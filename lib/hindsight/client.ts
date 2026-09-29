import { env } from "@/lib/env";

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

/** Stores one memory in a bank. */
export async function retain(item: MemoryItem, bankId = env.hindsightBankId()) {
  return post<RetainResponse>(
    `/v1/default/banks/${encodeURIComponent(bankId)}/memories`,
    { items: [item], async: false }
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

/** Semantic search over a bank's memories. */
export async function recall(
  query: string,
  options: {
    bankId?: string;
    maxTokens?: number;
    tags?: string[];
    /** 'any' also returns untagged memories; 'any_strict' returns only memories carrying one of the tags. */
    tagsMatch?: "any" | "any_strict";
  } = {}
) {
  const bankId = options.bankId ?? env.hindsightBankId();
  return post<RecallResponse>(
    `/v1/default/banks/${encodeURIComponent(bankId)}/memories/recall`,
    {
      query,
      max_tokens: options.maxTokens ?? 2048,
      budget: "mid",
      ...(options.tags?.length ? { tags: options.tags, tags_match: options.tagsMatch ?? "any" } : {}),
    }
  );
}
