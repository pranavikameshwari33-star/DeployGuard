import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import {
  updateDeploymentStatus,
  type DeploymentKey,
  type PipelineStatus,
  type StatusUpdate,
} from "@/lib/db/deployments";
import { buildDeploymentMemory } from "@/lib/hindsight/deployment-memory";
import { retain } from "@/lib/hindsight/client";

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
 *   memory      -> 200. The status is already saved in the database; a
 *                  Hindsight outage must not undo or hide that.
 */
export async function POST(request: Request) {
  // ---------- stage 1: authenticity ----------
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

  // ---------- stage 3: database (source of truth) ----------
  let result;
  try {
    result = await updateDeploymentStatus(key, update);
  } catch (error) {
    const message = (error as Error).message;
    console.error(`[DeployGuard][db] Failed to update status for ${label}: ${message}`);
    return NextResponse.json(
      { ok: false, stage: "database", error: "Failed to update the deployment record.", detail: message },
      { status: 500 }
    );
  }

  if (result.outcome === "not_found") {
    console.warn(`[DeployGuard][ci] No deployment for ${label} (status ${update.status} not applied).`);
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
    console.warn(
      `[DeployGuard][ci] Refused ${result.currentStatus} -> ${update.status} for ${label}.`
    );
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

  const { deployment, previousStatus } = result;
  console.log(
    `[DeployGuard][ci] Deployment #${deployment.id} ${label}: ${previousStatus} -> ${deployment.status}` +
      (deployment.failure_stage ? ` (failed stage: ${deployment.failure_stage})` : "")
  );

  // ---------- stage 4: agent memory (best effort, final results only) ----------
  // BUILDING is a passing moment and is not worth remembering. The final result
  // REPLACES the memory the webhook wrote (same document_id), so each deployment
  // stays one memory.
  let memory: { stored: boolean; error?: string } | { skipped: string } = {
    skipped: "Only final results (SUCCESS / FAILED) are written to Hindsight.",
  };

  if (deployment.status === "SUCCESS" || deployment.status === "FAILED") {
    try {
      await retain(buildDeploymentMemory(deployment));
      memory = { stored: true };
      console.log(`[DeployGuard][memory] Updated deployment #${deployment.id} in Hindsight (${deployment.status}).`);
    } catch (error) {
      memory = { stored: false, error: (error as Error).message };
      console.error(
        `[DeployGuard][memory] Hindsight write FAILED for deployment #${deployment.id}: ${memory.error}\n` +
          `             The ${deployment.status} status IS saved in the database. Re-store it later with: curl -X POST http://localhost:3000/api/memory/backfill`
      );
    }
  }

  return NextResponse.json({
    ok: true,
    stage: "database",
    deploymentId: deployment.id,
    previousStatus,
    status: deployment.status,
    failure: deployment.failure_stage
      ? { stage: deployment.failure_stage, job: deployment.failure_job }
      : undefined,
    memory,
  });
}

/**
 * Compares the bearer token in constant time. Both sides are hashed first so
 * they are always the same length, which timingSafeEqual requires, without
 * revealing the real token's length.
 */
function isAuthorized(header: string | null, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const received = header.slice("Bearer ".length).trim();
  const digest = (value: string) => crypto.createHash("sha256").update(value, "utf8").digest();
  return crypto.timingSafeEqual(digest(received), digest(expected));
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
