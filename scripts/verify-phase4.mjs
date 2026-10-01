/**
 * End-to-end check for Phase 4 (incident memory), without GitHub. Run with the
 * dev server up and the migration applied:
 *
 *   npm run db:migrate       (once, adds the incidents table)
 *   npm run dev              (terminal 1)
 *   npm run verify:phase4    (terminal 2)
 *
 * It plays the part of GitHub (push webhook) and GitHub Actions (status
 * reports) against your local server and prints PASS/FAIL for each link:
 *   1. the incidents table, its foreign key and its unique index exist
 *   2. a SUCCESSFUL deployment creates no incident
 *   3. three FAILED test deployments each create exactly one incident holding
 *      the observed stage, job and output, pointing at the right deployment
 *   4. unknown fields (root cause, resolution, service, downstream effect) stay NULL
 *   5. a repeated FAILED report and a re-run that fails again create no duplicate
 *   6. the incident memory is stored in Hindsight and can be recalled
 *
 * Test data is clearly labelled: every commit message starts with
 * "[DeployGuard verification]" and the repository is demo-owner/demo-repo.
 * Existing deployments and incidents are never modified. No secret is printed.
 */
import pg from "pg";
import { loadEnv } from "./load-env.mjs";
import { waitForJob } from "./job-helpers.mjs";
import { internalFetch } from "./internal-fetch.mjs";
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

const LABEL = "[DeployGuard verification]";

/** Realistic, clearly labelled failures. Each one goes through the real endpoints. */
const TEST_INCIDENTS = [
  {
    name: "A (payment timeout)",
    message: `${LABEL} Phase 4 test incident A: raise payment retry limit`,
    modified: ["services/payment/src/charge.ts", "services/payment/config/retry.yaml"],
    failure: {
      stage: "test",
      job: "Build, test and deploy",
      message:
        "not ok 3 - payment service > charges a card\n" +
        "  error: 'Timeout of 5000ms exceeded calling payment-service POST /charge'",
    },
    expectedType: "test_failure",
    expectText: "Timeout of 5000ms",
  },
  {
    name: "B (database connection timeout)",
    message: `${LABEL} Phase 4 test incident B: reduce database connection pool size`,
    modified: ["config/database.yaml", "src/db/pool.ts"],
    failure: {
      stage: "integration-test",
      job: "integration-tests",
      message:
        "Error: connect ETIMEDOUT 10.0.3.12:5432\n" +
        "Database connection timeout after 10000ms while running migrations",
    },
    expectedType: "integration_test_failure",
    expectText: "Database connection timeout",
  },
  {
    name: "C (authentication environment configuration error)",
    message: `${LABEL} Phase 4 test incident C: move auth issuer to environment config`,
    modified: ["services/auth/src/config.ts", ".env.example"],
    failure: {
      stage: "build",
      job: "Build, test and deploy",
      message:
        "Error: Missing required environment variable AUTH_JWT_ISSUER\n" +
        "    at loadConfig (services/auth/src/config.ts:14:11)",
    },
    expectedType: "build_failure",
    expectText: "AUTH_JWT_ISSUER",
  },
];

