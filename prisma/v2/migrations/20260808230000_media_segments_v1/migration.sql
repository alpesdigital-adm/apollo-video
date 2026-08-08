CREATE TABLE "media_segments" (
  "id" VARCHAR(128) NOT NULL, "workspaceId" VARCHAR(128) NOT NULL, "artifactId" VARCHAR(128) NOT NULL,
  "parentSegmentId" VARCHAR(128), "label" VARCHAR(240) NOT NULL, "description" VARCHAR(1000) NOT NULL DEFAULT '',
  "startMs" INTEGER NOT NULL, "endMs" INTEGER NOT NULL, "sourceDurationMs" INTEGER NOT NULL,
  "physicalObjectKey" VARCHAR(512), "segmentHash" CHAR(64) NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "media_segments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "media_segments_range_check" CHECK ("startMs" >= 0 AND "endMs" > "startMs" AND "endMs" <= "sourceDurationMs"),
  CONSTRAINT "media_segments_virtual_check" CHECK ("physicalObjectKey" IS NULL)
);
CREATE UNIQUE INDEX "media_segments_id_workspaceId_key" ON "media_segments"("id", "workspaceId");
CREATE UNIQUE INDEX "media_segments_workspaceId_artifactId_segmentHash_key" ON "media_segments"("workspaceId", "artifactId", "segmentHash");
CREATE INDEX "media_segments_workspaceId_artifactId_startMs_endMs_idx" ON "media_segments"("workspaceId", "artifactId", "startMs", "endMs");
CREATE INDEX "media_segments_workspaceId_parentSegmentId_idx" ON "media_segments"("workspaceId", "parentSegmentId");
ALTER TABLE "media_segments" ADD CONSTRAINT "media_segments_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_segments" ADD CONSTRAINT "media_segments_artifactId_workspaceId_fkey" FOREIGN KEY ("artifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_segments" ADD CONSTRAINT "media_segments_parentSegmentId_workspaceId_fkey" FOREIGN KEY ("parentSegmentId", "workspaceId") REFERENCES "media_segments"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "media_segment_materializations" (
  "id" VARCHAR(128) NOT NULL, "workspaceId" VARCHAR(128) NOT NULL, "segmentId" VARCHAR(128) NOT NULL,
  "consumerKey" VARCHAR(80) NOT NULL, "recipe" VARCHAR(64) NOT NULL, "outputArtifactId" VARCHAR(128) NOT NULL,
  "outputManifestId" VARCHAR(128) NOT NULL, "sourceArtifactSha256" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "media_segment_materializations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "media_segment_materializations_id_workspaceId_key" ON "media_segment_materializations"("id", "workspaceId");
CREATE UNIQUE INDEX "media_segment_materializations_workspaceId_segmentId_consum_key" ON "media_segment_materializations"("workspaceId", "segmentId", "consumerKey");
CREATE UNIQUE INDEX "media_segment_materializations_outputArtifactId_workspaceId_key" ON "media_segment_materializations"("outputArtifactId", "workspaceId");
CREATE UNIQUE INDEX "media_segment_materializations_outputManifestId_workspaceId_key" ON "media_segment_materializations"("outputManifestId", "workspaceId");
CREATE INDEX "media_segment_materializations_workspaceId_segmentId_create_idx" ON "media_segment_materializations"("workspaceId", "segmentId", "createdAt" DESC);
ALTER TABLE "media_segment_materializations" ADD CONSTRAINT "media_segment_materializations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_segment_materializations" ADD CONSTRAINT "media_segment_materializations_segmentId_workspaceId_fkey" FOREIGN KEY ("segmentId", "workspaceId") REFERENCES "media_segments"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_segment_materializations" ADD CONSTRAINT "media_segment_materializations_outputArtifactId_workspaceI_fkey" FOREIGN KEY ("outputArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_segment_materializations" ADD CONSTRAINT "media_segment_materializations_outputManifestId_workspaceI_fkey" FOREIGN KEY ("outputManifestId", "workspaceId") REFERENCES "media_artifact_manifests"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
