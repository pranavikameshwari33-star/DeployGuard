
# DeployGuard — AI DevOps Pipeline Agent

An AI-powered DevOps pipeline agent that connects to authorized GitHub repositories, monitors
deployments and GitHub Actions, remembers historical failures, analyzes changes, identifies
similar past deployments, and predicts deployment risk with explainable evidence.

**WATCH → REMEMBER → COMPARE → PREDICT → EXPLAIN → RECOVER**

DeployGuard observes and explains. It does not block, approve, roll back or change
deployments on its own.

---

## How DeployGuard works

```
GitHub account
  → authorized repository
  → GitHub push
  → deployment ingestion
  → change analysis
  → historical similarity
  → Gemini risk analysis
  → GitHub Actions monitoring
  → incident memory
  → risk refresh
  → dashboard
```

1. **GitHub account.** You sign in with GitHub. DeployGuard keys your account on your
   immutable GitHub user id and keeps its own session; GitHub tokens are not stored.
2. **Authorized repository.** You install the DeployGuard GitHub App and choose which
   repositories it may see (read-only: Metadata, Contents, Actions). Only those
   repositories are monitored, and each user sees only their own.
3. **GitHub push.** GitHub sends the push to `POST /api/webhook/github`. The HMAC signature
   is verified before anything else happens; duplicate deliveries are recognised and skipped.
4. **Deployment ingestion.** The push becomes one row in PostgreSQL (the source of truth),
   owned by its connected repository, plus a memory in Hindsight.
5. **Change analysis.** Changed file paths are classified with fixed, deterministic rules
   (database, configuration, authentication, payments, API, infrastructure, CI/CD, tests,
   documentation, dependencies, application code, unknown) and mapped to the
   services/components the folder structure names. No AI is used for this step.
6. **Historical similarity.** Earlier deployments of the same repository are ranked by
   explicit signals — shared files, components and categories, similar commit messages,
   failure type — with Hindsight recall as a supporting signal. Every match says why it
   matched and what happened to it.
7. **Gemini risk analysis.** Gemini receives only this evidence bundle and returns a
   structured LOW / MEDIUM / HIGH assessment with reasons, cited deployments, recommended
   checks and missing information. The answer is validated (for example, it may only cite
   deployments it was given, with their recorded outcome) before it is stored; an invalid or
   failed answer is reported as "unavailable" instead of inventing a risk level. It runs
   automatically after the push, without delaying the webhook.
8. **GitHub Actions monitoring.** `workflow_run` events for push-triggered workflows move
   the deployment through `RECEIVED → BUILDING → SUCCESS | FAILED`. A failure records the
   failed job, step and the end of its log, as GitHub reported them.
9. **Incident memory.** A failed deployment creates one incident with the observed failure.
   Root cause, resolution and downstream effect stay empty until they are actually known.
10. **Risk refresh.** Once the pipeline result arrives, the risk analysis is refreshed with
    that new evidence. Unchanged evidence reuses the stored assessment instead of calling
    Gemini again.
11. **Dashboard.** `/` shows your current deployment, its risk and reasons, the change
    analysis, pipeline state, historical evidence, deployment and incident history, and
    your connected repositories. Loading it never calls Gemini.

A maintenance run (`/api/maintenance/run`, internal-only) repairs what missed events leave
behind: it re-syncs installations and repositories, recovers pushes and pipeline results
that never arrived, retries unfinished work and resumes interrupted risk analyses.

---

## Roadmap / status

Built incrementally; each phase extended the previous ones rather than replacing them.

- [x] Phase 1 — GitHub push detection
- [x] Phase 2 — Store deployment events + Hindsight memory
- [x] Phase 3 — GitHub Actions pipeline monitoring
- [x] Phase 4 — Incident memory
- [x] Phase 5 — Detect affected components
- [x] Phase 6 — Historical similarity
- [x] Phase 7 — Gemini risk analysis
- [x] Phase 8 — Automatic risk analysis + Dashboard
- [x] Phase 9 — GitHub authentication + repository connection + multi-user isolation
- [x] Phase 10 — Reliability + security hardening

**Still open:**

- The real browser round-trip (GitHub sign-in → App installation → real push → real
  GitHub Actions run) has not yet been tested end to end; it is covered only by local
  verification scripts that simulate GitHub.
