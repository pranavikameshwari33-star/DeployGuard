import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyGithubSignature } from "../lib/github/verify-signature.ts";

// A throwaway value used only inside this test file; not a real secret.
const SECRET = "test-only-secret";
const BODY = JSON.stringify({ ref: "refs/heads/main", after: "abc" });
const sign = (body, secret) =>
  "sha256=" + crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");

test("accepts a body signed with the right secret", () => {
  assert.equal(verifyGithubSignature(BODY, sign(BODY, SECRET), SECRET), true);
});

test("rejects a body signed with a different secret", () => {
  assert.equal(verifyGithubSignature(BODY, sign(BODY, "someone-else"), SECRET), false);
});

test("rejects a body that was changed after signing", () => {
  const signature = sign(BODY, SECRET);
  assert.equal(verifyGithubSignature(BODY + " ", signature, SECRET), false);
});

test("rejects a missing or malformed signature header", () => {
  assert.equal(verifyGithubSignature(BODY, null, SECRET), false);
  assert.equal(verifyGithubSignature(BODY, "sha1=abc", SECRET), false);
  assert.equal(verifyGithubSignature(BODY, "sha256=short", SECRET), false);
});
