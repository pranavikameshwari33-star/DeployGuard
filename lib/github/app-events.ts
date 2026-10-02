import {
  addRepositoryIfNew,
  disconnectRepositories,
  findMonitoredRepository,
  findUserIdByGithubId,
  getInstallationStatus,
  replaceInstallationRepositories,
  setInstallationStatus,
  upsertInstallation,
  upsertRepositories,
  type RepositoryInfo,
} from "@/lib/db/accounts";
import { deploymentExists, type Deployment, type PipelineStatus, type StatusUpdate } from "@/lib/db/deployments";
import { forgetInstallationToken, getCommit, installationGet, installationGetText } from "@/lib/github/app";
import type { PushEvent } from "@/lib/github/parse-push-event";
import { applyPipelineStatus } from "@/lib/pipeline/apply-status";
import { ingestPush } from "@/lib/pipeline/ingest-push";
import { enqueue } from "@/lib/jobs/queue";
import { aggregateRuns, FAILED_CONCLUSIONS } from "@/lib/github/aggregate-runs";
import { JOB_TYPES } from "@/lib/jobs/types";

/**
 * Phase 9: the GitHub App events the existing webhook endpoint now understands.
 * All of them arrive at /api/webhook/github AFTER its signature check.
 *
 *   installation               -- the app was installed / uninstalled / suspended
 *   installation_repositories  -- the user changed which repositories it may see
 *   push                       -- resolveRepositoryForEvent(): which connected repository owns it
 *   workflow_run               -- GitHub Actions progress -> the existing Phase 3 lifecycle
 */

type Account = { id?: number; login?: string; type?: string };
type PayloadRepo = { id: number; name: string; full_name: string; private?: boolean; owner?: { login?: string; id?: number } };

function repoInfo(r: PayloadRepo): RepositoryInfo {
  return {
    githubRepositoryId: r.id,
    owner: r.owner?.login ?? r.full_name.split("/")[0],
    name: r.name,
    fullName: r.full_name,
    private: r.private ?? null,
  };
}

function installationInfo(installation: { id: number; account?: Account }) {
  return {
    installationId: installation.id,
    accountId: installation.account?.id ?? null,
    accountLogin: installation.account?.login ?? null,
    accountType: installation.account?.type ?? null,
  };
}

/**
 * The GitHub user who installed or changed the app is in `sender`. The event is
 * signed by GitHub, so if that user already has a DeployGuard account, the
 * installation is attached to it (only if unclaimed -- never moved).
 */
async function senderUserId(payload: { sender?: { id?: number } }): Promise<string | null> {
  return typeof payload.sender?.id === "number" ? findUserIdByGithubId(payload.sender.id) : null;
}

// ---------------------------------------------------------------------------
// installation / installation_repositories
// ---------------------------------------------------------------------------

export async function handleInstallationEvent(payload: {
  action?: string;
  installation?: { id: number; account?: Account };
  repositories?: PayloadRepo[];
  sender?: { id?: number };
}): Promise<string> {
  const installation = payload.installation;
  if (!installation?.id) return "ignored: no installation in payload";
  const id = installation.id;

  switch (payload.action) {
    case "deleted":
      await setInstallationStatus(id, "deleted");
      forgetInstallationToken(id);
      console.log(`[DeployGuard][github] Installation ${id} removed -- its repositories are no longer monitored.`);
      return "installation deleted; repositories disconnected";
    case "suspend":
      await upsertInstallation(installationInfo(installation), { status: "suspended" });
      forgetInstallationToken(id);
      console.log(`[DeployGuard][github] Installation ${id} suspended -- monitoring paused.`);
      return "installation suspended";
    case "unsuspend": {
      // Phase 10: resume only for what is authorised NOW -- re-read the
      // installation and its repository list from GitHub before monitoring again.
      // Stage 2: the GitHub API calls run as a queued job, not inside the webhook request.
      await upsertInstallation(installationInfo(installation), { status: "active" });
      await enqueue(JOB_TYPES.installationReconcile, { installationId: String(id) }, { dedupeKey: `reconcile:${id}:${Date.now()}` });
      console.log(`[DeployGuard][github] Installation ${id} reactivated; repository resync queued.`);
      return "installation reactivated; resynchronisation queued";
    }
    default: {
      // created, new_permissions_accepted, ...
      await upsertInstallation(installationInfo(installation), {
        status: "active",
        claimForUserId: await senderUserId(payload),
        // Phase 10: the (signed) sender of "created" is the person who installed it.
        installedByGithubUserId: payload.action === "created" ? payload.sender?.id ?? null : null,
      });
      if (payload.action === "created" && Array.isArray(payload.repositories)) {
        await replaceInstallationRepositories(id, payload.repositories.map(repoInfo));
      }
      console.log(
        `[DeployGuard][github] Installation ${id} ${payload.action ?? "updated"}` +
          (payload.repositories ? ` with ${payload.repositories.length} repositor(ies).` : ".")
      );
      return `installation ${payload.action ?? "updated"}`;
    }
  }
}

