import type { Deployment } from "@/lib/db/deployments";
import type { Incident } from "@/lib/db/incidents";
import type { MemoryItem } from "@/lib/hindsight/client";
import { repositoryScopeTags } from "@/lib/hindsight/deployment-memory";

/**
 * Turns an incident (plus the deployment it belongs to) into a Hindsight memory.
 *
 * The deployment memory (deployment-memory.ts) answers "what was deployed and
 * how did it end". This one answers "what went wrong", so later phases can ask
 * "have we seen a failure like this before?" and get incidents back directly.
 *
 * Same conventions as the deployment memory:
 *  - `content` is plain sentences, because recall is semantic.
 *  - `tags` allow an exact filter: every incident carries `incident`, plus its
 *    own `incident:<id>`, so one specific incident can be recalled.
 *  - `document_id` + `update_mode: "replace"`: re-storing the same incident
 *    overwrites its memory rather than duplicating it.
 *
 * Evidence rule: every sentence comes from the incident or deployment row.
 * Fields that are NULL are stated as "not known" -- never guessed.
 */

/** Enough of the failing output to be recognisable, without flooding recall. */
const MAX_ERROR_TEXT = 1500;

export function buildIncidentMemory(incident: Incident, deployment: Deployment): MemoryItem {
  const repo = `${deployment.owner}/${deployment.repository}`;
  const shortSha = deployment.commit_sha.slice(0, 7);
  const stage = deployment.failure_stage ?? "unknown";

  const lines = [
    `Incident #${incident.id}: deployment #${deployment.id} of repository ${repo} ` +
      `on branch ${deployment.branch} FAILED at the ${stage} stage.`,
    `Commit ${shortSha} (full SHA ${deployment.commit_sha}) by ${deployment.author}: ` +
      `${deployment.commit_message.split("\n")[0].trim() || "(empty commit message)"}`,
    `Failure type: ${incident.failure_type}.`,
    `Failed job: ${incident.failure_job ?? "not reported"}.`,
    `Files changed by this deployment: ${deployment.changed_files.join(", ") || "none"}.`,
    incident.error_message
      ? `Observed failure output:\n${truncate(incident.error_message, MAX_ERROR_TEXT)}`
      : "The pipeline did not report any failure output.",
    `Affected service: ${known(incident.affected_service)}.`,
    `Downstream effect: ${known(incident.downstream_effect)}.`,
    `Root cause: ${known(incident.root_cause)}.`,
    `Resolution: ${known(incident.resolution)}.`,
    ...(deployment.ci_run_url ? [`GitHub Actions run: ${deployment.ci_run_url}.`] : []),
  ];

  return {
    content: lines.join("\n"),
    timestamp: (deployment.ci_finished_at ?? incident.created_at).toISOString(),
    context: `DeployGuard incident record for ${repo}`,
    document_id: `incident/${incident.id}`,
    update_mode: "replace",
    tags: [
      "incident",
      ...repositoryScopeTags(deployment),
      `incident:${incident.id}`,
      `deployment:${deployment.id}`,
      `repo:${repo}`,
      `branch:${deployment.branch}`,
      `failure-type:${incident.failure_type}`,
      `failed-stage:${stage}`,
      `commit:${shortSha}`,
    ],
    metadata: {
      kind: "incident",
      incident_id: incident.id,
      ...(deployment.github_repository_id ? { github_repository_id: deployment.github_repository_id } : {}),
      deployment_id: deployment.id,
      repository_full_name: repo,
      branch: deployment.branch,
      commit_sha: deployment.commit_sha,
      status: deployment.status,
      failure_type: incident.failure_type,
      failure_stage: stage,
      ...(incident.failure_job ? { failure_job: incident.failure_job } : {}),
      // Recorded explicitly so a reader can tell "unknown" from "forgot to copy".
      root_cause_known: String(incident.root_cause !== null),
      resolution_known: String(incident.resolution !== null),
    },
  };
}

function known(value: string | null): string {
  return value ?? "not known (not yet determined)";
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `... ${text.slice(-max)}`;
}
