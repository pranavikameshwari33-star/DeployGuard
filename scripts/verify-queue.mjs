/**
 * Stage 2: durable processing, idempotency, ordering and cost control.
 * Run with migration 010 applied and the dev server up:
 *
 *   npm run verify:queue
 *
 *   1  unit: backoff and multi-workflow aggregation (tests/queue-logic.test.mjs)
 *   2  the REAL queue code (lib/jobs/queue.ts) against PostgreSQL:
 *      dedupe, concurrent SKIP LOCKED claims, retry + backoff, dead-letter,
 *      immediate dead-letter for permanent errors, stuck-job reclaim, retry of a dead job
 *   3  live webhook: a workflow_run redelivery (same GUID) creates ONE job;
 *      a push redelivery creates ONE deployment; repeated CI reports keep one incident
 *   4  ordering (lib/db/deployments.ts): a late "in progress" never overwrites
 *      SUCCESS; a genuine re-run (newer event) still can
 *   5  Gemini cost control: daily and monthly caps refuse and count; the
 *      Re-analyze in-flight lock admits one request; reading the dashboard and
 *      the stored risk makes NO Gemini call
 *
 * Test jobs use their own type (verify.queue.<random>) and are deleted after.
 */
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { loadEnv } from "./load-env.mjs";
import { internalFetch } from "./internal-fetch.mjs";
import { buildPushPayload, signBody, testRepositoryId } from "./test-payload.mjs";
import { waitForJob } from "./job-helpers.mjs";

loadEnv();
const BASE = process.env.APP_URL || "http://localhost:3000";
const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
const statusToken = process.env.DEPLOYGUARD_STATUS_TOKEN;

