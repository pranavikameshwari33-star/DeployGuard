import { NextResponse } from "next/server";
import { SESSION_COOKIE, cookieOptions, getViewer, logErrorRef } from "@/lib/auth/session";
import { checkSameOrigin } from "@/lib/auth/csrf";
import { rateLimitResponse } from "@/lib/auth/rate-limit";
import { purgeUser } from "@/lib/lifecycle/purge";
import { writeAudit } from "@/lib/audit/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/account/purge   (Stage 2)   { "confirm": "<your GitHub login>" }
 *
 * Deletes the signed-in user's data: every repository's records in PostgreSQL
 * and Hindsight (verified), then the account (sessions, installation links,
 * user row). Same-origin only, confirmation required, audit-logged. The GitHub
 * App stays installed on GitHub until the user uninstalls it there.
 */
export async function POST(request: Request) {
  const viewer = await getViewer();
  if (viewer?.kind !== "user") return NextResponse.json({ ok: false, error: "Sign in required." }, { status: 401 });
  const csrf = checkSameOrigin(request);
  if (!csrf.ok) return NextResponse.json({ ok: false, error: "Request rejected." }, { status: 403 });
  const limited = await rateLimitResponse(request, "purge", `user:${viewer.user.id}`);
  if (limited) return limited;

  const actor = `user:${viewer.user.id}`;
  const body = (await request.json().catch(() => null)) as { confirm?: unknown } | null;
  if (body?.confirm !== viewer.user.github_login) {
    await writeAudit({ actor, action: "account.purge", outcome: "refused", detail: { reason: "confirmation mismatch" } });
    return NextResponse.json({ ok: false, error: 'Confirmation required: send your GitHub login as "confirm".' }, { status: 400 });
  }
  try {
    const result = await purgeUser(viewer.user.id);
    await writeAudit({
      actor,
      action: "account.purge",
      outcome: result.accountDeleted ? "ok" : "failed",
      detail: { repositories: Object.keys(result.repositories).length, errors: result.errors.length },
    });
    if (!result.accountDeleted) {
      const errorRef = logErrorRef(`Account purge incomplete: ${result.errors.slice(0, 5).join("; ")}`, "purge");
      return NextResponse.json({ ok: false, error: "Purge incomplete; it can be repeated safely.", errorRef }, { status: 500 });
    }
    const response = NextResponse.json({ ok: true, repositories: Object.keys(result.repositories).length });
    response.cookies.set(SESSION_COOKIE, "", cookieOptions(0));
    return response;
  } catch (error) {
    const errorRef = logErrorRef(`Account purge failed: ${(error as Error).message}`, "purge");
    return NextResponse.json({ ok: false, error: "Purge failed; it can be repeated safely.", errorRef }, { status: 500 });
  }
}
