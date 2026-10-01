import { analyzeChanges, type ChangeAnalysis } from "@/lib/analysis/change-analysis";
import {
  findHistoryCandidates,
  getDeploymentById,
  type Deployment,
  type DeploymentStatus,
} from "@/lib/db/deployments";
import { getIncidentForDeployment } from "@/lib/db/incidents";
import { recall } from "@/lib/hindsight/client";
import {
  DEFAULT_MIN_SCORE,
  SIMILARITY_WEIGHTS,
  STRONG_SCORE,
  scoreSimilarity,
  type Comparable,
  type MatchedSignal,
} from "@/lib/similarity/scoring";

/**
 * Phase 6: "Have we seen a similar deployment before, and what happened?"
 *
 *   current deployment
 *        |-- Hindsight recall (semantic, supporting) --.
 *        |-- PostgreSQL candidates (structured) -------+--> score --> filter --> evidence
 *
 * PostgreSQL is the source of truth: every returned fact comes from the
 * deployments and incidents tables, and a deployment is identified by its
 * database id. Hindsight only (a) nominates deployments that the structured
 * search might have missed and (b) adds a small supporting signal plus the
 * recalled text. A Hindsight memory whose deployment id is not in the database
 * is ignored, and Hindsight alone can never make something a match.
 *
 * This is an evidence layer. It does NOT judge risk -- that is Phase 7.
 */

export type HistoricalEvidence = {
  deployment_id: string;
  repository: string;
  branch: string;
  commit_sha: string;
  commit_message: string;
  created_at: string;
  status: DeploymentStatus;
  changed_files: string[];
  change_categories: string[];
  affected_services: string[];
  /** What the pipeline reported when this deployment failed; null otherwise. */
  failure: { stage: string | null; job: string | null; message: string | null } | null;
  /** The Phase 4 incident, if one exists. Unknown fields stay null. */
  incident: {
    id: string;
    failure_type: string;
    error_message: string | null;
    root_cause: string | null;
    resolution: string | null;
  } | null;
  similarity_score: number;
  relevance: "strong" | "weak";
  matched_signals: MatchedSignal[];
  /** Where this match was found. "database" is always present; "hindsight" if also recalled. */
  sources: ("database" | "hindsight")[];
  /** Hindsight's own summaries of DeployGuard records. Structured fields above take precedence. */
  recalled_memory_text: string[];
};

export type SimilarityResult = {
  deployment: {
    id: string;
    repository: string;
    branch: string;
    commit_sha: string;
    changed_files: string[];
    change_categories: string[];
    affected_services: string[];
  };
  settings: { min_score: number; strong_score: number; weights: typeof SIMILARITY_WEIGHTS };
  hindsight: { used: true; memories_recalled: number; deployments_recalled: number } | { used: false; error: string };
  candidates_considered: number;
  matches: HistoricalEvidence[];
};

export type SimilarityOptions = {
  minScore?: number;
  limit?: number;
  /** Set false to use the database only (e.g. if Hindsight is down). */
  useHindsight?: boolean;
};

const MAX_ERROR_TEXT = 1000;
const MAX_RECALLED_TEXTS = 3;

