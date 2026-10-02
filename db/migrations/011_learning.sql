-- Stage 4: learning features. Additive and re-runnable like 001-010. Safe on a
-- database with real data: new tables, new nullable columns, new indexes and
-- two triggers that refuse edits to recorded predictions and outcomes.
--
-- Rollback / recovery: pre-Stage-4 code ignores every new table and column, so
-- rolling back = deploying the previous code. To remove the triggers:
--   DROP TRIGGER IF EXISTS risk_assessments_immutable ON risk_assessments;
--   DROP TRIGGER IF EXISTS risk_outcomes_append_only ON risk_outcomes;
--   DROP TRIGGER IF EXISTS incident_confirmations_append_only ON incident_confirmations;
-- The new tables can stay (or be dropped; they hold only Stage 4 data).

-- ---------------------------------------------------------------------------
-- 4.1 Human-confirmed root cause and resolution
-- ---------------------------------------------------------------------------
-- Every confirmation (and every later edit) is a NEW revision row; rows are
-- never updated, so the full edit history is kept. The incident row mirrors the
-- newest revision in root_cause / resolution / affected_service /
-- downstream_effect (which nothing else ever writes) plus who confirmed it, so
-- all existing readers see the confirmed values with their provenance.
CREATE TABLE IF NOT EXISTS incident_confirmations (
  id                 BIGSERIAL   PRIMARY KEY,
  -- Part of the incident's record: purged with it.
  incident_id        BIGINT      NOT NULL REFERENCES incidents (id) ON DELETE CASCADE,
  revision           INTEGER     NOT NULL CHECK (revision >= 1),
  -- NULL = "not known" (the person confirmed some fields but not this one).
  root_cause         TEXT,
  resolution         TEXT,
  affected_service   TEXT,
  downstream_effect  TEXT,
  -- Attribution. The login is a snapshot (logins can change); the user id is
  -- kept while the account exists.
  confirmed_by_user_id BIGINT    REFERENCES users (id) ON DELETE SET NULL,
  confirmed_by_login TEXT        NOT NULL,
  confirmed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Counts/categories only when redaction masked something in the input.
  redaction          JSONB,
  UNIQUE (incident_id, revision)
);
CREATE INDEX IF NOT EXISTS incident_confirmations_incident_idx ON incident_confirmations (incident_id, revision DESC);

CREATE OR REPLACE FUNCTION deployguard_refuse_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: rows cannot be changed', TG_TABLE_NAME;
END $$;
DROP TRIGGER IF EXISTS incident_confirmations_append_only ON incident_confirmations;
CREATE TRIGGER incident_confirmations_append_only BEFORE UPDATE ON incident_confirmations
  FOR EACH ROW EXECUTE FUNCTION deployguard_refuse_update();

