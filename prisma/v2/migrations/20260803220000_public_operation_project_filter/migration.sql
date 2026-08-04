ALTER TABLE "public_operations"
  ADD COLUMN "projectId" VARCHAR(128);

UPDATE "public_operations" AS operation
SET "projectId" = context."projectId"
FROM (
  SELECT "operationId", "projectId" FROM "media_ingest_operations"
  UNION ALL
  SELECT "operationId", "projectId" FROM "project_proxy_render_operations"
  UNION ALL
  SELECT "operationId", "projectId" FROM "project_final_export_operations"
  UNION ALL
  SELECT "operationId", "projectId" FROM "source_cleanup_plans"
  UNION ALL
  SELECT "operationId", "projectId" FROM "long_form_index_workflows"
) AS context
WHERE operation."id" = context."operationId";

ALTER TABLE "public_operations"
  ADD CONSTRAINT "public_operations_project_scope_check"
  CHECK (
    ("type" = 'artifact-render' AND "projectId" IS NULL)
    OR
    (
      "type" IN (
        'media-ingest',
        'project-proxy-render',
        'project-final-export',
        'source-cleanup',
        'long-form-index'
      )
      AND "projectId" IS NOT NULL
    )
  );

CREATE INDEX "public_operations_workspaceId_projectId_createdAt_id_idx"
  ON "public_operations"("workspaceId", "projectId", "createdAt" DESC, "id" DESC);

ALTER TABLE "public_operations"
  ADD CONSTRAINT "public_operations_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
