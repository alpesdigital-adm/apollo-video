CREATE TABLE "project_creation_commands" (
    "id" VARCHAR(128) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "action" VARCHAR(16) NOT NULL,
    "projectId" VARCHAR(128) NOT NULL,
    "versionId" VARCHAR(128) NOT NULL,
    "sourceProjectId" VARCHAR(128),
    "sourceVersionId" VARCHAR(128),
    "actorClientId" VARCHAR(80) NOT NULL,
    "actorCredentialId" VARCHAR(128) NOT NULL,
    "actorEnvironment" VARCHAR(16) NOT NULL,
    "actorAuthenticationKind" VARCHAR(16) NOT NULL,
    "actorContextHash" CHAR(64) NOT NULL,
    "actorDelegatedUserId" VARCHAR(128),
    "actorDelegatedIdentityId" VARCHAR(128),
    "actorWorkspaceRole" VARCHAR(32),
    "requestFingerprint" CHAR(64) NOT NULL,
    "commandHash" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "project_creation_commands_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "project_creation_commands_action_check" CHECK (
      ("action" = 'create' AND "sourceProjectId" IS NULL AND "sourceVersionId" IS NULL) OR
      ("action" = 'duplicate' AND "sourceProjectId" IS NOT NULL AND "sourceVersionId" IS NOT NULL)
    ),
    CONSTRAINT "project_creation_commands_actor_check" CHECK (
      "actorEnvironment" IN ('sandbox', 'production') AND
      "actorAuthenticationKind" IN ('bearer', 'ui-session') AND
      (
        ("actorAuthenticationKind" = 'bearer' AND
          "actorDelegatedUserId" IS NULL AND "actorDelegatedIdentityId" IS NULL AND
          "actorWorkspaceRole" IS NULL) OR
        ("actorAuthenticationKind" = 'ui-session' AND
          "actorDelegatedUserId" IS NOT NULL AND "actorDelegatedIdentityId" IS NOT NULL AND
          "actorWorkspaceRole" IN ('administrator', 'director', 'operator', 'reviewer'))
      )
    ),
    CONSTRAINT "project_creation_commands_hash_check" CHECK (
      "actorContextHash" ~ '^[a-f0-9]{64}$' AND
      "requestFingerprint" ~ '^[a-f0-9]{64}$' AND
      "commandHash" ~ '^[a-f0-9]{64}$'
    )
);

CREATE UNIQUE INDEX "project_creation_commands_projectId_workspaceId_key"
  ON "project_creation_commands"("projectId", "workspaceId");
CREATE UNIQUE INDEX "project_creation_commands_versionId_projectId_workspaceId_key"
  ON "project_creation_commands"("versionId", "projectId", "workspaceId");
CREATE INDEX "project_creation_commands_workspaceId_actorContextHash_crea_idx"
  ON "project_creation_commands"("workspaceId", "actorContextHash", "createdAt" DESC);
CREATE INDEX "project_creation_commands_workspaceId_action_createdAt_idx"
  ON "project_creation_commands"("workspaceId", "action", "createdAt" DESC);

ALTER TABLE "project_creation_commands"
  ADD CONSTRAINT "project_creation_commands_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_creation_commands"
  ADD CONSTRAINT "project_creation_commands_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_creation_commands"
  ADD CONSTRAINT "project_creation_commands_versionId_projectId_workspaceId_fkey"
  FOREIGN KEY ("versionId", "projectId", "workspaceId") REFERENCES "project_versions"("id", "projectId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_creation_commands"
  ADD CONSTRAINT "project_creation_commands_actorClientId_workspaceId_fkey"
  FOREIGN KEY ("actorClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
