CREATE TABLE "provider_jobs" (
  "id" VARCHAR(128) NOT NULL, "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL, "originProjectVersionId" VARCHAR(128) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL, "operation" VARCHAR(32) NOT NULL,
  "adapterId" VARCHAR(128) NOT NULL, "adapterVersion" VARCHAR(128) NOT NULL,
  "providerJobId" VARCHAR(256), "inputJson" TEXT NOT NULL, "inputHash" CHAR(64) NOT NULL,
  "authorizationJson" TEXT NOT NULL, "authorizationHash" CHAR(64) NOT NULL,
  "estimateJson" TEXT, "estimateHash" CHAR(64), "status" VARCHAR(32) NOT NULL,
  "providerStatus" VARCHAR(24), "attempt" INTEGER NOT NULL DEFAULT 0,
  "resultArtifactId" VARCHAR(128), "resultArtifactSha256" CHAR(64), "criticResultHash" CHAR(64),
  "normalizedErrorJson" TEXT, "jobJson" TEXT NOT NULL, "jobHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL, "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL, "actorCredentialId" VARCHAR(128),
  "actorEnvironment" VARCHAR(16), "actorAuthenticationKind" VARCHAR(16),
  "actorContextHash" CHAR(64), "delegatedUserId" VARCHAR(128),
  "delegatedIdentityId" VARCHAR(128), "workspaceRole" VARCHAR(32),
  "submittedAt" TIMESTAMPTZ(3), "heartbeatAt" TIMESTAMPTZ(3), "completedAt" TIMESTAMPTZ(3),
  "leaseOwner" VARCHAR(128), "leaseToken" VARCHAR(128), "leaseExpiresAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL, "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "provider_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "provider_jobs_attempt_check" CHECK ("attempt" >= 0),
  CONSTRAINT "provider_jobs_status_check" CHECK ("status" IN ('planned','estimated','submitted','queued','processing','suspected-stalled','retrieving','evaluating','approved','rejected','failed','canceled','expired','superseded')),
  CONSTRAINT "provider_jobs_provider_status_check" CHECK ("providerStatus" IS NULL OR "providerStatus" IN ('queued','processing','retrieving','completed','failed','cancelled')),
  CONSTRAINT "provider_jobs_lease_check" CHECK (("leaseOwner" IS NULL AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL) OR ("leaseOwner" IS NOT NULL AND "leaseToken" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL)),
  CONSTRAINT "provider_jobs_result_check" CHECK (("resultArtifactId" IS NULL AND "resultArtifactSha256" IS NULL) OR ("resultArtifactId" IS NOT NULL AND "resultArtifactSha256" IS NOT NULL)),
  CONSTRAINT "provider_jobs_estimate_check" CHECK (("estimateJson" IS NULL AND "estimateHash" IS NULL) OR ("estimateJson" IS NOT NULL AND "estimateHash" IS NOT NULL))
);

CREATE TABLE "provider_job_transitions" (
  "id" VARCHAR(128) NOT NULL, "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL, "jobId" VARCHAR(128) NOT NULL,
  "sequence" INTEGER NOT NULL, "fromStatus" VARCHAR(32), "toStatus" VARCHAR(32) NOT NULL,
  "jobHash" CHAR(64) NOT NULL, "leaseToken" VARCHAR(128), "occurredAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "provider_job_transitions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "provider_job_transitions_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "provider_job_transitions_status_check" CHECK ("toStatus" IN ('planned','estimated','submitted','queued','processing','suspected-stalled','retrieving','evaluating','approved','rejected','failed','canceled','expired','superseded'))
);

CREATE UNIQUE INDEX "provider_jobs_id_workspaceId_key" ON "provider_jobs"("id", "workspaceId");
CREATE UNIQUE INDEX "provider_jobs_id_workspaceId_projectId_key" ON "provider_jobs"("id", "workspaceId", "projectId");
CREATE UNIQUE INDEX "provider_jobs_workspaceId_createdByClientId_actorContextHas_key" ON "provider_jobs"("workspaceId", "createdByClientId", "actorContextHash", "idempotencyKey");
CREATE UNIQUE INDEX "provider_jobs_workspaceId_adapterId_providerJobId_key" ON "provider_jobs"("workspaceId", "adapterId", "providerJobId");
CREATE INDEX "provider_jobs_workspaceId_projectId_createdAt_id_idx" ON "provider_jobs"("workspaceId", "projectId", "createdAt" DESC, "id" DESC);
CREATE INDEX "provider_jobs_workspaceId_status_leaseExpiresAt_createdAt_idx" ON "provider_jobs"("workspaceId", "status", "leaseExpiresAt", "createdAt");
CREATE INDEX "provider_jobs_workspaceId_originProjectVersionId_idx" ON "provider_jobs"("workspaceId", "originProjectVersionId");
CREATE INDEX "provider_jobs_workspaceId_resultArtifactId_idx" ON "provider_jobs"("workspaceId", "resultArtifactId");
CREATE INDEX "provider_jobs_workspaceId_actorContextHash_createdAt_idx" ON "provider_jobs"("workspaceId", "actorContextHash", "createdAt" DESC);
CREATE UNIQUE INDEX "provider_job_transitions_id_workspaceId_key" ON "provider_job_transitions"("id", "workspaceId");
CREATE UNIQUE INDEX "provider_job_transitions_jobId_sequence_key" ON "provider_job_transitions"("jobId", "sequence");
CREATE INDEX "provider_job_transitions_workspaceId_projectId_occurredAt_idx" ON "provider_job_transitions"("workspaceId", "projectId", "occurredAt" DESC);
CREATE INDEX "provider_job_transitions_workspaceId_jobId_occurredAt_idx" ON "provider_job_transitions"("workspaceId", "jobId", "occurredAt");

ALTER TABLE "provider_jobs" ADD CONSTRAINT "provider_jobs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provider_jobs" ADD CONSTRAINT "provider_jobs_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "provider_jobs" ADD CONSTRAINT "provider_jobs_originProjectVersionId_projectId_workspaceId_fkey" FOREIGN KEY ("originProjectVersionId", "projectId", "workspaceId") REFERENCES "project_versions"("id", "projectId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provider_jobs" ADD CONSTRAINT "provider_jobs_resultArtifactId_workspaceId_fkey" FOREIGN KEY ("resultArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provider_jobs" ADD CONSTRAINT "provider_jobs_createdByClientId_workspaceId_fkey" FOREIGN KEY ("createdByClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provider_job_transitions" ADD CONSTRAINT "provider_job_transitions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provider_job_transitions" ADD CONSTRAINT "provider_job_transitions_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "provider_job_transitions" ADD CONSTRAINT "provider_job_transitions_jobId_workspaceId_projectId_fkey" FOREIGN KEY ("jobId", "workspaceId", "projectId") REFERENCES "provider_jobs"("id", "workspaceId", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
