/**
 * End-to-end check for Phase 5 (change & affected-component detection). Run
 * with the migration applied and the dev server up:
 *
 *   npm run db:migrate       (once, adds the change-analysis columns)
 *   npm run dev              (terminal 1)
 *   npm run verify:phase5    (terminal 2)
 *
 * Prints PASS/FAIL for each link:
 *   1. classification of known examples (pure, no server needed)
 *   2. unknown files stay "unknown"
 *   3. added / modified / deleted are preserved, and the analysis is deterministic
 *   4. a real webhook push stores the analysis on its deployment row
 *   5. a redelivered push keeps one row with the same analysis
 *   6. the deployment memory carries the analysis and Hindsight can recall it
 *
 * Test pushes are labelled "[DeployGuard verification]" in demo-owner/demo-repo.
 * Existing deployments are never modified. No secret is printed.
 */
import assert from "node:assert/strict";
import pg from "pg";
import { loadEnv } from "./load-env.mjs";
import { waitForJob } from "./job-helpers.mjs";
import { internalFetch } from "./internal-fetch.mjs";
import { buildPushPayload, deliver } from "./test-payload.mjs";
import { analyzeChanges, classifyFile } from "../lib/analysis/change-analysis.ts";

loadEnv();

const BASE = process.env.APP_URL || "http://localhost:3000";
const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
const connectionString = process.env.DATABASE_URL;

