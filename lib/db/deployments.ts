import crypto from "node:crypto";
import { getPool } from "@/lib/db/client";
import type { PushEvent } from "@/lib/github/parse-push-event";
import type { ChangeAnalysis, ChangeCategory, FileAnalysis } from "@/lib/analysis/change-analysis";

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
  /** Phase 5: deterministic change analysis. NULL on rows recorded before Phase 5. */
  file_analysis: FileAnalysis[] | null;
  change_categories: ChangeCategory[] | null;
  affected_services: string[] | null;
  /** Phase 8: automatic risk analysis state. NULL = never scheduled. */
  risk_analysis_status: RiskAnalysisStatus | null;
  risk_analysis_error: string | null;
  risk_analysis_updated_at: Date | null;
  /** Phase 9: the connected repository that owns this deployment (NULL = unowned / pre-Phase 9). */
  repository_id: string | null;
  /** Phase 9: GitHub's immutable repository id from the push payload. */
  github_repository_id: string | null;
  /** Stage 1: what kind of content was redacted from this record (counts/categories, never values). */
  redaction: DeploymentRedaction | null;
  /** Stage 2: GitHub time of the newest pipeline event applied (ordering guard). */
  ci_last_event_at: Date | null;
};

export type RedactionCount = { count: number; categories: string[] };
export type DeploymentRedaction = { commit_message?: RedactionCount; failure_output?: RedactionCount };

export type RiskAnalysisStatus = "pending" | "completed" | "unavailable";

export type InsertResult = {
  deployment: Deployment;
  /** false when this exact push was already recorded (a GitHub retry). */
  isNew: boolean;
};

const COLUMNS = `
  id, repository, owner, branch, commit_sha, commit_message, author,
  changed_files, added_files, modified_files, deleted_files, status, created_at,
  updated_at, ci_run_id, ci_run_url, ci_started_at, ci_finished_at,
  failure_stage, failure_job, failure_message, file_analysis, change_categories,
  affected_services, risk_analysis_status, risk_analysis_error, risk_analysis_updated_at,
  repository_id, github_repository_id, redaction, ci_last_event_at
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
 *
 * The change analysis (Phase 5) is written in the same INSERT, so a deployment
 * never exists without the analysis of its own files.
 */
export async function insertDeployment(
  event: PushEvent,
  analysis: ChangeAnalysis,
  /** Phase 9: the connected repository this push belongs to; null for an unowned (plain webhook) push. */
  repositoryId: string | null = null
): Promise<InsertResult> {
  const pool = getPool();

  const inserted = await pool.query<Deployment>(
    `INSERT INTO deployments (
       repository, owner, branch, commit_sha, commit_message, author,
       changed_files, added_files, modified_files, deleted_files, status,
       file_analysis, change_categories, affected_services,
       repository_id, github_repository_id, redaction
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'RECEIVED', $11::jsonb, $12, $13, $14, $15, $16::jsonb)
     -- Either unique key (name-based, or Stage 2 repository-id-based) means "already recorded".
     ON CONFLICT DO NOTHING
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
      JSON.stringify(analysis.files),
      analysis.categories,
      analysis.services,
      repositoryId,
      event.githubRepositoryId,
      event.commitMessageRedaction?.count ? JSON.stringify({ commit_message: event.commitMessageRedaction }) : null,
    ]
  );

  if (inserted.rows.length > 0) {
    return { deployment: inserted.rows[0], isNew: true };
  }

  // Conflict: this push is already in the table. If it was first recorded by a
  // plain repository webhook (unowned) and now arrives through the GitHub App,
  // attach the owner; ownership is never moved once set.
  const existing = await pool.query<Deployment>(
    `UPDATE deployments SET
       repository_id        = COALESCE(repository_id, $5),
       github_repository_id = COALESCE(github_repository_id, $6)
     WHERE (owner = $1 AND repository = $2 AND branch = $3 AND commit_sha = $4)
        OR (github_repository_id = $6 AND branch = $3 AND commit_sha = $4)
     RETURNING ${COLUMNS}`,
    [event.owner, event.repository, event.branch, event.commitSha, repositoryId, event.githubRepositoryId]
  );

  return { deployment: existing.rows[0], isNew: false };
}

/** Which deployments a query may see: all (internal tooling) or those of the given repositories (Phase 9). */
export type DeploymentScope = { all: true } | { all: false; repositoryIds: string[] };

/** Newest-first deployment history, limited to the caller's scope. */
export async function listDeployments(limit = 20, scope: DeploymentScope = { all: true }): Promise<Deployment[]> {
  const pool = getPool();
  const result = scope.all
    ? await pool.query<Deployment>(
        `SELECT ${COLUMNS} FROM deployments ORDER BY created_at DESC, id DESC LIMIT $1`,
        [limit]
      )
    : await pool.query<Deployment>(
        `SELECT ${COLUMNS} FROM deployments WHERE repository_id = ANY($2::bigint[])
         ORDER BY created_at DESC, id DESC LIMIT $1`,
        [limit, scope.repositoryIds]
      );
  return result.rows;
}

