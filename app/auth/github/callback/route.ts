import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { OAUTH_STATE_COOKIE, SESSION_COOKIE, cookieOptions, getViewer } from "@/lib/auth/session";
import { SESSION_TTL_DAYS, createSession, upsertUser } from "@/lib/db/accounts";
import { exchangeCodeForUserToken, getAuthenticatedUser } from "@/lib/github/app";
import { claimUserInstallations } from "@/lib/github/installations";
import { rateLimitResponse } from "@/lib/auth/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /auth/github/callback (Phase 9) -- where GitHub returns after
 *   (a) sign-in            ("Continue with GitHub", state flow "login"), or
 *   (b) app installation   ("Connect GitHub repositories", state flow "install";
 *                           the App has "Request user authorization during
 *                           installation" enabled, so GitHub returns here with a code).
 *
 * Checks, in order:
 *   1. `state` matches the httpOnly cookie set when the flow started. Sign-in
 *      without a valid state is always rejected (login CSRF). An installation
 *      started on GitHub itself carries no state; it is accepted only for a
 *      user who is already signed in AND whose GitHub identity matches (step 3).
 *   2. The code is exchanged server-side (client secret never leaves the server).
 *   3. The GitHub user behind the code is looked up. For an installation it must
 *      be the signed-in user.
 *   4. Installations are linked only if GitHub confirms, via that user's own
 *      token, that the user can access them. An installation_id in the URL is
 *      never trusted on its own.
 * The GitHub user token is used for these calls and then dropped: it is not
 * stored, logged, or sent to the browser.
 */
export async function GET(request: Request) {
  const limited = await rateLimitResponse(request, "authCallback");
  if (limited) return limited;

  const url = new URL(request.url);
  const origin = url.origin;
  const params = url.searchParams;

  const jar = await cookies();
  const stateCookie = jar.get(OAUTH_STATE_COOKIE)?.value ?? "";
  const [cookieFlow, cookieState] = stateCookie.split(":");

  const fail = (to: string, reason: string) => {
    console.warn(`[DeployGuard][auth] Callback rejected: ${reason}`);
    const response = NextResponse.redirect(`${origin}${to}`);
    response.cookies.set(OAUTH_STATE_COOKIE, "", cookieOptions(0, "/auth/github"));
    return response;
  };

  if (params.get("error")) return fail("/login?error=denied", `GitHub returned ${params.get("error")}`);

  // An org owner must approve the installation first; GitHub sends no code.
  if (params.get("setup_action") === "request") return fail("/?connect=requested", "installation awaiting approval");

  // ---- 1. state ----
  const state = params.get("state");
  const installationParam = params.get("installation_id");
  let flow: "login" | "install";
  if (state) {
    if (!cookieState || !safeEqual(state, cookieState)) return fail("/login?error=state", "state mismatch");
    flow = cookieFlow === "install" ? "install" : "login";
  } else if (installationParam) {
    flow = "install"; // installed from GitHub directly; identity must match below
  } else {
    return fail("/login?error=state", "missing state");
  }

  const viewer = await getViewer();
  if (flow === "install" && viewer?.kind !== "user") {
    return fail("/login?error=signin_first", "installation callback without a signed-in user");
  }

  const code = params.get("code");
  if (!code || code.length > 200) return fail(flow === "login" ? "/login?error=callback" : "/?connect=error", "missing code");

  // ---- 2 + 3. exchange the code, identify the GitHub user ----
  let userToken: string;
  let githubUser;
  try {
    userToken = await exchangeCodeForUserToken(code, `${origin}/auth/github/callback`);
    githubUser = await getAuthenticatedUser(userToken);
  } catch (error) {
    return fail(flow === "login" ? "/login?error=callback" : "/?connect=error", (error as Error).message);
  }

  if (flow === "install") {
    const current = viewer?.kind === "user" ? viewer.user : null;
    if (!current || current.github_user_id !== String(githubUser.id)) {
      return fail("/?connect=account_mismatch", "installation authorized by a different GitHub account");
    }
    const requested = installationParam && /^\d{1,19}$/.test(installationParam) ? Number(installationParam) : undefined;
    try {
      const result = await claimUserInstallations(userToken, current, requested);
      if (requested !== undefined && !result.requestedConfirmed) {
        return fail(
          result.ownedByOthers.includes(requested) ? "/?connect=taken" : "/?connect=unverified",
          `installation ${requested} not confirmed for this user`
        );
      }
    } catch (error) {
      return fail("/?connect=error", `installation lookup failed: ${(error as Error).message}`);
    }
    const response = NextResponse.redirect(`${origin}/?connect=done`);
    response.cookies.set(OAUTH_STATE_COOKIE, "", cookieOptions(0, "/auth/github"));
    return response;
  }

  // ---- login: account + session ----
  const user = await upsertUser(githubUser);
  try {
    // Link installations this user already has (e.g. installed before signing in).
    await claimUserInstallations(userToken, user);
  } catch (error) {
    console.warn(`[DeployGuard][auth] Could not look up installations at sign-in: ${(error as Error).message}`);
  }
  const session = await createSession(user.id);
  console.log(`[DeployGuard][auth] Signed in @${user.github_login}.`);

  const response = NextResponse.redirect(`${origin}/`);
  response.cookies.set(SESSION_COOKIE, session.token, cookieOptions(SESSION_TTL_DAYS * 24 * 60 * 60));
  response.cookies.set(OAUTH_STATE_COOKIE, "", cookieOptions(0, "/auth/github"));
  return response;
}

function safeEqual(a: string, b: string): boolean {
  const digest = (v: string) => crypto.createHash("sha256").update(v, "utf8").digest();
  return crypto.timingSafeEqual(digest(a), digest(b));
}
