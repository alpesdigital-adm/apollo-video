CREATE TABLE "localization_translation_preflights" (
  "id" VARCHAR(128) NOT NULL, "workspaceId" VARCHAR(128) NOT NULL, "projectId" VARCHAR(128) NOT NULL, "variantId" VARCHAR(128) NOT NULL,
  "variantRevision" INTEGER NOT NULL, "variantHash" CHAR(64) NOT NULL, "canonicalScriptVersionId" VARCHAR(128) NOT NULL, "canonicalContentHash" CHAR(64) NOT NULL,
  "preflightJson" TEXT NOT NULL, "preflightHash" CHAR(64) NOT NULL, "costFingerprint" CHAR(64) NOT NULL, "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL, "requestedByClientId" VARCHAR(80) NOT NULL, "actorCredentialId" VARCHAR(128) NOT NULL,
  "actorEnvironment" VARCHAR(16) NOT NULL, "actorAuthenticationKind" VARCHAR(16) NOT NULL, "actorContextHash" CHAR(64) NOT NULL,
  "delegatedUserId" VARCHAR(128), "delegatedIdentityId" VARCHAR(128), "workspaceRole" VARCHAR(32), "consumedAt" TIMESTAMPTZ(3),
  "consumedByRunId" VARCHAR(128), "createdAt" TIMESTAMPTZ(3) NOT NULL, "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "localization_translation_preflights_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "localization_translation_preflights_id_workspaceId_key" ON "localization_translation_preflights"("id", "workspaceId");
CREATE UNIQUE INDEX "localization_translation_preflights_consumedByRunId_key" ON "localization_translation_preflights"("consumedByRunId");
CREATE UNIQUE INDEX "localization_translation_preflights_workspaceId_requestedBy_key" ON "localization_translation_preflights"("workspaceId", "requestedByClientId", "idempotencyKey");
CREATE INDEX "localization_translation_preflights_workspaceId_projectId_v_idx" ON "localization_translation_preflights"("workspaceId", "projectId", "variantId", "createdAt" DESC);
ALTER TABLE "localization_translation_preflights" ADD CONSTRAINT "localization_translation_preflights_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT;
ALTER TABLE "localization_translation_preflights" ADD CONSTRAINT "localization_translation_preflights_requestedByClientId_wo_fkey" FOREIGN KEY ("requestedByClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT;
ALTER TABLE "localization_translation_preflights" ADD CONSTRAINT "localization_translation_preflights_variantRevision_check" CHECK ("variantRevision" >= 1);
ALTER TABLE "localization_translation_preflights" ADD CONSTRAINT "localization_translation_preflights_expiry_check" CHECK ("expiresAt" > "createdAt");
ALTER TABLE "localization_runs" ADD COLUMN "preflightId" VARCHAR(128);
ALTER TABLE "localization_runs" ADD CONSTRAINT "localization_runs_preflightId_fkey" FOREIGN KEY ("preflightId") REFERENCES "localization_translation_preflights"("id") ON DELETE RESTRICT;
CREATE UNIQUE INDEX "localization_runs_preflightId_key" ON "localization_runs"("preflightId");
CREATE UNIQUE INDEX "localization_runs_workspaceId_variantId_variantRevision_key" ON "localization_runs"("workspaceId", "variantId", "variantRevision");
