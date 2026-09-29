-- Phase 2: the structured source of truth for deployment records.
--
-- Safe to run more than once: every statement is written to be re-runnable.

CREATE TABLE IF NOT EXISTS deployments (
  id              BIGSERIAL PRIMARY KEY,

  -- where the push came from
  repository      TEXT        NOT NULL,
  owner           TEXT        NOT NULL,
  branch          TEXT        NOT NULL,

  -- what the push contained
  commit_sha      TEXT        NOT NULL,
  commit_message  TEXT        NOT NULL DEFAULT '',
  author          TEXT        NOT NULL DEFAULT 'unknown',

  -- which files moved. text[] (not jsonb) so Phase 6 can use PostgreSQL's
  -- array operators directly, e.g.  WHERE changed_files && ARRAY['config/database.yaml']
  changed_files   TEXT[]      NOT NULL DEFAULT '{}',
  added_files     TEXT[]      NOT NULL DEFAULT '{}',
  modified_files  TEXT[]      NOT NULL DEFAULT '{}',
  deleted_files   TEXT[]      NOT NULL DEFAULT '{}',

  -- lifecycle. RECEIVED now; the later states arrive with the CI pipeline in Phase 3.
  status          TEXT        NOT NULL DEFAULT 'RECEIVED'
                    CHECK (status IN ('RECEIVED', 'BUILDING', 'SUCCESS', 'FAILED', 'ROLLED_BACK')),

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency.
--
-- GitHub retries a webhook delivery if our server is slow or returns an error, and
-- the retry carries the SAME payload. This constraint is what makes a retry land as
-- "already recorded" instead of a second row. The same commit pushed to a different
-- branch is genuinely a different deployment, so branch is part of the key.
CREATE UNIQUE INDEX IF NOT EXISTS deployments_unique_push
  ON deployments (owner, repository, branch, commit_sha);

-- Newest-first listing is the most common read (dashboard, history).
CREATE INDEX IF NOT EXISTS deployments_created_at_idx
  ON deployments (created_at DESC);

-- Phase 6 will ask "which past deployments touched any of these files?".
-- A GIN index makes the array-overlap operator (&&) fast.
CREATE INDEX IF NOT EXISTS deployments_changed_files_idx
  ON deployments USING GIN (changed_files);
