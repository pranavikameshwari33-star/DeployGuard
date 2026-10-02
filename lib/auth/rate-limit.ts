import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { getPool } from "@/lib/db/client";

/**
 * Phase 10: fixed-window rate limiting stored in PostgreSQL (rate_limits).
 *
 * Why the database: DeployGuard may run as several serverless instances, so an
 * in-memory counter would reset per instance. One upsert per request is cheap
 * and needs no extra infrastructure.
 *
 * Fails OPEN: if the database cannot be reached the request is allowed (and
 * logged). Signing in must not break because the limiter is unavailable.
 */

export type RateLimitRule = { limit: number; windowSeconds: number };

/** Limits for the sensitive routes. Generous enough for development and manual testing. */
export const RATE_LIMITS = {
  authStart: { limit: 30, windowSeconds: 10 * 60 },     // GET /auth/github
  authCallback: { limit: 30, windowSeconds: 10 * 60 },  // GET /auth/github/callback
  authInstall: { limit: 30, windowSeconds: 10 * 60 },   // GET /auth/github/install
  authLogout: { limit: 60, windowSeconds: 10 * 60 },    // POST /auth/logout
  riskRefresh: { limit: 10, windowSeconds: 60 * 60 },   // POST /api/deployments/risk?refresh=1 by a user (Gemini cost)
  // Stage 1: intake and expensive endpoints.
  webhook: { limit: 600, windowSeconds: 60 },           // POST /api/webhook/github, per source address
  ciStatus: { limit: 120, windowSeconds: 60 },          // POST /api/deployments/status, per source address
  memoryRecall: { limit: 60, windowSeconds: 10 * 60 },  // GET /api/memory/recall by a user (Hindsight call)
  riskAnalyze: { limit: 30, windowSeconds: 60 * 60 },   // POST /api/deployments/risk by a user (may call Gemini)
  purge: { limit: 5, windowSeconds: 60 * 60 },          // Stage 2: repository / account purge, per user
  export: { limit: 20, windowSeconds: 60 * 60 },        // Stage 2: data export, per user
  // Stage 4: learning features.
  incidentConfirm: { limit: 30, windowSeconds: 60 * 60 }, // POST /api/incidents/confirmation, per user
  askHistory: { limit: 30, windowSeconds: 10 * 60 },      // ask-your-history (Hindsight call), per user
} satisfies Record<string, RateLimitRule>;

/**
 * A client key from the request: hashed, so no raw IP address is ever stored.
 *
 * Stage 1 fix: the LEFTMOST X-Forwarded-For entry is whatever the client chose
 * to send, so keying on it let anyone dodge every limit by rotating a header.
 * Each proxy APPENDS the address it saw, so the trustworthy entry is counted
 * from the RIGHT: with N trusted proxies in front of DeployGuard
 * (DEPLOYGUARD_TRUSTED_PROXY_HOPS, default 1 -- e.g. ngrok, Vercel, one
 * reverse proxy), the client is the Nth entry from the right.
 */
export function clientKey(request: Request): string {
  const hops = Math.max(1, Number(process.env.DEPLOYGUARD_TRUSTED_PROXY_HOPS) || 1);
  const chain = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const forwarded = chain.length ? chain[Math.max(0, chain.length - hops)] : undefined;
  const ip = forwarded || request.headers.get("x-real-ip") || "unknown";
  return crypto.createHash("sha256").update(`deployguard-rl:${ip}`).digest("hex").slice(0, 32);
}

export async function checkRateLimit(
  name: string,
  key: string,
  rule: RateLimitRule
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const windowStartSec = nowSec - (nowSec % rule.windowSeconds);
  try {
    const result = await getPool().query<{ count: number }>(
      `INSERT INTO rate_limits (bucket, window_start, count) VALUES ($1, to_timestamp($2), 1)
       ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limits.count + 1
       RETURNING count`,
      [`${name}:${key}`, windowStartSec]
    );
    // Opportunistic, bounded cleanup of old windows (~1 in 50 requests).
    if (Math.random() < 0.02) {
      getPool()
        .query(
          `DELETE FROM rate_limits WHERE ctid IN (
             SELECT ctid FROM rate_limits WHERE window_start < now() - interval '1 day' LIMIT 1000)`
        )
        .catch(() => {});
    }
    const allowed = result.rows[0].count <= rule.limit;
    return { allowed, retryAfterSeconds: allowed ? 0 : windowStartSec + rule.windowSeconds - nowSec };
  } catch (error) {
    console.error(`[DeployGuard][ratelimit] Check failed for ${name}, allowing request: ${(error as Error).message}`);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

/** Returns a 429 response when the caller is over the limit, otherwise null. */
export async function rateLimitResponse(
  request: Request,
  name: keyof typeof RATE_LIMITS,
  key = clientKey(request)
): Promise<NextResponse | null> {
  const { allowed, retryAfterSeconds } = await checkRateLimit(name, key, RATE_LIMITS[name]);
  if (allowed) return null;
  console.warn(`[DeployGuard][ratelimit] ${name} limit reached (retry in ${retryAfterSeconds}s).`);
  return NextResponse.json(
    { error: "Too many requests. Please wait and try again.", retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } }
  );
}
