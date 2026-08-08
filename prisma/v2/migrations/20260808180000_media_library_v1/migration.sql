CREATE TABLE "media_library_entries" (
    "artifactId" VARCHAR(128) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "label" VARCHAR(240) NOT NULL,
    "peopleJson" TEXT NOT NULL DEFAULT '[]',
    "peopleSearch" TEXT NOT NULL DEFAULT E'\n',
    "topicsJson" TEXT NOT NULL DEFAULT '[]',
    "topicsSearch" TEXT NOT NULL DEFAULT E'\n',
    "originType" VARCHAR(16) NOT NULL,
    "parentArtifactId" VARCHAR(128),
    "thumbnailArtifactId" VARCHAR(128),
    "waveformArtifactId" VARCHAR(128),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "media_library_entries_pkey" PRIMARY KEY ("artifactId")
);

CREATE UNIQUE INDEX "media_library_entries_artifactId_workspaceId_key" ON "media_library_entries"("artifactId", "workspaceId");
CREATE INDEX "media_library_entries_workspaceId_createdAt_artifactId_idx" ON "media_library_entries"("workspaceId", "createdAt" DESC, "artifactId" DESC);
CREATE INDEX "media_library_entries_workspaceId_originType_createdAt_idx" ON "media_library_entries"("workspaceId", "originType", "createdAt" DESC);
CREATE INDEX "media_library_entries_workspaceId_parentArtifactId_idx" ON "media_library_entries"("workspaceId", "parentArtifactId");
CREATE INDEX "media_library_entries_workspaceId_thumbnailArtifactId_idx" ON "media_library_entries"("workspaceId", "thumbnailArtifactId");
CREATE INDEX "media_library_entries_workspaceId_waveformArtifactId_idx" ON "media_library_entries"("workspaceId", "waveformArtifactId");

ALTER TABLE "media_library_entries" ADD CONSTRAINT "media_library_entries_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_library_entries" ADD CONSTRAINT "media_library_entries_artifactId_workspaceId_fkey" FOREIGN KEY ("artifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "media_library_entries" ADD CONSTRAINT "media_library_entries_parentArtifactId_workspaceId_fkey" FOREIGN KEY ("parentArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_library_entries" ADD CONSTRAINT "media_library_entries_thumbnailArtifactId_workspaceId_fkey" FOREIGN KEY ("thumbnailArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_library_entries" ADD CONSTRAINT "media_library_entries_waveformArtifactId_workspaceId_fkey" FOREIGN KEY ("waveformArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
