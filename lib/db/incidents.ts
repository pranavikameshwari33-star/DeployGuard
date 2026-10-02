import { getPool } from "@/lib/db/client";
import type { Deployment } from "@/lib/db/deployments";
import type { ConfirmationInput } from "@/lib/learning/confirmation";
import { detectFlake, type FlakeEvidence } from "@/lib/learning/flake";
import { errorSignature } from "@/lib/learning/signature";
import type { RedactionSummary } from "@/lib/security/redact";

/**
 * One row of the `incidents` table: what went wrong with a FAILED deployment.
 *
 * failure_type, failure_job and error_message are observed facts from the CI
 * report. root_cause, resolution, affected_service and downstream_effect are
 * NULL until a person confirms them (Stage 4.1): they are then HUMAN-CONFIRMED,
 * with confirmed_revision / confirmed_by_login / confirmed_at saying who and
 * when, and the full edit history in incident_confirmations. Nothing automatic
 * ever writes those four fields.
 */
export type Incident = {
  /** BIGSERIAL, returned as a string by node-postgres (see Deployment.id). */
  id: string;
  deployment_id: string;
  failure_type: string;
  failure_job: string | null;
  error_message: string | null;
  affected_service: string | null;
  downstream_effect: string | null;
  root_cause: string | null;
  resolution: string | null;
  created_at: Date;
  /** Stage 4.1: set only when a person confirmed the fields above. */
  confirmed_revision: number | null;
  confirmed_by_login: string | null;
  confirmed_at: Date | null;
  /** Stage 4.4: the failing run (snapshot) and the probable-flake evidence. */
  failed_ci_run_id: string | null;
  failed_ci_run_url: string | null;
  failed_at: Date | null;
  flake_status: "probable_flake" | null;
  flake_passing_run_id: string | null;
  flake_passing_run_url: string | null;
  flake_detected_at: Date | null;
  /** Stage 4.3: normalised error signature (what was printed, not why). */
  error_signature: string | null;
};

export type IncidentResult = {
  incident: Incident;
  /** false when this deployment already had an incident (a retry or a re-run). */
  isNew: boolean;
};

const NAMES = [
  "id", "deployment_id", "failure_type", "failure_job", "error_message", "affected_service",
  "downstream_effect", "root_cause", "resolution", "created_at", "confirmed_revision",
  "confirmed_by_login", "confirmed_at", "failed_ci_run_id", "failed_ci_run_url", "failed_at",
  "flake_status", "flake_passing_run_id", "flake_passing_run_url", "flake_detected_at", "error_signature",
];

/** The incident columns, optionally qualified with a table alias ("i.id, i.deployment_id, ..."). */
export function incidentColumns(alias?: string): string {
  return NAMES.map((n) => (alias ? `${alias}.${n}` : n)).join(", ");
}

const COLUMNS = incidentColumns();

/**
 * Records the incident for a FAILED deployment, exactly once per deployment.
 *
 * The unique index on deployment_id makes this idempotent: a repeated FAILED
 * report updates the same row instead of adding another. Only the observed
 * fields are refreshed (a re-run can fail differently, and the incident should
 * describe the latest failure). The human-confirmed fields and the flake marker
 * are never touched here, so anything a person recorded survives a retry.
 *
 * `xmax = 0` is PostgreSQL's way of saying the row was inserted rather than
 * updated by this statement.
 */