- `DEPLOYGUARD_STATUS_TOKEN` currently serves both CI status reporting and internal
  maintenance/admin access. Splitting it into a separate internal token is pending.

The sections below document the pipeline from the ground up, in the order it was built.
Since Phase 9, browser-facing endpoints require a signed-in session (or internal tooling),
and each user only sees data for their own connected repositories.

---

## Phase 1 — what exists

| Route | Purpose |
| --- | --- |
| `POST /api/webhook/github` | Receives GitHub push events. Verifies the signature, normalizes the payload, records it. |
| `GET /api/events` | Shows the push events received since the server started. Internal tooling only since Phase 9. |
| `GET /` | The dashboard (Phase 8); redirects to `/login` when you are not signed in. |

Push events are also printed as a readable block in the terminal running `npm run dev`.

> Phase 1 stored events in memory only. Phase 2 replaced that with the `deployments`
> table; `/api/events` remains as a raw receipt log.

---

## Phase 2 — what exists

```
GitHub push
    |
    v
POST /api/webhook/github   (verify signature)
    |
    +---> PostgreSQL   deployments table   <- structured source of truth
    |
    +---> Hindsight    memory bank         <- agent long-term memory
```

The database and Hindsight do different jobs and are not interchangeable. The table answers
"what exactly happened", with exact columns you can filter and join. Hindsight answers
"have we seen anything like this before", with semantic search. Later phases need both:
Phase 6 finds candidate history, Phase 7 makes Gemini justify its risk score against it.

| Route | Purpose |
| --- | --- |
| `POST /api/webhook/github` | Verify, store in Postgres, then store in Hindsight. |
| `GET /api/deployments` | The `deployments` table, newest first — only your own repositories' deployments. |
| `GET /api/memory/recall?q=...` | Ask Hindsight what it remembers, in plain English — restricted to your own repositories' memories. |
| `POST /api/memory/backfill` | Re-store memories for recent deployments after a Hindsight outage. Internal tooling only. |
| `GET /api/events` | Raw in-memory receipt log. Still works when the database is down, which is what makes it useful for diagnosis. Internal tooling only. |

### Database setup

Add a PostgreSQL connection string to `.env.local`:

```
DATABASE_URL=postgresql://user:password@host:6543/postgres
```

**Supabase:** create a project, then **Project Settings → Database → Connection string →
Transaction pooler**. Use the *pooler* string (port 6543), not the direct connection — the
direct one is IPv6-only on the free tier and fails to connect from most home networks.
Replace `[YOUR-PASSWORD]` with your database password.

**Local PostgreSQL:** `postgresql://postgres:postgres@localhost:5432/deployguard`

Then create the table:

```bash
npm run db:migrate
```

It prints the resulting columns. Re-running it is safe.

> After editing `.env.local` you must restart `npm run dev`. Next.js reads environment
> variables once, at startup.

### Hindsight setup

Already configured from your existing environment. `.env` supplies `HINDSIGHT_API_KEY` and
`HINDSIGHT_BASE_URL`; `HINDSIGHT_BANK_ID` defaults to `DeployGuard`. The key is read only in
`lib/env.ts`, sent only as an `Authorization` header, and never logged, returned, or shipped
to the browser.

### Verify Phase 2

```bash
npm run dev             # terminal 1
npm run verify:phase2   # terminal 2
```

It prints PASS/FAIL for each link in the chain: the table exists, a signed push is accepted,
the row is really in Postgres, a redelivery creates no second row, and the deployment can be
recalled from Hindsight.

### Idempotency

GitHub retries a delivery when your server is slow or returns an error. A unique index on
`(owner, repository, branch, commit_sha)` plus `INSERT ... ON CONFLICT DO NOTHING` means a
retry is recorded once. The response says `"duplicate": true` instead of silently writing a
second row. Hindsight memories use a stable `document_id` with `update_mode: "replace"` for
the same reason.

### How the three failures are kept separate

| Failure | Response | What happens |
| --- | --- | --- |
| Bad signature | `401` `stage: signature` | Nothing is stored anywhere. |
| Database write fails | `500` `stage: database` | Nothing stored. GitHub retries, and the retry is safe. |
| Hindsight write fails | `200` `memory.stored: false` | **The deployment row is kept.** The error appears in the response and the log; recover with `POST /api/memory/backfill`. |

---

## Phase 3 — what exists

