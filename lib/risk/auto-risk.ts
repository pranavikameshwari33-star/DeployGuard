import { after } from "next/server";
import { finishRiskAnalysis, startRiskAnalysis } from "@/lib/db/deployments";
import { analyzeDeploymentRisk } from "@/lib/risk/analyze-risk";

/**
 * Phase 8: run the Phase 7 risk analysis automatically, AFTER the response.
 *
 * Called from the push webhook (new deployment) and from the CI lifecycle
 * (final SUCCESS / FAILED). Next.js's `after()` runs the callback once the
 * response has been sent, so GitHub and the pipeline never wait for Gemini.
 *
 * Nothing new is decided here -- it reuses analyzeDeploymentRisk unchanged:
 *   - the same facts (evidence fingerprint) reuse the stored assessment, so a
 *     retried webhook or a repeated CI report makes no new Gemini call;
 *   - a new pipeline result changes the fingerprint, so exactly one refreshed
 *     assessment is produced for it;
 *   - a Gemini failure or rejected answer stores NO assessment. The deployment
 *     is untouched and only risk_analysis_status becomes "unavailable".
 *
 * Phase 10: the deployment is marked "pending" BEFORE the response is sent.
 * If the after() callback is lost (serverless timeout, crash, restart), the
 * row stays "pending" and the maintenance run picks it up again
 * (resumeStuckRiskAnalyses) instead of the analysis silently never happening.
 */
export async function scheduleRiskAnalysis(deploymentId: string, trigger: string): Promise<boolean> {
  let attempt: string;
  try {
    attempt = await startRiskAnalysis(deploymentId);
  } catch (error) {
    console.error(`[DeployGuard][risk] Could not start automatic analysis for #${deploymentId}: ${(error as Error).message}`);
    return false;
  }
  after(() => runRiskAnalysis(deploymentId, attempt, trigger));
  return true;
}

/** Runs one analysis attempt and records its outcome (only if it is still the newest attempt). */
export async function runRiskAnalysis(deploymentId: string, attempt: string, trigger: string): Promise<void> {
  let outcome: { status: "completed" } | { status: "unavailable"; error: string };
  try {
    const result = await analyzeDeploymentRisk(deploymentId);
    if (result.status === "assessed") {
      outcome = { status: "completed" };
      console.log(
        `[DeployGuard][risk] Automatic analysis (${trigger}) for #${deploymentId}: ` +
          `${result.assessment.risk_level} (${result.source === "stored" ? "reused stored assessment" : "new Gemini assessment"}).`
      );
    } else if (result.status === "unavailable") {
      const detail = result.errors?.length ? ` ${result.errors.slice(0, 3).join("; ")}` : "";
      outcome = { status: "unavailable", error: `${result.message}${detail}` };
    } else {
      outcome = { status: "unavailable", error: "Deployment not found when the analysis ran." };
    }
  } catch (error) {
    outcome = { status: "unavailable", error: `Risk analysis failed: ${(error as Error).message}` };
  }

  if (outcome.status === "unavailable") {
    console.warn(`[DeployGuard][risk] Automatic analysis (${trigger}) for #${deploymentId} unavailable: ${outcome.error}`);
  }
  try {
    await finishRiskAnalysis(deploymentId, attempt, outcome);
  } catch (error) {
    console.error(`[DeployGuard][risk] Could not record analysis outcome for #${deploymentId}: ${(error as Error).message}`);
  }
}