let failures = 0;
const check = (ok, step, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${step}${detail ? " -- " + detail : ""}`);
};

const queue = await import("@/lib/jobs/queue");
const { updateDeploymentStatus, tryStartRiskAnalysis, finishRiskAnalysis } = await import("@/lib/db/deployments");
const { reserveGeminiCall } = await import("@/lib/risk/usage");
const { getPool } = await import("@/lib/db/client");
const db = getPool();
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(process.env.DATABASE_URL ?? "") ? undefined : { rejectUnauthorized: false },
});
await client.connect();

const RUN = crypto.randomBytes(4).toString("hex");
const TYPE = `verify.queue.${RUN}`;
const REPO = `queue-${RUN}`;

console.log("DeployGuard Stage 2: queue, idempotency, ordering, cost control\n");

// --- 1. unit --------------------------------------------------------------------------
const unit = spawnSync(process.execPath, ["--experimental-strip-types", "--test", "tests/queue-logic.test.mjs"], { encoding: "utf8" });
check(unit.status === 0, "unit: backoff + workflow aggregation", `${/# pass (\d+)/.exec(unit.stdout)?.[1]} passed, ${/# fail (\d+)/.exec(unit.stdout)?.[1]} failed`);

try {
  // --- 2. queue mechanics -------------------------------------------------------------
  console.log("\n2. Queue mechanics (real lib/jobs/queue.ts)");
  const a = await queue.enqueue(TYPE, { n: 1 }, { dedupeKey: `${TYPE}:dup` });
  const b = await queue.enqueue(TYPE, { n: 1 }, { dedupeKey: `${TYPE}:dup` });
  check(a.created && !b.created && a.id === b.id, "enqueue with the same dedupe key is a no-op (same job)");

  for (let i = 0; i < 10; i++) await queue.enqueue(TYPE, { n: i }, { dedupeKey: `${TYPE}:c${i}` });
  const [w1, w2] = await Promise.all([queue.claim(11, "worker-A", [TYPE]), queue.claim(11, "worker-B", [TYPE])]);
  const ids1 = new Set(w1.map((j) => j.id));
  const overlap = w2.filter((j) => ids1.has(j.id)).length;
  check(w1.length + w2.length === 11 && overlap === 0, "two concurrent workers never take the same job (SKIP LOCKED)", `A=${w1.length}, B=${w2.length}, overlap=${overlap}`);
  for (const j of [...w1, ...w2]) await queue.complete(j.id);

  // Real contention: another connection holds row locks on 5 ready jobs inside an
  // open transaction (a worker mid-claim). claim() must skip them, not wait.
  const held = [];
  for (let i = 0; i < 8; i++) held.push((await queue.enqueue(TYPE, { n: i }, { dedupeKey: `${TYPE}:h${i}` })).id);
  await client.query("BEGIN");
  await client.query(`SELECT id FROM jobs WHERE id = ANY($1::bigint[]) ORDER BY id LIMIT 5 FOR UPDATE`, [held]);
  const started = Date.now();
  const skipped = await queue.claim(20, "worker-C", [TYPE]);
  const waited = Date.now() - started;
  await client.query("ROLLBACK");
  const lockedIds = new Set(held.slice(0, 5));
  check(skipped.length === 3 && skipped.every((j) => !lockedIds.has(j.id)) && waited < 3000,
    "jobs locked by another worker are SKIPPED without blocking", `claimed ${skipped.length} of 8 (5 locked elsewhere) in ${waited} ms`);
  for (const j of skipped) await queue.complete(j.id);
  for (const j of await queue.claim(20, "worker-C", [TYPE])) await queue.complete(j.id);

  const fakeToken = "ghp" + "_" + "Ab12".repeat(9);
  const r1 = await queue.enqueue(TYPE, {}, { dedupeKey: `${TYPE}:retry`, maxAttempts: 2 });
  let [job] = await queue.claim(1, "worker-A", [TYPE]);
  let status = await queue.fail(job, `boom with ${fakeToken}`);
  let row = (await db.query(`SELECT status, attempts, run_at > now() AS later, last_error FROM jobs WHERE id = $1`, [r1.id])).rows[0];
  check(status === "queued" && row.later && row.attempts === 1, "a failed attempt is retried later (backoff)", `attempts=${row.attempts}`);
  check(!row.last_error.includes(fakeToken) && row.last_error.includes("[REDACTED"), "stored job errors are redacted");
  await db.query(`UPDATE jobs SET run_at = now() WHERE id = $1`, [r1.id]);
  [job] = await queue.claim(1, "worker-A", [TYPE]);
  status = await queue.fail(job, "boom again");
  row = (await db.query(`SELECT status, attempts FROM jobs WHERE id = $1`, [r1.id])).rows[0];
  check(status === "dead" && row.status === "dead" && row.attempts === 2, "after max attempts the job is dead-lettered (kept, visible)");
  check(await queue.retryDead(r1.id), "an operator can put a dead job back in the queue");

  const p = await queue.enqueue(TYPE, {}, { dedupeKey: `${TYPE}:perm` });
  [job] = await queue.claim(1, "worker-A", [TYPE]);
  while (job && job.id !== p.id) { await queue.complete(job.id); [job] = await queue.claim(1, "worker-A", [TYPE]); }
  status = await queue.fail(job, "bad payload", false);
  check(status === "dead", "a permanent error dead-letters at once");

  const s = await queue.enqueue(TYPE, {}, { dedupeKey: `${TYPE}:stuck`, maxAttempts: 3 });
  [job] = await queue.claim(1, "worker-dies", [TYPE]);
  while (job && job.id !== s.id) { await queue.complete(job.id); [job] = await queue.claim(1, "worker-dies", [TYPE]); }
  await db.query(`UPDATE jobs SET locked_at = now() - interval '10 minutes' WHERE id = $1`, [s.id]);
  const reclaimed = await queue.reclaimStuck(300);
  row = (await db.query(`SELECT status, locked_by, last_error FROM jobs WHERE id = $1`, [s.id])).rows[0];
  check(reclaimed.requeued >= 1 && row.status === "queued" && row.locked_by === null, "a job whose worker died is reclaimed and re-queued", row.last_error);
  const stats = await queue.queueStats();
  check(typeof stats.dead === "number" && "oldestReadyAgeSeconds" in stats, "queue depth / oldest-job age / dead-letter count are reported", JSON.stringify(stats));

  // --- 3. live webhook idempotency ------------------------------------------------------
  console.log("\n3. Webhook idempotency (live)");
  const guid = crypto.randomUUID();
  const wr = {
    action: "completed",
    workflow_run: { id: 9900000 + crypto.randomInt(99999), head_branch: "main", head_sha: crypto.randomBytes(20).toString("hex"), status: "completed", conclusion: "success", event: "push", updated_at: new Date().toISOString() },
    repository: { id: 900000000001, name: REPO, full_name: `demo-owner/${REPO}`, owner: { login: "demo-owner" } },
    installation: { id: 900000001 },
  };
  const send = async () => {
    const raw = JSON.stringify(wr);
    const r = await fetch(`${BASE}/api/webhook/github`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-GitHub-Event": "workflow_run", "X-GitHub-Delivery": guid, "X-Hub-Signature-256": signBody(raw, webhookSecret) },
      body: raw,
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const first = await send();
  const second = await send();
  const jobs = (await db.query(`SELECT id, status FROM jobs WHERE dedupe_key = $1`, [`webhook:${guid}`])).rows;
  check(first.status === 202 && first.body.queued, "workflow_run is acknowledged fast and queued (202)");
  check([200, 202].includes(second.status) && jobs.length === 1, "the same delivery GUID twice creates exactly ONE job", `second: HTTP ${second.status}${second.body.duplicate ? " duplicate" : ""}`);
  const done = await waitForJob(db, jobs[0]?.id, 60_000);
  check(done?.status === "succeeded", "the workflow_run job ran to completion (unconnected repo: ignored)", done?.status ?? "timeout");

  const push = buildPushPayload({ message: "[DeployGuard verification] Stage 2 queue", modified: ["src/db/pool.ts"], added: [], removed: [] });
  push.repository = { ...push.repository, name: REPO, full_name: `demo-owner/${REPO}`, id: testRepositoryId(`demo-owner/${REPO}`) };
  const pushGuid = crypto.randomUUID();
  const sendPush = async () => {
    const raw = JSON.stringify(push);
    const r = await fetch(`${BASE}/api/webhook/github`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-GitHub-Event": "push", "X-GitHub-Delivery": pushGuid, "X-Hub-Signature-256": signBody(raw, webhookSecret), "X-DeployGuard-Auto-Risk": "off" },
      body: raw,
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const p1 = await sendPush();
  const p2 = await sendPush();
  const rows = (await db.query(`SELECT id FROM deployments WHERE commit_sha = $1`, [push.after])).rows;
  check(p1.status === 200 && p2.body.duplicate === true && rows.length === 1, "a redelivered push keeps ONE deployment row");
  const memJob = await waitForJob(db, p1.body.memory?.jobId, 60_000);
  check(memJob?.status === "succeeded", "the push's memory write ran as a queued job and succeeded", memJob?.status ?? "timeout");
  const id = rows[0]?.id;

  const report = (st, extra = {}) =>
    fetch(`${BASE}/api/deployments/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${statusToken}` },
      body: JSON.stringify({ repository: `demo-owner/${REPO}`, branch: "main", commitSha: push.after, status: st, ...extra }),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  await report("BUILDING");
  const f1 = await report("FAILED", { failure: { stage: "test", message: "Error: connect ETIMEDOUT" } });
  const f2 = await report("FAILED", { failure: { stage: "test", message: "Error: connect ETIMEDOUT" } });
  const inc = (await db.query(`SELECT count(*)::int n FROM incidents WHERE deployment_id = $1`, [id])).rows[0].n;
  check(f1.status === 200 && f2.status === 200 && inc === 1, "a repeated CI FAILED report keeps ONE incident");

  // --- 4. ordering -------------------------------------------------------------------------
  console.log("\n4. Ordering (real lib/db/deployments.ts)");
  const key = { owner: "demo-owner", repository: REPO, branch: "main", commitSha: push.after };
  const t0 = Date.now() + 60_000; // GitHub times ahead of the CI reports above
  const at = (s) => new Date(t0 + s * 1000).toISOString();
  const rerun = await updateDeploymentStatus(key, { status: "BUILDING", eventAt: at(1) });
  const succ = await updateDeploymentStatus(key, { status: "SUCCESS", eventAt: at(3) });
  check(rerun.outcome === "updated" && succ.outcome === "updated" && succ.deployment.status === "SUCCESS", "re-run BUILDING then SUCCESS applied in order");
  const late = await updateDeploymentStatus(key, { status: "BUILDING", eventAt: at(2) });
  const now = (await db.query(`SELECT status FROM deployments WHERE id = $1`, [id])).rows[0].status;
  check(late.outcome === "stale_event" && now === "SUCCESS", "a LATE in_progress event does not overwrite SUCCESS", `outcome=${late.outcome}, status=${now}`);
  const again = await updateDeploymentStatus(key, { status: "BUILDING", eventAt: at(10) });
  check(again.outcome === "updated", "a genuine re-run (newer event) still moves it to BUILDING");
  const lateCi = await report("BUILDING");
  check(lateCi.status === 200 && lateCi.body.ignored, "an out-of-date CI report is acknowledged and ignored (not an error)", JSON.stringify(lateCi.body).slice(0, 80));

  // --- 5. cost control ----------------------------------------------------------------------
  console.log("\n5. Gemini cost control");
  const tenantA = `verify:${RUN}:a`;
  process.env.DEPLOYGUARD_GEMINI_DAILY_CAP = "2";
  process.env.DEPLOYGUARD_GEMINI_MONTHLY_CAP = "100";
  const d = [await reserveGeminiCall(tenantA), await reserveGeminiCall(tenantA), await reserveGeminiCall(tenantA)];
  check(d[0].allowed && d[1].allowed && !d[2].allowed && d[2].reason === "daily", "daily cap: 2 allowed, the 3rd refused");
  const tenantB = `verify:${RUN}:b`;
  process.env.DEPLOYGUARD_GEMINI_DAILY_CAP = "100";
  process.env.DEPLOYGUARD_GEMINI_MONTHLY_CAP = "1";
  const m = [await reserveGeminiCall(tenantB), await reserveGeminiCall(tenantB)];
  check(m[0].allowed && !m[1].allowed && m[1].reason === "monthly", "monthly cap: refused once reached");
  const usage = (await db.query(`SELECT sum(calls)::int calls, sum(refused)::int refused FROM gemini_usage WHERE tenant = ANY($1)`, [[tenantA, tenantB]])).rows[0];
  check(usage.calls === 3 && usage.refused === 2, "usage is recorded per tenant (calls and refusals)", JSON.stringify(usage));

  const lock1 = await tryStartRiskAnalysis(id);
  const lock2 = await tryStartRiskAnalysis(id);
  check(Boolean(lock1) && lock2 === null, "Re-analyze in-flight lock: a second concurrent request is refused");
  await finishRiskAnalysis(id, lock1, { status: "unavailable", error: "verification" });

  const totalCalls = async () => (await db.query(`SELECT COALESCE(sum(calls), 0)::int n FROM gemini_usage`)).rows[0].n;
  const beforeCalls = await totalCalls();
  for (const path of [`/?id=${id}`, `/api/dashboard?id=${id}`, `/api/deployments/risk?id=${id}`, `/api/deployments?limit=5`]) await internalFetch(`${BASE}${path}`);
  check((await totalCalls()) === beforeCalls, "page loads and API reads made NO Gemini call");
} catch (error) {
  check(false, "verification crashed", error.stack?.split("\n").slice(0, 3).join(" | "));
} finally {
  await db.query(`DELETE FROM jobs WHERE type = $1`, [TYPE]).catch(() => {});
  await db.query(`DELETE FROM gemini_usage WHERE tenant LIKE $1`, [`verify:${RUN}:%`]).catch(() => {});
  await client.end();
  await db.end();
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
