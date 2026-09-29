import crypto from "node:crypto";

/**
 * Checks an `Authorization: Bearer <token>` header in constant time. Both sides
 * are hashed first so they are always the same length, which timingSafeEqual
 * requires, without revealing the real token's length.
 *
 * Shared by the routes that only DeployGuard's own callers may use: the CI
 * status endpoint (Phase 3) and the risk-analysis trigger (Phase 7).
 */
export function isAuthorized(header: string | null, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const received = header.slice("Bearer ".length).trim();
  const digest = (value: string) => crypto.createHash("sha256").update(value, "utf8").digest();
  return crypto.timingSafeEqual(digest(received), digest(expected));
}
