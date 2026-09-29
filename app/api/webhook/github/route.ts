import { NextResponse } from "next/server";
import { verifyGithubSignature } from "@/lib/github/verify-signature";
import { branchFromRef, parsePushEvent, type PushEvent } from "@/lib/github/parse-push-event";
import { recordPushEvent } from "@/lib/store/event-store";
import { insertDeployment, type Deployment } from "@/lib/db/deployments";
import { buildDeploymentMemory } from "@/lib/hindsight/deployment-memory";
import { retain } from "@/lib/hindsight/client";

// node:crypto is not available on the Edge runtime, so pin this to Node.
export const runtime = "nodejs";
// Never cache a webhook: every delivery must actually run this code.
export const dynamic = "force-dynamic";

/**
 * POST /api/webhook/github
 *
 * GitHub push  ->  verify  ->  PostgreSQL (source of truth)  ->  Hindsight (agent memory)
 *
 * The three stages fail differently on purpose, and the response always says
 * which stage was reached:
 *
 *   signature  failed -> 401, nothing is stored anywhere.
 *   database   failed -> 500, so GitHub retries. The retry is safe because the
 *                        insert is idempotent.
 *   memory     failed -> 200. The deployment row already exists and must not be
 *                        lost or duplicated, so we report the failure in the
 *                        response body and the log rather than by rejecting the
 *                        delivery.
 */
export async function POST(request: Request) {
  // ---------- stage 1: authenticity ----------
  const secret = process.env.GITHUB_WEBHOOK_SECRET;

  if (!secret) {
    console.error(
      "[DeployGuard] GITHUB_WEBHOOK_SECRET is not set. Add it to .env.local and restart the dev server."
    );
    return NextResponse.json(
      { ok: false, stage: "config", error: "Server is not configured: GITHUB_WEBHOOK_SECRET is missing." },
      { status: 500 }
    );
  }

  // Raw body. Do NOT use request.json() here -- the signature is computed over
  // these exact bytes.
  const rawBody = await request.text();

  const eventType = request.headers.get("x-github-event") ?? "unknown";
  const deliveryId = request.headers.get("x-github-delivery") ?? "local-test";
  const signature = request.headers.get("x-hub-signature-256");

  if (!verifyGithubSignature(rawBody, signature, secret)) {
    console.warn(
      `[DeployGuard] REJECTED delivery ${deliveryId} (event: ${eventType}) - invalid or missing signature.`
    );
    return NextResponse.json(
      { ok: false, stage: "signature", error: "Invalid signature." },
      { status: 401 }
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { ok: false, stage: "payload", error: "Body is not valid JSON." },
      { status: 400 }
    );
  }

  // GitHub sends a one-off `ping` the moment you create the webhook. Answering
  // it with 200 is what turns the delivery green in the GitHub UI.
  if (eventType === "ping") {
    console.log(`[DeployGuard] Ping received (delivery ${deliveryId}). Webhook is wired up correctly.`);
    return NextResponse.json({ ok: true, message: "pong" });
  }

  if (eventType !== "push") {
    console.log(`[DeployGuard] Ignoring unsupported event type: ${eventType}`);
    return NextResponse.json({ ok: true, ignored: eventType });
  }

  const body = payload as { ref?: string; deleted?: boolean };

  // Tag pushes (refs/tags/...) are not deployments of a branch, so skip them.
  if (!branchFromRef(body.ref ?? "")) {
    console.log(`[DeployGuard] Ignoring non-branch ref: ${body.ref}`);
    return NextResponse.json({ ok: true, ignored: "non-branch ref" });
  }

  // Deleting a branch also fires a push event, with no commits.
  if (body.deleted) {
    console.log(`[DeployGuard] Ignoring branch deletion: ${body.ref}`);
    return NextResponse.json({ ok: true, ignored: "branch deleted" });
  }

  const event = parsePushEvent(payload, deliveryId);
  recordPushEvent(event); // in-memory receipt log, so /api/events works even if the DB is down
  logPushEvent(event);

  // ---------- stage 2: database (source of truth) ----------
  let deployment: Deployment;
  let isNew: boolean;
  try {
    ({ deployment, isNew } = await insertDeployment(event));
  } catch (error) {
    const message = (error as Error).message;
    console.error(`[DeployGuard][db] Failed to store deployment for ${event.commitSha}: ${message}`);
    return NextResponse.json(
      {
        ok: false,
        stage: "database",
        error: "Failed to store the deployment record.",
        detail: message,
      },
      { status: 500 }
    );
  }

  if (!isNew) {
    console.log(
      `[DeployGuard][db] Deployment #${deployment.id} already recorded for ${event.commitSha.slice(0, 7)} - duplicate delivery ignored.`
    );
    return NextResponse.json({
      ok: true,
      stage: "database",
      duplicate: true,
      deploymentId: deployment.id,
      message: "This push was already recorded. No duplicate row and no duplicate memory were created.",
    });
  }

  console.log(`[DeployGuard][db] Stored deployment #${deployment.id} with status ${deployment.status}.`);

  // ---------- stage 3: agent memory (best effort) ----------
  let memoryStored = false;
  let memoryError: string | undefined;
  try {
    await retain(buildDeploymentMemory(deployment));
    memoryStored = true;
    console.log(`[DeployGuard][memory] Stored deployment #${deployment.id} in Hindsight.`);
  } catch (error) {
    memoryError = (error as Error).message;
    console.error(
      `[DeployGuard][memory] Hindsight write FAILED for deployment #${deployment.id}: ${memoryError}\n` +
        `             The deployment IS safely stored in the database. Re-store it later with: curl -X POST http://localhost:3000/api/memory/backfill`
    );
  }

  return NextResponse.json({
    ok: true,
    stage: memoryStored ? "memory" : "database",
    duplicate: false,
    deploymentId: deployment.id,
    status: deployment.status,
    received: {
      repository: `${deployment.owner}/${deployment.repository}`,
      branch: deployment.branch,
      commitSha: deployment.commit_sha.slice(0, 7),
      changedFiles: deployment.changed_files.length,
    },
    memory: memoryStored
      ? { stored: true }
      : { stored: false, error: memoryError, note: "Deployment record is stored in the database." },
  });
}

/**
 * Opening the webhook URL in a browser sends a GET, which would otherwise
 * return a confusing 405. This makes the mistake self-explaining.
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    message:
      "DeployGuard GitHub webhook endpoint. GitHub delivers push events here via POST. Visit /api/deployments to see stored deployments.",
  });
}

/** Human-readable summary in the terminal, so you can see the push land. */
function logPushEvent(event: PushEvent): void {
  const lines = [
    "",
    "==================== DeployGuard: PUSH RECEIVED ====================",
    `Repository : ${event.owner}/${event.repository}`,
    `Branch     : ${event.branch}`,
    `Commit     : ${event.commitSha.slice(0, 7)}  (${event.commitCount} commit(s) in this push)`,
    `Message    : ${event.commitMessage.split("\n")[0]}`,
    `Author     : ${event.author} <${event.authorEmail}>`,
    `Timestamp  : ${event.timestamp}`,
    `Added      : ${format(event.addedFiles)}`,
    `Modified   : ${format(event.modifiedFiles)}`,
    `Deleted    : ${format(event.deletedFiles)}`,
    `Total files: ${event.changedFiles.length}`,
    "====================================================================",
    "",
  ];
  console.log(lines.join("\n"));
}

function format(files: string[]): string {
  return files.length ? files.join(", ") : "(none)";
}
