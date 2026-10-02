/**
 * Stage 4.6: "ask your history" -- the pure parts.
 *
 *   gateQuestion   decides whether a question is about deployment/incident
 *                  history at all (anything else is refused), and turns it
 *                  into keyword groups for the database search.
 *   composeAnswer  writes the answer FROM RECORDS ONLY: one statement per
 *                  record, each linked to its deployment (and incident). No
 *                  language model is involved, so there is no prose that a
 *                  record does not back.
 *
 * Pure: no imports, no I/O -- unit-tested directly.
 */

export const MAX_QUESTION_LENGTH = 300;

/** At least one of these (as a word prefix) must appear, or the question is not about history. */
const DOMAIN_PREFIXES = [
  "deploy", "release", "ship", "push", "commit", "fail", "error", "incident", "outage", "exception", "crash",
  "timeout", "timed", "build", "test", "ci", "pipeline", "workflow", "job", "revert", "rollback", "rolled",
  "flak", "broke", "break", "bug", "regress", "migration", "database", "db", "connection", "refused", "oom",
  "memory", "latency", "stage", "lint", "compile", "dependency", "install", "docker", "config",
];

/** Requests to produce something rather than look something up. */
const NOT_A_LOOKUP = /\b(write|compose|poem|joke|story|song|essay|translate|pretend|role-?play|ignore (?:all|any|previous|prior)|system prompt|your instructions|generate (?:code|a|an))\b/i;

const STOPWORDS = new Set([
  "a", "an", "the", "we", "us", "our", "you", "your", "i", "me", "my", "it", "its", "is", "are", "was", "were", "be",
  "been", "being", "have", "has", "had", "do", "does", "did", "any", "ever", "before", "seen", "see", "there",
  "what", "when", "which", "who", "why", "how", "many", "much", "times", "time", "this", "that", "these", "those",
  "of", "in", "on", "at", "to", "for", "with", "from", "by", "about", "into", "and", "or", "not", "no", "yes",
  "show", "tell", "find", "list", "give", "get", "can", "could", "would", "should", "will", "please", "last",
  "recent", "recently", "again", "like", "similar", "kind", "sort", "type", "happen", "happened", "happens",
  "history", "past", "previous", "previously", "repo", "repository", "repositories", "ago", "since", "ok",
  "day", "days", "week", "weeks", "month", "months", "year", "years", "today", "yesterday", "out", "up",
  // Words that name WHAT is searched (every record is a deployment), not what to look for.
  "deployment", "deploy", "incident", "commit", "push", "release", "record", "recorded",
]);

/** Spellings that should find each other in CI output. Keys are stems. */
const SYNONYMS: Record<string, string[]> = {
  timeout: ["timeout", "timed out", "etimedout", "time out", "deadline exceeded"],
  connect: ["connect", "econnrefused", "econnreset", "connection"],
  connection: ["connection", "connect", "econnrefused", "econnreset"],
  database: ["database", "postgres", "mysql", "sql", "db/", "db.", " db "],
  db: ["database", "postgres", "mysql", "sql", "db/", "db.", " db "],
  oom: ["oom", "out of memory", "heap", "killed"],
  memory: ["memory", "oom", "heap"],
  flake: ["flake", "probable_flake", "intermittent"],
  flaky: ["flake", "probable_flake", "intermittent"],
  revert: ["revert"],
  test: ["test"],
  fail: ["fail"],
  failure: ["fail"],
};

export type KeywordGroup = { term: string; patterns: string[] };

export type Gate =
  | { ok: true; question: string; keywords: KeywordGroup[] }
  | { ok: false; reason: "empty" | "too_long" | "off_topic" | "too_vague"; message: string };

export const OFF_TOPIC_MESSAGE =
  "DeployGuard only answers questions about your recorded deployments, failures and incidents " +
  "(for example: \"have we seen a database connection timeout before?\"). It is not a general assistant.";

function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("es") && !word.endsWith("sses")) return word.slice(0, -1).replace(/e$/, "");
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