```
git push ──► GitHub ──┬──► push webhook ──► POST /api/webhook/github ──► row: RECEIVED
                      │
                      └──► GitHub Actions (.github/workflows/deployguard-ci.yml)
                              report BUILDING ───────────► POST /api/deployments/status
                              install → test → build → simulated deploy
                              report SUCCESS or FAILED ──► POST /api/deployments/status
                                                               │
                                          same row updated ◄───┤
                                          Hindsight memory replaced (final result only)
```

| Route | Purpose |
| --- | --- |
| `POST /api/deployments/status` | Called by GitHub Actions. Bearer-token protected. Moves an **existing** deployment to `BUILDING`, `SUCCESS` or `FAILED`. Never creates a row. |

The row is found by the same `(owner, repository, branch, commit_sha)` key that stops
duplicate webhook deliveries, so one push is always one row.

**Allowed moves:** `RECEIVED → BUILDING → SUCCESS | FAILED`. A GitHub "Re-run jobs" may go
back to `BUILDING`. `SUCCESS → FAILED` and the reverse are refused with `409`.

**On failure** the row stores `failure_stage` (`install`, `test`, `build`, `deploy`),
`failure_job`, `failure_message` (the last 40 lines that stage printed), the run link and
the time. These are observations, not a diagnosis — root cause belongs to a later phase.

| Response | Meaning |
| --- | --- |
| `200` | Status updated. `memory` says whether Hindsight was updated too. |
| `400 stage: validation` | Bad body, e.g. not a 40-character SHA. |
| `401 stage: auth` | Missing or wrong `DEPLOYGUARD_STATUS_TOKEN`. |
| `404` | No deployment for that commit — the push webhook never stored it. |
| `409` | Status move not allowed (e.g. `SUCCESS → FAILED`). |
| `500 stage: database` | Database error. Nothing changed. |

A Hindsight outage never undoes a status update: the database write is kept and the error is
reported in the response. Recover with `POST /api/memory/backfill`.

### Setup for Phase 3

1. `.env.local`: add `DEPLOYGUARD_STATUS_TOKEN=<a random value>` (generate one with the same
   `node -e ...randomBytes...` command as the webhook secret). Restart `npm run dev`.
2. `npm run db:migrate` — adds the pipeline columns. Safe to re-run.
3. GitHub → repo **Settings → Secrets and variables → Actions**:
   - **Secrets** tab → `DEPLOYGUARD_STATUS_TOKEN` = the same value as in `.env.local`.
   - **Variables** tab → `DEPLOYGUARD_URL` = your ngrok URL, e.g. `https://xxxx.ngrok-free.app`.
     Update it whenever ngrok gives you a new URL.

Without those two settings the pipeline still runs; it only prints a warning that it could
not report to DeployGuard. Reporting never fails a build.

### Verify Phase 3 locally (no GitHub needed)

```bash
npm run dev             # terminal 1
npm run verify:phase3   # terminal 2
```

### Tests

`npm test` runs the unit tests in `tests/` with Node's built-in test runner. CI runs the
same command.

### Demonstrating a failed deployment

Put `[demo-fail]` in a commit message:

```bash
git commit --allow-empty -m "Demo a failed deployment [demo-fail]"
git push
```

The workflow turns on `tests/demo-failure.test.mjs` for that commit only, so the **test**
stage genuinely fails and DeployGuard records `FAILED`. Nothing in the code changes, so
there is nothing to undo: the next normal push passes again.

---

## Setup

```bash
npm install
cp .env.example .env.local
```

Generate a webhook secret and put it in `.env.local`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

```
GITHUB_WEBHOOK_SECRET=<the value you just generated>
```

Then:

```bash
npm run dev
```

Open http://localhost:3000

---

## Test locally, without GitHub

In a second terminal:

```bash
npm run test:webhook
```

This sends a fake-but-correctly-signed push event to your local server. You should see
`Status: 200` in that terminal and a `PUSH RECEIVED` block in the dev-server terminal.
The push is recorded without an owner (it did not come through the GitHub App), so it is
not shown on a signed-in user's dashboard.

---

## Test with real GitHub pushes (ngrok)

GitHub cannot reach `localhost`, so you need a public URL that tunnels to your machine.

**1. Install ngrok**

Download from https://ngrok.com/download (or `winget install ngrok`), sign up for the free
account, and authenticate once:

```bash
ngrok config add-authtoken <your-token-from-the-ngrok-dashboard>
```