/** Returns null when the deployment does not exist. */
export async function findSimilarDeployments(
  deploymentId: string,
  options: SimilarityOptions = {}
): Promise<SimilarityResult | null> {
  const current = await getDeploymentById(deploymentId);
  if (!current) return null;

  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const limit = options.limit ?? 10;
  const repo = `${current.owner}/${current.repository}`;
  const currentAnalysis = analysisOf(current);
  const currentIncident = current.status === "FAILED" ? await getIncidentForDeployment(current.id) : null;

  // --- 1. Hindsight: which past deployments does memory associate with this change?
  const recalled = new Map<string, string[]>();
  let hindsight: SimilarityResult["hindsight"];
  // Phase 9 / Stage 1: recall is scoped to the deployment's own immutable GitHub
  // repository id -- owned or not. The mutable repo:<name> tag is no longer a
  // scope; without a repository id there is no recall (the client refuses it).
  const scopeRepoIds = current.github_repository_id ? [current.github_repository_id] : null;
  if (options.useHindsight === false) {
    hindsight = { used: false, error: "disabled by request" };
  } else if (!scopeRepoIds) {
    hindsight = { used: false, error: "no repository scope available for memory recall" };
  } else {
    try {
      const { results } = await recall(buildRecallQuery(repo, current, currentAnalysis), {
        githubRepositoryIds: scopeRepoIds,
      });
      for (const memory of results ?? []) {
        const id = memory.metadata?.deployment_id;
        if (!id || id === current.id) continue;
        const texts = recalled.get(id) ?? [];
        if (!texts.includes(memory.text)) texts.push(memory.text);
        recalled.set(id, texts);
      }
      hindsight = { used: true, memories_recalled: results?.length ?? 0, deployments_recalled: recalled.size };
    } catch (error) {
      // Best effort: structured similarity still works without memory recall.
      hindsight = { used: false, error: (error as Error).message };
    }
  }

  // --- 2. PostgreSQL: structured candidates (plus any Hindsight nominated) ------
  const candidates = await findHistoryCandidates(current, {
    categories: currentAnalysis.categories.filter((c) => c !== "application_code" && c !== "unknown"),
    services: currentAnalysis.services,
    extraIds: [...recalled.keys()].filter((id) => /^\d+$/.test(id)),
  });

  // --- 3. Score, filter, merge. One entry per deployment id, so a deployment found
  // by both sources appears once with both listed in `sources`.
  const currentComparable = comparable(current, currentAnalysis, currentIncident?.failure_type ?? null);
  const byId = new Map<string, HistoricalEvidence>();

  for (const row of candidates) {
    if (row.id === current.id || byId.has(row.id)) continue;
    const analysis = analysisOf(row);
    const wasRecalled = recalled.has(row.id);
    const { score, relevance, signals } = scoreSimilarity(
      currentComparable,
      comparable(row, analysis, row.incident_failure_type),
      { recalledByHindsight: wasRecalled, minScore }
    );
    if (relevance === "not_relevant") continue;

    byId.set(row.id, {
      deployment_id: row.id,
      repository: `${row.owner}/${row.repository}`,
      branch: row.branch,
      commit_sha: row.commit_sha,
      commit_message: row.commit_message.split("\n")[0].trim(),
      created_at: row.created_at.toISOString(),
      status: row.status,
      changed_files: row.changed_files,
      change_categories: analysis.categories,
      affected_services: analysis.services,
      failure:
        row.status === "FAILED"
          ? { stage: row.failure_stage, job: row.failure_job, message: tail(row.failure_message) }
          : null,
      incident: row.incident_id
        ? {
            id: row.incident_id,
            failure_type: row.incident_failure_type ?? "unknown_failure",
            error_message: tail(row.incident_error_message),
            root_cause: row.incident_root_cause,
            resolution: row.incident_resolution,
          }
        : null,
      similarity_score: score,
      relevance,
      matched_signals: signals,
      sources: wasRecalled ? ["database", "hindsight"] : ["database"],
      recalled_memory_text: (recalled.get(row.id) ?? []).slice(0, MAX_RECALLED_TEXTS),
    });
  }

  const matches = [...byId.values()]
    .sort(
      (a, b) =>
        b.similarity_score - a.similarity_score ||
        b.created_at.localeCompare(a.created_at) ||
        Number(b.deployment_id) - Number(a.deployment_id)
    )
    .slice(0, limit);

  return {
    deployment: {
      id: current.id,
      repository: repo,
      branch: current.branch,
      commit_sha: current.commit_sha,
      changed_files: current.changed_files,
      change_categories: currentAnalysis.categories,
      affected_services: currentAnalysis.services,
    },
    settings: { min_score: minScore, strong_score: STRONG_SCORE, weights: SIMILARITY_WEIGHTS },
    hindsight,
    candidates_considered: candidates.length,
    matches,
  };
}

/**
 * The stored Phase 5 analysis, or -- for rows recorded before Phase 5 -- the
 * same deterministic analyzer run on the stored file lists. Nothing new is
 * inferred either way.
 */
function analysisOf(d: Deployment): ChangeAnalysis {
  if (d.file_analysis && d.change_categories && d.affected_services) {
    return { files: d.file_analysis, categories: d.change_categories, services: d.affected_services };
  }
  return analyzeChanges({ added: d.added_files, modified: d.modified_files, deleted: d.deleted_files });
}

function comparable(d: Deployment, analysis: ChangeAnalysis, failureType: string | null): Comparable {
  return {
    changedFiles: d.changed_files,
    files: analysis.files,
    categories: analysis.categories,
    services: analysis.services,
    commitMessage: d.commit_message,
    failureType,
  };
}

/** A plain-language question built only from the current deployment's own facts. */
function buildRecallQuery(repo: string, d: Deployment, analysis: ChangeAnalysis): string {
  const files = d.changed_files.slice(0, 15).join(", ") || "no files";
  const services = analysis.services.join(", ") || "no identified service";
  return (
    `Previous deployments of ${repo} that changed ${files}, ` +
    `in categories ${analysis.categories.join(", ") || "none"}, affecting ${services}. ` +
    `What happened to them, did they fail, and what failure was observed?`
  );
}

/** Keep the end of long output: that is where a failing command reports its error. */
function tail(text: string | null): string | null {
  if (!text) return null;
  return text.length <= MAX_ERROR_TEXT ? text : `... ${text.slice(-MAX_ERROR_TEXT)}`;
}
