# How DeployGuard learns from what happens (Stage 4)

DeployGuard keeps learning from real outcomes, not from guesses. Every learning
feature below is computed from **PostgreSQL records**. Hindsight can only suggest
which records to look at, and Gemini only ever receives records, each labelled
with where it came from.

| Feature | Where | Source of truth |
| --- | --- | --- |
| Human-confirmed root cause | incident page, `POST /api/incidents/confirmation` | `incident_confirmations` (append-only) mirrored on `incidents` |
| Risk prediction record | dashboard "Risk prediction record", `GET /api/dashboard` (`learning.accuracy`) | `risk_outcomes` (append-only) |
| Recurring failure patterns | dashboard "Recurring failure patterns" | computed by SQL from `incidents` + `deployments` |
| Probable flakes | incident page, history tables | `incidents.flake_status` + both run ids |
| Reverts | deployment detail, evidence bundles | `deployment_reverts` |
| Ask your history | dashboard "Ask your history", `GET /api/history/ask` | `deployments` + `incidents` |
| Offline evaluation | `npm run eval:risk` | fixtures or a real export |

## 4.1 Human-confirmed root cause and resolution

* Only a **signed-in owner** of the incident's repository can record one (same-origin
  request, rate-limited, audit-logged). Internal tooling is refused, because every
  confirmation must be attributable to a person. ("Authorized user" means repository
  owner until team roles exist in Stage 6.)
* Each save is a **new revision** in `incident_confirmations`, holding who (GitHub login),
  when and the values. Rows can never be updated (database trigger), so the edit history
  is complete. `base_revision` stops one person silently overwriting another's newer save
  (HTTP 409). Saving identical values creates nothing.
* An empty field means **not known** and is stored as NULL. Input is redacted (a pasted
  token is masked) and capped like any ingested text.
* Provenance: the bundle marks each incident `provenance: "HUMAN-CONFIRMED"` or
  `"NOT DETERMINED"`. Root cause, resolution, service and downstream effect are passed
  **only** when confirmed. The validator accepts a model's statement of a cause or fix
  only if a HUMAN-CONFIRMED record supplies one.
* After a save, the incident memory is rewritten (same `document_id`, replace) and **one**
  `learning.reevaluate` job is queued, delayed 120 s. When it runs, a revision that has
  since been superseded does nothing, so a burst of edits leads to one re-evaluation.
  Otherwise it re-analyses at most **5** deployments in the same repository whose
  *latest* assessment used this incident, through the normal controlled path: queued,
  deduplicated, usage caps applied, and only deployments under automatic analysis.

## 4.2 Risk accuracy (rule `accuracy-v1`)

The **prediction** is the newest validated assessment made **before** the CI result:
its evidence says the pipeline was RECEIVED or BUILDING, and it was generated no later
than the result. An assessment made afterwards (the automatic refresh with the CI
outcome in its evidence) already knew the answer and is never scored.

| predicted | then FAILED | then SUCCESS |
| --- | --- | --- |
| HIGH | hit | false alarm |
| LOW | miss | hit |
| MEDIUM | unscored | unscored |
| no prediction | unscored | unscored |

MEDIUM is unscored because it does not predict a direction. The dashboard shows the
raw level × outcome counts anyway, so nothing is hidden. One row is written per
deployment per change of outcome. A repeated report adds nothing; a re-run that flips
the outcome adds a row, and the newest row counts. Assessments cannot be edited
(database trigger on prediction, time, deployment, fingerprint, model and the
pipeline state they were based on; only text redaction may touch a row). Outcome rows
cannot be updated. Fewer than 20 scored outcomes shows a **small sample** notice.
No rates or significance claims are made.

## 4.3 Recurring failure patterns

Incidents of the last 60 days are grouped **per repository** by:

* normalised error signature (`lib/learning/signature.ts`: addresses, ports, numbers,
  paths, hex ids and quoted strings are replaced, so `connect ETIMEDOUT 10.0.0.7:5432`
  and `…10.0.0.9:6543` match);
* failed stage;
* component (a human-confirmed affected service wins over the path-derived ones);
* change category (uninformative ones such as `application_code` are skipped).

Two or more non-flaky incidents make a pattern, shown with links to every incident. A
pattern is an **observation** ("these share X"), never a statement of cause. Probable
flakes are left out of the count and reported as excluded. Hindsight is not used here:
page loads never call Hindsight. Older incidents get their signature from the
maintenance run (bounded backfill).

## 4.4 Probable flakes

A deployment is keyed by (repository, branch, commit), so a re-run is the same row:
FAILED → BUILDING → SUCCESS. When that happens, the incident is marked
`probable_flake`, with the failing run (snapshotted when the failure was recorded) and
the passing run as evidence. The incident is **never deleted**. It still appears in
history (labelled), earns no `same_failure_type` points in similarity, is left out of
patterns, and is labelled `probable_flake: true` in bundles.

## 4.5 Reverts

When a push is recorded, its message is checked for GitHub/`git revert` conventions
(`Revert "<title>"` and `This reverts commit <sha>.`). The SHA is matched exactly; the
title alone is matched against the first line of an earlier deployment's message. Only
earlier deployments of the **same repository and ownership** within
`DEPLOYGUARD_REVERT_WINDOW_HOURS` (default 72; 0 = off) are considered. The link is
stored in `deployment_reverts` and travels in later bundles as `reverted_by` / `reverts`
(a database fact, which the validator also allows the model to refer to).

## 4.6 Ask your history

1. **Gate.** The question must be about deployment/incident history, and requests to
   produce content ("write…", "ignore previous…") are refused. A question with nothing
   specific to look for is asked to be more specific.
2. **Hindsight** (scoped to the asker's `ghrepo:` tags, `any_strict`) only nominates
   deployment/incident **ids**. Its text is never used.
3. **PostgreSQL** (scope enforced in SQL; a foreign `?repo=` narrows to nothing) returns
   records that match at least half of the question's keyword groups (with a few
   synonyms, e.g. `timeout` ↔ `ETIMEDOUT`). Being nominated only raises a record's rank;
   it never lets a non-matching record in.
4. **The answer** is composed without an LLM: one sentence per record, each linked to its
   deployment (and incident). Confirmed causes are quoted as HUMAN-CONFIRMED, unknown
   ones as "not determined". If nothing matches, it says so.

## 4.7 Offline evaluation

`npm run eval:risk` replays histories through the real similarity scorer, the real
validator and the real accuracy rule, and prints **raw counts**: ratings vs outcomes,
hits, misses, false alarms, unscored and validator rejections.

* The bundled fixture (`tests/fixtures/risk-eval/synthetic-history.json`) is
  **synthetic**: hand-written histories and model outputs. It tests the harness, not
  whether DeployGuard is useful.
* `npm run eval:risk -- --export <file>` evaluates a real export
  (`GET /api/repositories/export`), using the outcomes DeployGuard recorded, plus a
  similarity replay ("did failed deployments have a similar earlier failure?").
  Judging usefulness and false-alarm rate on real histories is a **manual** step.

## Verification

* `npm test`: pure rules (accuracy table, flake rule, revert parsing, signatures,
  confirmation input, ask gate and record-only composition, provenance in the validator).
* `npm run verify:learning` (dev server up): 56 end-to-end checks through the real
  webhook, CI route, APIs and dashboard. Test data is purged from both stores.
