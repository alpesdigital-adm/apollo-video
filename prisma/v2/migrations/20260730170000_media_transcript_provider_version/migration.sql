ALTER TABLE "media_transcripts"
  ADD COLUMN "providerVersion" VARCHAR(128) NOT NULL DEFAULT 'legacy';

ALTER TABLE "media_transcripts"
  ADD CONSTRAINT "media_transcripts_provider_version_check"
  CHECK (
    "providerVersion" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
  );

CREATE INDEX "media_transcripts_workspaceId_sourceArtifactId_provider_mod_idx"
  ON "media_transcripts"(
    "workspaceId",
    "sourceArtifactId",
    "provider",
    "model",
    "providerVersion"
  );
