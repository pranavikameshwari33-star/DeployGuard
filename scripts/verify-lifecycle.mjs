/**
 * Stage 2: data lifecycle -- export, purge (PostgreSQL + Hindsight, verified),
 * disconnect-is-not-purge, retention, append-only audit log.
 * Run with migration 010 applied and the dev server up:
 *
 *   npm run verify:lifecycle
 *
 * Creates a test user, installation and repository (ids in test-only ranges),
 * pushes test deployments through the real webhook, then exercises the real
 * routes as that user. Retention runs the real lib/lifecycle/retention.ts on
 * BACKDATED test rows only; it refuses to run if any other row is old enough
 * to be affected. Audit rows written by the test stay (the log is append-only).
 */
import crypto from "node:crypto";
import { loadEnv } from "./load-env.mjs";
import { buildPushPayload, deliver, testRepositoryId } from "./test-payload.mjs";
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

const { getPool } = await import("@/lib/db/client");
const { documentExists } = await import("@/lib/hindsight/client");
const { applyRetention } = await import("@/lib/lifecycle/retention");
const { disconnectRepositories } = await import("@/lib/db/accounts");
const { purgeRepository } = await import("@/lib/lifecycle/purge");
const db = getPool();

const RUN = crypto.randomBytes(4).toString("hex");
const REPO = `lifecycle-${RUN}`;
const FULL = `demo-owner/${REPO}`;
const REPO_ID = String(testRepositoryId(FULL));
const REPO_B = `lifecycle-b-${RUN}`;
const REPO_B_ID = String(testRepositoryId(`demo-owner/${REPO_B}`));
const INSTALLATION = 900000000 + crypto.randomInt(1, 99_999_999);
const GH_USER = 700000000000 + crypto.randomInt(1, 1_000_000_000);

