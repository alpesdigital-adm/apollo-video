CREATE UNIQUE INDEX "media_transcripts_id_workspaceId_key"
  ON "media_transcripts"("id", "workspaceId");

CREATE TABLE "speech_segment_catalog_runs" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "sourceTranscriptId" VARCHAR(128) NOT NULL,
  "sourceTranscriptHash" CHAR(64) NOT NULL,
  "sourceArtifactId" VARCHAR(128) NOT NULL,
  "extractionPolicyVersion" VARCHAR(64) NOT NULL,
  "producerJson" TEXT NOT NULL,
  "annotationsJson" TEXT NOT NULL,
  "annotationsHash" CHAR(64) NOT NULL,
  "segmentCount" INTEGER NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "recordHash" CHAR(64) NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdByType" VARCHAR(32) NOT NULL,
  "createdById" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "speech_segment_catalog_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "speech_segment_catalog_runs_hashes_check" CHECK (
    "sourceTranscriptHash" ~ '^[a-f0-9]{64}$'
    AND "annotationsHash" ~ '^[a-f0-9]{64}$'
    AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
    AND "recordHash" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "speech_segment_catalog_runs_policy_check" CHECK (
    "extractionPolicyVersion" = 'speech-segment-extraction/v1'
  ),
  CONSTRAINT "speech_segment_catalog_runs_actor_check" CHECK (
    "createdByType" = 'api-client'
  ),
  CONSTRAINT "speech_segment_catalog_runs_bounds_check" CHECK (
    "segmentCount" BETWEEN 1 AND 100000
    AND length("producerJson") BETWEEN 2 AND 10000
    AND length("annotationsJson") BETWEEN 2 AND 10000000
  )
);

CREATE UNIQUE INDEX "speech_segment_catalog_runs_id_workspaceId_key"
  ON "speech_segment_catalog_runs"("id", "workspaceId");
CREATE UNIQUE INDEX "speech_segment_catalog_runs_workspaceId_projectId_idempoten_key"
  ON "speech_segment_catalog_runs"(
    "workspaceId",
    "projectId",
    "idempotencyKey"
  );
CREATE UNIQUE INDEX "speech_segment_catalog_runs_one_active_transcript_key"
  ON "speech_segment_catalog_runs"(
    "workspaceId",
    "projectId",
    "sourceTranscriptId"
  )
  WHERE "active" = TRUE;
CREATE INDEX "speech_segment_catalog_runs_workspaceId_projectId_active_cr_idx"
  ON "speech_segment_catalog_runs"(
    "workspaceId",
    "projectId",
    "active",
    "createdAt" DESC
  );
CREATE INDEX "speech_segment_catalog_runs_workspaceId_sourceTranscriptId__idx"
  ON "speech_segment_catalog_runs"(
    "workspaceId",
    "sourceTranscriptId",
    "active",
    "createdAt" DESC
  );
CREATE INDEX "speech_segment_catalog_runs_workspaceId_sourceArtifactId_ac_idx"
  ON "speech_segment_catalog_runs"(
    "workspaceId",
    "sourceArtifactId",
    "active"
  );

CREATE TABLE "speech_segments" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "catalogRunId" VARCHAR(128) NOT NULL,
  "sourceTranscriptId" VARCHAR(128) NOT NULL,
  "sourceTranscriptHash" CHAR(64) NOT NULL,
  "sourceArtifactId" VARCHAR(128) NOT NULL,
  "sourceSegmentId" INTEGER NOT NULL,
  "exactText" TEXT NOT NULL,
  "normalizedText" TEXT NOT NULL,
  "wordsJson" TEXT NOT NULL,
  "speakerJson" TEXT NOT NULL,
  "speakerId" VARCHAR(240) NOT NULL,
  "speakerNormalized" VARCHAR(240) NOT NULL,
  "startMs" INTEGER NOT NULL,
  "endMs" INTEGER NOT NULL,
  "completeThoughtScore" DOUBLE PRECISION NOT NULL,
  "classification" VARCHAR(32) NOT NULL,
  "visualJson" TEXT NOT NULL,
  "emotionNormalized" VARCHAR(240),
  "expressionNormalized" VARCHAR(240),
  "wardrobeNormalized" VARCHAR(240),
  "settingNormalized" VARCHAR(240),
  "colorsNormalized" TEXT NOT NULL,
  "intentionsJson" TEXT NOT NULL,
  "intentionsNormalized" TEXT NOT NULL,
  "extractionProvenanceJson" TEXT NOT NULL,
  "extractionPolicyVersion" VARCHAR(64) NOT NULL,
  "physicalMaterialized" BOOLEAN NOT NULL DEFAULT FALSE,
  "segmentHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "speech_segments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "speech_segments_virtual_check" CHECK (
    "physicalMaterialized" = FALSE
  ),
  CONSTRAINT "speech_segments_range_check" CHECK (
    "sourceSegmentId" >= 0
    AND "startMs" >= 0
    AND "endMs" > "startMs"
  ),
  CONSTRAINT "speech_segments_score_check" CHECK (
    "completeThoughtScore" BETWEEN 0 AND 1
  ),
  CONSTRAINT "speech_segments_classification_check" CHECK (
    "classification" IN (
      'complete-thought',
      'incomplete',
      'interrupted'
    )
  ),
  CONSTRAINT "speech_segments_policy_check" CHECK (
    "extractionPolicyVersion" = 'speech-segment-extraction/v1'
  ),
  CONSTRAINT "speech_segments_hash_check" CHECK (
    "sourceTranscriptHash" ~ '^[a-f0-9]{64}$'
    AND "segmentHash" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "speech_segments_text_check" CHECK (
    length("exactText") BETWEEN 1 AND 10000
    AND length("normalizedText") BETWEEN 1 AND 10000
    AND length("wordsJson") BETWEEN 2 AND 1000000
    AND length("speakerJson") BETWEEN 2 AND 10000
    AND length("visualJson") BETWEEN 2 AND 100000
    AND length("intentionsJson") BETWEEN 2 AND 100000
    AND length("extractionProvenanceJson") BETWEEN 2 AND 10000
  )
);

