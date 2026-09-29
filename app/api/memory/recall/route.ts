import { NextResponse } from "next/server";
import { recall } from "@/lib/hindsight/client";
import { errorDetail, getViewer } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/memory/recall?q=...
 *
 * Verification endpoint: asks Hindsight what it remembers, in plain English.
 * Try: /api/memory/recall?q=have we changed the database config before
 * Incidents only (Phase 4): /api/memory/recall?q=database timeout&tags=incident
 *
 * The Hindsight API key stays on the server. This route sends only the query
 * and returns only the recalled text -- the browser never sees a credential.
 *
 * Phase 9 isolation: for a signed-in user the Hindsight query itself is
 * restricted to the ghrepo:<id> tags of THEIR repositories (any_strict), so
 * another user's memories cannot be returned. Extra `tags` then narrow that
 * result further; they can never widen it. Internal tooling (Bearer
 * DEPLOYGUARD_STATUS_TOKEN) keeps the unrestricted behaviour.
 */
export async function GET(request: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const query = params.get("q");
  const tags = (params.get("tags") ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);

  if (!query) {
    return NextResponse.json(
      { error: "Add a query, e.g. /api/memory/recall?q=database config change" },
      { status: 400 }
    );
  }

  let scopeTags: string[] | null = null;
  if (viewer.kind === "user") {
    scopeTags = viewer.repositories.map((r) => `ghrepo:${r.github_repository_id}`);
    if (scopeTags.length === 0) return NextResponse.json({ query, count: 0, memories: [] });
  }

  try {
    const { results } = await recall(
      query,
      scopeTags
        ? { tags: scopeTags, tagsMatch: "any_strict" }
        : tags.length
          ? { tags, tagsMatch: "any_strict" }
          : {}
    );
    const visible = (results ?? []).filter(
      (result) => !scopeTags || !tags.length || tags.some((tag) => result.tags?.includes(tag))
    );
    return NextResponse.json({
      query,
      ...(tags.length ? { tags } : {}),
      count: visible.length,
      memories: visible.map((result) => ({
        text: result.text,
        tags: result.tags,
        kind: result.metadata?.kind,
        incidentId: result.metadata?.incident_id,
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
      { error: "Could not recall from Hindsight.", ...errorDetail(viewer, message) },
      { status: 502 }
    );
  }
}
