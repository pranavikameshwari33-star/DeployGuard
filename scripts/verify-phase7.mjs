/**
 * End-to-end check for Phase 7 (AI deployment risk analysis). Run with the
 * migration applied and the dev server up:
 *
 *   npm run db:migrate       (once, adds risk_assessments)
 *   npm run dev              (terminal 1)
 *   npm run verify:phase7    (terminal 2)
 *
 *   A Gemini key detected (never printed); the trigger endpoint requires auth
 *   B a real evidence bundle (failed + successful history) gives a valid assessment
 *   C risk level is LOW / MEDIUM / HIGH
 *   D every cited deployment id was in the supplied evidence
 *   E no incident is invented
 *   F mixed outcomes are cited with their true recorded status
 *   G no history -> none claimed
 *   H malformed answers are rejected; the table refuses invalid levels
 *   I answers citing unsupplied deployments are rejected
 *   J the assessment is stored in Hindsight and can be recalled
 *   + the same facts reuse the stored assessment (no second Gemini call)
 *
 * Makes 2 Gemini calls. Tests H and I run the server's own validator on
 * deliberately broken answers, so they need no Gemini calls.
 *
 * Each run uses its own repository (demo-owner/phase7-<random>); commit
 * messages start with "[DeployGuard verification]". No secret is printed.
 */
import crypto from "node:crypto";
import pg from "pg";
import { loadEnv } from "./load-env.mjs";
import { internalFetch } from "./internal-fetch.mjs";
import { buildPushPayload, deliver } from "./test-payload.mjs";
import { validateRiskAssessment } from "../lib/risk/validate.ts";

loadEnv();

const BASE = process.env.APP_URL || "http://localhost:3000";
const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
const statusToken = process.env.DEPLOYGUARD_STATUS_TOKEN;
// Stage 1: the risk-analysis route is internal tooling; it accepts the internal token, not the CI status token.
const internalToken = process.env.DEPLOYGUARD_INTERNAL_TOKEN;
const connectionString = process.env.DATABASE_URL;

let failures = 0;
let geminiCalls = 0;
const pass = (step, detail = "") => console.log(`  PASS  ${step}${detail ? " -- " + detail : ""}`);
const fail = (step, detail = "") => {
  failures++;
  console.log(`  FAIL  ${step}${detail ? " -- " + detail : ""}`);
};
const check = (ok, step, detail) => (ok ? pass(step, detail) : fail(step, detail));

const REPO = `phase7-${crypto.randomBytes(4).toString("hex")}`;
const LABEL = "[DeployGuard verification] Phase 7";

const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString ?? "");
const client = new pg.Client({ connectionString, ssl: isLocal ? undefined : { rejectUnauthorized: false } });

async function push(message, files) {
  const payload = buildPushPayload({
    message: `${LABEL}: ${message}`,
    added: files.added ?? [],
    modified: files.modified ?? [],
    removed: files.removed ?? [],
  });
  payload.repository = { ...payload.repository, name: REPO, full_name: `demo-owner/${REPO}` };
  const result = await deliver(`${BASE}/api/webhook/github`, payload, webhookSecret);
  if (result.status !== 200 || !result.body.ok) throw new Error(`webhook refused push: HTTP ${result.status}`);
  return { payload, id: String(result.body.deploymentId) };
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
      runId: "7777",
      runUrl: `https://github.com/demo-owner/${REPO}/actions/runs/7777`,
      ...(failure ? { failure } : {}),
    }),
  });
  if (!response.ok) throw new Error(`status report ${status} failed: HTTP ${response.status}`);
}

