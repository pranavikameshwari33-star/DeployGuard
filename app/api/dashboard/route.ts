import { NextResponse } from "next/server";
import { getDashboardData } from "@/lib/dashboard/dashboard-data";
import { errorDetail, getViewer, scopeOf } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/dashboard[?id=<deploymentId>][&repo=<githubRepositoryId>][&offset=<n>]
 *
 * Phase 8: the data behind the dashboard page, as JSON -- the selected (or
 * latest) deployment with its risk state, change analysis, historical evidence
 * and pipeline, plus deployment and incident history.
 *
 * Read-only. Reads PostgreSQL only; never calls Gemini or Hindsight.
 * Phase 9: limited to the signed-in user's repositories (internal tooling with
 * Bearer DEPLOYGUARD_INTERNAL_TOKEN sees everything).
 */
export async function GET(request: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const id = params.get("id") ?? undefined;
  const repo = params.get("repo");
  const offset = params.get("offset");
  for (const [name, value] of [["id", id], ["repo", repo], ["offset", offset]] as const) {
    if (value != null && !/^\d{1,19}$/.test(value)) {
      return NextResponse.json({ error: `${name} must be numeric.` }, { status: 400 });
    }
  }
  try {
    // Stage 3: ?repo is ANDed with the viewer's scope in SQL, so a repository
    // that is not the viewer's simply returns nothing.
    const data = await getDashboardData({
      deploymentId: id,
      scope: scopeOf(viewer),
      githubRepositoryId: repo,
      historyOffset: offset ? Math.min(Number(offset), 100_000) : 0,
    });
    if (data.notFound) return NextResponse.json({ error: `No deployment #${id}.` }, { status: 404 });
    return NextResponse.json(data);
  } catch (error) {
    const message = (error as Error).message;
    console.error(`[DeployGuard][dashboard] ${message}`);
    return NextResponse.json({ error: "Could not load dashboard data.", ...errorDetail(viewer, message) }, { status: 500 });
  }
}
