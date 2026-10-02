import { env, findServerSecretIn } from "@/lib/env";

/**
 * A tiny client for Gemini's generateContent REST endpoint (Phase 7).
 *
 * Same approach as lib/hindsight/client.ts: plain fetch, no SDK. The API key
 * is read at call time and sent only in the `x-goog-api-key` header -- never
 * in the URL (URLs end up in logs), never in an error message, never returned.
 *
 * Only structured JSON output is supported: callers pass a response schema
 * and get back parsed JSON, which they must still validate themselves.
 */

export type GeminiErrorKind =
  | "config"        // GEMINI_API_KEY missing
  | "auth"          // key rejected
  | "rate_limit"    // quota or rate limit
  | "timeout"
  | "unavailable"   // network error or 5xx
  | "bad_request"   // 4xx other than the above
  | "bad_response"  // no usable JSON came back
  | "blocked";      // Stage 1: the request contained a server secret and was not sent

export class GeminiError extends Error {
  // Plain fields (not constructor parameter properties) so Node's type
  // stripping can load this module in the verification scripts.
  readonly kind: GeminiErrorKind;
  readonly status?: number;
  constructor(message: string, kind: GeminiErrorKind, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.name = "GeminiError";
  }
}

const TIMEOUT_MS = 60_000;
const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export type GeminiJsonResult = {
  json: unknown;
  model: string;
  /** Why the model stopped, e.g. "STOP" or "MAX_TOKENS". */
  finishReason: string | null;
};

type JsonRequest = {
  systemInstruction: string;
  userContent: string;
  responseSchema: object;
  maxOutputTokens?: number;
};

/** Temporary failures (overload, network) are retried; auth, quota and bad requests are not. */
const RETRY_DELAYS_MS = [2_000, 6_000];

export async function generateJson(request: JsonRequest): Promise<GeminiJsonResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await generateJsonOnce(request);
    } catch (error) {
      const retryable = error instanceof GeminiError && error.kind === "unavailable";
      if (!retryable || attempt >= RETRY_DELAYS_MS.length) throw error;
      console.warn(`[DeployGuard][gemini] ${(error as Error).message} -- retrying (${attempt + 1}/${RETRY_DELAYS_MS.length}).`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }
}

async function generateJsonOnce(request: JsonRequest): Promise<GeminiJsonResult> {
  // Stage 1 tripwire: never send a server secret to the model, whatever happened upstream.
  const leaked = findServerSecretIn(`${request.systemInstruction}
${request.userContent}`);
  if (leaked) throw new GeminiError(`Request not sent: it contained the value of ${leaked}.`, "blocked");

  let apiKey: string;
  try {
    apiKey = env.geminiApiKey();
  } catch (error) {
    throw new GeminiError((error as Error).message, "config");
  }
  const model = env.geminiModel();

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: request.systemInstruction }] },
        contents: [{ role: "user", parts: [{ text: request.userContent }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: request.responseSchema,
          maxOutputTokens: request.maxOutputTokens ?? 8192,
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const name = (error as Error).name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new GeminiError(`Gemini did not answer within ${TIMEOUT_MS / 1000}s.`, "timeout");
    }
    // fetch's own message; it cannot contain the key, which only lives in the headers object.
    throw new GeminiError(`Could not reach Gemini (${name}: ${(error as Error).message})`, "unavailable");
  }

  const text = await response.text();
  if (!response.ok) {
    // Google's error body names the problem (e.g. RESOURCE_EXHAUSTED) and does not echo the key.
    const detail = safeErrorDetail(text);
    const kind: GeminiErrorKind =
      response.status === 401 || response.status === 403
        ? "auth"
        : response.status === 429
          ? "rate_limit"
          : response.status >= 500
            ? "unavailable"
            : "bad_request";
    throw new GeminiError(`Gemini responded ${response.status}: ${detail}`, kind, response.status);
  }

  let body: {
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
  };
  try {
    body = JSON.parse(text);
  } catch {
    throw new GeminiError("Gemini returned a body that is not JSON.", "bad_response");
  }

  const candidate = body.candidates?.[0];
  const finishReason = candidate?.finishReason ?? null;
  const output = (candidate?.content?.parts ?? [])
    .filter((part) => !part.thought && typeof part.text === "string")
    .map((part) => part.text)
    .join("");

  if (!output) {
    const why = body.promptFeedback?.blockReason ?? finishReason ?? "no content";
    throw new GeminiError(`Gemini returned no output (${why}).`, "bad_response");
  }

  try {
    return { json: JSON.parse(output), model, finishReason };
  } catch {
    throw new GeminiError(
      `Gemini's output is not valid JSON (finish reason: ${finishReason ?? "unknown"}).`,
      "bad_response"
    );
  }
}

/** Status + a short message from Google's error body. Never the raw request. */
function safeErrorDetail(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { status?: string; message?: string } };
    return `${parsed.error?.status ?? "error"} - ${(parsed.error?.message ?? "").slice(0, 200)}`;
  } catch {
    return text.slice(0, 200);
  }
}
