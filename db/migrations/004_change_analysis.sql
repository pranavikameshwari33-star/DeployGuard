-- Phase 5: deterministic change analysis, stored on the deployment it describes.
--
-- Additive only, and safe to run more than once, like 001-003.
--
-- NULL means "not analysed" (the deployment was recorded before Phase 5), which
-- is different from an empty array ("analysed, nothing found").

-- Per-file detail: [{ "path", "change_type", "categories", "service" }, ...]
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS file_analysis     JSONB;

-- The union over all files, as text[] like changed_files, so Phase 6 can ask
-- "which deployments touched payments?" with the array-overlap operator (&&).
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS change_categories TEXT[];
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS affected_services TEXT[];

CREATE INDEX IF NOT EXISTS deployments_change_categories_idx
  ON deployments USING GIN (change_categories);
CREATE INDEX IF NOT EXISTS deployments_affected_services_idx
  ON deployments USING GIN (affected_services);
