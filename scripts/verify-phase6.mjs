/**
 * End-to-end check for Phase 6 (historical similarity & recall). Run with the
 * dev server up:
 *
 *   npm run dev              (terminal 1)
 *   npm run verify:phase6    (terminal 2)
 *
 * Builds a small, clearly labelled history through the REAL webhook and status
 * endpoints, then asks GET /api/deployments/similar about new deployments:
 *
 *   A same file        B same service      C same category
 *   D unrelated docs change is not returned
 *   E failed history carries its failure + incident
 *   F successful history is returned as SUCCESS
 *   G a deployment never matches itself
 *   H every match explains itself with signals
 *   I database + Hindsight hits are merged, not duplicated
 *   J Hindsight recalls the recorded database timeout
 *
 * Each run uses its own repository name (demo-owner/phase6-<random>), so the
 * results only ever involve this run's test data. Commit messages start with
 * "[DeployGuard verification]". No existing data is modified. No secret is printed.
 */
import crypto from "node:crypto";
import { loadEnv } from "./load-env.mjs";
import { internalFetch } from "./internal-fetch.mjs";
import { buildPushPayload, deliver } from "./test-payload.mjs";

loadEnv();

const BASE = process.env.APP_URL || "http://localhost:3000";
const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
const statusToken = process.env.DEPLOYGUARD_STATUS_TOKEN;

