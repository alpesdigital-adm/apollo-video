CREATE TABLE "automatic_catalog_records" (
    "id" VARCHAR(128) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "artifactId" VARCHAR(128) NOT NULL,
    "manifestId" VARCHAR(128) NOT NULL,
    "outputKind" VARCHAR(32) NOT NULL,
    "searchableKind" VARCHAR(16) NOT NULL,
    "segmentId" VARCHAR(128),
    "rightsSnapshotId" VARCHAR(128) NOT NULL,
    "rightsSnapshotHash" CHAR(64) NOT NULL,
    "eligibilityEvidenceHash" CHAR(64) NOT NULL,
    "lineageJson" TEXT NOT NULL,
    "recordHash" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "automatic_catalog_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "automatic_catalog_records_id_workspaceId_key" ON "automatic_catalog_records"("id", "workspaceId");
CREATE UNIQUE INDEX "automatic_catalog_records_workspaceId_artifactId_manifestId_key" ON "automatic_catalog_records"("workspaceId", "artifactId", "manifestId");
CREATE UNIQUE INDEX "automatic_catalog_records_workspaceId_recordHash_key" ON "automatic_catalog_records"("workspaceId", "recordHash");
CREATE INDEX "automatic_catalog_records_workspaceId_outputKind_createdAt_idx" ON "automatic_catalog_records"("workspaceId", "outputKind", "createdAt" DESC);
CREATE INDEX "automatic_catalog_records_workspaceId_segmentId_idx" ON "automatic_catalog_records"("workspaceId", "segmentId");
CREATE INDEX "automatic_catalog_records_workspaceId_rightsSnapshotId_idx" ON "automatic_catalog_records"("workspaceId", "rightsSnapshotId");

ALTER TABLE "automatic_catalog_records" ADD CONSTRAINT "automatic_catalog_records_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "automatic_catalog_records" ADD CONSTRAINT "automatic_catalog_records_artifactId_workspaceId_fkey" FOREIGN KEY ("artifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "automatic_catalog_records" ADD CONSTRAINT "automatic_catalog_manifest_fkey" FOREIGN KEY ("manifestId", "artifactId", "workspaceId") REFERENCES "media_artifact_manifests"("id", "artifactId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "automatic_catalog_records" ADD CONSTRAINT "automatic_catalog_records_segmentId_workspaceId_fkey" FOREIGN KEY ("segmentId", "workspaceId") REFERENCES "media_segments"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "automatic_catalog_records" ADD CONSTRAINT "automatic_catalog_records_rightsSnapshotId_workspaceId_fkey" FOREIGN KEY ("rightsSnapshotId", "workspaceId") REFERENCES "asset_rights_snapshots"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
