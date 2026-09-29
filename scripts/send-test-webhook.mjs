/**
 * Sends one fake-but-correctly-signed GitHub push event to your local server.
 *
 * Lets you exercise the whole path (signature -> database -> Hindsight) without
 * GitHub and without ngrok.
 *
 *   npm run dev            (in one terminal)
 *   npm run test:webhook   (in another terminal)
 */
import { loadEnv } from "./load-env.mjs";
import { buildPushPayload, deliver } from "./test-payload.mjs";

loadEnv();

const secret = process.env.GITHUB_WEBHOOK_SECRET;
const url = process.env.WEBHOOK_URL || "http://localhost:3000/api/webhook/github";

if (!secret) {
  console.error("GITHUB_WEBHOOK_SECRET not found in .env.local. Create it first.");
  process.exit(1);
}

// Behaves like a real GitHub push, including automatic risk analysis (Phase 8).
const { status, body } = await deliver(url, buildPushPayload(), secret, "push", { autoRisk: true });

console.log("Status:", status);
console.log("Body  :", JSON.stringify(body, null, 2));