export async function recordIncident(deployment: Deployment): Promise<IncidentResult> {
  if (deployment.status !== "FAILED") {
    throw new Error(`Deployment #${deployment.id} is ${deployment.status}, not FAILED; no incident recorded.`);
  }

  const result = await getPool().query<Incident & { inserted: boolean }>(
    `INSERT INTO incidents (deployment_id, failure_type, failure_job, error_message,
                            failed_ci_run_id, failed_ci_run_url, failed_at, error_signature)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (deployment_id) DO UPDATE SET
       failure_type      = EXCLUDED.failure_type,
       failure_job       = EXCLUDED.failure_job,
       error_message     = EXCLUDED.error_message,
       failed_ci_run_id  = EXCLUDED.failed_ci_run_id,
       failed_ci_run_url = EXCLUDED.failed_ci_run_url,
       failed_at         = EXCLUDED.failed_at,
       error_signature   = EXCLUDED.error_signature
     RETURNING ${COLUMNS}, (xmax = 0) AS inserted`,
    [
      deployment.id,
      failureType(deployment.failure_stage),
      deployment.failure_job,
      deployment.failure_message,
      deployment.ci_run_id,
      deployment.ci_run_url,
      deployment.ci_finished_at ?? new Date(),
      errorSignature(deployment.failure_message),
    ]
  );

  const { inserted, ...incident } = result.rows[0];
  return { incident, isNew: inserted };
}

/** The incident recorded for a deployment, or null if it has none. */
export async function getIncidentForDeployment(deploymentId: string): Promise<Incident | null> {
  const result = await getPool().query<Incident>(
    `SELECT ${COLUMNS} FROM incidents WHERE deployment_id = $1`,
    [deploymentId]
  );
  return result.rows[0] ?? null;
}

export async function getIncidentById(incidentId: string): Promise<Incident | null> {
  const result = await getPool().query<Incident>(`SELECT ${COLUMNS} FROM incidents WHERE id = $1`, [incidentId]);
  return result.rows[0] ?? null;
}

/** An incident with the deployment facts the incident history table shows. */
export type IncidentListItem = Incident & {
  repository: string;
  branch: string;
  commit_sha: string;
  deployment_status: string;
  failure_stage: string | null;
};

