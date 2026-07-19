ALTER TABLE "review_annotations"
  ADD COLUMN "applicationScopeJson" TEXT,
  ADD COLUMN "affectedCount" INTEGER;

UPDATE "review_annotations" AS annotation
SET
  "applicationScopeJson" = json_build_object(
    'kind', CASE annotation."scope"
      WHEN 'point' THEN 'frame'
      WHEN 'region' THEN 'region'
      ELSE 'scene'
    END,
    'targetIds', CASE
      WHEN annotation."scope" = 'scene' THEN annotation."targetIdsJson"::json
      ELSE json_build_array('frame:' || annotation."frame"::text)
    END,
    'formatIds', json_build_array(project."format"),
    'localeIds', json_build_array(COALESCE(project."locale", 'pt-BR')),
    'recipeIds', json_build_array(),
    'global', false
  )::text,
  "affectedCount" = 1
FROM "projects" AS project
WHERE project."id" = annotation."projectId"
  AND project."workspaceId" = annotation."workspaceId";

ALTER TABLE "review_annotations"
  ALTER COLUMN "applicationScopeJson" SET NOT NULL,
  ALTER COLUMN "affectedCount" SET NOT NULL;

ALTER TABLE "review_annotations"
  ADD CONSTRAINT "review_annotations_affected_count_check" CHECK ("affectedCount" >= 1),
  ADD CONSTRAINT "review_annotations_application_scope_json_check" CHECK (
    "applicationScopeJson" IS JSON OBJECT WITH UNIQUE KEYS
  );
