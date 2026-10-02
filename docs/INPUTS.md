# Better inputs to the analysis (Stage 5)

Everything here is deterministic and stored in PostgreSQL before it is used, so it can
enter the evidence bundle as a recorded fact.

## 5.4 Richer change signals

`lib/analysis/change-analysis.ts` now adds explicit categories next to the broad ones
(the broad category is still set, so older history keeps matching):

| Category | Examples | Also sets |
| --- | --- | --- |
| `migration` | `db/migrations/…`, `prisma/migrations/…`, `alembic/…`, `db/0042_add.sql`, `*.migration.ts` | database |
| `lockfile` | `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `poetry.lock`, `go.sum`, `Cargo.lock` | dependencies |
| `dependency_manifest` | `package.json`, `requirements*.txt`, `pyproject.toml`, `go.mod`, `Gemfile` | dependencies |
| `iac` | `*.tf`, `*.tfvars`, `terraform/`, `k8s/`, `helm/`, `serverless.yml`, CloudFormation | infrastructure |
| `container` | `Dockerfile*`, `*.dockerfile`, `docker-compose.yml`, `compose.*.yaml` | infrastructure |
| `environment` | `.env*`, `*.env`, `config/production.yml`, `environments/…` | configuration |

CI config stays `ci_cd`. Paths only: no file is ever opened.

## 5.2 `.deployguard.yml`

Read from the repository's **default branch** through the GitHub API, validated, and
cached in `repository_inputs`. Only the validated result is stored, never the raw file.

```yaml
version: 1
pull_request_checks: true          # false = no PR check runs for this repository
ignore:                            # left out of the analysis (still listed, labelled)
  - "docs/**"
critical_paths:                    # flagged on the dashboard, in PR checks and in the bundle
  - "src/payments/**"
services:                          # path -> service/component name
  "services/legacy-billing/**": billing
categories:                        # path -> extra categories (from the list above)
  "db/schema/**": [database, migration]
```

* **Strict subset, nothing executable.** DeployGuard does not use a general YAML library.
  It accepts only the shapes above: top-level `key: value`, two-space lists and maps, and
  `[a, b]` lists. Anchors, aliases, tags, block scalars, flow maps, tabs, unknown keys,
  unknown categories, `..` in paths and files over 64 KB are rejected with line-numbered
  errors.
* **Invalid means unused.** The defaults apply until the file is fixed. The errors are
  shown on the dashboard ("Repository inputs"), and each deployment records which config
  status/version shaped its analysis (`deployments.analysis_config`).
* **No waiting on GitHub.** The push webhook uses the cached copy. When the cache is
  missing or older than 6 hours, or a push to the default branch changed the file, one
  deduplicated `repo.inputs_refresh` job is queued. The first push of a new repository is
  therefore analysed with defaults (recorded as `not_read_yet`).

## 5.3 CODEOWNERS

The first of `.github/CODEOWNERS`, `CODEOWNERS` or `docs/CODEOWNERS` on the default branch
is read with the config. GitHub semantics apply: the last matching line wins, and a
matching line with no owner means unowned. Only `@user` and `@org/team` owners are kept;
**email owners are dropped** and counted, so addresses are never stored or shown. Owners
of the changed files appear on the risk panel, the change-analysis panel and in PR
checks, escaped so GitHub sends no notifications. Owners are not sent to Gemini (they
aren't needed to judge risk).

## 5.1 Pull request risk checks (advisory)

`pull_request` (opened, synchronize, reopened, ready_for_review) is queued like
`workflow_run`. The job:

1. stops if checks are off (`DEPLOYGUARD_PR_CHECKS=off` globally, or
   `pull_request_checks: false` in the repository's config), recording `disabled`;
2. lists the PR's files (up to 300; renames count as the new path added and the old one
   removed) and runs the **same** analysis, config, similarity search (same repository
   and ownership boundary), evidence rules and validator as for deployments. The bundle
   says it is an unmerged pull request, and its placeholder id cannot be cited;
3. reuses a stored assessment when an earlier commit of the PR produced the same
   evidence; otherwise it makes one Gemini call within the repository's usage caps.
   Invalid or failed answers show "risk analysis unavailable", never a guessed level;
4. finds DeployGuard's check run for the head commit (by name and `external_id`) and
   **updates** it, or creates it. The conclusion is always `neutral`.

The text is redacted and HTML/Markdown-escaped. Links are built only from numeric
deployment ids and `DEPLOYGUARD_BASE_URL` (https only). A missing permission is recorded
as `permission_missing` rather than retried. Recent checks are listed on the dashboard.

## 5.5 Environment awareness

* `deployment_status` events record `(GitHub deployment, environment, state)` for every
  DeployGuard deployment of that commit in that repository. An older status never
  overwrites a newer one.
* After a final CI result, one delayed `github.environments_sync` job asks
  `GET /deployments?sha=` (at most 10 GitHub deployments) for repositories without
  events.
* With no permission, or no GitHub deployments, the deployment is **"environment
  unknown"**: on the dashboard, in history and in the bundle. It is never assumed to be
  production. Every historical match carries its own environments, and the model is told
  not to treat staging and production outcomes as the same history.

## Verification

* `npm test`: `tests/inputs.test.mjs` (signals, globs, config parser, CODEOWNERS,
  check-run escaping, no invented level).
* `npm run verify:inputs` (dev server up): 42 end-to-end checks through the real webhook,
  queue, analysis, bundle and dashboard. GitHub file reads and check-run posting need a
  real installation: **MANUAL TEST REQUIRED**.
