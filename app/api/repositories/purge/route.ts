import { NextResponse } from "next/server";
import { getViewer, logErrorRef } from "@/lib/auth/session";
import { checkSameOrigin } from "@/lib/auth/csrf";
import { rateLimitResponse } from "@/lib/auth/rate-limit";
import { purgeRepository } from "@/lib/lifecycle/purge";
import { writeAudit } from "@/lib/audit/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/repositories/purge   (Stage 2)
 *   { "githubRepositoryId": "123", "confirm": "owner/name" }
 *
 * Permanently deletes everything DeployGuard holds for one repository from
 * PostgreSQL AND Hindsight, then verifies both. Only the repository's owner
 * (signed in, same-origin request) or internal tooling may do it; a signed-in
 * owner must repeat the repository's full name as confirmation. Every attempt
 * is audit-logged. Disconnecting a repository never purges it.
 */
export async function POST(request: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  if (viewer.kind === "user") {
    const csrf = checkSameOrigin(request);
    if (!csrf.ok) return NextResponse.json({ ok: false, error: "Request rejected." }, { status: 403 });
    const limited = await rateLimitResponse(request, "purge", `user:${viewer.user.id}`);
    if (limited) return limited;
  }
  const actor = viewer.kind === "user" ? `user:${viewer.user.id}` : "internal";

  const body = (await request.json().catch(() => null)) as { githubRepositoryId?: unknown; confirm?: unknown } | null;
  const id = String(body?.githubRepositoryId ?? "");
  if (!/^\d{1,19}$/.test(id)) return NextResponse.json({ ok: false, error: "githubRepositoryId is required." }, { status: 400 });

  // Ownership: the user's own repositories only (same answer as "not found" otherwise).
  if (viewer.kind === "user") {
    const repo = viewer.repositories.find((r) => String(r.github_repository_id) === id);
    if (!repo) return NextResponse.json({ ok: false, error: "No such repository." }, { status: 404 });
    if (body?.confirm !== repo.full_name) {
      await writeAudit({ actor, action: "repository.purge", githubRepositoryId: id, outcome: "refused", detail: { reason: "confirmation mismatch" } });
      return NextResponse.json(
        { ok: false, error: 'Confirmation required: send the full repository name (owner/name) as "confirm".' },
        { status: 400 }
      );
    }
  }

  try {
    const report = await purgeRepository(id);
    const ok = report.errors.length === 0 && report.verified.postgres && report.verified.hindsightDocuments;
    await writeAudit({
      actor,
      action: "repository.purge",
      githubRepositoryId: id,
      outcome: ok ? "ok" : "failed",
      detail: {
        deployments: report.deployments,
        documentsDeleted: report.documentsDeleted,
        verifiedPostgres: report.verified.postgres,
        verifiedHindsightDocuments: report.verified.hindsightDocuments,
        recallEmpty: report.verified.hindsightRecallEmpty,
        errors: report.errors.length,
      },
    });
    const safeReport = { ...report, errors: report.errors.length };
    if (!ok) {
      const errorRef = logErrorRef(`Purge of ghrepo:${id} incomplete: ${report.errors.slice(0, 5).join("; ")}`, "purge");
      return NextResponse.json({ ok: false, error: "Purge incomplete; it can be repeated safely.", errorRef, report: safeReport }, { status: 500 });
    }
    return NextResponse.json({ ok: true, report: safeReport });
  } catch (error) {
    await writeAudit({ actor, action: "repository.purge", githubRepositoryId: id, outcome: "failed" });
    const errorRef = logErrorRef(`Purge of ghrepo:${id} failed: ${(error as Error).message}`, "purge");
    return NextResponse.json({ ok: false, error: "Purge failed; it can be repeated safely.", errorRef }, { status: 500 });
  }
}
