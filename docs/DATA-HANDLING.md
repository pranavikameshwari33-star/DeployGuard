# What DeployGuard stores, remembers and sends (Stage 2)

This describes what the code does today. It is the basis for a privacy disclosure, not a
substitute for a legal review (**MANUAL**: legal/privacy review not performed).

## Never collected

* **Source code contents.** DeployGuard never reads file contents. It sees file *paths*
  (from push events and the commit API) and metadata.
* GitHub user tokens (used once at sign-in to identify the user and their installations,
  then discarded), installation tokens (in memory only, short-lived), secrets of any kind.

## PostgreSQL (the source of truth)

| Table | Contents | Notes |
| --- | --- | --- |
| `deployments` | repository owner/name and immutable id, branch, commit SHA, **first commit message** (redacted), author login/name, changed file paths, change categories/services, pipeline status and timestamps, CI run id/URL, failed stage and job name, **failure output: the last 40 lines of the failing job log, redacted, ≤ 4000 chars** | failure output is cleared after `DEPLOYGUARD_RETENTION_FAILURE_OUTPUT_DAYS` (default 90) |
| `incidents` | observed failure type, job, the same redacted output tail; root cause / resolution only if a person records them | |
| `risk_assessments` | the validated assessment, and the exact evidence bundle that was sent to Gemini | |
| `users`, `sessions` | GitHub user id, login, display name, avatar URL; a SHA-256 hash of the session token | |
| `github_installations`, `repositories` | installation/account ids and logins, repository names, private flag, connection state | |
| `github_webhook_deliveries` | delivery GUID, event, action, ids, outcome, a redacted error; the (redacted) payload only until a queued `workflow_run` is processed | pruned after 14/30 days |
| `jobs` | job type, references (delivery id / deployment id), attempts, redacted error | succeeded jobs pruned after 7 days; dead jobs kept |
| `memory_documents` | ids of the Hindsight documents DeployGuard wrote, per repository | used to purge exactly what was written |
| `gemini_usage` | per repository and day: number of Gemini calls and refusals | counts only |
| `audit_log` | who, what, which repository, when, outcome, counts | append-only (database trigger) |
| `rate_limits` | hashed client key, counter | pruned after 1 day |

Deployments with all their data are deleted after `DEPLOYGUARD_RETENTION_DEPLOYMENT_DAYS`
(default 0 = keep).

## Hindsight (semantic recall only)

Three kinds of documents per repository, each with a stable `document_id`, `update_mode:
"replace"` and exactly one tenant tag `ghrepo:<repository id>`:
`deployment/<owner>/<repo>/<branch>/<sha>`, `incident/<id>`, `risk/<deployment id>`.
They contain the same (redacted) facts as the rows above, in sentence form. Every string is
redacted again and checked against server secret values before it is sent.

## Gemini

Only the JSON evidence bundle built from PostgreSQL rows: the current deployment (paths,
first line of the commit message, author, branch, change analysis, pipeline state, the
redacted failure tail ≤ 1000 chars) and the matching past deployments with their recorded
outcomes and incidents. Every string is redacted, cleaned and length-capped first.
Recalled memory text is never sent. Calls are capped per repository
(`DEPLOYGUARD_GEMINI_DAILY_CAP`, `DEPLOYGUARD_GEMINI_MONTHLY_CAP`).

## Disconnect, purge, export

* **Disconnect / uninstall / suspend** stops monitoring. **History is kept.** Nothing is purged.
* **Purge a repository** — `POST /api/repositories/purge` (owner, same-origin, confirmation
  = full repository name): deletes every Hindsight document of the repository and verifies
  each is gone, then deletes its deployments, incidents, assessments, queued jobs and
  delivery-log rows in one transaction, then verifies PostgreSQL and that a scoped recall
  returns nothing. If Hindsight deletion fails, PostgreSQL is left untouched so the purge
  can simply be repeated. Kept after a purge: the repository's connection row (so
  monitoring state is clear), its `gemini_usage` counts and its audit-log entries.
* **Purge the account** — `POST /api/account/purge` (confirmation = GitHub login): purges every
  repository as above, then deletes repository rows, installation links, sessions and the
  user row. The GitHub App stays installed on GitHub until the user uninstalls it there.
* **Export** — `GET /api/repositories/export?githubRepositoryId=…`: the owner's deployments,
  incidents and risk assessments for one repository as JSON.
All three are audit-logged.

## Known limitations

* Hindsight may derive consolidated "observation" memories. Purge verification therefore
  also runs a recall scoped to the repository and reports what remains; deleting
  observations that outlive their documents depends on Hindsight's own behaviour.
* Audit rows of a purged account are kept (append-only); they hold ids and counts only.
