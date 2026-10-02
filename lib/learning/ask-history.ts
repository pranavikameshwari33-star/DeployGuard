import { checkRateLimit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { searchHistory, type LearningScope } from "@/lib/db/learning";
import { recall } from "@/lib/hindsight/client";
import { composeAnswer, gateQuestion, likePattern, requiredMatches, type Answer, type AskRecord } from "@/lib/learning/ask";
import { redactText } from "@/lib/security/redact";

/**
 * Stage 4.6: grounded "ask your history".
 *
 *   question --gate--> keywords
 *            --Hindsight (scoped to the asker's ghrepo: tags, any_strict)--> nominated ids only
 *            --PostgreSQL (asker's scope, ownership enforced in SQL)--> records
 *            --composeAnswer--> one statement per record, each linked to it
 *
 * No language model writes the answer, so every statement is a database row
 * rendered as a sentence. Recalled TEXT is never used, only ids, and an id is
 * kept only if PostgreSQL finds it inside the asker's scope AND it matches the
 * question. If nothing matches, the answer says so.
 */

export type AskResult =
  | { state: "answered"; question: string; answer: Answer; memory: "used" | "unavailable" | "not_in_scope" }
  | { state: "refused"; question: string; message: string }
  | { state: "rate_limited"; question: string; message: string };

const MAX_RECORDS = 10;

export async function askHistory(input: {
  question: string;
  scope: LearningScope;
  /** GitHub repository ids the asker may see (the Hindsight scope). Already narrowed by the switcher. */
  githubRepositoryIds: string[];
  actorKey: string;
}): Promise<AskResult> {
  const gate = gateQuestion(input.question);
  const question = (input.question ?? "").slice(0, 300);
  if (!gate.ok) return { state: "refused", question, message: gate.message };

  const limited = await checkRateLimit("askHistory", input.actorKey, RATE_LIMITS.askHistory);
  if (!limited.allowed) return { state: "rate_limited", question, message: "Too many questions; try again in a few minutes." };

  // --- Hindsight: ids only ---------------------------------------------------
  const nominatedDeployments = new Set<string>();
  const nominatedIncidents = new Set<string>();
  let memory: "used" | "unavailable" | "not_in_scope" = "not_in_scope";
  if (input.githubRepositoryIds.length > 0) {
    try {
      const { results } = await recall(gate.question, { githubRepositoryIds: input.githubRepositoryIds, maxTokens: 1500 });
      for (const r of results) {
        const d = r.metadata?.deployment_id;
        const i = r.metadata?.incident_id;
        if (d && /^\d{1,19}$/.test(d)) nominatedDeployments.add(d);
        if (i && /^\d{1,19}$/.test(i)) nominatedIncidents.add(i);
      }
      memory = "used";
    } catch (error) {
      console.error(`[DeployGuard][ask] Memory recall failed; answering from the database only: ${(error as Error).message}`);
      memory = "unavailable";
    }
  }

  // --- PostgreSQL: the records ---------------------------------------------------
  const patterns: string[] = [];
  const groups: number[] = [];
  gate.keywords.forEach((k, index) => {
    for (const p of k.patterns) {
      patterns.push(likePattern(p));
      groups.push(index);
    }
  });
  const rows = await searchHistory(input.scope, {
    patterns,
    groups,
    minHits: requiredMatches(gate.keywords.length),
    nominatedDeployments: [...nominatedDeployments],
    nominatedIncidents: [...nominatedIncidents],
    limit: MAX_RECORDS,
  });

  const records: AskRecord[] = rows.map((r) => ({
    deployment_id: r.deployment_id,
    repository: r.repository,
    branch: r.branch,
    commit_sha: r.commit_sha,
    commit_message: redactText(r.commit_message).slice(0, 200),
    status: r.status,
    created_at: r.created_at,
    failure_stage: r.failure_stage,
    incident_id: r.incident_id,
    failure_type: r.failure_type,
    error_line: errorLine(r.error_message),
    root_cause: r.root_cause ? redactText(r.root_cause) : null,
    resolution: r.resolution ? redactText(r.resolution) : null,
    confirmed_by_login: r.confirmed_by_login,
    confirmed_at: r.confirmed_at,
    probable_flake: r.flake_status === "probable_flake",
    reverted_by: r.reverted_by,
    matched_terms: r.matched.map((g) => gate.keywords[g]?.term).filter(Boolean) as string[],
    recalled: r.nominated,
  }));

  return { state: "answered", question: gate.question, answer: composeAnswer(gate.keywords, records), memory };
}

/** The most telling line of a stored (already redacted) failure output. */
function errorLine(output: string | null): string | null {
  if (!output) return null;
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const line = [...lines].reverse().find((l) => /error|fail|exception|timeout|refused/i.test(l)) ?? lines[lines.length - 1];
  return line ? redactText(line).slice(0, 200) : null;
}
