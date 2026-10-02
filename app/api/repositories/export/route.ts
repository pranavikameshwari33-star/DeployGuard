import { NextResponse } from "next/server";
import { getViewer, logErrorRef } from "@/lib/auth/session";
import { rateLimitResponse } from "@/lib/auth/rate-limit";
import { exportRepository } from "@/lib/lifecycle/purge";
import { writeAudit } from "@/lib/audit/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/repositories/export?githubRepositoryId=123   (Stage 2)
 * The owner's own records for one repository as a JSON download
 * (deployments, incidents, risk assessments). Audit-logged.
 */
export async function GET(request: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const id = new URL(request.url).searchParams.get("githubRepositoryId") ?? "";
  if (!/^\d{1,19}$/.test(id)) return NextResponse.json({ error: "githubRepositoryId is required." }, { status: 400 });
  if (viewer.kind === "user") {
    if (!viewer.repositories.some((r) => String(r.github_repository_id) === id)) {
      return NextResponse.json({ error: "No such repository." }, { status: 404 });
    }
    const limited = await rateLimitResponse(request, "export", `user:${viewer.user.id}`);
    if (limited) return limited;
  }
  const actor = viewer.kind === "user" ? `user:${viewer.user.id}` : "internal";
  try {
    const data = await exportRepository(id);
    await writeAudit({ actor, action: "repository.export", githubRepositoryId: id, outcome: "ok", detail: { deployments: data.deployments.length } });
    return new NextResponse(JSON.stringify(data, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="deployguard-export-${id}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    await writeAudit({ actor, action: "repository.export", githubRepositoryId: id, outcome: "failed" });
    return NextResponse.json({ error: "Export failed.", errorRef: logErrorRef((error as Error).message, "export") }, { status: 500 });
  }
}
