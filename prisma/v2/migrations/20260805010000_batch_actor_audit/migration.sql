ALTER TABLE "production_batches"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32);

ALTER TABLE "production_batches"
  ADD CONSTRAINT "production_batches_actor_audit_check" CHECK (
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

CREATE INDEX "production_batches_actor_context_idx"
  ON "production_batches"("workspaceId", "actorContextHash", "createdAt" DESC);

ALTER TABLE "script_alignment_runs"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32);

ALTER TABLE "script_alignment_runs"
  ADD CONSTRAINT "script_alignment_runs_actor_audit_check" CHECK (
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

CREATE INDEX "script_alignment_runs_actor_context_idx"
  ON "script_alignment_runs"("workspaceId", "actorContextHash", "createdAt" DESC);

ALTER TABLE "script_alignment_reviews"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32);

ALTER TABLE "script_alignment_reviews"
  ADD CONSTRAINT "script_alignment_reviews_actor_audit_check" CHECK (
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

CREATE INDEX "script_alignment_reviews_actor_context_idx"
  ON "script_alignment_reviews"("workspaceId", "actorContextHash", "createdAt" DESC);

ALTER TABLE "take_library_runs"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32);

ALTER TABLE "take_library_runs"
  ADD CONSTRAINT "take_library_runs_actor_audit_check" CHECK (
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

CREATE INDEX "take_library_runs_actor_context_idx"
  ON "take_library_runs"("workspaceId", "actorContextHash", "createdAt" DESC);

ALTER TABLE "take_library_selections"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32);

ALTER TABLE "take_library_selections"
  ADD CONSTRAINT "take_library_selections_actor_audit_check" CHECK (
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

CREATE INDEX "take_library_selections_actor_context_idx"
  ON "take_library_selections"("workspaceId", "actorContextHash", "createdAt" DESC);

ALTER TABLE "compatibility_graph_runs"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32);

ALTER TABLE "compatibility_graph_runs"
  ADD CONSTRAINT "compatibility_graph_runs_actor_audit_check" CHECK (
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

CREATE INDEX "compatibility_graph_runs_actor_context_idx"
  ON "compatibility_graph_runs"("workspaceId", "actorContextHash", "createdAt" DESC);

ALTER TABLE "variant_recipe_runs"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32);

ALTER TABLE "variant_recipe_runs"
  ADD CONSTRAINT "variant_recipe_runs_actor_audit_check" CHECK (
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

CREATE INDEX "variant_recipe_runs_actor_context_idx"
  ON "variant_recipe_runs"("workspaceId", "actorContextHash", "createdAt" DESC);

ALTER TABLE "variant_portfolio_preflight_runs"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32);

ALTER TABLE "variant_portfolio_preflight_runs"
  ADD CONSTRAINT "variant_portfolio_preflight_runs_actor_audit_check" CHECK (
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

CREATE INDEX "variant_portfolio_preflights_actor_context_idx"
  ON "variant_portfolio_preflight_runs"("workspaceId", "actorContextHash", "createdAt" DESC);

ALTER TABLE "batch_edit_preflight_runs"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32);

ALTER TABLE "batch_edit_preflight_runs"
  ADD CONSTRAINT "batch_edit_preflights_actor_audit_check" CHECK (
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

CREATE INDEX "batch_edit_preflights_actor_context_idx"
  ON "batch_edit_preflight_runs"("workspaceId", "actorContextHash", "createdAt" DESC);

ALTER TABLE "batch_edit_commands"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32);

ALTER TABLE "batch_edit_commands"
  ADD CONSTRAINT "batch_edit_commands_actor_audit_check" CHECK (
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

CREATE INDEX "batch_edit_commands_actor_context_idx"
  ON "batch_edit_commands"("workspaceId", "actorContextHash", "createdAt" DESC);

ALTER TABLE "production_batch_actions"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32);

ALTER TABLE "production_batch_actions"
  ADD CONSTRAINT "production_batch_actions_actor_audit_check" CHECK (
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

CREATE INDEX "production_batch_actions_actor_context_idx"
  ON "production_batch_actions"("workspaceId", "actorContextHash", "createdAt" DESC);

-- Existing batch rows predate credential-bound audit and are deliberately not
-- backfilled. Application hydration rejects them until the authorized
-- pre-production reset removes them.