CREATE UNIQUE INDEX "speech_segments_id_workspaceId_key"
  ON "speech_segments"("id", "workspaceId");
CREATE UNIQUE INDEX "speech_segments_catalogRunId_sourceSegmentId_key"
  ON "speech_segments"("catalogRunId", "sourceSegmentId");
CREATE UNIQUE INDEX "speech_segments_catalogRunId_segmentHash_key"
  ON "speech_segments"("catalogRunId", "segmentHash");
CREATE INDEX "speech_segments_workspaceId_projectId_createdAt_idx"
  ON "speech_segments"("workspaceId", "projectId", "createdAt" DESC);
CREATE INDEX "speech_segments_workspaceId_catalogRunId_sourceSegmentId_idx"
  ON "speech_segments"("workspaceId", "catalogRunId", "sourceSegmentId");
CREATE INDEX "speech_segments_workspaceId_sourceArtifactId_startMs_idx"
  ON "speech_segments"("workspaceId", "sourceArtifactId", "startMs");
CREATE INDEX "speech_segments_workspaceId_speakerNormalized_idx"
  ON "speech_segments"("workspaceId", "speakerNormalized");
CREATE INDEX "speech_segments_workspaceId_classification_completeThoughtS_idx"
  ON "speech_segments"(
    "workspaceId",
    "classification",
    "completeThoughtScore" DESC
  );
CREATE INDEX "speech_segments_workspaceId_emotionNormalized_idx"
  ON "speech_segments"("workspaceId", "emotionNormalized");
CREATE INDEX "speech_segments_workspaceId_wardrobeNormalized_idx"
  ON "speech_segments"("workspaceId", "wardrobeNormalized");
CREATE INDEX "speech_segments_workspaceId_settingNormalized_idx"
  ON "speech_segments"("workspaceId", "settingNormalized");

ALTER TABLE "speech_segment_catalog_runs"
  ADD CONSTRAINT "speech_segment_catalog_runs_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "speech_segment_catalog_runs"
  ADD CONSTRAINT "speech_segment_catalog_runs_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "speech_segment_catalog_runs"
  ADD CONSTRAINT "speech_segment_catalog_runs_sourceTranscriptId_workspaceId_fkey"
  FOREIGN KEY ("sourceTranscriptId", "workspaceId")
  REFERENCES "media_transcripts"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "speech_segment_catalog_runs"
  ADD CONSTRAINT "speech_segment_catalog_runs_sourceArtifactId_workspaceId_fkey"
  FOREIGN KEY ("sourceArtifactId", "workspaceId")
  REFERENCES "media_artifacts"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "speech_segment_catalog_runs"
  ADD CONSTRAINT "speech_segment_catalog_runs_createdById_workspaceId_fkey"
  FOREIGN KEY ("createdById", "workspaceId")
  REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "speech_segments"
  ADD CONSTRAINT "speech_segments_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "speech_segments"
  ADD CONSTRAINT "speech_segments_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "speech_segments"
  ADD CONSTRAINT "speech_segments_catalogRunId_workspaceId_fkey"
  FOREIGN KEY ("catalogRunId", "workspaceId")
  REFERENCES "speech_segment_catalog_runs"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "speech_segments"
  ADD CONSTRAINT "speech_segments_sourceTranscriptId_workspaceId_fkey"
  FOREIGN KEY ("sourceTranscriptId", "workspaceId")
  REFERENCES "media_transcripts"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "speech_segments"
  ADD CONSTRAINT "speech_segments_sourceArtifactId_workspaceId_fkey"
  FOREIGN KEY ("sourceArtifactId", "workspaceId")
  REFERENCES "media_artifacts"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
