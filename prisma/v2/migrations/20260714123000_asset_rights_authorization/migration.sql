ALTER TABLE "media_artifacts"
  ADD COLUMN "currentRightsSnapshotId" VARCHAR(128),
  ADD COLUMN "rightsRevision" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "media_artifacts_rights_revision_check" CHECK ("rightsRevision" >= 0);

CREATE TABLE "asset_rights_snapshots" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "artifactId" VARCHAR(128) NOT NULL,
  "sequence" INTEGER NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "snapshotHash" CHAR(64) NOT NULL,
  "owner" VARCHAR(240),
  "license" VARCHAR(240),
  "status" VARCHAR(32) NOT NULL,
  "allowedUsesJson" TEXT NOT NULL,
  "prohibitedUsesJson" TEXT NOT NULL,
  "allowedWorkspaceIdsJson" TEXT NOT NULL,
  "allowedMarketsJson" TEXT,
  "allowedLocalesJson" TEXT,
  "allowedSyntheticOperationsJson" TEXT,
  "expiresAt" TIMESTAMPTZ(3),
  "consentStatus" VARCHAR(32) NOT NULL,
  "consentAllowedUsesJson" TEXT NOT NULL,
  "consentAllowedMarketsJson" TEXT,
  "consentAllowedLocalesJson" TEXT,
  "consentSyntheticOperationsJson" TEXT,
  "consentExpiresAt" TIMESTAMPTZ(3),
  "consentDocumentArtifactId" VARCHAR(128),
  "sourceNote" TEXT,
  "createdByType" VARCHAR(32) NOT NULL,
  "createdById" VARCHAR(128) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "asset_rights_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "asset_rights_snapshots_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "asset_rights_snapshots_schema_check" CHECK ("schemaVersion" = 'asset-rights/v1'),
  CONSTRAINT "asset_rights_snapshots_hash_check" CHECK ("snapshotHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "asset_rights_snapshots_status_check" CHECK (
    "status" IN ('approved', 'restricted', 'unknown', 'expired', 'revoked')
  ),
  CONSTRAINT "asset_rights_snapshots_consent_status_check" CHECK (
    "consentStatus" IN ('not-required', 'approved', 'restricted', 'unknown', 'expired', 'revoked')
  ),
  CONSTRAINT "asset_rights_snapshots_creator_type_check" CHECK (
    "createdByType" IN ('api-client', 'user', 'system')
  ),
  CONSTRAINT "asset_rights_snapshots_json_check" CHECK (
    jsonb_typeof("allowedUsesJson"::jsonb) = 'array'
    AND jsonb_typeof("prohibitedUsesJson"::jsonb) = 'array'
    AND jsonb_typeof("allowedWorkspaceIdsJson"::jsonb) = 'array'
    AND ("allowedMarketsJson" IS NULL OR jsonb_typeof("allowedMarketsJson"::jsonb) = 'array')
    AND ("allowedLocalesJson" IS NULL OR jsonb_typeof("allowedLocalesJson"::jsonb) = 'array')
    AND ("allowedSyntheticOperationsJson" IS NULL OR jsonb_typeof("allowedSyntheticOperationsJson"::jsonb) = 'array')
    AND jsonb_typeof("consentAllowedUsesJson"::jsonb) = 'array'
    AND ("consentAllowedMarketsJson" IS NULL OR jsonb_typeof("consentAllowedMarketsJson"::jsonb) = 'array')
    AND ("consentAllowedLocalesJson" IS NULL OR jsonb_typeof("consentAllowedLocalesJson"::jsonb) = 'array')
    AND ("consentSyntheticOperationsJson" IS NULL OR jsonb_typeof("consentSyntheticOperationsJson"::jsonb) = 'array')
  )
);

CREATE TABLE "materialization_authorizations" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "artifactId" VARCHAR(128) NOT NULL,
  "manifestId" VARCHAR(128) NOT NULL,
  "inputHash" CHAR(64) NOT NULL,
  "rightsUse" VARCHAR(64) NOT NULL,
  "market" VARCHAR(16),
  "locale" VARCHAR(32) NOT NULL,
  "syntheticOpsJson" TEXT NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "issuesJson" TEXT NOT NULL,
  "clientId" VARCHAR(80) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "evaluatedAt" TIMESTAMPTZ(3) NOT NULL,
  "validUntil" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "materialization_authorizations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "materialization_authorizations_hash_check" CHECK (
    "inputHash" ~ '^[a-f0-9]{64}$' AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "materialization_authorizations_status_check" CHECK (
    "status" IN ('authorized', 'denied')
  ),
  CONSTRAINT "materialization_authorizations_validity_check" CHECK (
    ("status" = 'authorized' AND "validUntil" IS NOT NULL AND "validUntil" > "evaluatedAt")
    OR ("status" = 'denied' AND "validUntil" IS NULL)
  ),
  CONSTRAINT "materialization_authorizations_json_check" CHECK (
    jsonb_typeof("syntheticOpsJson"::jsonb) = 'array'
    AND jsonb_typeof("issuesJson"::jsonb) = 'array'
  )
);