**2. Start the tunnel** (leave `npm run dev` running in another terminal):

```bash
ngrok http 3000
```

ngrok prints a line like:

```
Forwarding   https://a1b2-49-37-xxx-xx.ngrok-free.app -> http://localhost:3000
```

Copy that `https://...ngrok-free.app` URL. It changes every time you restart ngrok on the
free plan, so you will need to update the webhook URL in GitHub whenever you restart it.

**3. Add the webhook in GitHub**

In the repository you want to watch: **Settings → Webhooks → Add webhook**

| Field | Value |
| --- | --- |
| Payload URL | `https://<your-ngrok-url>/api/webhook/github` |
| Content type | `application/json` |
| Secret | the **exact same** value as `GITHUB_WEBHOOK_SECRET` in `.env.local` |
| SSL verification | Enable |
| Events | *Just the push event* |
| Active | checked |

Click **Add webhook**. GitHub immediately sends a `ping`; your terminal should log
`Ping received`.

**4. Push something**

```bash
git commit --allow-empty -m "test deployguard webhook"
git push
```

Watch the dev-server terminal for the `PUSH RECEIVED` block.

> This section describes a plain repository webhook, which records deployments without an
> owner. For signed-in, per-user monitoring, point the **GitHub App's** webhook URL at the
> same `https://<your-ngrok-url>/api/webhook/github` endpoint instead.

**If nothing arrives**, open **Settings → Webhooks → your webhook → Recent Deliveries** in
GitHub. Each delivery shows the request, the response code, and a **Redeliver** button so
you can retry without pushing again.

| Response | Meaning |
| --- | --- |
| `200` | Working. |
| `401 Invalid signature` | The secret in GitHub does not match `.env.local`. |
| `500 GITHUB_WEBHOOK_SECRET is missing` | You edited `.env.local` but did not restart `npm run dev`. |
| Timeout / no response | ngrok is not running, or the URL is stale. |

---

## Project layout

```
app/
  page.tsx, layout.tsx, _components/  the dashboard (Open Sans, server-rendered)
  login/page.tsx                sign-in page
  auth/github/...               GitHub sign-in, App installation callback, logout (auth/logout)
  api/webhook/github/route.ts   the single GitHub webhook endpoint (push, workflow_run, installation events)
  api/deployments/...           deployments, CI status updates, similar deployments, risk analysis
  api/dashboard/route.ts        dashboard data as JSON
  api/repositories/route.ts     your connected repositories
  api/memory/...                Hindsight recall and backfill
  api/maintenance/run/route.ts  reconciliation / recovery run (internal only)
  api/health/route.ts           health check
  api/events/route.ts           raw push receipt log (internal only)
proxy.ts                        sends signed-out visitors of / to /login
lib/
  env.ts                        the only place secrets are read
  auth/                         sessions, bearer-token check, rate limiting
  github/                       signature check, push parsing, GitHub App client, App events, installations
  db/                           PostgreSQL pool and table reads/writes
  analysis/change-analysis.ts   deterministic change classification
  similarity/                   historical similarity scoring and search
  ai/gemini.ts                  Gemini client (server-side only)
  risk/                         evidence bundle, validation, risk analysis, automatic scheduling
  pipeline/                     shared push ingestion and deployment lifecycle
  hindsight/                    Hindsight client and memory builders (deployment, incident, risk)
  dashboard/dashboard-data.ts   read-only data for the dashboard
  maintenance/run.ts            the maintenance / recovery run
db/migrations/                  001 … 008, additive and re-runnable (`npm run db:migrate`)
scripts/
  send-test-webhook.mjs         signed fake push, for local testing
  report-status.mjs             run by GitHub Actions to report BUILDING/SUCCESS/FAILED
  verify-phase*.mjs             local end-to-end checks, one per phase (`npm run verify:phaseN`)
tests/                          unit tests, run by `npm test` locally and in CI
.github/workflows/
  deployguard-ci.yml            install -> test -> build -> simulated deploy
  deployguard-maintenance.yml   hourly call to the maintenance run
```

---

## Security notes

- Secrets live only in `.env.local`, which is gitignored. Nothing is hardcoded.
- Every delivery is verified with HMAC-SHA256 over the **raw** request body, compared using
  a timing-safe comparison. Unsigned or wrongly-signed requests get `401` and are never parsed.
