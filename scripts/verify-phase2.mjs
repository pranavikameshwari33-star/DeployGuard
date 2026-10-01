/**
 * End-to-end check for Phase 2. Run with the dev server up:
 *
 *   npm run dev              (terminal 1)
 *   npm run verify:phase2    (terminal 2)
 *
 * It walks the whole path and prints PASS/FAIL for each link:
 *   1. the database is reachable and the deployments table exists
 *   2. a signed push is accepted and stored
 *   3. the row is really in PostgreSQL
 *   4. redelivering the SAME push creates no second row (idempotency)
 *   5. the deployment can be recalled from Hindsight
 *
 * No secret is printed at any point.
 */
import pg from "pg";
import { loadEnv } from "./load-env.mjs";
import { waitForJob } from "./job-helpers.mjs";
import { internalFetch } from "./internal-fetch.mjs";
import { buildPushPayload, deliver } from "./test-payload.mjs";

loadEnv();

const BASE = process.env.APP_URL || "http://localhost:3000";
const secret = process.env.GITHUB_WEBHOOK_SECRET;
const connectionString = process.env.DATABASE_URL;

let failures = 0;
const pass = (step, detail = "") => console.log(`  PASS  ${step}${detail ? " -- " + detail : ""}`);
const fail = (step, detail = "") => {
  failures++;
  console.log(`  FAIL  ${step}${detail ? " -- " + detail : ""}`);
};

for (const [name, value] of Object.entries({
  GITHUB_WEBHOOK_SECRET: secret,
  DATABASE_URL: connectionString,
  HINDSIGHT_API_KEY: process.env.HINDSIGHT_API_KEY,
})) {
  if (!value) {
    console.error(`${name} is not set. Add it to .env.local (see .env.example).`);
    process.exit(1);
  }
}

const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString);
const client = new pg.Client({
  connectionString,
  ssl: isLocal ? undefined : { rejectUnauthorized: false },
});

console.log("\nDeployGuard - Phase 2 verification\n");

try {
  // --- 1. database reachable, table present -------------------------------
  console.log("1. Database");
  await client.connect();
  const { rows } = await client.query(
    `SELECT to_regclass('public.deployments') AS table_name`
  );
  if (rows[0].table_name) pass("deployments table exists");
  else {
    fail("deployments table is missing", "run: npm run db:migrate");
    process.exit(1);
  }

  const before = await client.query("SELECT count(*)::int AS n FROM deployments");

  // --- 2. webhook accepts a signed push ------------------------------------
  console.log("\n2. Webhook -> database");
  const payload = buildPushPayload({ message: "Phase 2 verification: tune database pool" });
  const first = await deliver(`${BASE}/api/webhook/github`, payload, secret);

  if (first.status === 200 && first.body.ok && first.body.duplicate === false) {
    pass("push accepted", `deployment #${first.body.deploymentId}, status ${first.body.status}`);
  } else {
    fail("push was not accepted", `HTTP ${first.status} ${JSON.stringify(first.body)}`);
  }

  // --- 3. the row is really there ------------------------------------------
  const stored = await client.query(
    `SELECT id, status, changed_files, added_files, modified_files, deleted_files
     FROM deployments WHERE commit_sha = $1`,
    [payload.after]
  );
  if (stored.rows.length === 1) {
    const row = stored.rows[0];
    pass(
      "row present in PostgreSQL",
      `status=${row.status}, changed=${row.changed_files.length} ` +
        `(+${row.added_files.length} ~${row.modified_files.length} -${row.deleted_files.length})`
    );
  } else {
    fail("row not found in PostgreSQL", `${stored.rows.length} rows matched`);
  }

  // --- 4. idempotency -------------------------------------------------------
  console.log("\n3. Idempotency (GitHub retry)");
  const second = await deliver(`${BASE}/api/webhook/github`, payload, secret);
  const after = await client.query("SELECT count(*)::int AS n FROM deployments");
  const added = after.rows[0].n - before.rows[0].n;

  if (second.body.duplicate === true) pass("redelivery reported as duplicate");
  else fail("redelivery was not flagged as a duplicate", JSON.stringify(second.body));

  if (added === 1) pass("exactly one row added by two deliveries");
  else fail("wrong number of rows added", `expected 1, got ${added}`);

  // --- 5. Hindsight memory --------------------------------------------------
  console.log("\n4. Hindsight memory");
  // Stage 2: the webhook no longer writes to Hindsight inside the request; it
  // queues a job. The guarantee checked here is the same: the memory is written.
  const memoryJob = await waitForJob(client, first.body.memory?.jobId);
  if (first.body.memory?.queued && memoryJob?.status === "succeeded") pass("memory job queued by the webhook and written to Hindsight");
  else fail("memory was not written", `queued=${first.body.memory?.queued}, job=${memoryJob?.status ?? "timeout"} ${memoryJob?.last_error ?? ""}`);

  const query = "deployment that changed the database configuration";
  const recallResponse = await internalFetch(
    `${BASE}/api/memory/recall?q=${encodeURIComponent(query)}`
  );
  const recalled = await recallResponse.json();

  if (recallResponse.ok && recalled.count > 0) {
    pass(`recall returned ${recalled.count} memory/memories`);
    console.log(`\n  Query: "${query}"`);
    for (const memory of recalled.memories.slice(0, 3)) {
      console.log(`  ----------------------------------------------------------`);
      console.log(
        "  " + memory.text.split("\n").slice(0, 4).join("\n  ")
      );
      if (memory.deploymentId) console.log(`  [deployment #${memory.deploymentId}]`);
    }
  } else if (recallResponse.ok) {
    fail(
      "recall returned nothing",
      "Hindsight indexes a new memory asynchronously; wait a few seconds and retry"
    );
  } else {
    fail("recall request failed", recalled.detail ?? `HTTP ${recallResponse.status}`);
  }
} catch (error) {
  fail("unexpected error", error.message);
} finally {
  await client.end();
}

console.log(
  failures === 0
    ? "\nPhase 2 verified: every step passed.\n"
    : `\n${failures} check(s) failed. See above.\n`
);
process.exitCode = failures === 0 ? 0 : 1;
