-- Stage 2: durable processing, ordering, usage caps, data integrity, lifecycle.
-- Additive and re-runnable like 001-009. Safe on a database with real data:
-- new tables, new nullable columns, new indexes, and two foreign keys whose
-- delete action becomes stricter (see "History-preserving foreign keys").
--
-- Rollback / recovery: every new table and column is ignored by pre-Stage-2
-- code, so rolling back = deploying the previous code. The tables can stay.
-- The two foreign keys can be returned to their old actions with the
-- statements in the comments next to them.

-- ---------------------------------------------------------------------------
-- 1. The job queue (FOR UPDATE SKIP LOCKED; no extra infrastructure)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
  id            BIGSERIAL   PRIMARY KEY,
  type          TEXT        NOT NULL,
  -- References only (delivery id, deployment id, ...), never repository content.
  payload       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- Idempotency: one job per key (e.g. "webhook:<delivery guid>"). NULL = no key.
  dedupe_key    TEXT        UNIQUE,
  status        TEXT        NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'succeeded', 'dead')),
  attempts      INTEGER     NOT NULL DEFAULT 0,
  max_attempts  INTEGER     NOT NULL DEFAULT 5,
  run_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by     TEXT,
  locked_at     TIMESTAMPTZ,
  last_error    TEXT,       -- redacted, truncated
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS jobs_ready_idx ON jobs (run_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS jobs_running_idx ON jobs (locked_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS jobs_dead_idx ON jobs (updated_at) WHERE status = 'dead';
CREATE INDEX IF NOT EXISTS jobs_finished_idx ON jobs (finished_at) WHERE status = 'succeeded';

-- Deliveries now keep the payload of EVERY queued event until it is processed.
-- (Column already exists; nothing to add.)

-- ---------------------------------------------------------------------------
-- 2. Ordering: the GitHub timestamp of the newest pipeline event applied
-- ---------------------------------------------------------------------------
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS ci_last_event_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 3. Gemini usage per tenant (counts only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gemini_usage (
  tenant  TEXT    NOT NULL,   -- "ghrepo:<id>" or "unowned"
  day     DATE    NOT NULL,
  calls   INTEGER NOT NULL DEFAULT 0,
  refused INTEGER NOT NULL DEFAULT 0,  -- calls not made because a cap was reached
  PRIMARY KEY (tenant, day)
);

-- ---------------------------------------------------------------------------
-- 4. Hindsight document tracking (so a purge can delete exactly what we wrote)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_documents (
  document_id           TEXT        PRIMARY KEY,
  kind                  TEXT        NOT NULL,   -- deployment | incident | risk_assessment
  github_repository_id  BIGINT      NOT NULL,
  deployment_id         BIGINT,
  incident_id           BIGINT,
  retained_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at            TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS memory_documents_repo_idx ON memory_documents (github_repository_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS memory_documents_deployment_idx ON memory_documents (deployment_id);

-- ---------------------------------------------------------------------------
-- 5. Audit log (append-only; Stage 6 adds the viewer). No payloads, no secrets.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id                    BIGSERIAL   PRIMARY KEY,
  at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor                 TEXT        NOT NULL,   -- "user:<id>", "internal", "system"
  action                TEXT        NOT NULL,   -- e.g. "repository.purge"
  github_repository_id  BIGINT,
  outcome               TEXT        NOT NULL,   -- "ok" | "failed" | "refused"
  detail                JSONB       NOT NULL DEFAULT '{}'::jsonb  -- counts and ids only
);
CREATE INDEX IF NOT EXISTS audit_log_repo_idx ON audit_log (github_repository_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log (actor, at DESC);
-- Append-only: refuse UPDATE and DELETE on audit rows at the database level.
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $$;
DROP TRIGGER IF EXISTS audit_log_no_change ON audit_log;
CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

-- ---------------------------------------------------------------------------
-- 6. History-preserving foreign keys
-- ---------------------------------------------------------------------------
-- Before: deleting an installation row CASCADE-deleted its repositories, and
-- deleting a repository row SET NULL on its deployments -- silently turning a
-- user's history into unowned rows nobody can see. Nothing in the app deletes
-- these rows, but a manual or future DELETE must not destroy history. Now both
-- are RESTRICT: a repository's deployments must be removed deliberately (the
-- purge action) before the repository row can go.
--   Rollback: re-add with ON DELETE CASCADE / ON DELETE SET NULL respectively.
ALTER TABLE repositories DROP CONSTRAINT IF EXISTS repositories_installation_id_fkey;
ALTER TABLE repositories ADD CONSTRAINT repositories_installation_id_fkey
  FOREIGN KEY (installation_id) REFERENCES github_installations (installation_id) ON DELETE RESTRICT;
ALTER TABLE deployments DROP CONSTRAINT IF EXISTS deployments_repository_id_fkey;
ALTER TABLE deployments ADD CONSTRAINT deployments_repository_id_fkey
  FOREIGN KEY (repository_id) REFERENCES repositories (id) ON DELETE RESTRICT;
-- incidents / risk_assessments keep ON DELETE CASCADE from deployments: they
-- are parts of one deployment's record and go only when it is purged.

-- ---------------------------------------------------------------------------
-- 7. Integrity and hot-path indexes
-- ---------------------------------------------------------------------------
-- One deployment per (immutable repository id, branch, commit). The existing
-- name-based key stays; this one survives repository renames.
CREATE UNIQUE INDEX IF NOT EXISTS deployments_unique_push_by_repo_id
  ON deployments (github_repository_id, branch, commit_sha) WHERE github_repository_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS deployments_github_repository_id_idx ON deployments (github_repository_id, created_at DESC);
-- Stale-pipeline and stuck-analysis scans.
CREATE INDEX IF NOT EXISTS deployments_open_pipeline_idx ON deployments (updated_at) WHERE status IN ('RECEIVED', 'BUILDING');
CREATE INDEX IF NOT EXISTS deployments_pending_risk_idx ON deployments (risk_analysis_updated_at) WHERE risk_analysis_status = 'pending';
-- Retention scan on failure output.
CREATE INDEX IF NOT EXISTS deployments_failed_created_idx ON deployments (created_at) WHERE failure_message IS NOT NULL;
CREATE INDEX IF NOT EXISTS repositories_connected_idx ON repositories (installation_id) WHERE connected;
