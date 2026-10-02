import crypto from "node:crypto";
import { getPool } from "@/lib/db/client";
import { redactText } from "@/lib/security/redact";
import { backoffSeconds } from "@/lib/jobs/backoff";

/**
 * Stage 2: a PostgreSQL job queue (table `jobs`, migration 010).
 *
 *   enqueue   -- insert a job; a dedupe_key makes a second enqueue of the same
 *                work a no-op (webhook redeliveries, repeated CI reports).
 *   claim     -- take up to N ready jobs with FOR UPDATE SKIP LOCKED, so any
 *                number of workers can drain the queue without taking the same job.
 *   complete  -- mark succeeded.
 *   fail      -- retry later with exponential backoff + jitter, or move the job to
 *                the dead-letter state ("dead") after max_attempts.
 *   reclaim   -- jobs left "running" by a worker that died are put back.
 *
 * Payloads hold references (delivery id, deployment id), never repository
 * content. Errors are redacted before they are stored.
 */

export type JobStatus = "queued" | "running" | "succeeded" | "dead";

export type Job = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  dedupe_key: string | null;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_at: Date;
  last_error: string | null;
};

/** A worker id for locked_by: process + random suffix (no host names, no secrets). */
export const WORKER_ID = `w-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

export async function enqueue(
  type: string,
  payload: Record<string, unknown>,
  options: { dedupeKey?: string; maxAttempts?: number; delaySeconds?: number } = {}
): Promise<{ id: string; created: boolean }> {
  const result = await getPool().query<{ id: string; created: boolean }>(
    `WITH ins AS (
       INSERT INTO jobs (type, payload, dedupe_key, max_attempts, run_at)
       VALUES ($1, $2::jsonb, $3, $4, now() + make_interval(secs => $5))
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id
     )
     SELECT id, true AS created FROM ins
     UNION ALL
     SELECT id, false AS created FROM jobs WHERE dedupe_key = $3 AND NOT EXISTS (SELECT 1 FROM ins)`,
    [type, JSON.stringify(payload), options.dedupeKey ?? null, options.maxAttempts ?? 5, options.delaySeconds ?? 0]
  );
  return result.rows[0];
}

export async function claim(limit: number, workerId = WORKER_ID, types?: string[]): Promise<Job[]> {
  const result = await getPool().query<Job>(
    `UPDATE jobs SET status = 'running', locked_by = $2, locked_at = now(), attempts = attempts + 1, updated_at = now()
     WHERE id IN (
       SELECT id FROM jobs
       WHERE status = 'queued' AND run_at <= now() AND ($3::text[] IS NULL OR type = ANY($3::text[]))
       ORDER BY run_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     RETURNING id, type, payload, dedupe_key, status, attempts, max_attempts, run_at, last_error`,
    [limit, workerId, types ?? null]
  );
  return result.rows;
}

export async function complete(id: string): Promise<void> {
  await getPool().query(
    `UPDATE jobs SET status = 'succeeded', finished_at = now(), updated_at = now(), locked_by = NULL, locked_at = NULL, last_error = NULL
     WHERE id = $1`,
    [id]
  );
}

/**
 * Records a failed attempt. Retries after an exponentially growing, jittered
 * delay; after max_attempts the job is dead-lettered (kept, visible, never
 * retried automatically). `retryable: false` dead-letters immediately.
 */
export async function fail(job: Pick<Job, "id" | "attempts" | "max_attempts">, error: string, retryable = true): Promise<JobStatus> {
  const dead = !retryable || job.attempts >= job.max_attempts;
  const delay = dead ? 0 : backoffSeconds(job.attempts);
  await getPool().query(
    `UPDATE jobs SET status = $2, last_error = $3, run_at = now() + make_interval(secs => $4),
            locked_by = NULL, locked_at = NULL, updated_at = now(),
            finished_at = CASE WHEN $2 = 'dead' THEN now() ELSE NULL END
     WHERE id = $1`,
    [job.id, dead ? "dead" : "queued", redactText(error).slice(0, 1000), delay]
  );
  return dead ? "dead" : "queued";
}

/**
 * Jobs stuck in "running" longer than `staleSeconds` belonged to a worker that
 * died (crash, serverless timeout). They go back to the queue -- or to the
 * dead-letter state if that was their last allowed attempt.
 */
export async function reclaimStuck(staleSeconds = 300): Promise<{ requeued: number; dead: number }> {
  const result = await getPool().query<{ status: JobStatus }>(
    `UPDATE jobs SET
       status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
       last_error = COALESCE(last_error, '') || CASE WHEN last_error IS NULL THEN '' ELSE ' | ' END || 'worker lost (lock expired)',
       locked_by = NULL, locked_at = NULL, run_at = now(), updated_at = now(),
       finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END
     WHERE status = 'running' AND locked_at < now() - make_interval(secs => $1)
     RETURNING status`,
    [staleSeconds]
  );
  return {
    requeued: result.rows.filter((r) => r.status === "queued").length,
    dead: result.rows.filter((r) => r.status === "dead").length,
  };
}

/** Puts a dead-lettered job back in the queue (operator action, internal only). */
export async function retryDead(id: string): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE jobs SET status = 'queued', attempts = 0, run_at = now(), updated_at = now(), finished_at = NULL
     WHERE id = $1 AND status = 'dead'`,
    [id]
  );
  return (result.rowCount ?? 0) > 0;
}

export type QueueStats = {
  queued: number;
  ready: number;
  running: number;
  dead: number;
  oldestReadyAgeSeconds: number | null;
};

export async function queueStats(): Promise<QueueStats> {
  const { rows } = await getPool().query<QueueStats>(
    `SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued,
            count(*) FILTER (WHERE status = 'queued' AND run_at <= now())::int AS ready,
            count(*) FILTER (WHERE status = 'running')::int AS running,
            count(*) FILTER (WHERE status = 'dead')::int AS dead,
            extract(epoch FROM now() - min(run_at) FILTER (WHERE status = 'queued' AND run_at <= now()))::int AS "oldestReadyAgeSeconds"
     FROM jobs WHERE status IN ('queued', 'running', 'dead')`
  );
  return rows[0];
}

/** Housekeeping: finished jobs older than `days` are removed (dead ones are kept). */
export async function pruneSucceeded(days = 7, limit = 5000): Promise<number> {
  const result = await getPool().query(
    `DELETE FROM jobs WHERE id IN (
       SELECT id FROM jobs WHERE status = 'succeeded' AND finished_at < now() - make_interval(days => $1) LIMIT $2)`,
    [days, limit]
  );
  return result.rowCount ?? 0;
}