async function assess(id, { token = internalToken, countsAsGemini = true } = {}) {
  const response = await fetch(`${BASE}/api/deployments/risk?id=${id}`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const body = await response.json().catch(() => ({}));
  // Every request that reached Gemini: success, invalid answer, or Gemini error (excluding server-side retries).
  if (countsAsGemini && (body.source === "gemini" || body.status === "unavailable")) geminiCalls++;
  return { status: response.status, body };
}

/** Turns a stored assessment back into the shape Gemini returns, for validator tests. */
function asModelOutput(a) {
  return {
    risk_level: a.risk_level,
    confidence: a.risk_confidence,
    summary: a.risk_summary,
    historical_evidence_available: a.evidence.historical_evidence.available,
    reasons: a.risk_reasons,
    historical_evidence: a.historical_evidence.map((h) => ({
      deployment_id: h.deployment_id,
      outcome: h.outcome,
      relevance_note: h.relevance_note,
    })),
    missing_information: a.missing_information,
    recommended_checks: a.recommended_checks,
  };
}

const citedIds = (a) => [
  ...a.risk_reasons.flatMap((r) => r.evidence_deployment_ids),
  ...a.historical_evidence.map((h) => h.deployment_id),
];

console.log(`\nDeployGuard - Phase 7 verification (AI risk analysis)\nTest repository: demo-owner/${REPO}\n`);

try {
  // --- A. configuration ----------------------------------------------------------
  console.log("A. Gemini configuration");
  check(Boolean(process.env.GEMINI_API_KEY), "GEMINI_API_KEY is set in the environment (value not shown)");
  check(Boolean(webhookSecret && statusToken && connectionString), "webhook secret, status token and DATABASE_URL are set");
  await client.connect();
  const { rows: table } = await client.query(`SELECT to_regclass('public.risk_assessments') AS t`);
  if (!table[0].t) {
    fail("risk_assessments table is missing", "run: npm run db:migrate");
    process.exit(1);
  }
  pass("risk_assessments table exists");

  // --- history + current deployments ---------------------------------------------------
  console.log("\nBuilding labelled history");
  const failedDb = await push("reduce database connection pool size", { modified: ["config/database.yaml", "src/db/pool.ts"] });
  await report(failedDb, "BUILDING");
  await report(failedDb, "FAILED", {
    stage: "integration-test",
    job: "integration-tests",
    message: "Error: connect ETIMEDOUT 10.0.3.12:5432\nDatabase connection timeout after 10000ms",
  });
  const successDb = await push("add read replica to database config", { modified: ["config/database.yaml", "src/db/replica.ts"] });
  await report(successDb, "BUILDING");
  await report(successDb, "SUCCESS");
  const payment = await push("tighten refund validation", { modified: ["payment-service/refund.ts"] });
  await report(payment, "BUILDING");
  await report(payment, "SUCCESS");
  pass("history created", `#${failedDb.id} FAILED db, #${successDb.id} SUCCESS db, #${payment.id} SUCCESS payment`);

  const current = await push("increase database pool timeout", { modified: ["config/database.yaml", "src/db/pool.ts"] });
  const isolated = await push("add custom lint rule", { added: ["tools/lint-rules/no-console-rule.js"] });
  pass("current deployments created (not yet built)", `#${current.id} database change, #${isolated.id} unrelated tooling change`);

  const unauth = await assess(current.id, { token: "", countsAsGemini: false });
  check(unauth.status === 401, "risk trigger without the token is rejected", `HTTP ${unauth.status}`);

  // --- B/C/D. assessment with mixed history ------------------------------------------------
  console.log("\nB. Evidence bundle -> Gemini -> validated assessment");
  const first = await assess(current.id);
  const a = first.body.riskAssessment;
  check(
    first.status === 200 && first.body.status === "assessed" && first.body.source === "gemini" && a,
    "Gemini produced an assessment that passed validation",
    first.status === 200 ? `assessment #${a?.id}, model ${a?.model}` : `HTTP ${first.status} ${first.body.reason ?? ""} ${(first.body.errors ?? [first.body.message]).join("; ")}`
  );
  if (!a) throw new Error("no assessment to check further");

  const supplied = a.evidence.historical_evidence.matches.map((m) => m.deployment_id);
  check(
    supplied.includes(failedDb.id) && supplied.includes(successDb.id) && !supplied.includes(current.id),
    "bundle contained the failed and the successful history, not the deployment itself",
    `supplied: ${supplied.map((s) => "#" + s).join(", ")}`
  );
  check(a.evidence.current_pipeline.status === "RECEIVED", "bundle marks the pipeline as not yet run", a.evidence.current_pipeline.state);

  console.log("\nC. Risk level");
  check(["LOW", "MEDIUM", "HIGH"].includes(a.risk_level), "risk level is LOW/MEDIUM/HIGH", a.risk_level);
  check(a.risk_confidence >= 0 && a.risk_confidence <= 1, "confidence is within 0-1", String(a.risk_confidence));

  console.log("\nD. Evidence grounding");
  const cited = citedIds(a);
  check(cited.length > 0 && cited.every((id) => supplied.includes(id)), "every cited deployment id was supplied", `cited: ${[...new Set(cited)].map((s) => "#" + s).join(", ")}`);

  // --- E. no invented incident ------------------------------------------------------------
  console.log("\nE. No invented incident");
  const { rows: incidents } = await client.query(
    `SELECT d.id FROM incidents i JOIN deployments d ON d.id = i.deployment_id
     WHERE d.owner = 'demo-owner' AND d.repository = $1`,
    [REPO]
  );
  check(
    incidents.length === 1 && String(incidents[0].id) === failedDb.id,
    "the only incident in the test repository is the real one",
    `${incidents.length} incident(s)`
  );
  check(
    a.historical_evidence.every((h) => (h.deployment_id === failedDb.id ? h.incident_id !== null : h.incident_id === null)),
    "no cited deployment gained an incident it does not have"
  );

  // --- F. mixed outcomes ---------------------------------------------------------------
  console.log("\nF. Mixed historical outcomes");
  const counts = a.evidence.historical_evidence.outcome_counts;
  check(counts.SUCCESS >= 1 && counts.FAILED >= 1, "bundle had both outcomes", JSON.stringify(counts));
  const { rows: truth } = await client.query(`SELECT id::text, status FROM deployments WHERE id = ANY($1::bigint[])`, [
    a.historical_evidence.map((h) => h.deployment_id),
  ]);
  const actual = Object.fromEntries(truth.map((r) => [r.id, r.status]));
  check(
    a.historical_evidence.length > 0 && a.historical_evidence.every((h) => actual[h.deployment_id] === h.outcome),
    "every cited outcome matches the database",
    a.historical_evidence.map((h) => `#${h.deployment_id}=${h.outcome}`).join(", ")
  );
  check(cited.includes(failedDb.id), `the failed deployment #${failedDb.id} is cited`);
  console.log(`   successful #${successDb.id} cited: ${cited.includes(successDb.id) ? "yes" : "no"} (informational)`);

  // --- reuse -------------------------------------------------------------------------------
  console.log("\nReuse (no repeated Gemini call)");
  const again = await assess(current.id);
  check(
    again.body.source === "stored" && again.body.riskAssessment?.id === a.id,
    "same facts return the stored assessment",
    `source: ${again.body.source}`
  );
  const latest = await (await internalFetch(`${BASE}/api/deployments/risk?id=${current.id}`)).json();
  check(latest.riskAssessment?.id === a.id, "GET returns the latest stored assessment without calling Gemini");

  // --- G. no history ---------------------------------------------------------------------
  console.log("\nG. No historical matches");
  const lone = await assess(isolated.id);
  const g = lone.body.riskAssessment;
  check(lone.status === 200 && g, "assessment produced from current facts alone", lone.status === 200 ? g?.risk_level : `HTTP ${lone.status} ${(lone.body.errors ?? [lone.body.message]).join("; ")}`);
  if (g) {
    check(g.evidence.historical_evidence.matches.length === 0, "no history was supplied");
    check(
      g.historical_evidence_available === false &&
        g.historical_evidence.length === 0 &&
        g.risk_reasons.every((r) => r.basis !== "historical_evidence" && r.evidence_deployment_ids.length === 0),
      "no history is claimed or cited"
    );
    console.log(`   summary: ${g.risk_summary}`);
  }

  // --- H. invalid responses ----------------------------------------------------------------
  console.log("\nH. Invalid Gemini responses are rejected");
  const valid = asModelOutput(a);
  check(validateRiskAssessment(valid, a.evidence).ok, "control: the stored answer passes the validator");
  const broken = {
    "not a JSON object": "HIGH risk, trust me",
    "risk level CRITICAL": { ...valid, risk_level: "CRITICAL" },
    "confidence 1.7": { ...valid, confidence: 1.7 },
    "reasons missing": { ...valid, reasons: undefined },
    "no recommended checks": { ...valid, recommended_checks: [] },
  };
  for (const [name, output] of Object.entries(broken)) {
    const result = validateRiskAssessment(output, a.evidence);
    check(!result.ok, `rejected: ${name}`, result.ok ? "ACCEPTED" : result.errors[0]);
  }
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO risk_assessments (deployment_id, risk_level, risk_confidence, risk_summary, risk_reasons,
         historical_evidence, missing_information, recommended_checks, evidence, evidence_fingerprint, model)
       VALUES ($1, 'CRITICAL', 0.5, 'x', '[]', '[]', '[]', '[]', '{}', 'verify-phase7-probe', 'probe')`,
      [current.id]
    );
    fail("database accepted risk level CRITICAL");
  } catch (error) {
    pass("database itself refuses an invalid risk level", error.message.split("\n")[0]);
  } finally {
    await client.query("ROLLBACK");
  }
  const { rows: stored } = await client.query(
    `SELECT count(*)::int AS n FROM risk_assessments WHERE deployment_id = ANY($1::bigint[])`,
    [[current.id, isolated.id]]
  );
  // One row per SUCCESSFUL assessment; a rejected or failed Gemini answer stores nothing.
  const expectedRows = 1 + (g ? 1 : 0);
  check(stored[0].n === expectedRows, "exactly one stored row per successful assessment, none for rejected ones", `${stored[0].n} row(s)`);

  // --- I. unsupported evidence ids ------------------------------------------------------------
  console.log("\nI. Unsupported evidence ids are rejected");
  const ghost = "999999999";
  const cases = {
    "reason cites an unsupplied deployment": {
      ...valid,
      reasons: [...valid.reasons, { reason: "A similar deployment failed.", basis: "historical_evidence", evidence_deployment_ids: [ghost] }],
    },
    "historical_evidence cites an unsupplied deployment": {
      ...valid,
      historical_evidence: [...valid.historical_evidence, { deployment_id: ghost, outcome: "FAILED", relevance_note: "Similar." }],
    },
    "summary mentions an unsupplied deployment": { ...valid, summary: `${valid.summary} Deployment #${ghost} also failed.` },
    "a real deployment given the wrong outcome": {
      ...valid,
      historical_evidence: [{ deployment_id: failedDb.id, outcome: "SUCCESS", relevance_note: "Similar change." }],
    },
    "history claimed when none was supplied": { ...valid, historical_evidence_available: true },
  };
  // The same evidence with all history removed, for the last case.
  const noHistory = {
    ...a.evidence,
    historical_evidence: { available: false, match_count: 0, outcome_counts: {}, matches: [] },
  };
  for (const [name, output] of Object.entries(cases)) {
    const evidence = name.startsWith("history claimed") ? noHistory : a.evidence;
    const result = validateRiskAssessment(output, evidence);
    check(!result.ok, `rejected: ${name}`, result.ok ? "ACCEPTED" : result.errors[0]);
  }

  // --- J. Hindsight ------------------------------------------------------------------------
  console.log("\nJ. Hindsight");
  check(first.body.memory?.stored === true, "risk memory written to Hindsight", first.body.memory?.error ?? "");
  const q = `What was the risk assessment for deployment #${current.id}?`;
  const recall = await internalFetch(`${BASE}/api/memory/recall?q=${encodeURIComponent(q)}&tags=${encodeURIComponent(`deployment:${current.id}`)}`);
  const recalled = await recall.json().catch(() => ({}));
  const hit = (recalled.memories ?? []).find((m) => m.deploymentId === current.id && /risk|LOW|MEDIUM|HIGH/i.test(m.text));
  check(recall.ok && hit, "risk assessment recalled from Hindsight", hit ? hit.text.slice(0, 120) : `${recalled.count ?? 0} memories, none matched`);

  // --- demonstration ------------------------------------------------------------------------
  console.log(`\nRisk assessment for deployment #${current.id} (config/database.yaml + src/db/pool.ts):`);
  console.log(`   Risk: ${a.risk_level}  (model-reported confidence ${a.risk_confidence})`);
  console.log(`   Summary: ${a.risk_summary}`);
  for (const r of a.risk_reasons) {
    console.log(`   - [${r.basis}] ${r.reason}${r.evidence_deployment_ids.length ? ` (evidence: #${r.evidence_deployment_ids.join(", #")})` : ""}`);
  }
  console.log("   Historical evidence:");
  for (const h of a.historical_evidence) {
    console.log(`   - #${h.deployment_id} ${h.outcome}${h.observed_failure ? `: ${h.observed_failure.split("\n").pop()}` : ""}`);
  }
  console.log("   Recommended checks:");
  for (const c of a.recommended_checks) console.log(`   - ${c}`);
  if (a.missing_information.length) console.log(`   Missing information: ${a.missing_information.join("; ")}`);
} catch (error) {
  fail("unexpected error", error.message);
} finally {
  await client.end();
}

console.log(`\nGemini analysis requests made by this run: ${geminiCalls} (a request may retry up to 2 times on temporary Gemini errors)`);
console.log(failures === 0 ? "\nPhase 7 verified: every step passed.\n" : `\n${failures} check(s) failed. See above.\n`);
process.exitCode = failures === 0 ? 0 : 1;