/**
 * Phase 8: marks automatic risk analysis as pending and returns a token that
 * identifies this attempt. Only the holder of the newest token may record the
 * outcome (see finishRiskAnalysis).
 */
export async function startRiskAnalysis(deploymentId: string): Promise<string> {
  const attempt = crypto.randomUUID();
  await getPool().query(
    `UPDATE deployments
     SET risk_analysis_status = 'pending', risk_analysis_error = NULL,
         risk_analysis_updated_at = now(), risk_analysis_attempt = $2
     WHERE id = $1`,
    [deploymentId, attempt]
  );
  return attempt;
}

/**
 * Stage 2: the in-flight lock for a user's Re-analyze. Atomically starts an
 * attempt ONLY if no other attempt started within `lockSeconds`; returns null
 * when one is already running, so two clicks never make two Gemini calls.
 */
export async function tryStartRiskAnalysis(deploymentId: string, lockSeconds = 180): Promise<string | null> {
  const attempt = crypto.randomUUID();
  const result = await getPool().query(
    `UPDATE deployments
     SET risk_analysis_status = 'pending', risk_analysis_error = NULL,
         risk_analysis_updated_at = now(), risk_analysis_attempt = $2
     WHERE id = $1
       -- COALESCE: a never-analysed row has NULL status, and NOT (NULL ...) would be NULL (= refuse).
       AND NOT COALESCE(risk_analysis_status = 'pending' AND risk_analysis_updated_at > now() - make_interval(secs => $3), false)`,
    [deploymentId, attempt, lockSeconds]
  );
  return (result.rowCount ?? 0) > 0 ? attempt : null;
}

/**
 * Records how an attempt ended -- unless a newer attempt has started since, in
 * which case this (older) outcome is dropped and the newer one will report.
 */
export async function finishRiskAnalysis(
  deploymentId: string,
  attempt: string,
  outcome: { status: "completed" } | { status: "unavailable"; error: string }
): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE deployments
     SET risk_analysis_status = $3, risk_analysis_error = $4, risk_analysis_updated_at = now()
     WHERE id = $1 AND risk_analysis_attempt = $2`,
    [deploymentId, attempt, outcome.status, outcome.status === "unavailable" ? outcome.error.slice(0, 500) : null]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Phase 10: automatic analyses left "pending" for too long -- their after()
 * callback was lost (timeout, crash, restart). The maintenance run resumes them.
 */
export async function listStuckRiskAnalyses(olderThanMinutes: number, limit: number): Promise<string[]> {
  const result = await getPool().query<{ id: string }>(
    `SELECT id FROM deployments
     WHERE risk_analysis_status = 'pending' AND risk_analysis_updated_at < now() - make_interval(mins => $1)
       -- Stage 2: a job still queued/running (e.g. waiting for a retry) is not stuck.
       AND NOT EXISTS (
         SELECT 1 FROM jobs j
         WHERE j.type = 'risk.analyze' AND j.payload->>'deploymentId' = deployments.id::text
           AND j.status IN ('queued', 'running'))
     ORDER BY risk_analysis_updated_at LIMIT $2`,
    [olderThanMinutes, limit]
  );
  return result.rows.map((r) => r.id);
}

/**
 * Phase 10: owned deployments whose pipeline result never arrived (still
 * RECEIVED/BUILDING after `staleMinutes`), with what is needed to ask GitHub.
 */
export async function listStaleOwnedDeployments(
  staleMinutes: number,
  maxAgeHours: number,
  limit: number
): Promise<(Deployment & { installation_id: string; full_name: string })[]> {
  const result = await getPool().query<Deployment & { installation_id: string; full_name: string }>(
    `SELECT d.*, r.installation_id, r.full_name
     FROM deployments d
     JOIN repositories r ON r.id = d.repository_id
     JOIN github_installations i ON i.installation_id = r.installation_id
     WHERE d.status IN ('RECEIVED', 'BUILDING') AND r.connected AND i.status = 'active'
       AND d.updated_at < now() - make_interval(mins => $1)
       AND d.created_at > now() - make_interval(hours => $2)
     ORDER BY d.created_at DESC LIMIT $3`,
    [staleMinutes, maxAgeHours, limit]
  );
  return result.rows;
}

/** Phase 10: whether a push (repository/branch/commit) has already been recorded. */
export async function deploymentExists(owner: string, repository: string, branch: string, commitSha: string): Promise<boolean> {
  const result = await getPool().query(
    `SELECT 1 FROM deployments WHERE owner = $1 AND repository = $2 AND branch = $3 AND commit_sha = $4`,
    [owner, repository, branch, commitSha]
  );
  return (result.rowCount ?? 0) > 0;
}

/** One deployment by id, or null. */
export async function getDeploymentById(id: string): Promise<Deployment | null> {
  const result = await getPool().query<Deployment>(
    `SELECT ${COLUMNS} FROM deployments WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

