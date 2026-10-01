/**
 * Stage 1: LIVE cross-tenant canary test against the real Hindsight service.
 *
 *   npm run verify:hindsight-canary
 *
 * Retains one distinctive canary memory for each of two fake test tenants
 * (GitHub repository ids in the >= 900000000000 test range, which no real
 * repository uses), then recalls as each tenant exactly the way DeployGuard
 * does (ghrepo:<id> tags, tags_match "any_strict") and proves:
 *   - each tenant recalls its OWN canary;
 *   - neither tenant ever receives the other's canary;
 *   - a recall without tenant tags is not something DeployGuard can issue
 *     (checked in tests/hindsight-scope.test.mjs, not here).
 * Finally both canary documents are deleted and the deletion is checked.
 *
 * Writes to the configured bank (HINDSIGHT_BANK_ID). Needs HINDSIGHT_API_KEY
 * and HINDSIGHT_BASE_URL. No credential is printed.
 */
import crypto from "node:crypto";
import { loadEnv } from "./load-env.mjs";

loadEnv();

const key = process.env.HINDSIGHT_API_KEY;
const base = (process.env.HINDSIGHT_BASE_URL || "https://api.hindsight.vectorize.io").replace(/\/+$/, "");
const bank = process.env.HINDSIGHT_BANK_ID || "DeployGuard";

let failures = 0;
const check = (ok, step, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${step}${detail ? " -- " + detail : ""}`);
};

if (!key) {
  console.log("SKIP: HINDSIGHT_API_KEY is not set. MANUAL TEST REQUIRED: run this with Hindsight credentials.");
  process.exit(0);
}

async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

const run = crypto.randomBytes(4).toString("hex");
const tenants = [
  { name: "A", repo: String(900000000000 + crypto.randomInt(1, 1_000_000_000)), word: `zephyrcanary${run}alpha` },
  { name: "B", repo: String(900000000000 + crypto.randomInt(1, 1_000_000_000)), word: `quillcanary${run}bravo` },
];
for (const t of tenants) t.doc = `canary/${run}/${t.name}`;

const bankPath = `/v1/default/banks/${encodeURIComponent(bank)}`;

console.log(`DeployGuard Stage 1: live Hindsight cross-tenant canary (run ${run})\n`);
try {
  for (const t of tenants) {
    const r = await call("POST", `${bankPath}/memories`, {
      async: false,
      items: [
        {
          content: `Canary record ${t.word}: deployment of service canary-${t.name} failed with a database connection timeout during tests.`,
          context: "DeployGuard isolation canary (test data, deleted after the run)",
          document_id: t.doc,
          update_mode: "replace",
          tags: ["deployguard-canary", `ghrepo:${t.repo}`],
          metadata: { kind: "canary", tenant: t.name },
        },
      ],
    });
    check(r.status >= 200 && r.status < 300, `retain canary for tenant ${t.name}`, `HTTP ${r.status}`);
  }

  for (const me of tenants) {
    const other = tenants.find((t) => t !== me);
    const r = await call("POST", `${bankPath}/memories/recall`, {
      query: `database connection timeout canary ${me.word} ${other.word}`,
      max_tokens: 4096,
      budget: "mid",
      tags: [`ghrepo:${me.repo}`],
      tags_match: "any_strict",
    });
    const results = r.json?.results ?? [];
    const text = JSON.stringify(results);
    check(r.status === 200, `tenant ${me.name} recall succeeded`, `HTTP ${r.status}, ${results.length} result(s)`);
    // Hindsight returns extracted facts, which may paraphrase the canary word away,
    // so a memory is identified by its document id first, its text second.
    const isFrom = (m, t) => m.document_id === t.doc || String(m.text ?? "").includes(t.word);
    check(results.some((m) => isFrom(m, me)), `tenant ${me.name} recalls its OWN canary`,
      `document ids returned: ${[...new Set(results.map((m) => m.document_id ?? "?"))].join(", ")}`);
    check(!results.some((m) => isFrom(m, other)) && !text.includes(other.word) && !text.includes(other.doc),
      `tenant ${me.name} does NOT receive tenant ${other.name}'s canary`);
    check(
      results.every((m) => (m.tags ?? []).includes(`ghrepo:${me.repo}`)),
      `every result for tenant ${me.name} carries ghrepo:${me.repo}`
    );
  }
} finally {
  for (const t of tenants) {
    const del = await call("DELETE", `${bankPath}/documents/${encodeURIComponent(t.doc)}`);
    const gone = await call("GET", `${bankPath}/documents/${encodeURIComponent(t.doc)}`);
    check(del.status < 300 || del.status === 404, `delete canary document ${t.name}`, `HTTP ${del.status}`);
    check(gone.status === 404, `canary document ${t.name} is gone`, `HTTP ${gone.status}`);
  }
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
