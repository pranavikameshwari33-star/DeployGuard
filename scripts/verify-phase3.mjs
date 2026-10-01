/**
 * End-to-end check for Phase 3, without GitHub. Run with the dev server up:
 *
 *   npm run dev              (terminal 1)
 *   npm run verify:phase3    (terminal 2)
 *
 * It plays the part of GitHub Actions against your local server and prints
 * PASS/FAIL for each link:
 *   1. the Phase 3 columns exist (npm run db:migrate)
 *   2. status updates without the right token are rejected
 *   3. a push that DeployGuard never received gives 404
 *   4. success path:  RECEIVED -> BUILDING -> SUCCESS
 *   5. failure path:  RECEIVED -> BUILDING -> FAILED, with the failure details stored
 *   6. a finished deployment cannot jump SUCCESS -> FAILED (409)
 *   7. still exactly one row per push
 *
 * No secret is printed at any point.
 */
import crypto from "node:crypto";
import pg from "pg";
import { loadEnv } from "./load-env.mjs";
import { waitForJob } from "./job-helpers.mjs";
import { buildPushPayload, deliver } from "./test-payload.mjs";

loadEnv();

const BASE = process.env.APP_URL || "http://localhost:3000";
const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
const statusToken = process.env.DEPLOYGUARD_STATUS_TOKEN;
const connectionString = process.env.DATABASE_URL;

for (const [name, value] of Object.entries({
  GITHUB_WEBHOOK_SECRET: webhookSecret,
  DATABASE_URL: connectionString,
  DEPLOYGUARD_STATUS_TOKEN: statusToken,
})) {
  if (!value) {
    console.error(`${name} is not set. Add it to .env.local and restart npm run dev.`);
    process.exit(1);
  }
}

let failures = 0;
const pass = (step, detail = "") => console.log(`  PASS  ${step}${detail ? " -- " + detail : ""}`);
const fail = (step, detail = "") => {
  failures++;
  console.log(`  FAIL  ${step}${detail ? " -- " + detail : ""}`);
};
const check = (ok, step, detail) => (ok ? pass(step, detail) : fail(step, detail));

const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString);
const client = new pg.Client({
  connectionString,
  ssl: isLocal ? undefined : { rejectUnauthorized: false },
});