/** Phase 8: newest incidents first, for the dashboard. */
export async function listIncidents(
  limit = 20,
  /** Phase 9: all (internal tooling) or only incidents of the given repositories. */
  scope: { all: true } | { all: false; repositoryIds: string[] } = { all: true }
): Promise<IncidentListItem[]> {
  const result = await getPool().query<IncidentListItem>(
    `SELECT ${incidentColumns("i")},
            d.owner || '/' || d.repository AS repository, d.branch, d.commit_sha,
            d.status AS deployment_status, d.failure_stage
     FROM incidents i JOIN deployments d ON d.id = i.deployment_id
     WHERE $2::boolean OR d.repository_id = ANY($3::bigint[])
     ORDER BY i.created_at DESC, i.id DESC
     LIMIT $1`,
    [limit, scope.all, scope.all ? [] : scope.repositoryIds]
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// Stage 4.1: human-confirmed root cause and resolution
// ---------------------------------------------------------------------------

export type IncidentConfirmation = ConfirmationInput & {
  id: string;
  incident_id: string;
  revision: number;
  confirmed_by_login: string;
  confirmed_at: Date;
  redaction: RedactionSummary | null;
};

export type ConfirmResult =
  | { outcome: "confirmed"; incident: Incident; revision: number }
  | { outcome: "unchanged"; incident: Incident }
  | { outcome: "conflict"; currentRevision: number }
  | { outcome: "not_found" };

/**
 * Appends a confirmation revision and mirrors it onto the incident, in one
 * transaction. `baseRevision` (optional) is the revision the person was
 * editing: if someone else saved in between, nothing is written (conflict).
 * Submitting exactly the current values writes nothing (no new revision, no
 * re-evaluation).
 */
export async function confirmIncident(
  incidentId: string,
  input: ConfirmationInput,
  by: { userId: string; login: string },
  redaction: RedactionSummary | null,
  baseRevision?: number
): Promise<ConfirmResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<Incident>(`SELECT ${COLUMNS} FROM incidents WHERE id = $1 FOR UPDATE`, [incidentId]);
    const row = current.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { outcome: "not_found" };
    }
    const currentRevision = row.confirmed_revision ?? 0;
    if (baseRevision !== undefined && baseRevision !== currentRevision) {
      await client.query("ROLLBACK");
      return { outcome: "conflict", currentRevision };
    }
    if (
      currentRevision > 0 &&
      row.root_cause === input.root_cause &&
      row.resolution === input.resolution &&
      row.affected_service === input.affected_service &&
      row.downstream_effect === input.downstream_effect
    ) {
      await client.query("ROLLBACK");
      return { outcome: "unchanged", incident: row };
    }
    const revision = currentRevision + 1;
    await client.query(
      `INSERT INTO incident_confirmations
         (incident_id, revision, root_cause, resolution, affected_service, downstream_effect,
          confirmed_by_user_id, confirmed_by_login, redaction)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [incidentId, revision, input.root_cause, input.resolution, input.affected_service, input.downstream_effect,
       by.userId, by.login, redaction ? JSON.stringify(redaction) : null]
    );
    const updated = await client.query<Incident>(
      `UPDATE incidents SET root_cause = $2, resolution = $3, affected_service = $4, downstream_effect = $5,
              confirmed_revision = $6, confirmed_by_login = $7, confirmed_at = now()
       WHERE id = $1 RETURNING ${COLUMNS}`,
      [incidentId, input.root_cause, input.resolution, input.affected_service, input.downstream_effect, revision, by.login]
    );
    await client.query("COMMIT");
    return { outcome: "confirmed", incident: updated.rows[0], revision };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** The edit history of an incident's confirmation, newest first. */
export async function listConfirmations(incidentId: string): Promise<IncidentConfirmation[]> {
  const { rows } = await getPool().query<IncidentConfirmation>(
    `SELECT id, incident_id, revision, root_cause, resolution, affected_service, downstream_effect,
            confirmed_by_login, confirmed_at, redaction
     FROM incident_confirmations WHERE incident_id = $1 ORDER BY revision DESC`,
    [incidentId]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Stage 4.4: probable flake
// ---------------------------------------------------------------------------

/**
 * Called when a deployment reaches SUCCESS. If it has an incident (it failed
 * earlier) and the rule in lib/learning/flake.ts holds, the incident is marked
 * "probable_flake" with the passing run as evidence. Idempotent: an incident is
 * marked once; the incident itself is never deleted.
 */
export async function markProbableFlake(deployment: Deployment): Promise<{ incident: Incident; evidence: FlakeEvidence } | null> {
  if (deployment.status !== "SUCCESS") return null;
  const incident = await getIncidentForDeployment(deployment.id);
  const evidence = detectFlake({
    deployment,
    incident: incident && { ...incident, commit_sha: deployment.commit_sha },
  });
  if (!incident || !evidence) return null;
  const { rows } = await getPool().query<Incident>(
    `UPDATE incidents SET flake_status = 'probable_flake', flake_passing_run_id = $2,
            flake_passing_run_url = $3, flake_detected_at = now()
     WHERE id = $1 AND flake_status IS NULL
     RETURNING ${COLUMNS}`,
    [incident.id, evidence.passing_run.id, evidence.passing_run.url]
  );
  return rows[0] ? { incident: rows[0], evidence } : null;
}

/** Stage 4.3: fills error_signature for incidents recorded before Stage 4 (bounded batch). */
export async function backfillErrorSignatures(limit = 500): Promise<number> {
  const { rows } = await getPool().query<{ id: string; error_message: string }>(
    `SELECT id, error_message FROM incidents WHERE error_signature IS NULL AND error_message IS NOT NULL ORDER BY id LIMIT $1`,
    [limit]
  );
  let updated = 0;
  for (const row of rows) {
    const signature = errorSignature(row.error_message);
    if (!signature) continue;
    const r = await getPool().query(`UPDATE incidents SET error_signature = $2 WHERE id = $1 AND error_signature IS NULL`, [row.id, signature]);
    updated += r.rowCount ?? 0;
  }
  return updated;
}

/**
 * Names the failure after the stage the pipeline says stopped, e.g. "test" ->
 * "test_failure". This only relabels the stage and does not diagnose anything.
 */
function failureType(stage: string | null): string {
  const clean = (stage ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `${clean || "unknown"}_failure`;
}
