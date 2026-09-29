import { getPool } from "@/lib/db/client";
import type { PushEvent } from "@/lib/github/parse-push-event";

/**
 * The lifecycle of a deployment. The webhook creates RECEIVED (Phase 2); the
 * GitHub Actions pipeline moves it to BUILDING and then SUCCESS or FAILED
 * (Phase 3). ROLLED_BACK is reserved for a later phase.
 */
export type DeploymentStatus =
  | "RECEIVED"
  | "BUILDING"
  | "SUCCESS"
  | "FAILED"
  | "ROLLED_BACK";

/** One row of the `deployments` table. */
export type Deployment = {
  /** BIGSERIAL. node-postgres returns int8 as a string so large ids keep full precision. */
  id: string;
  repository: string;
  owner: string;
  branch: string;
  commit_sha: string;
  commit_message: string;
  author: string;
  changed_files: string[];
  added_files: string[];
  modified_files: string[];
  deleted_files: string[];
  status: DeploymentStatus;
  created_at: Date;
  updated_at: Date;
  /** Phase 3: the GitHub Actions run that reported on this deployment. */
  ci_run_id: string | null;
  ci_run_url: string | null;
  ci_started_at: Date | null;
  ci_finished_at: Date | null;
  /** Phase 3: only set when status is FAILED. Observed facts, not a diagnosis. */
  failure_stage: string | null;
  failure_job: string | null;
  failure_message: string | null;
};

export type InsertResult = {
  deployment: Deployment;
  /** false when this exact push was already recorded (a GitHub retry). */
  isNew: boolean;
};

const COLUMNS = `
  id, repository, owner, branch, commit_sha, commit_message, author,
  changed_files, added_files, modified_files, deleted_files, status, created_at,
  updated_at, ci_run_id, ci_run_url, ci_started_at, ci_finished_at,
  failure_stage, failure_job, failure_message
`;

/**
 * Writes a push event as a deployment record, exactly once.
 *
 * `ON CONFLICT DO NOTHING` leans on the unique index (owner, repository, branch,
 * commit_sha). If GitHub redelivers the same push, the INSERT quietly affects no
 * rows, we read the existing record back, and the caller learns `isNew: false`.
 * That is what stops duplicates without us having to SELECT-then-INSERT, which
 * would still race if two deliveries arrived at the same moment.
 *
 * Every value is passed as a bound parameter ($1, $2, ...), never string
 * concatenation, so a commit message containing SQL is just text.
 */
