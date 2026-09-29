import { analyzeChanges } from "@/lib/analysis/change-analysis";
import { insertDeployment, type Deployment } from "@/lib/db/deployments";
import type { PushEvent } from "@/lib/github/parse-push-event";
import { retain } from "@/lib/hindsight/client";
import { buildDeploymentMemory } from "@/lib/hindsight/deployment-memory";
import { scheduleRiskAnalysis } from "@/lib/risk/auto-risk";

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
  memory?: { stored: boolean; error?: string };
  riskScheduled: boolean;
};

export async function ingestPush(
  event: PushEvent,
  repositoryId: string | null,
  options: { autoRisk: boolean; source: string }
): Promise<IngestResult> {
  // Phase 5: classify the changed files by path (deterministic, no I/O).
  const analysis = analyzeChanges({
    added: event.addedFiles,
    modified: event.modifiedFiles,
    deleted: event.deletedFiles,
  });
  console.log(
    `[DeployGuard][analysis] Categories: ${analysis.categories.join(", ") || "(none)"} | ` +
      `Services/components: ${analysis.services.join(", ") || "(none determined)"}`
  );

  // Database (source of truth). Throws on failure; the caller decides the HTTP answer.
  const { deployment, isNew } = await insertDeployment(event, analysis, repositoryId);

  if (!isNew) {
    console.log(
      `[DeployGuard][db] Deployment #${deployment.id} already recorded for ${event.commitSha.slice(0, 7)} - duplicate ${options.source} ignored.`
    );
    return { deployment, isNew, riskScheduled: false };
  }
  console.log(`[DeployGuard][db] Stored deployment #${deployment.id} with status ${deployment.status} (${options.source}).`);

  // Agent memory (best effort).
  let memory: { stored: boolean; error?: string };
  try {
    await retain(buildDeploymentMemory(deployment));
    memory = { stored: true };
    console.log(`[DeployGuard][memory] Stored deployment #${deployment.id} in Hindsight.`);
  } catch (error) {
    memory = { stored: false, error: (error as Error).message };
    console.error(
      `[DeployGuard][memory] Hindsight write FAILED for deployment #${deployment.id}: ${memory.error}\n` +
        `             The deployment IS safely stored in the database. Re-store it later with the internal /api/memory/backfill endpoint.`
    );
  }

  // Automatic risk analysis (Phase 8): marked pending now, runs after the response.
  const riskScheduled = options.autoRisk ? await scheduleRiskAnalysis(deployment.id, options.source) : false;

  return { deployment, isNew, memory, riskScheduled };
}
