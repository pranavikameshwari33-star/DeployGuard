/**
 * Stage 1: CSRF protection for state-changing requests made with the session
 * cookie (Re-analyze, logout, and every future disconnect / root cause /
 * purge / settings route).
 *
 * Strategy (documented in docs/SECURITY.md):
 *   1. The session cookie is SameSite=Lax, so browsers do not attach it to
 *      cross-site POST/PUT/DELETE requests at all.
 *   2. On top of that, every cookie-authenticated state change must come from
 *      DeployGuard's own origin: Sec-Fetch-Site must not be "cross-site" /
 *      "same-site", and Origin (or, if absent, Referer) must match the origin
 *      the request was addressed to (or DEPLOYGUARD_BASE_URL). A request with
 *      neither Origin nor Referer is refused.
 *   3. Bearer-token requests are exempt: a token is not an ambient credential a
 *      browser attaches by itself, so it cannot be forged cross-site.
 *
 * Pure apart from reading the request, so it is unit-tested directly.
 */

export type CsrfCheck = { ok: true } | { ok: false; reason: string };

function originOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** The origins this request may legitimately come from. */
export function allowedOrigins(request: Request, baseUrl = process.env.DEPLOYGUARD_BASE_URL): Set<string> {
  const allowed = new Set<string>();
  const own = originOf(request.url);
  if (own) allowed.add(own);
  // The Host header is what the browser addressed; a cross-site attacker cannot
  // change it on the victim's request. (Covers ngrok / reverse proxies.)
  const host = request.headers.get("host");
  if (host && /^[a-z0-9.-]+(:\d{1,5})?$/i.test(host)) {
    allowed.add(`https://${host}`);
    if (process.env.NODE_ENV !== "production") allowed.add(`http://${host}`);
  }
  const configured = originOf(baseUrl ?? null);
  if (configured) allowed.add(configured);
  return allowed;
}

export function checkSameOrigin(request: Request, baseUrl?: string): CsrfCheck {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return { ok: false, reason: `sec-fetch-site ${site}` };
  }
  const allowed = allowedOrigins(request, baseUrl);
  const origin = request.headers.get("origin");
  if (origin) {
    if (origin === "null") return { ok: false, reason: "opaque origin" };
    return allowed.has(origin) ? { ok: true } : { ok: false, reason: "origin mismatch" };
  }
  const referer = originOf(request.headers.get("referer"));
  if (referer) return allowed.has(referer) ? { ok: true } : { ok: false, reason: "referer mismatch" };
  return { ok: false, reason: "no origin or referer" };
}

/** True when the request authenticates with a Bearer token rather than the cookie. */
export function usesBearerToken(request: Request): boolean {
  return request.headers.get("authorization")?.startsWith("Bearer ") ?? false;
}
