-- PostgreSQL CHECK constraints accept UNKNOWN. The original complete-tuple
-- constraint therefore needs explicit non-null checks for every required
-- external-authentication field. Internal Director/system commands keep the
-- all-null branch; no historical identity is inferred or backfilled.
ALTER TABLE "edit_commands"
  DROP CONSTRAINT "edit_commands_actor_audit_check";

ALTER TABLE "edit_commands"
  ADD CONSTRAINT "edit_commands_actor_audit_check" CHECK (
    (
      "actorCredentialId" IS NULL AND "actorEnvironment" IS NULL AND
      "actorAuthenticationKind" IS NULL AND "actorContextHash" IS NULL AND
      "actorDelegatedIdentityId" IS NULL AND "actorWorkspaceRole" IS NULL
    ) OR (
      "actorType" = 'api-client' AND
      "actorCredentialId" IS NOT NULL AND
      "actorEnvironment" IS NOT NULL AND
      "actorEnvironment" IN ('sandbox', 'production') AND
      "actorAuthenticationKind" IS NOT NULL AND
      "actorAuthenticationKind" IN ('bearer', 'ui-session') AND
      "actorContextHash" IS NOT NULL AND
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
