CREATE TABLE "localization_runs" (
  "id" VARCHAR(128) NOT NULL, "workspaceId" VARCHAR(128) NOT NULL, "projectId" VARCHAR(128) NOT NULL, "variantId" VARCHAR(128) NOT NULL,
  "variantRevision" INTEGER NOT NULL, "variantHash" CHAR(64) NOT NULL, "canonicalScriptVersionId" VARCHAR(128) NOT NULL, "canonicalContentHash" CHAR(64) NOT NULL,
  "status" VARCHAR(32) NOT NULL, "attempt" INTEGER NOT NULL, "runJson" TEXT NOT NULL, "runHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL, "idempotencyKey" VARCHAR(128) NOT NULL, "requestedByClientId" VARCHAR(80) NOT NULL,
  "actorCredentialId" VARCHAR(128) NOT NULL, "actorEnvironment" VARCHAR(16) NOT NULL, "actorAuthenticationKind" VARCHAR(16) NOT NULL,
  "actorContextHash" CHAR(64) NOT NULL, "delegatedUserId" VARCHAR(128), "delegatedIdentityId" VARCHAR(128), "workspaceRole" VARCHAR(32),
  "leaseOwner" VARCHAR(128), "leaseTokenHash" CHAR(64), "leaseExpiresAt" TIMESTAMPTZ(3), "heartbeatAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL, "updatedAt" TIMESTAMPTZ(3) NOT NULL, CONSTRAINT "localization_runs_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "localization_run_revisions" (
  "id" VARCHAR(160) NOT NULL, "workspaceId" VARCHAR(128) NOT NULL, "runId" VARCHAR(128) NOT NULL, "revision" INTEGER NOT NULL,
  "status" VARCHAR(32) NOT NULL, "runJson" TEXT NOT NULL, "runHash" CHAR(64) NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "localization_run_revisions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "localization_runs_id_workspaceId_key" ON "localization_runs"("id", "workspaceId");
CREATE UNIQUE INDEX "localization_runs_workspaceId_requestedByClientId_idempoten_key" ON "localization_runs"("workspaceId", "requestedByClientId", "idempotencyKey");
CREATE INDEX "localization_runs_status_leaseExpiresAt_createdAt_idx" ON "localization_runs"("status", "leaseExpiresAt", "createdAt");
CREATE INDEX "localization_runs_workspaceId_projectId_variantId_createdAt_idx" ON "localization_runs"("workspaceId", "projectId", "variantId", "createdAt" DESC);
CREATE UNIQUE INDEX "localization_run_revisions_runId_revision_key" ON "localization_run_revisions"("runId", "revision");
CREATE INDEX "localization_run_revisions_workspaceId_runId_createdAt_idx" ON "localization_run_revisions"("workspaceId", "runId", "createdAt" DESC);
ALTER TABLE "localization_runs" ADD CONSTRAINT "localization_runs_workspace_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT;
ALTER TABLE "localization_runs" ADD CONSTRAINT "localization_runs_project_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE RESTRICT;
ALTER TABLE "localization_runs" ADD CONSTRAINT "localization_runs_variant_fkey" FOREIGN KEY ("variantId", "workspaceId") REFERENCES "localization_variant_heads"("id", "workspaceId") ON DELETE RESTRICT;
ALTER TABLE "localization_runs" ADD CONSTRAINT "localization_runs_requester_fkey" FOREIGN KEY ("requestedByClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT;
ALTER TABLE "localization_run_revisions" ADD CONSTRAINT "localization_run_revisions_workspace_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT;
ALTER TABLE "localization_run_revisions" ADD CONSTRAINT "localization_run_revisions_run_fkey" FOREIGN KEY ("runId", "workspaceId") REFERENCES "localization_runs"("id", "workspaceId") ON DELETE RESTRICT;
ALTER TABLE "localization_runs" ADD CONSTRAINT "localization_runs_status_check" CHECK ("status" IN ('requested','translating','awaiting-human-review','failed','cancelled'));
ALTER TABLE "localization_runs" ADD CONSTRAINT "localization_runs_lease_check" CHECK (("leaseOwner" IS NULL AND "leaseTokenHash" IS NULL AND "leaseExpiresAt" IS NULL) OR ("leaseOwner" IS NOT NULL AND "leaseTokenHash" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL));
ALTER TABLE "localization_run_revisions" ADD CONSTRAINT "localization_run_revisions_revision_check" CHECK ("revision" >= 1);
