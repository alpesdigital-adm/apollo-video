CREATE TABLE "edit_commands" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "baseVersionId" VARCHAR(128) NOT NULL,
  "baseHash" CHAR(64) NOT NULL,
  "type" VARCHAR(80) NOT NULL,
  "scopeJson" TEXT NOT NULL,
  "payloadJson" TEXT NOT NULL,
  "reason" VARCHAR(1000),
  "actorType" VARCHAR(32) NOT NULL,
  "actorId" VARCHAR(128) NOT NULL,
  "delegatedUserId" VARCHAR(128),
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "edit_commands_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "edit_commands_type_check" CHECK ("type" = 'remove-spoken-content'),
  CONSTRAINT "edit_commands_actor_type_check" CHECK ("actorType" IN ('user', 'director', 'system', 'api-client')),
  CONSTRAINT "edit_commands_base_hash_check" CHECK ("baseHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "edit_commands_request_fingerprint_check" CHECK ("requestFingerprint" ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX "edit_commands_id_workspaceId_key"
  ON "edit_commands"("id", "workspaceId");
CREATE UNIQUE INDEX "edit_commands_workspaceId_projectId_idempotencyKey_key"
  ON "edit_commands"("workspaceId", "projectId", "idempotencyKey");
CREATE INDEX "edit_commands_workspaceId_projectId_createdAt_idx"
  ON "edit_commands"("workspaceId", "projectId", "createdAt" DESC);
CREATE INDEX "edit_commands_workspaceId_baseVersionId_idx"
  ON "edit_commands"("workspaceId", "baseVersionId");

CREATE UNIQUE INDEX "project_versions_commandId_workspaceId_key"
  ON "project_versions"("commandId", "workspaceId");

ALTER TABLE "edit_commands" ADD CONSTRAINT "edit_commands_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "edit_commands" ADD CONSTRAINT "edit_commands_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "edit_commands" ADD CONSTRAINT "edit_commands_baseVersionId_workspaceId_fkey" FOREIGN KEY ("baseVersionId", "workspaceId") REFERENCES "project_versions"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_versions" ADD CONSTRAINT "project_versions_commandId_workspaceId_fkey" FOREIGN KEY ("commandId", "workspaceId") REFERENCES "edit_commands"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
