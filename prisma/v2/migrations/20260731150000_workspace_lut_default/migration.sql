CREATE TABLE "workspace_lut_defaults" (
  "workspaceId" VARCHAR(128) NOT NULL,
  "revision" INTEGER NOT NULL,
  "currentVersionId" VARCHAR(128) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "workspace_lut_defaults_pkey" PRIMARY KEY ("workspaceId"),
  CONSTRAINT "workspace_lut_defaults_revision_check" CHECK ("revision" > 0)
);

CREATE TABLE "workspace_lut_default_versions" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "revision" INTEGER NOT NULL,
  "mode" VARCHAR(16) NOT NULL,
  "lutVersionId" VARCHAR(128),
  "selectionHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "workspace_lut_default_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workspace_lut_default_versions_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "workspace_lut_default_versions_mode_check" CHECK (("mode" = 'none' AND "lutVersionId" IS NULL) OR ("mode" = 'lut-version' AND "lutVersionId" IS NOT NULL)),
  CONSTRAINT "workspace_lut_default_versions_hash_check" CHECK ("selectionHash" ~ '^[a-f0-9]{64}$' AND "requestFingerprint" ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX "workspace_lut_default_versions_id_workspaceId_key" ON "workspace_lut_default_versions"("id", "workspaceId");
CREATE UNIQUE INDEX "workspace_lut_default_versions_workspaceId_revision_key" ON "workspace_lut_default_versions"("workspaceId", "revision");
CREATE UNIQUE INDEX "workspace_lut_default_versions_workspaceId_createdByClientI_key" ON "workspace_lut_default_versions"("workspaceId", "createdByClientId", "idempotencyKey");
CREATE INDEX "workspace_lut_default_versions_workspaceId_createdAt_idx" ON "workspace_lut_default_versions"("workspaceId", "createdAt" DESC);
CREATE INDEX "workspace_lut_default_versions_workspaceId_lutVersionId_idx" ON "workspace_lut_default_versions"("workspaceId", "lutVersionId");

ALTER TABLE "workspace_lut_defaults" ADD CONSTRAINT "workspace_lut_defaults_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workspace_lut_default_versions" ADD CONSTRAINT "workspace_lut_default_versions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workspace_lut_default_versions" ADD CONSTRAINT "workspace_lut_default_versions_lutVersionId_workspaceId_fkey" FOREIGN KEY ("lutVersionId", "workspaceId") REFERENCES "workspace_lut_versions"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "workspace_lut_default_versions" ADD CONSTRAINT "workspace_lut_default_versions_createdByClientId_workspace_fkey" FOREIGN KEY ("createdByClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "workspace_lut_defaults" ADD CONSTRAINT "workspace_lut_defaults_currentVersionId_workspaceId_fkey" FOREIGN KEY ("currentVersionId", "workspaceId") REFERENCES "workspace_lut_default_versions"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
