import crypto from "node:crypto";

/**
 * Builds a realistic GitHub `push` payload and signs it exactly the way GitHub
 * does, so local tests exercise the real signature-verification path.
 *
 * Shared by send-test-webhook.mjs and verify-phase2.mjs so the fake push is
 * defined in exactly one place.
 */
export function buildPushPayload(overrides = {}) {
  const sha = overrides.sha ?? crypto.randomBytes(20).toString("hex");
  const timestamp = new Date().toISOString();

  const commit = {
    id: sha,
    message: overrides.message ?? "Reduce database connection pool size",
    timestamp,
    url: `https://github.com/demo-owner/demo-repo/commit/${sha.slice(0, 7)}`,
    author: { name: "Dev Example", email: "dev@example.com", username: "dev-example" },
    added: overrides.added ?? ["config/database.staging.yaml"],
    removed: overrides.removed ?? ["docs/old-notes.md"],
    modified: overrides.modified ?? ["config/database.yaml", "src/db/pool.ts"],
  };

  return {
    ref: `refs/heads/${overrides.branch ?? "main"}`,
    before: "0000000000000000000000000000000000000000",
    after: sha,
    created: false,
    deleted: false,
    forced: false,
    compare: "https://github.com/demo-owner/demo-repo/compare/abc...def",
    repository: {
      name: "demo-repo",
      full_name: "demo-owner/demo-repo",
      html_url: "https://github.com/demo-owner/demo-repo",
      default_branch: "main",
      owner: { name: "demo-owner", login: "demo-owner" },
    },
    pusher: { name: "demo-owner", email: "dev@example.com" },
    head_commit: commit,
    commits: [commit],
  };
}

/** Signs a raw body with the webhook secret, producing GitHub's header value. */
export function signBody(rawBody, secret) {
  return "sha256=" + crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/**
 * POSTs a payload to the webhook endpoint with correct GitHub headers.
 *
 * `autoRisk` (Phase 8): verification scripts create many test pushes, and each
 * automatic risk analysis can cost a Gemini call. So by default a scripted
 * delivery asks the server to skip automatic analysis. The header is honoured
 * only on a correctly signed delivery; real GitHub pushes never send it.
 */
export async function deliver(url, payload, secret, eventType = "push", { autoRisk = false } = {}) {
  const rawBody = JSON.stringify(payload);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": eventType,
      "X-GitHub-Delivery": crypto.randomUUID(),
      "X-Hub-Signature-256": signBody(rawBody, secret),
      "User-Agent": "GitHub-Hookshot/local-test",
      ...(autoRisk ? {} : { "X-DeployGuard-Auto-Risk": "off" }),
    },
    body: rawBody,
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: response.status, body: json };
}