CREATE TABLE "asset_use_decisions" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "authorizationId" VARCHAR(128) NOT NULL,
  "artifactId" VARCHAR(128) NOT NULL,
  "assetOrdinal" INTEGER NOT NULL,
  "assetKind" VARCHAR(16) NOT NULL,
  "rightsSnapshotId" VARCHAR(128),
  "outcome" VARCHAR(16) NOT NULL,
  "reasonCodesJson" TEXT NOT NULL,
  "evaluatedAt" TIMESTAMPTZ(3) NOT NULL,
  "validUntil" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "asset_use_decisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "asset_use_decisions_ordinal_check" CHECK ("assetOrdinal" >= 0),
  CONSTRAINT "asset_use_decisions_kind_check" CHECK ("assetKind" IN ('video', 'audio', 'image', 'font', 'lut', 'data')),
  CONSTRAINT "asset_use_decisions_outcome_check" CHECK ("outcome" IN ('allow', 'deny')),
  CONSTRAINT "asset_use_decisions_validity_check" CHECK (
    ("outcome" = 'allow' AND "validUntil" IS NOT NULL AND "validUntil" > "evaluatedAt")
    OR ("outcome" = 'deny' AND "validUntil" IS NULL)
  ),
  CONSTRAINT "asset_use_decisions_reasons_check" CHECK (
    jsonb_typeof("reasonCodesJson"::jsonb) = 'array'
  )
);

CREATE UNIQUE INDEX "asset_rights_snapshots_id_workspaceId_key"
  ON "asset_rights_snapshots"("id", "workspaceId");
CREATE UNIQUE INDEX "asset_rights_snapshots_artifactId_sequence_key"
  ON "asset_rights_snapshots"("artifactId", "sequence");
CREATE UNIQUE INDEX "asset_rights_snapshots_artifactId_snapshotHash_key"
  ON "asset_rights_snapshots"("artifactId", "snapshotHash");
CREATE INDEX "asset_rights_snapshots_workspaceId_status_expiresAt_idx"
  ON "asset_rights_snapshots"("workspaceId", "status", "expiresAt");
CREATE INDEX "asset_rights_snapshots_workspaceId_consentStatus_consentExp_idx"
  ON "asset_rights_snapshots"("workspaceId", "consentStatus", "consentExpiresAt");
CREATE INDEX "asset_rights_snapshots_workspaceId_consentDocumentArtifactI_idx"
  ON "asset_rights_snapshots"("workspaceId", "consentDocumentArtifactId");
CREATE INDEX "media_artifacts_workspaceId_currentRightsSnapshotId_idx"
  ON "media_artifacts"("workspaceId", "currentRightsSnapshotId");
CREATE UNIQUE INDEX "materialization_authorizations_id_workspaceId_key"
  ON "materialization_authorizations"("id", "workspaceId");
CREATE UNIQUE INDEX "materialization_authorizations_workspaceId_clientId_idempot_key"
  ON "materialization_authorizations"("workspaceId", "clientId", "idempotencyKey");
CREATE INDEX "materialization_authorizations_workspaceId_artifactId_evalu_idx"
  ON "materialization_authorizations"("workspaceId", "artifactId", "evaluatedAt" DESC);
CREATE INDEX "materialization_authorizations_workspaceId_status_validUnti_idx"
  ON "materialization_authorizations"("workspaceId", "status", "validUntil");
CREATE UNIQUE INDEX "asset_use_decisions_authorizationId_assetOrdinal_key"
  ON "asset_use_decisions"("authorizationId", "assetOrdinal");
CREATE INDEX "asset_use_decisions_workspaceId_artifactId_evaluatedAt_idx"
  ON "asset_use_decisions"("workspaceId", "artifactId", "evaluatedAt" DESC);
CREATE INDEX "asset_use_decisions_workspaceId_rightsSnapshotId_idx"
  ON "asset_use_decisions"("workspaceId", "rightsSnapshotId");

ALTER TABLE "asset_rights_snapshots"
  ADD CONSTRAINT "asset_rights_snapshots_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_rights_snapshots_artifactId_workspaceId_fkey" FOREIGN KEY ("artifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_rights_snapshots_consentDocumentArtifactId_workspace_fkey" FOREIGN KEY ("consentDocumentArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "media_artifacts"
  ADD CONSTRAINT "media_artifacts_currentRightsSnapshotId_workspaceId_fkey" FOREIGN KEY ("currentRightsSnapshotId", "workspaceId") REFERENCES "asset_rights_snapshots"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "materialization_authorizations"
  ADD CONSTRAINT "materialization_authorizations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "materialization_authorizations_artifactId_workspaceId_fkey" FOREIGN KEY ("artifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "materialization_authorizations_manifestId_workspaceId_fkey" FOREIGN KEY ("manifestId", "workspaceId") REFERENCES "media_artifact_manifests"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "asset_use_decisions"
  ADD CONSTRAINT "asset_use_decisions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_use_decisions_authorizationId_workspaceId_fkey" FOREIGN KEY ("authorizationId", "workspaceId") REFERENCES "materialization_authorizations"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_use_decisions_rightsSnapshotId_workspaceId_fkey" FOREIGN KEY ("rightsSnapshotId", "workspaceId") REFERENCES "asset_rights_snapshots"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
