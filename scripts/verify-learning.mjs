/**
 * Stage 4 gate: learning features, through the REAL webhook, CI status route,
 * confirmation API, ask-history API and dashboard, as signed-in test users.
 * Dev server up:
 *
 *   npm run verify:learning
 *
 * Users: A owns repository a1, B owns b1. Pushes arrive through the webhook
 * as GitHub App pushes; CI results through POST /api/deployments/status.
 *
 *   4.1 confirmed causes: owner-only, same-origin, attributed, versioned,
 *       append-only, redacted, provenance-marked in the evidence bundle, one
 *       re-evaluation job per revision (superseded revisions do nothing)
 *   4.2 predictions immutable; outcomes recorded once per outcome, append-only
 *   4.3 patterns derived from incident records, flakes excluded, tenant-scoped
 *   4.4 flake: failed then passed on the same commit, both runs as evidence
 *   4.5 revert detection by SHA, attached as a database fact in evidence
 *   4.6 ask-history: record-backed statements only, scoped, refuses off-topic
 *
 * No Gemini call is made (automatic analysis off; assessments for 4.2 are
 * inserted as rows). Test data is purged from PostgreSQL and Hindsight at the end.
 */
import crypto from "node:crypto";
import { loadEnv } from "./load-env.mjs";
import { buildPushPayload, deliver } from "./test-payload.mjs";

loadEnv();
const BASE = process.env.APP_URL || "http://localhost:3000";
const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
const statusToken = process.env.DEPLOYGUARD_STATUS_TOKEN;
const internalToken = process.env.DEPLOYGUARD_INTERNAL_TOKEN;

let failures = 0;
const counts = { pass: 0, fail: 0 };
const check = (ok, step, detail = "") => {
  if (!ok) failures++;
  counts[ok ? "pass" : "fail"]++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${step}${detail ? " -- " + detail : ""}`);
};

const { getPool } = await import("@/lib/db/client");
const { purgeRepository } = await import("@/lib/lifecycle/purge");
const { buildRiskEvidence } = await import("@/lib/risk/evidence");
const { dependentDeployments, findFailurePatterns } = await import("@/lib/db/learning");
const db = getPool();
const RUN = crypto.randomBytes(3).toString("hex");
const rid = () => String(900000000000 + crypto.randomInt(1, 999_999_999));

const users = {};
const repos = {};
async function makeUser(name, repoNames) {
  const gh = 600000000000 + crypto.randomInt(1, 999_999_999);
  const login = `learn-${name}-${RUN}`;
  const id = (await db.query(`INSERT INTO users (github_user_id, github_login) VALUES ($1, $2) RETURNING id`, [gh, login])).rows[0].id;
  const installation = 800000000 + crypto.randomInt(1, 99_999_999);
  await db.query(`INSERT INTO github_installations (installation_id, user_id, status, github_account_login, account_type) VALUES ($1, $2, 'active', $3, 'User')`, [installation, id, login]);
  for (const r of repoNames) {
    const ghId = rid();
    await db.query(`INSERT INTO repositories (github_repository_id, installation_id, owner, name, full_name) VALUES ($1, $2, $3, $4, $5)`, [ghId, installation, login, r, `${login}/${r}`]);
    repos[r] = { ghId, full: `${login}/${r}`, owner: login, name: r, installation };
  }
  const token = crypto.randomBytes(32).toString("base64url");
  await db.query(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [id, crypto.createHash("sha256").update(token).digest("hex")]);
  users[name] = { id, login, installation, cookie: `dg_session=${token}` };
}
const page = async (user, path) => {
  const r = await fetch(`${BASE}${path}`, { headers: { Cookie: users[user].cookie }, redirect: "manual" });
  return { status: r.status, html: (await r.text()).replace(/<!-- -->/g, "") };
};
const api = async (user, path, { method = "GET", body, origin = BASE, bearer } = {}) => {
  const headers = { "Content-Type": "application/json" };
  if (user) headers.Cookie = users[user].cookie;
  if (origin) headers.Origin = origin;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
async function push(repoKey, message, files, sha) {
  const r = repos[repoKey];
  const payload = buildPushPayload({ message, modified: files, added: [], removed: [], ...(sha ? { sha } : {}) });
  payload.repository = { ...payload.repository, id: Number(r.ghId), name: r.name, full_name: r.full, owner: { login: r.owner, name: r.owner } };
  payload.installation = { id: r.installation };
  const res = await deliver(`${BASE}/api/webhook/github`, payload, webhookSecret, "push");
  if (res.status !== 200 || !res.body.deploymentId) throw new Error(`push to ${repoKey} failed: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
  return { id: String(res.body.deploymentId), sha: payload.after };
}
const ci = async (repoKey, sha, status, extra = {}) => {
  const res = await fetch(`${BASE}/api/deployments/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${statusToken}` },
    body: JSON.stringify({ repository: repos[repoKey].full, branch: "main", commitSha: sha, status, ...extra }),
  });
  if (!res.ok) throw new Error(`CI ${status} failed: HTTP ${res.status}`);
};
const runUrl = (repoKey, id) => `https://github.com/${repos[repoKey].full}/actions/runs/${id}`;
const fail = async (repoKey, sha, output, run) => {
  await ci(repoKey, sha, "BUILDING", { runId: run, runUrl: runUrl(repoKey, run) });
  await ci(repoKey, sha, "FAILED", { runId: run, runUrl: runUrl(repoKey, run), failure: { stage: "test", job: "ci / test", message: output } });
};
const incidentOf = async (deploymentId) => (await db.query(`SELECT * FROM incidents WHERE deployment_id = $1`, [deploymentId])).rows[0];
const refused = async (sql, params) => {
  try {
    await db.query(sql, params);
    return false;
  } catch {
    return true;
  }
};

