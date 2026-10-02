import { NextResponse } from "next/server";
import { getViewer, logErrorRef } from "@/lib/auth/session";
import { runMaintenance } from "@/lib/maintenance/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Allow the run its full time budget on hosts that honour this (e.g. Vercel).
export const maxDuration = 60;

/**
 * POST /api/maintenance/run  (Phase 10)
 *   Authorization: Bearer <DEPLOYGUARD_INTERNAL_TOKEN>   (Stage 1: the CI status token is rejected)
 *
 * Runs one bounded maintenance/reconciliation pass (see lib/maintenance/run.ts)
 * and returns what it did. Meant to be called on a schedule -- e.g. the
 * .github/workflows/deployguard-maintenance.yml workflow, or any cron service --
 * so no long-running server process is needed. Safe to call repeatedly.
 *
 * GET is accepted too, for schedulers that can only send GET (same token).
 */
async function handle() {
  const viewer = await getViewer();
  if (viewer?.kind !== "internal") {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    return NextResponse.json({ ok: true, report: await runMaintenance({ budgetMs: 50_000 }) });
  } catch (error) {
    const errorRef = logErrorRef(`Run failed: ${(error as Error).message}`, "maintenance");
    return NextResponse.json({ ok: false, error: "Maintenance run failed.", errorRef }, { status: 500 });
  }
}

export const POST = handle;
export const GET = handle;
