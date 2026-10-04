-- Multiple consumers can reuse the same content-addressed immutable bytes.
DROP INDEX "media_segment_materializations_outputArtifactId_workspaceId_key";
CREATE INDEX "media_segment_materializations_outputArtifactId_workspaceId_idx" ON "media_segment_materializations"("outputArtifactId", "workspaceId");

CREATE TABLE "media_segment_derivative_jobs" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "segmentId" VARCHAR(128) NOT NULL,
  "consumerKey" VARCHAR(80) NOT NULL,
  "sourceSha256" CHAR(64) NOT NULL,
  "segmentHash" CHAR(64) NOT NULL,
  "rightsSnapshotId" VARCHAR(128) NOT NULL,
  "clientId" VARCHAR(80) NOT NULL,
  "actorContextHash" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "status" VARCHAR(16) NOT NULL,
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  "leaseOwner" VARCHAR(128),
  "leaseExpiresAt" TIMESTAMPTZ(3),
  "heartbeatAt" TIMESTAMPTZ(3),
  "nextAttemptAt" TIMESTAMPTZ(3),
  "deadlineAt" TIMESTAMPTZ(3) NOT NULL,
  "outputArtifactId" VARCHAR(128),
  "outputManifestId" VARCHAR(128),
  "errorCode" VARCHAR(64),
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "media_segment_derivative_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "media_segment_derivative_jobs_status_check" CHECK ("status" IN ('queued', 'running', 'retrying', 'succeeded', 'failed', 'canceled'))
);
CREATE UNIQUE INDEX "media_segment_derivative_jobs_workspaceId_clientId_idempotencyKey_key" ON "media_segment_derivative_jobs"("workspaceId", "clientId", "idempotencyKey");
CREATE UNIQUE INDEX "media_segment_derivative_jobs_workspaceId_segmentId_consumerKey_key" ON "media_segment_derivative_jobs"("workspaceId", "segmentId", "consumerKey");
CREATE INDEX "media_segment_derivative_jobs_status_nextAttemptAt_leaseExpiresAt_createdAt_idx" ON "media_segment_derivative_jobs"("status", "nextAttemptAt", "leaseExpiresAt", "createdAt");
CREATE INDEX "media_segment_derivative_jobs_workspaceId_segmentId_createdAt_idx" ON "media_segment_derivative_jobs"("workspaceId", "segmentId", "createdAt" DESC);
ALTER TABLE "media_segment_derivative_jobs" ADD CONSTRAINT "media_segment_derivative_jobs_segment_fkey" FOREIGN KEY ("segmentId", "workspaceId") REFERENCES "media_segments"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_segment_derivative_jobs" ADD CONSTRAINT "media_segment_derivative_jobs_rights_fkey" FOREIGN KEY ("rightsSnapshotId", "workspaceId") REFERENCES "asset_rights_snapshots"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
