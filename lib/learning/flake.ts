/**
 * Stage 4.4: "probable flake" -- a failed run whose re-run of the SAME commit
 * passed with no code change.
 *
 * DeployGuard keys a deployment by (repository, branch, commit), so a re-run is
 * the same deployment row: FAILED -> BUILDING -> SUCCESS. The incident recorded
 * for the failure stays; this marks it, with both runs as evidence. Nothing is
 * deleted: a flake still appears in history, it only counts for less
 * (similarity, patterns).
 *
 * Pure: no imports, no I/O -- unit-tested directly.
 */

export type FlakeInput = {
  deployment: { status: string; commit_sha: string; ci_run_id: string | null; ci_run_url: string | null; ci_finished_at: Date | null };
  incident: {
    flake_status: string | null;
    failed_ci_run_id: string | null;
    failed_ci_run_url: string | null;
    failed_at: Date | null;
    /** The commit of the deployment the incident belongs to. */
    commit_sha: string;
  } | null;
};

export type FlakeEvidence = {
  failed_run: { id: string | null; url: string | null; at: Date | null };
  passing_run: { id: string | null; url: string | null; at: Date };
};

/** Evidence that the incident is a probable flake, or null when the rule does not hold. */
export function detectFlake(input: FlakeInput): FlakeEvidence | null {
  const { deployment: d, incident: i } = input;
  if (!i || i.flake_status) return null; // no failure to explain, or already marked
  if (d.status !== "SUCCESS" || !d.ci_finished_at) return null;
  if (i.commit_sha !== d.commit_sha) return null; // a code change is a fix, not a flake
  // The pass must come after the recorded failure.
  if (i.failed_at && d.ci_finished_at.getTime() < i.failed_at.getTime()) return null;
  return {
    failed_run: { id: i.failed_ci_run_id, url: i.failed_ci_run_url, at: i.failed_at },
    passing_run: { id: d.ci_run_id, url: d.ci_run_url, at: d.ci_finished_at },
  };
}
