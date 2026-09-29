-- Phase 8: the state of AUTOMATIC risk analysis for each deployment.
--
-- Additive only, and safe to run more than once, like 001-005.
--
-- risk_assessments (Phase 7) stores only VALID assessments. These columns record
-- what happened on the latest automatic attempt, so the dashboard can tell
-- "pending" from "unavailable" without ever inventing a risk level:
--
--   NULL         never scheduled (recorded before Phase 8, or opted out)
--   pending      scheduled or running
--   completed    produced (or reused) a valid assessment
--   unavailable  Gemini failed or its answer was rejected; see risk_analysis_error

ALTER TABLE deployments ADD COLUMN IF NOT EXISTS risk_analysis_status TEXT
  CHECK (risk_analysis_status IN ('pending', 'completed', 'unavailable'));
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS risk_analysis_error      TEXT;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS risk_analysis_updated_at TIMESTAMPTZ;

-- Identifies the newest attempt. When a CI result triggers a refresh while an
-- earlier attempt is still running, only the newest attempt may record its outcome.
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS risk_analysis_attempt    TEXT;
