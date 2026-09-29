import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { OAUTH_STATE_COOKIE, cookieOptions, getViewer } from "@/lib/auth/session";
import { getAppSlug } from "@/lib/github/app";
import { rateLimitResponse } from "@/lib/auth/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /auth/github/install -- "Connect GitHub repositories" (Phase 9).
 *
 * Sends a signed-in user to the GitHub App's installation page, where they
 * choose exactly which repositories DeployGuard may see. GitHub then returns to
 * /auth/github/callback with an authorization code, which is used to confirm
 * that the installation really belongs to this user before it is linked.
 */
export async function GET(request: Request) {
  const limited = await rateLimitResponse(request, "authInstall");
  if (limited) return limited;

  const origin = new URL(request.url).origin;
  const viewer = await getViewer();
  if (viewer?.kind !== "user") return NextResponse.redirect(`${origin}/login`);

  let slug: string;
  try {
    slug = await getAppSlug();
  } catch (error) {
    console.error(`[DeployGuard][auth] Could not read the GitHub App's details: ${(error as Error).message}`);
    return NextResponse.redirect(`${origin}/?connect=error`);
  }

  const state = crypto.randomBytes(24).toString("base64url");
  const install = new URL(`https://github.com/apps/${encodeURIComponent(slug)}/installations/new`);
  install.searchParams.set("state", state);

  const response = NextResponse.redirect(install);
  response.cookies.set(OAUTH_STATE_COOKIE, `install:${state}`, cookieOptions(30 * 60, "/auth/github"));
  return response;
}
