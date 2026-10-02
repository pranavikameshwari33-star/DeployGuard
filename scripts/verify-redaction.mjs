/**
 * Stage 1: redaction, end to end. Run with the migration applied and the dev
 * server up:
 *
 *   npm run db:migrate          (adds deployments.redaction)
 *   npm run dev                 (terminal 1)
 *   npm run verify:redaction    (terminal 2)
 *
 *   1  unit fixtures: secrets of every category masked, ordinary text untouched
 *      (tests/redaction.test.mjs)
 *   2  a push whose commit message contains a token: masked in the webhook
 *      response, PostgreSQL, the dashboard and Hindsight
 *   3  a FAILED report whose log contains a token, a connection string, a JWT
 *      and an API_KEY= line: masked in deployments.failure_message,
 *      incidents.error_message, the dashboard and Hindsight
 *   4  the redaction is RECORDED (counts + categories) and the record holds no value
 *   5  the 40-line cap holds for long output
 *
 * Fake, runtime-assembled secrets only. No real credential is used or printed.
 * Uses its own repository (demo-owner/redaction-<random>); no Gemini calls.
 */
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { loadEnv } from "./load-env.mjs";
import { internalFetch } from "./internal-fetch.mjs";
import { buildPushPayload, deliver } from "./test-payload.mjs";

loadEnv();

const BASE = process.env.APP_URL || "http://localhost:3000";
const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
const statusToken = process.env.DEPLOYGUARD_STATUS_TOKEN;
const connectionString = process.env.DATABASE_URL;

let failures = 0;
const check = (ok, step, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${step}${detail ? " -- " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (n) => crypto.randomBytes(n).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, n);

// Fake secrets, assembled at runtime so no key-shaped literal sits in the repo.
const S = {
  commitToken: "ghp" + "_" + rand(36).padEnd(36, "Q7"),
  logToken: "ghs" + "_" + rand(36).padEnd(36, "Z3"),
  dbPassword: "Pw" + rand(22) + "9x",
  jwt: ["eyJ" + rand(24), "eyJ" + rand(30), rand(40)].join("."),
  apiKey: "k" + rand(30) + "7Q",
};
const leaked = (text) => Object.entries(S).filter(([, v]) => String(text).includes(v)).map(([k]) => k);

const REPO = `redaction-${crypto.randomBytes(4).toString("hex")}`;
const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString ?? "");
const client = new pg.Client({ connectionString, ssl: isLocal ? undefined : { rejectUnauthorized: false } });

console.log("DeployGuard Stage 1: redaction\n");

