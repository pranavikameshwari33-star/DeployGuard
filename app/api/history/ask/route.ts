import { NextResponse } from "next/server";
import { getViewer, logErrorRef, scopeOf } from "@/lib/auth/session";
import { getPool } from "@/lib/db/client";
import { askHistory } from "@/lib/learning/ask-history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/history/ask?q=<question>[&repo=<GitHub repository id>]   (Stage 4.6)
 *
 * Answers a question about the caller's OWN deployment and incident history
 * from database records, one linked statement per record. Unrelated questions
 * are refused. Scope: a signed-in user's repositories (optionally narrowed to
 * one of them with ?repo=), enforced in the SQL and in the Hindsight query.
 * A foreign ?repo= narrows to nothing. Internal tooling sees every repository.
 */
export async function GET(request: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ ok: false, error: "Sign in required." }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const question = params.get("q") ?? "";
  const repo = params.get("repo");
  if (repo !== null && !/^\d{1,19}$/.test(repo)) return NextResponse.json({ ok: false, error: "repo must be a numeric id." }, { status: 400 });

  let githubRepositoryIds: string[];
  if (viewer.kind === "user") {
    const own = viewer.repositories.map((r) => String(r.github_repository_id));
    githubRepositoryIds = repo ? own.filter((id) => id === repo) : own;
  } else {
    const { rows } = await getPool().query<{ id: string }>(
      `SELECT DISTINCT github_repository_id::text AS id FROM deployments WHERE github_repository_id IS NOT NULL`
    );
    githubRepositoryIds = repo ? rows.map((r) => r.id).filter((id) => id === repo) : rows.map((r) => r.id);
  }

  try {
    const result = await askHistory({
      question,
      scope: { scope: scopeOf(viewer), githubRepositoryId: repo },
      githubRepositoryIds,
      actorKey: viewer.kind === "user" ? `user:${viewer.user.id}` : "internal",
    });
    if (result.state === "rate_limited") return NextResponse.json({ ok: false, ...result }, { status: 429 });
    if (result.state === "refused") return NextResponse.json({ ok: false, ...result }, { status: 422 });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const errorRef = logErrorRef(`Ask-history failed: ${(error as Error).message}`, "ask");
    return NextResponse.json({ ok: false, error: "The question could not be answered.", errorRef }, { status: 500 });
  }
}
