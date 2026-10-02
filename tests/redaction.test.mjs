import { test } from "node:test";
import assert from "node:assert/strict";
import {
  redact,
  redactDeep,
  prepareFailureOutput,
  tailOutput,
  FAILURE_OUTPUT_LIMITS,
} from "../lib/security/redact.ts";

/**
 * Stage 1 redaction fixtures. Secret-shaped strings are ASSEMBLED at runtime
 * (never written out whole in this file), so the repository itself contains no
 * key-shaped literals for scanners to flag. None of these are real credentials.
 */
const rand = (alphabet, n, seed = 7) => {
  let out = "";
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += alphabet[x % alphabet.length];
  }
  return out;
};
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const UPPER_NUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const B64 = ALNUM + "+/";

const F = {
  ghp: "ghp" + "_" + rand(ALNUM, 36, 1),
  gho: "gho" + "_" + rand(ALNUM, 36, 2),
  ghs: "ghs" + "_" + rand(ALNUM, 36, 3),
  ghu: "ghu" + "_" + rand(ALNUM, 36, 4),
  ghr: "ghr" + "_" + rand(ALNUM, 36, 5),
  pat: "github" + "_pat_" + rand(ALNUM + "_", 82, 6),
  awsId: "AK" + "IA" + rand(UPPER_NUM, 16, 8),
  awsSecret: rand(B64, 40, 9),
  google: "AI" + "za" + rand(ALNUM + "_-", 35, 10),
  jwt: ["eyJ" + rand(ALNUM, 30, 11), "eyJ" + rand(ALNUM, 40, 12), rand(ALNUM + "_-", 43, 13)].join("."),
  slack: "xo" + "xb-" + rand("0123456789", 12, 14) + "-" + rand(ALNUM, 24, 15),
  npm: "npm" + "_" + rand(ALNUM, 36, 16),
  stripe: "sk" + "_live_" + rand(ALNUM, 24, 17),
  supabase: "sb" + "_secret_" + rand(ALNUM, 32, 18),
  entropy: rand(ALNUM, 48, 19),
};
const pem = [
  "-----BEGIN RSA PRIVATE KEY-----",
  rand(B64, 64, 20),
  rand(B64, 64, 21),
  rand(B64, 30, 22) + "==",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

function assertMasked(input, secret, category) {
  const r = redact(input);
  assert.ok(!r.text.includes(secret), `secret survived in: ${r.text}`);
  if (category) assert.ok(r.categories.includes(category), `expected category ${category}, got ${r.categories}`);
  assert.ok(r.count >= 1);
  return r;
}

test("GitHub tokens of every prefix are masked", () => {
  for (const key of ["ghp", "gho", "ghs", "ghu", "ghr", "pat"]) {
    assertMasked(`git clone https://x:${F[key]}@github.com/o/r`, F[key]);
    assertMasked(`using token ${F[key]} now`, F[key], "github_token");
  }
});

test("AWS access key id and secret are masked", () => {
  assertMasked(`aws configure set aws_access_key_id ${F.awsId}`, F.awsId, "aws_access_key");
  assertMasked(`AWS_SECRET_ACCESS_KEY=${F.awsSecret}`, F.awsSecret, "secret_assignment");
  assertMasked(`aws_secret_access_key = "${F.awsSecret}"`, F.awsSecret);
});

test("Google API key, JWT, Slack, npm, Stripe, Supabase keys are masked", () => {
  assertMasked(`maps key ${F.google} loaded`, F.google, "google_api_key");
  assertMasked(`cookie=${F.jwt}`, F.jwt);
  assertMasked(`session ${F.jwt} expired`, F.jwt, "jwt");
  assertMasked(`SLACK ${F.slack}`, F.slack, "slack_token");
  assertMasked(`//registry.npmjs.org/:_authToken ${F.npm}`, F.npm, "npm_token");
  assertMasked(`charge with ${F.stripe}`, F.stripe, "stripe_key");
  assertMasked(`supabase ${F.supabase}`, F.supabase, "supabase_key");
});

test("private key blocks are masked whole, even when the END line is missing", () => {
  const r = assertMasked(`Loading key\n${pem}\nDone`, pem.split("\n")[1], "private_key");
  assert.ok(r.text.includes("Loading key") && r.text.includes("Done"));
  const cut = pem.split("\n").slice(0, 3).join("\n");
  assertMasked(`partial:\n${cut}`, pem.split("\n")[2], "private_key");
});

test("Authorization headers keep the scheme and drop the credential", () => {
  const r = assertMasked(`curl -H "Authorization: Bearer ${F.entropy}" https://api`, F.entropy, "auth_header");
  assert.match(r.text, /Bearer \[REDACTED:auth_header\]/);
  const basic = Buffer.from("deploy:" + rand(ALNUM, 14, 30)).toString("base64");
  assertMasked(`Authorization: Basic ${basic}`, basic, "auth_header");
});

test("URLs with credentials and database connection strings are masked", () => {
  const pass = rand(ALNUM, 18, 31);
  const r = assertMasked(`fetching https://deploy:${pass}@registry.example.com/pkg`, pass, "url_credentials");
  assert.match(r.text, /https:\/\/\[REDACTED:url_credentials\]@registry\.example\.com\/pkg/);
  assertMasked(`DATABASE_URL=postgresql://postgres.abc:${pass}@aws-0.pooler.supabase.com:6543/postgres`, pass);
  assertMasked(`connect mongodb+srv://app:${pass}@cluster0.mongodb.net/db failed`, pass, "connection_string");
  assertMasked(`redis://default:${pass}@cache:6379`, pass);
});

test(".env-style KEY=value lines with sensitive names are masked; the key name is kept", () => {
  const v = rand(ALNUM, 20, 32);
  for (const line of [
    `API_KEY=${v}`,
    `export STRIPE_SECRET=${v}`,
    `DB_PASSWORD="${v}"`,
    `client_secret: ${v}`,
    `{"access_token": "${v}"}`,
    `SESSION_KEY='${v}'`,
  ]) {
    const r = assertMasked(line, v);
    assert.match(r.text, /\[REDACTED:/);
  }
  assert.match(redact(`API_KEY=${v}`).text, /^API_KEY=\[REDACTED:secret_assignment\]$/);
});

test("long high-entropy strings are masked", () => {
  assertMasked(`unexpected value ${F.entropy} in payload`, F.entropy, "high_entropy");
});

test("FALSE POSITIVES: ordinary CI and commit text survives unchanged", () => {
  const ordinary = [
    "fix: handle null user in checkout flow",
    "Merge pull request #42 from octo/feature-login",
    "commit 3f9c2a1b7d4e5f60718293a4b5c6d7e8f9012345",
    "sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "request id 123e4567-e89b-12d3-a456-426614174000",
    "src/components/checkout/PaymentSummaryWithDiscounts.tsx",
    "FAIL tests/integration/database-connection-pool.test.ts (12.3 s)",
    "SyntaxError: Unexpected token: } in JSON at position 42",
    "Error: password: required field missing",
    "GITHUB_TOKEN: ***",
    "token: ${{ secrets.GITHUB_TOKEN }}",
    "Basic configuration loaded from defaults",
    "npm ERR! code ELIFECYCLE",
    "Connection timeout after 30000ms to db.internal:5432",
    "https://github.com/octo/repo/actions/runs/1234567890/job/987654321",
    "Bearer token rejected by upstream",
    "PASSWORD=",
    "The tokenizer handled 1200 items",
  ];
  for (const line of ordinary) {
    const r = redact(line);
    assert.equal(r.text, line, `false positive on: ${line}`);
    assert.equal(r.count, 0);
  }
});

test("redaction is idempotent and records counts and categories only", () => {
  const input = `token ${F.ghp} and API_KEY=${F.entropy}`;
  const once = redact(input);
  const twice = redact(once.text);
  assert.equal(twice.text, once.text);
  assert.equal(twice.count, 0);
  assert.deepEqual(once.categories, ["github_token", "secret_assignment"]);
  for (const c of once.categories) assert.ok(!c.includes(F.ghp));
});

test("redactDeep reaches nested strings and keeps keys and non-strings", () => {
  const { value, summary } = redactDeep({ a: [`x ${F.ghp}`], b: { c: 5, d: `pw: ${F.entropy}` }, when: new Date(0) });
  assert.ok(!JSON.stringify(value).includes(F.ghp));
  assert.equal(value.b.c, 5);
  assert.ok(value.when instanceof Date);
  assert.ok(summary.count >= 2);
});

test("failure output keeps the last 40 lines, caps line length and total size", () => {
  const lines = Array.from({ length: 120 }, (_, i) => `line ${i} ` + "x".repeat(i === 119 ? 900 : 10));
  const out = tailOutput(lines.join("\n"));
  const kept = out.split("\n");
  assert.equal(kept.length, FAILURE_OUTPUT_LIMITS.maxLines);
  assert.ok(kept[0].startsWith("line 80 "));
  assert.ok(kept.every((l) => l.length <= FAILURE_OUTPUT_LIMITS.maxLineLength + 4));
  assert.ok(out.length <= FAILURE_OUTPUT_LIMITS.maxTotal);
  assert.ok(!/\x1b/.test(tailOutput("\x1b[31mred\x1b[0m error")));
});

test("prepareFailureOutput redacts a secret in a realistic CI log tail", () => {
  const log = [
    "Run npm test",
    `npm notice using registry token ${F.npm}`,
    "  database",
    `    x connects (DATABASE_URL=postgres://ci:${F.entropy}@db:5432/app)`,
    "      Error: connect ETIMEDOUT 10.0.0.5:5432",
    "Process completed with exit code 1.",
  ].join("\n");
  const r = prepareFailureOutput(log);
  assert.ok(!r.text.includes(F.npm) && !r.text.includes(F.entropy));
  assert.ok(r.text.includes("Error: connect ETIMEDOUT 10.0.0.5:5432"));
  assert.ok(r.count >= 2);
});
