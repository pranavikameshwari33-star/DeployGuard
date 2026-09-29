-- Phase 9: GitHub login, GitHub App installations, connected repositories and
-- deployment ownership.
--
-- Additive only, and safe to run more than once, like 001-006. Existing rows
-- are untouched: deployments recorded before Phase 9 keep repository_id NULL
-- ("unowned") and are never shown to a signed-in user.
--
-- Ownership chain:  users <- github_installations <- repositories <- deployments
-- (incidents and risk_assessments already hang off deployments).

-- A DeployGuard account. The immutable GitHub user id is the identity; the
-- login (username) can change and is only display information.
CREATE TABLE IF NOT EXISTS users (
  id              BIGSERIAL   PRIMARY KEY,
  github_user_id  BIGINT      NOT NULL UNIQUE,
  github_login    TEXT        NOT NULL,
  display_name    TEXT,
  avatar_url      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Browser sessions. Only a SHA-256 hash of the random session token is stored,
-- so a database leak does not reveal usable session cookies.
CREATE TABLE IF NOT EXISTS sessions (
  id          BIGSERIAL   PRIMARY KEY,
  user_id     BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  TEXT        NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

-- One row per GitHub App installation (a user or organisation account that
-- installed the app). user_id is NULL until a signed-in DeployGuard user is
-- verified to have access to it. No installation token is ever stored:
-- tokens are minted on demand and expire after an hour.
CREATE TABLE IF NOT EXISTS github_installations (
  id                    BIGSERIAL   PRIMARY KEY,
  installation_id       BIGINT      NOT NULL UNIQUE,
  user_id               BIGINT      REFERENCES users (id) ON DELETE SET NULL,
  github_account_id     BIGINT,
  github_account_login  TEXT,
  account_type          TEXT,       -- 'User' or 'Organization'
  status                TEXT        NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS github_installations_user_id_idx ON github_installations (user_id);

-- Repositories an installation was granted. A repository removed from the
-- installation (or whose installation is deleted) is marked disconnected, not
-- deleted, so its deployment history is kept.
CREATE TABLE IF NOT EXISTS repositories (
  id                    BIGSERIAL   PRIMARY KEY,
  github_repository_id  BIGINT      NOT NULL UNIQUE,
  installation_id       BIGINT      NOT NULL REFERENCES github_installations (installation_id) ON DELETE CASCADE,
  owner                 TEXT        NOT NULL,
  name                  TEXT        NOT NULL,
  full_name             TEXT        NOT NULL,
  default_branch        TEXT,
  private               BOOLEAN,
  connected             BOOLEAN     NOT NULL DEFAULT true,
  disconnected_at       TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS repositories_installation_id_idx ON repositories (installation_id);

-- Deployment ownership. repository_id is the tenant boundary for everything
-- that hangs off a deployment. github_repository_id is the immutable id from the
-- push payload; Hindsight memories are tagged with it.
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS repository_id        BIGINT REFERENCES repositories (id) ON DELETE SET NULL;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS github_repository_id BIGINT;
CREATE INDEX IF NOT EXISTS deployments_repository_id_idx ON deployments (repository_id, created_at DESC);
