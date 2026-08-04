ALTER TABLE "materialization_authorizations"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32);

ALTER TABLE "materialization_authorizations"
  ADD CONSTRAINT "materialization_authorizations_actor_audit_check" CHECK (
    (
      "actorCredentialId" IS NULL AND "actorEnvironment" IS NULL AND
      "actorAuthenticationKind" IS NULL AND "actorContextHash" IS NULL AND
      "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
      "workspaceRole" IS NULL
    ) OR (
      "actorCredentialId" IS NOT NULL AND
      "actorEnvironment" IN ('sandbox', 'production') AND
      "actorAuthenticationKind" IN ('bearer', 'ui-session') AND
      "actorContextHash" ~ '^[a-f0-9]{64}$' AND
      (
        ("actorAuthenticationKind" = 'bearer' AND "delegatedUserId" IS NULL AND
          "delegatedIdentityId" IS NULL AND "workspaceRole" IS NULL) OR
        ("actorAuthenticationKind" = 'ui-session' AND "delegatedUserId" IS NOT NULL AND
          "delegatedIdentityId" IS NOT NULL AND
          "workspaceRole" IN ('administrator', 'operator', 'director', 'reviewer'))
      )
    )
  );

CREATE INDEX "materialization_authorizations_actor_context_idx"
  ON "materialization_authorizations"("workspaceId", "actorContextHash", "evaluatedAt" DESC);

ALTER TABLE "public_operations"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32);

ALTER TABLE "public_operations"
  ADD CONSTRAINT "public_operations_actor_audit_check" CHECK (
    (
      "actorCredentialId" IS NULL AND "actorEnvironment" IS NULL AND
      "actorAuthenticationKind" IS NULL AND "actorContextHash" IS NULL AND
      "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
      "workspaceRole" IS NULL
    ) OR (
      "actorCredentialId" IS NOT NULL AND
      "actorEnvironment" IN ('sandbox', 'production') AND
      "actorAuthenticationKind" IN ('bearer', 'ui-session') AND
      "actorContextHash" ~ '^[a-f0-9]{64}$' AND
      (
        ("actorAuthenticationKind" = 'bearer' AND "delegatedUserId" IS NULL AND
          "delegatedIdentityId" IS NULL AND "workspaceRole" IS NULL) OR
        ("actorAuthenticationKind" = 'ui-session' AND "delegatedUserId" IS NOT NULL AND
          "delegatedIdentityId" IS NOT NULL AND
          "workspaceRole" IN ('administrator', 'operator', 'director', 'reviewer'))
      )
    )
  );

CREATE INDEX "public_operations_actor_context_idx"
  ON "public_operations"("workspaceId", "actorContextHash", "createdAt" DESC);

