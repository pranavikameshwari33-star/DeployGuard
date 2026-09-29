import { NextResponse } from "next/server";
import { listPushEvents } from "@/lib/store/event-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/events
 *
 * Verification endpoint for Phase 1: returns the push events this server has
 * received since it started, newest first. Open it in a browser after you push
 * and you should see your commit.
 */
export async function GET() {
  const events = listPushEvents();
  return NextResponse.json({ count: events.length, events });
}
