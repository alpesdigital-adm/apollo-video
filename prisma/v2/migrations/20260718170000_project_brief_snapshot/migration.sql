CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE "project_snapshots"
  DROP CONSTRAINT "project_snapshots_kind_check";

ALTER TABLE "project_snapshots"
  ADD CONSTRAINT "project_snapshots_kind_check"
  CHECK ("kind" IN ('brief', 'edit-plan', 'policies'));

ALTER TABLE "project_versions"
  ADD COLUMN "briefSnapshotId" VARCHAR(128);

WITH bootstrap AS (
  SELECT
    version."id" AS "versionId",
    version."workspaceId",
    version."projectId",
    version."createdAt",
    ('brief-bootstrap-' || md5(version."id"))::VARCHAR(128) AS "snapshotId",
    jsonb_build_object(
      'schemaVersion', 1,
      'objective', COALESCE(project."objective", 'discovery'),
      'desiredAction', jsonb_build_object(
        'schemaVersion', 1,
        'kind', 'continue-viewing',
        'disclosures', jsonb_build_array()
      ),
      'outputSpec', jsonb_build_object(
        'schemaVersion', 1,
        'id', 'output-' || replace(COALESCE(project."format", '9:16'), ':', 'x') || '-pt-br',
        'locale', COALESCE(project."locale", 'pt-BR'),
        'aspectRatio', COALESCE(project."format", '9:16'),
        'width', CASE COALESCE(project."format", '9:16')
          WHEN '16:9' THEN 1920
          WHEN '21:9' THEN 2520
          ELSE 1080
        END,
        'height', CASE COALESCE(project."format", '9:16')
          WHEN '9:16' THEN 1920
          WHEN '16:9' THEN 1080
          WHEN '4:5' THEN 1350
          WHEN '1:1' THEN 1080
          WHEN '21:9' THEN 1080
          ELSE 1920
        END,
        'fps', 30,
        'safeArea', jsonb_build_object(
          'top', 0.05,
          'right', 0.05,
          'bottom', 0.05,
          'left', 0.05
        )
      ),
      'productionBrief', jsonb_build_object(
        'schemaVersion', 1,
        'summary', jsonb_build_object(
          'text', 'Sem briefing livre; análise seguirá apenas objetivo, ação e mídia.',
          'supplied', false
        ),
        'assumptions', jsonb_build_array(
          'briefing-absent',
          'audience-not-specified',
          'offer-not-specified',
          'tone-not-specified'
        ),
        'readyForExpensiveGeneration', false
      ),
      'createdAt', version."createdAt"
    )::text AS "contentJson"
  FROM "project_versions" version
  JOIN "projects" project ON project."id" = version."projectId"
)
INSERT INTO "project_snapshots" (
  "id", "workspaceId", "projectId", "kind", "schemaVersion",
  "contentJson", "contentHash", "createdAt"
)
SELECT
  "snapshotId", "workspaceId", "projectId", 'brief', 1,
  "contentJson", encode(digest("contentJson"::bytea, 'sha256'), 'hex'), "createdAt"
FROM bootstrap;

UPDATE "project_versions" version
SET "briefSnapshotId" = 'brief-bootstrap-' || md5(version."id");

ALTER TABLE "project_versions"
  ALTER COLUMN "briefSnapshotId" SET NOT NULL;

ALTER TABLE "project_versions"
  ADD CONSTRAINT "project_versions_briefSnapshotId_fkey" FOREIGN KEY ("briefSnapshotId") REFERENCES "project_snapshots"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