t e s t 
 
 
=======
# DeployGuard — AI DevOps Pipeline Agent

An AI-powered DevOps pipeline agent that connects to authorized GitHub repositories, monitors
deployments and GitHub Actions, remembers historical failures, analyzes changes, identifies
similar past deployments, and predicts deployment risk with explainable evidence.

**WATCH → REMEMBER → COMPARE → PREDICT → EXPLAIN → RECOVER**

DeployGuard observes and explains. It does not block, approve, roll back or change
deployments on its own.

---

## How DeployGuard works

```
GitHub account
  → authorized repository
  → GitHub push
  → deployment ingestion
  → change analysis
  → historical similarity
  → Gemini risk analysis
  → GitHub Actions monitoring
  → incident memory
  → risk refresh
  → dashboard
```

1. **GitHub account.** You sign in with GitHub. DeployGuard keys your account on your
   immutable GitHub user id and keeps its own session; GitHub tokens are not stored.
2. **Authorized repository.** You install the DeployGuard GitHub App and choose which
   repositories it may see (read-only: Metadata, Contents, Actions). Only those
   repositories are monitored, and each user sees only their own.
3. **GitHub push.** GitHub sends the push to `POST /api/webhook/github`. The HMAC signature
   is verified before anything else happens; duplicate deliveries are recognised and skipped.
4. **Deployment ingestion.** The push becomes one row in PostgreSQL (the source of truth),
   owned by its connected repository, plus a memory in Hindsight.
5. **Change analysis.** Changed file paths are classified with fixed, deterministic rules
   (database, configuration, authentication, payments, API, infrastructure, CI/CD, tests,
   documentation, dependencies, application code, unknown) and mapped to the
   services/components the folder structure names. No AI is used for this step.
6. **Historical similarity.** Earlier deployments of the same repository are ranked by
   explicit signals — shared files, components and categories, similar commit messages,
   failure type — with Hindsight recall as a supporting signal. Every match says why it
   matched and what happened to it.
7. **Gemini risk analysis.** Gemini receives only this evidence bundle and returns a
   structured LOW / MEDIUM / HIGH assessment with reasons, cited deployments, recommended
   checks and missing information. The answer is validated (for example, it may only cite
   deployments it was given, with their recorded outcome) before it is stored; an invalid or
   failed answer is reported as "unavailable" instead of inventing a risk level. It runs
   automatically after the push, without delaying the webhook.
8. **GitHub Actions monitoring.** `workflow_run` events for push-triggered workflows move
   the deployment through `RECEIVED → BUILDING → SUCCESS | FAILED`. A failure records the
   failed job, step and the end of its log, as GitHub reported them.
9. **Incident memory.** A failed deployment creates one incident with the observed failure.
   Root cause, resolution and downstream effect stay empty until they are actually known.
10. **Risk refresh.** Once the pipeline result arrives, the risk analysis is refreshed with
    that new evidence. Unchanged evidence reuses the stored assessment instead of calling
    Gemini again.
11. **Dashboard.** `/` shows your current deployment, its risk and reasons, the change
    analysis, pipeline state, historical evidence, deployment and incident history, and
    your connected repositories. Loading it never calls Gemini.

A maintenance run (`/api/maintenance/run`, internal-only) repairs what missed events leave
behind: it re-syncs installations and repositories, recovers pushes and pipeline results
that never arrived, retries unfinished work and resumes interrupted risk analyses.

---

## Roadmap / status

Built incrementally; each phase extended the previous ones rather than replacing them.

- [x] Phase 1 — GitHub push detection
- [x] Phase 2 — Store deployment events + Hindsight memory
- [x] Phase 3 — GitHub Actions pipeline monitoring
- [x] Phase 4 — Incident memory
- [x] Phase 5 — Detect affected components
- [x] Phase 6 — Historical similarity
- [x] Phase 7 — Gemini risk analysis
- [x] Phase 8 — Automatic risk analysis + Dashboard
- [x] Phase 9 — GitHub authentication + repository connection + multi-user isolation
- [x] Phase 10 — Reliability + security hardening

**Still open:**

- The real browser round-trip (GitHub sign-in → App installation → real push → real
  GitHub Actions run) has not yet been tested end to end; it is covered only by local
  verification scripts that simulate GitHub.
