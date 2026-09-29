-- Phase 10: production hardening. Additive only, re-runnable, like 001-007.

-- Rate limiting for /auth/* (and user-triggered risk refreshes). Fixed windows
-- in PostgreSQL: works across server instances and serverless invocations with
-- no extra infrastructure. `bucket` is "<route>:<client key>"; the client key is
-- a hash, never a raw IP address.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket        TEXT        NOT NULL,
  window_start  TIMESTAMPTZ NOT NULL,
  count         INTEGER     NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
CREATE INDEX IF NOT EXISTS rate_limits_window_start_idx ON rate_limits (window_start);

-- Every GitHub webhook delivery, keyed by GitHub's delivery GUID (a manual or
-- automatic redelivery keeps the same GUID). Gives three things:
--   * idempotency: a delivery that was already processed is not processed again;
--   * durability: workflow_run work runs after the HTTP response, so its payload
--     is kept until it is processed, and maintenance retries anything a
--     serverless timeout or crash left unfinished;
--   * diagnosis: what arrived, and what failed and why (no secrets are stored).
CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
  delivery_id           TEXT        PRIMARY KEY,
  event                 TEXT        NOT NULL,
  action                TEXT,
  installation_id       BIGINT,
  github_repository_id  BIGINT,
  status                TEXT        NOT NULL DEFAULT 'received'
                          CHECK (status IN ('received', 'processing', 'processed', 'failed', 'ignored')),
  attempts              INTEGER     NOT NULL DEFAULT 0,
  last_error            TEXT,
  payload               JSONB,      -- kept only for deferred work (workflow_run), cleared once processed
  received_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS github_webhook_deliveries_pending_idx
  ON github_webhook_deliveries (status, received_at) WHERE status IN ('received', 'processing', 'failed');
CREATE INDEX IF NOT EXISTS github_webhook_deliveries_received_at_idx ON github_webhook_deliveries (received_at);

-- Installations: who installed it (organisation installations are only linked
-- to that person's DeployGuard account), and when repositories were last
-- reconciled with GitHub.
ALTER TABLE github_installations ADD COLUMN IF NOT EXISTS installed_by_github_user_id BIGINT;
ALTER TABLE github_installations ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;
