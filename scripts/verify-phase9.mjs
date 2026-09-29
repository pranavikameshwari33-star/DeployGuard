/**
 * Local verification for Phase 9 (GitHub login, App connection, multi-user
 * isolation). Run with migrations applied and the dev server up:
 *
 *   npm run db:migrate       (once, adds users / sessions / installations / repositories)
 *   npm run dev              (terminal 1)
 *   npm run verify:phase9    (terminal 2)
 *
 * What it can check WITHOUT a real GitHub sign-in (the real OAuth and App
 * installation round-trip must be tested in a browser):
 *   1  protected endpoints refuse anonymous callers; the page redirects to /login
 *   2  the sign-in redirect and its state cookie; bad / missing state is rejected
 *   3  signed installation webhooks create the installation + repository mapping
 *      and attach it to the installing user; duplicates create no second row
 *   4  an App push is owned by the right repository; a plain webhook push stays unowned
 *   5  user A cannot see user B's deployments (API, dashboard, similar, risk, page)
 *   6  workflow_run moves the deployment through the existing lifecycle (+ incident on failure)
 *   7  Hindsight recall for user A returns only A's repository memories
 *   8  uninstalling stops monitoring; logout deletes the session
 *   9  the webhook signature check is intact
 *
 * Test accounts use made-up GitHub ids (990000000000+) and are labelled
 * "[DeployGuard verification]". Sessions are created directly in the database
 * with the same hashing as the app. No Gemini calls. workflow_run makes a few
 * GitHub API calls for a made-up installation, which fail by design and
 * exercise the fallback path. No secret or token is printed.
 */
import crypto from "node:crypto";
import pg from "pg";
import { loadEnv } from "./load-env.mjs";
import { buildPushPayload, deliver, signBody } from "./test-payload.mjs";

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
const check = (ok, step, detail) => (ok ? pass(step, detail) : fail(step, detail));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString ?? "");
const client = new pg.Client({ connectionString, ssl: isLocal ? undefined : { rejectUnauthorized: false } });

const RUN = crypto.randomBytes(3).readUIntBE(0, 3);
const fakeId = (n) => 990_000_000_000 + RUN * 10 + n;
const LABEL = "[DeployGuard verification] Phase 9";

const A = { github: fakeId(1), login: `dg-verify-a-${RUN}`, installation: fakeId(2), repo: fakeId(3), name: `phase9-a-${RUN}` };
const B = { github: fakeId(4), login: `dg-verify-b-${RUN}`, installation: fakeId(5), repo: fakeId(6), name: `phase9-b-${RUN}` };

async function createUserWithSession(u) {
  const { rows } = await client.query(
    `INSERT INTO users (github_user_id, github_login, display_name) VALUES ($1, $2, $3) RETURNING id`,
    [u.github, u.login, `${LABEL} user`]
  );
  const token = crypto.randomBytes(32).toString("base64url");
  await client.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
    [rows[0].id, crypto.createHash("sha256").update(token).digest("hex")]
  );
  return { ...u, userId: String(rows[0].id), cookie: `dg_session=${token}` };
}

const as = (user) => (path, init = {}) =>
  fetch(`${BASE}${path}`, { ...init, redirect: "manual", headers: { ...(init.headers ?? {}), Cookie: user.cookie } });

const repoPayload = (u) => ({ id: u.repo, name: u.name, full_name: `${u.login}/${u.name}`, private: true, owner: { login: u.login, id: u.github } });

async function installationEvent(u, action = "created") {
  return deliver(`${BASE}/api/webhook/github`, {
    action,
    installation: { id: u.installation, account: { id: u.github, login: u.login, type: "User" } },
    repositories: action === "created" ? [repoPayload(u)] : undefined,
    sender: { id: u.github, login: u.login },
  }, secret, "installation");
}

async function appPush(u, message) {
  const payload = buildPushPayload({ message: `${LABEL}: ${message}`, modified: ["config/database.yaml"], added: [], removed: [] });
  payload.repository = { ...payload.repository, ...repoPayload(u), owner: { login: u.login, name: u.login, id: u.github } };
  payload.installation = { id: u.installation };
  const result = await deliver(`${BASE}/api/webhook/github`, payload, secret, "push");
  return { payload, result };
}

async function workflowRun(u, pushed, action, conclusion = null) {
  return deliver(`${BASE}/api/webhook/github`, {
    action,
    workflow_run: {
      id: fakeId(9), name: "CI", run_number: 1, event: "push",
      head_branch: "main", head_sha: pushed.payload.after,
      status: action === "completed" ? "completed" : "in_progress", conclusion,
      html_url: `https://github.com/${u.login}/${u.name}/actions/runs/${fakeId(9)}`,
    },
    repository: repoPayload(u),
    installation: { id: u.installation },
  }, secret, "workflow_run");
}