export async function insertDeployment(event: PushEvent): Promise<InsertResult> {
  const pool = getPool();

  const inserted = await pool.query<Deployment>(
    `INSERT INTO deployments (
       repository, owner, branch, commit_sha, commit_message, author,
       changed_files, added_files, modified_files, deleted_files, status
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'RECEIVED')
     ON CONFLICT (owner, repository, branch, commit_sha) DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      event.repository,
      event.owner,
      event.branch,
      event.commitSha,
      event.commitMessage,
      event.author,
      event.changedFiles,
      event.addedFiles,
      event.modifiedFiles,
      event.deletedFiles,
    ]
  );

  if (inserted.rows.length > 0) {
    return { deployment: inserted.rows[0], isNew: true };
  }

  // Conflict: this push is already in the table. Return what is stored.
  const existing = await pool.query<Deployment>(
    `SELECT ${COLUMNS} FROM deployments
     WHERE owner = $1 AND repository = $2 AND branch = $3 AND commit_sha = $4`,
    [event.owner, event.repository, event.branch, event.commitSha]
  );

  return { deployment: existing.rows[0], isNew: false };
}

/** Newest-first deployment history. Used by the verification endpoint. */
export async function listDeployments(limit = 20): Promise<Deployment[]> {
  const pool = getPool();
  const result = await pool.query<Deployment>(
    `SELECT ${COLUMNS} FROM deployments ORDER BY created_at DESC, id DESC LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/** The statuses the CI pipeline is allowed to report. RECEIVED belongs to the webhook. */
export type PipelineStatus = "BUILDING" | "SUCCESS" | "FAILED";

/**
 * Which status a deployment must currently have for each pipeline report to be
 * accepted.
 *
 *  - BUILDING from RECEIVED is the normal start. From SUCCESS or FAILED it is a
 *    "Re-run jobs" in GitHub, which reuses the same commit.
 *  - SUCCESS / FAILED normally follow BUILDING. RECEIVED is also accepted so a
 *    lost BUILDING report does not strand the final result.
 *  - Repeating the current status is allowed, so a retried report is harmless.
 */
const ALLOWED_FROM: Record<PipelineStatus, DeploymentStatus[]> = {
  BUILDING: ["RECEIVED", "BUILDING", "SUCCESS", "FAILED"],
  SUCCESS: ["RECEIVED", "BUILDING", "SUCCESS"],
  FAILED: ["RECEIVED", "BUILDING", "FAILED"],
};

export type DeploymentKey = {
  owner: string;
  repository: string;
  branch: string;
  commitSha: string;
};

export type StatusUpdate = {
  status: PipelineStatus;
  ciRunId?: string;
  ciRunUrl?: string;
  failure?: { stage?: string; job?: string; message?: string };
};

export type UpdateResult =
  | { outcome: "updated"; deployment: Deployment; previousStatus: DeploymentStatus }
  | { outcome: "not_found" }
  | { outcome: "invalid_transition"; currentStatus: DeploymentStatus };

/**
 * Moves an EXISTING deployment to a new pipeline status. Never inserts: the row
 * is found by the same (owner, repository, branch, commit_sha) key the webhook
 * uses to prevent duplicates, so one push is always one row.
 *
 * The status check lives in the WHERE clause, which makes "check the current
 * status, then change it" a single atomic statement.
 */
export async function updateDeploymentStatus(
  key: DeploymentKey,
  update: StatusUpdate
): Promise<UpdateResult> {
  const pool = getPool();
  const isFailed = update.status === "FAILED";

  const result = await pool.query<Deployment & { previous_status: DeploymentStatus }>(
    `WITH prev AS (
       -- The row as it was before this update; FOR UPDATE stops two reports racing.
       SELECT id, status FROM deployments
       WHERE owner = $1 AND repository = $2 AND branch = $3 AND commit_sha = $4
       FOR UPDATE
     )
     UPDATE deployments AS d SET
       status          = $5::text,
       updated_at      = now(),
       ci_run_id       = COALESCE($7, d.ci_run_id),
       ci_run_url      = COALESCE($8, d.ci_run_url),
       -- BUILDING starts a (re)run: stamp the start and clear the previous finish.
       ci_started_at   = CASE WHEN $5::text = 'BUILDING' THEN now() ELSE COALESCE(d.ci_started_at, now()) END,
       ci_finished_at  = CASE WHEN $5::text = 'BUILDING' THEN NULL ELSE now() END,
       failure_stage   = $9,
       failure_job     = $10,
       failure_message = $11
     FROM prev
     WHERE d.id = prev.id AND prev.status = ANY($6::text[])
     RETURNING d.*, prev.status AS previous_status`,
    [
      key.owner,
      key.repository,
      key.branch,
      key.commitSha,
      update.status,
      ALLOWED_FROM[update.status],
      update.ciRunId ?? null,
      update.ciRunUrl ?? null,
      isFailed ? update.failure?.stage ?? null : null,
      isFailed ? update.failure?.job ?? null : null,
      isFailed ? update.failure?.message ?? null : null,
    ]
  );

  if (result.rows.length > 0) {
    const { previous_status, ...deployment } = result.rows[0];
    return { outcome: "updated", deployment, previousStatus: previous_status };
  }

  // Nothing changed: either there is no such deployment, or its current status
  // does not allow this move. Tell the two apart for a useful error.
  const existing = await pool.query<{ status: DeploymentStatus }>(
    `SELECT status FROM deployments
     WHERE owner = $1 AND repository = $2 AND branch = $3 AND commit_sha = $4`,
    [key.owner, key.repository, key.branch, key.commitSha]
  );

  return existing.rows.length === 0
    ? { outcome: "not_found" }
    : { outcome: "invalid_transition", currentStatus: existing.rows[0].status };
}
