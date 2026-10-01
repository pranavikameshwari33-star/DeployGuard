import { env, findServerSecretIn } from "@/lib/env";
import { redactDeep } from "@/lib/security/redact";
import { assertRetainScope, filterRecallResults, recallTagRequests, type ScopedRecall } from "@/lib/hindsight/scope";

/**
 * A tiny HTTP client for the Hindsight memory API.
 *
 * Hindsight ships an official Python SDK, but DeployGuard's backend is
 * TypeScript, so we call the same REST endpoints directly with fetch. Only two
 * operations are needed: store a memory (`retain`) and search memories
 * (`recall`).
 *
 * The API key is read from the environment at call time and used only as an
 * Authorization header. It is never logged, never returned to a caller, and
 * never included in an error message -- see `HindsightError` below.
 */

export class HindsightError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "HindsightError";
  }
}

const TIMEOUT_MS = 20_000;

async function post<T>(path: string, body: unknown): Promise<T> {
  const url = `${env.hindsightBaseUrl()}${path}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.hindsightApiKey()}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    // Network failure or timeout. The message here comes from fetch and cannot
    // contain our key, because the key only ever lived in the headers object.
    throw new HindsightError(
      `Could not reach Hindsight (${(error as Error).name}: ${(error as Error).message})`
    );
  }

  const text = await response.text();

  if (!response.ok) {
    // Hindsight echoes back a validation message, not our credentials, so this
    // is safe to surface. Truncated to keep logs readable.
    throw new HindsightError(
      `Hindsight responded ${response.status}: ${text.slice(0, 300)}`,
      response.status
    );
  }

  return text ? (JSON.parse(text) as T) : ({} as T);
}

/** One memory to store. Hindsight requires metadata values to be strings. */
export type MemoryItem = {
  content: string;
  timestamp?: string;
  context?: string;
  metadata?: Record<string, string>;
  document_id?: string;
  tags?: string[];
  /** 'replace' makes re-storing the same document_id overwrite instead of duplicate. */
  update_mode?: "replace" | "append";
};

export type RetainResponse = { success?: boolean; items_processed?: number };

/**
 * Stores one memory in a bank.
 *
 * Stage 1 guards, in order: the item must be scoped to exactly one tenant
 * (ghrepo: tag, stable document_id, update_mode "replace"); every string in it
 * is redacted; and as a last tripwire the request is refused if it still
 * contains the value of any server secret. Each guard throws, so the caller
 * sees a normal "memory write failed" -- the database record is unaffected.
 */
export async function retain(item: MemoryItem, bankId = env.hindsightBankId()) {
  assertRetainScope(item);
  const { value: safe } = redactDeep(item);
  const leaked = findServerSecretIn(JSON.stringify(safe));
  if (leaked) throw new HindsightError(`Refusing to retain: the memory contains the value of ${leaked}.`);
  return post<RetainResponse>(
    `/v1/default/banks/${encodeURIComponent(bankId)}/memories`,
    { items: [safe], async: false }
  );
}

export type RecallResult = {
  id: string;
  text: string;
  type?: string;
  context?: string;
  document_id?: string;
  metadata?: Record<string, string>;
  tags?: string[];
  scores?: Record<string, number>;
};

export type RecallResponse = { results: RecallResult[] };

/**
 * Semantic search over a bank's memories, ALWAYS within a tenant scope.
 *
 * The scope (authorised GitHub repository ids) becomes the ghrepo: tag filter
 * with tags_match "any_strict" (or, when narrowed, one all_strict call per
 * tenant); there is no way to call this without one.
 * `narrowTags` (e.g. deployment:12) are applied to the returned results and
 * can only remove results, never add any.
 */
export async function recall(
  query: string,
  scope: ScopedRecall & { bankId?: string; maxTokens?: number }
): Promise<RecallResponse> {
  const requests = recallTagRequests(scope);
  const bankId = scope.bankId ?? env.hindsightBankId();
  const responses = await Promise.all(
    requests.map((filter) =>
      post<RecallResponse>(`/v1/default/banks/${encodeURIComponent(bankId)}/memories/recall`, {
        query,
        max_tokens: scope.maxTokens ?? 2048,
        budget: "mid",
        ...filter,
      })
    )
  );
  // Several per-tenant calls may return the same memory only if it carries two
  // tenant tags, which filterRecallResults drops anyway; dedupe by id regardless.
  const byId = new Map<string, RecallResult>();
  for (const memory of responses.flatMap((r) => r.results ?? [])) {
    if (!byId.has(memory.id)) byId.set(memory.id, memory);
  }
  return { results: filterRecallResults([...byId.values()], scope) };
}