console.log("DeployGuard Stage 4: learning features\n");
try {
  await makeUser("a", ["a1"]);
  await makeUser("b", ["b1"]);

  // History: two pool timeouts, one flaky failure, a revert, and a timeout in the other tenant.
  const d1 = await push("a1", "Tune pool size", ["src/db/pool.ts"]);
  await fail("a1", d1.sha, "npm test\nError: connect ETIMEDOUT 10.0.0.7:5432", "1001");
  const d2 = await push("a1", "Pool retries", ["src/db/pool.ts"]);
  await fail("a1", d2.sha, "Error: connect ETIMEDOUT 10.0.0.9:6543", "1002");
  const d3 = await push("a1", "Orders endpoint", ["src/api/orders.ts"]);
  await fail("a1", d3.sha, "Error: socket hang up", "1003");
  await ci("a1", d3.sha, "BUILDING", { runId: "1004", runUrl: runUrl("a1", "1004") });
  await ci("a1", d3.sha, "SUCCESS", { runId: "1004", runUrl: runUrl("a1", "1004") });
  const d4 = await push("a1", `Revert "Pool retries"\n\nThis reverts commit ${d2.sha}.`, ["src/db/pool.ts"]);
  const d5 = await push("a1", "Add revert button to the admin UI", ["src/ui/admin.tsx"]);
  const b1 = await push("b1", "B pool", ["src/db/pool.ts"]);
  await fail("b1", b1.sha, "Error: connect ETIMEDOUT 10.1.1.1:5432", "2001");
  const inc1 = await incidentOf(d1.id);
  const inc2 = await incidentOf(d2.id);
  const incB = await incidentOf(b1.id);
  check(Boolean(inc1 && inc2 && incB), "test history created through the real webhook and CI route");

  // --- 4.1 ------------------------------------------------------------------------------------
  console.log("\n4.1 Human-confirmed root cause");
  const path1 = `/api/incidents/confirmation?id=${inc1.id}`;
  const value = { root_cause: "Pool size set to 2 in config/database.yaml", resolution: "Raised the pool size to 20", affected_service: "db" };
  check((await api("a", path1, { method: "POST", body: value, origin: "https://evil.example" })).status === 403, "cross-origin POST is refused (CSRF)");
  check((await api("a", path1, { method: "POST", body: value, origin: null })).status === 403, "POST without Origin/Referer is refused");
  check((await api("b", path1, { method: "POST", body: value })).status === 404, "another user's incident reads as not found (404)");
  check((await api(null, path1, { method: "POST", body: value, origin: null, bearer: internalToken })).status === 403, "internal token cannot confirm: a person must");
  check((await api("a", path1, { method: "POST", body: { ...value, is_admin: true } })).status === 400, "unknown fields are refused");
  const before = await page("a", `/?incident=${inc1.id}`);
  check(before.html.includes("Not determined") && !before.html.includes("Pool size set to 2"), "before confirmation the cause reads \"Not determined\"");

  const c1 = await api("a", path1, { method: "POST", body: { ...value, base_revision: 0 } });
  check(c1.status === 200 && c1.body.revision === 1 && c1.body.provenance === "HUMAN-CONFIRMED", "owner confirms: revision 1, HUMAN-CONFIRMED", JSON.stringify(c1.body).slice(0, 120));
  const row1 = await incidentOf(d1.id);
  check(row1.confirmed_revision === 1 && row1.confirmed_by_login === users.a.login && row1.confirmed_at && row1.root_cause === value.root_cause,
    "incident stores the confirmed values with who and when");
  const again = await api("a", path1, { method: "POST", body: value });
  check(again.status === 200 && again.body.outcome === "unchanged", "saving identical values adds no revision");
  check((await api("a", path1, { method: "POST", body: { ...value, root_cause: "other", base_revision: 0 } })).status === 409, "a stale base_revision is refused (409), nothing overwritten");
  const leaked = "ghp_" + crypto.randomBytes(18).toString("hex");
  const c2 = await api("a", path1, { method: "POST", body: { ...value, resolution: `Rotated token ${leaked} and raised pool to 20`, base_revision: 1 } });
  check(c2.status === 200 && c2.body.revision === 2 && c2.body.redacted >= 1, "an edit is revision 2; a pasted token is masked");
  const revs = (await db.query(`SELECT revision, resolution, confirmed_by_login FROM incident_confirmations WHERE incident_id = $1 ORDER BY revision`, [inc1.id])).rows;
  check(revs.length === 2 && revs[0].resolution === value.resolution && !revs[1].resolution.includes(leaked), "edit history keeps both revisions; no raw token stored");
  check(await refused(`UPDATE incident_confirmations SET root_cause = 'x' WHERE incident_id = $1`, [inc1.id]), "confirmation revisions are append-only (UPDATE refused by the database)");
  const audit = (await db.query(`SELECT count(*)::int n FROM audit_log WHERE action = 'incident.confirm' AND actor = $1 AND outcome = 'ok'`, [`user:${users.a.id}`])).rows[0].n;
  check(audit === 2, "each confirmation is audit-logged (ids and revision only)", `${audit} entries`);
  const hist = await api("a", path1);
  check(hist.status === 200 && hist.body.history.length === 2 && hist.body.provenance === "HUMAN-CONFIRMED", "GET returns provenance and the edit history");
  const detail = await page("a", `/?incident=${inc1.id}`);
  check(detail.html.includes("Human-confirmed") && detail.html.includes("Edit history") && detail.html.includes(`@${users.a.login}`), "incident page shows the HUMAN-CONFIRMED label, attribution and history");

  // Evidence: the confirmed cause travels as a database row with provenance; unconfirmed stays null.
  const ev = await buildRiskEvidence(d2.id);
  const m1 = ev.evidence.historical_evidence.matches.find((m) => m.deployment_id === d1.id);
  check(m1?.incident?.provenance === "HUMAN-CONFIRMED" && m1.incident.root_cause === value.root_cause, "evidence bundle carries the confirmed cause with provenance HUMAN-CONFIRMED");
  check(ev.evidence.current_pipeline.incident?.provenance === "NOT DETERMINED" && ev.evidence.current_pipeline.incident.root_cause === null, "an unconfirmed incident stays NOT DETERMINED with root_cause null");
  check(ev.evidence.historical_evidence.matches.every((m) => m.deployment_id !== b1.id), "evidence never includes the other tenant's deployment");

  // Re-evaluation: one job per revision, delayed; a superseded revision does nothing.
  const jobs = (await db.query(`SELECT dedupe_key, status, run_at > now() AS delayed FROM jobs WHERE type = 'learning.reevaluate' AND payload->>'incidentId' = $1 ORDER BY id`, [inc1.id])).rows;
  check(jobs.length === 2 && jobs.every((j) => j.delayed && j.status === "queued"), "exactly one delayed re-evaluation job per revision", jobs.map((j) => j.dedupe_key).join(", "));
  // Run the revision-1 job now through the real queue (before any dependent exists, so even a bug could not reach Gemini).
  const riskJobs = async () => (await db.query(
    `SELECT count(*)::int n FROM jobs WHERE type = 'risk.analyze' AND payload->>'deploymentId' = ANY($1::text[])`, [[d1.id, d2.id, d3.id]])).rows[0].n;
  const r0 = await riskJobs();
  await db.query(`UPDATE jobs SET run_at = now() WHERE dedupe_key = $1`, [`learning.reevaluate:incident:${inc1.id}:1`]);
  await fetch(`${BASE}/api/jobs/run`, { method: "POST", headers: { Authorization: `Bearer ${internalToken}` } });
  const j1 = (await db.query(`SELECT status FROM jobs WHERE dedupe_key = $1`, [`learning.reevaluate:incident:${inc1.id}:1`])).rows[0];
  check(j1?.status === "succeeded" && (await riskJobs()) === r0, "the revision-1 job ran, saw it was superseded by revision 2, and re-analysed nothing", j1?.status);
  // Dependents: deployments whose LATEST assessment used the incident (bounded, same repository).
  await db.query(
    `INSERT INTO risk_assessments (deployment_id, risk_level, risk_confidence, risk_summary, risk_reasons, historical_evidence,
       missing_information, recommended_checks, evidence, evidence_fingerprint, model)
     VALUES ($1, 'HIGH', 0.5, 'test', '[]', '[]', '[]', '[]', $2::jsonb, $3, 'verification')`,
    [d2.id, JSON.stringify(ev.evidence), `verify-${RUN}-d2`]
  );
  await db.query(`UPDATE deployments SET risk_analysis_status = 'completed' WHERE id = $1`, [d2.id]);
  const deps = await dependentDeployments(inc1.id, 5);
  check(deps.length === 1 && deps[0] === d2.id, "dependent assessments are found from stored evidence (bounded, same repository)", JSON.stringify(deps));

  // --- 4.2 ------------------------------------------------------------------------------------
  console.log("\n4.2 Risk accuracy and immutable predictions");
  const d6 = await push("a1", "Cache layer", ["src/cache/redis.ts"]);
  const ins = (level, pipeline, key) =>
    db.query(
      `INSERT INTO risk_assessments (deployment_id, risk_level, risk_confidence, risk_summary, risk_reasons, historical_evidence,
         missing_information, recommended_checks, evidence, evidence_fingerprint, model)
       VALUES ($1, $2, 0.5, 'test', '[]', '[]', '[]', '[]', $3::jsonb, $4, 'verification') RETURNING id`,
      [d6.id, level, JSON.stringify({ current_pipeline: { status: pipeline }, historical_evidence: { matches: [], available: false } }), `verify-${RUN}-${key}`]
    );
  const pre = (await ins("HIGH", "RECEIVED", "pre")).rows[0].id;
  await fail("a1", d6.sha, "Error: redis ECONNREFUSED", "1006");
  await ci("a1", d6.sha, "FAILED", { runId: "1006", failure: { stage: "test", message: "Error: redis ECONNREFUSED" } });
  const o1 = (await db.query(`SELECT * FROM risk_outcomes WHERE deployment_id = $1 ORDER BY id`, [d6.id])).rows;
  check(o1.length === 1 && o1[0].assessment_id === pre && o1[0].result === "hit" && o1[0].predicted_level === "HIGH",
    "HIGH before CI, then FAILED -> one outcome row: hit, linked to the pre-CI assessment", JSON.stringify(o1.map((o) => o.result)));
  await ins("LOW", "FAILED", "post"); // made after the result: never the prediction
  await ci("a1", d6.sha, "BUILDING", { runId: "1007", runUrl: runUrl("a1", "1007") });
  await ci("a1", d6.sha, "SUCCESS", { runId: "1007", runUrl: runUrl("a1", "1007") });
  const o2 = (await db.query(`SELECT * FROM risk_outcomes WHERE deployment_id = $1 ORDER BY id`, [d6.id])).rows;
  check(o2.length === 2 && o2[0].result === "hit" && o2[1].result === "false_alarm" && o2[1].assessment_id === pre,
    "a re-run that passes ADDS a row (false alarm, same pre-CI prediction); the first row is unchanged");
  check(await refused(`UPDATE risk_assessments SET risk_level = 'LOW' WHERE id = $1`, [pre]), "a stored prediction cannot be edited (risk_level UPDATE refused)");
  check(await refused(`UPDATE risk_assessments SET risk_generated_at = now() WHERE id = $1`, [pre]), "its time cannot be edited");
  check(!(await refused(`UPDATE risk_assessments SET evidence = jsonb_set(evidence, '{evidence_notes}', '[]') WHERE id = $1`, [pre])), "text redaction of the stored evidence is still allowed");
  check(await refused(`UPDATE risk_outcomes SET result = 'hit' WHERE deployment_id = $1`, [d6.id]), "outcome rows are append-only (UPDATE refused)");
  const dashA = await api("a", "/api/dashboard");
  const acc = dashA.body.learning?.accuracy;
  check(acc && acc.counts.false_alarm >= 1 && acc.rows.some((r) => r.deployment_id === d6.id), "the per-repository record lists the underlying deployment");
  const dashB = await api("b", "/api/dashboard");
  check(!dashB.body.learning.accuracy.rows.some((r) => r.deployment_id === d6.id), "user B's record does not include A's deployments");
  const home = await page("a", "/");
  check(home.html.includes("Risk prediction record") && home.html.includes("Small sample"), "dashboard shows the plain record with a small-sample notice");

  // --- 4.4 ------------------------------------------------------------------------------------
  console.log("\n4.4 Flaky failure detection");
  const inc3 = await incidentOf(d3.id);
  check(inc3?.flake_status === "probable_flake", "failed then passed on the same commit -> incident marked probable flake");
  check(inc3?.failed_ci_run_id === "1003" && inc3?.flake_passing_run_id === "1004", "both runs are kept as evidence", `${inc3?.failed_ci_run_id} -> ${inc3?.flake_passing_run_id}`);
  check((await db.query(`SELECT status FROM deployments WHERE id = $1`, [d3.id])).rows[0].status === "SUCCESS" && Boolean(inc3), "the incident is kept (never deleted)");
  check((await incidentOf(d1.id)).flake_status === null, "a failure without a passing re-run is not a flake");
  const flakePage = await page("a", `/?incident=${inc3.id}`);
  check(flakePage.html.includes("Probable flake") && flakePage.html.includes("runs/1003") && flakePage.html.includes("runs/1004"), "incident page shows the flake with links to both runs");

  // --- 4.3 ------------------------------------------------------------------------------------
  console.log("\n4.3 Recurring failure patterns");
  const viewA = { scope: { all: false, repositoryIds: (await db.query(`SELECT id FROM repositories WHERE github_repository_id = $1`, [repos.a1.ghId])).rows.map((r) => r.id) }, githubRepositoryId: null };
  const patterns = await findFailurePatterns(viewA);
  const sig = patterns.find((p) => p.dimension === "error_signature" && p.value === "error: connect etimedout <ip>");
  const expected = (await db.query(
    `SELECT i.id::text FROM incidents i JOIN deployments d ON d.id = i.deployment_id
     WHERE d.github_repository_id = $1 AND i.error_signature = 'error: connect etimedout <ip>' AND i.flake_status IS NULL`, [repos.a1.ghId])).rows.map((r) => r.id).sort();
  check(sig && sig.count === 2 && [...sig.incident_ids].sort().join() === expected.join(), "same normalised timeout in two incidents -> one pattern, evidence = exactly those records", sig ? sig.incident_ids.join(",") : "none");
  check(sig && !sig.incident_ids.includes(incB.id), "the other tenant's identical failure is not in A's pattern");
  const stage = patterns.find((p) => p.dimension === "failed_stage" && p.value === "test_failure");
  check(stage && stage.flakes_excluded >= 1 && !stage.incident_ids.includes(inc3.id), "probable flakes are left out of the count (and reported as excluded)");
  check(home.html.includes("Recurring failure patterns") && home.html.includes("does not say they share a cause"), "dashboard shows patterns as observations");

  // --- 4.5 ------------------------------------------------------------------------------------
  console.log("\n4.5 Revert detection");
  const rv = (await db.query(`SELECT * FROM deployment_reverts WHERE reverting_deployment_id = $1`, [d4.id])).rows;
  check(rv.length === 1 && String(rv[0].reverted_deployment_id) === d2.id && rv[0].matched_by === "reverted_sha", "a GitHub revert commit is attached to the deployment it reverts");
  check((await db.query(`SELECT count(*)::int n FROM deployment_reverts WHERE reverting_deployment_id = $1`, [d5.id])).rows[0].n === 0, "\"Add revert button\" is not a revert");
  const d7 = await push("a1", "Pool again", ["src/db/pool.ts"]);
  const ev7 = await buildRiskEvidence(d7.id);
  const m2 = ev7.evidence.historical_evidence.matches.find((m) => m.deployment_id === d2.id);
  check(m2?.reverted_by?.deployment_id === d4.id, "a later bundle carries the revert as a database fact (reverted_by)");
  const d2page = await page("a", `/?id=${d2.id}`);
  check(d2page.html.includes("Reverted by"), "deployment detail shows the revert");

  // --- 4.6 ------------------------------------------------------------------------------------
  console.log("\n4.6 Ask your history");
  const q = encodeURIComponent("Have we seen a database connection timeout before?");
  const askA = await api("a", `/api/history/ask?q=${q}`);
  const st = askA.body.answer?.statements ?? [];
  check(askA.status === 200 && askA.body.answer?.found && st.length >= 2, "a history question is answered", `${st.length} statement(s), memory ${askA.body.memory}`);
  const aIds = new Set((await db.query(`SELECT id::text FROM deployments WHERE github_repository_id = $1`, [repos.a1.ghId])).rows.map((r) => r.id));
  let backed = st.length > 0;
  for (const s of st) {
    const row = (await db.query(`SELECT d.id, i.id AS incident FROM deployments d LEFT JOIN incidents i ON i.deployment_id = d.id WHERE d.id = $1`, [s.deployment_id])).rows[0];
    if (!row || !aIds.has(s.deployment_id) || (s.incident_id && String(row.incident) !== s.incident_id) || s.source !== "database") backed = false;
    if (!new RegExp(`Deployment #${s.deployment_id}\\b`).test(s.text)) backed = false;
  }
  check(backed, "every statement is linked to an existing record of the asker's repository");
  check(st.some((s) => s.deployment_id === d1.id && s.text.includes("HUMAN-CONFIRMED") && s.text.includes(value.root_cause)), "the confirmed cause is quoted as HUMAN-CONFIRMED");
  check(st.some((s) => s.deployment_id === d2.id && s.text.includes("not determined") && s.text.includes(`reverted by deployment #${d4.id}`)), "an unconfirmed cause says \"not determined\"; the revert is stated from its record");
  check(!st.some((s) => s.deployment_id === b1.id), "the other tenant's matching failure is never in the answer");
  const askB = await api("b", `/api/history/ask?q=${q}`);
  check(askB.status === 200 && (askB.body.answer?.statements ?? []).every((s) => s.deployment_id === b1.id), "user B only gets B's own record");
  const foreign = await api("a", `/api/history/ask?q=${q}&repo=${repos.b1.ghId}`);
  check(foreign.status === 200 && foreign.body.answer?.found === false, "a foreign repository filter narrows to nothing");
  const off = await api("a", `/api/history/ask?q=${encodeURIComponent("What is the capital of France?")}`);
  check(off.status === 422 && off.body.state === "refused", "an unrelated question is refused");
  const none = await api("a", `/api/history/ask?q=${encodeURIComponent("kubernetes helm chart error")}`);
  check(none.status === 200 && none.body.answer?.found === false && /no record/i.test(none.body.answer.summary), "when nothing matches, the answer says so");
  check((await api(null, `/api/history/ask?q=${q}`, { origin: null })).status === 401, "anonymous callers are refused");
  const askPage = await page("a", `/?ask=${q}`);
  check(askPage.html.includes("Ask your history") && askPage.html.includes(`Deployment #${d1.id}`), "the dashboard renders the answer with record links");
} catch (error) {
  check(false, "verification crashed", error.stack?.split("\n").slice(0, 3).join(" | "));
} finally {
  // Let queued Hindsight writes finish first, so the purge does not race a memory being written.
  const testIds = (await db.query(`SELECT id::text FROM deployments WHERE github_repository_id = ANY($1::bigint[])`, [Object.values(repos).map((r) => r.ghId)]).catch(() => ({ rows: [] }))).rows.map((r) => r.id);
  for (let i = 0; i < 60; i++) {
    const open = (await db.query(`SELECT count(*)::int n FROM jobs WHERE type LIKE 'memory.%' AND status IN ('queued', 'running') AND payload->>'deploymentId' = ANY($1::text[])`, [testIds]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
    if (open === 0) break;
    if (i % 10 === 0) await fetch(`${BASE}/api/jobs/run`, { method: "POST", headers: { Authorization: `Bearer ${internalToken}` } }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1000));
  }
  await db.query(`DELETE FROM jobs WHERE type = 'learning.reevaluate' AND status = 'queued' AND payload->>'incidentId' IN (
    SELECT i.id::text FROM incidents i JOIN deployments d ON d.id = i.deployment_id WHERE d.github_repository_id = ANY($1::bigint[]))`,
    [Object.values(repos).map((r) => r.ghId)]).catch(() => {});
  for (const r of Object.values(repos)) {
    // A purge stops (by design) if a Hindsight deletion fails; it is safe to repeat.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const report = await purgeRepository(r.ghId).catch((e) => ({ errors: [e.message] }));
      if (!report.errors.length) break;
      console.log(`  WARN purge attempt ${attempt} for ${r.full}: ${report.errors[0].slice(0, 120)}`);
    }
  }
  for (const u of Object.values(users)) {
    await db.query(`DELETE FROM sessions WHERE user_id = $1`, [u.id]).catch(() => {});
    await db.query(`DELETE FROM repositories WHERE installation_id = $1`, [u.installation]).catch((e) => console.log(`  WARN cleanup: ${e.message}`));
    await db.query(`DELETE FROM github_installations WHERE installation_id = $1`, [u.installation]).catch(() => {});
    await db.query(`DELETE FROM users WHERE id = $1`, [u.id]).catch(() => {});
  }
  await db.end();
}

console.log(`\n${counts.pass} passed, ${counts.fail} failed`);
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
