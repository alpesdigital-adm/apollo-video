-- FR-175 — immutable SRT/VTT sidecars derived from the alignment that was
-- actually rendered. One row per (workspace, lineage): the lineage hash covers
-- the ProjectVersion, the variant, the rendered MP4, the RenderInput, the cue
-- alignment map, the format and the locale, so the same derivation can never
-- produce two different rows.
CREATE TABLE "project_subtitle_sidecars" (
  "id" VARCHAR(128) PRIMARY KEY,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "projectVersionId" VARCHAR(128) NOT NULL,
  "variantId" VARCHAR(128) NOT NULL,
  "outputKind" VARCHAR(16) NOT NULL,
  "outputArtifactId" VARCHAR(128) NOT NULL,
  "outputManifestId" VARCHAR(128) NOT NULL,
  "outputSha256" CHAR(64) NOT NULL,
  "format" VARCHAR(8) NOT NULL,
  "locale" VARCHAR(32) NOT NULL,
  "artifactId" VARCHAR(128) NOT NULL,
  "manifestId" VARCHAR(128) NOT NULL,
  "artifactKey" VARCHAR(512) NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "encoding" VARCHAR(32) NOT NULL,
  "cueCount" INTEGER NOT NULL,
  "lineageHash" CHAR(64) NOT NULL,
  "renderElementMapHash" CHAR(64) NOT NULL,
  "renderInputHash" CHAR(64) NOT NULL,
  "editPlanSnapshotId" VARCHAR(128) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_subtitle_sidecars_format_check" CHECK ("format" IN ('srt','vtt')),
  CONSTRAINT "project_subtitle_sidecars_output_kind_check" CHECK ("outputKind" IN ('proxy','final')),
  CONSTRAINT "project_subtitle_sidecars_encoding_check" CHECK ("encoding" = 'utf-8-bom'),
  CONSTRAINT "project_subtitle_sidecars_byte_size_check" CHECK ("byteSize" > 0),
  CONSTRAINT "project_subtitle_sidecars_cue_count_check" CHECK ("cueCount" > 0)
);

CREATE UNIQUE INDEX "project_subtitle_sidecars_id_workspaceId_key" ON "project_subtitle_sidecars"("id","workspaceId");
CREATE UNIQUE INDEX "project_subtitle_sidecars_workspaceId_lineageHash_key" ON "project_subtitle_sidecars"("workspaceId","lineageHash");
CREATE UNIQUE INDEX "project_subtitle_sidecars_workspaceId_projectId_idempotency_key" ON "project_subtitle_sidecars"("workspaceId","projectId","idempotencyKey");
CREATE INDEX "project_subtitle_sidecars_workspaceId_projectId_projectVers_idx" ON "project_subtitle_sidecars"("workspaceId","projectId","projectVersionId","variantId","createdAt" DESC);
CREATE INDEX "project_subtitle_sidecars_workspaceId_artifactId_idx" ON "project_subtitle_sidecars"("workspaceId","artifactId");

ALTER TABLE "project_subtitle_sidecars" ADD CONSTRAINT "project_subtitle_sidecars_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_subtitle_sidecars" ADD CONSTRAINT "project_subtitle_sidecars_projectId_workspaceId_fkey" FOREIGN KEY ("projectId","workspaceId") REFERENCES "projects"("id","workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_subtitle_sidecars" ADD CONSTRAINT "project_subtitle_sidecars_projectVersionId_workspaceId_fkey" FOREIGN KEY ("projectVersionId","workspaceId") REFERENCES "project_versions"("id","workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_subtitle_sidecars" ADD CONSTRAINT "project_subtitle_sidecars_outputArtifactId_workspaceId_fkey" FOREIGN KEY ("outputArtifactId","workspaceId") REFERENCES "media_artifacts"("id","workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_subtitle_sidecars" ADD CONSTRAINT "project_subtitle_sidecars_artifactId_workspaceId_fkey" FOREIGN KEY ("artifactId","workspaceId") REFERENCES "media_artifacts"("id","workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
