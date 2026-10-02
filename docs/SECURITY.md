# DeployGuard security model (Stage 1)

This document records the security decisions made in Stage 1 and how each one is tested.
Anything marked **MANUAL** cannot be proven by the automated suite and needs a person.

## 1. Credentials and their separation

| Variable | Used for | Accepted by | Never accepted by |
| --- | --- | --- | --- |
| `DEPLOYGUARD_STATUS_TOKEN` | CI status reports from GitHub Actions | `POST /api/deployments/status` only | every other route (maintenance, backfill, events, dashboard, recall, risk, health detail) |
| `DEPLOYGUARD_INTERNAL_TOKEN` | maintenance schedule, memory backfill, verification scripts, operational health detail | internal routes (`getViewer()` → `internal`) | `POST /api/deployments/status` |
| `GITHUB_WEBHOOK_SECRET` | HMAC check of every webhook delivery | `POST /api/webhook/github` | — |

* Tokens are compared in constant time (SHA-256 both sides, `timingSafeEqual`).
* The two tokens must be different; startup validation (`instrumentation.ts` →
  `validateServerEnv()`) refuses to start in production if they are equal, if a required
  variable is missing, if a token is shorter than 32 characters, or if any
  `NEXT_PUBLIC_*` variable looks like a secret. Messages name the variable, never the value.
* Why the split matters: the status token lives in GitHub Actions secrets of the
  monitored repository, so it is the credential most likely to leak. Before Stage 1 it
  also unlocked maintenance, backfill and unscoped reads of every tenant's data.
* Secret tripwire: right before data is sent to Hindsight or Gemini, the request is
  refused if it contains the value of any server secret (`findServerSecretIn`).
* **Operator action after Stage 1:** the maintenance workflow now reads the repository
  secret `DEPLOYGUARD_INTERNAL_TOKEN`. Add it in GitHub → Settings → Secrets and
  variables → Actions, with the same value as `.env.local`. Until then the scheduled
  maintenance run is refused (401).

## 2. Redaction of ingested content

One module, `lib/security/redact.ts`, used everywhere. Detects and masks: private key
blocks (also when the END line was cut off), GitHub tokens (`ghp_ gho_ ghu_ ghs_ ghr_
github_pat_`), AWS access key ids, Google API keys, Slack tokens and webhook URLs, Stripe,
npm and Supabase keys, JWTs, `Bearer`/`Basic` credentials, URLs with `user:password@`,
database/broker connection strings, `KEY=value` / `"key": "value"` assignments whose key
name looks secret, and long high-entropy strings. Pure hex (commit SHAs, digests) and
UUIDs are never treated as secrets; `tests/redaction.test.mjs` has false-positive fixtures.
Extra rules can be passed via `RedactionOptions.extraRules`.

Where it is applied (before the data goes anywhere):

| Data | Point of redaction |
| --- | --- |
| Commit message | `ingestPush()` (every ingestion path) and the webhook route before logging |
| Failure output, failed job/step | `applyPipelineStatus()` (CI reporter, `workflow_run`, reconciliation) |
| Incident observed output | copied from the already-redacted deployment row |
| Stored `workflow_run` payload text, delivery errors | `lib/db/webhook-deliveries.ts` |
| Hindsight | `retain()` redacts every string of every memory item |
| Gemini | `protectEvidence()` in `lib/risk/evidence.ts` |
| Dashboard | `getDashboardData()` redacts its whole result (covers rows stored before Stage 1) |
| Recall API | recalled memory text is redacted before it is returned |
| Server logs of internal errors | `logErrorRef()` |
| GitHub output | no DeployGuard output is posted to GitHub yet (PR checks are Stage 5) |

Failure output keeps the last 40 lines, at most 500 characters per line and 4000 in
total. What was removed is recorded as counts and categories only, in
`deployments.redaction` (migration `009_redaction.sql`). The raw text is never stored.

Rows stored before Stage 1: `npm run db:redact-existing` (dry run, counts only) and
`npm run db:redact-existing -- --apply` (irreversible rewrite). Afterwards, re-store
deployment memories with the internal `/api/memory/backfill` endpoint.

