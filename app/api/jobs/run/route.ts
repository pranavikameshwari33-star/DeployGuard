import { NextResponse } from "next/server";
import { getViewer, logErrorRef } from "@/lib/auth/session";
import { drainQueue } from "@/lib/jobs/runner";
import { queueStats, reclaimStuck, retryDead } from "@/lib/jobs/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/jobs/run   (Stage 2; Bearer DEPLOYGUARD_INTERNAL_TOKEN only)
 *
 * Drains the job queue for up to ~50 s and returns counts. Meant for a
 * frequent external scheduler (e.g. every minute) in addition to the drain
 * that runs after each webhook. Safe to call concurrently (SKIP LOCKED).
 *
 *   ?retryDead=<jobId>   puts one dead-lettered job back in the queue (operator action)
 */
export async function POST(request: Request) {
  const viewer = await getViewer();
  if (viewer?.kind !== "internal") return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const retry = new URL(request.url).searchParams.get("retryDead");
    if (retry) {
      if (!/^\d{1,19}$/.test(retry)) return NextResponse.json({ error: "retryDead must be a job id." }, { status: 400 });
      return NextResponse.json({ ok: await retryDead(retry), jobId: retry });
    }
    const reclaimed = await reclaimStuck();
    const drain = await drainQueue({ budgetMs: 50_000, maxJobs: 200 });
    return NextResponse.json({ ok: true, reclaimed, drain, queue: await queueStats() });
  } catch (error) {
    const errorRef = logErrorRef(`Queue run failed: ${(error as Error).message}`, "jobs");
    return NextResponse.json({ ok: false, error: "Queue run failed.", errorRef }, { status: 500 });
  }
}
