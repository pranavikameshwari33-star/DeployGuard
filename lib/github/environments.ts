import { findMonitoredRepository } from "@/lib/db/accounts";
import { getPool } from "@/lib/db/client";
import { cleanEnvironmentName, markEnvironmentsChecked, recordEnvironmentStatus } from "@/lib/db/environments";
import { GitHubApiError, installationGet } from "@/lib/github/app";
import { enqueue } from "@/lib/jobs/queue";
import { JOB_TYPES } from "@/lib/jobs/types";

/**
 * Stage 5.5: environment awareness from GitHub's Deployments API.
 *
 *   deployment_status event  -> the environment and state of that GitHub
 *                               deployment, attached to the DeployGuard
 *                               deployment(s) of the same commit
 *   after a final CI result  -> one bounded lookup (GET /deployments?sha=)
 *                               for repositories whose events are not set up
 *
 * Needs the "Deployments: read" permission. Without it (or when GitHub
 * reports nothing) the deployment stays "environment unknown".
 */

type DeploymentStatusPayload = {
  deployment?: { id?: number; sha?: string; environment?: string };
  deployment_status?: { state?: string; created_at?: string; updated_at?: string };
  repository?: { id?: number };
  installation?: { id?: number };
};

export async function processDeploymentStatusEvent(payload: DeploymentStatusPayload): Promise<string> {
  const d = payload.deployment;
  const repoId = payload.repository?.id;
  const installationId = payload.installation?.id;
  if (!d?.id || !d.sha || typeof repoId !== "number" || typeof installationId !== "number") return "ignored: incomplete payload";
  if (!(await findMonitoredRepository(installationId, repoId))) return "ignored: repository is not connected to DeployGuard";
  const environment = cleanEnvironmentName(d.environment);
  if (!environment) return "ignored: no environment name";
  const n = await recordEnvironmentStatus({
    githubRepositoryId: String(repoId),
    commitSha: d.sha,
    githubDeploymentId: d.id,
    environment,
    state: payload.deployment_status?.state ?? null,
    stateAt: payload.deployment_status?.updated_at ?? payload.deployment_status?.created_at ?? null,
    source: "deployment_status_event",
  });
  return n ? `${environment}: ${payload.deployment_status?.state ?? "unknown"} (${n} deployment(s))` : "no DeployGuard deployment for this commit yet";
}

/** Queued after a final CI result (owned deployments only). Never throws. */
export async function queueEnvironmentsSync(deploymentId: string): Promise<void> {
  try {
    // A little later, so a deploy job that runs after CI has had time to report.
    await enqueue(JOB_TYPES.environmentsSync, { deploymentId }, { dedupeKey: `environments:${deploymentId}:${Math.floor(Date.now() / 3_600_000)}`, maxAttempts: 3, delaySeconds: 300 });
  } catch (error) {
    console.error(`[DeployGuard][environments] Could not queue a sync for deployment #${deploymentId}: ${(error as Error).message}`);
  }
}

const MAX_GITHUB_DEPLOYMENTS = 10;

export async function syncEnvironments(deploymentId: string): Promise<string> {
  const { rows } = await getPool().query<{ commit_sha: string; github_repository_id: string; installation_id: string; full_name: string }>(
    `SELECT d.commit_sha, d.github_repository_id::text, r.installation_id::text, r.full_name
     FROM deployments d JOIN repositories r ON r.id = d.repository_id
     WHERE d.id = $1 AND r.connected`,
    [deploymentId]
  );
  const row = rows[0];
  if (!row) return "deployment not owned by a connected repository";
  const installationId = Number(row.installation_id);
  try {
    const list = await installationGet<{ id: number; environment?: string; created_at?: string }[]>(
      installationId,
      `/repos/${row.full_name}/deployments?sha=${row.commit_sha}&per_page=${MAX_GITHUB_DEPLOYMENTS}`
    );
    if (list.length === 0) {
      await markEnvironmentsChecked(deploymentId, "none");
      return "GitHub reports no deployments for this commit (environment unknown)";
    }
    let recorded = 0;
    for (const gd of list) {
      const environment = cleanEnvironmentName(gd.environment);
      if (!environment) continue;
      const statuses = await installationGet<{ state?: string; created_at?: string }[]>(
        installationId,
        `/repos/${row.full_name}/deployments/${gd.id}/statuses?per_page=1`
      );
      recorded += await recordEnvironmentStatus({
        githubRepositoryId: row.github_repository_id,
        commitSha: row.commit_sha,
        githubDeploymentId: gd.id,
        environment,
        state: statuses[0]?.state ?? null,
        stateAt: statuses[0]?.created_at ?? gd.created_at ?? null,
        source: "deployments_api",
      });
    }
    if (!recorded) await markEnvironmentsChecked(deploymentId, "none");
    return `${list.length} GitHub deployment(s) read`;
  } catch (error) {
    if (error instanceof GitHubApiError && (error.kind === "forbidden" || error.kind === "not_found")) {
      await markEnvironmentsChecked(deploymentId, "unavailable");
      return 'environment unknown: no access to the Deployments API ("Deployments: read")';
    }
    throw error;
  }
}
