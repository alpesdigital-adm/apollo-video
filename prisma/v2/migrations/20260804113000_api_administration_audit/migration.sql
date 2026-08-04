-- Completed client-create/credential-rotate idempotency rows created before this
-- contract cannot be bound to a credential or delegated human after the fact.
DELETE FROM "idempotency_records"
WHERE "responseJson" IS NOT NULL
  AND ("responseJson"::jsonb ->> 'operation') IN ('api-client.create', 'api-credential.rotate');

-- A revoked credential without its immutable revocation command is equally
-- unattributable. It is safe to remove in the authorized pre-production reset.
DELETE FROM "api_credentials" WHERE "status" = 'revoked';

CREATE TABLE "api_administration_commands" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "action" VARCHAR(32) NOT NULL,
  "targetClientId" VARCHAR(80) NOT NULL,
  "targetCredentialId" VARCHAR(80) NOT NULL,
  "actorClientId" VARCHAR(80) NOT NULL,
  "actorCredentialId" VARCHAR(128) NOT NULL,
  "actorEnvironment" VARCHAR(16) NOT NULL,
  "actorAuthenticationKind" VARCHAR(16) NOT NULL,
  "actorContextHash" CHAR(64) NOT NULL,
  "delegatedUserId" VARCHAR(128),
  "delegatedIdentityId" VARCHAR(128),
  "workspaceRole" VARCHAR(32),
  "idempotencyKey" VARCHAR(128),
  "requestFingerprint" CHAR(64) NOT NULL,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "api_administration_commands_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "api_admin_commands_action_check"
    CHECK ("action" IN ('api-client.create', 'api-credential.rotate', 'api-credential.revoke')),
  CONSTRAINT "api_admin_commands_environment_check"
    CHECK ("actorEnvironment" IN ('sandbox', 'production')),
  CONSTRAINT "api_admin_commands_authentication_kind_check"
    CHECK ("actorAuthenticationKind" IN ('bearer', 'ui-session')),
  CONSTRAINT "api_admin_commands_context_hash_check"
    CHECK ("actorContextHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "api_admin_commands_fingerprint_check"
    CHECK ("requestFingerprint" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "api_admin_commands_idempotency_check"
    CHECK (
      ("action" = 'api-credential.revoke' AND "idempotencyKey" IS NULL)
      OR
      ("action" IN ('api-client.create', 'api-credential.rotate') AND length("idempotencyKey") BETWEEN 1 AND 128)
    ),
  CONSTRAINT "api_admin_commands_delegation_check"
    CHECK (
      ("actorAuthenticationKind" = 'bearer' AND "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND "workspaceRole" IS NULL)
      OR
      ("actorAuthenticationKind" = 'ui-session' AND "delegatedUserId" IS NOT NULL AND "delegatedIdentityId" IS NOT NULL AND "workspaceRole" IN ('administrator', 'director', 'operator', 'reviewer'))
    )
);

CREATE UNIQUE INDEX "api_admin_commands_target_action_key"
  ON "api_administration_commands"("workspaceId", "action", "targetClientId", "targetCredentialId");
CREATE INDEX "api_admin_commands_actor_context_idx"
  ON "api_administration_commands"("workspaceId", "actorContextHash", "occurredAt" DESC);
CREATE INDEX "api_admin_commands_target_history_idx"
  ON "api_administration_commands"("workspaceId", "targetClientId", "occurredAt" DESC);

ALTER TABLE "api_administration_commands"
  ADD CONSTRAINT "api_admin_commands_workspace_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "api_admin_commands_actor_fkey"
    FOREIGN KEY ("actorClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "api_admin_commands_target_client_fkey"
    FOREIGN KEY ("targetClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "api_admin_commands_target_credential_fkey"
    FOREIGN KEY ("targetCredentialId", "targetClientId") REFERENCES "api_credentials"("id", "clientId") ON DELETE RESTRICT ON UPDATE CASCADE;
