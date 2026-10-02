import { getPool } from "@/lib/db/client";
import { redactText } from "@/lib/security/redact";

/**
 * Stage 5.5: which GitHub deployment environments a DeployGuard deployment
 * (a commit) went to, from the GitHub Deployments API / deployment_status
 * events. Nothing is inferred: when GitHub reports nothing, or could not be
 * asked, the environment is "unknown" -- never assumed to be production.
 */
export type EnvironmentFacts = {
  /** found / none / unavailable; null = not asked yet. Only "found" names an environment. */
  status: "found" | "none" | "unavailable" | null;
  environments: { name: string; state: string | null; at: Date | null }[];
};

export async function getEnvironments(deploymentId: string): Promise<EnvironmentFacts> {
  const [d, e] = await Promise.all([
    getPool().query<{ environments_status: EnvironmentFacts["status"] }>(`SELECT environments_status FROM deployments WHERE id = $1`, [deploymentId]),
    getPool().query<{ environment: string; state: string | null; state_at: Date | null }>(
      `SELECT environment, state, state_at FROM deployment_environments WHERE deployment_id = $1 ORDER BY environment, state_at DESC NULLS LAST`,
      [deploymentId]
    ),
  ]);
  return {
    status: e.rows.length ? "found" : d.rows[0]?.environments_status ?? null,
    environments: e.rows.map((r) => ({ name: r.environment, state: r.state, at: r.state_at })),
  };
}

/** Environment names from GitHub are untrusted text: redacted, single-line, capped. */
export function cleanEnvironmentName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const clean = redactText(name).replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 100);
  return clean || null;
}

const STATES = new Set(["success", "failure", "error", "inactive", "in_progress", "queued", "pending"]);

/**
 * Records (or advances) one GitHub deployment's latest status for every
 * DeployGuard deployment of that commit in that repository. A status older
 * than the one stored is ignored (out-of-order events).
 */
export async function recordEnvironmentStatus(input: {
  githubRepositoryId: string;
  commitSha: string;
  githubDeploymentId: number;
  environment: string;
  state: string | null;
  stateAt: string | null;
  source: "deployment_status_event" | "deployments_api";
}): Promise<number> {
  const state = input.state && STATES.has(input.state) ? input.state : null;
  const { rowCount } = await getPool().query(
    `INSERT INTO deployment_environments (deployment_id, github_deployment_id, environment, state, state_at, source)
     SELECT d.id, $3, $4, $5, $6::timestamptz, $7 FROM deployments d
     WHERE d.github_repository_id = $1 AND d.commit_sha = $2
     ON CONFLICT (deployment_id, github_deployment_id) DO UPDATE SET
       environment = EXCLUDED.environment, state = EXCLUDED.state, state_at = EXCLUDED.state_at,
       source = EXCLUDED.source, updated_at = now()
     WHERE deployment_environments.state_at IS NULL OR EXCLUDED.state_at IS NULL
        OR EXCLUDED.state_at >= deployment_environments.state_at`,
    [input.githubRepositoryId, input.commitSha.toLowerCase(), input.githubDeploymentId, input.environment, state, input.stateAt, input.source]
  );
  if ((rowCount ?? 0) > 0) {
    await getPool().query(
      `UPDATE deployments SET environments_status = 'found', environments_checked_at = now()
       WHERE github_repository_id = $1 AND commit_sha = $2`,
      [input.githubRepositoryId, input.commitSha.toLowerCase()]
    );
  }
  return rowCount ?? 0;
}

/** Records that GitHub was asked and reported nothing / could not be asked. Never downgrades "found". */
export async function markEnvironmentsChecked(deploymentId: string, status: "none" | "unavailable"): Promise<void> {
  await getPool().query(
    `UPDATE deployments SET environments_status = CASE WHEN environments_status = 'found' THEN 'found' ELSE $2 END,
            environments_checked_at = now()
     WHERE id = $1`,
    [deploymentId, status]
  );
}
