CREATE TABLE "workspace_luts" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'active',
  "currentVersionId" VARCHAR(128),
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "workspace_luts_pkey" PRIMARY KEY ("id", "workspaceId"),
  CONSTRAINT "workspace_luts_status_check" CHECK ("status" IN ('active', 'inactive'))
);

CREATE TABLE "workspace_lut_versions" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "lutId" VARCHAR(128) NOT NULL,
  "version" INTEGER NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "owner" VARCHAR(240) NOT NULL,
  "licensePolicy" VARCHAR(32) NOT NULL,
  "licenseName" VARCHAR(240) NOT NULL,
  "licenseUsageNotes" TEXT,
  "tagsJson" TEXT NOT NULL,
  "inputColorSpace" VARCHAR(32) NOT NULL,
  "outputColorSpace" VARCHAR(32) NOT NULL,
  "intensityDefault" DOUBLE PRECISION NOT NULL,
  "cubeSize" INTEGER NOT NULL,
  "cubeDomainMinJson" TEXT NOT NULL,
  "cubeDomainMaxJson" TEXT NOT NULL,
  "cubeContent" TEXT NOT NULL,
  "cubeContentHash" CHAR(64) NOT NULL,
  "previewPng" BYTEA NOT NULL,
  "previewSha256" CHAR(64) NOT NULL,
  "previewByteSize" INTEGER NOT NULL,
  "recordHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "workspace_lut_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workspace_lut_versions_schema_check" CHECK ("schemaVersion" = 'workspace-lut-version/v1'),
  CONSTRAINT "workspace_lut_versions_license_check" CHECK ("licensePolicy" IN ('owned', 'licensed', 'restricted')),
  CONSTRAINT "workspace_lut_versions_color_check" CHECK ("inputColorSpace" IN ('rec709', 'display-p3', 'rec2020') AND "outputColorSpace" IN ('rec709', 'display-p3', 'rec2020')),
  CONSTRAINT "workspace_lut_versions_values_check" CHECK ("version" > 0 AND "cubeSize" BETWEEN 2 AND 65 AND "intensityDefault" BETWEEN 0 AND 1 AND "previewByteSize" > 0),
  CONSTRAINT "workspace_lut_versions_hashes_check" CHECK ("cubeContentHash" ~ '^[a-f0-9]{64}$' AND "previewSha256" ~ '^[a-f0-9]{64}$' AND "recordHash" ~ '^[a-f0-9]{64}$' AND "requestFingerprint" ~ '^[a-f0-9]{64}$')
);

CREATE INDEX "workspace_luts_workspaceId_status_updatedAt_idx" ON "workspace_luts"("workspaceId", "status", "updatedAt" DESC);
CREATE UNIQUE INDEX "workspace_lut_versions_id_workspaceId_key" ON "workspace_lut_versions"("id", "workspaceId");
CREATE UNIQUE INDEX "workspace_lut_versions_workspaceId_lutId_version_key" ON "workspace_lut_versions"("workspaceId", "lutId", "version");
CREATE UNIQUE INDEX "workspace_lut_versions_workspaceId_recordHash_key" ON "workspace_lut_versions"("workspaceId", "recordHash");
CREATE UNIQUE INDEX "workspace_lut_versions_workspaceId_createdByClientId_idempo_key" ON "workspace_lut_versions"("workspaceId", "createdByClientId", "idempotencyKey");
CREATE INDEX "workspace_lut_versions_workspaceId_lutId_createdAt_idx" ON "workspace_lut_versions"("workspaceId", "lutId", "createdAt" DESC);
CREATE INDEX "workspace_lut_versions_workspaceId_cubeContentHash_idx" ON "workspace_lut_versions"("workspaceId", "cubeContentHash");

ALTER TABLE "workspace_luts" ADD CONSTRAINT "workspace_luts_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workspace_lut_versions" ADD CONSTRAINT "workspace_lut_versions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workspace_lut_versions" ADD CONSTRAINT "workspace_lut_versions_lutId_workspaceId_fkey" FOREIGN KEY ("lutId", "workspaceId") REFERENCES "workspace_luts"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workspace_lut_versions" ADD CONSTRAINT "workspace_lut_versions_createdByClientId_workspaceId_fkey" FOREIGN KEY ("createdByClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "workspace_luts" ADD CONSTRAINT "workspace_luts_currentVersionId_workspaceId_fkey" FOREIGN KEY ("currentVersionId", "workspaceId") REFERENCES "workspace_lut_versions"("id", "workspaceId") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