export async function handleInstallationRepositoriesEvent(payload: {
  installation?: { id: number; account?: Account };
  repositories_added?: PayloadRepo[];
  repositories_removed?: PayloadRepo[];
  sender?: { id?: number };
}): Promise<string> {
  const installation = payload.installation;
  if (!installation?.id) return "ignored: no installation in payload";

  await upsertInstallation(installationInfo(installation), { claimForUserId: await senderUserId(payload) });
  const added = payload.repositories_added ?? [];
  const removed = payload.repositories_removed ?? [];
  if (added.length) await upsertRepositories(installation.id, added.map(repoInfo));
  if (removed.length) await disconnectRepositories(installation.id, removed.map((r) => r.id));

  console.log(
    `[DeployGuard][github] Installation ${installation.id}: +${added.length} / -${removed.length} repositor(ies).`
  );
  return `repositories added ${added.length}, removed ${removed.length}`;
}

// ---------------------------------------------------------------------------
// push: which connected repository does this event belong to?
// ---------------------------------------------------------------------------

export type RepositoryResolution =
  | { kind: "unowned" } // a plain repository webhook (no App installation): recorded without an owner, as before Phase 9
  | { kind: "owned"; repositoryId: string }
  | { kind: "not_monitored"; reason: string };

export async function resolveRepositoryForEvent(payload: {
  installation?: { id?: number };
  repository?: PayloadRepo;
}): Promise<RepositoryResolution> {
  const installationId = payload.installation?.id;
  if (typeof installationId !== "number") return { kind: "unowned" };
  const repo = payload.repository;
  if (!repo?.id) return { kind: "not_monitored", reason: "no repository in payload" };

  const status = await getInstallationStatus(installationId);
  if (status === "deleted" || status === "suspended") {
    return { kind: "not_monitored", reason: `installation ${status}` };
  }

  const monitored = await findMonitoredRepository(installationId, repo.id);
  if (monitored) return { kind: "owned", repositoryId: monitored.id };

  // GitHub only delivers events for repositories the installation can access,
  // so a signed event proves access. Record it if an earlier installation
  // webhook was missed (the installation stays unclaimed until its user signs in).
  if (status === null) {
    await upsertInstallation({
      installationId,
      accountId: repo.owner?.id ?? null,
      accountLogin: repo.owner?.login ?? null,
      accountType: null,
    });
  }
  // Phase 10: only an UNKNOWN repository is added from an event. One that was
  // disconnected stays disconnected: a late or redelivered event must not
  // silently re-enable monitoring (the authoritative repository list does that).
  const recorded = await addRepositoryIfNew(installationId, repoInfo(repo));
  if (!recorded.connected) return { kind: "not_monitored", reason: "repository was disconnected from DeployGuard" };
  return { kind: "owned", repositoryId: recorded.id };
}

// ---------------------------------------------------------------------------
// workflow_run -> the existing Phase 3 lifecycle
// ---------------------------------------------------------------------------

type WorkflowRun = {
  id: number;
  name?: string;
  run_number?: number;
  head_branch: string | null;
  head_sha: string;
  status: string | null;
  conclusion: string | null;
  event?: string;
  html_url?: string;
  /** Stage 2: GitHub's timestamp of this state of the run, used to ignore out-of-order events. */
  updated_at?: string;
  run_attempt?: number;
};