ALTER TABLE "long_form_index_workflows"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32);
ALTER TABLE "long_form_index_workflows"
  ADD CONSTRAINT "long_form_index_workflows_actor_audit_check" CHECK (
    ("actorCredentialId" IS NULL AND "actorEnvironment" IS NULL AND "actorAuthenticationKind" IS NULL AND
      "actorContextHash" IS NULL AND "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND "workspaceRole" IS NULL) OR
    ("actorCredentialId" IS NOT NULL AND "actorEnvironment" IN ('sandbox', 'production') AND
      "actorAuthenticationKind" IN ('bearer', 'ui-session') AND "actorContextHash" ~ '^[a-f0-9]{64}$' AND
      (("actorAuthenticationKind" = 'bearer' AND "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND "workspaceRole" IS NULL) OR
       ("actorAuthenticationKind" = 'ui-session' AND "delegatedUserId" IS NOT NULL AND "delegatedIdentityId" IS NOT NULL AND
        "workspaceRole" IN ('administrator', 'operator', 'director', 'reviewer'))))
  );
CREATE INDEX "long_form_index_workflows_actor_context_idx"
  ON "long_form_index_workflows"("workspaceId", "actorContextHash", "createdAt" DESC);

ALTER TABLE "source_cleanup_plans"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32);
ALTER TABLE "source_cleanup_plans"
  ADD CONSTRAINT "source_cleanup_plans_actor_audit_check" CHECK (
    ("actorCredentialId" IS NULL AND "actorEnvironment" IS NULL AND "actorAuthenticationKind" IS NULL AND
      "actorContextHash" IS NULL AND "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND "workspaceRole" IS NULL) OR
    ("actorCredentialId" IS NOT NULL AND "actorEnvironment" IN ('sandbox', 'production') AND
      "actorAuthenticationKind" IN ('bearer', 'ui-session') AND "actorContextHash" ~ '^[a-f0-9]{64}$' AND
      (("actorAuthenticationKind" = 'bearer' AND "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND "workspaceRole" IS NULL) OR
       ("actorAuthenticationKind" = 'ui-session' AND "delegatedUserId" IS NOT NULL AND "delegatedIdentityId" IS NOT NULL AND
        "workspaceRole" IN ('administrator', 'operator', 'director', 'reviewer'))))
  );
CREATE INDEX "source_cleanup_plans_actor_context_idx"
  ON "source_cleanup_plans"("workspaceId", "actorContextHash", "createdAt" DESC);

CREATE TABLE "public_operation_control_commands" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "operationId" VARCHAR(128) NOT NULL,
  "action" VARCHAR(16) NOT NULL,
  "previousStatus" VARCHAR(32) NOT NULL,
  "resultStatus" VARCHAR(32) NOT NULL,
  "actorClientId" VARCHAR(80) NOT NULL,
  "actorCredentialId" VARCHAR(128) NOT NULL,
  "actorEnvironment" VARCHAR(16) NOT NULL,
  "actorAuthenticationKind" VARCHAR(16) NOT NULL,
  "actorContextHash" CHAR(64) NOT NULL,
  "delegatedUserId" VARCHAR(128),
  "delegatedIdentityId" VARCHAR(128),
  "workspaceRole" VARCHAR(32),
  "occurredAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "public_operation_control_commands_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "public_operation_control_commands_action_check" CHECK (
    ("action" = 'cancel' AND "previousStatus" IN ('queued', 'running', 'waiting', 'retrying') AND "resultStatus" = 'canceled') OR
    ("action" = 'retry' AND "previousStatus" IN ('canceled', 'failed') AND "resultStatus" IN ('queued', 'retrying'))
  ),
  CONSTRAINT "public_operation_control_commands_actor_audit_check" CHECK (
    "actorEnvironment" IN ('sandbox', 'production') AND
    "actorAuthenticationKind" IN ('bearer', 'ui-session') AND
    "actorContextHash" ~ '^[a-f0-9]{64}$' AND
    (
      ("actorAuthenticationKind" = 'bearer' AND "delegatedUserId" IS NULL AND
        "delegatedIdentityId" IS NULL AND "workspaceRole" IS NULL) OR
      ("actorAuthenticationKind" = 'ui-session' AND "delegatedUserId" IS NOT NULL AND
        "delegatedIdentityId" IS NOT NULL AND
        "workspaceRole" IN ('administrator', 'operator', 'director', 'reviewer'))
    )
  )
);

CREATE INDEX "public_operation_control_commands_history_idx"
  ON "public_operation_control_commands"("workspaceId", "operationId", "occurredAt" DESC);
CREATE INDEX "public_operation_control_commands_actor_idx"
  ON "public_operation_control_commands"("workspaceId", "actorContextHash", "occurredAt" DESC);

ALTER TABLE "public_operation_control_commands"
  ADD CONSTRAINT "public_operation_control_commands_workspace_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public_operation_control_commands"
  ADD CONSTRAINT "public_operation_control_commands_operation_fkey"
  FOREIGN KEY ("operationId", "workspaceId") REFERENCES "public_operations"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public_operation_control_commands"
  ADD CONSTRAINT "public_operation_control_commands_actor_fkey"
  FOREIGN KEY ("actorClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Existing rows predate credential-bound audit and are deliberately not backfilled.
-- Application hydration rejects them until the authorized pre-production reset removes them.