export function gateQuestion(raw: string): Gate {
  const question = (raw ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!question) return { ok: false, reason: "empty", message: "Type a question about your deployment history." };
  if (question.length > MAX_QUESTION_LENGTH) {
    return { ok: false, reason: "too_long", message: `Questions are limited to ${MAX_QUESTION_LENGTH} characters.` };
  }
  const words = question
    .toLowerCase()
    .replace(/\btim(?:e|ed|ing)\s+out\b/g, "timeout")
    .match(/[a-z0-9_]+/g) ?? [];
  const onTopic = words.some((w) => DOMAIN_PREFIXES.some((p) => w.startsWith(p)));
  if (!onTopic || NOT_A_LOOKUP.test(question)) return { ok: false, reason: "off_topic", message: OFF_TOPIC_MESSAGE };

  const groups = new Map<string, KeywordGroup>();
  for (const w of words) {
    if (w.length < 2 || STOPWORDS.has(w) || /^\d+$/.test(w)) continue;
    const s = stem(w);
    if (STOPWORDS.has(s) || groups.has(s)) continue;
    groups.set(s, { term: s, patterns: SYNONYMS[s] ?? SYNONYMS[w] ?? [s] });
  }
  if (groups.size === 0) {
    return { ok: false, reason: "too_vague", message: "Say what to look for: an error, a failing stage, a file or a component." };
  }
  return { ok: true, question, keywords: [...groups.values()].slice(0, 8) };
}

/** How many keyword groups a record must match. Half, rounded up (at least one). */
export function requiredMatches(groups: number): number {
  return Math.max(1, Math.ceil(groups / 2));
}

/** Escapes a pattern for SQL ILIKE (with the default backslash escape) and wraps it in %...%. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// ---------------------------------------------------------------------------
// Composing the answer from records
// ---------------------------------------------------------------------------

export type AskRecord = {
  deployment_id: string;
  repository: string;
  branch: string;
  commit_sha: string;
  commit_message: string;
  status: string;
  created_at: Date;
  failure_stage: string | null;
  incident_id: string | null;
  failure_type: string | null;
  error_line: string | null;
  root_cause: string | null;
  resolution: string | null;
  confirmed_by_login: string | null;
  confirmed_at: Date | null;
  probable_flake: boolean;
  reverted_by: string | null;
  /** Which keyword groups the record matched (from the database text search). */
  matched_terms: string[];
  /** True when Hindsight also nominated this record. */
  recalled: boolean;
};

export type AnswerStatement = {
  text: string;
  deployment_id: string;
  incident_id: string | null;
  /** Where the statement's facts come from. Always the database. */
  source: "database";
};

export type Answer = {
  found: boolean;
  /** A count-only summary; every factual claim is in a statement below. */
  summary: string;
  statements: AnswerStatement[];
};

const day = (d: Date) => d.toISOString().slice(0, 10);

export function composeAnswer(keywords: KeywordGroup[], records: AskRecord[]): Answer {
  const terms = keywords.map((k) => k.term).join(", ");
  if (records.length === 0) {
    return {
      found: false,
      summary: `No recorded deployment or incident in the repositories you can see matches "${terms}". DeployGuard has no record of it.`,
      statements: [],
    };
  }
  const failures = records.filter((r) => r.incident_id).length;
  const statements = records.map((r): AnswerStatement => {
    const parts = [
      `Deployment #${r.deployment_id} (${r.repository}, ${r.branch}, ${r.commit_sha.slice(0, 7)}) on ${day(r.created_at)}` +
        (r.status === "FAILED" || r.incident_id
          ? ` failed${r.failure_stage ? ` at the ${r.failure_stage} stage` : ""}.`
          : ` ended ${r.status}.`),
    ];
    if (r.incident_id) {
      parts.push(`Incident #${r.incident_id}${r.error_line ? ` observed: "${r.error_line}"` : ` (${r.failure_type ?? "failure"})`}.`);
      parts.push(
        r.root_cause
          ? `Root cause (HUMAN-CONFIRMED by @${r.confirmed_by_login ?? "unknown"}${r.confirmed_at ? ` on ${day(r.confirmed_at)}` : ""}): ${r.root_cause}.`
          : "Root cause: not determined."
      );
      if (r.resolution) parts.push(`Resolution (HUMAN-CONFIRMED): ${r.resolution}.`);
      if (r.probable_flake) parts.push("A re-run of the same commit passed afterwards (probable flake).");
    }
    if (r.reverted_by) parts.push(`It was reverted by deployment #${r.reverted_by}.`);
    if (!r.incident_id && r.commit_message) parts.push(`Commit: "${r.commit_message}".`);
    return { text: parts.join(" "), deployment_id: r.deployment_id, incident_id: r.incident_id, source: "database" };
  });
  return {
    found: true,
    summary:
      `${records.length} recorded deployment${records.length === 1 ? "" : "s"} match "${terms}"` +
      (failures ? `, ${failures} of them with an incident` : "") +
      ". Each line below is one record.",
    statements,
  };
}

/** The ids every statement must be backed by (used by the verification to check the answer). */
export function statementIds(answer: Answer): { deployments: string[]; incidents: string[] } {
  return {
    deployments: answer.statements.map((s) => s.deployment_id),
    incidents: answer.statements.flatMap((s) => (s.incident_id ? [s.incident_id] : [])),
  };
}
