import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/repositories  (Phase 10)
 *
 * The signed-in user's repositories (from their own installations only), with
 * whether each is currently monitored. The list is resolved server-side from
 * the session; nothing in the request can widen it. Other users' repositories
 * and installation internals are never included.
 */
export async function GET() {
  const viewer = await getViewer();
  if (viewer?.kind !== "user") return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  return NextResponse.json({
    count: viewer.repositories.length,
    repositories: viewer.repositories.map((r) => ({
      id: r.id,
      fullName: r.full_name,
      private: r.private,
      defaultBranch: r.default_branch,
      monitoring: r.monitoring,
      installationStatus: r.installation_status,
    })),
  });
}
