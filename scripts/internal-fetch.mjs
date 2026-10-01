/**
 * fetch() as DeployGuard's internal tooling (Phase 9).
 *
 * Since Phase 9, browser-facing endpoints (dashboard, deployments, similar,
 * risk, recall) require either a signed-in user or the internal Bearer token.
 * The verification scripts are internal tooling, so they present
 * DEPLOYGUARD_INTERNAL_TOKEN (Stage 1: the CI status token no longer works on
 * these endpoints). Loaded from .env.local by load-env.mjs; the token only ever
 * goes in the Authorization header and is never printed.
 */
export function internalFetch(url, init = {}) {
  const token = process.env.DEPLOYGUARD_INTERNAL_TOKEN;
  return fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
}
