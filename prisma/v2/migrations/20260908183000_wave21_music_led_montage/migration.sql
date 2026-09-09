CREATE TABLE "music_analyses" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectVersionId" VARCHAR(128) NOT NULL,
  "sourceArtifactId" VARCHAR(128) NOT NULL,
  "sourceSha256" CHAR(64) NOT NULL,
  "sourceByteSize" BIGINT NOT NULL,
  "rightsSnapshotId" VARCHAR(128) NOT NULL,
  "analyzerId" VARCHAR(128) NOT NULL,
  "analyzerVersion" VARCHAR(64) NOT NULL,
  "durationMs" INTEGER NOT NULL,
  "bpm" DOUBLE PRECISION,
  "confidence" DOUBLE PRECISION NOT NULL,
  "analysisJson" TEXT NOT NULL,
  "analysisHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "music_analyses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "music_analyses_bounds_check" CHECK ("sourceByteSize" > 0 AND "durationMs" > 0 AND "confidence" >= 0 AND "confidence" <= 1 AND ("bpm" IS NULL OR "bpm" > 0))
);
CREATE UNIQUE INDEX "music_analyses_id_workspaceId_key" ON "music_analyses"("id", "workspaceId");
CREATE UNIQUE INDEX "music_analyses_source_analyzer_key" ON "music_analyses"("workspaceId", "sourceArtifactId", "sourceSha256", "analyzerId", "analyzerVersion");
CREATE INDEX "music_analyses_workspaceId_projectVersionId_createdAt_idx" ON "music_analyses"("workspaceId", "projectVersionId", "createdAt" DESC);
CREATE INDEX "music_analyses_workspaceId_sourceArtifactId_idx" ON "music_analyses"("workspaceId", "sourceArtifactId");

CREATE TABLE "music_montage_runs" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "projectVersionId" VARCHAR(128) NOT NULL,
  "locale" VARCHAR(35),
  "market" VARCHAR(16),
  "rightsSnapshotId" VARCHAR(128) NOT NULL,
  "musicAnalysisId" VARCHAR(128) NOT NULL,
  "musicAnalysisHash" CHAR(64) NOT NULL,
  "montagePlanJson" TEXT NOT NULL,
  "montagePlanHash" CHAR(64) NOT NULL,
  "editPlanId" VARCHAR(128) NOT NULL,
  "editPlanHash" CHAR(64) NOT NULL,
  "criticJson" TEXT NOT NULL,
  "eligibleForRender" BOOLEAN NOT NULL,
  "runJson" TEXT NOT NULL,
  "runHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(128) NOT NULL,
  "actorCredentialId" VARCHAR(128) NOT NULL,
  "actorEnvironment" VARCHAR(32) NOT NULL,
  "actorAuthenticationKind" VARCHAR(32) NOT NULL,
  "actorContextHash" CHAR(64) NOT NULL,
  "delegatedUserId" VARCHAR(128),
  "delegatedIdentityId" VARCHAR(128),
  "workspaceRole" VARCHAR(32),
  "createdAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "music_montage_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "music_montage_runs_eligible_check" CHECK ("eligibleForRender" = TRUE)
);
CREATE UNIQUE INDEX "music_montage_runs_id_workspaceId_key" ON "music_montage_runs"("id", "workspaceId");
CREATE UNIQUE INDEX "music_montage_runs_version_plan_key" ON "music_montage_runs"("workspaceId", "projectVersionId", "montagePlanHash");
CREATE UNIQUE INDEX "music_montage_runs_idempotency_key" ON "music_montage_runs"("workspaceId", "idempotencyKey");
CREATE INDEX "music_montage_runs_workspaceId_projectId_createdAt_idx" ON "music_montage_runs"("workspaceId", "projectId", "createdAt" DESC);
CREATE INDEX "music_montage_runs_workspaceId_musicAnalysisId_idx" ON "music_montage_runs"("workspaceId", "musicAnalysisId");

ALTER TABLE "renderable_plan_snapshots" DROP CONSTRAINT "renderable_plan_snapshots_origin_check";
ALTER TABLE "renderable_plan_snapshots" ADD CONSTRAINT "renderable_plan_snapshots_origin_check" CHECK ("origin" IN ('react-playback', 'multi-range-synthesis', 'music-led-montage', 'localization'));
