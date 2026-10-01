import { NextResponse } from "next/server";
import { recall } from "@/lib/hindsight/client";
import { errorDetail, getViewer } from "@/lib/auth/session";
import { getPool } from "@/lib/db/client";
import { redactText } from "@/lib/security/redact";
import { rateLimitResponse } from "@/lib/auth/rate-limit";

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
 * DEPLOYGUARD_INTERNAL_TOKEN) is scoped to every repository DeployGuard knows.
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

  // Stage 1: the scope is always a list of GitHub repository ids; the client
  // turns it into ghrepo: tags with any_strict and re-checks every result.
  let githubRepositoryIds: string[];
  if (viewer.kind === "user") {
    const limited = await rateLimitResponse(request, "memoryRecall", `user:${viewer.user.id}`);
    if (limited) return limited;
    githubRepositoryIds = viewer.repositories.map((r) => r.github_repository_id);
  } else {
    // Internal tooling: every repository DeployGuard knows. A deployment:<id> or
    // commit:<sha> filter is first resolved to that deployment's own repository,
    // so a narrowed recall stays a single-tenant query.
    const deploymentIds = tags.flatMap((t) => (/^deployment:\d{1,19}$/.test(t) ? [t.slice(11)] : []));
    const shas = tags.flatMap((t) => (/^commit:[0-9a-f]{7,40}$/i.test(t) ? [t.slice(7).toLowerCase()] : []));
    const known =
      deploymentIds.length || shas.length
        ? await getPool().query<{ id: string }>(
            `SELECT DISTINCT github_repository_id::text AS id FROM deployments
             WHERE github_repository_id IS NOT NULL
               AND (id = ANY($1::bigint[]) OR left(commit_sha, 7) = ANY($2::text[]))`,
            [deploymentIds, shas.map((s) => s.slice(0, 7))]
          )
        : await getPool().query<{ id: string }>(
            `SELECT github_repository_id::text AS id FROM repositories
             UNION SELECT DISTINCT github_repository_id::text FROM deployments WHERE github_repository_id IS NOT NULL`
          );
    githubRepositoryIds = known.rows.map((r) => r.id);
  }
  if (githubRepositoryIds.length === 0) return NextResponse.json({ query, count: 0, memories: [] });

  try {
    const { results } = await recall(query, { githubRepositoryIds, narrowTags: tags });
    const visible = results;
    return NextResponse.json({
      query,
      ...(tags.length ? { tags } : {}),
      count: visible.length,
      memories: visible.map((result) => ({
        // Recalled memory is shown to people, labelled as such; redacted again in
        // case it was retained before Stage 1.
        text: redactText(result.text),
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
