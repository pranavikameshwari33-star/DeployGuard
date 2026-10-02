import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, cookieOptions } from "@/lib/auth/session";
import { deleteSession } from "@/lib/db/accounts";
import { rateLimitResponse } from "@/lib/auth/rate-limit";
import { checkSameOrigin } from "@/lib/auth/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /auth/logout (Phase 9): deletes the session row and clears the cookie.
 * POST only (from the dashboard's form): with SameSite=Lax cookies another site
 * cannot trigger it, and (Stage 1) the request must come from our own origin.
 */
export async function POST(request: Request) {
  const limited = await rateLimitResponse(request, "authLogout");
  if (limited) return limited;

  const csrf = checkSameOrigin(request);
  if (!csrf.ok) {
    console.warn(`[DeployGuard][csrf] Rejected logout: ${csrf.reason}.`);
    return NextResponse.json({ error: "Request rejected." }, { status: 403 });
  }

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) {
    try {
      await deleteSession(token);
    } catch (error) {
      console.error(`[DeployGuard][auth] Could not delete session: ${(error as Error).message}`);
    }
  }
  // 303 turns the POST into a GET of the login page.
  const response = NextResponse.redirect(`${new URL(request.url).origin}/login`, 303);
  response.cookies.set(SESSION_COOKIE, "", cookieOptions(0));
  return response;
}