type WorkflowRunPayload = {
  action?: string;
  workflow_run?: WorkflowRun;
  repository?: PayloadRepo;
  installation?: { id?: number };
};

/** Conclusions that mean the pipeline failed. cancelled / skipped / neutral are not failures. */

const LOG_TAIL_LINES = 40;
const MAX_FAILURE_MESSAGE = 4000;
const NOT_FOUND_RETRIES = 4;
const RETRY_DELAY_MS = 5000;

/**
 * Maps one workflow_run event to the existing lifecycle:
 *   requested / in_progress                    -> BUILDING
 *   completed, every push run for the commit ok -> SUCCESS
 *   completed, any push run for the commit failed -> FAILED (+ failed job/step/log tail)
 *
 * A commit can trigger several workflows, so a "completed" event looks at ALL
 * push-triggered runs for the commit before deciding. Runs triggered by pull
 * requests, schedules etc. are not deployments and are ignored.
 */
export async function processWorkflowRun(
  payload: WorkflowRunPayload,
  options: { waitForPush?: boolean } = {}
): Promise<string> {
  const run = payload.workflow_run;
  const repo = payload.repository;
  const installationId = payload.installation?.id;
  if (!run || !repo || typeof installationId !== "number") return "ignored: incomplete payload";
  if (run.event && run.event !== "push") return `ignored: run triggered by ${run.event}, not a push`;
  if (!run.head_branch) return "ignored: no branch";

  const monitored = await findMonitoredRepository(installationId, repo.id);
  if (!monitored) return "ignored: repository is not connected to DeployGuard";

  let update: StatusUpdate | null;
  if (payload.action === "requested" || payload.action === "in_progress") {
    update = { status: "BUILDING", ciRunId: String(run.id), ciRunUrl: run.html_url, eventAt: run.updated_at };
  } else if (payload.action === "completed") {
    update = await completedUpdate(installationId, repo.full_name, run);
    if (update) update.eventAt = run.updated_at;
  } else {
    return `ignored: action ${payload.action}`;
  }
  if (!update) return "no lifecycle change";

  const key = {
    owner: repo.owner?.login ?? repo.full_name.split("/")[0],
    repository: repo.name,
    branch: run.head_branch,
    commitSha: run.head_sha.toLowerCase(),
  };

  // The workflow can start before the push webhook has been processed. Inline
  // callers wait briefly; the job queue (Stage 2) instead retries with backoff.
  const tries = options.waitForPush === false ? 1 : NOT_FOUND_RETRIES;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const result = await applyPipelineStatus(key, update, "actions");
    if (result.outcome !== "not_found") return `${update.status}: ${result.outcome}`;
    if (attempt < tries) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }
  return `${update.status}: no deployment recorded for this push`;
}

async function completedUpdate(installationId: number, fullName: string, run: WorkflowRun): Promise<StatusUpdate | null> {
  // Every push-triggered run for this commit (latest attempt of each).
  let runs: WorkflowRun[] = [run];
  try {
    const listed = await installationGet<{ workflow_runs: WorkflowRun[] }>(
      installationId,
      `/repos/${fullName}/actions/runs?head_sha=${run.head_sha}&event=push&per_page=100`
    );
    const sameBranch = listed.workflow_runs.filter((r) => r.head_branch === run.head_branch);
    if (sameBranch.length) runs = sameBranch;
  } catch (error) {
    console.warn(
      `[DeployGuard][actions] Could not list runs for ${run.head_sha.slice(0, 7)} (${(error as Error).message}); using this run only.`
    );
  }

  // Stage 2: the aggregation rule lives in lib/github/aggregate-runs.ts (unit-tested).
  const result = aggregateRuns(runs);
  if (result.outcome === "FAILED") {
    return {
      status: "FAILED",
      ciRunId: String(result.run.id),
      ciRunUrl: result.run.html_url,
      failure: await failureDetails(installationId, fullName, result.run),
    };
  }
  if (result.outcome === "SUCCESS") {
    return { status: "SUCCESS" as PipelineStatus, ciRunId: String(run.id), ciRunUrl: run.html_url };
  }
  return null; // BUILDING: other workflows still running; NONE: e.g. all cancelled
}

