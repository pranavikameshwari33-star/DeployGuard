/**
 * Stage 1: credential separation, CSRF, sessions, OAuth state, rate limiting,
 * and "no secret reaches the client". Dev server up:
 *
 *   npm run verify:csrf-and-auth
 *
 *   1  unit fixtures (tests/csrf-and-env.test.mjs)
 *   2  token separation: the CI status token is rejected on every internal
 *      route; the internal token is rejected on the CI status route
 *   3  CSRF: cookie-authenticated POSTs from another origin (or with no
 *      origin) are refused; the same POST from our origin is accepted
 *   4  cookies: the OAuth state cookie is HttpOnly, SameSite=Lax, path-scoped;
 *      each sign-in gets a fresh unpredictable state; a bad state is rejected
 *   5  sessions: logout revokes the session server-side
 *   6  rate limiting: a spoofed leftmost X-Forwarded-For does not reset the limit
 *   7  no server secret value appears in any API response collected here, in
 *      the dashboard HTML, or in the client JavaScript bundles on disk
 *
 * Role matrix (owner/member/viewer) does not exist yet (Stage 6): NOT TESTED.
 * Secure cookies in production: enforced in code by NODE_ENV; this dev server
 * is not production, so that flag is MANUAL TEST REQUIRED on a deployed host.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { loadEnv } from "./load-env.mjs";

loadEnv();

const BASE = process.env.APP_URL || "http://localhost:3000";
const statusToken = process.env.DEPLOYGUARD_STATUS_TOKEN;
const internalToken = process.env.DEPLOYGUARD_INTERNAL_TOKEN;
const connectionString = process.env.DATABASE_URL;
const SECRET_NAMES = [
  "GITHUB_WEBHOOK_SECRET", "DEPLOYGUARD_STATUS_TOKEN", "DEPLOYGUARD_INTERNAL_TOKEN", "DATABASE_URL",
  "HINDSIGHT_API_KEY", "GEMINI_API_KEY", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY", "SUPABASE_SECRET_KEY",
];
const secretValues = SECRET_NAMES.flatMap((name) => {
  const v = (process.env[name] ?? "").trim();
  if (v.length < 12) return [];
  // For the PEM, also look for any single body line.
  const parts = name === "GITHUB_APP_PRIVATE_KEY"
    ? v.replace(/\\n/g, "\n").split("\n").map((l) => l.trim()).filter((l) => l.length >= 40 && !l.startsWith("-----"))
    : [];
  return [{ name, v }, ...parts.map((p) => ({ name, v: p }))];
});
const secretsIn = (text) => [...new Set(secretValues.filter((s) => text.includes(s.v)).map((s) => s.name))];

let failures = 0;
const check = (ok, step, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${step}${detail ? " -- " + detail : ""}`);
};
const collected = [];
async function hit(pathname, init = {}) {
  const response = await fetch(`${BASE}${pathname}`, { redirect: "manual", ...init });
  const text = await response.text();
  collected.push(text, JSON.stringify([...response.headers]));
  return { status: response.status, text, headers: response.headers };
}
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

console.log("DeployGuard Stage 1: CSRF, auth and token separation\n");

const unit = spawnSync(process.execPath, ["--experimental-strip-types", "--test", "tests/csrf-and-env.test.mjs", "tests/hindsight-scope.test.mjs"], { encoding: "utf8" });
check(unit.status === 0, "unit fixtures (CSRF, env validation, secret tripwire, Hindsight scope)",
  `${/# pass (\d+)/.exec(unit.stdout)?.[1]} passed, ${/# fail (\d+)/.exec(unit.stdout)?.[1]} failed`);

if (!statusToken || !internalToken || !connectionString) {
  console.log("\nSKIP live checks: DEPLOYGUARD_STATUS_TOKEN, DEPLOYGUARD_INTERNAL_TOKEN and DATABASE_URL are required.");
  process.exit(failures ? 1 : 0);
}
check(statusToken !== internalToken, "status token and internal token are different values");

// --- 2. token separation ------------------------------------------------------------------
for (const [method, p] of [
  ["POST", "/api/maintenance/run"],
  ["POST", "/api/memory/backfill?limit=1"],
  ["GET", "/api/events"],
  ["GET", "/api/dashboard"],
  ["GET", "/api/deployments?limit=1"],
  ["GET", "/api/memory/recall?q=test"],
  ["POST", "/api/deployments/risk?id=1"],
]) {
  const r = await hit(p, { method, headers: bearer(statusToken) });
  check(r.status === 401, `status token REJECTED on ${method} ${p}`, `HTTP ${r.status}`);
}
const health = JSON.parse((await hit("/api/health", { headers: bearer(statusToken) })).text);
check(!("operations" in health), "status token gets no operational health detail");
const healthInternal = JSON.parse((await hit("/api/health", { headers: bearer(internalToken) })).text);
check("operations" in healthInternal, "internal token gets operational health detail");
const events = await hit("/api/events", { headers: bearer(internalToken) });
check(events.status === 200, "internal token ACCEPTED on an internal route", `HTTP ${events.status}`);
const ciWithInternal = await hit("/api/deployments/status", {
  method: "POST",
  headers: { ...bearer(internalToken), "Content-Type": "application/json" },
  body: JSON.stringify({ repository: "x/y", branch: "main", commitSha: "0".repeat(40), status: "BUILDING" }),
});
check(ciWithInternal.status === 401, "internal token REJECTED on the CI status route", `HTTP ${ciWithInternal.status}`);
const ciWithStatus = await hit("/api/deployments/status", {
  method: "POST",
  headers: { ...bearer(statusToken), "Content-Type": "application/json" },
  body: JSON.stringify({ repository: "x/y", branch: "main", commitSha: "0".repeat(40), status: "BUILDING" }),
});
check(ciWithStatus.status === 404, "status token ACCEPTED on the CI status route (404: no such deployment)", `HTTP ${ciWithStatus.status}`);

// --- 3 + 5. CSRF and logout, with a real session row --------------------------------------------
const client = new pg.Client({
  connectionString,
  ssl: /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString) ? undefined : { rejectUnauthorized: false },
});
await client.connect();
const githubId = 800000000000 + crypto.randomInt(1, 1_000_000_000);
const { rows: [user] } = await client.query(
  `INSERT INTO users (github_user_id, github_login, display_name) VALUES ($1, $2, 'Stage 1 verification') RETURNING id`,
  [githubId, `csrf-check-${crypto.randomBytes(3).toString("hex")}`]
);
const token = crypto.randomBytes(32).toString("base64url");
await client.query(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [
  user.id,
  crypto.createHash("sha256").update(token, "utf8").digest("hex"),
]);
const cookie = { Cookie: `dg_session=${token}` };
const sessionAlive = async () =>
  (await client.query(`SELECT 1 FROM sessions WHERE token_hash = $1`, [crypto.createHash("sha256").update(token).digest("hex")])).rowCount === 1;

try {
  for (const [label, headers] of [
    ["foreign Origin", { Origin: "https://evil.example" }],
    ["no Origin or Referer", {}],
    ["Sec-Fetch-Site cross-site", { Origin: BASE, "Sec-Fetch-Site": "cross-site" }],
  ]) {
    const risk = await hit("/api/deployments/risk?id=999999999999", { method: "POST", headers: { ...cookie, ...headers } });
    check(risk.status === 403, `Re-analyze POST with cookie and ${label} is refused`, `HTTP ${risk.status}`);
    const out = await hit("/auth/logout", { method: "POST", headers: { ...cookie, ...headers } });
    check(out.status === 403 && (await sessionAlive()), `logout POST with ${label} is refused (session intact)`, `HTTP ${out.status}`);
  }
  const sameOrigin = await hit("/api/deployments/risk?id=999999999999", { method: "POST", headers: { ...cookie, Origin: BASE } });
  check(sameOrigin.status === 404, "same-origin Re-analyze POST passes the CSRF check (404: not your deployment)", `HTTP ${sameOrigin.status}`);
  const logout = await hit("/auth/logout", { method: "POST", headers: { ...cookie, Origin: BASE } });
  check(logout.status === 303 && !(await sessionAlive()), "same-origin logout revokes the session server-side", `HTTP ${logout.status}`);
  check((await hit("/api/dashboard", { headers: cookie })).status === 401, "the revoked session no longer works");
} finally {
  await client.query(`DELETE FROM sessions WHERE user_id = $1`, [user.id]);
  await client.query(`DELETE FROM users WHERE id = $1`, [user.id]);
}

// --- 4. OAuth state cookie ---------------------------------------------------------------------------
const testIp = `198.51.100.${crypto.randomInt(1, 254)}`;
const start1 = await hit("/auth/github", { headers: { "X-Forwarded-For": testIp } });
const start2 = await hit("/auth/github", { headers: { "X-Forwarded-For": testIp } });
const setCookie = start1.headers.get("set-cookie") ?? "";
check(/dg_oauth_state=/.test(setCookie) && /HttpOnly/i.test(setCookie) && /SameSite=lax/i.test(setCookie) && /Path=\/auth\/github/i.test(setCookie),
  "OAuth state cookie is HttpOnly, SameSite=Lax and scoped to /auth/github");
const state = (r) => new URL(r.headers.get("location") ?? "http://x").searchParams.get("state");
check(state(start1) && state(start1) !== state(start2) && state(start1).length >= 32, "each sign-in gets a fresh, long random state");
console.log(`  INFO  Secure flag on cookies: ${/;\s*Secure/i.test(setCookie) ? "present" : "absent (expected on a non-production dev server; set when NODE_ENV=production)"}`);
const forged = await hit(`/auth/github/callback?code=abc&state=forged`, {
  headers: { Cookie: `dg_oauth_state=login:${state(start1)}`, "X-Forwarded-For": testIp },
});
check(forged.status >= 300 && forged.status < 400 && /error=state/.test(forged.headers.get("location") ?? ""), "callback with a mismatched state is rejected");

// --- 6. rate limit cannot be dodged by spoofing X-Forwarded-For --------------------------------------
const proxyIp = `203.0.113.${crypto.randomInt(1, 254)}`;
let limitedAt = 0;
for (let i = 1; i <= 32; i++) {
  // The client prepends a different fake address every time; the proxy-appended (rightmost) address stays the same.
  const r = await hit("/auth/github", { headers: { "X-Forwarded-For": `10.${i}.0.1, ${proxyIp}` } });
  if (r.status === 429) {
    limitedAt = i;
    break;
  }
}
check(limitedAt === 31, "sign-in start is rate limited at 30 per window despite a rotating spoofed X-Forwarded-For", `429 at request ${limitedAt || "never"}`);
const limited = collected[collected.length - 2] ?? "";
check(!/stack|at \w+ \(|node_modules/i.test(limited), "429 response carries no internals");

// --- 7. no secret value in responses, page, or client bundles ------------------------------------------
const page = await hit("/", { headers: bearer(internalToken) });
check(secretsIn(page.text).length === 0, "dashboard HTML contains no server secret");
const inResponses = secretsIn(collected.join("\n"));
check(inResponses.length === 0, "no API response collected here contains a server secret", inResponses.join(", "));

const bundleDirs = [".next/static", ".next/dev/static"].filter((d) => fs.existsSync(d));
let scanned = 0;
const found = new Set();
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(js|mjs|css|html|json|map)$/.test(entry.name)) {
      scanned++;
      for (const name of secretsIn(fs.readFileSync(full, "utf8"))) found.add(name);
    }
  }
};
bundleDirs.forEach(walk);
if (scanned === 0) console.log("  NOTE  no client bundle on disk yet (run `npm run build`, or load a page in dev); bundle scan skipped");
else check(found.size === 0, "client JavaScript bundles contain no server secret value", `${scanned} file(s) scanned${found.size ? "; found: " + [...found].join(", ") : ""}`);
check(!/DEPLOYGUARD_INTERNAL_TOKEN|DEPLOYGUARD_STATUS_TOKEN/.test(page.text), "the page does not even name the tokens");

await client.end();
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
