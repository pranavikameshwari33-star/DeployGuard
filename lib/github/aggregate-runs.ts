/**
 * Stage 2: how several GitHub Actions workflow runs for ONE push combine into
 * one deployment outcome. Pure, so it is unit-tested.
 *
 *   any completed run failed               -> FAILED (that run is reported)
 *   any run still queued / in progress     -> BUILDING (no final outcome yet)
 *   all completed, none failed, >= 1 success -> SUCCESS
 *   anything else (e.g. all cancelled)     -> no outcome to record
 *
 * "skipped" and "neutral" count as not-failed; "cancelled" neither passes nor fails.
 */
export const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"]);
export const OK_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

export type RunState = { id: number; status: string | null; conclusion: string | null };

export type Aggregate<R extends RunState> =
  | { outcome: "FAILED"; run: R }
  | { outcome: "BUILDING" }
  | { outcome: "SUCCESS" }
  | { outcome: "NONE" };

export function aggregateRuns<R extends RunState>(runs: R[]): Aggregate<R> {
  const failed = runs.find((r) => r.status === "completed" && FAILED_CONCLUSIONS.has(r.conclusion ?? ""));
  if (failed) return { outcome: "FAILED", run: failed };
  if (runs.some((r) => r.status !== "completed")) return { outcome: "BUILDING" };
  if (runs.length > 0 && runs.every((r) => OK_CONCLUSIONS.has(r.conclusion ?? "")) && runs.some((r) => r.conclusion === "success")) {
    return { outcome: "SUCCESS" };
  }
  return { outcome: "NONE" };
}
