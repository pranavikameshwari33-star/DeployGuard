import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSameOrigin } from "../lib/auth/csrf.ts";
import { findServerSecretIn, validateServerEnv } from "../lib/env.ts";

/** Stage 1: CSRF origin checks, secret tripwire and startup validation. */

const req = (headers, url = "https://deployguard.example.com/api/deployments/risk?id=1") =>
  new Request(url, { method: "POST", headers: { host: new URL(url).host, ...headers } });

test("same-origin POSTs are allowed", () => {
  assert.equal(checkSameOrigin(req({ origin: "https://deployguard.example.com" })).ok, true);
  assert.equal(checkSameOrigin(req({ referer: "https://deployguard.example.com/?id=3" })).ok, true);
  assert.equal(checkSameOrigin(req({ origin: "https://deployguard.example.com", "sec-fetch-site": "same-origin" })).ok, true);
});

test("cross-site POSTs are rejected", () => {
  for (const headers of [
    { origin: "https://evil.example" },
    { origin: "null" },
    { referer: "https://evil.example/page" },
    { origin: "https://deployguard.example.com", "sec-fetch-site": "cross-site" },
    { origin: "https://deployguard.example.com", "sec-fetch-site": "same-site" },
    {},
  ]) {
    assert.equal(checkSameOrigin(req(headers)).ok, false, JSON.stringify(headers));
  }
});

test("a configured public base URL is accepted (reverse proxy / ngrok)", () => {
  const r = req({ origin: "https://abc.ngrok-free.app" }, "http://localhost:3000/auth/logout");
  assert.equal(checkSameOrigin(r).ok, false);
  assert.equal(checkSameOrigin(r, "https://abc.ngrok-free.app").ok, true);
});

test("secret tripwire names the variable whose value appears, never the value", () => {
  const saved = { ...process.env };
  try {
    process.env.GEMINI_API_KEY = "fixture-gemini-value-0123456789";
    process.env.DEPLOYGUARD_INTERNAL_TOKEN = "fixture-internal-token-abcdefghijklmnopqrstuvwxyz";
    assert.equal(findServerSecretIn("nothing here"), null);
    assert.equal(findServerSecretIn(`x ${process.env.GEMINI_API_KEY} y`), "GEMINI_API_KEY");
    assert.equal(findServerSecretIn(`{"t":"${process.env.DEPLOYGUARD_INTERNAL_TOKEN}"}`), "DEPLOYGUARD_INTERNAL_TOKEN");
  } finally {
    process.env = saved;
  }
});

test("startup validation: missing variables, equal tokens, NEXT_PUBLIC_ secrets", () => {
  const saved = { ...process.env };
  try {
    for (const k of Object.keys(process.env)) delete process.env[k];
    const missing = validateServerEnv();
    assert.ok(missing.some((p) => p.includes("DEPLOYGUARD_INTERNAL_TOKEN")));
    const same = "s".repeat(40);
    Object.assign(process.env, { DEPLOYGUARD_STATUS_TOKEN: same, DEPLOYGUARD_INTERNAL_TOKEN: same, NEXT_PUBLIC_API_KEY: "x" });
    const problems = validateServerEnv();
    assert.ok(problems.some((p) => p.includes("must be different")));
    assert.ok(problems.some((p) => p.includes("NEXT_PUBLIC_API_KEY")));
    assert.ok(problems.every((p) => !p.includes(same)), "a problem message contained a value");
  } finally {
    process.env = saved;
  }
});
