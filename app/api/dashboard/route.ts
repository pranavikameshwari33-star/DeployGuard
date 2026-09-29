import { NextResponse } from "next/server";
import { getDashboardData } from "@/lib/dashboard/dashboard-data";
import { errorDetail, getViewer, scopeOf } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/dashboard[?id=<deploymentId>]
 *
 * Phase 8: the data behind the dashboard page, as JSON -- the selected (or
 * latest) deployment with its risk state, change analysis, historical evidence
 * and pipeline, plus deployment and incident history.
 *
 * Read-only. Reads PostgreSQL only; never calls Gemini or Hindsight.
 * Phase 9: limited to the signed-in user's repositories (internal tooling with
 * Bearer DEPLOYGUARD_STATUS_TOKEN sees everything).
 */
export async function GET(request: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  const id = new URL(request.url).searchParams.get("id") ?? undefined;
  if (id !== undefined && !/^\d{1,19}$/.test(id)) {
    return NextResponse.json({ error: "id must be a numeric deployment id." }, { status: 400 });
  }
  try {
    const data = await getDashboardData({ deploymentId: id, scope: scopeOf(viewer) });
    if (data.notFound) return NextResponse.json({ error: `No deployment #${id}.` }, { status: 404 });
    return NextResponse.json(data);
  } catch (error) {
    const message = (error as Error).message;
    console.error(`[DeployGuard][dashboard] ${message}`);
    return NextResponse.json({ error: "Could not load dashboard data.", ...errorDetail(viewer, message) }, { status: 500 });
  }
}
