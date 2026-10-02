-- Stage 5: better inputs to the analysis. Additive and re-runnable like 001-011:
-- new tables and new nullable columns only.
--
-- Rollback / recovery: pre-Stage-5 code ignores all of it; rolling back = deploying
-- the previous code. The tables can stay or be dropped (they hold only Stage 5 data).

-- ---------------------------------------------------------------------------
-- 5.2 / 5.3 Repository inputs read from GitHub: .deployguard.yml and CODEOWNERS
-- ---------------------------------------------------------------------------
-- One row per repository (immutable GitHub id). Only the VALIDATED, normalised
-- result is stored -- never the raw file -- plus the validation errors.
CREATE TABLE IF NOT EXISTS repository_inputs (
  github_repository_id  BIGINT      PRIMARY KEY,
  default_branch        TEXT,
  -- absent: no file; valid: parsed and validated; invalid: errors, defaults used;
  -- unavailable: could not be read (permission, network).
  config_status         TEXT        NOT NULL DEFAULT 'absent'
                          CHECK (config_status IN ('absent', 'valid', 'invalid', 'unavailable')),
  config                JSONB,      -- normalised config (valid only)
  config_errors         JSONB,      -- [string], line-numbered
  config_sha            TEXT,       -- blob SHA of the file that was read
  codeowners_status     TEXT        NOT NULL DEFAULT 'absent'
                          CHECK (codeowners_status IN ('absent', 'valid', 'unavailable')),
  codeowners_path       TEXT,
  codeowners            JSONB,      -- [{ pattern, owners: ["@handle" | "@org/team"] }], in file order
  codeowners_emails_dropped INTEGER NOT NULL DEFAULT 0,
  fetched_at            TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which config (if any) shaped a deployment's change analysis.
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS analysis_config JSONB;  -- { status, sha }

-- ---------------------------------------------------------------------------
-- 5.1 Pull request risk checks (advisory)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pull_request_checks (
  id                    BIGSERIAL   PRIMARY KEY,
  github_repository_id  BIGINT      NOT NULL,
  repository_id         BIGINT      REFERENCES repositories (id) ON DELETE CASCADE,
  pr_number             INTEGER     NOT NULL,
  head_sha              TEXT        NOT NULL,
  base_ref              TEXT,
  title                 TEXT,       -- redacted, capped
  state                 TEXT        NOT NULL DEFAULT 'pending'
                          CHECK (state IN ('pending', 'posted', 'disabled', 'permission_missing', 'failed')),
  detail                TEXT,       -- why, in words (no secrets)
  check_run_id          BIGINT,     -- the GitHub check run we created (updated, never duplicated)
  risk_level            TEXT        CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH')),
  analysis_status       TEXT        CHECK (analysis_status IN ('assessed', 'unavailable')),
  assessment            JSONB,      -- validated assessment (same validator as deployments)
  evidence              JSONB,      -- exactly what the model saw
  evidence_fingerprint  TEXT,
  model                 TEXT,
  files_analysed        INTEGER,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (github_repository_id, pr_number, head_sha)
);
CREATE INDEX IF NOT EXISTS pull_request_checks_repo_idx ON pull_request_checks (github_repository_id, updated_at DESC);

-- ---------------------------------------------------------------------------
-- 5.5 Environment awareness (GitHub Deployments API)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deployment_environments (
  id                    BIGSERIAL   PRIMARY KEY,
  deployment_id         BIGINT      NOT NULL REFERENCES deployments (id) ON DELETE CASCADE,
  github_deployment_id  BIGINT      NOT NULL,
  environment           TEXT        NOT NULL,   -- as named on GitHub (sanitised)
  state                 TEXT,                   -- latest deployment status: success, failure, error, in_progress, ...
  state_at              TIMESTAMPTZ,
  source                TEXT        NOT NULL CHECK (source IN ('deployment_status_event', 'deployments_api')),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (deployment_id, github_deployment_id)
);
CREATE INDEX IF NOT EXISTS deployment_environments_env_idx ON deployment_environments (environment);

-- found: GitHub reported deployments; none: GitHub reported none; unavailable:
-- could not ask (no permission / error). NULL: not asked yet. Anything but
-- "found" is shown as "environment unknown".
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS environments_status TEXT
  CHECK (environments_status IN ('found', 'none', 'unavailable'));
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS environments_checked_at TIMESTAMPTZ;