for (const [name, value] of Object.entries({
  GITHUB_WEBHOOK_SECRET: webhookSecret,
  DATABASE_URL: connectionString,
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
const same = (a, b) => {
  try {
    assert.deepStrictEqual(a, b);
    return true;
  } catch {
    return false;
  }
};

/** [path, expected categories (canonical order), expected service or null]. Stage 5 added the finer categories. */
const EXAMPLES = [
  ["README.md", ["documentation"], null],
  ["package.json", ["dependencies", "dependency_manifest"], null],
  ["config/database.yaml", ["database", "configuration"], "database"],
  ["src/auth/login.ts", ["application_code", "authentication"], null],
  ["payment-service/checkout.ts", ["application_code", "payments"], "payment-service"],
  [".github/workflows/deploy.yml", ["infrastructure", "ci_cd"], null],
  ["tests/payment.test.ts", ["payments", "tests"], null],
  ["payment-service/tests/checkout.test.ts", ["payments", "tests"], "payment-service"],
  ["src/db/pool.ts", ["application_code", "database"], "database"],
  ["services/auth/login.ts", ["application_code", "authentication"], "auth"],
  ["frontend/components/Login.tsx", ["application_code", "authentication"], "frontend"],
  ["app/api/deployments/status/route.ts", ["application_code", "api"], null],
  ["db/migrations/001_deployments.sql", ["database", "migration"], "database"],
  ["k8s/deployment.yaml", ["infrastructure", "iac"], null],
  ["terraform/main.tf", ["infrastructure", "iac"], null],
  ["Dockerfile", ["infrastructure", "container"], null],
  ["docker-compose.yml", ["infrastructure", "container"], null],
  [".env.example", ["configuration", "environment"], null],
  ["next.config.ts", ["configuration"], null],
];

console.log("\nDeployGuard - Phase 5 verification (change analysis)\n");

// --- 1. classification ---------------------------------------------------------
console.log("1. Classification");
for (const [path, categories, service] of EXAMPLES) {
  const result = classifyFile(path, "modified");
  check(
    same(result.categories, categories) && result.service === service,
    `${path} -> ${categories.join(" + ")}${service ? ` [${service}]` : ""}`,
    same(result.categories, categories) && result.service === service
      ? ""
      : `got ${result.categories.join(" + ")} [${result.service}]`
  );
}

// --- 2. unknown ------------------------------------------------------------------
console.log("\n2. Unknown files");
const weird = classifyFile("misc/something.weird", "added");
check(
  same(weird.categories, ["unknown"]) && weird.service === null,
  "misc/something.weird -> unknown, no service",
  `got ${weird.categories.join(" + ")} [${weird.service}]`
);

// --- 3. change types + determinism ------------------------------------------------
console.log("\n3. Change types");
const FILES = {
  added: ["payment-service/checkout.ts", "misc/something.weird"],
  modified: ["config/database.yaml", "src/db/pool.ts", ".github/workflows/deploy.yml"],
  deleted: ["services/auth/legacy-login.ts"],
};
const local = analyzeChanges(FILES);
const typeOf = (path) => local.files.find((f) => f.path === path)?.change_type;
check(typeOf("payment-service/checkout.ts") === "added", "added file keeps change_type added");
check(typeOf("config/database.yaml") === "modified", "modified file keeps change_type modified");
check(
  typeOf("services/auth/legacy-login.ts") === "deleted",
  "deleted file is kept, with change_type deleted"
);
check(local.files.length === 6, "every file appears in the analysis", `${local.files.length} of 6`);
check(same(analyzeChanges(FILES), local), "same input gives the same analysis");
check(
  same(local.services, ["auth", "database", "payment-service"]),
  "affected services/components",
  local.services.join(", ")
);

// --- 4-6. database + Hindsight through the real webhook -------------------------
const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString);
const client = new pg.Client({
  connectionString,
  ssl: isLocal ? undefined : { rejectUnauthorized: false },
});

async function recallMemories(query, tags) {
  const url = `${BASE}/api/memory/recall?q=${encodeURIComponent(query)}&tags=${encodeURIComponent(tags)}`;
  const response = await internalFetch(url);
  return { ok: response.ok, body: await response.json().catch(() => ({})) };
}

try {
  console.log("\n4. Database storage");
  await client.connect();
  const { rows: cols } = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'deployments'
       AND column_name IN ('file_analysis', 'change_categories', 'affected_services')`
  );
  if (cols.length !== 3) {
    fail("change-analysis columns are missing", "run: npm run db:migrate");
    process.exit(1);
  }
  pass("change-analysis columns exist");

  const payload = buildPushPayload({
    message: "[DeployGuard verification] Phase 5: payment checkout + database pool change",
    added: FILES.added,
    modified: FILES.modified,
    removed: FILES.deleted,
  });
  const first = await deliver(`${BASE}/api/webhook/github`, payload, webhookSecret);
  check(first.status === 200 && first.body.ok, "webhook accepted the push", `deployment #${first.body.deploymentId}`);

  const readRow = async () =>
    (
      await client.query(
        `SELECT id, file_analysis, change_categories, affected_services
         FROM deployments WHERE commit_sha = $1`,
        [payload.after]
      )
    ).rows;

  const rows = await readRow();
  const row = rows[0];
  check(rows.length === 1, "one deployment row for the push");
  check(same(row?.file_analysis, local.files), "file-level analysis stored and read back");
  check(
    same(row?.change_categories, local.categories),
    "change categories stored and read back",
    row?.change_categories?.join(", ")
  );
  check(
    same(row?.affected_services, local.services),
    "affected services/components stored and read back",
    row?.affected_services?.join(", ")
  );
  check(
    row?.file_analysis?.some((f) => f.path === "services/auth/legacy-login.ts" && f.change_type === "deleted"),
    "deleted file is stored in the analysis"
  );

  console.log("\n5. Redelivery");
  const second = await deliver(`${BASE}/api/webhook/github`, payload, webhookSecret);
  const again = await readRow();
  check(
    second.body.duplicate === true && again.length === 1 && same(again[0].file_analysis, row?.file_analysis),
    "duplicate delivery keeps one row with the same analysis"
  );

  console.log("\n6. Hindsight memory");
  // Stage 2: the Hindsight write is a queued job (not inside the webhook request).
  const memoryJob = await waitForJob(client, first.body.memory?.jobId);
  check(
    first.body.memory?.queued === true && memoryJob?.status === "succeeded",
    "deployment memory (with analysis) written (queued job succeeded)",
    `queued=${first.body.memory?.queued}, job=${memoryJob?.status ?? "timeout"} ${memoryJob?.last_error ?? ""}`
  );

  const shortSha = payload.after.slice(0, 7);
  const dbQuestion = "Which previous deployment changed database configuration?";
  const db = await recallMemories(dbQuestion, `commit:${shortSha}`);
  check(
    // The recall is filtered to this commit's tag. Hindsight rewords what it
    // stored (sometimes dropping "config"), so require only the database mention.
    db.ok && (db.body.memories ?? []).some((m) => /database/i.test(m.text)),
    "recall finds this deployment's database configuration change",
    db.ok ? `${db.body.count} memory/memories` : db.body.detail ?? "request failed"
  );

  const payQuestion = "Have we previously modified the payment service?";
  const pay = await recallMemories(payQuestion, "service:payment-service");
  check(
    pay.ok && (pay.body.memories ?? []).some((m) => /payment/i.test(m.text)),
    "recall by affected service finds the payment-service change",
    pay.ok ? `${pay.body.count} memory/memories` : pay.body.detail ?? "request failed"
  );

  for (const [question, result] of [[dbQuestion, db], [payQuestion, pay]]) {
    console.log(`\n  Query: "${question}"`);
    for (const memory of (result.body.memories ?? []).slice(0, 2)) {
      console.log("  ----------------------------------------------------------");
      console.log("  " + memory.text.split("\n").slice(0, 3).join("\n  "));
    }
  }
} catch (error) {
  fail("unexpected error", error.message);
} finally {
  await client.end();
}

console.log(
  failures === 0
    ? "\nPhase 5 verified: every step passed.\n"
    : `\n${failures} check(s) failed. See above.\n`
);
process.exitCode = failures === 0 ? 0 : 1;
