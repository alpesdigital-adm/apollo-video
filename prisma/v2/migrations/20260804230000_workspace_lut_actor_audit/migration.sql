-- Pre-contract LUT mutations recorded only a technical client ID. Their exact
-- credential or delegated human cannot be reconstructed truthfully, so this
-- pre-production contract reset removes those projections before making the
-- complete actor tuple mandatory.
TRUNCATE TABLE
  "project_lut_selection_heads",
  "project_lut_selections",
  "workspace_lut_defaults",
  "workspace_lut_default_versions",
  "workspace_lut_status_commands",
  "workspace_lut_versions",
  "workspace_luts"
CASCADE;

ALTER TABLE "workspace_lut_versions"
  ADD COLUMN "actorCredentialId" VARCHAR(128) NOT NULL,
  ADD COLUMN "actorEnvironment" VARCHAR(16) NOT NULL,
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16) NOT NULL,
  ADD COLUMN "actorContextHash" CHAR(64) NOT NULL,
  ADD COLUMN "actorDelegatedUserId" VARCHAR(128),
  ADD COLUMN "actorDelegatedIdentityId" VARCHAR(128),
  ADD COLUMN "actorWorkspaceRole" VARCHAR(32);

ALTER TABLE "workspace_lut_status_commands"
  ADD COLUMN "actorCredentialId" VARCHAR(128) NOT NULL,
  ADD COLUMN "actorEnvironment" VARCHAR(16) NOT NULL,
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16) NOT NULL,
  ADD COLUMN "actorContextHash" CHAR(64) NOT NULL,
  ADD COLUMN "actorDelegatedUserId" VARCHAR(128),
  ADD COLUMN "actorDelegatedIdentityId" VARCHAR(128),
  ADD COLUMN "actorWorkspaceRole" VARCHAR(32);

ALTER TABLE "workspace_lut_default_versions"
  ADD COLUMN "actorCredentialId" VARCHAR(128) NOT NULL,
  ADD COLUMN "actorEnvironment" VARCHAR(16) NOT NULL,
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16) NOT NULL,
  ADD COLUMN "actorContextHash" CHAR(64) NOT NULL,
  ADD COLUMN "actorDelegatedUserId" VARCHAR(128),
  ADD COLUMN "actorDelegatedIdentityId" VARCHAR(128),
  ADD COLUMN "actorWorkspaceRole" VARCHAR(32);

ALTER TABLE "workspace_lut_versions"
  ADD CONSTRAINT "workspace_lut_versions_actor_audit_check" CHECK (
    "actorEnvironment" IN ('sandbox', 'production') AND
    "actorAuthenticationKind" IN ('bearer', 'ui-session') AND
    "actorContextHash" ~ '^[a-f0-9]{64}$' AND
    (
      ("actorAuthenticationKind" = 'bearer' AND
        "actorDelegatedUserId" IS NULL AND "actorDelegatedIdentityId" IS NULL AND
        "actorWorkspaceRole" IS NULL) OR
      ("actorAuthenticationKind" = 'ui-session' AND
        "actorDelegatedUserId" IS NOT NULL AND "actorDelegatedIdentityId" IS NOT NULL AND
        "actorWorkspaceRole" IN ('administrator', 'director', 'operator', 'reviewer'))
    )
  );

ALTER TABLE "workspace_lut_status_commands"
  ADD CONSTRAINT "workspace_lut_status_commands_actor_audit_check" CHECK (
    "actorEnvironment" IN ('sandbox', 'production') AND
    "actorAuthenticationKind" IN ('bearer', 'ui-session') AND
    "actorContextHash" ~ '^[a-f0-9]{64}$' AND
    (
      ("actorAuthenticationKind" = 'bearer' AND
        "actorDelegatedUserId" IS NULL AND "actorDelegatedIdentityId" IS NULL AND
        "actorWorkspaceRole" IS NULL) OR
      ("actorAuthenticationKind" = 'ui-session' AND
        "actorDelegatedUserId" IS NOT NULL AND "actorDelegatedIdentityId" IS NOT NULL AND
        "actorWorkspaceRole" IN ('administrator', 'director', 'operator', 'reviewer'))
    )
  );

ALTER TABLE "workspace_lut_default_versions"
  ADD CONSTRAINT "workspace_lut_default_versions_actor_audit_check" CHECK (
    "actorEnvironment" IN ('sandbox', 'production') AND
    "actorAuthenticationKind" IN ('bearer', 'ui-session') AND
    "actorContextHash" ~ '^[a-f0-9]{64}$' AND
    (
      ("actorAuthenticationKind" = 'bearer' AND
        "actorDelegatedUserId" IS NULL AND "actorDelegatedIdentityId" IS NULL AND
        "actorWorkspaceRole" IS NULL) OR
      ("actorAuthenticationKind" = 'ui-session' AND
        "actorDelegatedUserId" IS NOT NULL AND "actorDelegatedIdentityId" IS NOT NULL AND
        "actorWorkspaceRole" IN ('administrator', 'director', 'operator', 'reviewer'))
    )
  );

CREATE INDEX "workspace_lut_versions_workspaceId_actorContextHash_created_idx"
  ON "workspace_lut_versions"("workspaceId", "actorContextHash", "createdAt" DESC);
CREATE INDEX "workspace_lut_status_commands_workspaceId_actorContextHash__idx"
  ON "workspace_lut_status_commands"("workspaceId", "actorContextHash", "createdAt" DESC);
CREATE INDEX "workspace_lut_default_versions_workspaceId_actorContextHash_idx"
  ON "workspace_lut_default_versions"("workspaceId", "actorContextHash", "createdAt" DESC);
