import { NextResponse } from "next/server";
import { findSimilarDeployments } from "@/lib/similarity/find-similar";
import { canAccessDeployment, errorDetail, getViewer } from "@/lib/auth/session";
import { getDeploymentById } from "@/lib/db/deployments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/deployments/similar?id=<deploymentId>
 *
 * Phase 6: historical evidence for one deployment -- earlier deployments of the
 * same repository that changed the same files/services/categories, why each
 * matched, and what happened to it (status, failure, incident).
 *
 * Optional: &minScore=2  &limit=10  &hindsight=0 (database only)
 *
 * Read-only, like GET /api/deployments. It returns recorded facts only; it does
 * not judge risk (Phase 7).
 */
export async function GET(request: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const id = params.get("id") ?? "";

  if (!/^\d{1,19}$/.test(id)) {
    return NextResponse.json(
      { error: "Add a numeric deployment id, e.g. /api/deployments/similar?id=12" },
      { status: 400 }
    );
  }

  // Phase 9: ownership is checked server-side. Someone else's deployment answers
  // exactly like a missing one, so ids cannot be probed.
  const deployment = await getDeploymentById(id);
  if (!deployment || !canAccessDeployment(viewer, deployment)) {
    return NextResponse.json({ error: `No deployment #${id}.` }, { status: 404 });
  }

  const minScoreParam = Number(params.get("minScore"));
  const limitParam = Number(params.get("limit"));

  try {
    const result = await findSimilarDeployments(id, {
      minScore: Number.isFinite(minScoreParam) && minScoreParam > 0 ? minScoreParam : undefined,
      limit: Math.min(Math.max(limitParam || 10, 1), 50),
      useHindsight: params.get("hindsight") !== "0",
    });

    if (!result) {
      return NextResponse.json({ error: `No deployment #${id}.` }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (error) {
    const message = (error as Error).message;
    console.error(`[DeployGuard][similarity] Failed for deployment #${id}: ${message}`);
    return NextResponse.json(
      { error: "Could not compute similar deployments.", ...errorDetail(viewer, message) },
      { status: 500 }
    );
  }
}
