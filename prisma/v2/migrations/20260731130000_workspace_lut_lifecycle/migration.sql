ALTER TABLE "workspace_luts" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "workspace_luts" ADD CONSTRAINT "workspace_luts_revision_check" CHECK ("revision" > 0);

CREATE TABLE "workspace_lut_status_commands" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "lutId" VARCHAR(128) NOT NULL,
  "baseRevision" INTEGER NOT NULL,
  "resultRevision" INTEGER NOT NULL,
  "status" VARCHAR(16) NOT NULL,
  "resultVersionId" VARCHAR(128) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "workspace_lut_status_commands_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workspace_lut_status_commands_revision_check" CHECK ("baseRevision" > 0 AND "resultRevision" = "baseRevision" + 1),
  CONSTRAINT "workspace_lut_status_commands_status_check" CHECK ("status" IN ('active', 'inactive')),
  CONSTRAINT "workspace_lut_status_commands_hash_check" CHECK ("requestFingerprint" ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX "workspace_lut_status_commands_id_workspaceId_key" ON "workspace_lut_status_commands"("id", "workspaceId");
CREATE UNIQUE INDEX "workspace_lut_status_commands_workspaceId_lutId_resultRevis_key" ON "workspace_lut_status_commands"("workspaceId", "lutId", "resultRevision");
CREATE UNIQUE INDEX "workspace_lut_status_commands_workspaceId_createdByClientId_key" ON "workspace_lut_status_commands"("workspaceId", "createdByClientId", "idempotencyKey");
CREATE INDEX "workspace_lut_status_commands_workspaceId_lutId_createdAt_idx" ON "workspace_lut_status_commands"("workspaceId", "lutId", "createdAt" DESC);

ALTER TABLE "workspace_lut_status_commands" ADD CONSTRAINT "workspace_lut_status_commands_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workspace_lut_status_commands" ADD CONSTRAINT "workspace_lut_status_commands_lutId_workspaceId_fkey" FOREIGN KEY ("lutId", "workspaceId") REFERENCES "workspace_luts"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workspace_lut_status_commands" ADD CONSTRAINT "workspace_lut_status_commands_resultVersionId_workspace_fkey" FOREIGN KEY ("resultVersionId", "workspaceId") REFERENCES "workspace_lut_versions"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "workspace_lut_status_commands" ADD CONSTRAINT "workspace_lut_status_commands_createdByClientId_workspaceI_fkey" FOREIGN KEY ("createdByClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
