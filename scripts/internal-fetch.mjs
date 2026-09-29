/**
 * fetch() as DeployGuard's internal tooling (Phase 9).
 *
 * Since Phase 9, browser-facing endpoints (dashboard, deployments, similar,
 * risk, recall) require either a signed-in user or the internal Bearer token.
 * The verification scripts are internal tooling, so they present the existing
 * DEPLOYGUARD_STATUS_TOKEN (loaded from .env.local by load-env.mjs). The token
 * only ever goes in the Authorization header and is never printed.
 */
export function internalFetch(url, init = {}) {
  const token = process.env.DEPLOYGUARD_STATUS_TOKEN;
  return fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
}
