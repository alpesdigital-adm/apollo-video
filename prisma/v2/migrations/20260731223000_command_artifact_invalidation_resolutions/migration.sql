CREATE TABLE "command_artifact_invalidation_resolutions" (
  "id" UUID NOT NULL,
  "invalidationId" CHAR(64) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "operationId" VARCHAR(128) NOT NULL,
  "replacementArtifactId" VARCHAR(128) NOT NULL,
  "replacementManifestId" VARCHAR(128) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "command_artifact_invalidation_resolutions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "command_artifact_invalidation_resolutions_invalidationId_op_key" ON "command_artifact_invalidation_resolutions"("invalidationId", "operationId");
CREATE INDEX "command_artifact_invalidation_resolutions_invalidationId_wo_idx" ON "command_artifact_invalidation_resolutions"("invalidationId", "workspaceId");
CREATE INDEX "command_artifact_invalidation_resolutions_workspaceId_proje_idx" ON "command_artifact_invalidation_resolutions"("workspaceId", "projectId", "operationId");
CREATE INDEX "command_artifact_invalidation_resolutions_workspaceId_repla_idx" ON "command_artifact_invalidation_resolutions"("workspaceId", "replacementArtifactId");

ALTER TABLE "command_artifact_invalidation_resolutions" ADD CONSTRAINT "command_artifact_invalidation_resolutions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "command_artifact_invalidation_resolutions" ADD CONSTRAINT "command_artifact_invalidation_resolutions_projectId_worksp_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "command_artifact_invalidation_resolutions" ADD CONSTRAINT "command_artifact_invalidation_resolutions_invalidationId_w_fkey" FOREIGN KEY ("invalidationId", "workspaceId") REFERENCES "command_artifact_invalidations"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "command_artifact_invalidation_resolutions" ADD CONSTRAINT "command_artifact_invalidation_resolutions_operationId_work_fkey" FOREIGN KEY ("operationId", "workspaceId") REFERENCES "public_operations"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "command_artifact_invalidation_resolutions" ADD CONSTRAINT "command_artifact_invalidation_resolutions_replacementArtif_fkey" FOREIGN KEY ("replacementArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "command_artifact_invalidation_resolutions" ADD CONSTRAINT "command_artifact_invalidation_resolutions_replacementManif_fkey" FOREIGN KEY ("replacementManifestId", "workspaceId") REFERENCES "media_artifact_manifests"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
