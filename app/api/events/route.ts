import { NextResponse } from "next/server";
import { listPushEvents } from "@/lib/store/event-store";
import { getViewer } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/events
 *
 * Verification endpoint for Phase 1: returns the push events this server has
 * received since it started, newest first. The log is not split by owner, so
 * since Phase 9 it is internal tooling only (Bearer DEPLOYGUARD_STATUS_TOKEN).
 */
export async function GET() {
  const viewer = await getViewer();
  if (viewer?.kind !== "internal") {
    return NextResponse.json({ error: "Internal tooling only (Bearer DEPLOYGUARD_STATUS_TOKEN)." }, { status: 401 });
  }
  const events = listPushEvents();
  return NextResponse.json({ count: events.length, events });
}