/** Sends a status report exactly the way scripts/report-status.mjs does in CI. */
async function report(payload, status, extra = {}, token = statusToken) {
  const response = await fetch(`${BASE}/api/deployments/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      repository: payload.repository.full_name,
      branch: payload.ref.replace("refs/heads/", ""),
      commitSha: payload.after,
      status,
      runId: "4242",
      runUrl: "https://github.com/demo-owner/demo-repo/actions/runs/4242",
      ...extra,
    }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function row(sha) {
  const { rows } = await client.query(
    `SELECT status, ci_run_id, ci_started_at, ci_finished_at,
            failure_stage, failure_job, failure_message
     FROM deployments WHERE commit_sha = $1`,
    [sha]
  );
  return rows;
}

async function newPush(message) {
  const payload = buildPushPayload({ message });
  const result = await deliver(`${BASE}/api/webhook/github`, payload, webhookSecret);
  if (result.status !== 200 || !result.body.ok) {
    throw new Error(`webhook did not accept the push: HTTP ${result.status} ${JSON.stringify(result.body)}`);
  }
  return payload;
}

console.log("\nDeployGuard - Phase 3 verification\n");

try {
  // --- 1. schema -------------------------------------------------------------
  console.log("1. Database schema");
  await client.connect();
  const { rows: cols } = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'deployments' AND column_name IN ('updated_at', 'ci_run_id', 'failure_stage')`
  );
  if (cols.length === 3) pass("Phase 3 columns exist");
  else {
    fail("Phase 3 columns are missing", "run: npm run db:migrate");
    process.exit(1);
  }

  // --- 2. auth ---------------------------------------------------------------
  console.log("\n2. Security");
  const probe = await newPush("Phase 3 verification: auth probe");
  const noToken = await report(probe, "BUILDING", {}, "");
  check(noToken.status === 401, "request without a token is rejected", `HTTP ${noToken.status}`);
  const badToken = await report(probe, "BUILDING", {}, crypto.randomBytes(16).toString("hex"));
  check(badToken.status === 401, "request with a wrong token is rejected", `HTTP ${badToken.status}`);
  const [probeRow] = await row(probe.after);
  check(probeRow?.status === "RECEIVED", "rejected requests changed nothing", `status=${probeRow?.status}`);

  // --- 3. not found ----------------------------------------------------------
  console.log("\n3. Unknown deployment");
  const ghost = buildPushPayload(); // never delivered to the webhook
  const missing = await report(ghost, "BUILDING");
  check(missing.status === 404, "a push DeployGuard never received gives 404", `HTTP ${missing.status}`);
  check((await row(ghost.after)).length === 0, "no row was created for it");

  // --- 4. success path -------------------------------------------------------
  console.log("\n4. Successful pipeline");
  const ok = await newPush("Phase 3 verification: successful pipeline");
  check((await row(ok.after))[0]?.status === "RECEIVED", "webhook created the row as RECEIVED");

  let r = await report(ok, "BUILDING");
  check(r.status === 200 && r.body.status === "BUILDING", "RECEIVED -> BUILDING", `HTTP ${r.status}`);
  r = await report(ok, "SUCCESS");
  check(r.status === 200 && r.body.status === "SUCCESS", "BUILDING -> SUCCESS", `HTTP ${r.status}`);
  const [okRow] = await row(ok.after);
  check(
    okRow?.status === "SUCCESS" && okRow.ci_run_id === "4242" && okRow.ci_finished_at && !okRow.failure_stage,
    "database row is SUCCESS with run id and finish time"
  );
  // Stage 2: the Hindsight write is a queued job (not inside the CI request).
  const finalMemoryJob = await waitForJob(client, r.body.memory?.jobId);
  check(
    r.body.memory?.queued === true && finalMemoryJob?.status === "succeeded",
    "final result written to Hindsight (queued job succeeded)",
    `queued=${r.body.memory?.queued}, job=${finalMemoryJob?.status ?? "timeout"} ${finalMemoryJob?.last_error ?? ""}`
  );

  // --- 5. failure path -------------------------------------------------------
  console.log("\n5. Failed pipeline");
  const bad = await newPush("Phase 3 verification: failing pipeline");
  await report(bad, "BUILDING");
  r = await report(bad, "FAILED", {
    failure: {
      stage: "test",
      job: "Build, test and deploy",
      message: "not ok 1 - demo failure switch\n  error: 'Intentional demo failure'",
    },
  });
  check(r.status === 200 && r.body.status === "FAILED", "BUILDING -> FAILED", `HTTP ${r.status}`);
  const [badRow] = await row(bad.after);
  check(
    badRow?.status === "FAILED" &&
      badRow.failure_stage === "test" &&
      badRow.failure_job === "Build, test and deploy" &&
      badRow.failure_message?.includes("Intentional demo failure"),
    "failure stage, job and output stored",
    `stage=${badRow?.failure_stage}`
  );

  // --- 6. invalid transition -------------------------------------------------
  console.log("\n6. Lifecycle rules");
  r = await report(ok, "FAILED", { failure: { stage: "test" } });
  check(r.status === 409, "SUCCESS -> FAILED is refused", `HTTP ${r.status}`);
  check((await row(ok.after))[0]?.status === "SUCCESS", "refused update changed nothing");

  // --- 7. no duplicates ------------------------------------------------------
  console.log("\n7. One row per push");
  for (const p of [ok, bad]) {
    const n = (await row(p.after)).length;
    check(n === 1, `commit ${p.after.slice(0, 7)} has exactly one row`, `${n} row(s)`);
  }
} catch (error) {
  fail("unexpected error", error.message);
} finally {
  await client.end();
}

console.log(
  failures === 0
    ? "\nPhase 3 verified: every step passed.\n"
    : `\n${failures} check(s) failed. See above.\n`
);
process.exitCode = failures === 0 ? 0 : 1;
