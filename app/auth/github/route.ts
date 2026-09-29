import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { OAUTH_STATE_COOKIE, cookieOptions } from "@/lib/auth/session";
import { rateLimitResponse } from "@/lib/auth/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /auth/github -- "Continue with GitHub" (Phase 9).
 *
 * Sends the browser to GitHub's authorization page for the DeployGuard GitHub
 * App. A random `state` is stored in a short-lived httpOnly cookie and must
 * come back unchanged on the callback (CSRF / login-forgery protection).
 */
export async function GET(request: Request) {
  const limited = await rateLimitResponse(request, "authStart");
  if (limited) return limited;

  const origin = new URL(request.url).origin;
  const state = crypto.randomBytes(24).toString("base64url");

  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", env.githubAppClientId());
  authorize.searchParams.set("redirect_uri", `${origin}/auth/github/callback`);
  authorize.searchParams.set("state", state);

  const response = NextResponse.redirect(authorize);
  response.cookies.set(OAUTH_STATE_COOKIE, `login:${state}`, cookieOptions(10 * 60, "/auth/github"));
  return response;
}
