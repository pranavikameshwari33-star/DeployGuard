/**
 * End-to-end check for Phase 8 (automatic risk analysis + dashboard). Run with
 * the migration applied and the dev server up:
 *
 *   npm run db:migrate       (once, adds the risk-analysis status columns)
 *   npm run dev              (terminal 1)
 *   npm run verify:phase8    (terminal 2)
 *
 *   1  a new push automatically triggers risk analysis (after the webhook responds)
 *   2  the risk result is stored
 *   3-8  the dashboard can read risk, change analysis, historical evidence,
 *        pipeline state, deployment history and incident history
 *   9  loading the dashboard does not trigger Gemini
 *   10 a CI result refreshes the analysis exactly once; a repeated report reuses it
 *   11 an unavailable analysis leaves the deployment intact and shows no risk level
 *
 * Makes about 2 Gemini calls (initial analysis + one refresh after CI).
 * Uses its own repository (demo-owner/phase8-<random>); commit messages start
 * with "[DeployGuard verification]". No secret is printed.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import pg from "pg";
import { loadEnv } from "./load-env.mjs";
import { internalFetch } from "./internal-fetch.mjs";
import { buildPushPayload, deliver } from "./test-payload.mjs";

loadEnv();

const BASE = process.env.APP_URL || "http://localhost:3000";
const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
const statusToken = process.env.DEPLOYGUARD_STATUS_TOKEN;
const connectionString = process.env.DATABASE_URL;
const DEV_LOG = ".next/dev/logs/next-development.log";

let failures = 0;
const pass = (step, detail = "") => console.log(`  PASS  ${step}${detail ? " -- " + detail : ""}`);
const fail = (step, detail = "") => {
  failures++;
  console.log(`  FAIL  ${step}${detail ? " -- " + detail : ""}`);
};
const check = (ok, step, detail) => (ok ? pass(step, detail) : fail(step, detail));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REPO = `phase8-${crypto.randomBytes(4).toString("hex")}`;
const LABEL = "[DeployGuard verification] Phase 8";

const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString ?? "");
const client = new pg.Client({ connectionString, ssl: isLocal ? undefined : { rejectUnauthorized: false } });

async function push(message, files, autoRisk = false) {
  const payload = buildPushPayload({
    message: `${LABEL}: ${message}`,
    added: files.added ?? [],
    modified: files.modified ?? [],
    removed: files.removed ?? [],
  });
  payload.repository = { ...payload.repository, name: REPO, full_name: `demo-owner/${REPO}` };
  const started = Date.now();
  const result = await deliver(`${BASE}/api/webhook/github`, payload, webhookSecret, "push", { autoRisk });
  if (result.status !== 200 || !result.body.ok) throw new Error(`webhook refused push: HTTP ${result.status}`);
  return { payload, id: String(result.body.deploymentId), body: result.body, ms: Date.now() - started };
}

async function report(pushed, status, failure) {
  const response = await fetch(`${BASE}/api/deployments/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${statusToken}` },
    body: JSON.stringify({
      repository: `demo-owner/${REPO}`,
      branch: "main",
      commitSha: pushed.payload.after,
      status,
      runId: "8888",
      runUrl: `https://github.com/demo-owner/${REPO}/actions/runs/8888`,
      ...(failure ? { failure } : {}),
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`status report ${status} failed: HTTP ${response.status}`);
  return body;
}

async function dashboard(id) {
  const response = await internalFetch(`${BASE}/api/dashboard${id ? `?id=${id}` : ""}`);
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function riskState(id) {
  const { rows } = await client.query(
    `SELECT d.risk_analysis_status, d.risk_analysis_error, d.risk_analysis_updated_at,
            (SELECT count(*)::int FROM risk_assessments r WHERE r.deployment_id = d.id) AS assessments
     FROM deployments d WHERE d.id = $1`,
    [id]
  );
  return rows[0];
}

/** Waits (reading the database only) until the analysis for `id` is no longer pending. */
async function waitForAnalysis(id, { minAssessments = 1, timeoutMs = 240_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let state;
  while (Date.now() < deadline) {
    state = await riskState(id);
    if (state.risk_analysis_status === "unavailable") return state;
    if (state.risk_analysis_status === "completed" && state.assessments >= minAssessments) return state;
    await sleep(3000);
  }
  return state;
}

function logLinesMatching(pattern) {
  try {
    return fs.readFileSync(DEV_LOG, "utf8").split("\n").filter((l) => pattern.test(l)).length;
  } catch {
    return null;
  }
}

console.log(`\nDeployGuard - Phase 8 verification (automatic risk + dashboard)\nTest repository: demo-owner/${REPO}\n`);

try {
  await client.connect();
  const { rows: cols } = await client.query(
    `SELECT count(*)::int AS n FROM information_schema.columns
     WHERE table_name = 'deployments' AND column_name IN ('risk_analysis_status', 'risk_analysis_error', 'risk_analysis_attempt')`
  );
  if (cols[0].n !== 3) {
    fail("risk-analysis status columns are missing", "run: npm run db:migrate");
    process.exit(1);
  }

  // --- history (no automatic analysis, to save Gemini calls) ------------------------
  console.log("Building labelled history");
  const failed = await push("reduce database connection pool size", { modified: ["config/database.yaml", "src/db/pool.ts"] });
  await report(failed, "BUILDING");
  await report(failed, "FAILED", {
    stage: "integration-test",
    job: "integration-tests",
    message: "Error: connect ETIMEDOUT 10.0.3.12:5432\nDatabase connection timeout after 10000ms",
  });
  const succeeded = await push("add read replica to database config", { modified: ["config/database.yaml", "src/db/replica.ts"] });
  await report(succeeded, "BUILDING");
  await report(succeeded, "SUCCESS");
  const skipped = await push("history push without automatic analysis", { modified: ["README.md"] });
  check(skipped.body.riskAnalysis === "skipped" && (await riskState(skipped.id)).risk_analysis_status === null,
    "opted-out verification pushes are not analysed");
  pass("history created", `#${failed.id} FAILED db, #${succeeded.id} SUCCESS db`);

  // --- 1. automatic analysis on push ---------------------------------------------------
  console.log("\n1. Automatic risk analysis on push");
  const current = await push("increase database pool timeout", { modified: ["config/database.yaml", "src/db/pool.ts"] }, true);
  check(current.body.riskAnalysis === "scheduled", "webhook scheduled the analysis", `webhook answered in ${current.ms} ms`);
  check(current.ms < 10_000, "webhook did not wait for Gemini", `${current.ms} ms`);
  const early = await riskState(current.id);
  check(early !== undefined, "deployment row exists immediately after the webhook", `analysis state: ${early?.risk_analysis_status ?? "not started yet"}`);

  const first = await waitForAnalysis(current.id);
  check(first?.risk_analysis_status === "completed", "analysis completed automatically", first?.risk_analysis_error ?? first?.risk_analysis_status);

  // --- 2. stored ------------------------------------------------------------------------
  console.log("\n2. Risk result stored");
  check(first?.assessments === 1, "exactly one assessment stored", `${first?.assessments} row(s)`);

  // --- 3-8. dashboard data ------------------------------------------------------------
  console.log("\n3-8. Dashboard data");
  const dash = await dashboard(current.id);
  const sel = dash.body.selected;
  check(dash.status === 200 && sel?.deployment?.id === current.id, "dashboard API returns the deployment");
  check(
    sel?.risk?.state === "assessed" && ["LOW", "MEDIUM", "HIGH"].includes(sel.risk.assessment.risk_level) &&
      sel.risk.assessment.risk_reasons.length > 0 && sel.risk.assessment.recommended_checks.length > 0,
    "3. risk level, reasons and recommended checks",
    sel?.risk?.assessment?.risk_level ?? sel?.risk?.state
  );
  check(
    sel?.deployment?.file_analysis?.length === 2 && sel.deployment.change_categories?.includes("database") &&
      sel.deployment.affected_services?.includes("database"),
    "4. change analysis (files, categories, components)",
    sel?.deployment?.change_categories?.join(", ")
  );
  const evidenceIds = (sel?.evidence?.matches ?? []).map((m) => m.deployment_id);
  check(
    sel?.evidence?.source === "assessment" && evidenceIds.includes(failed.id) && evidenceIds.includes(succeeded.id),
    "5. historical evidence (failed and successful)",
    evidenceIds.map((i) => "#" + i).join(", ")
  );
  const failedDash = (await dashboard(failed.id)).body.selected;
  check(
    sel?.deployment?.status === "RECEIVED" &&
      failedDash?.deployment?.failure?.stage === "integration-test" && failedDash?.deployment?.ci_run_url &&
      failedDash?.incident?.root_cause === null,
    "6. pipeline state (incl. failure stage, run link, unknown root cause kept null)"
  );
  check(dash.body.history?.some((r) => r.id === current.id && r.risk_level), "7. deployment history includes the new row with its risk");
  check(dash.body.incidents?.some((i) => i.deployment_id === failed.id), "8. incident history includes the recorded incident");

  // --- 9. dashboard loads never call Gemini ------------------------------------------
  console.log("\n9. Loading the dashboard does not trigger Gemini");
  const before = await riskState(current.id);
  const geminiLinesBefore = logLinesMatching(/\[DeployGuard\]\[(risk|gemini)\]/);
  const page = await internalFetch(`${BASE}/?id=${current.id}`);
  const html = await page.text();
  for (let i = 0; i < 3; i++) {
    await internalFetch(`${BASE}/`);
    await dashboard(current.id);
  }
  await sleep(1500);
  const afterLoads = await riskState(current.id);
  const geminiLinesAfter = logLinesMatching(/\[DeployGuard\]\[(risk|gemini)\]/);
  check(
    afterLoads.assessments === before.assessments &&
      String(afterLoads.risk_analysis_updated_at) === String(before.risk_analysis_updated_at),
    "8 page/API loads created no assessment and started no analysis"
  );
  if (geminiLinesBefore !== null) {
    check(geminiLinesAfter === geminiLinesBefore, "no risk/Gemini activity in the server log during the loads");
  }
  check(
    page.ok && ["Current deployment", "Deployment risk", "Change analysis", "Historical evidence", "Pipeline", "Deployment history", "Incident history"].every((s) => html.includes(s)),
    "page renders every dashboard section"
  );
  const cssLinks = [...html.matchAll(/href="(\/_next\/static\/[^"]+\.css)"/g)].map((m) => m[1]);
  const css = (await Promise.all(cssLinks.map(async (l) => (await fetch(BASE + l)).text()))).join("\n");
  const families = new Set([...css.matchAll(/font-family:\s*([^;}]+)/g)].map((m) => m[1].trim()));
  check(
    [...families].every((f) => /open[ _]sans|inherit/i.test(f)) && [...families].some((f) => /open[ _]sans/i.test(f)),
    "every font-family in the page CSS is Open Sans (or inherits it)",
    [...families].join(" | ")
  );

  // --- 10. refresh after CI --------------------------------------------------------------
  console.log("\n10. Refresh after the CI result");
  const building = await report(current, "BUILDING");
  check(building.riskAnalysis === "not scheduled", "BUILDING does not trigger a new analysis");
  const success = await report(current, "SUCCESS");
  check(success.riskAnalysis === "refresh scheduled", "SUCCESS schedules a refresh");
  const refreshed = await waitForAnalysis(current.id, { minAssessments: 2 });
  check(refreshed?.risk_analysis_status === "completed" && refreshed.assessments === 2, "refresh produced one new assessment", `${refreshed?.assessments} row(s)`);
  const latest = (await dashboard(current.id)).body.selected;
  check(latest?.risk?.basedOnPipeline === "SUCCESS" && latest?.risk?.note === null, "dashboard now shows the assessment based on SUCCESS");

  const repeat = await report(current, "SUCCESS");
  await sleep(2000);
  const afterRepeat = await waitForAnalysis(current.id, { minAssessments: 2 });
  check(
    repeat.riskAnalysis === "refresh scheduled" && afterRepeat.assessments === 2 && afterRepeat.risk_analysis_status === "completed",
    "a repeated SUCCESS report reuses the stored assessment (no duplicate)",
    `${afterRepeat.assessments} row(s)`
  );

  // --- 11. unavailable analysis ---------------------------------------------------------
  console.log("\n11. Unavailable analysis");
  const lonely = await push("unanalysed tooling change", { added: ["tools/lint-rules/no-console-rule.js"] });
  await client.query(
    `UPDATE deployments SET risk_analysis_status = 'unavailable',
       risk_analysis_error = 'Gemini did not answer within 60s. (simulated by verify-phase8)', risk_analysis_updated_at = now()
     WHERE id = $1 AND repository = $2`,
    [lonely.id, REPO]
  );
  const u = (await dashboard(lonely.id)).body.selected;
  check(u?.deployment?.id === lonely.id && u.deployment.status === "RECEIVED", "deployment record is intact");
  check(u?.risk?.state === "unavailable" && !u.risk.assessment, "shown as unavailable, with no risk level", u?.risk?.error);
  const uPage = await (await internalFetch(`${BASE}/?id=${lonely.id}`)).text();
  check(uPage.includes("Risk analysis unavailable") && !/risk-level/.test(uPage), "page says 'Risk analysis unavailable' and shows no level");
} catch (error) {
  fail("unexpected error", error.message);
} finally {
  await client.end();
}

console.log(failures === 0 ? "\nPhase 8 verified: every step passed.\n" : `\n${failures} check(s) failed. See above.\n`);
process.exitCode = failures === 0 ? 0 : 1;
