CREATE TABLE "image_analyses" (
  "id" VARCHAR(128) NOT NULL, "workspaceId" VARCHAR(128) NOT NULL, "artifactId" VARCHAR(128) NOT NULL,
  "manifestId" VARCHAR(128) NOT NULL, "sourceSha256" CHAR(64) NOT NULL, "analysisJson" TEXT NOT NULL,
  "analysisHash" CHAR(64) NOT NULL, "thumbnailArtifactId" VARCHAR(128) NOT NULL, "previewArtifactId" VARCHAR(128) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "image_analyses_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "image_analyses_id_workspaceId_key" ON "image_analyses"("id", "workspaceId");
CREATE UNIQUE INDEX "image_analyses_workspaceId_artifactId_manifestId_key" ON "image_analyses"("workspaceId", "artifactId", "manifestId");
CREATE UNIQUE INDEX "image_analyses_thumbnailArtifactId_workspaceId_key" ON "image_analyses"("thumbnailArtifactId", "workspaceId");
CREATE UNIQUE INDEX "image_analyses_previewArtifactId_workspaceId_key" ON "image_analyses"("previewArtifactId", "workspaceId");
CREATE INDEX "image_analyses_workspaceId_createdAt_idx" ON "image_analyses"("workspaceId", "createdAt" DESC);
ALTER TABLE "image_analyses" ADD CONSTRAINT "image_analyses_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "image_analyses" ADD CONSTRAINT "image_analyses_artifactId_workspaceId_fkey" FOREIGN KEY ("artifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "image_analyses" ADD CONSTRAINT "image_analyses_manifestId_artifactId_workspaceId_fkey" FOREIGN KEY ("manifestId", "artifactId", "workspaceId") REFERENCES "media_artifact_manifests"("id", "artifactId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "image_analyses" ADD CONSTRAINT "image_analyses_thumbnailArtifactId_workspaceId_fkey" FOREIGN KEY ("thumbnailArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "image_analyses" ADD CONSTRAINT "image_analyses_previewArtifactId_workspaceId_fkey" FOREIGN KEY ("previewArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
