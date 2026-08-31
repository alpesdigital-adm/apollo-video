-- Reusable synthetic sentences catalogued from a sealed master.
--
-- This is not `speech_segments`: that table describes speech extracted from
-- ingested real media and requires a catalog run, a media transcript and an
-- extracted complete-thought score. A synthetic sentence has none of those —
-- reusing it would mean fabricating a transcript and a catalog run that never
-- happened. The attribute ontology (exact/normalized text, half-open range,
-- emotion, wardrobe, setting, framing) is deliberately identical so both
-- catalogs answer the same questions.

CREATE TABLE "synthetic_speech_segments" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "masterId" VARCHAR(128) NOT NULL,
  "masterHash" CHAR(64) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "blockId" VARCHAR(128) NOT NULL,
  "occurrence" INTEGER NOT NULL,
  "sequence" INTEGER NOT NULL,
  "audioArtifactId" VARCHAR(128) NOT NULL,
  "videoArtifactId" VARCHAR(128) NOT NULL,
  "alignmentArtifactId" VARCHAR(128) NOT NULL,
  "exactText" TEXT NOT NULL,
  "normalizedText" TEXT NOT NULL,
  "scriptHash" CHAR(64) NOT NULL,
  "wordsJson" TEXT NOT NULL,
  "startMs" INTEGER NOT NULL,
  "endMs" INTEGER NOT NULL,
  "locale" VARCHAR(35) NOT NULL,
  "actorIdentityId" VARCHAR(128) NOT NULL,
  "profileId" VARCHAR(128) NOT NULL,
  "profileVersion" INTEGER NOT NULL,
  "voiceId" VARCHAR(128) NOT NULL,
  "voiceVersion" INTEGER NOT NULL,
  "avatarIdentityRef" VARCHAR(128) NOT NULL,
  "emotionNormalized" VARCHAR(240),
  "wardrobeNormalized" VARCHAR(240),
  "settingNormalized" VARCHAR(240),
  "framingNormalized" VARCHAR(240),
  "consentSnapshotHash" CHAR(64) NOT NULL,
  "rightsSnapshotId" VARCHAR(128),
  "criticReportId" VARCHAR(128) NOT NULL,
  "criticReportHash" CHAR(64) NOT NULL,
  "segmentHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "synthetic_speech_segments_pkey" PRIMARY KEY ("id"),
  -- Half-open range inside the master timeline.
  CONSTRAINT "synthetic_speech_segments_range_check" CHECK ("startMs" >= 0 AND "endMs" > "startMs"),
  CONSTRAINT "synthetic_speech_segments_order_check" CHECK ("sequence" >= 0 AND "occurrence" >= 1)
);

CREATE UNIQUE INDEX "synthetic_speech_segments_id_workspace_key"
  ON "synthetic_speech_segments"("id", "workspaceId");
-- One row per approved block occurrence of a master, and one per content address.
CREATE UNIQUE INDEX "synthetic_speech_segments_master_block_key"
  ON "synthetic_speech_segments"("masterId", "blockId", "occurrence");
CREATE UNIQUE INDEX "synthetic_speech_segments_master_sequence_key"
  ON "synthetic_speech_segments"("masterId", "sequence");
CREATE UNIQUE INDEX "synthetic_speech_segments_master_hash_key"
  ON "synthetic_speech_segments"("masterId", "segmentHash");

CREATE INDEX "synthetic_speech_segments_workspace_project_created_idx"
  ON "synthetic_speech_segments"("workspaceId", "projectId", "createdAt" DESC);
CREATE INDEX "synthetic_speech_segments_workspace_script_idx"
  ON "synthetic_speech_segments"("workspaceId", "scriptHash");
CREATE INDEX "synthetic_speech_segments_workspace_profile_idx"
  ON "synthetic_speech_segments"("workspaceId", "profileId", "profileVersion");
CREATE INDEX "synthetic_speech_segments_workspace_locale_idx"
  ON "synthetic_speech_segments"("workspaceId", "locale");
CREATE INDEX "synthetic_speech_segments_workspace_emotion_idx"
  ON "synthetic_speech_segments"("workspaceId", "emotionNormalized");
CREATE INDEX "synthetic_speech_segments_workspace_wardrobe_idx"
  ON "synthetic_speech_segments"("workspaceId", "wardrobeNormalized");
CREATE INDEX "synthetic_speech_segments_workspace_setting_idx"
  ON "synthetic_speech_segments"("workspaceId", "settingNormalized");
CREATE INDEX "synthetic_speech_segments_workspace_audio_idx"
  ON "synthetic_speech_segments"("workspaceId", "audioArtifactId", "startMs");

ALTER TABLE "synthetic_speech_segments" ADD CONSTRAINT "synthetic_speech_segments_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_speech_segments" ADD CONSTRAINT "synthetic_speech_segments_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "synthetic_speech_segments" ADD CONSTRAINT "synthetic_speech_segments_masterId_workspaceId_fkey"
  FOREIGN KEY ("masterId", "workspaceId") REFERENCES "synthetic_master_assets"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "synthetic_speech_segments" ADD CONSTRAINT "synthetic_speech_segments_audioArtifactId_workspaceId_fkey"
  FOREIGN KEY ("audioArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_speech_segments" ADD CONSTRAINT "synthetic_speech_segments_videoArtifactId_workspaceId_fkey"
  FOREIGN KEY ("videoArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