type Job = {
  id: number;
  name: string;
  conclusion: string | null;
  steps?: { name: string; conclusion: string | null }[];
};

/** What GitHub reports about the failure: failed job, failed step, and the end of the job's log. Nothing inferred. */
async function failureDetails(installationId: number, fullName: string, run: WorkflowRun) {
  const workflow = run.name ?? "workflow";
  let job: Job | undefined;
  let step: { name: string } | undefined;
  try {
    const jobs = await installationGet<{ jobs: Job[] }>(
      installationId,
      `/repos/${fullName}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`
    );
    job = jobs.jobs.find((j) => FAILED_CONCLUSIONS.has(j.conclusion ?? ""));
    step = job?.steps?.find((s) => FAILED_CONCLUSIONS.has(s.conclusion ?? ""));
  } catch (error) {
    console.warn(`[DeployGuard][actions] Could not read jobs for run ${run.id}: ${(error as Error).message}`);
  }

  let message = `Workflow "${workflow}" concluded "${run.conclusion}"` +
    (job ? `; failed job "${job.name}"` : "") +
    (step ? `; failed step "${step.name}"` : "") +
    ".";
  if (job) {
    try {
      const log = await installationGetText(installationId, `/repos/${fullName}/actions/jobs/${job.id}/logs`);
      const tail = log
        .replace(/\r/g, "")
        .split("\n")
        .map((line) => line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, "").replace(/\x1b\[[0-9;]*m/g, ""))
        .filter((line) => line.trim() !== "")
        .slice(-LOG_TAIL_LINES)
        .join("\n");
      if (tail) message = `${message}\n${tail}`.slice(-MAX_FAILURE_MESSAGE);
    } catch (error) {
      console.warn(`[DeployGuard][actions] Could not read the log of job ${job.id}: ${(error as Error).message}`);
    }
  }

  return {
    stage: (step?.name ?? job?.name ?? workflow).slice(0, 50),
    job: `${workflow} / ${job?.name ?? "unknown job"}`.slice(0, 200),
    message,
  };
}

// ---------------------------------------------------------------------------
// Phase 10: recovery when webhooks were missed (used by the maintenance run)
// ---------------------------------------------------------------------------

/** Push-triggered runs for one commit on one branch (latest attempt of each workflow). */
async function pushRunsForCommit(installationId: number, fullName: string, sha: string, branch: string): Promise<WorkflowRun[]> {
  const listed = await installationGet<{ workflow_runs: WorkflowRun[] }>(
    installationId,
    `/repos/${fullName}/actions/runs?head_sha=${sha}&event=push&per_page=100`
  );
  return listed.workflow_runs.filter((r) => r.head_branch === branch);
}

/**
 * Re-derives a deployment's pipeline state from GitHub Actions, for a
 * deployment stuck in RECEIVED/BUILDING because workflow_run events were
 * missed. Uses the same aggregation and the same lifecycle function as the
 * webhook path, so the result is identical to what the events would have done.
 */
export async function refreshDeploymentFromActions(d: Deployment, installationId: number, fullName: string): Promise<string> {
  const runs = await pushRunsForCommit(installationId, fullName, d.commit_sha, d.branch);
  if (runs.length === 0) return "no push-triggered workflow runs for this commit";

  const key = { owner: d.owner, repository: d.repository, branch: d.branch, commitSha: d.commit_sha };
  const latest = runs[0];
  if (runs.some((r) => r.status !== "completed")) {
    if (d.status !== "RECEIVED") return "still running";
    const result = await applyPipelineStatus(key, { status: "BUILDING", ciRunId: String(latest.id), ciRunUrl: latest.html_url }, "reconcile");
    return `BUILDING: ${result.outcome}`;
  }
  const update = await completedUpdate(installationId, fullName, latest);
  if (!update) return "runs completed without a success/failure outcome (e.g. cancelled)";
  const result = await applyPipelineStatus(key, update, "reconcile");
  return `${update.status}: ${result.outcome}`;
}

