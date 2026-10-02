import crypto from "node:crypto";
import { env } from "@/lib/env";

/**
 * Phase 9: GitHub App client -- plain fetch, no SDK (same approach as the
 * Hindsight and Gemini clients).
 *
 *  - App JWT: signed with the App's private key (RS256, node:crypto), valid for
 *    under 10 minutes, used only to mint installation tokens / read app info.
 *  - Installation tokens: requested on demand, kept in memory until shortly
 *    before they expire (GitHub issues them for 1 hour), never stored or logged.
 *  - User tokens (from the login code exchange): used for one or two identity
 *    calls by the caller and then dropped.
 *
 * Errors carry the HTTP status and GitHub's message -- never a token.
 */

const API = "https://api.github.com";
const TIMEOUT_MS = 15_000;

export type GitHubErrorKind =
  | "unavailable"   // network error or 5xx
  | "rate_limited"  // 429, or 403 with the rate limit exhausted
  | "unauthorized"  // 401: token expired / revoked / wrong credentials
  | "forbidden"     // 403: e.g. installation suspended, permission missing
  | "not_found"     // 404/410: installation or repository gone / not accessible
  | "bad_request";

export class GitHubApiError extends Error {
  // Plain fields (not parameter properties) so Node's type stripping can load this module.
  readonly status?: number;
  readonly kind: GitHubErrorKind;
  constructor(message: string, status?: number, kind: GitHubErrorKind = "unavailable") {
    super(message);
    this.status = status;
    this.kind = kind;
    this.name = "GitHubApiError";
  }
}

function kindFor(status: number, rateLimitRemaining: string | null): GitHubErrorKind {
  if (status === 429 || (status === 403 && rateLimitRemaining === "0")) return "rate_limited";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404 || status === 410) return "not_found";
  if (status >= 500) return "unavailable";
  return "bad_request";
}

/** Phase 10: transient failures are retried; waits are capped so a request never hangs. */
const MAX_RETRIES = 2;
const MAX_WAIT_MS = 10_000;

function retryDelay(response: Response | null, attempt: number): number {
  const retryAfter = Number(response?.headers.get("retry-after"));
  if (retryAfter > 0) return retryAfter * 1000;
  const reset = Number(response?.headers.get("x-ratelimit-reset"));
  if (reset > 0) return reset * 1000 - Date.now();
  return [1000, 3000][attempt] ?? 3000;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** A short-lived JWT that authenticates as the GitHub App itself. */
function appJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // iat is backdated 60s to tolerate clock drift, as GitHub recommends.
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: env.githubAppId() }));
  const signature = crypto.createSign("RSA-SHA256").update(`${header}.${payload}`).sign(env.githubAppPrivateKey());
  return `${header}.${payload}.${base64url(signature)}`;
}

