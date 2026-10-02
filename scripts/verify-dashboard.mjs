/**
 * Stage 3: core product features, through the REAL dashboard page and API as
 * signed-in test users. Dev server up:
 *
 *   npm run verify:dashboard
 *
 * Users: A owns repositories A1 and A2, B owns B1, C has none, D has one
 * repository without deployments. Deployments arrive through the real webhook
 * as GitHub App pushes (owned), failures through the CI status route.
 *
 *   1 switcher: lists only the user's repositories; narrowing works; a foreign
 *     repository / deployment / incident is never shown (server-side)
 *   2 deployment detail fields, provenance labels, history counts and paging
 *   3 incident detail ("Not determined" for unknowns)
 *   4 Re-analyze offered only when warranted; usage-limit state is explained
 *   5 recalled memory appears ONLY on explicit request (Hindsight is not
 *     reached on normal page loads); page loads make no Gemini call
 *   6 connection states CONNECTED / DISCONNECTED / SUSPENDED and the banner
 *   7 first-time user and connected-but-empty states
 * No Gemini calls (automatic analysis off). Test data is purged at the end.
 */
import crypto from "node:crypto";
import { loadEnv } from "./load-env.mjs";
import { buildPushPayload, deliver } from "./test-payload.mjs";

loadEnv();
const BASE = process.env.APP_URL || "http://localhost:3000";
const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
const statusToken = process.env.DEPLOYGUARD_STATUS_TOKEN;

