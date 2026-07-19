ALTER TABLE "public_operations"
  DROP CONSTRAINT "public_operations_type_check";

ALTER TABLE "public_operations"
  ADD CONSTRAINT "public_operations_type_check"
  CHECK ("type" IN ('artifact-render', 'media-ingest', 'project-proxy-render', 'project-final-export'));

ALTER TABLE "project_media_assets"
  DROP CONSTRAINT "project_media_assets_role_check";

ALTER TABLE "project_media_assets"
  ADD CONSTRAINT "project_media_assets_role_check"
  CHECK ("role" IN ('source-master', 'editing-proxy', 'editorial-proxy', 'final-output'));

CREATE TABLE "project_final_export_operations" (
  "operationId" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "projectVersionId" VARCHAR(128) NOT NULL,
  "projectVersionHash" CHAR(64) NOT NULL,
  "editPlanSnapshotId" VARCHAR(128) NOT NULL,
  "directorRunId" VARCHAR(128) NOT NULL,
  "qualitySnapshotId" VARCHAR(128) NOT NULL,
  "qualitySnapshotHash" CHAR(64) NOT NULL,
  "sourceArtifactId" VARCHAR(128) NOT NULL,
  "sourceManifestId" VARCHAR(128) NOT NULL,
  "inputHash" CHAR(64) NOT NULL,
  "outputArtifactId" VARCHAR(128) NOT NULL,
  "outputManifestId" VARCHAR(128) NOT NULL,
  "outputAspectRatio" VARCHAR(16) NOT NULL,
  "outputWidth" INTEGER NOT NULL,
  "outputHeight" INTEGER NOT NULL,
  "outputFps" INTEGER NOT NULL,
  "approvedByType" VARCHAR(32) NOT NULL,
  "approvedById" VARCHAR(128) NOT NULL,
  "approvalNote" VARCHAR(1000),
  "approvedAt" TIMESTAMPTZ(3) NOT NULL,
  "originalFileName" VARCHAR(240) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "project_final_export_operations_pkey" PRIMARY KEY ("operationId"),
  CONSTRAINT "project_final_export_operations_hashes_check" CHECK (
    "projectVersionHash" ~ '^[a-f0-9]{64}$' AND
    "qualitySnapshotHash" ~ '^[a-f0-9]{64}$' AND
    "inputHash" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "project_final_export_operations_output_check" CHECK (
    "outputAspectRatio" IN ('9:16', '16:9', '4:5', '1:1', '21:9') AND
    "outputWidth" > 0 AND "outputWidth" % 2 = 0 AND
    "outputHeight" > 0 AND "outputHeight" % 2 = 0 AND
    "outputFps" BETWEEN 1 AND 120
  ),
  CONSTRAINT "project_final_export_operations_approval_check" CHECK (
    "approvedByType" IN ('user', 'api-client') AND
    length(trim("approvedById")) >= 3
  )
);

CREATE UNIQUE INDEX "project_final_export_operations_operationId_workspaceId_key"
  ON "project_final_export_operations"("operationId", "workspaceId");
CREATE INDEX "project_final_export_operations_workspaceId_projectVersionI_idx"
  ON "project_final_export_operations"("workspaceId", "projectVersionId", "inputHash");
CREATE INDEX "project_final_export_operations_workspaceId_projectId_creat_idx"
  ON "project_final_export_operations"("workspaceId", "projectId", "createdAt" DESC);
CREATE INDEX "project_final_export_operations_workspaceId_sourceArtifactI_idx"
  ON "project_final_export_operations"("workspaceId", "sourceArtifactId");
CREATE INDEX "project_final_export_operations_workspaceId_outputArtifactI_idx"
  ON "project_final_export_operations"("workspaceId", "outputArtifactId");
CREATE INDEX "project_final_export_operations_workspaceId_directorRunId_idx"
  ON "project_final_export_operations"("workspaceId", "directorRunId");

ALTER TABLE "project_final_export_operations"
  ADD CONSTRAINT "project_final_export_operations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_final_export_operations_operationId_workspaceId_fkey" FOREIGN KEY ("operationId", "workspaceId") REFERENCES "public_operations"("id", "workspaceId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "project_final_export_operations_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_final_export_operations_projectVersionId_workspace_fkey" FOREIGN KEY ("projectVersionId", "workspaceId") REFERENCES "project_versions"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_final_export_operations_directorRunId_workspaceId_fkey" FOREIGN KEY ("directorRunId", "workspaceId") REFERENCES "director_runs"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_final_export_operations_qualitySnapshotId_fkey" FOREIGN KEY ("qualitySnapshotId") REFERENCES "project_snapshots"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
