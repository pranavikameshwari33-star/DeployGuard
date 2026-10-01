import { finishRiskAnalysis, startRiskAnalysis } from "@/lib/db/deployments";
import { enqueue } from "@/lib/jobs/queue";
import { kickQueue } from "@/lib/jobs/runner";
import { JOB_TYPES } from "@/lib/jobs/types";
import { analyzeDeploymentRisk } from "@/lib/risk/analyze-risk";

/**
 * Phase 8: run the Phase 7 risk analysis automatically, outside the request.
 *
 * Called from the push webhook (new deployment) and from the CI lifecycle
 * (final SUCCESS / FAILED). GitHub and the pipeline never wait for Gemini.
 *
 * Nothing new is decided here -- it reuses analyzeDeploymentRisk unchanged:
 *   - the same facts (evidence fingerprint) reuse the stored assessment, so a
 *     retried webhook or a repeated CI report makes no new Gemini call;
 *   - a new pipeline result changes the fingerprint, so exactly one refreshed
 *     assessment is produced for it;
 *   - a Gemini failure or rejected answer stores NO assessment. The deployment
 *     is untouched and only risk_analysis_status becomes "unavailable".
 *
 * Stage 2: the deployment is marked "pending" and a `risk.analyze` job is
 * queued BEFORE the response is sent (one job per attempt, deduplicated).
 * Transient Gemini failures (overload, timeout, rate limit) are retried by the
 * queue with exponential backoff, a bounded number of times; anything else
 * ends as "unavailable" at once.
 */
export async function scheduleRiskAnalysis(deploymentId: string, trigger: string): Promise<boolean> {
  try {
    const attempt = await startRiskAnalysis(deploymentId);
    await enqueue(JOB_TYPES.riskAnalyze, { deploymentId, attempt, trigger }, { dedupeKey: `risk:${deploymentId}:${attempt}`, maxAttempts: 3 });
  } catch (error) {
    console.error(`[DeployGuard][risk] Could not schedule automatic analysis for #${deploymentId}: ${(error as Error).message}`);
    return false;
  }
  kickQueue();
  return true;
}

const TRANSIENT = new Set(["unavailable", "timeout", "rate_limit"]);

export type RiskRunOutcome = { summary: string; retryable: boolean; kind?: string };

/** Runs one analysis attempt and records its outcome (only if it is still the newest attempt). */
export async function runRiskAnalysis(
  deploymentId: string,
  attempt: string,
  trigger: string,
  /** false while the queue will retry a transient failure: the row then stays "pending". */
  finalAttempt = true
): Promise<RiskRunOutcome> {
  let outcome: { status: "completed" } | { status: "unavailable"; error: string };
  let result: RiskRunOutcome;
  try {
    const analysis = await analyzeDeploymentRisk(deploymentId);
    if (analysis.status === "assessed") {
      outcome = { status: "completed" };
      result = {
        summary: `${analysis.assessment.risk_level} (${analysis.source === "stored" ? "reused stored assessment" : "new Gemini assessment"})`,
        retryable: false,
      };
      console.log(`[DeployGuard][risk] Automatic analysis (${trigger}) for #${deploymentId}: ${result.summary}.`);
    } else if (analysis.status === "unavailable") {
      const detail = analysis.errors?.length ? ` ${analysis.errors.slice(0, 3).join("; ")}` : "";
      outcome = { status: "unavailable", error: `${analysis.message}${detail}` };
      result = { summary: `unavailable (${analysis.reason})`, retryable: TRANSIENT.has(analysis.kind ?? ""), kind: analysis.kind ?? analysis.reason };
    } else {
      outcome = { status: "unavailable", error: "Deployment not found when the analysis ran." };
      result = { summary: "deployment not found", retryable: false };
    }
  } catch (error) {
    outcome = { status: "unavailable", error: `Risk analysis failed: ${(error as Error).message}` };
    result = { summary: "failed", retryable: true, kind: "error" };
  }

  if (outcome.status === "unavailable" && result.retryable && !finalAttempt) {
    console.warn(`[DeployGuard][risk] Automatic analysis (${trigger}) for #${deploymentId} temporarily unavailable; will retry: ${outcome.error}`);
    return result;
  }
  if (outcome.status === "unavailable") {
    console.warn(`[DeployGuard][risk] Automatic analysis (${trigger}) for #${deploymentId} unavailable: ${outcome.error}`);
  }
  try {
    await finishRiskAnalysis(deploymentId, attempt, outcome);
  } catch (error) {
    console.error(`[DeployGuard][risk] Could not record analysis outcome for #${deploymentId}: ${(error as Error).message}`);
  }
  return result;
}