/** A past deployment plus its incident (Phase 4), if it has one. */
export type HistoricalDeployment = Deployment & {
  incident_id: string | null;
  incident_failure_type: string | null;
  incident_error_message: string | null;
  incident_root_cause: string | null;
  incident_resolution: string | null;
  /** Stage 4: confirmation, flake and revert facts. */
  incident_affected_service: string | null;
  incident_downstream_effect: string | null;
  incident_confirmed_revision: number | null;
  incident_confirmed_at: Date | null;
  incident_flake_status: string | null;
  reverted_by_deployment_id: string | null;
  reverted_hours_after: string | null;
};

/**
 * Phase 6: earlier deployments of the same repository that COULD be similar to
 * `current` -- they share a changed file, an informative category or a service
 * (the GIN indexes make these overlaps cheap), or Hindsight named them. Rows
 * recorded before Phase 5 have no stored analysis, so they are included and the
 * caller analyses their file lists. Scoring happens in lib/similarity.
 *
 * Only deployments recorded no later than `current` count as history, and
 * `current` itself is always excluded.
 */
export async function findHistoryCandidates(
  current: Deployment,
  signals: { categories: string[]; services: string[]; extraIds: string[] },
  limit = 500
): Promise<HistoricalDeployment[]> {
  const result = await getPool().query<HistoricalDeployment>(
    `SELECT d.*,
            i.id            AS incident_id,
            i.failure_type  AS incident_failure_type,
            i.error_message AS incident_error_message,
            i.root_cause    AS incident_root_cause,
            i.resolution    AS incident_resolution,
            i.affected_service   AS incident_affected_service,
            i.downstream_effect  AS incident_downstream_effect,
            i.confirmed_revision AS incident_confirmed_revision,
            i.confirmed_at       AS incident_confirmed_at,
            i.flake_status       AS incident_flake_status,
            rv.reverting_deployment_id::text AS reverted_by_deployment_id,
            rv.hours_after::text AS reverted_hours_after
     FROM deployments d
     LEFT JOIN incidents i ON i.deployment_id = d.id
     -- Stage 4.5: the first observed revert of this deployment, if any.
     LEFT JOIN LATERAL (
       SELECT r.reverting_deployment_id, r.hours_after FROM deployment_reverts r
       WHERE r.reverted_deployment_id = d.id ORDER BY r.detected_at LIMIT 1
     ) rv ON true
     WHERE d.owner = $1 AND d.repository = $2
       -- Phase 9: history never crosses an ownership boundary. An owned
       -- deployment only sees deployments of the SAME connected repository;
       -- an unowned one only sees unowned ones.
       AND d.repository_id IS NOT DISTINCT FROM $10::bigint
       AND d.id <> $3
       AND d.created_at <= $4
       AND (   d.changed_files     && $5::text[]
            OR d.change_categories && $6::text[]
            OR d.affected_services && $7::text[]
            OR d.file_analysis IS NULL
            OR d.id = ANY($8::bigint[]))
     ORDER BY d.created_at DESC, d.id DESC
     LIMIT $9`,
    [
      current.owner,
      current.repository,
      current.id,
      current.created_at,
      current.changed_files,
      signals.categories,
      signals.services,
      signals.extraIds,
      limit,
      current.repository_id,
    ]
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
  /** Stage 1: set by the lifecycle when the failure output had something masked. */
  failureRedaction?: RedactionCount;
  /**
   * Stage 2: when GitHub says this state happened (workflow_run updated_at).
   * An event OLDER than the newest one already applied is ignored, so a late
   * "in progress" can never overwrite SUCCESS/FAILED. Reports without a time
   * (the CI reporter) count as "now".
   */
  eventAt?: string;
};

export type UpdateResult =
  | { outcome: "updated"; deployment: Deployment; previousStatus: DeploymentStatus }
  | { outcome: "not_found" }
  | { outcome: "invalid_transition"; currentStatus: DeploymentStatus }
  | { outcome: "stale_event"; currentStatus: DeploymentStatus };

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
       failure_message = $11,
       redaction       = CASE WHEN $12::jsonb IS NULL THEN d.redaction
                              ELSE COALESCE(d.redaction, '{}'::jsonb) || $12::jsonb END,
       ci_last_event_at = GREATEST(d.ci_last_event_at, COALESCE($13::timestamptz, now()))
     FROM prev
     WHERE d.id = prev.id AND prev.status = ANY($6::text[])
       -- Stage 2 ordering: only newer events (a repeat of the same state at the same time is harmless).
       AND (d.ci_last_event_at IS NULL
            OR COALESCE($13::timestamptz, now()) > d.ci_last_event_at
            OR (COALESCE($13::timestamptz, now()) = d.ci_last_event_at AND prev.status = $5::text))
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
      isFailed && update.failureRedaction?.count ? JSON.stringify({ failure_output: update.failureRedaction }) : null,
      update.eventAt ?? null,
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

  if (existing.rows.length === 0) return { outcome: "not_found" };
  const currentStatus = existing.rows[0].status;
  // Allowed move, but refused by the ordering check: an out-of-date event.
  return ALLOWED_FROM[update.status].includes(currentStatus)
    ? { outcome: "stale_event", currentStatus }
    : { outcome: "invalid_transition", currentStatus };
}