- `DEPLOYGUARD_STATUS_TOKEN` currently serves both CI status reporting and internal
  maintenance/admin access. Splitting it into a separate internal token is pending.

The sections below document the pipeline from the ground up, in the order it was built.
Since Phase 9, browser-facing endpoints require a signed-in session (or internal tooling),
and each user only sees data for their own connected repositories.

---

## Phase 1 — what exists

| Route | Purpose |
| --- | --- |
| `POST /api/webhook/github` | Receives GitHub push events. Verifies the signature, normalizes the payload, records it. |
| `GET /api/events` | Shows the push events received since the server started. Internal tooling only since Phase 9. |
| `GET /` | The dashboard (Phase 8); redirects to `/login` when you are not signed in. |

Push events are also printed as a readable block in the terminal running `npm run dev`.

> Phase 1 stored events in memory only. Phase 2 replaced that with the `deployments`
> table; `/api/events` remains as a raw receipt log.

---

## Phase 2 — what exists

```
GitHub push
    |
    v
POST /api/webhook/github   (verify signature)
    |
    +---> PostgreSQL   deployments table   <- structured source of truth
    |
    +---> Hindsight    memory bank         <- agent long-term memory
```

The database and Hindsight do different jobs and are not interchangeable. The table answers
"what exactly happened", with exact columns you can filter and join. Hindsight answers
"have we seen anything like this before", with semantic search. Later phases need both:
Phase 6 finds candidate history, Phase 7 makes Gemini justify its risk score against it.

| Route | Purpose |
| --- | --- |
| `POST /api/webhook/github` | Verify, store in Postgres, then store in Hindsight. |
| `GET /api/deployments` | The `deployments` table, newest first — only your own repositories' deployments. |
| `GET /api/memory/recall?q=...` | Ask Hindsight what it remembers, in plain English — restricted to your own repositories' memories. |
| `POST /api/memory/backfill` | Re-store memories for recent deployments after a Hindsight outage. Internal tooling only. |
| `GET /api/events` | Raw in-memory receipt log. Still works when the database is down, which is what makes it useful for diagnosis. Internal tooling only. |

### Database setup

Add a PostgreSQL connection string to `.env.local`:

```
DATABASE_URL=postgresql://user:password@host:6543/postgres
```

**Supabase:** create a project, then **Project Settings → Database → Connection string →
Transaction pooler**. Use the *pooler* string (port 6543), not the direct connection — the
direct one is IPv6-only on the free tier and fails to connect from most home networks.
Replace `[YOUR-PASSWORD]` with your database password.

**Local PostgreSQL:** `postgresql://postgres:postgres@localhost:5432/deployguard`

Then create the table:

```bash
npm run db:migrate
```

It prints the resulting columns. Re-running it is safe.

> After editing `.env.local` you must restart `npm run dev`. Next.js reads environment
> variables once, at startup.

### Hindsight setup

Already configured from your existing environment. `.env` supplies `HINDSIGHT_API_KEY` and
`HINDSIGHT_BASE_URL`; `HINDSIGHT_BANK_ID` defaults to `DeployGuard`. The key is read only in
`lib/env.ts`, sent only as an `Authorization` header, and never logged, returned, or shipped
to the browser.

### Verify Phase 2

```bash
npm run dev             # terminal 1
npm run verify:phase2   # terminal 2
```

It prints PASS/FAIL for each link in the chain: the table exists, a signed push is accepted,
the row is really in Postgres, a redelivery creates no second row, and the deployment can be
recalled from Hindsight.

### Idempotency

GitHub retries a delivery when your server is slow or returns an error. A unique index on
`(owner, repository, branch, commit_sha)` plus `INSERT ... ON CONFLICT DO NOTHING` means a
retry is recorded once. The response says `"duplicate": true` instead of silently writing a
second row. Hindsight memories use a stable `document_id` with `update_mode: "replace"` for
the same reason.

### How the three failures are kept separate

| Failure | Response | What happens |
| --- | --- | --- |
| Bad signature | `401` `stage: signature` | Nothing is stored anywhere. |
| Database write fails | `500` `stage: database` | Nothing stored. GitHub retries, and the retry is safe. |
| Hindsight write fails | `200` `memory.stored: false` | **The deployment row is kept.** The error appears in the response and the log; recover with `POST /api/memory/backfill`. |

---

## Phase 3 — what exists