async function githubFetch(url: string, init: RequestInit & { token: string }): Promise<Response> {
  const { token, ...rest } = init;
  try {
    return await fetch(url.startsWith("http") ? url : `${API}${url}`, {
      ...rest,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "DeployGuard",
        Authorization: `Bearer ${token}`,
        ...(rest.headers ?? {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new GitHubApiError(`Could not reach GitHub (${(error as Error).name})`, undefined, "unavailable");
  }
}

async function githubJson<T>(url: string, init: RequestInit & { token: string }): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let response: Response | null = null;
    let error: GitHubApiError;
    try {
      response = await githubFetch(url, init);
      const text = await response.text();
      if (response.ok) return JSON.parse(text) as T;

      let message = text.slice(0, 200);
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? message;
      } catch {}
      error = new GitHubApiError(
        `GitHub responded ${response.status}: ${message}`,
        response.status,
        kindFor(response.status, response.headers.get("x-ratelimit-remaining"))
      );
    } catch (thrown) {
      if (!(thrown instanceof GitHubApiError)) throw thrown;
      error = thrown; // network failure from githubFetch
    }

    const retryable = error.kind === "unavailable" || error.kind === "rate_limited";
    const wait = retryDelay(response, attempt);
    if (!retryable || attempt >= MAX_RETRIES || wait > MAX_WAIT_MS) throw error;
    console.warn(`[DeployGuard][github] ${error.message} -- retrying in ${Math.max(0, Math.round(wait / 1000))}s.`);
    await new Promise((r) => setTimeout(r, Math.max(0, wait)));
  }
}

// ---------------------------------------------------------------------------
// App-level
// ---------------------------------------------------------------------------

let cachedSlug: string | null = null;

/** The App's URL slug (for the install link), read once from GitHub. */
export async function getAppSlug(): Promise<string> {
  if (cachedSlug) return cachedSlug;
  const app = await githubJson<{ slug: string }>("/app", { token: appJwt() });
  cachedSlug = app.slug;
  return cachedSlug;
}

const tokenCache = new Map<number, { token: string; expiresAt: number }>();

/** A short-lived installation token. Kept in memory only, refreshed 5 minutes before expiry. */
async function installationToken(installationId: number): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt - Date.now() > 5 * 60 * 1000) return cached.token;

  const result = await githubJson<{ token: string; expires_at: string }>(
    `/app/installations/${installationId}/access_tokens`,
    { method: "POST", token: appJwt() }
  );
  tokenCache.set(installationId, { token: result.token, expiresAt: new Date(result.expires_at).getTime() });
  return result.token;
}

/**
 * A GET request made as an installation (only sees what the user granted).
 * A 401 means the cached token was revoked or expired early: it is dropped and
 * a fresh one is requested once.
 */
export async function installationGet<T>(installationId: number, path: string): Promise<T> {
  try {
    return await githubJson<T>(path, { token: await installationToken(installationId) });
  } catch (error) {
    if (!(error instanceof GitHubApiError) || error.kind !== "unauthorized") throw error;
    tokenCache.delete(installationId);
    return githubJson<T>(path, { token: await installationToken(installationId) });
  }
}

/**
 * Stage 5: a JSON write as an installation. Used ONLY for advisory check runs
 * (POST /check-runs, PATCH /check-runs/{id}), which need "Checks: write".
 */
