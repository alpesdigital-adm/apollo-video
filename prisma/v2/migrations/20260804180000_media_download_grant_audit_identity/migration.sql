-- Download grants are short-lived pre-production credentials. Existing rows cannot
-- be attributed to a credential or delegated member truthfully, so invalidate them
-- instead of manufacturing audit identity.
DELETE FROM "media_download_grants";

ALTER TABLE "media_download_grants"
  ADD COLUMN "issuerCredentialId" VARCHAR(128) NOT NULL,
  ADD COLUMN "issuerEnvironment" VARCHAR(16) NOT NULL,
  ADD COLUMN "issuerAuthenticationKind" VARCHAR(16) NOT NULL,
  ADD COLUMN "issuerContextHash" CHAR(64) NOT NULL,
  ADD COLUMN "issuerDelegatedUserId" VARCHAR(128),
  ADD COLUMN "issuerDelegatedIdentityId" VARCHAR(128),
  ADD COLUMN "issuerWorkspaceRole" VARCHAR(32),
  ADD COLUMN "revokerCredentialId" VARCHAR(128),
  ADD COLUMN "revokerEnvironment" VARCHAR(16),
  ADD COLUMN "revokerAuthenticationKind" VARCHAR(16),
  ADD COLUMN "revokerContextHash" CHAR(64),
  ADD COLUMN "revokerDelegatedUserId" VARCHAR(128),
  ADD COLUMN "revokerDelegatedIdentityId" VARCHAR(128),
  ADD COLUMN "revokerWorkspaceRole" VARCHAR(32);

ALTER TABLE "media_download_grants"
  ADD CONSTRAINT "media_download_grants_issuer_environment_check"
    CHECK ("issuerEnvironment" IN ('sandbox', 'production')),
  ADD CONSTRAINT "media_download_grants_issuer_auth_kind_check"
    CHECK ("issuerAuthenticationKind" IN ('bearer', 'ui-session')),
  ADD CONSTRAINT "media_download_grants_issuer_hash_check"
    CHECK ("issuerContextHash" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "media_download_grants_issuer_delegation_check"
    CHECK (
      ("issuerAuthenticationKind" = 'bearer' AND "issuerDelegatedUserId" IS NULL AND "issuerDelegatedIdentityId" IS NULL AND "issuerWorkspaceRole" IS NULL)
      OR
      ("issuerAuthenticationKind" = 'ui-session' AND "issuerDelegatedUserId" IS NOT NULL AND "issuerDelegatedIdentityId" IS NOT NULL AND "issuerWorkspaceRole" IN ('administrator', 'director', 'operator', 'reviewer'))
    ),
  ADD CONSTRAINT "media_download_grants_revocation_audit_check"
    CHECK (
      ("status" = 'active' AND "revokedAt" IS NULL AND "revokerCredentialId" IS NULL AND "revokerEnvironment" IS NULL AND "revokerAuthenticationKind" IS NULL AND "revokerContextHash" IS NULL AND "revokerDelegatedUserId" IS NULL AND "revokerDelegatedIdentityId" IS NULL AND "revokerWorkspaceRole" IS NULL)
      OR
      ("status" = 'revoked' AND "revokedAt" IS NOT NULL AND "revokerCredentialId" IS NOT NULL AND "revokerEnvironment" IN ('sandbox', 'production') AND "revokerAuthenticationKind" IN ('bearer', 'ui-session') AND "revokerContextHash" ~ '^[a-f0-9]{64}$')
    ),
  ADD CONSTRAINT "media_download_grants_revoker_delegation_check"
    CHECK (
      "revokerAuthenticationKind" IS NULL
      OR ("revokerAuthenticationKind" = 'bearer' AND "revokerDelegatedUserId" IS NULL AND "revokerDelegatedIdentityId" IS NULL AND "revokerWorkspaceRole" IS NULL)
      OR ("revokerAuthenticationKind" = 'ui-session' AND "revokerDelegatedUserId" IS NOT NULL AND "revokerDelegatedIdentityId" IS NOT NULL AND "revokerWorkspaceRole" IN ('administrator', 'director', 'operator', 'reviewer'))
    );

CREATE INDEX "media_download_grants_workspaceId_issuerContextHash_created_idx"
  ON "media_download_grants"("workspaceId", "issuerContextHash", "createdAt" DESC);

CREATE INDEX "media_download_grants_workspaceId_revokerContextHash_revoke_idx"
  ON "media_download_grants"("workspaceId", "revokerContextHash", "revokedAt" DESC);