```
git push ──► GitHub ──┬──► push webhook ──► POST /api/webhook/github ──► row: RECEIVED
                      │
                      └──► GitHub Actions (.github/workflows/deployguard-ci.yml)
                              report BUILDING ───────────► POST /api/deployments/status
                              install → test → build → simulated deploy
                              report SUCCESS or FAILED ──► POST /api/deployments/status
                                                               │
                                          same row updated ◄───┤
                                          Hindsight memory replaced (final result only)
```

| Route | Purpose |
| --- | --- |
| `POST /api/deployments/status` | Called by GitHub Actions. Bearer-token protected. Moves an **existing** deployment to `BUILDING`, `SUCCESS` or `FAILED`. Never creates a row. |

The row is found by the same `(owner, repository, branch, commit_sha)` key that stops
duplicate webhook deliveries, so one push is always one row.

**Allowed moves:** `RECEIVED → BUILDING → SUCCESS | FAILED`. A GitHub "Re-run jobs" may go
back to `BUILDING`. `SUCCESS → FAILED` and the reverse are refused with `409`.

**On failure** the row stores `failure_stage` (`install`, `test`, `build`, `deploy`),
`failure_job`, `failure_message` (the last 40 lines that stage printed), the run link and
the time. These are observations, not a diagnosis — root cause belongs to a later phase.

| Response | Meaning |
| --- | --- |
| `200` | Status updated. `memory` says whether Hindsight was updated too. |
| `400 stage: validation` | Bad body, e.g. not a 40-character SHA. |
| `401 stage: auth` | Missing or wrong `DEPLOYGUARD_STATUS_TOKEN`. |
| `404` | No deployment for that commit — the push webhook never stored it. |
| `409` | Status move not allowed (e.g. `SUCCESS → FAILED`). |
| `500 stage: database` | Database error. Nothing changed. |

A Hindsight outage never undoes a status update: the database write is kept and the error is
reported in the response. Recover with `POST /api/memory/backfill`.

### Setup for Phase 3

1. `.env.local`: add `DEPLOYGUARD_STATUS_TOKEN=<a random value>` (generate one with the same
   `node -e ...randomBytes...` command as the webhook secret). Restart `npm run dev`.
2. `npm run db:migrate` — adds the pipeline columns. Safe to re-run.
3. GitHub → repo **Settings → Secrets and variables → Actions**:
   - **Secrets** tab → `DEPLOYGUARD_STATUS_TOKEN` = the same value as in `.env.local`.
   - **Variables** tab → `DEPLOYGUARD_URL` = your ngrok URL, e.g. `https://xxxx.ngrok-free.app`.
     Update it whenever ngrok gives you a new URL.

Without those two settings the pipeline still runs; it only prints a warning that it could
not report to DeployGuard. Reporting never fails a build.

### Verify Phase 3 locally (no GitHub needed)

```bash
npm run dev             # terminal 1
npm run verify:phase3   # terminal 2
```

### Tests

`npm test` runs the unit tests in `tests/` with Node's built-in test runner. CI runs the
same command.

### Demonstrating a failed deployment

Put `[demo-fail]` in a commit message:

```bash
git commit --allow-empty -m "Demo a failed deployment [demo-fail]"
git push
```

The workflow turns on `tests/demo-failure.test.mjs` for that commit only, so the **test**
stage genuinely fails and DeployGuard records `FAILED`. Nothing in the code changes, so
there is nothing to undo: the next normal push passes again.

---

## Setup

```bash
npm install
cp .env.example .env.local
```

Generate a webhook secret and put it in `.env.local`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

```
GITHUB_WEBHOOK_SECRET=<the value you just generated>
```

Then:

```bash
npm run dev
```

Open http://localhost:3000

---

## Test locally, without GitHub

In a second terminal:

```bash
npm run test:webhook
```

This sends a fake-but-correctly-signed push event to your local server. You should see
`Status: 200` in that terminal and a `PUSH RECEIVED` block in the dev-server terminal.
The push is recorded without an owner (it did not come through the GitHub App), so it is
not shown on a signed-in user's dashboard.

---

## Test with real GitHub pushes (ngrok)

GitHub cannot reach `localhost`, so you need a public URL that tunnels to your machine.

**1. Install ngrok**

Download from https://ngrok.com/download (or `winget install ngrok`), sign up for the free
account, and authenticate once:

```bash
ngrok config add-authtoken <your-token-from-the-ngrok-dashboard>
```

