import { cookies, headers } from "next/headers";
import { isAuthorized } from "@/lib/auth/bearer-token";
import { getSessionUser, listUserRepositories, type User, type UserRepository } from "@/lib/db/accounts";
import { env } from "@/lib/env";

/**
 * Phase 9: who is making this request?
 *
 *   user      -- a signed-in browser session. Sees ONLY deployments of the
 *                repositories their GitHub App installations granted.
 *   internal  -- DeployGuard's own tooling (CI reporter, verification scripts)
 *                presenting the existing DEPLOYGUARD_STATUS_TOKEN as a Bearer
 *                token. Unscoped, as every endpoint was before Phase 9.
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
      expected = env.deployguardStatusToken();
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
 * Internal error text (database, Hindsight, GitHub messages) is only returned to
 * internal tooling. Signed-in users get the generic error; the detail stays in
 * the server log. Prevents host names or internal state leaking to browsers.
 */
export function errorDetail(viewer: Viewer | null, message: string): { detail?: string } {
  return viewer?.kind === "internal" ? { detail: message } : {};
}

/** Server-side ownership check for a single deployment. Unowned rows are internal-only. */
export function canAccessDeployment(viewer: Viewer, deployment: { repository_id: string | null }): boolean {
  if (viewer.kind === "internal") return true;
  return deployment.repository_id !== null && viewer.repositoryIds.includes(deployment.repository_id);
}
