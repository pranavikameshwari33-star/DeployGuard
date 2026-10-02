import { NextResponse } from "next/server";
import { canAccessDeployment, errorDetail, getViewer } from "@/lib/auth/session";
import { finishRiskAnalysis, getDeploymentById, tryStartRiskAnalysis } from "@/lib/db/deployments";
import { rateLimitResponse } from "@/lib/auth/rate-limit";
import { checkSameOrigin } from "@/lib/auth/csrf";
import { getLatestAssessment } from "@/lib/db/risk-assessments";
import { analyzeDeploymentRisk } from "@/lib/risk/analyze-risk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Phase 7: AI deployment risk analysis.
 *
 * POST /api/deployments/risk?id=<deploymentId>[&refresh=1]
 *   Authorization: Bearer <DEPLOYGUARD_INTERNAL_TOKEN>  -- or the owner's signed-in session (Phase 9)
 *   A session-authenticated call must come from DeployGuard's own origin (Stage 1 CSRF check).
 *   Gathers the evidence (Phase 5 + Phase 6), asks Gemini, validates, stores.
 *   Reuses the stored assessment when the facts have not changed; refresh=1
 *   forces a new Gemini call. Protected because each call can cost Gemini
 *   quota and this server is reachable from the internet (ngrok).
 *
 * GET /api/deployments/risk?id=<deploymentId>
 *   The latest stored assessment. Read-only, never calls Gemini.
 *
 * A Gemini outage or an invalid answer gives 502/503 with status
 * "unavailable" -- never a made-up risk level.
 */
export async function POST(request: Request) {
  // Internal tooling (Bearer DEPLOYGUARD_INTERNAL_TOKEN) or, since Phase 9, the
  // signed-in owner of the deployment. Anyone else gets 401 / 404.
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const id = params.get("id") ?? "";
  if (!/^\d{1,19}$/.test(id)) {
    return NextResponse.json({ ok: false, error: "Add a numeric deployment id: ?id=12" }, { status: 400 });
  }
  if (viewer.kind === "user") {
    const csrf = checkSameOrigin(request);
    if (!csrf.ok) {
      console.warn(`[DeployGuard][csrf] Rejected risk analysis request: ${csrf.reason}.`);
      return NextResponse.json({ ok: false, error: "Request rejected." }, { status: 403 });
    }
    const deployment = await getDeploymentById(id);
    if (!deployment || !canAccessDeployment(viewer, deployment)) {
      return NextResponse.json({ ok: false, error: `No deployment #${id}.` }, { status: 404 });
    }
    // Stage 1: any analysis request may call Gemini; limit it per user.
    const limitedAll = await rateLimitResponse(request, "riskAnalyze", `user:${viewer.user.id}`);
    if (limitedAll) return limitedAll;
  }

  // Stage 2: a user's Re-analyze is controlled.
  //  - It never forces a new Gemini call: the same evidence returns the stored
  //    assessment, so it only reaches Gemini when the result is stale or missing.
  //  - An in-flight lock stops a second request while one is running (409).
  //  - The per-repository usage caps apply (429 when reached).
  // Internal tooling may still force a refresh (?refresh=1).
  let attempt: string | null = null;
  if (viewer.kind === "user") {
    attempt = await tryStartRiskAnalysis(id);
    if (!attempt) {
      return NextResponse.json({ ok: false, error: "An analysis for this deployment is already running." }, { status: 409 });
    }
  }

  try {
    const result = await analyzeDeploymentRisk(id, { refresh: viewer.kind === "internal" && params.get("refresh") === "1" });
    if (attempt) {
      await finishRiskAnalysis(
        id,
        attempt,
        result.status === "assessed" ? { status: "completed" } : { status: "unavailable", error: result.status === "unavailable" ? result.message : "not found" }
      );
    }

    if (result.status === "not_found") {
      return NextResponse.json({ ok: false, error: `No deployment #${id}.` }, { status: 404 });
    }
    if (result.status === "unavailable") {
      // 503 when Gemini itself failed, 502 when it answered but the answer was invalid.
      return NextResponse.json(
        { ok: false, ...result, riskAssessment: null },
        { status: result.reason === "usage_limit" ? 429 : result.reason === "gemini_error" ? 503 : 502 }
      );
    }
    return NextResponse.json({
      ok: true,
      status: result.status,
      source: result.source,
      riskAssessment: result.assessment,
      memory: result.memory,
    });
  } catch (error) {
    const message = (error as Error).message;
    if (attempt) await finishRiskAnalysis(id, attempt, { status: "unavailable", error: "Risk analysis failed." }).catch(() => {});
    console.error(`[DeployGuard][risk] Risk analysis failed for deployment #${id}: ${message}`);
    return NextResponse.json(
      { ok: false, error: "Risk analysis failed.", ...errorDetail(viewer, message) },
      { status: 500 }
    );
  }
}

export async function GET(request: Request) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!/^\d{1,19}$/.test(id)) {
    return NextResponse.json({ error: "Add a numeric deployment id: ?id=12" }, { status: 400 });
  }
  if (viewer.kind === "user") {
    const deployment = await getDeploymentById(id);
    if (!deployment || !canAccessDeployment(viewer, deployment)) {
      return NextResponse.json({ error: `No deployment #${id}.` }, { status: 404 });
    }
  }
  try {
    const assessment = await getLatestAssessment(id);
    return NextResponse.json({ deploymentId: id, riskAssessment: assessment });
  } catch (error) {
    return NextResponse.json(
      { error: "Could not read the risk assessment.", ...errorDetail(viewer, (error as Error).message) },
      { status: 500 }
    );
  }
}