## 3. Untrusted content: prompt injection and XSS

* **Into Gemini:** commit messages, branch, author, file paths, job/step names, CI output
  and incident text are redacted, stripped of control/bidi characters, prompt-like
  delimiters (```` ``` ````, `<|...|>`, `<system>`, `[INST]`) are neutralised, and each is
  length-capped (`lib/security/untrusted.ts`). They travel only as JSON string values.
  The system instruction states that all such fields are data and never instructions.
  Prompt version bumped to `risk-v3`, so earlier stored assessments are not reused.
* **Out of Gemini:** the validator rejects the whole answer if ANY free-text field
  (summary, reasons, relevance notes, missing information, recommended checks) refers to a
  deployment/incident id not in the bundle, contains a URL not present in the bundle or a
  non-http scheme, contains HTML markup or a markdown link, asserts a root cause or
  resolution while no record in the bundle attests one (hedged or "unknown" statements
  are allowed), or exceeds 8000 characters in total.
* **Rendering:** React escapes all text; there is no raw HTML injection anywhere. Links
  built from GitHub data are rendered only if they are `https://github.com/...`.
* **Headers:** pages get a per-request nonce CSP (`proxy.ts`): `script-src 'self'
  'nonce-…' 'strict-dynamic'` (plus `'unsafe-eval'` in development only), `object-src
  'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`,
  `upgrade-insecure-requests` in production. Inline *styles* are allowed (a few style
  attributes exist; styles cannot run code). API routes get `default-src 'none'`. All
  responses: `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, `Permissions-Policy`,
  `Cross-Origin-Opener-Policy`, and HSTS in production.

## 4. Sessions, CSRF, rate limits, errors

* **OAuth state:** 24 random bytes, in an HttpOnly SameSite=Lax cookie scoped to
  `/auth/github`, cleared on every callback outcome (single use), compared in constant time.
* **Session cookie:** random 32-byte token, only its SHA-256 hash stored; HttpOnly,
  SameSite=Lax, `Secure` when `NODE_ENV=production`, 30-day expiry checked server-side.
  **Rotation:** signing in revokes any session the browser already had. **Logout**
  deletes the session row (server-side revocation).
* **CSRF** (`lib/auth/csrf.ts`): SameSite=Lax stops browsers attaching the cookie to
  cross-site POSTs; in addition every cookie-authenticated state change must pass an
  origin check: `Sec-Fetch-Site` must be same-origin/none, and `Origin` (else `Referer`)
  must equal the request's own origin, the Host header's origin, or
  `DEPLOYGUARD_BASE_URL`; a request with neither is refused. Bearer-token requests are
  exempt (a token is not an ambient credential). Applied to: Re-analyze
  (`POST /api/deployments/risk`) and logout; Stage 2 purge; Stage 4 incident confirmation
  (`POST /api/incidents/confirmation`, session only -- a Bearer token is refused there,
  because a confirmation must be attributable to a person). Every future state-changing
  route (disconnect, settings) must call `checkSameOrigin()`.
* **Rate limits** (PostgreSQL, fails open): sign-in start/callback/install, logout,
  risk analysis per user, forced refresh per user, memory recall per user, webhook intake
  and CI status per source address; Stage 4: incident confirmations and ask-history
  questions per user. Client address = the entry appended by the trusted
  proxy (`DEPLOYGUARD_TRUSTED_PROXY_HOPS`, default 1), not the client-controlled leftmost
  `X-Forwarded-For` entry (that was a bypass, fixed in Stage 1).
* **Errors:** clients receive a generic message plus a short `errorRef`; the detail is
  logged server-side (redacted) under that reference. No stack traces or database
  messages are returned, including to CI (whose logs may be public).

## 5. GitHub App least privilege

Derived from every GitHub API call in the code (`lib/github/app.ts`,
`lib/github/app-events.ts`, `lib/github/installations.ts`):

| Permission | Level | Why |
| --- | --- | --- |
| Metadata | Read | mandatory; repository list of an installation (`/installation/repositories`) |
| Contents | Read | commit details for missed-push recovery (`/repos/{r}/commits/{sha}`) |
| Actions | Read | workflow runs, jobs and job logs (`/actions/runs`, `/actions/runs/{id}/jobs`, `/actions/jobs/{id}/logs`) |
| Contents | Read (Stage 5, same permission) | `.deployguard.yml` and `CODEOWNERS` on the default branch (`/repos/{r}/contents/{path}`) |
| Pull requests | Read (Stage 5.1) | the files of a pull request (`/repos/{r}/pulls/{n}/files`) |
| Checks | **Write** (Stage 5.1) | create/update ONE advisory check run per PR head commit (`/check-runs`); conclusion always `neutral` |
| Deployments | Read (Stage 5.5) | environments of a commit (`/repos/{r}/deployments?sha=`, `/deployments/{id}/statuses`) |

Subscribed events: `push`, `workflow_run`, and for Stage 5 `pull_request` and
`deployment_status` (plus `installation` / `installation_repositories`, which every App
receives). User authorization: identity (`/user`) and the user's installations
(`/user/installations`), used once at sign-in / connect and discarded.

**Checks: write is the only write permission.** It is used solely to post advisory check
runs whose conclusion is always `neutral` (GitHub treats neutral as passing, so it can
never block a merge, even if someone marks the check as required). DeployGuard never
writes code, comments, statuses, labels or reviews. Without the Stage 5 permissions
DeployGuard keeps working: PR checks are recorded as "permission missing" and
environments stay "environment unknown". Not requested: Issues, Statuses,
Administration, Secrets, any write to Contents.

**MANUAL:** compare the App's actual settings on GitHub with this table and remove
anything extra. A second person should review the App listing.

## 6. Hindsight isolation

* **Decision:** one shared bank (`HINDSIGHT_BANK_ID`), every memory tagged with exactly
  one immutable tenant tag `ghrepo:<GitHub repository id>`. Enforced in one place,
  `lib/hindsight/scope.ts`, called by the only client (`lib/hindsight/client.ts`):
  * retain is refused without exactly one well-formed `ghrepo:` tag, a stable
    `document_id` and `update_mode: "replace"`;
  * recall cannot be issued without a scope: the scope is a list of authorised
    repository ids, turned into `ghrepo:` tags with `tags_match: "any_strict"`
    (untagged memories are never returned); user filters are applied afterwards and can
    only narrow; every returned memory is re-checked client-side and dropped unless it
    carries exactly one tenant tag from the scope.
  * Repository names (`repo:owner/name`) are no longer used as a scope: names can be
    renamed or re-created by someone else, ids cannot.
* **Trade-offs:** one bank is simple and lets one process serve all tenants, but
  isolation depends on tags being correct on every write and enforced by the service on
  every read; a Hindsight bug in tag filtering would cross tenants (the client-side
  re-check limits what DeployGuard would show). Bank-per-tenant gives hard separation
  but needs per-tenant bank lifecycle, makes cross-repository recall for a multi-repo
  user several calls, and bank creation/deletion becomes part of connect/purge.
* **Known limitation:** bank-per-tenant selection is not implemented (it would change how
  document ids are tracked and purged, which belongs to Stage 2.6). Documented, not hidden.
* **Secrets:** memories are redacted and pass the secret tripwire before retain.
* **Tests:** `tests/hindsight-scope.test.mjs` (automated, real tag logic);
  `npm run verify:hindsight-canary` (live: two fake tenants, distinctive canaries, each
  recalls only its own, documents deleted afterwards).

## 7. Supply chain

* `npm run audit` (`npm audit --audit-level=high`) is part of verification.
* Dependencies are pinned to exact versions in `package.json`; `package-lock.json` is
  committed.
* `.env`, `.env.local`, `.env.*` (except `.env.example`), `*.pem`, `*.key`, `*.p12`,
  `*.pfx` are git-ignored. `.env.example` holds placeholders only.
