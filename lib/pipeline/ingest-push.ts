import { analyzeChanges } from "@/lib/analysis/change-analysis";
import { insertDeployment, type Deployment } from "@/lib/db/deployments";
import { detectRevert } from "@/lib/db/learning";
import { env } from "@/lib/env";
import { analysisConfigOf } from "@/lib/config/repo-config";
import { effectiveConfig, getRepositoryInputs, maybeQueueInputsRefresh } from "@/lib/github/repo-inputs";
import type { PushEvent } from "@/lib/github/parse-push-event";
import { enqueue } from "@/lib/jobs/queue";
import { JOB_TYPES } from "@/lib/jobs/types";
import { kickQueue } from "@/lib/jobs/runner";
import { scheduleRiskAnalysis } from "@/lib/risk/auto-risk";
import { redact } from "@/lib/security/redact";

/**
 * Stage 1: the commit message is untrusted and may contain credentials; it is
 * redacted before it is logged, stored or remembered. Idempotent, so applying
 * it again (webhook route, then ingestPush) changes nothing.
 */
export function redactPushEvent(event: PushEvent): PushEvent {
  const message = redact(event.commitMessage);
  if (message.count === 0) return event;
  const previous = event.commitMessageRedaction;
  return {
    ...event,
    commitMessage: message.text,
    commitMessageRedaction: {
      count: message.count + (previous?.count ?? 0),
      categories: [...new Set([...(previous?.categories ?? []), ...message.categories])].sort(),
    },
  };
}

/**
 * The push -> deployment pipeline: Phase 5 change analysis -> Phase 2 database
 * record -> Phase 2 memory -> Phase 8 automatic risk analysis.
 *
 * Extracted unchanged from POST /api/webhook/github (Phase 10) so that a push
 * recovered by the maintenance run goes through exactly the same steps as one
 * delivered by GitHub. There is still one ingestion path.
 *
 * Idempotent: the insert is keyed by (owner, repository, branch, commit), so a
 * repeated push returns the existing deployment with isNew=false and nothing
 * else runs (no second memory, no second analysis).
 *
 * Throws only if the database insert fails.
 */
export type IngestResult = {
  deployment: Deployment;
  isNew: boolean;
  memory?: { queued: boolean; jobId?: string };
  riskScheduled: boolean;
};

export async function ingestPush(
  event: PushEvent,
  repositoryId: string | null,
  options: { autoRisk: boolean; source: string }
): Promise<IngestResult> {
  // Stage 1: every ingestion path (webhook, recovered push) is redacted here.
  event = redactPushEvent(event);
  if (event.commitMessageRedaction) {
    console.warn(
      `[DeployGuard][redaction] Commit ${event.commitSha.slice(0, 7)}: masked ${event.commitMessageRedaction.count} ` +
        `item(s) in the commit message (${event.commitMessageRedaction.categories.join(", ")}).`
    );
  }

  // Stage 5: the repository's cached .deployguard.yml (a database read; GitHub is never called here).
  const githubRepositoryId = event.githubRepositoryId != null ? String(event.githubRepositoryId) : null;
  const inputs = repositoryId ? await getRepositoryInputs(githubRepositoryId).catch(() => null) : null;
  const config = effectiveConfig(inputs);

  // Phase 5: classify the changed files by path (deterministic, no I/O).
  const analysis = analyzeChanges(
    {
      added: event.addedFiles,
      modified: event.modifiedFiles,
      deleted: event.deletedFiles,
    },
    analysisConfigOf(config)
  );
  console.log(
    `[DeployGuard][analysis] Categories: ${analysis.categories.join(", ") || "(none)"} | ` +
      `Services/components: ${analysis.services.join(", ") || "(none determined)"}`
  );

  // Database (source of truth). Throws on failure; the caller decides the HTTP answer.
  const { deployment, isNew } = await insertDeployment(
    event,
    analysis,
    repositoryId,
    repositoryId ? { status: inputs?.config_status ?? "not_read_yet", sha: config ? inputs?.config_sha ?? null : null } : null
  );
  // Owned repositories only: keep the cached config/CODEOWNERS fresh (queued, never inline).
  if (repositoryId) {
    await maybeQueueInputsRefresh(githubRepositoryId, { branch: event.branch, commitSha: event.commitSha, changedFiles: event.changedFiles }, inputs);
  }

  if (!isNew) {
    console.log(
      `[DeployGuard][db] Deployment #${deployment.id} already recorded for ${event.commitSha.slice(0, 7)} - duplicate ${options.source} ignored.`
    );
    return { deployment, isNew, riskScheduled: false };
  }
  console.log(`[DeployGuard][db] Stored deployment #${deployment.id} with status ${deployment.status} (${options.source}).`);

  // Stage 4.5: is this push a revert of a recent deployment? (observed signal, best effort)
  try {
    const revert = await detectRevert(deployment, env.revertWindowHours());
    if (revert) {
      console.log(
        `[DeployGuard][learning] Deployment #${deployment.id} reverts deployment #${revert.reverted_deployment_id} ` +
          `(${revert.matched_by}, ${revert.hours_after}h later).`
      );
    }
  } catch (error) {
    console.error(`[DeployGuard][learning] Revert check failed for deployment #${deployment.id}: ${(error as Error).message}`);
  }

  // Agent memory (Stage 2: a queued job with retries, never inside the request).
  let memory: { queued: boolean; jobId?: string };
  try {
    const job = await enqueue(
      JOB_TYPES.deploymentMemory,
      { deploymentId: deployment.id },
      { dedupeKey: `memory.deployment:${deployment.id}:RECEIVED`, maxAttempts: 6 }
    );
    memory = { queued: true, jobId: job.id };
  } catch (error) {
    memory = { queued: false };
    console.error(
      `[DeployGuard][memory] Could not queue the memory for deployment #${deployment.id}: ${(error as Error).message}\n` +
        `             The deployment IS safely stored in the database. Re-store it later with the internal /api/memory/backfill endpoint.`
    );
  }

  // Automatic risk analysis (Phase 8): marked pending now, queued as a job.
  const riskScheduled = options.autoRisk ? await scheduleRiskAnalysis(deployment.id, options.source) : false;
  kickQueue();

  return { deployment, isNew, memory, riskScheduled };
}
