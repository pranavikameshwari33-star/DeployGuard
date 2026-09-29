-- Phase 3: what the CI/CD pipeline reported about each deployment.
--
-- Additive only: the existing Phase 2 columns and rows are untouched. Safe to run
-- more than once, like 001.

-- When the status last changed. Existing rows get their created_at.
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
UPDATE deployments SET updated_at = created_at WHERE updated_at IS NULL;
ALTER TABLE deployments ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE deployments ALTER COLUMN updated_at SET NOT NULL;

-- Which GitHub Actions run handled this deployment, so the dashboard can link to it.
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS ci_run_id           TEXT;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS ci_run_url          TEXT;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS ci_started_at       TIMESTAMPTZ;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS ci_finished_at      TIMESTAMPTZ;

-- Only filled when status = FAILED. These are facts the pipeline observed (which
-- stage stopped, which job, the tail of its output) -- NOT a root cause. Working
-- out why it failed is Phase 4+.
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS failure_stage       TEXT;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS failure_job         TEXT;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS failure_message     TEXT;
