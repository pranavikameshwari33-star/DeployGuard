import {
  updateDeploymentStatus,
  type Deployment,
  type DeploymentKey,
  type DeploymentStatus,
  type StatusUpdate,
} from "@/lib/db/deployments";
import { markProbableFlake, recordIncident, type IncidentResult } from "@/lib/db/incidents";
import { recordRiskOutcome } from "@/lib/db/learning";
import { enqueue } from "@/lib/jobs/queue";
import { JOB_TYPES } from "@/lib/jobs/types";
import { kickQueue } from "@/lib/jobs/runner";
import { scheduleRiskAnalysis } from "@/lib/risk/auto-risk";
import { mergeSummaries, prepareFailureOutput, redact } from "@/lib/security/redact";

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
  | { outcome: "stale_event"; currentStatus: DeploymentStatus }
  | { outcome: "incident_error"; deployment: Deployment; message: string }
  | {
      outcome: "updated";
      deployment: Deployment;
      previousStatus: DeploymentStatus;
      incident?: IncidentResult;
      /** Stage 4.4: set when this SUCCESS turned an earlier failure of the same commit into a probable flake. */
      flakeIncidentId?: string;
      incidentMemory?: MemoryWrite;
      memory: MemoryWrite | { skipped: string };
      riskRefreshScheduled: boolean;
    };

/** Stage 2: memory writes are queued jobs; the result says whether the job was queued. */
type MemoryWrite = { queued: boolean; jobId?: string };

export async function applyPipelineStatus(
  key: DeploymentKey,
  update: StatusUpdate,
  source: string
): Promise<ApplyStatusResult> {
  const label = `${key.owner}/${key.repository}@${key.branch} ${key.commitSha.slice(0, 7)}`;

  // ---------- Stage 1: redaction before anything is stored ----------
  // Every status source (CI reporter, workflow_run, reconciliation) passes here,
  // so this is the one place failure output enters the database.
  update = redactStatusUpdate(update);
  if (update.failureRedaction?.count) {
    console.warn(
      `[DeployGuard][redaction] ${label}: masked ${update.failureRedaction.count} item(s) in the failure output ` +
        `(${update.failureRedaction.categories.join(", ")}).`
    );
  }

  // ---------- database (source of truth) ----------
  const result = await updateDeploymentStatus(key, update);

  if (result.outcome === "not_found") {
    console.warn(`[DeployGuard][${source}] No deployment for ${label} (status ${update.status} not applied).`);
    return result;
  }
  if (result.outcome === "stale_event") {
    console.log(`[DeployGuard][${source}] Ignored out-of-date ${update.status} event for ${label} (current: ${result.currentStatus}).`);
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

  // ---------- Stage 4.4: a re-run of the same commit passed -> probable flake ----------
  let flakeIncidentId: string | undefined;
  if (deployment.status === "SUCCESS") {
    try {
      const flake = await markProbableFlake(deployment);
      if (flake) {
        flakeIncidentId = flake.incident.id;
        console.log(
          `[DeployGuard][learning] Incident #${flake.incident.id} marked probable flake: a re-run of commit ` +
            `${deployment.commit_sha.slice(0, 7)} passed (run ${flake.evidence.passing_run.id ?? "not reported"}).`
        );
      }
    } catch (error) {
      // Learning is best effort: the lifecycle result is already stored.
      console.error(`[DeployGuard][learning] Flake check failed for deployment #${deployment.id}: ${(error as Error).message}`);
    }
  }

  // ---------- Stage 4.2: compare the stored prediction with the outcome ----------
  // Before the risk refresh below, which produces a post-result assessment that
  // is never scored anyway (see lib/learning/accuracy.ts).
  if (deployment.status === "SUCCESS" || deployment.status === "FAILED") {
    try {
      const score = await recordRiskOutcome(deployment);
      if (score) console.log(`[DeployGuard][learning] Deployment #${deployment.id} ${deployment.status}: prediction ${score.predicted_level ?? "none"} -> ${score.result}.`);
    } catch (error) {
      console.error(`[DeployGuard][learning] Could not record the outcome for deployment #${deployment.id}: ${(error as Error).message}`);
    }
  }

  // ---------- agent memory (Stage 2: queued, final results only) ----------
  // BUILDING is a passing moment and is not worth remembering. The final result
  // REPLACES the memory the webhook wrote (same document_id). The Hindsight
  // writes run as queued jobs (retried with backoff), never inside this request.
  let memory: MemoryWrite | { skipped: string } = {
    skipped: "Only final results (SUCCESS / FAILED) are written to Hindsight.",
  };
  let incidentMemory: MemoryWrite | undefined;

  if (deployment.status === "SUCCESS" || deployment.status === "FAILED") {
    const version = `${deployment.status}:${deployment.ci_last_event_at?.getTime() ?? deployment.updated_at.getTime()}`;
    memory = await queueMemory(JOB_TYPES.deploymentMemory, deployment.id, `memory.deployment:${deployment.id}:${version}`);
    if (incident) {
      incidentMemory = await queueMemory(JOB_TYPES.incidentMemory, deployment.id, `memory.incident:${deployment.id}:${version}`);
    }
    kickQueue();
  }

  // ---------- refresh the risk analysis with the CI result (Phase 8) ----------
  // Only for deployments analysed on push, only for a final result. A repeated
  // report has the same evidence fingerprint and reuses the stored assessment.
  const riskRefreshScheduled =
    (deployment.status === "SUCCESS" || deployment.status === "FAILED") && deployment.risk_analysis_status !== null;
  if (riskRefreshScheduled) await scheduleRiskAnalysis(deployment.id, `ci ${deployment.status}`);

  return { outcome: "updated", deployment, previousStatus, incident, flakeIncidentId, incidentMemory, memory, riskRefreshScheduled };
}

/**
 * The failure fields as they may be stored: output redacted and cut to the
 * last 40 lines / 500 chars per line / 4000 chars; stage and job names
 * redacted and length-capped. Exported for the verification scripts.
 */
export function redactStatusUpdate(update: StatusUpdate): StatusUpdate {
  if (!update.failure) return update;
  const output = prepareFailureOutput(update.failure.message);
  const stage = redact(update.failure.stage);
  const job = redact(update.failure.job);
  const summary = mergeSummaries(output, stage, job);
  return {
    ...update,
    failure: {
      stage: update.failure.stage === undefined ? undefined : stage.text.slice(0, 50),
      job: update.failure.job === undefined ? undefined : job.text.slice(0, 200),
      message: update.failure.message === undefined ? undefined : output.text || undefined,
    },
    failureRedaction: summary.count ? summary : undefined,
  };
}

async function queueMemory(type: string, deploymentId: string, dedupeKey: string): Promise<MemoryWrite> {
  try {
    const job = await enqueue(type, { deploymentId }, { dedupeKey, maxAttempts: 6 });
    return { queued: true, jobId: job.id };
  } catch (error) {
    console.error(`[DeployGuard][memory] Could not queue ${type} for deployment #${deploymentId}: ${(error as Error).message}`);
    return { queued: false };
  }
}