async function push(repo, message, files) {
  const payload = buildPushPayload({ message: `[DeployGuard verification] Stage 2 lifecycle: ${message}`, modified: files, added: [], removed: [] });
  payload.repository = { ...payload.repository, name: repo, full_name: `demo-owner/${repo}` };
  const r = await deliver(`${BASE}/api/webhook/github`, payload, webhookSecret, "push");
  if (r.status !== 200) throw new Error(`push failed: HTTP ${r.status}`);
  return { sha: payload.after, id: String(r.body.deploymentId), memoryJob: r.body.memory?.jobId };
}
const report = (repo, sha, status, failure) =>
  fetch(`${BASE}/api/deployments/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${statusToken}` },
    body: JSON.stringify({ repository: `demo-owner/${repo}`, branch: "main", commitSha: sha, status, ...(failure ? { failure } : {}) }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

console.log("DeployGuard Stage 2: data lifecycle\n");
let userId;
const token = crypto.randomBytes(32).toString("base64url");
const cookie = `dg_session=${token}`;
try {
  // --- setup: an owner with one repository -------------------------------------------
  userId = (await db.query(`INSERT INTO users (github_user_id, github_login) VALUES ($1, $2) RETURNING id`, [GH_USER, `lifecycle-${RUN}`])).rows[0].id;
  await db.query(`INSERT INTO github_installations (installation_id, user_id, status) VALUES ($1, $2, 'active')`, [INSTALLATION, userId]);
  await db.query(
    `INSERT INTO repositories (github_repository_id, installation_id, owner, name, full_name) VALUES ($1, $2, 'demo-owner', $3, $4), ($5, $2, 'demo-owner', $6, $7)`,
    [REPO_ID, INSTALLATION, REPO, FULL, REPO_B_ID, REPO_B, `demo-owner/${REPO_B}`]
  );
  await db.query(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [
    userId,
    crypto.createHash("sha256").update(token).digest("hex"),
  ]);
  const asUser = (path, init = {}) => fetch(`${BASE}${path}`, { ...init, headers: { ...(init.headers ?? {}), Cookie: cookie } });

  const d1 = await push(REPO, "db pool change", ["src/db/pool.ts"]);
  const d2 = await push(REPO, "failing change", ["src/db/pool.ts", "config/database.yaml"]);
  await report(REPO, d2.sha, "BUILDING");
  const failed = await report(REPO, d2.sha, "FAILED", { stage: "test", message: "Error: connect ETIMEDOUT 10.0.0.9:5432" });
  const jobs = [d1.memoryJob, d2.memoryJob, failed.body.memory?.jobId, failed.body.incident?.memory?.jobId];
  const results = await Promise.all(jobs.map((j) => waitForJob(db, j, 90_000)));
  check(results.every((r) => r?.status === "succeeded"), "test history created; all memory jobs succeeded", results.map((r) => r?.status ?? "timeout").join(","));

  const tracked = (await db.query(`SELECT document_id FROM memory_documents WHERE github_repository_id = $1 AND deleted_at IS NULL`, [REPO_ID])).rows.map((r) => r.document_id);
  check(tracked.length >= 3, "every retained Hindsight document is tracked by id", `${tracked.length} document(s)`);
  const present = await Promise.all(tracked.map((doc) => documentExists(doc)));
  check(present.every(Boolean), "those documents exist in Hindsight before the purge");

  // --- export -----------------------------------------------------------------------
  console.log("\nExport");
  const exp = await asUser(`/api/repositories/export?githubRepositoryId=${REPO_ID}`);
  const data = await exp.json().catch(() => ({}));
  check(exp.status === 200 && /attachment/.test(exp.headers.get("content-disposition") ?? ""), "owner can download an export");
  check(data.deployments?.length === 2 && data.incidents?.length === 1 && data.format === "deployguard-export/1", "export holds the repository's deployments and incident",
    `${data.deployments?.length} deployments, ${data.incidents?.length} incident(s)`);
  const otherExport = await asUser(`/api/repositories/export?githubRepositoryId=900000000999`);
  check(otherExport.status === 404, "export of a repository the user does not own is refused (404)");

  // --- disconnect is not purge --------------------------------------------------------------
  console.log("\nDisconnect is not purge");
  const b1 = await push(REPO_B, "repo b change", ["src/app.ts"]);
  await waitForJob(db, b1.memoryJob, 60_000);
  await disconnectRepositories(INSTALLATION, [Number(REPO_B_ID)]);
  const stillThere = (await db.query(`SELECT count(*)::int n FROM deployments WHERE github_repository_id = $1`, [REPO_B_ID])).rows[0].n;
  const state = (await db.query(`SELECT connected FROM repositories WHERE github_repository_id = $1`, [REPO_B_ID])).rows[0];
  check(state.connected === false && stillThere === 1, "disconnecting stops monitoring and KEEPS the history");

  // --- purge (user path) ---------------------------------------------------------------------
  console.log("\nPurge");
  const body = (confirm) => JSON.stringify({ githubRepositoryId: REPO_ID, confirm });
  const crossSite = await asUser(`/api/repositories/purge`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: body(FULL) });
  check(crossSite.status === 403, "a cross-site purge request is refused (CSRF)");
  const noConfirm = await asUser(`/api/repositories/purge`, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE }, body: body("wrong") });
  check(noConfirm.status === 400, "a purge without the exact confirmation is refused");
  const notMine = await asUser(`/api/repositories/purge`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE },
    body: JSON.stringify({ githubRepositoryId: "900000000999", confirm: "x/y" }),
  });
  check(notMine.status === 404, "purging a repository the user does not own is refused (404)");
  check((await db.query(`SELECT count(*)::int n FROM deployments WHERE github_repository_id = $1`, [REPO_ID])).rows[0].n === 2, "refused purges deleted nothing");

  const purge = await asUser(`/api/repositories/purge`, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE }, body: body(FULL) });
  const result = await purge.json().catch(() => ({}));
  check(purge.status === 200 && result.ok, "the owner's confirmed purge succeeds", `HTTP ${purge.status}`);
  check(result.report?.verified?.postgres && result.report?.verified?.hindsightDocuments, "the purge verified both stores itself", JSON.stringify(result.report?.verified));
  console.log(`  INFO  scoped recall after purge returned ${result.report?.remainingRecallMemories ?? "?"} memory(ies)`);
  check(result.report?.verified?.hindsightRecallEmpty === true, "a recall scoped to the purged repository returns nothing");

  const left = (await db.query(
    `SELECT (SELECT count(*) FROM deployments WHERE github_repository_id = $1)::int d,
            (SELECT count(*) FROM incidents i JOIN deployments x ON x.id = i.deployment_id WHERE x.github_repository_id = $1)::int i,
            (SELECT count(*) FROM memory_documents WHERE github_repository_id = $1 AND deleted_at IS NULL)::int m`,
    [REPO_ID]
  )).rows[0];
  check(left.d === 0 && left.i === 0 && left.m === 0, "PostgreSQL: no deployment, incident or live document record left", JSON.stringify(left));
  const gone = await Promise.all(tracked.map((doc) => documentExists(doc)));
  check(gone.every((x) => !x), "Hindsight: every tracked document is gone (checked independently)", `${gone.filter(Boolean).length} still present`);
  const audit = (await db.query(`SELECT action, outcome FROM audit_log WHERE github_repository_id = $1 ORDER BY id`, [REPO_ID])).rows;
  check(audit.some((a) => a.action === "repository.export" && a.outcome === "ok") &&
        audit.some((a) => a.action === "repository.purge" && a.outcome === "refused") &&
        audit.some((a) => a.action === "repository.purge" && a.outcome === "ok"), "export, refused purge and purge are all audit-logged", audit.map((a) => `${a.action}:${a.outcome}`).join(", "));

  // --- retention ---------------------------------------------------------------------------------
  console.log("\nRetention");
  const r1 = await push(REPO_B, "old failure", ["src/db/pool.ts"]);
  await report(REPO_B, r1.sha, "FAILED", { stage: "test", message: "Error: old output" });
  const others = (await db.query(
    `SELECT count(*)::int n FROM deployments WHERE github_repository_id IS DISTINCT FROM $1 AND failure_message IS NOT NULL AND created_at < now() - interval '90 days'`,
    [REPO_B_ID]
  )).rows[0].n;
  if (others > 0) {
    console.log(`  SKIP  retention: ${others} real row(s) are older than 90 days and would be affected; not run on real data.`);
  } else {
    await db.query(`UPDATE deployments SET created_at = now() - interval '100 days' WHERE id = $1`, [r1.id]);
    delete process.env.DEPLOYGUARD_RETENTION_FAILURE_OUTPUT_DAYS;
    process.env.DEPLOYGUARD_RETENTION_DEPLOYMENT_DAYS = "0";
    const ret = await applyRetention();
    const row = (await db.query(`SELECT d.failure_message, d.status, i.error_message FROM deployments d LEFT JOIN incidents i ON i.deployment_id = d.id WHERE d.id = $1`, [r1.id])).rows[0];
    check(ret.failureOutputCleared >= 1 && row.failure_message === null && row.error_message === null && row.status === "FAILED",
      "failure output past retention is cleared; the deployment and its outcome stay", `cleared=${ret.failureOutputCleared}`);
    const rewrite = (await db.query(`SELECT count(*)::int n FROM jobs WHERE dedupe_key = $1`, [`memory.deployment:${r1.id}:retention`])).rows[0].n;
    check(rewrite === 1, "the Hindsight memory is rewritten without the output (queued job)");
  }
  const oldOthers = (await db.query(`SELECT count(*)::int n FROM deployments WHERE github_repository_id IS DISTINCT FROM $1 AND created_at < now() - interval '3650 days'`, [REPO_B_ID])).rows[0].n;
  if (oldOthers > 0) {
    console.log(`  SKIP  deployment retention: ${oldOthers} real row(s) older than 3650 days.`);
  } else {
    await db.query(`UPDATE deployments SET created_at = now() - interval '4000 days' WHERE id = $1`, [r1.id]);
    process.env.DEPLOYGUARD_RETENTION_DEPLOYMENT_DAYS = "3650";
    const ret = await applyRetention();
    const exists = (await db.query(`SELECT count(*)::int n FROM deployments WHERE id = $1`, [r1.id])).rows[0].n;
    check(ret.deploymentsPurged >= 1 && exists === 0, "deployments past the deployment retention period are purged (both stores)", `purged=${ret.deploymentsPurged}`);
  }

  // --- audit log is append-only ----------------------------------------------------------------
  let refused = false;
  try {
    await db.query(`UPDATE audit_log SET outcome = 'failed' WHERE github_repository_id = $1`, [REPO_ID]);
  } catch {
    refused = true;
  }
  check(refused, "audit log rows cannot be changed (append-only, enforced by the database)");
} catch (error) {
  check(false, "verification crashed", error.stack?.split("\n").slice(0, 3).join(" | "));
} finally {
  // Cleanup: remaining test data (repository B) through the real purge, then the account rows.
  await purgeRepository(REPO_B_ID).catch(() => {});
  await purgeRepository(REPO_ID).catch(() => {});
  if (userId) {
    await db.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]).catch(() => {});
    await db.query(`DELETE FROM repositories WHERE installation_id = $1`, [INSTALLATION]).catch((e) => console.log(`  WARN cleanup: ${e.message}`));
    await db.query(`DELETE FROM github_installations WHERE installation_id = $1`, [INSTALLATION]).catch(() => {});
    await db.query(`DELETE FROM users WHERE id = $1`, [userId]).catch(() => {});
  }
  await db.end();
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
