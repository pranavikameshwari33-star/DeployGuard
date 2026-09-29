-- Phase 7: AI risk assessments, one row per (deployment, evidence) pair.
--
-- Additive only, and safe to run more than once, like 001-004.
--
-- Append-only: a regenerated assessment (new pipeline result, new matching
-- history) is a NEW row, so earlier assessments are never overwritten.
-- Only assessments that passed validation are stored; a failed or invalid
-- Gemini call writes nothing here.

CREATE TABLE IF NOT EXISTS risk_assessments (
  id                   BIGSERIAL    PRIMARY KEY,
  deployment_id        BIGINT       NOT NULL REFERENCES deployments (id) ON DELETE CASCADE,

  -- The validated result.
  risk_level           TEXT         NOT NULL CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH')),
  risk_confidence      NUMERIC(3,2) NOT NULL CHECK (risk_confidence >= 0 AND risk_confidence <= 1),
  risk_summary         TEXT         NOT NULL,
  risk_reasons         JSONB        NOT NULL,   -- [{ reason, basis, evidence_deployment_ids }]
  historical_evidence  JSONB        NOT NULL,   -- [{ deployment_id, outcome, observed_failure, incident_id, relevance_note }]
  missing_information  JSONB        NOT NULL,   -- [string]
  recommended_checks   JSONB        NOT NULL,   -- [string]

  -- Provenance: exactly what the model saw, which model, and a hash of the facts.
  evidence             JSONB        NOT NULL,
  evidence_fingerprint TEXT         NOT NULL,
  model                TEXT         NOT NULL,

  risk_generated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- The same facts are assessed once: a repeated request reuses this row instead
-- of calling Gemini again.
CREATE UNIQUE INDEX IF NOT EXISTS risk_assessments_deployment_fingerprint_key
  ON risk_assessments (deployment_id, evidence_fingerprint);

-- "Latest assessment for this deployment".
CREATE INDEX IF NOT EXISTS risk_assessments_deployment_latest_idx
  ON risk_assessments (deployment_id, risk_generated_at DESC);
