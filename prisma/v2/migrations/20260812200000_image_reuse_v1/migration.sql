CREATE TABLE "image_reuse_references" (
    "id" VARCHAR(128) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "projectId" VARCHAR(128) NOT NULL,
    "artifactId" VARCHAR(128) NOT NULL,
    "manifestId" VARCHAR(128) NOT NULL,
    "mediaAssetReferenceId" UUID NOT NULL,
    "analysisId" VARCHAR(128) NOT NULL,
    "analysisHash" CHAR(64) NOT NULL,
    "rightsSnapshotId" VARCHAR(128) NOT NULL,
    "rightsSnapshotHash" CHAR(64) NOT NULL,
    "usage" VARCHAR(16) NOT NULL,
    "query" VARCHAR(240) NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "lineageHash" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "image_reuse_references_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "image_reuse_references_usage_check" CHECK ("usage" IN ('b-roll', 'insert', 'card')),
    CONSTRAINT "image_reuse_references_score_check" CHECK ("score" >= 0 AND "score" <= 1)
);

CREATE UNIQUE INDEX "image_reuse_references_id_workspaceId_key"
    ON "image_reuse_references"("id", "workspaceId");
CREATE UNIQUE INDEX "image_reuse_references_workspaceId_projectId_lineageHash_key"
    ON "image_reuse_references"("workspaceId", "projectId", "lineageHash");
CREATE INDEX "image_reuse_references_workspaceId_projectId_createdAt_idx"
    ON "image_reuse_references"("workspaceId", "projectId", "createdAt" DESC);
CREATE INDEX "image_reuse_references_workspaceId_artifactId_usage_idx"
    ON "image_reuse_references"("workspaceId", "artifactId", "usage");
CREATE INDEX "image_reuse_references_workspaceId_analysisId_idx"
    ON "image_reuse_references"("workspaceId", "analysisId");
CREATE INDEX "image_reuse_references_workspaceId_rightsSnapshotId_idx"
    ON "image_reuse_references"("workspaceId", "rightsSnapshotId");

ALTER TABLE "image_reuse_references"
    ADD CONSTRAINT "image_reuse_references_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "image_reuse_references"
    ADD CONSTRAINT "image_reuse_references_projectId_workspaceId_fkey"
    FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "image_reuse_references"
    ADD CONSTRAINT "image_reuse_references_artifactId_workspaceId_fkey"
    FOREIGN KEY ("artifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "image_reuse_references"
    ADD CONSTRAINT "image_reuse_references_manifestId_artifactId_workspaceId_fkey"
    FOREIGN KEY ("manifestId", "artifactId", "workspaceId") REFERENCES "media_artifact_manifests"("id", "artifactId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "image_reuse_references"
    ADD CONSTRAINT "image_reuse_references_mediaAssetReferenceId_fkey"
    FOREIGN KEY ("mediaAssetReferenceId") REFERENCES "project_media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "image_reuse_references"
    ADD CONSTRAINT "image_reuse_references_analysisId_workspaceId_fkey"
    FOREIGN KEY ("analysisId", "workspaceId") REFERENCES "image_analyses"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "image_reuse_references"
    ADD CONSTRAINT "image_reuse_references_rightsSnapshotId_workspaceId_fkey"
    FOREIGN KEY ("rightsSnapshotId", "workspaceId") REFERENCES "asset_rights_snapshots"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
