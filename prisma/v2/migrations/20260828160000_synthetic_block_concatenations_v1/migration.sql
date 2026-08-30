-- A consolidated audio master may now originate from a deterministic
-- concatenation of approved block audio; it never carries a single TTS job.
ALTER TABLE "synthetic_audio_masters" DROP CONSTRAINT "synthetic_audio_masters_source_check";
ALTER TABLE "synthetic_audio_masters" ADD CONSTRAINT "synthetic_audio_masters_source_check" CHECK (
  ("sourceKind" = 'tts' AND "ttsProviderJobId" IS NOT NULL) OR
  ("sourceKind" IN ('uploaded', 'concatenated') AND "ttsProviderJobId" IS NULL)
);

CREATE TABLE "synthetic_block_concatenations" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "planId" VARCHAR(128) NOT NULL,
  "planVersionId" VARCHAR(128) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "container" VARCHAR(8) NOT NULL,
  "codec" VARCHAR(16) NOT NULL,
  "sampleRate" INTEGER NOT NULL,
  "channels" INTEGER NOT NULL,
  "gapMs" INTEGER NOT NULL,
  "durationMs" INTEGER NOT NULL,
  "settingsJson" TEXT NOT NULL,
  "manifestJson" TEXT NOT NULL,
  "concatHash" CHAR(64) NOT NULL,
  "audioArtifactId" VARCHAR(128) NOT NULL,
  "alignmentArtifactId" VARCHAR(128) NOT NULL,
  "finalAudioSha256" CHAR(64) NOT NULL,
  "audioMasterId" VARCHAR(128),
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "actorCredentialId" VARCHAR(128),
  "actorEnvironment" VARCHAR(16),
  "actorAuthenticationKind" VARCHAR(16),
  "actorContextHash" CHAR(64),
  "delegatedUserId" VARCHAR(128),
  "delegatedIdentityId" VARCHAR(128),
  "workspaceRole" VARCHAR(32),
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "synthetic_block_concatenations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "synthetic_block_concatenations_schema_check" CHECK ("schemaVersion" = 'synthetic-block-concatenation/v1'),
  CONSTRAINT "synthetic_block_concatenations_container_check" CHECK ("container" IN ('mp3', 'wav')),
  CONSTRAINT "synthetic_block_concatenations_stream_check" CHECK (
    "sampleRate" > 0 AND "channels" >= 1 AND "channels" <= 2 AND
    "gapMs" >= 0 AND "gapMs" <= 10000 AND "durationMs" > 0 AND "durationMs" <= 21600000
  ),
  CONSTRAINT "synthetic_block_concatenations_hash_check" CHECK (
    "concatHash" ~ '^[a-f0-9]{64}$' AND "finalAudioSha256" ~ '^[a-f0-9]{64}$' AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "synthetic_block_concatenations_manifest_check" CHECK (jsonb_typeof("manifestJson"::jsonb) = 'array'),
  CONSTRAINT "synthetic_block_concatenations_settings_check" CHECK (jsonb_typeof("settingsJson"::jsonb) = 'object')
);

CREATE UNIQUE INDEX "synthetic_block_concatenations_id_workspaceId_key"
  ON "synthetic_block_concatenations"("id", "workspaceId");
CREATE UNIQUE INDEX "synthetic_block_concatenations_actor_key"
  ON "synthetic_block_concatenations"("workspaceId", "planId", "createdByClientId", "actorContextHash", "idempotencyKey");
CREATE INDEX "synthetic_block_concatenations_plan_created_idx"
  ON "synthetic_block_concatenations"("workspaceId", "planId", "createdAt" DESC);
CREATE INDEX "synthetic_block_concatenations_version_idx"
  ON "synthetic_block_concatenations"("workspaceId", "planVersionId");

ALTER TABLE "synthetic_block_concatenations" ADD CONSTRAINT "synthetic_block_concatenations_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_block_concatenations" ADD CONSTRAINT "synthetic_block_concatenations_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "synthetic_block_concatenations" ADD CONSTRAINT "synthetic_block_concatenations_planId_workspaceId_fkey"
  FOREIGN KEY ("planId", "workspaceId") REFERENCES "synthetic_script_plans"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "synthetic_block_concatenations" ADD CONSTRAINT "synthetic_block_concatenations_planVersionId_planId_worksp_fkey"
  FOREIGN KEY ("planVersionId", "planId", "workspaceId") REFERENCES "synthetic_script_plan_versions"("id", "planId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_block_concatenations" ADD CONSTRAINT "synthetic_block_concatenations_audioArtifactId_workspaceId_fkey"
  FOREIGN KEY ("audioArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_block_concatenations" ADD CONSTRAINT "synthetic_block_concatenations_alignmentArtifactId_workspa_fkey"
  FOREIGN KEY ("alignmentArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_block_concatenations" ADD CONSTRAINT "synthetic_block_concatenations_audioMasterId_workspaceId_fkey"
  FOREIGN KEY ("audioMasterId", "workspaceId") REFERENCES "synthetic_audio_masters"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_block_concatenations" ADD CONSTRAINT "synthetic_block_concatenations_createdByClientId_workspace_fkey"
  FOREIGN KEY ("createdByClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
