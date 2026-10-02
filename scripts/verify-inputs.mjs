/**
 * Stage 5 gate: better inputs to the analysis, through the REAL webhook
 * (push, pull_request, deployment_status), job queue, analysis, evidence
 * bundle and dashboard, as signed-in test users. Dev server up:
 *
 *   npm run verify:inputs
 *
 * The test repositories are not real GitHub repositories, so reading
 * .deployguard.yml / CODEOWNERS from GitHub and posting check runs cannot run
 * here: the validated inputs are seeded into repository_inputs exactly as the
 * refresh job stores them, and the PR analysis is checked up to the rendered
 * check-run text. Live GitHub round trips are MANUAL TEST REQUIRED.
 *
 * No Gemini call is made. Test data is purged from PostgreSQL and Hindsight.
 */
import crypto from "node:crypto";
import { loadEnv } from "./load-env.mjs";
import { buildPushPayload, deliver, signBody } from "./test-payload.mjs";

loadEnv();
const BASE = process.env.APP_URL || "http://localhost:3000";
const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
const internalToken = process.env.DEPLOYGUARD_INTERNAL_TOKEN;

const counts = { pass: 0, fail: 0 };
const check = (ok, step, detail = "") => {
  counts[ok ? "pass" : "fail"]++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${step}${detail ? " -- " + detail : ""}`);
};

const { getPool } = await import("@/lib/db/client");
const { purgeRepository } = await import("@/lib/lifecycle/purge");
const { buildRiskEvidence } = await import("@/lib/risk/evidence");
const { parseRepoConfig } = await import("@/lib/config/repo-config");
const { parseCodeowners } = await import("@/lib/config/codeowners");
const { analyzePullRequest, buildPullRequestEvidence } = await import("@/lib/github/pull-request-check");
const { getRepositoryInputs } = await import("@/lib/github/repo-inputs");
const { renderCheck } = await import("@/lib/github/check-output");
const db = getPool();
const RUN = crypto.randomBytes(3).toString("hex");
const rid = () => String(900000000000 + crypto.randomInt(1, 999_999_999));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const users = {};
const repos = {};
async function makeUser(name, repoNames) {
  const gh = 600000000000 + crypto.randomInt(1, 999_999_999);
  const login = `inputs-${name}-${RUN}`;
  const id = (await db.query(`INSERT INTO users (github_user_id, github_login) VALUES ($1, $2) RETURNING id`, [gh, login])).rows[0].id;
  const installation = 800000000 + crypto.randomInt(1, 99_999_999);
  await db.query(`INSERT INTO github_installations (installation_id, user_id, status, github_account_login, account_type) VALUES ($1, $2, 'active', $3, 'User')`, [installation, id, login]);
  for (const r of repoNames) {
    const ghId = rid();
    const rowId = (await db.query(`INSERT INTO repositories (github_repository_id, installation_id, owner, name, full_name, default_branch) VALUES ($1, $2, $3, $4, $5, 'main') RETURNING id`, [ghId, installation, login, r, `${login}/${r}`])).rows[0].id;
    repos[r] = { ghId, rowId, full: `${login}/${r}`, owner: login, name: r, installation };
  }
  const token = crypto.randomBytes(32).toString("base64url");
  await db.query(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [id, crypto.createHash("sha256").update(token).digest("hex")]);
  users[name] = { id, login, installation, cookie: `dg_session=${token}` };
}
const page = async (user, path) => {
  const r = await fetch(`${BASE}${path}`, { headers: { Cookie: users[user].cookie }, redirect: "manual" });
  return { status: r.status, html: (await r.text()).replace(/<!-- -->/g, "") };
};
const repoPayload = (key) => {
  const r = repos[key];
  return { id: Number(r.ghId), name: r.name, full_name: r.full, owner: { login: r.owner, name: r.owner } };
};
async function push(key, message, files) {
  const payload = buildPushPayload({ message, modified: files, added: [], removed: [] });
  payload.repository = { ...payload.repository, ...repoPayload(key) };
  payload.installation = { id: repos[key].installation };
  const res = await deliver(`${BASE}/api/webhook/github`, payload, webhookSecret, "push");
  if (res.status !== 200 || !res.body.deploymentId) throw new Error(`push failed: HTTP ${res.status}`);
  return { id: String(res.body.deploymentId), sha: payload.after };
}
/** A signed delivery with a chosen delivery id (to test redelivery). */
async function event(type, payload, deliveryId = crypto.randomUUID()) {
  const raw = JSON.stringify(payload);
  const r = await fetch(`${BASE}/api/webhook/github`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-GitHub-Event": type, "X-GitHub-Delivery": deliveryId, "X-Hub-Signature-256": signBody(raw, webhookSecret) },
    body: raw,
  });
  return { status: r.status, body: await r.json().catch(() => ({})), deliveryId };
}
async function waitJob(deliveryId) {
  for (let i = 0; i < 40; i++) {
    const j = (await db.query(`SELECT status, last_error FROM jobs WHERE dedupe_key = $1`, [`webhook:${deliveryId}`])).rows[0];
    if (j && (j.status === "succeeded" || j.status === "dead")) return j;
    if (i % 8 === 7) await fetch(`${BASE}/api/jobs/run`, { method: "POST", headers: { Authorization: `Bearer ${internalToken}` } }).catch(() => {});
    await sleep(500);
  }
  return null;
}
async function seedInputs(key, configText, codeownersText) {
  const parsed = configText === null ? null : parseRepoConfig(configText);
  const owners = codeownersText ? parseCodeowners(codeownersText) : null;
  await db.query(
    `INSERT INTO repository_inputs (github_repository_id, default_branch, config_status, config, config_errors, config_sha,
       codeowners_status, codeowners_path, codeowners, codeowners_emails_dropped, fetched_at)
     VALUES ($1, 'main', $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8::jsonb, $9, now())`,
    [
      repos[key].ghId,
      parsed === null ? "absent" : parsed.ok ? "valid" : "invalid",
      parsed?.ok ? JSON.stringify(parsed.config) : null,
      parsed && !parsed.ok ? JSON.stringify(parsed.errors) : null,
      parsed ? `cfg${RUN}0000` : null,
      owners ? "valid" : "absent",
      owners ? ".github/CODEOWNERS" : null,
      owners ? JSON.stringify(owners.rules) : null,
      owners?.emailsDropped ?? 0,
    ]
  );
}

const CONFIG = `version: 1
pull_request_checks: false
ignore:
  - "docs/**"
critical_paths:
  - "src/payments/**"
services:
  "src/payments/**": payments-core
categories:
  "db/schema/**": [database, migration]
`;
const CODEOWNERS = `*  @acme/core
/src/payments/  @acme/payments @alice
/docs/  docs-team@acme.example
`;

console.log("DeployGuard Stage 5: better inputs to the analysis\n");
try {
  await makeUser("a", ["a1", "a2", "a3"]);
  await makeUser("b", ["b1"]);
  await seedInputs("a1", CONFIG, CODEOWNERS);
  await seedInputs("a2", "version: 1\nshell: rm -rf /\nignore:\n  - &anchor x\n", null);

  // --- 5.4 + 5.2 ------------------------------------------------------------------------------
  console.log("5.2 / 5.4 Config file and richer change signals");
  const d1 = await push("a1", "Payments and schema", ["src/payments/charge.ts", "db/schema/users.sql", "docs/guide.md", "package-lock.json", "terraform/main.tf", "Dockerfile", ".env.production"]);
  const row1 = (await db.query(`SELECT file_analysis, change_categories, affected_services, analysis_config FROM deployments WHERE id = $1`, [d1.id])).rows[0];
  const f = Object.fromEntries(row1.file_analysis.map((x) => [x.path, x]));
  check(f["src/payments/charge.ts"].critical === true && f["src/payments/charge.ts"].service === "payments-core", "critical path and service mapping from .deployguard.yml applied");
  check(f["db/schema/users.sql"].categories.includes("migration"), "custom category rule applied");
  check(f["docs/guide.md"].ignored === true && !row1.change_categories.includes("documentation"), "ignored file is labelled and left out of the categories");
  for (const c of ["lockfile", "iac", "container", "environment"]) check(row1.change_categories.includes(c), `explicit category "${c}" recorded`);
  check(row1.analysis_config?.status === "valid" && row1.analysis_config.sha === `cfg${RUN}0000`, "the deployment records which config shaped its analysis", JSON.stringify(row1.analysis_config));

  const d2 = await push("a2", "Docs change", ["docs/readme.md"]);
  const row2 = (await db.query(`SELECT file_analysis, change_categories, analysis_config FROM deployments WHERE id = $1`, [d2.id])).rows[0];
  check(row2.analysis_config?.status === "invalid" && row2.change_categories.includes("documentation") && !row2.file_analysis[0].ignored,
    "an invalid config is not used: defaults apply, and the deployment says so");
  const p2 = await page("a", `/?id=${d2.id}`);
  check(p2.html.includes("Config errors") && p2.html.includes("line 4:") && p2.html.includes("YAML syntax") && p2.html.includes("NOT used"), "config errors are shown in the UI (line-numbered)");
  check(!p2.html.includes("rm -rf"), "raw file content is not echoed into the page");

  const d3 = await push("a3", "First push", ["src/app.ts"]);
  const row3 = (await db.query(`SELECT analysis_config FROM deployments WHERE id = $1`, [d3.id])).rows[0];
  const refresh = (await db.query(`SELECT count(*)::int n FROM jobs WHERE type = 'repo.inputs_refresh' AND payload->>'githubRepositoryId' = $1`, [repos.a3.ghId])).rows[0].n;
  check(row3.analysis_config?.status === "not_read_yet" && refresh === 1, "a repository without cached inputs is analysed with defaults and ONE refresh job is queued", `${refresh} job(s)`);
  await push("a3", "Second push", ["src/other.ts"]);
  const refresh2 = (await db.query(`SELECT count(*)::int n FROM jobs WHERE type = 'repo.inputs_refresh' AND payload->>'githubRepositoryId' = $1`, [repos.a3.ghId])).rows[0].n;
  check(refresh2 === 1, "a second push in the same window does not queue another refresh (deduplicated)");
  const refreshA1 = (await db.query(`SELECT count(*)::int n FROM jobs WHERE type = 'repo.inputs_refresh' AND payload->>'githubRepositoryId' = $1`, [repos.a1.ghId])).rows[0].n;
  check(refreshA1 === 0, "fresh cached inputs are used without calling GitHub");

  // --- 5.3 ------------------------------------------------------------------------------------
  console.log("\n5.3 CODEOWNERS");
  const p1 = await page("a", `/?id=${d1.id}`);
  check(p1.html.includes("Code owners of the changed files") && p1.html.includes("@acme/payments") && p1.html.includes("@acme/core"), "owners of the affected files are shown on the deployment view");
  check(!p1.html.includes("docs-team@acme.example"), "email owners are never shown");
  check((p1.html.match(/Code owners of the changed files/g) ?? []).length >= 2, "owners appear on both the risk and the change views");
  check(p1.html.includes("Critical path"), "critical paths are flagged on the deployment view");

  // --- 5.5 ------------------------------------------------------------------------------------
  console.log("\n5.5 Environment awareness");
  check(p1.html.includes("Environment unknown"), "before GitHub reports anything, the page says \"Environment unknown\"");
  const status = (state, at, ghDeployment = 5001, env = "production", key = "a1", sha = d1.sha) => ({
    action: "created",
    deployment: { id: ghDeployment, sha, environment: env },
    deployment_status: { state, created_at: at, updated_at: at },
    repository: repoPayload(key),
    installation: { id: repos[key].installation },
  });
  const e1 = await event("deployment_status", status("success", "2026-10-02T10:00:00Z"));
  check(e1.status === 202, "deployment_status is accepted and queued (202)");
  const j1 = await waitJob(e1.deliveryId);
  const envRows = async () => (await db.query(`SELECT environment, state FROM deployment_environments WHERE deployment_id = $1 ORDER BY environment`, [d1.id])).rows;
  check(j1?.status === "succeeded" && JSON.stringify(await envRows()) === JSON.stringify([{ environment: "production", state: "success" }]), "the environment and state are attached to the deployment of that commit", JSON.stringify(await envRows()));
  const old = await event("deployment_status", status("failure", "2026-10-02T09:00:00Z"));
  await waitJob(old.deliveryId);
  check((await envRows())[0]?.state === "success", "an older (out-of-order) status does not overwrite a newer one");
  const stg = await event("deployment_status", status("failure", "2026-10-02T11:00:00Z", 5002, "staging"));
  await waitJob(stg.deliveryId);
  check((await envRows()).length === 2, "staging and production are kept apart for the same commit");
  const ev1 = await buildRiskEvidence(d1.id);
  check(JSON.stringify(ev1.evidence.current_deployment.environments) === JSON.stringify(["production: success", "staging: failure"]), "the evidence bundle states the environments as database facts");
  const ev2 = await buildRiskEvidence(d2.id);
  check(JSON.stringify(ev2.evidence.current_deployment.environments) === JSON.stringify(["environment unknown"]), "a deployment without GitHub deployments is \"environment unknown\" in the bundle (never assumed)");
  const foreign = await event("deployment_status", { ...status("success", "2026-10-02T12:00:00Z", 6001, "production", "a1", d1.sha), repository: { id: 999999999999, name: "x", full_name: "x/x" } });
  const jf = await waitJob(foreign.deliveryId);
  check(jf?.status === "succeeded" && (await envRows()).length === 2, "an event for a repository that is not connected changes nothing");
  const p1b = await page("a", `/?id=${d1.id}`);
  check(p1b.html.includes("production: success") && p1b.html.includes("staging: failure"), "the deployment view shows the environments");

  // --- 5.1 ------------------------------------------------------------------------------------
  console.log("\n5.1 Pull request checks (advisory)");
  const prPayload = (key, number, sha, action = "opened") => ({
    action,
    number,
    pull_request: { number, title: "Tune payments <script>x</script>", state: "open", head: { sha, ref: "feature" }, base: { ref: "main" }, user: { login: "dev" } },
    repository: repoPayload(key),
    installation: { id: repos[key].installation },
  });
  const sha = crypto.randomBytes(20).toString("hex");
  const pr = await event("pull_request", prPayload("a1", 41, sha));
  check(pr.status === 202, "pull_request is accepted and queued (202), not processed inline");
  const again = await event("pull_request", prPayload("a1", 41, sha), pr.deliveryId);
  check(again.status === 200 && again.body.duplicate === true, "a redelivery of the same event is ignored (idempotent)");
  const jpr = await waitJob(pr.deliveryId);
  const prRow = (await db.query(`SELECT state, detail, check_run_id, title FROM pull_request_checks WHERE github_repository_id = $1 AND pr_number = 41`, [repos.a1.ghId])).rows;
  check(jpr?.status === "succeeded" && prRow.length === 1 && prRow[0].state === "disabled" && prRow[0].check_run_id === null,
    "pull_request_checks: false in .deployguard.yml disables the check for that repository (nothing posted)", prRow[0]?.detail);
  await event("pull_request", prPayload("a1", 41, sha, "synchronize")).then((r) => waitJob(r.deliveryId));
  check((await db.query(`SELECT count(*)::int n FROM pull_request_checks WHERE github_repository_id = $1 AND pr_number = 41`, [repos.a1.ghId])).rows[0].n === 1,
    "the same head commit keeps ONE record (updated, never duplicated)");
  const closed = await event("pull_request", { ...prPayload("a3", 42, sha, "closed") });
  check((await waitJob(closed.deliveryId))?.status === "succeeded" && (await db.query(`SELECT count(*)::int n FROM pull_request_checks WHERE pr_number = 42 AND github_repository_id = $1`, [repos.a3.ghId])).rows[0].n === 0,
    "closed pull requests are ignored");

  // The analysis itself (everything except the GitHub calls), on repository a1's history.
  const inputsA1 = await getRepositoryInputs(repos.a1.ghId);
  const analysed = analyzePullRequest({
    repo: { name: "a1", owner: repos.a1.owner, ghRepoId: repos.a1.ghId, repositoryId: repos.a1.rowId },
    pr: { number: 43, title: "Payments again", author: "dev", headSha: sha, baseRef: "main" },
    files: [{ filename: "src/payments/charge.ts", status: "modified" }, { filename: "docs/x.md", status: "added" }, { filename: "src/new.ts", status: "renamed", previous_filename: "src/old.ts" }],
    inputs: inputsA1,
  });
  check(analysed.analysis.critical?.includes("src/payments/charge.ts") && analysed.analysis.ignored?.includes("docs/x.md"), "the PR's files go through the same analysis and config");
  check(analysed.pseudo.deleted_files.includes("src/old.ts") && analysed.pseudo.added_files.includes("src/new.ts"), "a rename counts as the new path added and the old one removed");
  check(analysed.owners.some((o) => o.owner === "@acme/payments"), "PR owners come from CODEOWNERS");
  const prEvidence = await buildPullRequestEvidence(analysed);
  const ids = prEvidence.evidence.historical_evidence.matches.map((m) => m.deployment_id);
  const bIds = new Set((await db.query(`SELECT d.id::text FROM deployments d WHERE d.github_repository_id = $1`, [repos.b1?.ghId ?? "0"])).rows.map((r) => r.id));
  check(ids.includes(d1.id) && !ids.some((id) => bIds.has(id)), "PR history comes from the repository's own deployments only", ids.join(","));
  check(prEvidence.evidence.current_deployment.deployment_id === "pull-request" && /pull request: not merged/.test(prEvidence.evidence.current_pipeline.state),
    "the bundle says plainly it is an unmerged pull request");
  check(prEvidence.evidence.current_deployment.critical_files?.includes("src/payments/charge.ts"), "critical files are in the bundle as facts");
  const out = renderCheck({
    prNumber: 43, level: null, unavailable: "not run in verification", confidence: null, summary: null, reasons: [], cited: [],
    matches: prEvidence.evidence.historical_evidence.matches.map((m) => ({ deployment_id: m.deployment_id, status: m.status, commit_message: m.commit_message, environments: m.environments })),
    categories: analysed.analysis.categories, criticalFiles: analysed.analysis.critical ?? [], ignoredFiles: 1, owners: analysed.owners,
    configStatus: "valid", filesAnalysed: 3, filesTruncated: false, dashboardBase: null, githubRepositoryId: repos.a1.ghId,
  });
  check(out.text.includes(`deployment ${d1.id}`) && out.text.includes("production\\: success") && /never blocks merging/.test(out.title), "the check text lists linked history with environments and says it never blocks");
  const prRaw = (await db.query(`SELECT title FROM pull_request_checks WHERE pr_number = 41 AND github_repository_id = $1`, [repos.a1.ghId])).rows[0].title;
  check(prRaw.includes("<script>") === true, "the stored PR title is data (escaped on output, see unit tests)");

  // --- isolation and purge ------------------------------------------------------------------------
  console.log("\nIsolation and purge");
  const pb = await page("b", `/?id=${d1.id}`);
  check(pb.html.includes(`Deployment #${d1.id} not found`) && !pb.html.includes("@acme/payments"), "another user cannot see the deployment, its owners or its inputs");
  const report = await purgeRepository(repos.a1.ghId);
  const left = (await db.query(
    `SELECT (SELECT count(*) FROM pull_request_checks WHERE github_repository_id = $1)::int AS prs,
            (SELECT count(*) FROM repository_inputs WHERE github_repository_id = $1)::int AS inputs,
            (SELECT count(*) FROM deployment_environments e WHERE e.deployment_id = $2)::int AS envs`, [repos.a1.ghId, d1.id])).rows[0];
  check(report.errors.length === 0 && left.prs === 0 && left.inputs === 0 && left.envs === 0, "purge removes PR checks, cached inputs and environments", JSON.stringify(left));
} catch (error) {
  check(false, "verification crashed", error.stack?.split("\n").slice(0, 3).join(" | "));
} finally {
  const ghIds = Object.values(repos).map((r) => r.ghId);
  await db.query(`DELETE FROM jobs WHERE type = 'repo.inputs_refresh' AND payload->>'githubRepositoryId' = ANY($1::text[])`, [ghIds]).catch(() => {});
  const testIds = (await db.query(`SELECT id::text FROM deployments WHERE github_repository_id = ANY($1::bigint[])`, [ghIds]).catch(() => ({ rows: [] }))).rows.map((r) => r.id);
  for (let i = 0; i < 60; i++) {
    const open = (await db.query(`SELECT count(*)::int n FROM jobs WHERE status IN ('queued', 'running') AND payload->>'deploymentId' = ANY($1::text[])`, [testIds]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
    if (open === 0) break;
    if (i % 10 === 0) await fetch(`${BASE}/api/jobs/run`, { method: "POST", headers: { Authorization: `Bearer ${internalToken}` } }).catch(() => {});
    await sleep(1000);
  }
  for (const r of Object.values(repos)) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const rep = await purgeRepository(r.ghId).catch((e) => ({ errors: [e.message] }));
      if (!rep.errors.length) break;
      console.log(`  WARN purge attempt ${attempt} for ${r.full}: ${rep.errors[0].slice(0, 120)}`);
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
console.log(counts.fail === 0 ? "ALL CHECKS PASSED" : `${counts.fail} CHECK(S) FAILED`);
process.exit(counts.fail === 0 ? 0 : 1);
