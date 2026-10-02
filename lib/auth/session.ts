import crypto from "node:crypto";
import { cookies, headers } from "next/headers";
import { isAuthorized } from "@/lib/auth/bearer-token";
import { getSessionUser, listUserRepositories, type User, type UserRepository } from "@/lib/db/accounts";
import { env } from "@/lib/env";
import { redactText } from "@/lib/security/redact";

/**
 * Phase 9: who is making this request?
 *
 *   user      -- a signed-in browser session. Sees ONLY deployments of the
 *                repositories their GitHub App installations granted.
 *   internal  -- DeployGuard's own tooling (maintenance schedule, verification
 *                scripts) presenting DEPLOYGUARD_INTERNAL_TOKEN as a Bearer
 *                token. Unscoped. Stage 1: the CI STATUS token is NOT accepted
 *                here; it only works on POST /api/deployments/status.
 *   null      -- anonymous: protected endpoints answer 401, pages redirect to /login.
 *
 * The session cookie holds a random token; the database stores only its hash
 * (see lib/db/accounts.ts). The cookie is httpOnly, SameSite=Lax, and Secure in
 * production, so page scripts cannot read it and cross-site requests cannot
 * make state-changing calls with it.
 */

export const SESSION_COOKIE = "dg_session";
export const OAUTH_STATE_COOKIE = "dg_oauth_state";

export type Viewer =
  | { kind: "user"; user: User; repositories: UserRepository[]; repositoryIds: string[] }
  | { kind: "internal" };

export function cookieOptions(maxAgeSeconds: number, path = "/") {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path,
    maxAge: maxAgeSeconds,
  };
}

/** Resolves the viewer from the current request (route handlers and server components). */
export async function getViewer(): Promise<Viewer | null> {
  const authorization = (await headers()).get("authorization");
  if (authorization) {
    let expected: string | null = null;
    try {
      expected = env.deployguardInternalToken();
    } catch {
      expected = null;
    }
    if (expected && isAuthorized(authorization, expected)) return { kind: "internal" };
  }

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const user = await getSessionUser(token);
  if (!user) return null;

  const repositories = await listUserRepositories(user.id);
  return { kind: "user", user, repositories, repositoryIds: repositories.map((r) => r.id) };
}

/** The data scope for queries: every repository (internal) or the user's own repositories. */
export type DataScope = { all: true } | { all: false; repositoryIds: string[] };

export function scopeOf(viewer: Viewer): DataScope {
  return viewer.kind === "internal" ? { all: true } : { all: false, repositoryIds: viewer.repositoryIds };
}

/**
 * Stage 1: error detail (database, Hindsight, GitHub messages) is NEVER sent to
 * a client -- not even internal tooling, whose output can end up in CI logs.
 * The detail is logged server-side with a short random reference, and only
 * the reference is returned, so an operator can find the log line.
 */
export function errorDetail(_viewer: Viewer | null, message: string): { errorRef: string } {
  return { errorRef: logErrorRef(message) };
}

/** Logs an internal error message under a fresh reference and returns the reference. */
export function logErrorRef(message: string, area = "error"): string {
  const ref = crypto.randomBytes(4).toString("hex");
  console.error(`[DeployGuard][${area}] ref=${ref}: ${redactText(message)}`);
  return ref;
}

/** Server-side ownership check for a single deployment. Unowned rows are internal-only. */
export function canAccessDeployment(viewer: Viewer, deployment: { repository_id: string | null }): boolean {
  if (viewer.kind === "internal") return true;
  return deployment.repository_id !== null && viewer.repositoryIds.includes(deployment.repository_id);
}
