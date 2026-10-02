/**
 * Stage 4.2: how a stored prediction is compared with what actually happened.
 *
 * Pure: no imports, no I/O -- unit-tested directly.
 *
 * Rule "accuracy-v1" (documented in docs/LEARNING.md):
 *
 *   The PREDICTION is the newest validated assessment of the deployment that was
 *   made BEFORE the CI result: its evidence says the pipeline was RECEIVED or
 *   BUILDING, and it was generated no later than the result arrived. An
 *   assessment produced after the result (e.g. the automatic refresh with the
 *   CI outcome in its evidence) already knew the answer and is never scored.
 *
 *                    outcome FAILED     outcome SUCCESS
 *     HIGH           hit                false_alarm
 *     LOW            miss               hit
 *     MEDIUM         unscored           unscored     (not a directional prediction)
 *     no prediction  unscored           unscored
 *
 * Predictions are never edited; a deployment whose outcome later changes (a
 * re-run) gets a second outcome row, and the newest one is the one counted.
 */

export const ACCURACY_RULE_VERSION = "accuracy-v1";

export type PredictionCandidate = {
  id: string;
  risk_level: "LOW" | "MEDIUM" | "HIGH";
  risk_generated_at: Date;
  /** evidence.current_pipeline.status at the time of the assessment. */
  based_on_pipeline: string;
};

export type OutcomeScore = {
  assessment_id: string | null;
  predicted_level: "LOW" | "MEDIUM" | "HIGH" | null;
  result: "hit" | "miss" | "false_alarm" | "unscored";
  unscored_reason: string | null;
};

const PRE_RESULT_STATES = new Set(["RECEIVED", "BUILDING"]);

/** The assessment that counts as the prediction, or null when none existed before the result. */
export function choosePrediction(candidates: PredictionCandidate[], outcomeAt: Date): PredictionCandidate | null {
  const eligible = candidates
    .filter((c) => PRE_RESULT_STATES.has(c.based_on_pipeline) && c.risk_generated_at.getTime() <= outcomeAt.getTime())
    .sort((a, b) => b.risk_generated_at.getTime() - a.risk_generated_at.getTime() || Number(b.id) - Number(a.id));
  return eligible[0] ?? null;
}

export function scoreOutcome(prediction: PredictionCandidate | null, outcome: "SUCCESS" | "FAILED"): OutcomeScore {
  if (!prediction) {
    return { assessment_id: null, predicted_level: null, result: "unscored", unscored_reason: "No assessment existed before the CI result." };
  }
  const base = { assessment_id: prediction.id, predicted_level: prediction.risk_level };
  switch (prediction.risk_level) {
    case "HIGH":
      return { ...base, result: outcome === "FAILED" ? "hit" : "false_alarm", unscored_reason: null };
    case "LOW":
      return { ...base, result: outcome === "FAILED" ? "miss" : "hit", unscored_reason: null };
    default:
      return { ...base, result: "unscored", unscored_reason: "MEDIUM is not a directional prediction." };
  }
}

/** Below this many scored outcomes the record is shown with a "small sample" notice. */
export const SMALL_SAMPLE = 20;
