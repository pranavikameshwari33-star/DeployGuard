import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { isAuthorized } from "@/lib/auth/bearer-token";
import type { DeploymentKey, PipelineStatus, StatusUpdate } from "@/lib/db/deployments";
import { applyPipelineStatus } from "@/lib/pipeline/apply-status";
import { logErrorRef } from "@/lib/auth/session";
import { rateLimitResponse } from "@/lib/auth/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/deployments/status
 *
 * Called by the GitHub Actions workflow (.github/workflows/deployguard-ci.yml)
 * to move an EXISTING deployment through its lifecycle:
 *
 *   RECEIVED (webhook)  ->  BUILDING  ->  SUCCESS | FAILED
 *
 * Request:
 *   Authorization: Bearer <DEPLOYGUARD_STATUS_TOKEN>
 *   {
 *     "repository": "owner/name",
 *     "branch": "main",
 *     "commitSha": "<40-char sha>",
 *     "status": "BUILDING" | "SUCCESS" | "FAILED",
 *     "runId": "123456789",                       (optional)
 *     "runUrl": "https://github.com/.../runs/1",  (optional)
 *     "failure": { "stage": "test", "job": "...", "message": "..." }   (FAILED only)
 *   }
 *
 * Stages, like the webhook, fail differently on purpose:
 *   auth        -> 401, nothing changes.
 *   validation  -> 400, nothing changes.
 *   database    -> 404 no such deployment, 409 status move not allowed,
 *                  500 database error.
 *   incident    -> FAILED only (Phase 4): one incident row per deployment.
 *                  500 if it cannot be written, so the pipeline retries.
 *   memory      -> 200. The status is already saved in the database; a
 *                  Hindsight outage must not undo or hide that.
 */
export async function POST(request: Request) {
  const limited = await rateLimitResponse(request, "ciStatus");
  if (limited) return limited;

  // ---------- stage 1: authenticity ----------
  // Stage 1: ONLY the CI status token is accepted here. The internal
  // maintenance token is rejected (it simply does not match).
  let expectedToken: string;
  try {
    expectedToken = env.deployguardStatusToken();
  } catch (error) {
    console.error(`[DeployGuard][ci] ${(error as Error).message}`);
    return NextResponse.json(
      { ok: false, stage: "config", error: "Server is not configured: DEPLOYGUARD_STATUS_TOKEN is missing." },
      { status: 500 }
    );
  }

  if (!isAuthorized(request.headers.get("authorization"), expectedToken)) {
    console.warn("[DeployGuard][ci] REJECTED status update - missing or wrong token.");
    return NextResponse.json(
      { ok: false, stage: "auth", error: "Unauthorized." },
      { status: 401 }
    );
  }

  // ---------- stage 2: validation ----------
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, stage: "validation", error: "Body is not valid JSON." },
      { status: 400 }
    );
  }

  const parsed = parseStatusRequest(body);
  if ("error" in parsed) {
    return NextResponse.json(
      { ok: false, stage: "validation", error: parsed.error },
      { status: 400 }
    );
  }
  const { key, update } = parsed;
  const label = `${key.owner}/${key.repository}@${key.branch} ${key.commitSha.slice(0, 7)}`;

  // ---------- stages 3-6: status, incident, memory, risk refresh ----------
  // Shared with the GitHub App's workflow_run handling (lib/pipeline/apply-status.ts).
  let result;
  try {
    result = await applyPipelineStatus(key, update, "ci");
  } catch (error) {
    // Stage 1: the database message stays in the server log. This response is
    // printed in GitHub Actions logs, which can be public.
    const errorRef = logErrorRef(`Failed to update status for ${label}: ${(error as Error).message}`, "db");
    return NextResponse.json(
      { ok: false, stage: "database", error: "Failed to update the deployment record.", errorRef },
      { status: 500 }
    );
  }

  if (result.outcome === "not_found") {
    return NextResponse.json(
      {
        ok: false,
        stage: "database",
        error:
          "No deployment record matches this repository, branch and commit. The push webhook " +
          "creates it; check that the webhook delivery for this push succeeded.",
      },
      { status: 404 }
    );
  }

  if (result.outcome === "invalid_transition") {
    return NextResponse.json(
      {
        ok: false,
        stage: "database",
        error: `Cannot move a deployment from ${result.currentStatus} to ${update.status}.`,
        currentStatus: result.currentStatus,
      },
      { status: 409 }
    );
  }

  // A database error on the incident returns 500 so the pipeline retries; the
  // retry is safe because FAILED -> FAILED is allowed and the incident write is idempotent.
  if (result.outcome === "incident_error") {
    return NextResponse.json(
      {
        ok: false,
        stage: "incident",
        error: "The FAILED status was saved, but the incident record could not be written.",
        errorRef: logErrorRef(result.message, "incident"),
        deploymentId: result.deployment.id,
      },
      { status: 500 }
    );
  }

  const { deployment, previousStatus, incident, incidentMemory, memory } = result;
  return NextResponse.json({
    ok: true,
    stage: "database",
    riskAnalysis: result.riskRefreshScheduled ? "refresh scheduled" : "not scheduled",
    deploymentId: deployment.id,
    previousStatus,
    status: deployment.status,
    failure: deployment.failure_stage
      ? { stage: deployment.failure_stage, job: deployment.failure_job }
      : undefined,
    incident: incident
      ? {
          id: incident.incident.id,
          created: incident.isNew,
          failureType: incident.incident.failure_type,
          memory: incidentMemory ? { stored: incidentMemory.stored } : undefined,
        }
      : undefined,
    memory: "skipped" in memory ? memory : { stored: memory.stored },
  });
}

