CREATE TABLE "webhook_administration_commands" (
    "id" UUID NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "action" VARCHAR(48) NOT NULL,
    "targetType" VARCHAR(32) NOT NULL,
    "targetId" UUID NOT NULL,
    "targetStatus" VARCHAR(32),
    "actorClientId" VARCHAR(80) NOT NULL,
    "actorCredentialId" VARCHAR(128) NOT NULL,
    "actorEnvironment" VARCHAR(16) NOT NULL,
    "actorAuthenticationKind" VARCHAR(16) NOT NULL,
    "actorContextHash" CHAR(64) NOT NULL,
    "delegatedUserId" VARCHAR(128),
    "delegatedIdentityId" VARCHAR(128),
    "workspaceRole" VARCHAR(32),
    "idempotencyKey" VARCHAR(128),
    "baseRevision" CHAR(64),
    "requestFingerprint" CHAR(64) NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_administration_commands_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "webhook_admin_commands_action_check" CHECK (
      "action" IN (
        'webhook-endpoint.create',
        'webhook-endpoint.status.set',
        'webhook-subscription.create',
        'webhook-subscription.status.set'
      )
    ),
    CONSTRAINT "webhook_admin_commands_target_check" CHECK (
      ("targetType" = 'webhook-endpoint' AND "action" LIKE 'webhook-endpoint.%') OR
      ("targetType" = 'webhook-subscription' AND "action" LIKE 'webhook-subscription.%')
    ),
    CONSTRAINT "webhook_admin_commands_environment_check" CHECK (
      "actorEnvironment" IN ('sandbox', 'production')
    ),
    CONSTRAINT "webhook_admin_commands_auth_kind_check" CHECK (
      "actorAuthenticationKind" IN ('bearer', 'ui-session')
    ),
    CONSTRAINT "webhook_admin_commands_actor_hash_check" CHECK (
      "actorContextHash" ~ '^[a-f0-9]{64}$'
    ),
    CONSTRAINT "webhook_admin_commands_fingerprint_check" CHECK (
      "requestFingerprint" ~ '^[a-f0-9]{64}$'
    ),
    CONSTRAINT "webhook_admin_commands_replay_check" CHECK (
      ("action" LIKE '%.create' AND "targetStatus" IS NULL AND "idempotencyKey" IS NOT NULL AND "baseRevision" IS NULL) OR
      ("action" = 'webhook-endpoint.status.set' AND "targetStatus" IN ('active', 'suspended', 'revoked') AND "idempotencyKey" IS NULL AND "baseRevision" ~ '^[a-f0-9]{64}$') OR
      ("action" = 'webhook-subscription.status.set' AND "targetStatus" IN ('active', 'paused', 'revoked') AND "idempotencyKey" IS NULL AND "baseRevision" ~ '^[a-f0-9]{64}$')
    ),
    CONSTRAINT "webhook_admin_commands_delegation_check" CHECK (
      ("actorAuthenticationKind" = 'bearer' AND "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND "workspaceRole" IS NULL) OR
      ("actorAuthenticationKind" = 'ui-session' AND "delegatedUserId" IS NOT NULL AND "delegatedIdentityId" IS NOT NULL AND "workspaceRole" IN ('administrator', 'editor', 'reviewer'))
    )
);

CREATE UNIQUE INDEX "webhook_admin_commands_target_revision_key"
ON "webhook_administration_commands"("targetType", "targetId", "action", "baseRevision");

CREATE UNIQUE INDEX "webhook_admin_commands_target_fingerprint_key"
ON "webhook_administration_commands"("targetType", "targetId", "action", "requestFingerprint");

CREATE INDEX "webhook_admin_commands_actor_context_idx"
ON "webhook_administration_commands"("workspaceId", "actorContextHash", "occurredAt" DESC);

CREATE INDEX "webhook_admin_commands_target_history_idx"
ON "webhook_administration_commands"("workspaceId", "targetType", "targetId", "occurredAt" DESC);

ALTER TABLE "webhook_administration_commands"
ADD CONSTRAINT "webhook_admin_commands_workspace_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "webhook_administration_commands"
ADD CONSTRAINT "webhook_admin_commands_actor_fkey"
FOREIGN KEY ("actorClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