/** Sends a status report exactly the way scripts/report-status.mjs does in CI. */
async function report(payload, status, extra = {}) {
  const response = await fetch(`${BASE}/api/deployments/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${statusToken}` },
    body: JSON.stringify({
      repository: payload.repository.full_name,
      branch: payload.ref.replace("refs/heads/", ""),
      commitSha: payload.after,
      status,
      runId: "4343",
      runUrl: "https://github.com/demo-owner/demo-repo/actions/runs/4343",
      ...extra,
    }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function newPush(message, modified) {
  const payload = buildPushPayload({ message, modified, added: [], removed: [] });
  const result = await deliver(`${BASE}/api/webhook/github`, payload, webhookSecret);
  if (result.status !== 200 || !result.body.ok) {
    throw new Error(`webhook did not accept the push: HTTP ${result.status} ${JSON.stringify(result.body)}`);
  }
  return payload;
}

/** The deployment row and every incident row for one commit. */
async function lookup(sha) {
  const { rows: deployments } = await client.query(
    `SELECT id, status FROM deployments WHERE commit_sha = $1`,
    [sha]
  );
  const { rows: incidents } = await client.query(
    `SELECT i.* FROM incidents i JOIN deployments d ON d.id = i.deployment_id
     WHERE d.commit_sha = $1`,
    [sha]
  );
  return { deployment: deployments[0], incidents };
}

async function recallMemories(query, tags) {
  const url = `${BASE}/api/memory/recall?q=${encodeURIComponent(query)}&tags=${encodeURIComponent(tags)}`;
  const response = await internalFetch(url);
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, body };
}

console.log("\nDeployGuard - Phase 4 verification (incident memory)\n");

try {
  // --- 1. schema -------------------------------------------------------------
  console.log("1. Database schema");
  await client.connect();
  const { rows: cols } = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'incidents'`
  );
  const names = cols.map((c) => c.column_name);
  const required = [
    "id", "deployment_id", "failure_type", "error_message", "affected_service",
    "downstream_effect", "root_cause", "resolution", "created_at",
  ];
  const missing = required.filter((c) => !names.includes(c));
  if (missing.length === 0) pass("incidents table has every required column");
  else {
    fail("incidents table is missing or incomplete", `missing: ${missing.join(", ")} -- run: npm run db:migrate`);
    process.exit(1);
  }

  const { rows: fk } = await client.query(
    `SELECT 1 FROM information_schema.table_constraints
     WHERE table_name = 'incidents' AND constraint_type = 'FOREIGN KEY'`
  );
  check(fk.length === 1, "deployment_id is a foreign key to deployments");
  const { rows: uniq } = await client.query(
    `SELECT 1 FROM pg_indexes WHERE tablename = 'incidents' AND indexname = 'incidents_deployment_id_key'`
  );
  check(uniq.length === 1, "unique index on deployment_id exists");

  // --- 2. success creates nothing -------------------------------------------
  console.log("\n2. Successful deployment");
  const ok = await newPush(`${LABEL} Phase 4 successful deployment`, ["README.md"]);
  await report(ok, "BUILDING");
  const okReport = await report(ok, "SUCCESS");
  check(okReport.status === 200 && okReport.body.incident === undefined, "SUCCESS report returns no incident");
  check((await lookup(ok.after)).incidents.length === 0, "no incident row for a successful deployment");

  // --- 3 + 4. failures create one incident each -------------------------------
  const created = [];
  for (const t of TEST_INCIDENTS) {
    console.log(`\n3. Failed deployment -- test incident ${t.name}`);
    const payload = await newPush(t.message, t.modified);
    await report(payload, "BUILDING");
    const r = await report(payload, "FAILED", { failure: t.failure });

    check(r.status === 200 && r.body.status === "FAILED", "BUILDING -> FAILED accepted", `HTTP ${r.status}`);
    check(r.body.incident?.created === true, "response reports a new incident", `incident #${r.body.incident?.id}`);

    const { deployment, incidents } = await lookup(payload.after);
    check(incidents.length === 1, "exactly one incident row", `${incidents.length} row(s)`);
    const incident = incidents[0];
    if (!incident) continue;

    check(
      incident.deployment_id === deployment.id && deployment.status === "FAILED",
      "incident points at the right FAILED deployment",
      `incident #${incident.id} -> deployment #${deployment.id}`
    );
    check(
      incident.failure_type === t.expectedType &&
        incident.failure_job === t.failure.job &&
        incident.error_message?.includes(t.expectText),
      "observed failure type, job and output stored",
      `type=${incident.failure_type}, job=${incident.failure_job}`
    );

    console.log("   4. Nothing invented");
    check(
      incident.root_cause === null &&
        incident.resolution === null &&
        incident.downstream_effect === null &&
        incident.affected_service === null,
      "root cause, resolution, downstream effect and affected service are NULL (unknown)"
    );

    // Stage 2: the incident memory is a queued job (not written inside the CI request).
    const incidentJob = await waitForJob(client, r.body.incident?.memory?.jobId);
    check(
      r.body.incident?.memory?.queued === true && incidentJob?.status === "succeeded",
      "incident memory written to Hindsight (queued job succeeded)",
      `queued=${r.body.incident?.memory?.queued}, job=${incidentJob?.status ?? "timeout"} ${incidentJob?.last_error ?? ""}`
    );
    created.push({ ...t, payload, incident });
  }

  // --- 5. duplicates -----------------------------------------------------------
  console.log("\n5. Duplicate protection");
  const b = created.find((c) => c.name.startsWith("B"));
  if (!b) throw new Error("test incident B was not created, cannot continue");

  const retry = await report(b.payload, "FAILED", { failure: b.failure });
  check(
    retry.status === 200 && retry.body.incident?.created === false && retry.body.incident?.id === b.incident.id,
    "repeated FAILED report reuses the same incident",
    `HTTP ${retry.status}, incident #${retry.body.incident?.id}`
  );
  check((await lookup(b.payload.after)).incidents.length === 1, "still exactly one incident after the retry");

  await report(b.payload, "BUILDING"); // "Re-run jobs" in GitHub
  const rerun = await report(b.payload, "FAILED", { failure: b.failure });
  check(
    rerun.status === 200 && rerun.body.incident?.id === b.incident.id,
    "a re-run that fails again reuses the same incident"
  );
  check((await lookup(b.payload.after)).incidents.length === 1, "still exactly one incident after the re-run");

  // --- 6. Hindsight recall ------------------------------------------------------
  console.log("\n6. Hindsight recall");
  const exact = await recallMemories("database connection timeout", `incident:${b.incident.id}`);
  const exactHit = exact.ok && exact.body.count > 0;
  check(
    exactHit,
    `incident #${b.incident.id} recalled by its tag`,
    exact.ok ? `${exact.body.count} memory/memories` : exact.body.detail ?? "request failed"
  );

  const question = "Have we seen a database connection timeout before?";
  const similar = await recallMemories(question, "incident");
  const mentionsTimeout = (similar.body.memories ?? []).some(
    (m) => /timeout|ETIMEDOUT/i.test(m.text) && /database|5432/i.test(m.text)
  );
  check(
    similar.ok && mentionsTimeout,
    "semantic recall across incidents finds the database timeout",
    similar.ok ? `${similar.body.count} incident memory/memories` : similar.body.detail ?? "request failed"
  );

  if (similar.ok) {
    console.log(`\n  Query: "${question}"`);
    for (const memory of (similar.body.memories ?? []).slice(0, 3)) {
      console.log("  ----------------------------------------------------------");
      console.log("  " + memory.text.split("\n").slice(0, 4).join("\n  "));
      if (memory.incidentId) console.log(`  [incident #${memory.incidentId}, deployment #${memory.deploymentId}]`);
    }
  }
} catch (error) {
  fail("unexpected error", error.message);
} finally {
  await client.end();
}

console.log(
  failures === 0
    ? "\nPhase 4 verified: every step passed.\n"
    : `\n${failures} check(s) failed. See above.\n`
);
process.exitCode = failures === 0 ? 0 : 1;