export type RecoverableRepository = {
  id: string;
  github_repository_id: string;
  owner: string;
  name: string;
  full_name: string;
};

/**
 * Finds pushes DeployGuard never received: push-triggered workflow runs in the
 * last `sinceHours` whose commit has no deployment. Each is rebuilt from the
 * commit (GitHub API, Contents: read) and sent through the normal ingestion
 * path, then its pipeline state is taken from the runs.
 *
 * Limitation (documented): only pushes that triggered a GitHub Actions run can
 * be discovered, and the recovered file list is the head commit's (a missed
 * multi-commit push is represented by its last commit).
 */
export async function recoverMissedPushes(
  installationId: number,
  repo: RecoverableRepository,
  options: { sinceHours: number; maxPushes: number }
): Promise<{ recovered: string[]; skipped: number }> {
  const since = new Date(Date.now() - options.sinceHours * 3600 * 1000).toISOString().slice(0, 19) + "Z";
  const listed = await installationGet<{ workflow_runs: WorkflowRun[] }>(
    installationId,
    `/repos/${repo.full_name}/actions/runs?event=push&per_page=50&created=${encodeURIComponent(`>=${since}`)}`
  );

  const seen = new Set<string>();
  const recovered: string[] = [];
  let skipped = 0;
  for (const run of listed.workflow_runs) {
    if (!run.head_branch || recovered.length >= options.maxPushes) break;
    const key = `${run.head_branch}@${run.head_sha}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (await deploymentExists(repo.owner, repo.name, run.head_branch, run.head_sha.toLowerCase())) {
      skipped++;
      continue;
    }

    const commit = await getCommit(installationId, repo.full_name, run.head_sha);
    const event = pushEventFromCommit(repo, run, commit, installationId);
    const result = await ingestPush(event, repo.id, { autoRisk: true, source: "recovered push" });
    if (result.isNew) {
      recovered.push(result.deployment.id);
      console.log(`[DeployGuard][reconcile] Recovered missed push ${run.head_sha.slice(0, 7)} on ${repo.full_name}@${run.head_branch} as deployment #${result.deployment.id}.`);
      try {
        await refreshDeploymentFromActions(result.deployment, installationId, repo.full_name);
      } catch (error) {
        console.warn(`[DeployGuard][reconcile] Could not read pipeline state for #${result.deployment.id}: ${(error as Error).message}`);
      }
    }
  }
  return { recovered, skipped };
}

function pushEventFromCommit(
  repo: RecoverableRepository,
  run: WorkflowRun,
  commit: Awaited<ReturnType<typeof getCommit>>,
  installationId: number
): PushEvent {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const f of commit.files ?? []) {
    if (f.status === "added" || f.status === "copied") added.push(f.filename);
    else if (f.status === "removed") deleted.push(f.filename);
    else if (f.status === "renamed") {
      added.push(f.filename);
      if (f.previous_filename) deleted.push(f.previous_filename);
    } else modified.push(f.filename);
  }
  const branch = run.head_branch ?? "";
  return {
    deliveryId: `recovered:${run.head_sha}`,
    receivedAt: new Date().toISOString(),
    repository: repo.name,
    owner: repo.owner,
    repositoryFullName: repo.full_name,
    branch,
    ref: `refs/heads/${branch}`,
    commitSha: run.head_sha.toLowerCase(),
    commitMessage: commit.commit.message ?? "",
    author: commit.author?.login ?? commit.commit.author?.name ?? "unknown",
    authorEmail: commit.commit.author?.email ?? "",
    pusher: "unknown (recovered)",
    timestamp: commit.commit.author?.date ?? new Date().toISOString(),
    commitCount: 1,
    compareUrl: "",
    addedFiles: added.sort(),
    modifiedFiles: modified.sort(),
    deletedFiles: deleted.sort(),
    changedFiles: [...added, ...modified, ...deleted].sort(),
    githubRepositoryId: Number(repo.github_repository_id),
    installationId,
  };
}
