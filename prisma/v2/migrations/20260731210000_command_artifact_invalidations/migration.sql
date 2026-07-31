CREATE TABLE "command_artifact_invalidations" (
  "id" CHAR(64) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "commandId" VARCHAR(128) NOT NULL,
  "baseVersionId" VARCHAR(128) NOT NULL,
  "resultVersionId" VARCHAR(128) NOT NULL,
  "artifactId" VARCHAR(128) NOT NULL,
  "kind" VARCHAR(16) NOT NULL,
  "variantId" VARCHAR(128) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'stale',
  "dependencyTypesJson" TEXT NOT NULL,
  "affectedRangesJson" TEXT NOT NULL,
  "impactHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "command_artifact_invalidations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "command_artifact_invalidations_kind_check" CHECK ("kind" IN ('proxy', 'final')),
  CONSTRAINT "command_artifact_invalidations_status_check" CHECK ("status" = 'stale'),
  CONSTRAINT "command_artifact_invalidations_hash_check" CHECK ("id" ~ '^[a-f0-9]{64}$' AND "impactHash" ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX "command_artifact_invalidations_id_workspaceId_key" ON "command_artifact_invalidations"("id", "workspaceId");
CREATE UNIQUE INDEX "command_artifact_invalidations_commandId_artifactId_key" ON "command_artifact_invalidations"("commandId", "artifactId");
CREATE INDEX "command_artifact_invalidations_workspaceId_projectId_result_idx" ON "command_artifact_invalidations"("workspaceId", "projectId", "resultVersionId", "status");
CREATE INDEX "command_artifact_invalidations_workspaceId_artifactId_statu_idx" ON "command_artifact_invalidations"("workspaceId", "artifactId", "status");
CREATE INDEX "command_artifact_invalidations_workspaceId_impactHash_idx" ON "command_artifact_invalidations"("workspaceId", "impactHash");

ALTER TABLE "command_artifact_invalidations" ADD CONSTRAINT "command_artifact_invalidations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "command_artifact_invalidations" ADD CONSTRAINT "command_artifact_invalidations_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "command_artifact_invalidations" ADD CONSTRAINT "command_artifact_invalidations_commandId_workspaceId_fkey" FOREIGN KEY ("commandId", "workspaceId") REFERENCES "edit_commands"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "command_artifact_invalidations" ADD CONSTRAINT "command_artifact_invalidations_baseVersionId_workspaceId_fkey" FOREIGN KEY ("baseVersionId", "workspaceId") REFERENCES "project_versions"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "command_artifact_invalidations" ADD CONSTRAINT "command_artifact_invalidations_resultVersionId_workspaceId_fkey" FOREIGN KEY ("resultVersionId", "workspaceId") REFERENCES "project_versions"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "command_artifact_invalidations" ADD CONSTRAINT "command_artifact_invalidations_artifactId_workspaceId_fkey" FOREIGN KEY ("artifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
