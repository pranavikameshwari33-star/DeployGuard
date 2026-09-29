-- Phase 4: incident memory. One incident per FAILED deployment, recording what
-- went wrong.
--
-- Additive only, and safe to run more than once, like 001 and 002.
--
-- Evidence rule: failure_type, failure_job and error_message are filled from
-- what the CI pipeline actually reported. affected_service, downstream_effect,
-- root_cause and resolution stay NULL ("not known") until someone -- a person
-- or a later phase -- has real evidence for them. NULL never means "none".

CREATE TABLE IF NOT EXISTS incidents (
  id                BIGSERIAL   PRIMARY KEY,

  -- The deployment that failed. Deleting a deployment removes its incident.
  deployment_id     BIGINT      NOT NULL REFERENCES deployments (id) ON DELETE CASCADE,

  -- Observed facts, copied from the pipeline report.
  failure_type      TEXT        NOT NULL,   -- which stage stopped, e.g. 'test_failure'
  failure_job       TEXT,                   -- the CI job that failed
  error_message     TEXT,                   -- the tail of the failing stage's output

  -- Not known yet. Filled only when there is evidence.
  affected_service  TEXT,
  downstream_effect TEXT,
  root_cause        TEXT,
  resolution        TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency: one incident per deployment. A retried FAILED report, a GitHub
-- retry or a re-run that fails again all land on this same row instead of
-- creating a second one.
CREATE UNIQUE INDEX IF NOT EXISTS incidents_deployment_id_key
  ON incidents (deployment_id);

-- Newest-first listing, and "what kind of failures have we had?".
CREATE INDEX IF NOT EXISTS incidents_created_at_idx ON incidents (created_at DESC);
CREATE INDEX IF NOT EXISTS incidents_failure_type_idx ON incidents (failure_type);
