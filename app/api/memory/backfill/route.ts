import { NextResponse } from "next/server";
import { listDeployments } from "@/lib/db/deployments";
import { buildDeploymentMemory } from "@/lib/hindsight/deployment-memory";
import { retain } from "@/lib/hindsight/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/memory/backfill
 *
 * Recovery tool for the case Step 7 of Phase 2 cares about: the database write
 * succeeded but Hindsight was unavailable, so a deployment exists with no
 * memory. This re-stores memories for recent deployments from the database.
 *
 * Re-running it is safe. Each memory uses a stable `document_id` with
 * `update_mode: "replace"`, so a deployment that already has a memory gets it
 * overwritten with identical content rather than duplicated.
 *
 *   curl -X POST http://localhost:3000/api/memory/backfill
 */
export async function POST(request: Request) {
  const limitParam = new URL(request.url).searchParams.get("limit");
  const limit = Math.min(Math.max(Number(limitParam) || 20, 1), 100);

  let deployments;
  try {
    deployments = await listDeployments(limit);
  } catch (error) {
    return NextResponse.json(
      { error: "Could not read deployments from the database.", detail: (error as Error).message },
      { status: 500 }
    );
  }

  const restored: string[] = [];
  const failed: { deploymentId: string; error: string }[] = [];

  for (const deployment of deployments) {
    try {
      await retain(buildDeploymentMemory(deployment));
      restored.push(deployment.id);
    } catch (error) {
      failed.push({ deploymentId: deployment.id, error: (error as Error).message });
    }
  }

  console.log(
    `[DeployGuard][memory] Backfill complete: ${restored.length} stored, ${failed.length} failed.`
  );

  return NextResponse.json({
    ok: failed.length === 0,
    considered: deployments.length,
    restored,
    failed,
  });
}