const PIPELINE_STATUSES: PipelineStatus[] = ["BUILDING", "SUCCESS", "FAILED"];
const MAX_FAILURE_MESSAGE = 4000;

type ParsedRequest = { key: DeploymentKey; update: StatusUpdate } | { error: string };

/** Checks the body field by field and returns a clear message for the first problem. */
function parseStatusRequest(body: unknown): ParsedRequest {
  if (!body || typeof body !== "object") return { error: "Body must be a JSON object." };
  const b = body as Record<string, unknown>;

  const repository = text(b.repository);
  const [owner, name, ...rest] = repository.split("/");
  if (!owner || !name || rest.length) {
    return { error: 'repository must look like "owner/name".' };
  }

  const branch = text(b.branch);
  if (!branch) return { error: "branch is required." };

  const commitSha = text(b.commitSha).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commitSha)) {
    return { error: "commitSha must be a full 40-character commit SHA." };
  }

  const status = text(b.status).toUpperCase() as PipelineStatus;
  if (!PIPELINE_STATUSES.includes(status)) {
    return { error: `status must be one of ${PIPELINE_STATUSES.join(", ")}.` };
  }

  const runId = text(b.runId);
  if (runId && !/^\d{1,20}$/.test(runId)) return { error: "runId must be numeric." };

  const runUrl = text(b.runUrl);
  if (runUrl && !runUrl.startsWith("https://github.com/")) {
    return { error: "runUrl must be a https://github.com/ link." };
  }

  const update: StatusUpdate = {
    status,
    ciRunId: runId || undefined,
    ciRunUrl: runUrl || undefined,
  };

  if (status === "FAILED") {
    const failure = (b.failure ?? {}) as Record<string, unknown>;
    const message = text(failure.message);
    update.failure = {
      stage: text(failure.stage).slice(0, 50) || "unknown",
      job: text(failure.job).slice(0, 200) || undefined,
      // Keep the END of long output: that is where a failing command reports its error.
      message: message ? message.slice(-MAX_FAILURE_MESSAGE) : undefined,
    };
  }

  return { key: { owner, repository: name, branch, commitSha }, update };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