ALTER TABLE incidents ADD COLUMN IF NOT EXISTS confirmed_revision   INTEGER;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS confirmed_by_login   TEXT;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS confirmed_at         TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 4.4 Flaky failure detection + the evidence for it
-- ---------------------------------------------------------------------------
-- The failing run, snapshotted when the incident is recorded (the deployment's
-- ci_run_* columns are overwritten by a re-run).
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS failed_ci_run_id     TEXT;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS failed_ci_run_url    TEXT;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS failed_at            TIMESTAMPTZ;
-- 'probable_flake' when a re-run of the SAME commit passed; NULL otherwise.
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS flake_status TEXT CHECK (flake_status IN ('probable_flake'));
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS flake_passing_run_id  TEXT;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS flake_passing_run_url TEXT;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS flake_detected_at     TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 4.3 Recurring failure patterns: a normalised error signature per incident
-- ---------------------------------------------------------------------------
-- Computed by lib/learning/signature.ts when the incident is recorded (and for
-- older incidents by the maintenance run). NULL = not computed yet.
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS error_signature TEXT;
CREATE INDEX IF NOT EXISTS incidents_error_signature_idx ON incidents (error_signature) WHERE error_signature IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4.2 Risk accuracy tracking
-- ---------------------------------------------------------------------------
-- Predictions are immutable. Only redaction of stored text (db:redact-existing)
-- may touch an assessment row; the prediction itself, its time, its deployment,
-- its evidence fingerprint and the pipeline state it was based on cannot change.
CREATE OR REPLACE FUNCTION risk_assessments_refuse_edit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deployment_id IS DISTINCT FROM OLD.deployment_id
     OR NEW.risk_level IS DISTINCT FROM OLD.risk_level
     OR NEW.risk_confidence IS DISTINCT FROM OLD.risk_confidence
     OR NEW.risk_reasons IS DISTINCT FROM OLD.risk_reasons
     OR NEW.evidence_fingerprint IS DISTINCT FROM OLD.evidence_fingerprint
     OR NEW.model IS DISTINCT FROM OLD.model
     OR NEW.risk_generated_at IS DISTINCT FROM OLD.risk_generated_at
     OR (NEW.evidence -> 'current_pipeline' ->> 'status') IS DISTINCT FROM (OLD.evidence -> 'current_pipeline' ->> 'status')
  THEN
    RAISE EXCEPTION 'risk_assessments are immutable predictions: only text redaction may change a row';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS risk_assessments_immutable ON risk_assessments;
CREATE TRIGGER risk_assessments_immutable BEFORE UPDATE ON risk_assessments
  FOR EACH ROW EXECUTE FUNCTION risk_assessments_refuse_edit();

-- One row per (deployment, final outcome observed). A re-run that changes the
-- outcome adds a row; nothing is edited. The newest row per deployment counts.
CREATE TABLE IF NOT EXISTS risk_outcomes (
  id                BIGSERIAL   PRIMARY KEY,
  deployment_id     BIGINT      NOT NULL REFERENCES deployments (id) ON DELETE CASCADE,
  -- The prediction compared: the newest assessment made BEFORE the CI result.
  assessment_id     BIGINT      REFERENCES risk_assessments (id) ON DELETE CASCADE,
  predicted_level   TEXT        CHECK (predicted_level IN ('LOW', 'MEDIUM', 'HIGH')),
  outcome_status    TEXT        NOT NULL CHECK (outcome_status IN ('SUCCESS', 'FAILED')),
  result            TEXT        NOT NULL CHECK (result IN ('hit', 'miss', 'false_alarm', 'unscored')),
  unscored_reason   TEXT,
  rule_version      TEXT        NOT NULL,
  outcome_at        TIMESTAMPTZ NOT NULL,
  scored_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (deployment_id, outcome_status, outcome_at)
);
CREATE INDEX IF NOT EXISTS risk_outcomes_deployment_idx ON risk_outcomes (deployment_id, scored_at DESC);
DROP TRIGGER IF EXISTS risk_outcomes_append_only ON risk_outcomes;
CREATE TRIGGER risk_outcomes_append_only BEFORE UPDATE ON risk_outcomes
  FOR EACH ROW EXECUTE FUNCTION deployguard_refuse_update();

-- ---------------------------------------------------------------------------
-- 4.5 Revert detection
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deployment_reverts (
  id                       BIGSERIAL   PRIMARY KEY,
  reverted_deployment_id   BIGINT      NOT NULL REFERENCES deployments (id) ON DELETE CASCADE,
  reverting_deployment_id  BIGINT      NOT NULL REFERENCES deployments (id) ON DELETE CASCADE,
  -- How it was recognised: the reverted SHA named in the message, or only the
  -- reverted commit's title ("Revert \"<title>\"").
  matched_by               TEXT        NOT NULL CHECK (matched_by IN ('reverted_sha', 'revert_title')),
  hours_after              NUMERIC(10,2) NOT NULL,
  detected_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (reverted_deployment_id, reverting_deployment_id)
);
CREATE INDEX IF NOT EXISTS deployment_reverts_reverting_idx ON deployment_reverts (reverting_deployment_id);