let failures = 0;
const check = (ok, step, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${step}${detail ? " -- " + detail : ""}`);
};

const { getPool } = await import("@/lib/db/client");
const { purgeRepository } = await import("@/lib/lifecycle/purge");
const db = getPool();
const RUN = crypto.randomBytes(3).toString("hex");
const rid = () => String(900000000000 + crypto.randomInt(1, 999_999_999));

const users = {};
const repos = {};
async function makeUser(name, repoNames) {
  const gh = 600000000000 + crypto.randomInt(1, 999_999_999);
  const id = (await db.query(`INSERT INTO users (github_user_id, github_login) VALUES ($1, $2) RETURNING id`, [gh, `dash-${name}-${RUN}`])).rows[0].id;
  const installation = 800000000 + crypto.randomInt(1, 99_999_999);
  await db.query(`INSERT INTO github_installations (installation_id, user_id, status, github_account_login, account_type) VALUES ($1, $2, 'active', $3, 'User')`, [installation, id, `dash-${name}-${RUN}`]);
  for (const r of repoNames) {
    const ghId = rid();
    const full = `dash-${name}-${RUN}/${r}`;
    await db.query(`INSERT INTO repositories (github_repository_id, installation_id, owner, name, full_name) VALUES ($1, $2, $3, $4, $5)`, [ghId, installation, `dash-${name}-${RUN}`, r, full]);
    repos[r] = { ghId, full, owner: `dash-${name}-${RUN}`, name: r, installation };
  }
  const token = crypto.randomBytes(32).toString("base64url");
  await db.query(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [id, crypto.createHash("sha256").update(token).digest("hex")]);
  users[name] = { id, installation, cookie: `dg_session=${token}` };
}
const page = async (user, path) => {
  const r = await fetch(`${BASE}${path}`, { headers: { Cookie: users[user].cookie }, redirect: "manual" });
  // React separates adjacent text nodes with <!-- --> markers; remove them to match visible text.
  return { status: r.status, html: (await r.text()).replace(/<!-- -->/g, "") };
};
async function appPush(repoKey, message, files) {
  const r = repos[repoKey];
  const payload = buildPushPayload({ message: `[DeployGuard verification] Stage 3 ${message}`, modified: files, added: [], removed: [] });
  payload.repository = { ...payload.repository, id: Number(r.ghId), name: r.name, full_name: r.full, owner: { login: r.owner, name: r.owner } };
  payload.installation = { id: r.installation };
  const res = await deliver(`${BASE}/api/webhook/github`, payload, webhookSecret, "push");
  if (res.status !== 200 || !res.body.deploymentId) throw new Error(`push to ${repoKey} failed: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
  return { id: String(res.body.deploymentId), sha: payload.after };
}
const fail = async (repoKey, sha, output) => {
  const r = repos[repoKey];
  const body = (status, extra = {}) =>
    JSON.stringify({ repository: r.full, branch: "main", commitSha: sha, status, ...extra });
  const post = (b) => fetch(`${BASE}/api/deployments/status`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${statusToken}` }, body: b });
  await post(body("BUILDING"));
  await post(body("FAILED", { failure: { stage: "test", job: "ci / test", message: output } }));
};

console.log("DeployGuard Stage 3: core product features\n");
try {
  await makeUser("a", ["a1", "a2"]);
  await makeUser("b", ["b1"]);
  await makeUser("c", []);
  await makeUser("d", ["d1"]);

  const a1x = await appPush("a1", "a1 first", ["src/api/users.ts"]);
  const a1y = await appPush("a1", "a1 second", ["src/api/users.ts", "src/db/pool.ts"]);
  const a2 = await appPush("a2", "a2 failing", ["src/db/pool.ts"]);
  await fail("a2", a2.sha, "Error: connect ETIMEDOUT 10.0.0.7:5432");
  const b1 = await appPush("b1", "b1 secret project", ["src/b-only.ts"]);
  await fail("b1", b1.sha, "Error: b-only failure");
  const incA = (await db.query(`SELECT id FROM incidents WHERE deployment_id = $1`, [a2.id])).rows[0]?.id;
  const incB = (await db.query(`SELECT id FROM incidents WHERE deployment_id = $1`, [b1.id])).rows[0]?.id;
  check(Boolean(incA && incB), "test history created through the real webhook and CI route", `A: #${a1x.id} #${a1y.id} #${a2.id}, B: #${b1.id}`);

  // --- 1. switcher and isolation ---------------------------------------------------------
  console.log("\n1. Repository switcher and isolation");
  const home = await page("a", "/");
  check(home.status === 200 && home.html.includes(repos.a1.full) && home.html.includes(repos.a2.full), "switcher lists the user's repositories");
  check(!home.html.includes(repos.b1.full) && !home.html.includes(b1.sha.slice(0, 7)), "another user's repository and commits are absent");
  const onlyA2 = await page("a", `/?repo=${repos.a2.ghId}`);
  check(onlyA2.html.includes(a2.sha.slice(0, 7)) && !onlyA2.html.includes(a1x.sha.slice(0, 7)) && !onlyA2.html.includes(a1y.sha.slice(0, 7)),
    "selecting a repository narrows deployment history to it");
  check(/Showing <strong>[^<]*a2<\/strong>/.test(onlyA2.html), "the page says which repository is shown");
  const foreignRepo = await page("a", `/?repo=${repos.b1.ghId}`);
  check(foreignRepo.html.includes("not one of yours") && !foreignRepo.html.includes(b1.sha.slice(0, 7)), "a foreign repository id is refused and shows nothing of it");
  const foreignDeployment = await page("a", `/?id=${b1.id}`);
  check(foreignDeployment.html.includes(`Deployment #${b1.id} not found`) && !foreignDeployment.html.includes("b1 secret project"), "a foreign deployment id reads as not found");
  const foreignIncident = await page("a", `/?incident=${incB}`);
  check(foreignIncident.html.includes(`Incident #${incB} not found`) && !foreignIncident.html.includes("b-only failure"), "a foreign incident id reads as not found");
  const api = await fetch(`${BASE}/api/dashboard?repo=${repos.b1.ghId}`, { headers: { Cookie: users.a.cookie } }).then((r) => r.json());
  check(Array.isArray(api.history) && api.history.length === 0 && api.counts.total === 0, "the JSON API returns nothing for a foreign repository filter");

  // --- 2. detail, provenance, counts, paging --------------------------------------------------
  console.log("\n2. Deployment detail, provenance, history counts");
  const detail = await page("a", `/?id=${a2.id}&repo=${repos.a2.ghId}`);
  for (const text of [a2.sha, "CI failed", "Observed fact", "Historical evidence", "Why this risk?", "Failed stage", "Observed failure output"]) {
    check(detail.html.includes(text), `deployment detail shows "${text}"`);
  }
  check(/Deployments<\/dt><dd class="num">1<\/dd>/.test(onlyA2.html) && /Failed<\/dt><dd class="num">1<\/dd>/.test(onlyA2.html), "history counts are plain counts for the selected repository");
  const allA = await page("a", "/");
  check(/Deployments<\/dt><dd class="num">3<\/dd>/.test(allA.html), "counts over all of the user's repositories (3)");
  const paged = await page("a", `/?repo=${repos.a1.ghId}&offset=1`);
  check(paged.html.includes("2-2 of 2") && paged.html.includes(a1x.sha.slice(0, 7)), "history paging works (offset)");

  // --- 3. incident detail ---------------------------------------------------------------------------
  console.log("\n3. Incident detail");
  const inc = await page("a", `/?incident=${incA}`);
  check(inc.html.includes(`Incident #${incA}`) && inc.html.includes("ETIMEDOUT 10.0.0.7:5432"), "incident detail shows the observed (redacted) output");
  const notDetermined = (inc.html.match(/Not determined/g) ?? []).length;
  check(notDetermined >= 4, "unknown root cause, resolution, service and downstream effect read \"Not determined\"", `${notDetermined} field(s)`);

  // --- 4. Re-analyze offer and unavailable states ---------------------------------------------------
  console.log("\n4. Re-analyze and analysis states");
  check(detail.html.includes("Re-analyze") && detail.html.includes("has not been analysed"), "Re-analyze is offered for a deployment that was never analysed");
  await db.query(
    `UPDATE deployments SET risk_analysis_status = 'unavailable', risk_analysis_error = 'Risk analysis unavailable: usage limit reached (daily cap of 50 analyses).' WHERE id = $1`,
    [a1y.id]
  );
  const limited = await page("a", `/?id=${a1y.id}`);
  check(limited.html.includes("usage limit for this repository has been reached") && !limited.html.includes(">Re-analyze<"),
    "usage-limit state is explained and Re-analyze is NOT offered");
  await db.query(`UPDATE deployments SET risk_analysis_status = 'unavailable', risk_analysis_error = 'Gemini did not answer within 60s.' WHERE id = $1`, [a1y.id]);
  const down = await page("a", `/?id=${a1y.id}`);
  check(down.html.includes("could not be reached") && down.html.includes(">Re-analyze<"), "AI-service-unavailable state is explained and Re-analyze is offered");

  // --- 5. recalled memory only on request; no Gemini on reads ----------------------------------------
  console.log("\n5. Recalled memory and read-only page loads");
  const bucket = `memoryRecall:user:${users.a.id}`;
  const bucketCount = async () => (await db.query(`SELECT COALESCE(sum(count), 0)::int n FROM rate_limits WHERE bucket = $1`, [bucket])).rows[0].n;
  const geminiCalls = async () => (await db.query(`SELECT COALESCE(sum(calls), 0)::int n FROM gemini_usage`)).rows[0].n;
  const g0 = await geminiCalls();
  check((await bucketCount()) === 0, "normal page loads did not reach Hindsight (no memory recall recorded)");
  const mem = await page("a", `/?id=${a2.id}&memory=1`);
  check(mem.html.includes("Recalled memory") && mem.html.includes("never sent to the AI analysis"), "\"Show recalled memory\" shows a clearly labelled RECALLED MEMORY panel");
  check((await bucketCount()) === 1, "exactly one recall was made, on explicit request");
  check((await geminiCalls()) === g0, "no page load made a Gemini call");

  // --- 6. connection states --------------------------------------------------------------------------
  console.log("\n6. GitHub connection states");
  check(home.html.includes("CONNECTED") && home.html.includes("settings/installations/"), "connected repositories show CONNECTED and a manage-on-GitHub link");
  await db.query(`UPDATE repositories SET connected = false, disconnected_at = now() WHERE github_repository_id = $1`, [repos.a2.ghId]);
  const disc = await page("a", `/?id=${a2.id}`);
  check(disc.html.includes("DISCONNECTED") && disc.html.includes("this repository is disconnected") && disc.html.includes(a2.sha.slice(0, 7)),
    "a disconnected repository is labelled, explained, and its history is still shown");
  await db.query(`UPDATE github_installations SET status = 'suspended' WHERE installation_id = $1`, [users.a.installation]);
  const susp = await page("a", `/?id=${a1x.id}`);
  check(susp.html.includes("SUSPENDED") && susp.html.includes("installation is suspended"), "a suspended installation is labelled and explained");
  await db.query(`UPDATE github_installations SET status = 'active' WHERE installation_id = $1`, [users.a.installation]);

  // --- 7. first-time and empty states -----------------------------------------------------------------
  console.log("\n7. First-time and empty states");
  const first = await page("c", "/");
  check(first.html.includes("Welcome to DeployGuard") && first.html.includes("Connect GitHub repositories"), "first-time user (no repositories) gets the welcome and connect step");
  const empty = await page("d", "/");
  check(empty.html.includes("No deployments yet") && empty.html.includes("CONNECTED"), "connected-but-no-deployments state");
} catch (error) {
  check(false, "verification crashed", error.stack?.split("\n").slice(0, 3).join(" | "));
} finally {
  for (const r of Object.values(repos)) await purgeRepository(r.ghId).catch(() => {});
  for (const u of Object.values(users)) {
    await db.query(`DELETE FROM sessions WHERE user_id = $1`, [u.id]).catch(() => {});
    await db.query(`DELETE FROM repositories WHERE installation_id = $1`, [u.installation]).catch((e) => console.log(`  WARN cleanup: ${e.message}`));
    await db.query(`DELETE FROM github_installations WHERE installation_id = $1`, [u.installation]).catch(() => {});
    await db.query(`DELETE FROM users WHERE id = $1`, [u.id]).catch(() => {});
  }
  await db.end();
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
