import type { ChangeCategory, FileAnalysis } from "@/lib/analysis/change-analysis";

/**
 * Phase 6: how similar is one deployment to another?
 *
 * A deterministic, explainable MVP heuristic. It is NOT a probability and has
 * NOT been validated statistically; it only ranks history so the most relevant
 * evidence comes first. Every point awarded is returned as a named signal, so a
 * reader (or Phase 7) can see exactly why a match was made.
 *
 * Pure: no I/O, no AI. Same inputs, same score.
 */

/** Points per signal. Change them here; nothing else hard-codes them. */
export const SIMILARITY_WEIGHTS = {
  /** The same file changed in both. Strong. */
  shared_file: { points: 4, max: 12 },
  /** The same service/component affected in both. Strong. */
  same_service: { points: 4, max: 8 },
  /** The same (category, service) pair, e.g. payments in payment-service. Moderate. */
  same_service_category: { points: 2, max: 4 },
  /** The same informative category, e.g. database. Moderate. */
  same_category: { points: 2, max: 6 },
  /** Overlapping commit-message words (Jaccard). Weak, supporting only. */
  similar_commit_message: { points: 1.5, max: 1.5 },
  /** Both deployments failed with the same failure type. Supporting only. */
  same_failure_type: { points: 1, max: 1 },
  /** Hindsight recalled this deployment for the same question. Supporting only. */
  recalled_by_hindsight: { points: 1, max: 1 },
} as const;

/** Below this a candidate is "not relevant" and is not returned. */
export const DEFAULT_MIN_SCORE = 2;
/** At or above this a match is labelled "strong"; between the two, "weak". */
export const STRONG_SCORE = 6;
/** Commit messages must share at least this fraction of words to count. */
const MIN_TEXT_OVERLAP = 0.25;

/**
 * Categories that say what KIND of file changed but not WHICH part of the
 * system. Nearly every deployment touches application_code, so sharing it says
 * nothing; these never earn points.
 */
const UNINFORMATIVE_CATEGORIES = new Set<ChangeCategory>([
  "application_code",
  "tests",
  "documentation",
  "unknown",
]);

/** Structural signals. A match needs at least one; supporting signals alone never qualify. */
const STRUCTURAL = new Set<SignalName>([
  "shared_file",
  "same_service",
  "same_service_category",
  "same_category",
]);

export type SignalName = keyof typeof SIMILARITY_WEIGHTS;

export type MatchedSignal = {
  signal: SignalName;
  /** What matched, e.g. the file path or the service name. */
  value: string;
  points: number;
};

/** What the scorer compares. Built from the Phase 5 analysis of each deployment. */
export type Comparable = {
  changedFiles: string[];
  files: FileAnalysis[];
  categories: ChangeCategory[];
  services: string[];
  commitMessage: string;
  /** The incident's failure_type when the deployment failed, else null. */
  failureType: string | null;
};

export type Score = {
  score: number;
  relevance: "strong" | "weak" | "not_relevant";
  signals: MatchedSignal[];
};

export function scoreSimilarity(
  current: Comparable,
  candidate: Comparable,
  options: { recalledByHindsight?: boolean; minScore?: number } = {}
): Score {
  const signals: MatchedSignal[] = [];

  award(signals, "shared_file", intersect(current.changedFiles, candidate.changedFiles));
  award(signals, "same_service", intersect(current.services, candidate.services));
  award(signals, "same_service_category", intersect(servicePairs(current), servicePairs(candidate)));
  award(
    signals,
    "same_category",
    intersect(informative(current.categories), informative(candidate.categories))
  );

  const overlap = jaccard(words(current.commitMessage), words(candidate.commitMessage));
  if (overlap >= MIN_TEXT_OVERLAP) {
    const { points, max } = SIMILARITY_WEIGHTS.similar_commit_message;
    signals.push({
      signal: "similar_commit_message",
      value: `${Math.round(overlap * 100)}% word overlap`,
      points: round(Math.min(max, points * overlap * 2)),
    });
  }

  if (current.failureType && current.failureType === candidate.failureType) {
    award(signals, "same_failure_type", [current.failureType]);
  }
  if (options.recalledByHindsight) {
    award(signals, "recalled_by_hindsight", ["recalled for this change"]);
  }

  const score = round(signals.reduce((sum, s) => sum + s.points, 0));
  const hasStructural = signals.some((s) => STRUCTURAL.has(s.signal));
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;

  const relevance =
    !hasStructural || score < minScore ? "not_relevant" : score >= STRONG_SCORE ? "strong" : "weak";

  return { score, relevance, signals };
}

/** Adds one signal per matched value, stopping at the signal's cap. */
function award(signals: MatchedSignal[], signal: SignalName, values: string[]) {
  const { points, max } = SIMILARITY_WEIGHTS[signal];
  let total = 0;
  for (const value of values) {
    if (total + points > max) break;
    signals.push({ signal, value, points });
    total += points;
  }
}

/** "payments@payment-service" for every file that has both an informative category and a service. */
function servicePairs(c: Comparable): string[] {
  const pairs = new Set<string>();
  for (const file of c.files) {
    if (!file.service) continue;
    for (const category of informative(file.categories)) pairs.add(`${category}@${file.service}`);
  }
  return [...pairs];
}

function informative(categories: ChangeCategory[]): ChangeCategory[] {
  return categories.filter((c) => !UNINFORMATIVE_CATEGORIES.has(c));
}

function intersect<T>(a: T[], b: T[]): T[] {
  const other = new Set(b);
  return [...new Set(a)].filter((x) => other.has(x)).sort();
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "this", "that", "add", "update", "fix", "change",
  "changes", "remove", "use", "make", "more", "less", "new", "old",
]);

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