for (const [name, value] of Object.entries({
  GITHUB_WEBHOOK_SECRET: webhookSecret,
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

const REPO = `phase6-${crypto.randomBytes(4).toString("hex")}`;
const LABEL = "[DeployGuard verification] Phase 6";

/** A push to this run's own test repository, delivered through the real webhook. */
async function push(message, files) {
  const payload = buildPushPayload({
    message: `${LABEL}: ${message}`,
    added: files.added ?? [],
    modified: files.modified ?? [],
    removed: files.removed ?? [],
  });
  payload.repository = { ...payload.repository, name: REPO, full_name: `demo-owner/${REPO}` };
  const result = await deliver(`${BASE}/api/webhook/github`, payload, webhookSecret);
  if (result.status !== 200 || !result.body.ok) {
    throw new Error(`webhook did not accept the push: HTTP ${result.status} ${JSON.stringify(result.body)}`);
  }
  return { payload, id: String(result.body.deploymentId) };
}

/** Reports a pipeline status exactly as scripts/report-status.mjs does. */
async function report(pushed, status, failure) {
  const response = await fetch(`${BASE}/api/deployments/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${statusToken}` },
    body: JSON.stringify({
      repository: `demo-owner/${REPO}`,
      branch: "main",
      commitSha: pushed.payload.after,
      status,
      runId: "6666",
      runUrl: `https://github.com/demo-owner/${REPO}/actions/runs/6666`,
      ...(failure ? { failure } : {}),
    }),
  });
  if (!response.ok) throw new Error(`status report ${status} failed: HTTP ${response.status}`);
}

async function similar(id, query = "") {
  const response = await internalFetch(`${BASE}/api/deployments/similar?id=${id}${query}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`similar failed: HTTP ${response.status} ${JSON.stringify(body)}`);
  return body;
}

const find = (result, id) => result.matches.filter((m) => m.deployment_id === id);
const signalsOf = (match) => match?.matched_signals?.map((s) => `${s.signal}:${s.value}`) ?? [];

console.log(`\nDeployGuard - Phase 6 verification (historical similarity)\nTest repository: demo-owner/${REPO}\n`);

try {
  // --- history ----------------------------------------------------------------
  console.log("Building labelled history");
  const dbFailure = await push("reduce database connection pool size", {
    modified: ["config/database.yaml", "src/db/pool.ts"],
  });
  await report(dbFailure, "BUILDING");
  await report(dbFailure, "FAILED", {
    stage: "integration-test",
    job: "integration-tests",
    message: "Error: connect ETIMEDOUT 10.0.3.12:5432\nDatabase connection timeout after 10000ms",
  });

  const paymentSuccess = await push("tighten refund validation", {
    modified: ["payment-service/refund.ts"],
  });
  await report(paymentSuccess, "BUILDING");
  await report(paymentSuccess, "SUCCESS");

  const dbTests = await push("add connection retry tests", {
    added: ["tests/db/connection.test.ts"],
  });
  await report(dbTests, "BUILDING");
  await report(dbTests, "SUCCESS");

  const docs = await push("rewrite the contributor guide", {
    modified: ["README.md", "docs/guide.md"],
  });
  await report(docs, "BUILDING");
  await report(docs, "SUCCESS");
  pass("history created", `#${dbFailure.id} FAILED db, #${paymentSuccess.id} SUCCESS payment, #${dbTests.id} SUCCESS db tests, #${docs.id} SUCCESS docs`);

  // --- current deployments (RECEIVED, not yet built) -------------------------
  const currentDb = await push("increase database pool timeout", {
    modified: ["config/database.yaml", "src/db/pool.ts"],
  });
  const currentPayment = await push("support partial checkout", {
    modified: ["payment-service/checkout.ts"],
  });
  const currentSeed = await push("seed default users", { added: ["db/seeds/users.sql"] });

  const dbResult = await similar(currentDb.id);
  const payResult = await similar(currentPayment.id);
  const seedResult = await similar(currentSeed.id);

  // --- A. same file -------------------------------------------------------------
  console.log("\nA. Same file");
  const [a] = find(dbResult, dbFailure.id);
  check(
    a && signalsOf(a).includes("shared_file:config/database.yaml"),
    `#${dbFailure.id} matched on shared file config/database.yaml`,
    a ? `score ${a.similarity_score} (${a.relevance})` : "not returned"
  );

  // --- B. same service ------------------------------------------------------------
  console.log("\nB. Same service");
  const [b] = find(payResult, paymentSuccess.id);
  check(
    b && signalsOf(b).includes("same_service:payment-service"),
    `#${paymentSuccess.id} matched on service payment-service (different file)`,
    b ? `score ${b.similarity_score} (${b.relevance})` : "not returned"
  );

  // --- C. same category -------------------------------------------------------------
  console.log("\nC. Same category");
  const [c] = find(seedResult, dbTests.id);
  check(
    c && signalsOf(c).includes("same_category:database") && !c.matched_signals.some((s) => s.signal === "shared_file"),
    `#${dbTests.id} matched on category database alone`,
    c ? `score ${c.similarity_score} (${c.relevance})` : "not returned"
  );

  // --- D. unrelated -------------------------------------------------------------------
  console.log("\nD. Unrelated deployment");
  check(find(payResult, docs.id).length === 0, `docs-only #${docs.id} is not returned for the payment change`);
  check(find(dbResult, docs.id).length === 0, `docs-only #${docs.id} is not returned for the database change`);

  // --- E. failed history ------------------------------------------------------------
  console.log("\nE. Failed historical deployment");
  check(
    a?.status === "FAILED" &&
      a.failure?.stage === "integration-test" &&
      a.failure?.job === "integration-tests" &&
      a.incident?.id &&
      a.incident?.failure_type === "integration_test_failure" &&
      a.incident?.error_message?.includes("Database connection timeout"),
    "match carries status FAILED, failure stage/job/output and its incident",
    a?.incident ? `incident #${a.incident.id}` : "no incident"
  );
  check(
    a && a.incident?.root_cause === null && a.incident?.resolution === null,
    "unknown root cause and resolution stay null"
  );
  check(a?.relevance === "strong", "identical files + service is a strong match", a?.relevance);

  // --- F. successful history ----------------------------------------------------------
  console.log("\nF. Successful historical deployment");
  check(
    b?.status === "SUCCESS" && b.failure === null && b.incident === null,
    `#${paymentSuccess.id} returned as SUCCESS with no failure or incident`
  );

  // --- G. self-match ------------------------------------------------------------------
  console.log("\nG. Self-match prevention");
  const selfCheck = await similar(dbFailure.id);
  check(
    [
      [dbResult, currentDb.id],
      [payResult, currentPayment.id],
      [seedResult, currentSeed.id],
      [selfCheck, dbFailure.id],
    ].every(([result, id]) => find(result, id).length === 0),
    "no deployment appears in its own results"
  );
  check(
    find(selfCheck, currentDb.id).length === 0,
    "later deployments are not treated as history of earlier ones"
  );

  // --- H. explanation ------------------------------------------------------------------
  console.log("\nH. Explanation");
  const all = [...dbResult.matches, ...payResult.matches, ...seedResult.matches];
  check(
    all.length > 0 && all.every((m) => m.matched_signals.length > 0 && m.matched_signals.every((s) => s.signal && s.value && s.points > 0)),
    "every match lists named signals with values and points",
    `${all.length} match(es) checked`
  );
  console.log(`   #${dbFailure.id} matched because: ${signalsOf(a).join(", ")}`);

  // --- I. deduplication ------------------------------------------------------------------
  console.log("\nI. Deduplication (database + Hindsight)");
  check(dbResult.hindsight?.used === true, "Hindsight recall ran", dbResult.hindsight?.error ?? `${dbResult.hindsight?.memories_recalled} memories`);
  check(find(dbResult, dbFailure.id).length === 1, `#${dbFailure.id} appears exactly once`);
  check(
    a?.sources?.includes("database") && a?.sources?.includes("hindsight"),
    `#${dbFailure.id} was found by both sources and merged`,
    `sources: ${a?.sources?.join(" + ")}`
  );
  const ids = dbResult.matches.map((m) => m.deployment_id);
  check(new Set(ids).size === ids.length, "no deployment id repeats in the evidence");
  const dbOnly = await similar(currentDb.id, "&hindsight=0");
  check(
    find(dbOnly, dbFailure.id)[0]?.sources?.join() === "database",
    "database-only mode still finds the match (Hindsight is supporting, not required)"
  );

  // --- J. Hindsight recall ----------------------------------------------------------------
  console.log("\nJ. Hindsight recall");
  const question = "Have we seen a database connection timeout before?";
  const response = await internalFetch(
    `${BASE}/api/memory/recall?q=${encodeURIComponent(question)}&tags=${encodeURIComponent(`repo:demo-owner/${REPO}`)}`
  );
  const recalled = await response.json().catch(() => ({}));
  const hit = (recalled.memories ?? []).find(
    (m) => /timeout|ETIMEDOUT/i.test(m.text) && m.deploymentId === dbFailure.id
  );
  check(response.ok && hit, `"${question}" recalls deployment #${dbFailure.id}`, hit ? hit.text.slice(0, 110) : `${recalled.count ?? 0} memories, none matched`);

  // --- demonstration ------------------------------------------------------------------------
  console.log("\nEvidence for the current database change (first match):");
  const shown = { ...a, recalled_memory_text: a?.recalled_memory_text?.slice(0, 1) };
  console.log(JSON.stringify(shown, null, 2).split("\n").map((l) => "   " + l).join("\n"));
} catch (error) {
  fail("unexpected error", error.message);
}

console.log(
  failures === 0
    ? "\nPhase 6 verified: every step passed.\n"
    : `\n${failures} check(s) failed. See above.\n`
);
process.exitCode = failures === 0 ? 0 : 1;