export async function installationSend<T>(installationId: number, method: "POST" | "PATCH", path: string, body: unknown): Promise<T> {
  const init = (token: string) => ({ method, token, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    return await githubJson<T>(path, init(await installationToken(installationId)));
  } catch (error) {
    if (!(error instanceof GitHubApiError) || error.kind !== "unauthorized") throw error;
    tokenCache.delete(installationId);
    return githubJson<T>(path, init(await installationToken(installationId)));
  }
}

/**
 * Stage 5: one file's text at a ref via the contents API, or null when it does
 * not exist (404). Files over `maxBytes` are refused without being decoded.
 */
export async function getRepositoryFile(
  installationId: number,
  fullName: string,
  path: string,
  ref: string | null,
  maxBytes: number
): Promise<{ text: string; sha: string } | null> {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  try {
    const file = await installationGet<{ type?: string; size?: number; encoding?: string; content?: string; sha?: string }>(
      installationId,
      `/repos/${fullName}/contents/${path.split("/").map(encodeURIComponent).join("/")}${query}`
    );
    if (file.type !== "file" || typeof file.content !== "string" || file.encoding !== "base64") return null;
    if ((file.size ?? 0) > maxBytes) throw new GitHubApiError(`${path} is larger than ${maxBytes} bytes`, 413, "bad_request");
    return { text: Buffer.from(file.content, "base64").toString("utf8"), sha: file.sha ?? "" };
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return null;
    throw error;
  }
}

/** Plain-text GET as an installation (used for job logs). Follows GitHub's redirect to the log file. */
export async function installationGetText(installationId: number, path: string): Promise<string> {
  const response = await githubFetch(path, { token: await installationToken(installationId), redirect: "follow" });
  if (!response.ok) {
    if (response.status === 401) tokenCache.delete(installationId);
    throw new GitHubApiError(
      `GitHub responded ${response.status} for a log download`,
      response.status,
      kindFor(response.status, response.headers.get("x-ratelimit-remaining"))
    );
  }
  return response.text();
}

/** Forget a cached token (e.g. the installation was removed or suspended). */
export function forgetInstallationToken(installationId: number): void {
  tokenCache.delete(installationId);
}

export type AppInstallation = {
  id: number;
  account: { id: number; login: string; type: string } | null;
  suspended_at: string | null;
};

/**
 * The installation as GitHub sees it now (authenticated as the App). Throws a
 * GitHubApiError with kind "not_found" if it was uninstalled.
 */
export async function getAppInstallation(installationId: number): Promise<AppInstallation> {
  return githubJson<AppInstallation>(`/app/installations/${installationId}`, { token: appJwt() });
}

export type CommitDetails = {
  sha: string;
  commit: { message: string; author: { name?: string; email?: string; date?: string } | null };
  author: { login?: string } | null;
  files?: { filename: string; status: string; previous_filename?: string }[];
};

/** One commit with its changed files (Contents: read). Used to recover a missed push. */
export async function getCommit(installationId: number, fullName: string, sha: string): Promise<CommitDetails> {
  return installationGet<CommitDetails>(installationId, `/repos/${fullName}/commits/${sha}`);
}

export type GitHubRepo = {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  default_branch?: string;
  private?: boolean;
};

/** Every repository the installation was granted (the user's selection). */
export async function listInstallationRepositories(installationId: number): Promise<GitHubRepo[]> {
  const all: GitHubRepo[] = [];
  for (let page = 1; page <= 20; page++) {
    const result = await installationGet<{ repositories: GitHubRepo[]; total_count: number }>(
      installationId,
      `/installation/repositories?per_page=100&page=${page}`
    );
    all.push(...result.repositories);
    if (all.length >= result.total_count || result.repositories.length === 0) break;
  }
  return all;
}

// ---------------------------------------------------------------------------
// User-level (login)
// ---------------------------------------------------------------------------

/** Exchanges the callback code for a user token. Server-side only; the client secret never leaves the server. */
export async function exchangeCodeForUserToken(code: string, redirectUri: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "DeployGuard" },
      body: JSON.stringify({
        client_id: env.githubAppClientId(),
        client_secret: env.githubAppClientSecret(),
        code,
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new GitHubApiError(`Could not reach GitHub (${(error as Error).name})`, undefined, "unavailable");
  }
  const body =(await response.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!response.ok || !body.access_token) {
    // GitHub reports e.g. "bad_verification_code"; the code itself is not echoed.
    throw new GitHubApiError(
      `Code exchange failed (${body.error ?? `HTTP ${response.status}`})`,
      response.status,
      response.status >= 500 ? "unavailable" : "bad_request"
    );
  }
  return body.access_token;
}

export type GitHubUser = { id: number; login: string; name: string | null; avatar_url: string | null };

export async function getAuthenticatedUser(userToken: string): Promise<GitHubUser> {
  const user = await githubJson<GitHubUser>("/user", { token: userToken });
  return { id: user.id, login: user.login, name: user.name ?? null, avatar_url: user.avatar_url ?? null };
}

export type UserInstallation = {
  id: number;
  app_id: number;
  account: { id: number; login: string; type: string } | null;
};

/**
 * Installations of THIS app that the signed-in GitHub user can access. This is
 * GitHub's own answer to "does this installation belong to this user?", which
 * is why an installation_id from a redirect is never trusted on its own.
 */
export async function listUserInstallations(userToken: string): Promise<UserInstallation[]> {
  const result = await githubJson<{ installations: UserInstallation[] }>("/user/installations?per_page=100", {
    token: userToken,
  });
  const appId = Number(env.githubAppId());
  return result.installations.filter((i) => i.app_id === appId);
}
