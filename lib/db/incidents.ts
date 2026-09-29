import { getPool } from "@/lib/db/client";
import type { Deployment } from "@/lib/db/deployments";

/**
 * One row of the `incidents` table: what went wrong with a FAILED deployment.
 *
 * The first three fields after deployment_id are observed facts from the CI
 * report. The four after that are NULL until there is real evidence for them;
 * this phase never fills them in automatically.
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
};

export type IncidentResult = {
  incident: Incident;
  /** false when this deployment already had an incident (a retry or a re-run). */
  isNew: boolean;
};

const COLUMNS = `
  id, deployment_id, failure_type, failure_job, error_message, affected_service,
  downstream_effect, root_cause, resolution, created_at
`;

/**
 * Records the incident for a FAILED deployment, exactly once per deployment.
 *
 * The unique index on deployment_id makes this idempotent: a repeated FAILED
 * report updates the same row instead of adding another. Only the observed
 * fields are refreshed (a re-run can fail differently, and the incident should
 * describe the latest failure). root_cause, resolution, affected_service and
 * downstream_effect are never touched here, so anything a person records later
 * survives a retry.
 *
 * `xmax = 0` is PostgreSQL's way of saying the row was inserted rather than
 * updated by this statement.
 */
export async function recordIncident(deployment: Deployment): Promise<IncidentResult> {
  if (deployment.status !== "FAILED") {
    throw new Error(`Deployment #${deployment.id} is ${deployment.status}, not FAILED; no incident recorded.`);
  }

  const result = await getPool().query<Incident & { inserted: boolean }>(
    `INSERT INTO incidents (deployment_id, failure_type, failure_job, error_message)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (deployment_id) DO UPDATE SET
       failure_type  = EXCLUDED.failure_type,
       failure_job   = EXCLUDED.failure_job,
       error_message = EXCLUDED.error_message
     RETURNING ${COLUMNS}, (xmax = 0) AS inserted`,
    [
      deployment.id,
      failureType(deployment.failure_stage),
      deployment.failure_job,
      deployment.failure_message,
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
    `SELECT i.id, i.deployment_id, i.failure_type, i.failure_job, i.error_message,
            i.affected_service, i.downstream_effect, i.root_cause, i.resolution, i.created_at,
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

/**
 * Names the failure after the stage the pipeline says stopped, e.g. "test" ->
 * "test_failure". This only relabels the stage and does not diagnose anything.
 */
function failureType(stage: string | null): string {
  const clean = (stage ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `${clean || "unknown"}_failure`;
}
