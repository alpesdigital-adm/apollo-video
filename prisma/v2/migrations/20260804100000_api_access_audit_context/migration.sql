-- F0.036 is pre-production and the owner authorized destructive V2 contract resets.
-- Existing access commands predate complete authentication attribution and cannot be
-- truthfully backfilled. Remove them instead of retaining fabricated audit identity.
TRUNCATE TABLE "api_access_commands";

ALTER TABLE "api_access_commands"
  ADD COLUMN "actorCredentialId" VARCHAR(128) NOT NULL,
  ADD COLUMN "actorEnvironment" VARCHAR(16) NOT NULL,
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16) NOT NULL,
  ADD COLUMN "actorContextHash" CHAR(64) NOT NULL,
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32);

ALTER TABLE "api_access_commands"
  ADD CONSTRAINT "api_access_commands_actor_environment_check"
    CHECK ("actorEnvironment" IN ('sandbox', 'production')),
  ADD CONSTRAINT "api_access_commands_actor_authentication_kind_check"
    CHECK ("actorAuthenticationKind" IN ('bearer', 'ui-session')),
  ADD CONSTRAINT "api_access_commands_actor_context_hash_check"
    CHECK ("actorContextHash" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "api_access_commands_delegation_check"
    CHECK (
      ("actorAuthenticationKind" = 'bearer' AND "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND "workspaceRole" IS NULL)
      OR
      ("actorAuthenticationKind" = 'ui-session' AND "delegatedUserId" IS NOT NULL AND "delegatedIdentityId" IS NOT NULL AND "workspaceRole" IN ('administrator', 'director', 'operator', 'reviewer'))
    );

CREATE INDEX "api_access_commands_workspaceId_actorContextHash_changedAt_idx"
  ON "api_access_commands"("workspaceId", "actorContextHash", "changedAt" DESC);
