import type { Deployment } from "@/lib/db/deployments";
import type { MemoryItem } from "@/lib/hindsight/client";

/**
 * Turns a stored deployment row into a Hindsight memory.
 *
 * The database answers "what exactly happened". Hindsight answers "have we seen
 * anything like this before?". That difference drives the shape below:
 *
 *  - `content` is written as plain sentences, because recall is semantic. A
 *    query like "have we changed the database config before?" has to match this
 *    text, so the file paths and the words around them are spelled out rather
 *    than encoded as JSON.
 *  - `tags` give later phases a cheap exact filter (this repo, this branch,
 *    this status) before the semantic search runs.
 *  - `metadata` carries the machine-readable ids back, most importantly
 *    `deployment_id`, so any recalled memory can be traced to the real database
 *    row. Phase 7 needs that link to prove a historical claim is real.
 *  - `document_id` + `update_mode: "replace"` mean re-storing the same
 *    deployment overwrites its memory instead of adding a near-duplicate. When
 *    Phase 3 updates the status to SUCCESS or FAILED, it rewrites this memory.
 *
 * Nothing here is inferred. Every sentence comes from the GitHub push event or
 * from what the CI pipeline reported. A failure is described by where it
 * stopped and what it printed -- never by a guessed cause.
 */

/** Enough of a failure's output to be recognisable later, without flooding recall. */
const MAX_FAILURE_TEXT = 1500;

/** Keeps the memory readable when someone pushes a thousand-file change. */
const MAX_FILES_IN_TEXT = 40;

export function buildDeploymentMemory(deployment: Deployment): MemoryItem {
  const repo = `${deployment.owner}/${deployment.repository}`;
  const shortSha = deployment.commit_sha.slice(0, 7);

  return {
    content: buildContent(deployment, repo, shortSha),
    timestamp: deployment.created_at.toISOString(),
    context: `DeployGuard deployment record for ${repo}`,
    document_id: `deployment/${repo}/${deployment.branch}/${deployment.commit_sha}`,
    update_mode: "replace",
    tags: buildTags(deployment, repo, shortSha),
    metadata: {
      kind: "deployment",
      deployment_id: deployment.id,
      repository: deployment.repository,
      owner: deployment.owner,
      repository_full_name: repo,
      branch: deployment.branch,
      commit_sha: deployment.commit_sha,
      author: deployment.author,
      status: deployment.status,
      changed_file_count: String(deployment.changed_files.length),
      created_at: deployment.created_at.toISOString(),
      ...(deployment.ci_run_url ? { ci_run_url: deployment.ci_run_url } : {}),
      ...(deployment.ci_finished_at
        ? { ci_finished_at: deployment.ci_finished_at.toISOString() }
        : {}),
      ...(deployment.failure_stage ? { failure_stage: deployment.failure_stage } : {}),
      ...(deployment.failure_job ? { failure_job: deployment.failure_job } : {}),
    },
  };
}

function buildContent(deployment: Deployment, repo: string, shortSha: string): string {
  const lines: string[] = [
    `Deployment event for repository ${repo} on branch ${deployment.branch}.`,
    `Commit ${shortSha} (full SHA ${deployment.commit_sha}) by ${deployment.author}.`,
    `Commit message: ${firstLine(deployment.commit_message) || "(empty)"}`,
    `Deployment status: ${deployment.status}.`,
    `This deployment changed ${deployment.changed_files.length} file(s).`,
  ];

  if (deployment.added_files.length) {
    lines.push(`Files added: ${fileList(deployment.added_files)}.`);
  }
  if (deployment.modified_files.length) {
    lines.push(`Files modified: ${fileList(deployment.modified_files)}.`);
  }
  if (deployment.deleted_files.length) {
    lines.push(`Files deleted: ${fileList(deployment.deleted_files)}.`);
  }

  // Naming the directories separately gives recall a second, coarser handle:
  // "have we deployed changes to config/ before?" matches even when the exact
  // filename differs.
  const areas = topLevelAreas(deployment.changed_files);
  if (areas.length) {
    lines.push(`Areas of the repository touched: ${areas.join(", ")}.`);
  }

  lines.push(`Recorded by DeployGuard at ${deployment.created_at.toISOString()}.`);
  lines.push(pipelineOutcome(deployment));

  return lines.join("\n");
}

/** What the CI pipeline reported, and nothing more. */
function pipelineOutcome(deployment: Deployment): string {
  const finished = deployment.ci_finished_at?.toISOString() ?? "an unknown time";
  const run = deployment.ci_run_url ? ` GitHub Actions run: ${deployment.ci_run_url}.` : "";

  switch (deployment.status) {
    case "SUCCESS":
      return (
        `The CI/CD pipeline SUCCEEDED: dependencies installed, tests passed, the build ` +
        `succeeded and the simulated deployment completed at ${finished}.${run}`
      );
    case "FAILED": {
      const stage = deployment.failure_stage ?? "an unknown";
      const job = deployment.failure_job ? ` in job "${deployment.failure_job}"` : "";
      const output = deployment.failure_message
        ? `\nLast output of the failing stage: ${truncate(deployment.failure_message, MAX_FAILURE_TEXT)}`
        : "";
      return (
        `The CI/CD pipeline FAILED at the ${stage} stage${job} at ${finished}.${run}${output}\n` +
        `The root cause of this failure has not been analysed.`
      );
    }
    case "BUILDING":
      return `The CI/CD pipeline is running; no outcome is known yet.${run}`;
    default:
      return `No build, test or deployment outcome is known for this deployment yet.`;
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)} ... (truncated)`;
}

function buildTags(deployment: Deployment, repo: string, shortSha: string): string[] {
  return [
    "deployment",
    `repo:${repo}`,
    `branch:${deployment.branch}`,
    `status:${deployment.status}`,
    ...(deployment.failure_stage ? [`failed-stage:${deployment.failure_stage}`] : []),
    `commit:${shortSha}`,
    `author:${deployment.author}`,
    ...topLevelAreas(deployment.changed_files).map((area) => `area:${area}`),
  ];
}

/** `config/database.yaml` -> `config`; a root-level file -> `(root)`. */
function topLevelAreas(files: string[]): string[] {
  const areas = new Set<string>();
  for (const file of files) {
    const slash = file.indexOf("/");
    areas.add(slash === -1 ? "(root)" : file.slice(0, slash));
  }
  return [...areas].sort();
}

function fileList(files: string[]): string {
  if (files.length <= MAX_FILES_IN_TEXT) {
    return files.join(", ");
  }
  const shown = files.slice(0, MAX_FILES_IN_TEXT).join(", ");
  return `${shown}, and ${files.length - MAX_FILES_IN_TEXT} more`;
}

function firstLine(message: string): string {
  return message.split("\n")[0].trim();
}