**2. Start the tunnel** (leave `npm run dev` running in another terminal):

```bash
ngrok http 3000
```

ngrok prints a line like:

```
Forwarding   https://a1b2-49-37-xxx-xx.ngrok-free.app -> http://localhost:3000
```

Copy that `https://...ngrok-free.app` URL. It changes every time you restart ngrok on the
free plan, so you will need to update the webhook URL in GitHub whenever you restart it.

**3. Add the webhook in GitHub**

In the repository you want to watch: **Settings → Webhooks → Add webhook**

| Field | Value |
| --- | --- |
| Payload URL | `https://<your-ngrok-url>/api/webhook/github` |
| Content type | `application/json` |
| Secret | the **exact same** value as `GITHUB_WEBHOOK_SECRET` in `.env.local` |
| SSL verification | Enable |
| Events | *Just the push event* |
| Active | checked |

Click **Add webhook**. GitHub immediately sends a `ping`; your terminal should log
`Ping received`.

**4. Push something**

```bash
git commit --allow-empty -m "test deployguard webhook"
git push
```

Watch the dev-server terminal for the `PUSH RECEIVED` block.

> This section describes a plain repository webhook, which records deployments without an
> owner. For signed-in, per-user monitoring, point the **GitHub App's** webhook URL at the
> same `https://<your-ngrok-url>/api/webhook/github` endpoint instead.

**If nothing arrives**, open **Settings → Webhooks → your webhook → Recent Deliveries** in
GitHub. Each delivery shows the request, the response code, and a **Redeliver** button so
you can retry without pushing again.

| Response | Meaning |
| --- | --- |
| `200` | Working. |
| `401 Invalid signature` | The secret in GitHub does not match `.env.local`. |
| `500 GITHUB_WEBHOOK_SECRET is missing` | You edited `.env.local` but did not restart `npm run dev`. |
| Timeout / no response | ngrok is not running, or the URL is stale. |

---

## Project layout

```
app/
  page.tsx, layout.tsx, _components/  the dashboard (Open Sans, server-rendered)
  login/page.tsx                sign-in page
  auth/github/...               GitHub sign-in, App installation callback, logout (auth/logout)
  api/webhook/github/route.ts   the single GitHub webhook endpoint (push, workflow_run, installation events)
  api/deployments/...           deployments, CI status updates, similar deployments, risk analysis
  api/dashboard/route.ts        dashboard data as JSON
  api/repositories/route.ts     your connected repositories
  api/memory/...                Hindsight recall and backfill
  api/maintenance/run/route.ts  reconciliation / recovery run (internal only)
  api/health/route.ts           health check
  api/events/route.ts           raw push receipt log (internal only)
proxy.ts                        sends signed-out visitors of / to /login
lib/
  env.ts                        the only place secrets are read
  auth/                         sessions, bearer-token check, rate limiting
  github/                       signature check, push parsing, GitHub App client, App events, installations
  db/                           PostgreSQL pool and table reads/writes
  analysis/change-analysis.ts   deterministic change classification
  similarity/                   historical similarity scoring and search
  ai/gemini.ts                  Gemini client (server-side only)
  risk/                         evidence bundle, validation, risk analysis, automatic scheduling
  pipeline/                     shared push ingestion and deployment lifecycle
  hindsight/                    Hindsight client and memory builders (deployment, incident, risk)
  dashboard/dashboard-data.ts   read-only data for the dashboard
  maintenance/run.ts            the maintenance / recovery run
db/migrations/                  001 … 008, additive and re-runnable (`npm run db:migrate`)
scripts/
  send-test-webhook.mjs         signed fake push, for local testing
  report-status.mjs             run by GitHub Actions to report BUILDING/SUCCESS/FAILED
  verify-phase*.mjs             local end-to-end checks, one per phase (`npm run verify:phaseN`)
tests/                          unit tests, run by `npm test` locally and in CI
.github/workflows/
  deployguard-ci.yml            install -> test -> build -> simulated deploy
  deployguard-maintenance.yml   hourly call to the maintenance run
```

---

## Security notes

- Secrets live only in `.env.local`, which is gitignored. Nothing is hardcoded.
- Every delivery is verified with HMAC-SHA256 over the **raw** request body, compared using
  a timing-safe comparison. Unsigned or wrongly-signed requests get `401` and are never parsed.

