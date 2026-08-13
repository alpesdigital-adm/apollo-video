CREATE TABLE "editorial_beat_sets" (
  "id" VARCHAR(128) NOT NULL, "workspaceId" VARCHAR(128) NOT NULL, "projectId" VARCHAR(128) NOT NULL,
  "projectVersionId" VARCHAR(128) NOT NULL, "transcriptId" VARCHAR(128) NOT NULL, "transcriptHash" CHAR(64) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL, "derivationVersion" VARCHAR(64) NOT NULL, "pauseBoundaryMs" INTEGER NOT NULL,
  "maxDurationMs" INTEGER NOT NULL, "wordsJson" TEXT NOT NULL, "wordsHash" CHAR(64) NOT NULL, "signalsJson" TEXT NOT NULL,
  "signalsHash" CHAR(64) NOT NULL, "beatsJson" TEXT NOT NULL, "beatsHash" CHAR(64) NOT NULL, "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL, "actorClientId" VARCHAR(80) NOT NULL, "actorCredentialId" VARCHAR(128) NOT NULL,
  "actorEnvironment" VARCHAR(16) NOT NULL, "actorAuthenticationKind" VARCHAR(16) NOT NULL, "actorContextHash" CHAR(64) NOT NULL,
  "actorDelegatedUserId" VARCHAR(128), "actorDelegatedIdentityId" VARCHAR(128), "actorWorkspaceRole" VARCHAR(32),
  "createdAt" TIMESTAMPTZ(3) NOT NULL, "recordHash" CHAR(64) NOT NULL, CONSTRAINT "editorial_beat_sets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "editorial_beat_sets_id_workspaceId_key" ON "editorial_beat_sets"("id", "workspaceId");
CREATE UNIQUE INDEX "editorial_beat_sets_idempotency_key" ON "editorial_beat_sets"("workspaceId", "projectId", "actorClientId", "idempotencyKey");
CREATE INDEX "editorial_beat_sets_workspaceId_projectId_createdAt_idx" ON "editorial_beat_sets"("workspaceId", "projectId", "createdAt" DESC);
CREATE INDEX "editorial_beat_sets_version_transcript_idx" ON "editorial_beat_sets"("workspaceId", "projectVersionId", "transcriptId");
CREATE INDEX "editorial_beat_sets_workspaceId_actorContextHash_createdAt_idx" ON "editorial_beat_sets"("workspaceId", "actorContextHash", "createdAt" DESC);
ALTER TABLE "editorial_beat_sets" ADD CONSTRAINT "editorial_beat_sets_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "editorial_beat_sets" ADD CONSTRAINT "editorial_beat_sets_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "editorial_beat_sets" ADD CONSTRAINT "editorial_beat_sets_projectVersionId_projectId_workspaceId_fkey" FOREIGN KEY ("projectVersionId", "projectId", "workspaceId") REFERENCES "project_versions"("id", "projectId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "editorial_beat_sets" ADD CONSTRAINT "editorial_beat_sets_transcriptId_workspaceId_fkey" FOREIGN KEY ("transcriptId", "workspaceId") REFERENCES "media_transcripts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "editorial_beat_sets" ADD CONSTRAINT "editorial_beat_sets_actorClientId_workspaceId_fkey" FOREIGN KEY ("actorClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "editorial_beat_adjustments" (
  "id" VARCHAR(128) NOT NULL, "workspaceId" VARCHAR(128) NOT NULL, "projectId" VARCHAR(128) NOT NULL, "beatSetId" VARCHAR(128) NOT NULL,
  "sourceBeatId" VARCHAR(128) NOT NULL, "directorRunId" VARCHAR(128) NOT NULL, "schemaVersion" VARCHAR(64) NOT NULL,
  "reason" VARCHAR(500) NOT NULL, "startWordId" VARCHAR(128) NOT NULL, "endWordId" VARCHAR(128) NOT NULL,
  "sourceBeatHash" CHAR(64) NOT NULL, "adjustedBeatJson" TEXT NOT NULL, "adjustedBeatHash" CHAR(64) NOT NULL,
  "wordAlignmentHash" CHAR(64) NOT NULL, "wordAlignmentUnchanged" BOOLEAN NOT NULL, "adjustmentHash" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL, "requestFingerprint" CHAR(64) NOT NULL, "actorClientId" VARCHAR(80) NOT NULL,
  "actorCredentialId" VARCHAR(128) NOT NULL, "actorEnvironment" VARCHAR(16) NOT NULL, "actorAuthenticationKind" VARCHAR(16) NOT NULL,
  "actorContextHash" CHAR(64) NOT NULL, "actorDelegatedUserId" VARCHAR(128), "actorDelegatedIdentityId" VARCHAR(128),
  "actorWorkspaceRole" VARCHAR(32), "createdAt" TIMESTAMPTZ(3) NOT NULL, "recordHash" CHAR(64) NOT NULL,
  CONSTRAINT "editorial_beat_adjustments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "editorial_beat_adjustments_id_workspaceId_key" ON "editorial_beat_adjustments"("id", "workspaceId");
CREATE UNIQUE INDEX "editorial_beat_adjustments_idempotency_key" ON "editorial_beat_adjustments"("workspaceId", "beatSetId", "actorClientId", "idempotencyKey");
CREATE INDEX "editorial_beat_adjustments_project_set_idx" ON "editorial_beat_adjustments"("workspaceId", "projectId", "beatSetId", "createdAt" DESC);
CREATE INDEX "editorial_beat_adjustments_workspaceId_directorRunId_idx" ON "editorial_beat_adjustments"("workspaceId", "directorRunId");
CREATE INDEX "editorial_beat_adjustments_actor_idx" ON "editorial_beat_adjustments"("workspaceId", "actorContextHash", "createdAt" DESC);
ALTER TABLE "editorial_beat_adjustments" ADD CONSTRAINT "editorial_beat_adjustments_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "editorial_beat_adjustments" ADD CONSTRAINT "editorial_beat_adjustments_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "editorial_beat_adjustments" ADD CONSTRAINT "editorial_beat_adjustments_beatSetId_workspaceId_fkey" FOREIGN KEY ("beatSetId", "workspaceId") REFERENCES "editorial_beat_sets"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "editorial_beat_adjustments" ADD CONSTRAINT "editorial_beat_adjustments_directorRunId_projectId_workspa_fkey" FOREIGN KEY ("directorRunId", "projectId", "workspaceId") REFERENCES "director_runs"("id", "projectId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "editorial_beat_adjustments" ADD CONSTRAINT "editorial_beat_adjustments_actorClientId_workspaceId_fkey" FOREIGN KEY ("actorClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
