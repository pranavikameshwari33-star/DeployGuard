import { NextResponse } from "next/server";
import { listDeployments } from "@/lib/db/deployments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/deployments
 *
 * Reads the `deployments` table, newest first. This is the structured source of
 * truth -- if a push shows up here, Phase 2 storage worked.
 */
export async function GET(request: Request) {
  const limitParam = new URL(request.url).searchParams.get("limit");
  const limit = Math.min(Math.max(Number(limitParam) || 20, 1), 100);

  try {
    const deployments = await listDeployments(limit);
    return NextResponse.json({ count: deployments.length, deployments });
  } catch (error) {
    const message = (error as Error).message;
    console.error(`[DeployGuard][db] Failed to read deployments: ${message}`);
    return NextResponse.json(
      { error: "Could not read deployments from the database.", detail: message },
      { status: 500 }
    );
  }
}
