import { NextResponse } from "next/server";
import { verifyGithubSignature } from "@/lib/github/verify-signature";
import {
  handleInstallationEvent,
  handleInstallationRepositoriesEvent,
  resolveRepositoryForEvent,
} from "@/lib/github/app-events";
import { branchFromRef, parsePushEvent, type PushEvent } from "@/lib/github/parse-push-event";
import { recordPushEvent } from "@/lib/store/event-store";
import { ingestPush } from "@/lib/pipeline/ingest-push";
import { beginDelivery, finishDelivery, type DeliveryStatus } from "@/lib/db/webhook-deliveries";
import { rateLimitResponse } from "@/lib/auth/rate-limit";
import { redactPushEvent } from "@/lib/pipeline/ingest-push";
import { enqueue } from "@/lib/jobs/queue";
import { JOB_TYPES } from "@/lib/jobs/types";
import { kickQueue } from "@/lib/jobs/runner";
import { logErrorRef } from "@/lib/auth/session";

// node:crypto is not available on the Edge runtime, so pin this to Node.
export const runtime = "nodejs";
// Never cache a webhook: every delivery must actually run this code.
export const dynamic = "force-dynamic";

/**
 * POST /api/webhook/github
 *
 * GitHub push  ->  verify  ->  change analysis  ->  PostgreSQL (source of truth)
 *              ->  queued jobs: Hindsight memory, automatic risk analysis (Stage 2)
 *
 * Stage 2: the request does only the fast, durable part (signature, delivery
 * log, one INSERT) and answers. Everything slow -- Hindsight, Gemini, GitHub
 * API calls -- runs as jobs in the PostgreSQL queue (lib/jobs), with retries,
 * backoff and a dead-letter state.
 *
 * Phase 9: the same endpoint also receives the GitHub App's events, after the
 * same signature check: installation, installation_repositories (which
 * repositories are connected) and workflow_run (GitHub Actions -> the existing
 * lifecycle). A push delivered through the App is attached to its connected
 * repository; a plain repository-webhook push is still recorded, unowned.
 *
 * Phase 10: every delivery is recorded by GitHub's delivery GUID
 * (lib/db/webhook-deliveries.ts). A redelivery of something already processed
 * is answered as a duplicate and not processed again; deferred workflow_run
 * work keeps its payload until it has run, so the maintenance run can retry it.
 *
 * The stages fail differently on purpose, and the response always says
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
  // Stage 1: per-source rate limit, before any parsing or signature work.
  const limited = await rateLimitResponse(request, "webhook");
  if (limited) return limited;

  // ---------- stage 1: authenticity ----------
  const secret = process.env.GITHUB_WEBHOOK_SECRET;

  if (!secret) {
    console.error(
      "[DeployGuard] GITHUB_WEBHOOK_SECRET is not set. Add it to .env.local and restart the dev server."
    );
    return NextResponse.json(
      { ok: false, stage: "config", error: "Server is not configured." },
      { status: 500 }
    );
  }

  // Raw body. Do NOT use request.json() here -- the signature is computed over
  // these exact bytes.
  const rawBody = await request.text();

  const eventType = request.headers.get("x-github-event") ?? "unknown";
  const deliveryHeader = request.headers.get("x-github-delivery");
  const deliveryId = deliveryHeader ?? "local-test";
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

  // ---------- Phase 10: delivery log (idempotency + durability) ----------
  const meta = payload as { action?: string; installation?: { id?: number }; repository?: { id?: number } };
  let tracked = Boolean(deliveryHeader);
  if (tracked) {
    try {
      const begin = await beginDelivery({
        deliveryId,
        event: eventType,
        action: typeof meta.action === "string" ? meta.action : null,
        installationId: typeof meta.installation?.id === "number" ? meta.installation.id : null,
        githubRepositoryId: typeof meta.repository?.id === "number" ? meta.repository.id : null,
        // Only deferred work needs its payload kept until it has run.
        payload: eventType === "workflow_run" ? payload : undefined,
      });
      if (!begin.proceed) {
        console.log(`[DeployGuard] Delivery ${deliveryId} (${eventType}) already ${begin.status} - duplicate ignored.`);
        return NextResponse.json({ ok: true, duplicate: true, delivery: begin.status });
      }
    } catch (error) {
      // The log is a safety net, not a gate: process the event anyway.
      tracked = false;
      console.error(`[DeployGuard] Could not record delivery ${deliveryId}: ${(error as Error).message}`);
    }
  }
  const finish = (status: DeliveryStatus, error?: string) => {
    if (!tracked) return;
    finishDelivery(deliveryId, status, error).catch((e) =>
      console.error(`[DeployGuard] Could not update delivery ${deliveryId}: ${(e as Error).message}`)
    );
  };

  // ---------- Phase 9: GitHub App events (same endpoint, same signature check) ----------
  try {
    if (eventType === "installation") {
      const result = await handleInstallationEvent(payload as Parameters<typeof handleInstallationEvent>[0]);
      finish("processed");
      return NextResponse.json({ ok: true, event: eventType, result });
    }
    if (eventType === "installation_repositories") {
      const result = await handleInstallationRepositoriesEvent(
        payload as Parameters<typeof handleInstallationRepositoriesEvent>[0]
      );
      finish("processed");
      return NextResponse.json({ ok: true, event: eventType, result });
    }
  } catch (error) {
    const message = (error as Error).message;
    console.error(`[DeployGuard][github] Failed to process ${eventType} (delivery ${deliveryId}): ${message}`);
    finish("failed", message);
    return NextResponse.json({ ok: false, stage: "database", error: `Failed to process ${eventType}.` }, { status: 500 });
  }

  if (eventType === "workflow_run") {
    // Stage 2: needs GitHub API calls (all runs for the commit, failed job, log
    // tail) and may have to wait for the push, so it becomes a queued job. The
    // payload is in the delivery log; the job is keyed by the delivery GUID, so
    // a redelivery never queues it twice. Retries/backoff/dead-letter come from the queue.
    try {
      if (!tracked) throw new Error("delivery log unavailable");
      await enqueue(JOB_TYPES.workflowRun, { deliveryId }, { dedupeKey: `webhook:${deliveryId}`, maxAttempts: 8 });
    } catch (error) {
      const errorRef = logErrorRef(`Could not queue workflow_run ${deliveryId}: ${(error as Error).message}`, "jobs");
      return NextResponse.json({ ok: false, stage: "queue", error: "Could not queue the event.", errorRef }, { status: 500 });
    }
    kickQueue();
    return NextResponse.json({ ok: true, event: eventType, accepted: true, queued: true }, { status: 202 });
  }

  if (eventType !== "push") {
    console.log(`[DeployGuard] Ignoring unsupported event type: ${eventType}`);
    finish("ignored");
    return NextResponse.json({ ok: true, ignored: eventType });
  }

  const body = payload as { ref?: string; deleted?: boolean };

  // Tag pushes (refs/tags/...) are not deployments of a branch, so skip them.
  if (!branchFromRef(body.ref ?? "")) {
    console.log(`[DeployGuard] Ignoring non-branch ref: ${body.ref}`);
    finish("ignored");
    return NextResponse.json({ ok: true, ignored: "non-branch ref" });
  }

  // Deleting a branch also fires a push event, with no commits.
  if (body.deleted) {
    console.log(`[DeployGuard] Ignoring branch deletion: ${body.ref}`);
    finish("ignored");
    return NextResponse.json({ ok: true, ignored: "branch deleted" });
  }

  // Stage 1: commit message redacted before it is logged, kept in memory or stored.
  const event = redactPushEvent(parsePushEvent(payload, deliveryId));
  recordPushEvent(event); // in-memory receipt log, so /api/events works even if the DB is down
  logPushEvent(event);

  // ---------- stages 2-4: database, memory, automatic risk analysis ----------
  // Shared with missed-push recovery (lib/pipeline/ingest-push.ts). Local
  // verification scripts may opt out of automatic analysis with a header; it is
  // only honoured here, after the signature has been verified.
  const autoRisk = request.headers.get("x-deployguard-auto-risk") !== "off";
  let ingested;
  try {
    // Phase 9: which connected repository owns this push? A plain repository
    // webhook (no App installation) is recorded unowned, exactly as before.
    const owner = await resolveRepositoryForEvent(payload as Parameters<typeof resolveRepositoryForEvent>[0]);
    if (owner.kind === "not_monitored") {
      console.log(`[DeployGuard] Ignoring push to ${event.repositoryFullName}: ${owner.reason}.`);
      finish("ignored");
      return NextResponse.json({ ok: true, ignored: owner.reason });
    }
    ingested = await ingestPush(event, owner.kind === "owned" ? owner.repositoryId : null, { autoRisk, source: "push" });
  } catch (error) {
    const message = (error as Error).message;
    console.error(`[DeployGuard][db] Failed to store deployment for ${event.commitSha}: ${message}`);
    finish("failed", message);
    return NextResponse.json(
      {
        // The database message stays in the server log and the delivery log; GitHub
        // shows response bodies to repository admins, so it is not echoed here.
        ok: false,
        stage: "database",
        error: "Failed to store the deployment record.",
      },
      { status: 500 }
    );
  }

  finish("processed");
  const { deployment, isNew, memory } = ingested;

  if (!isNew) {
    return NextResponse.json({
      ok: true,
      stage: "database",
      duplicate: true,
      deploymentId: deployment.id,
      message: "This push was already recorded. No duplicate row and no duplicate memory were created.",
    });
  }

  return NextResponse.json({
    ok: true,
    stage: "database",
    riskAnalysis: autoRisk ? (ingested.riskScheduled ? "scheduled" : "not scheduled") : "skipped",
    duplicate: false,
    deploymentId: deployment.id,
    status: deployment.status,
    received: {
      repository: `${deployment.owner}/${deployment.repository}`,
      branch: deployment.branch,
      commitSha: deployment.commit_sha.slice(0, 7),
      changedFiles: deployment.changed_files.length,
      changeCategories: deployment.change_categories,
      affectedServices: deployment.affected_services,
    },
    // Stage 2: the Hindsight write is a queued job (retried with backoff).
    memory: memory?.queued ? { queued: true, jobId: memory.jobId } : { queued: false, note: "Deployment record is stored in the database; the memory job could not be queued (logged)." },
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