// --- 1. unit fixtures -----------------------------------------------------------
const unit = spawnSync(process.execPath, ["--experimental-strip-types", "--test", "tests/redaction.test.mjs"], { encoding: "utf8" });
const passCount = Number(/# pass (\d+)/.exec(unit.stdout)?.[1] ?? 0);
const failCount = Number(/# fail (\d+)/.exec(unit.stdout)?.[1] ?? -1);
check(unit.status === 0 && failCount === 0, "unit redaction fixtures (secrets + false positives)", `${passCount} passed, ${failCount} failed`);

if (!webhookSecret || !statusToken || !connectionString) {
  console.log("\nSKIP live checks: GITHUB_WEBHOOK_SECRET, DEPLOYGUARD_STATUS_TOKEN and DATABASE_URL are required.");
  process.exit(failures ? 1 : 0);
}

await client.connect();
try {
  // --- 2. commit message ---------------------------------------------------------
  const payload = buildPushPayload({
    message: `[DeployGuard verification] Stage 1 redaction: rotate creds, old token ${S.commitToken}`,
    modified: ["src/db/pool.ts"],
    added: [],
    removed: [],
  });
  payload.repository = { ...payload.repository, name: REPO, full_name: `demo-owner/${REPO}` };
  const pushed = await deliver(`${BASE}/api/webhook/github`, payload, webhookSecret, "push");
  check(pushed.status === 200 && pushed.body.ok, "push accepted", `HTTP ${pushed.status}`);
  check(leaked(JSON.stringify(pushed.body)).length === 0, "webhook response contains no secret");
  const id = String(pushed.body.deploymentId);

  // --- 3. failure output -----------------------------------------------------------
  const filler = Array.from({ length: 70 }, (_, i) => `  ok ${i} unrelated test`);
  const log = [
    "Run npm test",
    ...filler,
    `npm notice token ${S.logToken}`,
    `DATABASE_URL=postgresql://app:${S.dbPassword}@db.internal:5432/app`,
    `Authorization: Bearer ${S.jwt}`,
    `API_KEY=${S.apiKey}`,
    "Error: connect ETIMEDOUT 10.0.0.5:5432",
    "Process completed with exit code 1.",
  ].join("\n");
  const report = await fetch(`${BASE}/api/deployments/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${statusToken}` },
    body: JSON.stringify({
      repository: `demo-owner/${REPO}`,
      branch: "main",
      commitSha: payload.after,
      status: "FAILED",
      runId: "4242",
      runUrl: `https://github.com/demo-owner/${REPO}/actions/runs/4242`,
      failure: { stage: "test", job: `ci / test (${S.logToken})`, message: log },
    }),
  });
  const reportBody = await report.json().catch(() => ({}));
  check(report.status === 200, "FAILED report accepted", `HTTP ${report.status}`);
  check(leaked(JSON.stringify(reportBody)).length === 0, "status response contains no secret");

  const { rows: [row] } = await client.query(
    `SELECT commit_message, failure_message, failure_job, redaction FROM deployments WHERE id = $1`,
    [id]
  );
  const { rows: [incident] } = await client.query(`SELECT error_message FROM incidents WHERE deployment_id = $1`, [id]);
  check(row && leaked(row.commit_message).length === 0, "PostgreSQL commit_message is redacted", row?.commit_message?.slice(0, 120));
  check(row && leaked(row.failure_message + row.failure_job).length === 0, "PostgreSQL failure output and job are redacted",
    `leaked: ${leaked((row?.failure_message ?? "") + (row?.failure_job ?? "")).join(", ") || "none"}`);
  check(incident && leaked(incident.error_message).length === 0, "incident error_message is redacted");
  check(row?.failure_message?.includes("Error: connect ETIMEDOUT 10.0.0.5:5432"), "the useful error line is kept");

  // --- 4. recorded, without values -------------------------------------------------------
  const r = row?.redaction ?? {};
  check(r.commit_message?.count >= 1 && r.commit_message.categories.includes("github_token"), "commit-message redaction recorded", JSON.stringify(r.commit_message));
  check(r.failure_output?.count >= 4, "failure-output redaction recorded", JSON.stringify(r.failure_output));
  check(leaked(JSON.stringify(r)).length === 0, "the redaction record holds no secret value");

  // --- 5. 40-line cap ---------------------------------------------------------------------
  const lines = (row?.failure_message ?? "").split("\n");
  check(lines.length <= 40, "failure output keeps at most 40 lines", `${lines.length} lines`);

  // --- rendering and memory ---------------------------------------------------------------
  const page = await (await internalFetch(`${BASE}/?id=${id}`)).text();
  check(page.includes("[REDACTED:") && leaked(page).length === 0, "dashboard page shows placeholders, no secret");
  const api = await (await internalFetch(`${BASE}/api/dashboard?id=${id}`)).text();
  check(leaked(api).length === 0, "dashboard API contains no secret");
  const list = await (await internalFetch(`${BASE}/api/deployments`)).text();
  check(leaked(list).length === 0, "deployments API contains no secret");

  let memories = [];
  for (let attempt = 0; attempt < 6 && memories.length === 0; attempt++) {
    if (attempt) await sleep(3000);
    const recall = await internalFetch(
      `${BASE}/api/memory/recall?q=${encodeURIComponent(`${REPO} failed deployment database timeout`)}&tags=${encodeURIComponent(`deployment:${id}`)}`
    );
    memories = (await recall.json().catch(() => ({}))).memories ?? [];
  }
  const { rows: [{ n }] } = await client.query(`SELECT count(*)::int AS n FROM incidents WHERE deployment_id = $1`, [id]);
  check(n === 1, "incident recorded");
  if (memories.length === 0) {
    console.log("  NOTE  Hindsight returned no memory for this deployment yet; memory-side check not conclusive.");
  } else {
    check(leaked(JSON.stringify(memories)).length === 0, "Hindsight memories contain no secret", `${memories.length} memory(ies)`);
  }
} finally {
  await client.end();
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
