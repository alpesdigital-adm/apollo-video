-- EditCommand also represents trusted Director/system work, so authentication
-- columns are nullable as a group. An external actor is valid only as a complete
-- tuple. Pre-contract api-client commands remain unattributable and are rejected
-- by the repositories that require external audit; no identity is backfilled.
ALTER TABLE "edit_commands"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "actorDelegatedIdentityId" VARCHAR(128),
  ADD COLUMN "actorWorkspaceRole" VARCHAR(32);

ALTER TABLE "edit_commands"
  ADD CONSTRAINT "edit_commands_actor_audit_check" CHECK (
    (
      "actorCredentialId" IS NULL AND "actorEnvironment" IS NULL AND
      "actorAuthenticationKind" IS NULL AND "actorContextHash" IS NULL AND
      "actorDelegatedIdentityId" IS NULL AND "actorWorkspaceRole" IS NULL
    ) OR (
      "actorType" = 'api-client' AND
      "actorCredentialId" IS NOT NULL AND
      "actorEnvironment" IN ('sandbox', 'production') AND
      "actorAuthenticationKind" IN ('bearer', 'ui-session') AND
      "actorContextHash" ~ '^[a-f0-9]{64}$' AND
      (
        ("actorAuthenticationKind" = 'bearer' AND
          "delegatedUserId" IS NULL AND "actorDelegatedIdentityId" IS NULL AND
          "actorWorkspaceRole" IS NULL) OR
        ("actorAuthenticationKind" = 'ui-session' AND
          "delegatedUserId" IS NOT NULL AND "actorDelegatedIdentityId" IS NOT NULL AND
          "actorWorkspaceRole" IN ('administrator', 'director', 'operator', 'reviewer'))
      )
    )
  );

CREATE INDEX "edit_commands_workspaceId_actorContextHash_createdAt_idx"
  ON "edit_commands"("workspaceId", "actorContextHash", "createdAt" DESC);
