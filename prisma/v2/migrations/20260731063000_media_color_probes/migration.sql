CREATE TABLE "media_color_probes" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "artifactId" VARCHAR(128) NOT NULL,
  "manifestId" VARCHAR(128) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "state" VARCHAR(16) NOT NULL,
  "metadataJson" TEXT NOT NULL,
  "pixelFormat" VARCHAR(64),
  "hdrMode" VARCHAR(16),
  "reasonsJson" TEXT NOT NULL,
  "producerProvider" VARCHAR(64) NOT NULL,
  "producerVersion" VARCHAR(128) NOT NULL,
  "producerBinaryDigest" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "probeHash" CHAR(64) NOT NULL,

  CONSTRAINT "media_color_probes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "media_color_probes_schema_check"
    CHECK (
      "schemaVersion" = 'media-color-probe/v1' AND
      "producerProvider" = 'ffprobe'
    ),
  CONSTRAINT "media_color_probes_state_check"
    CHECK (
      (
        "state" = 'ready' AND
        "pixelFormat" IS NOT NULL AND
        "hdrMode" IN ('sdr', 'hlg', 'pq') AND
        "metadataJson" <> 'null' AND
        "reasonsJson" = '[]'
      ) OR (
        "state" = 'unavailable' AND
        "hdrMode" IS NULL AND
        "metadataJson" = 'null' AND
        "reasonsJson" <> '[]'
      )
    ),
  CONSTRAINT "media_color_probes_hashes_check"
    CHECK (
      "producerBinaryDigest" ~ '^[a-f0-9]{64}$' AND
      "probeHash" ~ '^[a-f0-9]{64}$'
    )
);

CREATE UNIQUE INDEX "media_color_probes_id_workspaceId_key"
  ON "media_color_probes"("id", "workspaceId");
CREATE UNIQUE INDEX "media_color_probes_workspaceId_artifactId_manifestId_key"
  ON "media_color_probes"("workspaceId", "artifactId", "manifestId");
CREATE UNIQUE INDEX "media_color_probes_workspaceId_probeHash_key"
  ON "media_color_probes"("workspaceId", "probeHash");
CREATE INDEX "media_color_probes_workspaceId_artifactId_state_createdAt_idx"
  ON "media_color_probes"("workspaceId", "artifactId", "state", "createdAt" DESC);
CREATE INDEX "media_color_probes_workspaceId_state_hdrMode_idx"
  ON "media_color_probes"("workspaceId", "state", "hdrMode");

ALTER TABLE "media_color_probes"
  ADD CONSTRAINT "media_color_probes_workspaceId_fkey"
  FOREIGN KEY ("workspaceId")
  REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_color_probes"
  ADD CONSTRAINT "media_color_probes_artifactId_workspaceId_fkey"
  FOREIGN KEY ("artifactId", "workspaceId")
  REFERENCES "media_artifacts"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_color_probes"
  ADD CONSTRAINT "media_color_probes_manifestId_workspaceId_fkey"
  FOREIGN KEY ("manifestId", "workspaceId")
  REFERENCES "media_artifact_manifests"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
