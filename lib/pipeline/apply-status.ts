import {
  updateDeploymentStatus,
  type Deployment,
  type DeploymentKey,
  type DeploymentStatus,
  type StatusUpdate,
} from "@/lib/db/deployments";
import { recordIncident, type IncidentResult } from "@/lib/db/incidents";
import { retain } from "@/lib/hindsight/client";
import { buildDeploymentMemory } from "@/lib/hindsight/deployment-memory";
import { buildIncidentMemory } from "@/lib/hindsight/incident-memory";
import { scheduleRiskAnalysis } from "@/lib/risk/auto-risk";

/**
 * The deployment lifecycle update: Phase 3 status -> Phase 4 incident ->
 * memory -> Phase 8 risk refresh.
 *
 * Extracted unchanged from POST /api/deployments/status (Phase 9) so that the
 * GitHub App's workflow_run events use exactly the same logic as the CI
 * reporter -- one lifecycle, two sources.
 *
 * Throws only when the status update itself fails (a database error).
 */
export type ApplyStatusResult =
  | { outcome: "not_found" }
  | { outcome: "invalid_transition"; currentStatus: DeploymentStatus }
  | { outcome: "incident_error"; deployment: Deployment; message: string }
  | {
      outcome: "updated";
      deployment: Deployment;
      previousStatus: DeploymentStatus;
      incident?: IncidentResult;
      incidentMemory?: MemoryWrite;
      memory: MemoryWrite | { skipped: string };
      riskRefreshScheduled: boolean;
    };

type MemoryWrite = { stored: boolean; error?: string };

export async function applyPipelineStatus(
  key: DeploymentKey,
  update: StatusUpdate,
  source: string
): Promise<ApplyStatusResult> {
  const label = `${key.owner}/${key.repository}@${key.branch} ${key.commitSha.slice(0, 7)}`;

  // ---------- database (source of truth) ----------
  const result = await updateDeploymentStatus(key, update);

  if (result.outcome === "not_found") {
    console.warn(`[DeployGuard][${source}] No deployment for ${label} (status ${update.status} not applied).`);
    return result;
  }
  if (result.outcome === "invalid_transition") {
    console.warn(`[DeployGuard][${source}] Refused ${result.currentStatus} -> ${update.status} for ${label}.`);
    return result;
  }

  const { deployment, previousStatus } = result;
  console.log(
    `[DeployGuard][${source}] Deployment #${deployment.id} ${label}: ${previousStatus} -> ${deployment.status}` +
      (deployment.failure_stage ? ` (failed stage: ${deployment.failure_stage})` : "")
  );

  // ---------- incident (FAILED only, Phase 4) ----------
  // One incident per deployment; a repeated FAILED report lands on the same row.
  let incident: IncidentResult | undefined;
  if (deployment.status === "FAILED") {
    try {
      incident = await recordIncident(deployment);
      console.log(
        `[DeployGuard][incident] ${incident.isNew ? "Recorded" : "Refreshed"} incident ` +
          `#${incident.incident.id} (${incident.incident.failure_type}) for deployment #${deployment.id}.`
      );
    } catch (error) {
      const message = (error as Error).message;
      console.error(`[DeployGuard][incident] Failed to record incident for deployment #${deployment.id}: ${message}`);
      return { outcome: "incident_error", deployment, message };
    }
  }

  // ---------- agent memory (best effort, final results only) ----------
  // BUILDING is a passing moment and is not worth remembering. The final result
  // REPLACES the memory the webhook wrote (same document_id). A FAILED
  // deployment also gets its incident memory; both writes run in parallel.
  let memory: MemoryWrite | { skipped: string } = {
    skipped: "Only final results (SUCCESS / FAILED) are written to Hindsight.",
  };
  let incidentMemory: MemoryWrite | undefined;

  if (deployment.status === "SUCCESS" || deployment.status === "FAILED") {
    const [deploymentWrite, incidentWrite] = await Promise.allSettled([
      retain(buildDeploymentMemory(deployment)),
      incident ? retain(buildIncidentMemory(incident.incident, deployment)) : Promise.resolve(undefined),
    ]);

    memory = settled(deploymentWrite);
    if (memory.stored) {
      console.log(`[DeployGuard][memory] Updated deployment #${deployment.id} in Hindsight (${deployment.status}).`);
    } else {
      console.error(
        `[DeployGuard][memory] Hindsight write FAILED for deployment #${deployment.id}: ${memory.error}\n` +
          `             The ${deployment.status} status IS saved in the database. Re-store it later with: curl -X POST http://localhost:3000/api/memory/backfill`
      );
    }

    if (incident) {
      incidentMemory = settled(incidentWrite);
      const id = incident.incident.id;
      if (incidentMemory.stored) {
        console.log(`[DeployGuard][memory] Stored incident #${id} in Hindsight.`);
      } else {
        console.error(
          `[DeployGuard][memory] Hindsight write FAILED for incident #${id}: ${incidentMemory.error}\n` +
            `             The incident IS saved in the database. Re-send the FAILED report to store it again.`
        );
      }
    }
  }

  // ---------- refresh the risk analysis with the CI result (Phase 8) ----------
  // Only for deployments analysed on push, only for a final result. A repeated
  // report has the same evidence fingerprint and reuses the stored assessment.
  const riskRefreshScheduled =
    (deployment.status === "SUCCESS" || deployment.status === "FAILED") && deployment.risk_analysis_status !== null;
  if (riskRefreshScheduled) await scheduleRiskAnalysis(deployment.id, `ci ${deployment.status}`);

  return { outcome: "updated", deployment, previousStatus, incident, incidentMemory, memory, riskRefreshScheduled };
}

function settled(result: PromiseSettledResult<unknown>): MemoryWrite {
  return result.status === "fulfilled"
    ? { stored: true }
    : { stored: false, error: (result.reason as Error).message };
}
