import { getPool } from "@/lib/db/client";
import { redactDeep, redactText } from "@/lib/security/redact";

/**
 * Stage 1: a stored workflow_run payload keeps everything processing needs,
 * but the free text GitHub copies into it from the commit (head commit message,
 * run title) is redacted first. Processing reads ids, SHAs, branch and
 * conclusion only, which redaction leaves untouched.
 */
function redactStoredPayload(payload: unknown): unknown {
  const p = payload as { workflow_run?: { display_title?: unknown; head_commit?: { message?: unknown } } };
  const run = p?.workflow_run;
  if (!run) return redactDeep(payload).value; // any other event: every string redacted
  
  return {
    ...(payload as object),
    workflow_run: {
      ...run,
      ...(typeof run.display_title === "string" ? { display_title: redactText(run.display_title) } : {}),
      ...(run.head_commit && typeof run.head_commit.message === "string"
        ? { head_commit: { ...run.head_commit, message: redactText(run.head_commit.message) } }
        : {}),
    },
  };
}

/**
 * Phase 10: the GitHub webhook delivery log (github_webhook_deliveries).
 *
 * GitHub identifies each delivery with a GUID (X-GitHub-Delivery) that stays
 * the same on redelivery. Recording it makes processing idempotent across all
 * event types, and keeps the payload of deferred work until it has run, so a
 * lost after() callback can be retried by the maintenance run.
 *
 * Only event metadata and (for deferred work) GitHub's own payload are stored.
 * No header, token or secret is ever written here.
 */

export type DeliveryStatus = "received" | "processing" | "processed" | "failed" | "ignored";

/** Deliveries stuck in 'processing' longer than this are considered lost and may run again. */
const PROCESSING_STALE_MINUTES = 5;
export const MAX_DELIVERY_ATTEMPTS = 5;

export type BeginResult =
  | { proceed: true; attempt: number }
  | { proceed: false; status: DeliveryStatus };

/**
 * Registers a delivery and decides whether to process it:
 *   new                          -> process
 *   received / failed            -> process again (a redelivery of something that did not finish)
 *   processing, recently started -> skip (the first copy is still running)
 *   processed / ignored          -> skip (duplicate)
 */
export async function beginDelivery(input: {
  deliveryId: string;
  event: string;
  action: string | null;
  installationId: number | null;
  githubRepositoryId: number | null;
  payload?: unknown;
}): Promise<BeginResult> {
  const result = await getPool().query<{ status: DeliveryStatus; attempts: number; stale: boolean; inserted: boolean }>(
    `WITH prev AS (
       SELECT status, updated_at < now() - make_interval(mins => $7) AS stale
       FROM github_webhook_deliveries WHERE delivery_id = $1
     ), upsert AS (
       INSERT INTO github_webhook_deliveries (delivery_id, event, action, installation_id, github_repository_id, payload, status, attempts)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'processing', 1)
       ON CONFLICT (delivery_id) DO UPDATE SET
         attempts   = github_webhook_deliveries.attempts
                      + CASE WHEN github_webhook_deliveries.status IN ('received', 'failed')
                               OR (github_webhook_deliveries.status = 'processing'
                                   AND github_webhook_deliveries.updated_at < now() - make_interval(mins => $7))
                             THEN 1 ELSE 0 END,
         status     = CASE WHEN github_webhook_deliveries.status IN ('received', 'failed')
                             OR (github_webhook_deliveries.status = 'processing'
                                 AND github_webhook_deliveries.updated_at < now() - make_interval(mins => $7))
                           THEN 'processing' ELSE github_webhook_deliveries.status END,
         payload    = COALESCE(EXCLUDED.payload, github_webhook_deliveries.payload),
         updated_at = now()
       RETURNING (xmax = 0) AS inserted, attempts
     )
     SELECT u.inserted, u.attempts, p.status, COALESCE(p.stale, false) AS stale
     FROM upsert u LEFT JOIN prev p ON true`,
    [
      input.deliveryId,
      input.event,
      input.action,
      input.installationId,
      input.githubRepositoryId,
      input.payload === undefined ? null : JSON.stringify(redactStoredPayload(input.payload)),
      PROCESSING_STALE_MINUTES,
    ]
  );
  const row = result.rows[0];
  if (row.inserted) return { proceed: true, attempt: row.attempts };
  if (row.status === "received" || row.status === "failed" || (row.status === "processing" && row.stale)) {
    return { proceed: true, attempt: row.attempts };
  }
  return { proceed: false, status: row.status };
}

/** Records the outcome. The stored payload is dropped once it is no longer needed. */
export async function finishDelivery(deliveryId: string, status: DeliveryStatus, error?: string): Promise<void> {
  await getPool().query(
    `UPDATE github_webhook_deliveries
     SET status = $2, last_error = $3, updated_at = now(),
         payload = CASE WHEN $2 IN ('processed', 'ignored') THEN NULL ELSE payload END
     WHERE delivery_id = $1`,
    [deliveryId, status, error ? redactText(error).slice(0, 500) : null]
  );
}

/** Stage 2: the stored payload of a queued delivery (null once it has been processed). */
export async function getDeliveryPayload(deliveryId: string): Promise<unknown | null> {
  const result = await getPool().query<{ payload: unknown }>(
    `SELECT payload FROM github_webhook_deliveries WHERE delivery_id = $1`,
    [deliveryId]
  );
  return result.rows[0]?.payload ?? null;
}

/**
 * Stage 2: deliveries whose work is still pending but which have NO live job
 * (the enqueue was lost, or the delivery predates the queue). The maintenance
 * run enqueues them again; the job dedupe key makes that idempotent.
 */
export async function listOrphanedDeliveries(limit: number): Promise<{ delivery_id: string; event: string }[]> {
  const result = await getPool().query<{ delivery_id: string; event: string }>(
    `SELECT d.delivery_id, d.event FROM github_webhook_deliveries d
     WHERE d.payload IS NOT NULL AND d.status IN ('received', 'processing', 'failed')
       AND d.updated_at < now() - interval '2 minutes'
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.dedupe_key = 'webhook:' || d.delivery_id AND j.status IN ('queued', 'running'))
     ORDER BY d.received_at LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/** Bounded pruning: finished deliveries after 14 days, failed ones after 30. */
export async function pruneDeliveries(limit = 2000): Promise<number> {
  const result = await getPool().query(
    `DELETE FROM github_webhook_deliveries WHERE delivery_id IN (
       SELECT delivery_id FROM github_webhook_deliveries
       WHERE (status IN ('processed', 'ignored') AND received_at < now() - interval '14 days')
          OR received_at < now() - interval '30 days'
       LIMIT $1)`,
    [limit]
  );
  return result.rowCount ?? 0;
}

/** Deliveries still waiting to be processed (for the health report). */
export async function countPendingDeliveries(): Promise<number> {
  const result = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM github_webhook_deliveries WHERE status IN ('received', 'processing', 'failed') AND payload IS NOT NULL`
  );
  return result.rows[0].n;
}
