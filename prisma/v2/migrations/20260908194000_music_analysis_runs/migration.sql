CREATE TABLE "music_analysis_runs" (
  "id" VARCHAR(128) NOT NULL, "workspaceId" VARCHAR(128) NOT NULL, "projectId" VARCHAR(128) NOT NULL,
  "projectVersionId" VARCHAR(128) NOT NULL, "sourceArtifactId" VARCHAR(128) NOT NULL, "sourceArtifactKey" VARCHAR(512) NOT NULL,
  "sourceSha256" CHAR(64) NOT NULL, "sourceByteSize" BIGINT NOT NULL, "rightsSnapshotId" VARCHAR(128) NOT NULL,
  "locale" VARCHAR(35) NOT NULL, "status" VARCHAR(16) NOT NULL, "attempt" INTEGER NOT NULL DEFAULT 0,
  "analysisId" VARCHAR(128), "analysisHash" CHAR(64), "failureCode" VARCHAR(64), "failureMessage" VARCHAR(500),
  "requestFingerprint" CHAR(64) NOT NULL, "sourceFingerprint" CHAR(64) NOT NULL, "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestedByClientId" VARCHAR(128) NOT NULL, "actorCredentialId" VARCHAR(128) NOT NULL, "actorEnvironment" VARCHAR(32) NOT NULL,
  "actorAuthenticationKind" VARCHAR(32) NOT NULL, "actorContextHash" CHAR(64) NOT NULL, "delegatedUserId" VARCHAR(128),
  "delegatedIdentityId" VARCHAR(128), "workspaceRole" VARCHAR(32), "leaseOwner" VARCHAR(200), "leaseTokenHash" CHAR(64),
  "leaseExpiresAt" TIMESTAMPTZ(6), "heartbeatAt" TIMESTAMPTZ(6), "createdAt" TIMESTAMPTZ(6) NOT NULL, "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "music_analysis_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "music_analysis_runs_status_check" CHECK ("status" IN ('queued','running','completed','failed','canceled')),
  CONSTRAINT "music_analysis_runs_bounds_check" CHECK ("sourceByteSize" > 0 AND "attempt" >= 0 AND "attempt" <= 3),
  CONSTRAINT "music_analysis_runs_result_check" CHECK (("status" = 'completed' AND "analysisId" IS NOT NULL AND "analysisHash" IS NOT NULL) OR ("status" <> 'completed' AND "analysisId" IS NULL AND "analysisHash" IS NULL))
);
CREATE UNIQUE INDEX "music_analysis_runs_id_workspaceId_key" ON "music_analysis_runs"("id", "workspaceId");
CREATE UNIQUE INDEX "music_analysis_runs_idempotency_key" ON "music_analysis_runs"("workspaceId", "requestedByClientId", "idempotencyKey");
CREATE INDEX "music_analysis_runs_source_fingerprint_idx" ON "music_analysis_runs"("workspaceId", "sourceFingerprint", "status", "createdAt" DESC);
CREATE INDEX "music_analysis_runs_status_leaseExpiresAt_createdAt_idx" ON "music_analysis_runs"("status", "leaseExpiresAt", "createdAt");
CREATE INDEX "music_analysis_runs_workspaceId_projectId_createdAt_idx" ON "music_analysis_runs"("workspaceId", "projectId", "createdAt" DESC);
