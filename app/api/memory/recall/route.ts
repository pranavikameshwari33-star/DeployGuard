import { NextResponse } from "next/server";
import { recall } from "@/lib/hindsight/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/memory/recall?q=...
 *
 * Verification endpoint: asks Hindsight what it remembers, in plain English.
 * Try: /api/memory/recall?q=have we changed the database config before
 *
 * The Hindsight API key stays on the server. This route sends only the query
 * and returns only the recalled text -- the browser never sees a credential.
 *
 * Phase 6 will replace ad-hoc queries like this with targeted similarity
 * lookups; for now it exists so you can see that the memory really landed.
 */
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q");

  if (!query) {
    return NextResponse.json(
      { error: "Add a query, e.g. /api/memory/recall?q=database config change" },
      { status: 400 }
    );
  }

  try {
    const { results } = await recall(query);
    return NextResponse.json({
      query,
      count: results?.length ?? 0,
      memories: (results ?? []).map((result) => ({
        text: result.text,
        tags: result.tags,
        deploymentId: result.metadata?.deployment_id,
        commitSha: result.metadata?.commit_sha,
        repository: result.metadata?.repository_full_name,
        status: result.metadata?.status,
      })),
    });
  } catch (error) {
    const message = (error as Error).message;
    console.error(`[DeployGuard][memory] Recall failed: ${message}`);
    return NextResponse.json(
      { error: "Could not recall from Hindsight.", detail: message },
      { status: 502 }
    );
  }
}
