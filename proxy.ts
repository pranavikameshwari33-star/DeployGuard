import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Phase 9 fix: send anonymous visitors of the dashboard to /login with a real
 * HTTP redirect.
 *
 * The dashboard page has a loading boundary (app/loading.tsx), so Next.js starts
 * streaming it with status 200 before the page's own redirect("/login") runs.
 * That streamed redirect works in a browser and never includes dashboard data,
 * but non-browser clients see a 200. This check runs before rendering.
 *
 * It only looks at whether a session cookie (or an internal Bearer token) is
 * PRESENT. Validating it stays in the page (lib/auth/session.ts), so an
 * expired or forged cookie still ends up on /login -- this is a fast first
 * filter, not the authorization check.
 */
export function proxy(request: NextRequest) {
  const hasSession = Boolean(request.cookies.get("dg_session")?.value);
  const hasBearer = request.headers.get("authorization")?.startsWith("Bearer ") ?? false;
  if (!hasSession && !hasBearer) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

export const config = {
  // Only the dashboard page. API routes answer 401 themselves; /login and
  // /auth/* must stay reachable without a session.
  matcher: ["/"],
};
