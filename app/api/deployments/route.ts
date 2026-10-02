import { NextResponse } from "next/server";
import { listDeployments } from "@/lib/db/deployments";
import { errorDetail, getViewer, scopeOf } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/deployments
 *
 * The `deployments` table, newest first -- limited to the caller's scope
 * (Phase 9): a signed-in user sees only deployments of their connected
 * repositories; internal tooling (Bearer DEPLOYGUARD_INTERNAL_TOKEN) sees all.
 */
export async function GET(request: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  const limitParam = new URL(request.url).searchParams.get("limit");
  const limit = Math.min(Math.max(Number(limitParam) || 20, 1), 100);

  try {
    const deployments = await listDeployments(limit, scopeOf(viewer));
    return NextResponse.json({ count: deployments.length, deployments });
  } catch (error) {
    const message = (error as Error).message;
    console.error(`[DeployGuard][db] Failed to read deployments: ${message}`);
    return NextResponse.json(
      { error: "Could not read deployments from the database.", ...errorDetail(viewer, message) },
      { status: 500 }
    );
  }
}
