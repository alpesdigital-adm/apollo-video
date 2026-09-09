CREATE TABLE "localization_media_runs" (
  "id" VARCHAR(128) NOT NULL, "workspaceId" VARCHAR(128) NOT NULL, "projectId" VARCHAR(128) NOT NULL, "variantId" VARCHAR(128) NOT NULL,
  "variantRevision" INTEGER NOT NULL, "variantHash" CHAR(64) NOT NULL, "canonicalContentHash" CHAR(64) NOT NULL,
  "sourceArtifactId" VARCHAR(128) NOT NULL, "sourceSha256" CHAR(64) NOT NULL, "sourceRightsSnapshotId" VARCHAR(128) NOT NULL,
  "status" VARCHAR(40) NOT NULL, "revision" INTEGER NOT NULL, "attempt" INTEGER NOT NULL, "runJson" TEXT NOT NULL, "runHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL, "idempotencyKey" VARCHAR(128) NOT NULL, "requestedByClientId" VARCHAR(80) NOT NULL,
  "actorCredentialId" VARCHAR(128) NOT NULL, "actorEnvironment" VARCHAR(16) NOT NULL, "actorAuthenticationKind" VARCHAR(16) NOT NULL, "actorContextHash" CHAR(64) NOT NULL,
  "delegatedUserId" VARCHAR(128), "delegatedIdentityId" VARCHAR(128), "workspaceRole" VARCHAR(32),
  "leaseOwner" VARCHAR(128), "leaseTokenHash" CHAR(64), "leaseExpiresAt" TIMESTAMPTZ(3), "heartbeatAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL, "updatedAt" TIMESTAMPTZ(3) NOT NULL, CONSTRAINT "localization_media_runs_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "localization_media_run_revisions" (
  "id" VARCHAR(160) NOT NULL, "workspaceId" VARCHAR(128) NOT NULL, "runId" VARCHAR(128) NOT NULL, "revision" INTEGER NOT NULL,
  "status" VARCHAR(40) NOT NULL, "runJson" TEXT NOT NULL, "runHash" CHAR(64) NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "localization_media_run_revisions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "localization_media_runs_id_workspaceId_key" ON "localization_media_runs"("id", "workspaceId");
CREATE UNIQUE INDEX "localization_media_runs_workspaceId_requestedByClientId_ide_key" ON "localization_media_runs"("workspaceId", "requestedByClientId", "idempotencyKey");
CREATE UNIQUE INDEX "localization_media_runs_workspaceId_variantId_variantRevisi_key" ON "localization_media_runs"("workspaceId", "variantId", "variantRevision");
CREATE INDEX "localization_media_runs_status_leaseExpiresAt_createdAt_idx" ON "localization_media_runs"("status", "leaseExpiresAt", "createdAt");
CREATE INDEX "localization_media_runs_workspaceId_projectId_variantId_cre_idx" ON "localization_media_runs"("workspaceId", "projectId", "variantId", "createdAt" DESC);
CREATE UNIQUE INDEX "localization_media_run_revisions_runId_revision_key" ON "localization_media_run_revisions"("runId", "revision");
CREATE INDEX "localization_media_run_revisions_workspaceId_runId_createdA_idx" ON "localization_media_run_revisions"("workspaceId", "runId", "createdAt" DESC);
ALTER TABLE "localization_media_runs" ADD CONSTRAINT "localization_media_runs_workspace_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT;
ALTER TABLE "localization_media_runs" ADD CONSTRAINT "localization_media_runs_project_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE RESTRICT;
ALTER TABLE "localization_media_runs" ADD CONSTRAINT "localization_media_runs_variant_fkey" FOREIGN KEY ("variantId", "workspaceId") REFERENCES "localization_variant_heads"("id", "workspaceId") ON DELETE RESTRICT;
ALTER TABLE "localization_media_runs" ADD CONSTRAINT "localization_media_runs_source_fkey" FOREIGN KEY ("sourceArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT;
ALTER TABLE "localization_media_runs" ADD CONSTRAINT "localization_media_runs_rights_fkey" FOREIGN KEY ("sourceRightsSnapshotId", "sourceArtifactId", "workspaceId") REFERENCES "asset_rights_snapshots"("id", "artifactId", "workspaceId") ON DELETE RESTRICT;
ALTER TABLE "localization_media_runs" ADD CONSTRAINT "localization_media_runs_requester_fkey" FOREIGN KEY ("requestedByClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT;
ALTER TABLE "localization_media_run_revisions" ADD CONSTRAINT "localization_media_run_revisions_workspace_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT;
ALTER TABLE "localization_media_run_revisions" ADD CONSTRAINT "localization_media_run_revisions_run_fkey" FOREIGN KEY ("runId", "workspaceId") REFERENCES "localization_media_runs"("id", "workspaceId") ON DELETE RESTRICT;
ALTER TABLE "localization_media_runs" ADD CONSTRAINT "localization_media_runs_status_check" CHECK ("status" IN ('requested','processing','awaiting-human-approval','approved','failed','blocked','cancelled'));
ALTER TABLE "localization_media_runs" ADD CONSTRAINT "localization_media_runs_lease_check" CHECK (("leaseOwner" IS NULL AND "leaseTokenHash" IS NULL AND "leaseExpiresAt" IS NULL) OR ("leaseOwner" IS NOT NULL AND "leaseTokenHash" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL));
ALTER TABLE "localization_media_runs" ADD CONSTRAINT "localization_media_runs_revision_check" CHECK ("revision" >= 1 AND "attempt" >= 0);
ALTER TABLE "localization_media_run_revisions" ADD CONSTRAINT "localization_media_run_revisions_revision_check" CHECK ("revision" >= 1);
