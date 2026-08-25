CREATE TABLE "synthetic_audio_masters" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "projectVersionId" VARCHAR(128) NOT NULL,
  "profileSnapshotId" VARCHAR(128) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "sourceKind" VARCHAR(16) NOT NULL,
  "ttsProviderJobId" VARCHAR(128),
  "audioArtifactId" VARCHAR(128) NOT NULL,
  "alignmentEvidenceArtifactId" VARCHAR(128) NOT NULL,
  "durationMs" INTEGER NOT NULL,
  "locale" VARCHAR(35) NOT NULL,
  "wordsHash" CHAR(64) NOT NULL,
  "masterJson" TEXT NOT NULL,
  "masterHash" CHAR(64) NOT NULL,
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
  CONSTRAINT "synthetic_audio_masters_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "synthetic_audio_masters_schema_check" CHECK ("schemaVersion" = 'synthetic-audio-master/v1'),
  CONSTRAINT "synthetic_audio_masters_source_check" CHECK (
    ("sourceKind" = 'tts' AND "ttsProviderJobId" IS NOT NULL) OR
    ("sourceKind" = 'uploaded' AND "ttsProviderJobId" IS NULL)
  ),
  CONSTRAINT "synthetic_audio_masters_duration_check" CHECK ("durationMs" > 0 AND "durationMs" <= 21600000),
  CONSTRAINT "synthetic_audio_masters_json_check" CHECK (jsonb_typeof("masterJson"::jsonb) = 'object')
);

CREATE UNIQUE INDEX "synthetic_audio_masters_id_workspaceId_key"
  ON "synthetic_audio_masters"("id", "workspaceId");
CREATE UNIQUE INDEX "synthetic_audio_masters_workspace_project_actor_key"
  ON "synthetic_audio_masters"("workspaceId", "projectId", "createdByClientId", "actorContextHash", "idempotencyKey");
CREATE INDEX "synthetic_audio_masters_workspace_project_created_idx"
  ON "synthetic_audio_masters"("workspaceId", "projectId", "createdAt" DESC, "id" DESC);
CREATE INDEX "synthetic_audio_masters_workspace_version_idx"
  ON "synthetic_audio_masters"("workspaceId", "projectVersionId");
CREATE INDEX "synthetic_audio_masters_workspace_profile_idx"
  ON "synthetic_audio_masters"("workspaceId", "profileSnapshotId");
CREATE INDEX "synthetic_audio_masters_workspace_audio_idx"
  ON "synthetic_audio_masters"("workspaceId", "audioArtifactId");
CREATE INDEX "synthetic_audio_masters_workspace_hash_idx"
  ON "synthetic_audio_masters"("workspaceId", "masterHash");

ALTER TABLE "synthetic_audio_masters" ADD CONSTRAINT "synthetic_audio_masters_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_audio_masters" ADD CONSTRAINT "synthetic_audio_masters_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "synthetic_audio_masters" ADD CONSTRAINT "synthetic_audio_masters_projectVersionId_projectId_workspa_fkey"
  FOREIGN KEY ("projectVersionId", "projectId", "workspaceId") REFERENCES "project_versions"("id", "projectId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_audio_masters" ADD CONSTRAINT "synthetic_audio_masters_profileSnapshotId_workspaceId_fkey"
  FOREIGN KEY ("profileSnapshotId", "workspaceId") REFERENCES "synthetic_presenter_profiles"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_audio_masters" ADD CONSTRAINT "synthetic_audio_masters_ttsProviderJobId_workspaceId_fkey"
  FOREIGN KEY ("ttsProviderJobId", "workspaceId") REFERENCES "provider_jobs"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_audio_masters" ADD CONSTRAINT "synthetic_audio_masters_audioArtifactId_workspaceId_fkey"
  FOREIGN KEY ("audioArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_audio_masters" ADD CONSTRAINT "synthetic_audio_masters_alignmentEvidenceArtifactId_worksp_fkey"
  FOREIGN KEY ("alignmentEvidenceArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_audio_masters" ADD CONSTRAINT "synthetic_audio_masters_createdByClientId_workspaceId_fkey"
  FOREIGN KEY ("createdByClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
