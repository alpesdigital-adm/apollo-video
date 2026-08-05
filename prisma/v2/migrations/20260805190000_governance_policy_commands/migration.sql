CREATE TABLE "governance_policy_commands" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "action" VARCHAR(16) NOT NULL,
  "policyId" VARCHAR(128) NOT NULL,
  "scopeType" VARCHAR(16) NOT NULL,
  "scopeId" VARCHAR(128) NOT NULL,
  "environment" VARCHAR(16) NOT NULL,
  "limitsJson" TEXT,
  "baseRevision" CHAR(64),
  "resultRevision" CHAR(64),
  "reason" VARCHAR(500) NOT NULL,
  "actorClientId" VARCHAR(80) NOT NULL,
  "actorCredentialId" VARCHAR(128) NOT NULL,
  "actorEnvironment" VARCHAR(16) NOT NULL,
  "actorAuthenticationKind" VARCHAR(16) NOT NULL,
  "actorContextHash" CHAR(64) NOT NULL,
  "delegatedUserId" VARCHAR(128),
  "delegatedIdentityId" VARCHAR(128),
  "workspaceRole" VARCHAR(32),
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "resultJson" TEXT NOT NULL,
  "resultHash" CHAR(64) NOT NULL,
  "commandHash" CHAR(64) NOT NULL,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "governance_policy_commands_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "governance_policy_commands_transition_check" CHECK (
    ("action" = 'set' AND "limitsJson" IS NOT NULL AND
      "resultRevision" IS NOT NULL) OR
    ("action" = 'delete' AND "limitsJson" IS NULL AND
      "baseRevision" IS NOT NULL AND "resultRevision" IS NULL)
  ),
  CONSTRAINT "governance_policy_commands_scope_check" CHECK (
    ("scopeType" = 'workspace' AND "scopeId" = "workspaceId") OR
    "scopeType" = 'client'
  ),
  CONSTRAINT "governance_policy_commands_environment_check" CHECK (
    "environment" IN ('sandbox', 'production') AND
    "actorEnvironment" IN ('sandbox', 'production') AND
    "actorAuthenticationKind" IN ('bearer', 'ui-session')
  ),
  CONSTRAINT "governance_policy_commands_json_check" CHECK (
    ("limitsJson" IS NULL OR jsonb_typeof("limitsJson"::jsonb) = 'object') AND
    jsonb_typeof("resultJson"::jsonb) = 'object'
  ),
  CONSTRAINT "governance_policy_commands_hashes_check" CHECK (
    ("baseRevision" IS NULL OR "baseRevision" ~ '^[a-f0-9]{64}$') AND
    ("resultRevision" IS NULL OR "resultRevision" ~ '^[a-f0-9]{64}$') AND
    "actorContextHash" ~ '^[a-f0-9]{64}$' AND
    "requestFingerprint" ~ '^[a-f0-9]{64}$' AND
    "resultHash" ~ '^[a-f0-9]{64}$' AND
    "commandHash" ~ '^[a-f0-9]{64}$'
  )
);

CREATE UNIQUE INDEX "governance_policy_commands_hash_key"
  ON "governance_policy_commands"("commandHash");
CREATE UNIQUE INDEX "governance_policy_commands_idempotency_key"
  ON "governance_policy_commands"(
    "workspaceId", "actorContextHash", "idempotencyKey"
  );
CREATE INDEX "governance_policy_commands_policy_history_idx"
  ON "governance_policy_commands"(
    "workspaceId", "policyId", "occurredAt" DESC
  );
CREATE INDEX "governance_policy_commands_actor_history_idx"
  ON "governance_policy_commands"(
    "workspaceId", "actorContextHash", "occurredAt" DESC
  );

ALTER TABLE "governance_policy_commands"
  ADD CONSTRAINT "governance_policy_commands_workspace_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "governance_policy_commands"
  ADD CONSTRAINT "governance_policy_commands_actor_fkey"
  FOREIGN KEY ("actorClientId", "workspaceId")
  REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
