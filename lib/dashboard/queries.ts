import { getPool } from "@/lib/db/client";
import { getDeploymentById, type Deployment, type DeploymentScope } from "@/lib/db/deployments";
import { incidentColumns, listConfirmations, type Incident, type IncidentConfirmation, type IncidentListItem } from "@/lib/db/incidents";

/**
 * Stage 3: the dashboard's scoped reads. Every query takes the viewer's scope
 * (all repositories for internal tooling, otherwise the user's own repository
 * ids) AND an optional repository filter (the immutable GitHub repository id
 * chosen in the switcher). The filter can only narrow: it is ANDed with the
 * scope inside the SQL, so a foreign repository id simply returns nothing.
 *
 * PostgreSQL only -- never Hindsight, never Gemini.
 */
export type ViewScope = { scope: DeploymentScope; githubRepositoryId: string | null };

/** $1 = all?, $2 = owned repository ids, $3 = repository filter. */
const SCOPE_SQL = `($1::boolean OR d.repository_id = ANY($2::bigint[])) AND ($3::bigint IS NULL OR d.github_repository_id = $3::bigint)`;
const scopeParams = (v: ViewScope) => [v.scope.all, v.scope.all ? [] : v.scope.repositoryIds, v.githubRepositoryId];

export async function listDeploymentsPage(v: ViewScope, limit: number, offset: number): Promise<Deployment[]> {
  const { rows } = await getPool().query<Deployment>(
    `SELECT d.* FROM deployments d WHERE ${SCOPE_SQL} ORDER BY d.created_at DESC, d.id DESC LIMIT $4 OFFSET $5`,
    [...scopeParams(v), limit, offset]
  );
  return rows;
}

export async function listIncidentsScoped(v: ViewScope, limit: number): Promise<IncidentListItem[]> {
  const { rows } = await getPool().query<IncidentListItem>(
    `SELECT ${incidentColumns("i")},
            d.owner || '/' || d.repository AS repository, d.branch, d.commit_sha,
            d.status AS deployment_status, d.failure_stage
     FROM incidents i JOIN deployments d ON d.id = i.deployment_id
     WHERE ${SCOPE_SQL}
     ORDER BY i.created_at DESC, i.id DESC LIMIT $4`,
    [...scopeParams(v), limit]
  );
  return rows;
}

export type HistoryCounts = {
  total: number;
  byStatus: Record<string, number>;
  /** Latest valid assessment per deployment; "none" = never assessed. */
  byRisk: Record<"LOW" | "MEDIUM" | "HIGH" | "none", number>;
  incidents: number;
};

/** Plain counts over EVERY deployment in scope (not only the current page). No rates, no trends. */
export async function historyCounts(v: ViewScope): Promise<HistoryCounts> {
  const { rows } = await getPool().query<{ status: string; risk: string; n: number; incidents: number }>(
    `SELECT d.status, COALESCE(r.risk_level, 'none') AS risk, count(*)::int AS n, count(i.id)::int AS incidents
     FROM deployments d
     LEFT JOIN LATERAL (
       SELECT risk_level FROM risk_assessments a WHERE a.deployment_id = d.id
       ORDER BY a.risk_generated_at DESC, a.id DESC LIMIT 1
     ) r ON true
     LEFT JOIN incidents i ON i.deployment_id = d.id
     WHERE ${SCOPE_SQL}
     GROUP BY 1, 2`,
    scopeParams(v)
  );
  const counts: HistoryCounts = { total: 0, byStatus: {}, byRisk: { LOW: 0, MEDIUM: 0, HIGH: 0, none: 0 }, incidents: 0 };
  for (const r of rows) {
    counts.total += r.n;
    counts.incidents += r.incidents;
    counts.byStatus[r.status] = (counts.byStatus[r.status] ?? 0) + r.n;
    counts.byRisk[r.risk as keyof HistoryCounts["byRisk"]] += r.n;
  }
  return counts;
}

export type RepositoryOption = { github_repository_id: string; full_name: string };

/** Internal tooling: every repository seen in deployments (users get theirs from the session). */
export async function listRepositoryOptions(limit = 100): Promise<RepositoryOption[]> {
  const { rows } = await getPool().query<RepositoryOption>(
    `SELECT DISTINCT ON (github_repository_id) github_repository_id::text, owner || '/' || repository AS full_name
     FROM deployments WHERE github_repository_id IS NOT NULL
     ORDER BY github_repository_id, created_at DESC LIMIT $1`,
    [limit]
  );
  return rows.sort((a, b) => a.full_name.localeCompare(b.full_name));
}

export type IncidentDetail = {
  incident: Incident;
  deployment: Deployment;
  /** Other incidents of the same repository with the same failure type (observed fact, not a causal claim). */
  related: (IncidentListItem & { deployment_created_at: Date })[];
  /** Stage 4.1: the confirmation edit history, newest first. */
  confirmations: IncidentConfirmation[];
};

/** One incident, only if its deployment is inside the viewer's scope (otherwise null, like a missing one). */
export async function getIncidentDetail(incidentId: string, v: ViewScope): Promise<IncidentDetail | null> {
  const { rows } = await getPool().query<Incident>(
    `SELECT ${incidentColumns("i")}
     FROM incidents i JOIN deployments d ON d.id = i.deployment_id
     WHERE i.id = $4 AND ${SCOPE_SQL}`,
    [...scopeParams(v), incidentId]
  );
  const incident = rows[0];
  if (!incident) return null;
  const deployment = await getDeploymentById(incident.deployment_id);
  if (!deployment) return null;
  const related = await getPool().query<IncidentListItem & { deployment_created_at: Date }>(
    `SELECT ${incidentColumns("i")},
            d.owner || '/' || d.repository AS repository, d.branch, d.commit_sha,
            d.status AS deployment_status, d.failure_stage, d.created_at AS deployment_created_at
     FROM incidents i JOIN deployments d ON d.id = i.deployment_id
     WHERE ${SCOPE_SQL} AND i.id <> $4 AND i.failure_type = $5
       AND d.github_repository_id IS NOT DISTINCT FROM $6::bigint
     ORDER BY i.created_at DESC LIMIT 10`,
    [...scopeParams(v), incidentId, incident.failure_type, deployment.github_repository_id]
  );
  return { incident, deployment, related: related.rows, confirmations: await listConfirmations(incident.id) };
}
