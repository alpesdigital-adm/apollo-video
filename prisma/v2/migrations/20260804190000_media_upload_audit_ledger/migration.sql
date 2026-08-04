-- Existing pre-contract uploads are intentionally not backfilled or deleted here.
-- The repository requires a matching begin entry before hydrating them, so they
-- fail closed until the authorized pre-production reset without fabricating actor identity.
ALTER TABLE "media_uploads"
  ADD COLUMN "sessionAuditEntryId" UUID;

CREATE TABLE "media_upload_audit_entries" (
  "id" UUID NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "uploadId" UUID NOT NULL,
  "action" VARCHAR(24) NOT NULL,
  "partNumber" INTEGER,
  "actorClientId" VARCHAR(80) NOT NULL,
  "actorCredentialId" VARCHAR(128) NOT NULL,
  "actorEnvironment" VARCHAR(16) NOT NULL,
  "actorAuthenticationKind" VARCHAR(16) NOT NULL,
  "actorContextHash" CHAR(64) NOT NULL,
  "delegatedUserId" VARCHAR(128),
  "delegatedIdentityId" VARCHAR(128),
  "workspaceRole" VARCHAR(32),
  "requestFingerprint" CHAR(64) NOT NULL,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "media_upload_audit_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "media_upload_audit_entries_action_check"
    CHECK ("action" IN ('begin', 'session-issue', 'part-record', 'complete', 'abort')),
  CONSTRAINT "media_upload_audit_entries_part_check"
    CHECK (("action" = 'part-record' AND "partNumber" BETWEEN 1 AND 10000) OR ("action" <> 'part-record' AND "partNumber" IS NULL)),
  CONSTRAINT "media_upload_audit_entries_environment_check"
    CHECK ("actorEnvironment" IN ('sandbox', 'production')),
  CONSTRAINT "media_upload_audit_entries_auth_kind_check"
    CHECK ("actorAuthenticationKind" IN ('bearer', 'ui-session')),
  CONSTRAINT "media_upload_audit_entries_hash_check"
    CHECK ("actorContextHash" ~ '^[a-f0-9]{64}$' AND "requestFingerprint" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "media_upload_audit_entries_delegation_check"
    CHECK (
      ("actorAuthenticationKind" = 'bearer' AND "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND "workspaceRole" IS NULL)
      OR
      ("actorAuthenticationKind" = 'ui-session' AND "delegatedUserId" IS NOT NULL AND "delegatedIdentityId" IS NOT NULL AND "workspaceRole" IN ('administrator', 'director', 'operator', 'reviewer'))
    )
);

CREATE UNIQUE INDEX "media_upload_audit_entries_id_workspaceId_key"
  ON "media_upload_audit_entries"("id", "workspaceId");
CREATE UNIQUE INDEX "media_upload_audit_entries_uploadId_action_requestFingerpri_key"
  ON "media_upload_audit_entries"("uploadId", "action", "requestFingerprint");
CREATE INDEX "media_upload_audit_entries_workspaceId_actorContextHash_occ_idx"
  ON "media_upload_audit_entries"("workspaceId", "actorContextHash", "occurredAt" DESC);
CREATE INDEX "media_upload_audit_entries_workspaceId_uploadId_action_occu_idx"
  ON "media_upload_audit_entries"("workspaceId", "uploadId", "action", "occurredAt" DESC);

ALTER TABLE "media_upload_audit_entries"
  ADD CONSTRAINT "media_upload_audit_entries_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_upload_audit_entries"
  ADD CONSTRAINT "media_upload_audit_entries_uploadId_workspaceId_fkey"
  FOREIGN KEY ("uploadId", "workspaceId") REFERENCES "media_uploads"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "media_upload_audit_entries"
  ADD CONSTRAINT "media_upload_audit_entries_actorClientId_workspaceId_fkey"
  FOREIGN KEY ("actorClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
