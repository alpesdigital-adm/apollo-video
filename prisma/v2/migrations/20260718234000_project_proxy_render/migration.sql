ALTER TABLE "public_operations"
  DROP CONSTRAINT "public_operations_type_check";

ALTER TABLE "public_operations"
  ADD CONSTRAINT "public_operations_type_check"
  CHECK ("type" IN ('artifact-render', 'media-ingest', 'project-proxy-render'));

ALTER TABLE "project_media_assets"
  DROP CONSTRAINT "project_media_assets_role_check";

ALTER TABLE "project_media_assets"
  ADD CONSTRAINT "project_media_assets_role_check"
  CHECK ("role" IN ('source-master', 'editing-proxy', 'editorial-proxy'));

CREATE TABLE "project_proxy_render_operations" (
  "operationId" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "projectVersionId" VARCHAR(128) NOT NULL,
  "editPlanSnapshotId" VARCHAR(128) NOT NULL,
  "sourceArtifactId" VARCHAR(128) NOT NULL,
  "sourceManifestId" VARCHAR(128) NOT NULL,
  "inputHash" CHAR(64) NOT NULL,
  "outputArtifactId" VARCHAR(128) NOT NULL,
  "outputManifestId" VARCHAR(128) NOT NULL,
  "originalFileName" VARCHAR(240) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "project_proxy_render_operations_pkey" PRIMARY KEY ("operationId"),
  CONSTRAINT "project_proxy_render_operations_hash_check" CHECK ("inputHash" ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX "project_proxy_render_operations_operationId_workspaceId_key"
  ON "project_proxy_render_operations"("operationId", "workspaceId");
CREATE UNIQUE INDEX "project_proxy_render_operations_workspaceId_projectVersionI_key"
  ON "project_proxy_render_operations"("workspaceId", "projectVersionId", "inputHash");
CREATE INDEX "project_proxy_render_operations_workspaceId_projectId_creat_idx"
  ON "project_proxy_render_operations"("workspaceId", "projectId", "createdAt" DESC);
CREATE INDEX "project_proxy_render_operations_workspaceId_sourceArtifactI_idx"
  ON "project_proxy_render_operations"("workspaceId", "sourceArtifactId");
CREATE INDEX "project_proxy_render_operations_workspaceId_outputArtifactI_idx"
  ON "project_proxy_render_operations"("workspaceId", "outputArtifactId");

ALTER TABLE "project_proxy_render_operations"
  ADD CONSTRAINT "project_proxy_render_operations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_proxy_render_operations_operationId_workspaceId_fkey" FOREIGN KEY ("operationId", "workspaceId") REFERENCES "public_operations"("id", "workspaceId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "project_proxy_render_operations_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_proxy_render_operations_projectVersionId_workspace_fkey" FOREIGN KEY ("projectVersionId", "workspaceId") REFERENCES "project_versions"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE;