async function statusOf(sha) {
  const { rows } = await client.query(`SELECT id, status, repository_id, failure_stage FROM deployments WHERE commit_sha = $1`, [sha]);
  return rows[0];
}

async function waitForStatus(sha, status, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let row;
  while (Date.now() < deadline) {
    row = await statusOf(sha);
    if (row?.status === status) return row;
    await sleep(2000);
  }
  return row;
}

console.log(`\nDeployGuard - Phase 9 verification (GitHub accounts + isolation)\n`);

try {
  await client.connect();

  // --- 1. anonymous access --------------------------------------------------------
  console.log("1. Anonymous callers");
  for (const path of ["/api/deployments", "/api/dashboard", "/api/memory/recall?q=x", "/api/deployments/similar?id=1", "/api/deployments/risk?id=1", "/api/events"]) {
    const r = await fetch(`${BASE}${path}`);
    check(r.status === 401, `${path} -> 401`, `HTTP ${r.status}`);
  }
  const home = await fetch(`${BASE}/`, { redirect: "manual" });
  check([303, 307, 308].includes(home.status) && home.headers.get("location")?.includes("/login"), "dashboard redirects to /login", `HTTP ${home.status}`);
  const login = await fetch(`${BASE}/login`);
  check(login.ok && (await login.text()).includes("Continue with GitHub"), "login page renders");

  // --- 2. sign-in redirect and state -----------------------------------------------
  console.log("\n2. Sign-in redirect and state protection");
  const start = await fetch(`${BASE}/auth/github`, { redirect: "manual" });
  const location = start.headers.get("location") ?? "";
  const setCookie = start.headers.get("set-cookie") ?? "";
  check(location.startsWith("https://github.com/login/oauth/authorize") && /[?&]state=/.test(location) && /redirect_uri=/.test(location),
    "redirects to GitHub with state and redirect_uri");
  check(/dg_oauth_state=/.test(setCookie) && /HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie),
    "state cookie is HttpOnly and SameSite=Lax");
  const badState = await fetch(`${BASE}/auth/github/callback?code=abc&state=wrong`, { redirect: "manual" });
  check(badState.headers.get("location")?.includes("/login?error=state"), "wrong state is rejected");
  const noState = await fetch(`${BASE}/auth/github/callback?code=abc`, { redirect: "manual" });
  check(noState.headers.get("location")?.includes("/login?error=state"), "missing state is rejected");
  const denied = await fetch(`${BASE}/auth/github/callback?error=access_denied`, { redirect: "manual" });
  check(denied.headers.get("location")?.includes("/login?error=denied"), "a GitHub denial is handled");

  // --- 3. installations ---------------------------------------------------------------
  console.log("\n3. Installation -> user -> repository mapping");
  const userA = await createUserWithSession(A);
  const userB = await createUserWithSession(B);
  for (const u of [userA, userB]) {
    const r = await installationEvent(u);
    check(r.status === 200, `installation webhook accepted for ${u.login}`, `HTTP ${r.status}`);
  }
  await installationEvent(userA); // duplicate delivery
  const { rows: inst } = await client.query(
    `SELECT i.installation_id, i.user_id, count(r.id)::int AS repos
     FROM github_installations i LEFT JOIN repositories r ON r.installation_id = i.installation_id
     WHERE i.installation_id = ANY($1::bigint[]) GROUP BY i.installation_id, i.user_id`,
    [[A.installation, B.installation]]
  );
  const instA = inst.find((r) => String(r.installation_id) === String(A.installation));
  check(inst.length === 2 && instA?.user_id === userA.userId && instA?.repos === 1,
    "each installation belongs to its installing user with one repository; the duplicate added nothing");

  // --- 4. ownership of pushes --------------------------------------------------------
  console.log("\n4. Push ownership");
  const pushA = await appPush(userA, "user A database change");
  const pushB = await appPush(userB, "user B database change");
  const rowA = await statusOf(pushA.payload.after);
  const rowB = await statusOf(pushB.payload.after);
  const { rows: repoRows } = await client.query(`SELECT id, github_repository_id FROM repositories WHERE github_repository_id = ANY($1::bigint[])`, [[A.repo, B.repo]]);
  const repoA = repoRows.find((r) => String(r.github_repository_id) === String(A.repo));
  check(pushA.result.status === 200 && rowA?.repository_id === repoA?.id, "App push is owned by user A's repository");
  const plain = buildPushPayload({ message: `${LABEL}: plain webhook push` });
  await deliver(`${BASE}/api/webhook/github`, plain, secret);
  check((await statusOf(plain.after))?.repository_id === null, "a plain repository-webhook push stays unowned");

  // --- 5. isolation --------------------------------------------------------------------
  console.log("\n5. Isolation between users");
  const listA = await (await as(userA)("/api/deployments?limit=100")).json();
  const idsA = (listA.deployments ?? []).map((d) => d.id);
  check(idsA.includes(rowA.id) && !idsA.includes(rowB.id) && !idsA.includes((await statusOf(plain.after)).id),
    "A's deployment list has A's row only (not B's, not unowned)", `${idsA.length} row(s)`);
  for (const path of [`/api/dashboard?id=${rowB.id}`, `/api/deployments/similar?id=${rowB.id}`, `/api/deployments/risk?id=${rowB.id}`]) {
    const r = await as(userA)(path);
    check(r.status === 404, `A requesting B's deployment: ${path.split("?")[0]} -> 404`, `HTTP ${r.status}`);
  }
  const ownDash = await as(userA)(`/api/dashboard?id=${rowA.id}`);
  check(ownDash.status === 200, "A can open their own deployment");
  const dashA = await ownDash.json();
  check((dashA.incidents ?? []).every((i) => idsA.includes(i.deployment_id)), "A's incident history contains only A's incidents");
  const pageB = await (await as(userA)(`/?id=${rowB.id}`)).text();
  check(pageB.includes("not found") && !pageB.includes(userB.name), "the dashboard page does not render B's deployment for A");

  // --- 6. workflow_run ------------------------------------------------------------------
  console.log("\n6. workflow_run -> existing lifecycle");
  check((await workflowRun(userA, pushA, "in_progress")).status === 202, "workflow_run accepted (202)");
  check((await waitForStatus(pushA.payload.after, "BUILDING"))?.status === "BUILDING", "in_progress -> BUILDING");
  await workflowRun(userA, pushA, "completed", "success");
  check((await waitForStatus(pushA.payload.after, "SUCCESS"))?.status === "SUCCESS", "completed/success -> SUCCESS");
  const failing = await appPush(userA, "user A failing change");
  await workflowRun(userA, failing, "in_progress");
  await workflowRun(userA, failing, "completed", "failure");
  const failedRow = await waitForStatus(failing.payload.after, "FAILED");
  const { rows: inc } = await client.query(`SELECT failure_type, error_message FROM incidents WHERE deployment_id = $1`, [failedRow?.id ?? 0]);
  check(failedRow?.status === "FAILED" && inc.length === 1 && inc[0].error_message?.includes('concluded "failure"'),
    "completed/failure -> FAILED with an incident holding only what GitHub reported");

  // --- 7. Hindsight scoping ---------------------------------------------------------
  console.log("\n7. Hindsight isolation");
  const recallA = await (await as(userA)(`/api/memory/recall?q=${encodeURIComponent("database change deployment")}`)).json();
  const memories = recallA.memories ?? [];
  check(memories.every((m) => m.tags?.includes(`ghrepo:${A.repo}`)) && !memories.some((m) => m.tags?.includes(`ghrepo:${B.repo}`)),
    "A's recall returns only memories tagged with A's repository", `${memories.length} memory/memories`);

  // --- 8. uninstall + logout ---------------------------------------------------------
  console.log("\n8. Uninstall and logout");
  await installationEvent(userA, "deleted");
  const { rows: afterUninstall } = await client.query(`SELECT connected FROM repositories WHERE github_repository_id = $1`, [A.repo]);
  check(afterUninstall[0]?.connected === false, "uninstalling disconnects the repository");
  const ignored = await appPush(userA, "push after uninstall");
  check(ignored.result.body?.ignored && !(await statusOf(ignored.payload.after)), "pushes after uninstall are not recorded", ignored.result.body?.ignored);
  const logout = await as(userA)("/auth/logout", { method: "POST" });
  check(logout.status === 303 && /dg_session=;/.test(logout.headers.get("set-cookie") ?? ""), "logout redirects and clears the cookie");
  check((await as(userA)("/api/deployments")).status === 401, "the old session no longer works");

  // --- 9. webhook signature ---------------------------------------------------------
  console.log("\n9. Webhook security");
  const body = JSON.stringify({ action: "created", installation: { id: fakeId(7) } });
  const forged = await fetch(`${BASE}/api/webhook/github`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-GitHub-Event": "installation", "X-Hub-Signature-256": signBody(body, "not-the-secret") },
    body,
  });
  check(forged.status === 401, "a forged installation event is rejected", `HTTP ${forged.status}`);

  await client.query(`DELETE FROM sessions WHERE user_id = ANY($1::bigint[])`, [[userA.userId, userB.userId]]);
} catch (error) {
  fail("unexpected error", error.message);
} finally {
  await client.end();
}

console.log(failures === 0 ? "\nPhase 9 verified: every step passed.\n" : `\n${failures} check(s) failed. See above.\n`);
process.exitCode = failures === 0 ? 0 : 1;
