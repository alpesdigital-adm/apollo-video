ALTER TABLE "workspaces"
  ADD COLUMN "apiAccessStatus" VARCHAR(32) NOT NULL DEFAULT 'active',
  ADD COLUMN "apiKillSwitchEngaged" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "apiAccessRevision" CHAR(64) NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000';

ALTER TABLE "api_clients"
  ADD COLUMN "apiKillSwitchEngaged" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "apiAccessRevision" CHAR(64) NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000';

ALTER TABLE "workspaces"
  ADD CONSTRAINT "workspaces_api_access_status_check"
  CHECK ("apiAccessStatus" IN ('active', 'suspended', 'revoked')),
  ADD CONSTRAINT "workspaces_api_access_revision_check"
  CHECK ("apiAccessRevision" ~ '^[a-f0-9]{64}$');

ALTER TABLE "api_clients"
  ADD CONSTRAINT "api_clients_api_access_revision_check"
  CHECK ("apiAccessRevision" ~ '^[a-f0-9]{64}$');

CREATE TABLE "api_access_commands" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "targetType" VARCHAR(16) NOT NULL,
  "targetId" VARCHAR(128) NOT NULL,
  "action" VARCHAR(32) NOT NULL,
  "baseRevision" CHAR(64) NOT NULL,
  "resultRevision" CHAR(64) NOT NULL,
  "previousStatus" VARCHAR(32) NOT NULL,
  "resultStatus" VARCHAR(32) NOT NULL,
  "previousKillSwitchEngaged" BOOLEAN NOT NULL,
  "resultKillSwitchEngaged" BOOLEAN NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "actorClientId" VARCHAR(80) NOT NULL,
  "delegatedUserId" VARCHAR(128),
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "canceledOperationCount" INTEGER NOT NULL DEFAULT 0,
  "changedAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "api_access_commands_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "api_access_commands_target_type_check" CHECK ("targetType" IN ('client', 'workspace')),
  CONSTRAINT "api_access_commands_action_check" CHECK ("action" IN ('activate', 'suspend', 'revoke', 'engage-kill-switch', 'release-kill-switch')),
  CONSTRAINT "api_access_commands_previous_status_check" CHECK ("previousStatus" IN ('active', 'suspended', 'revoked')),
  CONSTRAINT "api_access_commands_result_status_check" CHECK ("resultStatus" IN ('active', 'suspended', 'revoked')),
  CONSTRAINT "api_access_commands_base_revision_check" CHECK ("baseRevision" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "api_access_commands_result_revision_check" CHECK ("resultRevision" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "api_access_commands_request_fingerprint_check" CHECK ("requestFingerprint" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "api_access_commands_canceled_operation_count_check" CHECK ("canceledOperationCount" >= 0)
);

CREATE UNIQUE INDEX "api_access_commands_id_workspaceId_key"
  ON "api_access_commands"("id", "workspaceId");
CREATE UNIQUE INDEX "api_access_commands_workspaceId_actorClientId_idempotencyKe_key"
  ON "api_access_commands"("workspaceId", "actorClientId", "idempotencyKey");
CREATE INDEX "api_access_commands_workspaceId_targetType_targetId_changed_idx"
  ON "api_access_commands"("workspaceId", "targetType", "targetId", "changedAt" DESC);
CREATE INDEX "api_access_commands_workspaceId_action_changedAt_idx"
  ON "api_access_commands"("workspaceId", "action", "changedAt" DESC);

ALTER TABLE "api_access_commands"
  ADD CONSTRAINT "api_access_commands_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "api_access_commands"
  ADD CONSTRAINT "api_access_commands_actorClientId_workspaceId_fkey"
  FOREIGN KEY ("actorClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
