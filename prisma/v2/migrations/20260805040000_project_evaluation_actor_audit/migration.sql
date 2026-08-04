-- These project-evaluation records are externally initiated. Historical rows
-- remain unattributed rather than receiving an invented credential/member;
-- every current Application path fails closed unless the complete tuple exists.
ALTER TABLE "color_pipeline_compilations"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32),
  ADD CONSTRAINT "color_pipeline_compilations_actor_audit_check" CHECK (
    (
      "actorCredentialId" IS NULL AND "actorEnvironment" IS NULL AND
      "actorAuthenticationKind" IS NULL AND "actorContextHash" IS NULL AND
      "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
      "workspaceRole" IS NULL
    ) OR (
      "actorCredentialId" IS NOT NULL AND
      "actorEnvironment" IS NOT NULL AND
      "actorEnvironment" IN ('sandbox', 'production') AND
      "actorAuthenticationKind" IS NOT NULL AND
      "actorAuthenticationKind" IN ('bearer', 'ui-session') AND
      "actorContextHash" IS NOT NULL AND
      "actorContextHash" ~ '^[a-f0-9]{64}$' AND
      (
        ("actorAuthenticationKind" = 'bearer' AND
          "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
          "workspaceRole" IS NULL) OR
        ("actorAuthenticationKind" = 'ui-session' AND
          "delegatedUserId" IS NOT NULL AND "delegatedIdentityId" IS NOT NULL AND
          "workspaceRole" IN ('administrator', 'director', 'operator', 'reviewer'))
      )
    )
  );

CREATE INDEX "color_pipeline_compilations_workspaceId_actorContextHash_cr_idx"
  ON "color_pipeline_compilations"("workspaceId", "actorContextHash", "createdAt" DESC);

ALTER TABLE "asset_selections"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32),
  ADD CONSTRAINT "asset_selections_actor_audit_check" CHECK (
    (
      "actorCredentialId" IS NULL AND "actorEnvironment" IS NULL AND
      "actorAuthenticationKind" IS NULL AND "actorContextHash" IS NULL AND
      "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
      "workspaceRole" IS NULL
    ) OR (
      "actorCredentialId" IS NOT NULL AND
      "actorEnvironment" IS NOT NULL AND
      "actorEnvironment" IN ('sandbox', 'production') AND
      "actorAuthenticationKind" IS NOT NULL AND
      "actorAuthenticationKind" IN ('bearer', 'ui-session') AND
      "actorContextHash" IS NOT NULL AND
      "actorContextHash" ~ '^[a-f0-9]{64}$' AND
      (
        ("actorAuthenticationKind" = 'bearer' AND
          "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
          "workspaceRole" IS NULL) OR
        ("actorAuthenticationKind" = 'ui-session' AND
          "delegatedUserId" IS NOT NULL AND "delegatedIdentityId" IS NOT NULL AND
          "workspaceRole" IN ('administrator', 'director', 'operator', 'reviewer'))
      )
    )
  );

CREATE INDEX "asset_selections_workspaceId_actorContextHash_createdAt_idx"
  ON "asset_selections"("workspaceId", "actorContextHash", "createdAt" DESC);

ALTER TABLE "quality_iterations"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32),
  ADD CONSTRAINT "quality_iterations_actor_audit_check" CHECK (
    (
      "actorCredentialId" IS NULL AND "actorEnvironment" IS NULL AND
      "actorAuthenticationKind" IS NULL AND "actorContextHash" IS NULL AND
      "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
      "workspaceRole" IS NULL
    ) OR (
      "actorCredentialId" IS NOT NULL AND
      "actorEnvironment" IS NOT NULL AND
      "actorEnvironment" IN ('sandbox', 'production') AND
      "actorAuthenticationKind" IS NOT NULL AND
      "actorAuthenticationKind" IN ('bearer', 'ui-session') AND
      "actorContextHash" IS NOT NULL AND
      "actorContextHash" ~ '^[a-f0-9]{64}$' AND
      (
        ("actorAuthenticationKind" = 'bearer' AND
          "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
          "workspaceRole" IS NULL) OR
        ("actorAuthenticationKind" = 'ui-session' AND
          "delegatedUserId" IS NOT NULL AND "delegatedIdentityId" IS NOT NULL AND
          "workspaceRole" IN ('administrator', 'director', 'operator', 'reviewer'))
      )
    )
  );

CREATE INDEX "quality_iterations_workspaceId_actorContextHash_createdAt_idx"
  ON "quality_iterations"("workspaceId", "actorContextHash", "createdAt" DESC);

ALTER TABLE "mvp_core_gates"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32),
  ADD CONSTRAINT "mvp_core_gates_actor_audit_check" CHECK (
    (
      "actorCredentialId" IS NULL AND "actorEnvironment" IS NULL AND
      "actorAuthenticationKind" IS NULL AND "actorContextHash" IS NULL AND
      "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
      "workspaceRole" IS NULL
    ) OR (
      "actorCredentialId" IS NOT NULL AND
      "actorEnvironment" IS NOT NULL AND
      "actorEnvironment" IN ('sandbox', 'production') AND
      "actorAuthenticationKind" IS NOT NULL AND
      "actorAuthenticationKind" IN ('bearer', 'ui-session') AND
      "actorContextHash" IS NOT NULL AND
      "actorContextHash" ~ '^[a-f0-9]{64}$' AND
      (
        ("actorAuthenticationKind" = 'bearer' AND
          "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
          "workspaceRole" IS NULL) OR
        ("actorAuthenticationKind" = 'ui-session' AND
          "delegatedUserId" IS NOT NULL AND "delegatedIdentityId" IS NOT NULL AND
          "workspaceRole" IN ('administrator', 'director', 'operator', 'reviewer'))
      )
    )
  );

CREATE INDEX "mvp_core_gates_workspaceId_actorContextHash_createdAt_idx"
  ON "mvp_core_gates"("workspaceId", "actorContextHash", "createdAt" DESC);

ALTER TABLE "proxy_review_decisions"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32),
  ADD CONSTRAINT "proxy_review_decisions_actor_audit_check" CHECK (
    (
      "actorCredentialId" IS NULL AND "actorEnvironment" IS NULL AND
      "actorAuthenticationKind" IS NULL AND "actorContextHash" IS NULL AND
      "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
      "workspaceRole" IS NULL
    ) OR (
      "actorCredentialId" IS NOT NULL AND
      "actorEnvironment" IS NOT NULL AND
      "actorEnvironment" IN ('sandbox', 'production') AND
      "actorAuthenticationKind" IS NOT NULL AND
      "actorAuthenticationKind" IN ('bearer', 'ui-session') AND
      "actorContextHash" IS NOT NULL AND
      "actorContextHash" ~ '^[a-f0-9]{64}$' AND
      (
        ("actorAuthenticationKind" = 'bearer' AND
          "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
          "workspaceRole" IS NULL) OR
        ("actorAuthenticationKind" = 'ui-session' AND
          "delegatedUserId" IS NOT NULL AND "delegatedIdentityId" IS NOT NULL AND
          "workspaceRole" IN ('administrator', 'director', 'operator', 'reviewer'))
      )
    )
  );

CREATE INDEX "proxy_review_decisions_workspaceId_actorContextHash_created_idx"
  ON "proxy_review_decisions"("workspaceId", "actorContextHash", "createdAt" DESC);

ALTER TABLE "contiguous_extractions"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32),
  ADD CONSTRAINT "contiguous_extractions_actor_audit_check" CHECK (
    (
      "actorCredentialId" IS NULL AND "actorEnvironment" IS NULL AND
      "actorAuthenticationKind" IS NULL AND "actorContextHash" IS NULL AND
      "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
      "workspaceRole" IS NULL
    ) OR (
      "actorCredentialId" IS NOT NULL AND
      "actorEnvironment" IS NOT NULL AND
      "actorEnvironment" IN ('sandbox', 'production') AND
      "actorAuthenticationKind" IS NOT NULL AND
      "actorAuthenticationKind" IN ('bearer', 'ui-session') AND
      "actorContextHash" IS NOT NULL AND
      "actorContextHash" ~ '^[a-f0-9]{64}$' AND
      (
        ("actorAuthenticationKind" = 'bearer' AND
          "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
          "workspaceRole" IS NULL) OR
        ("actorAuthenticationKind" = 'ui-session' AND
          "delegatedUserId" IS NOT NULL AND "delegatedIdentityId" IS NOT NULL AND
          "workspaceRole" IN ('administrator', 'director', 'operator', 'reviewer'))
      )
    )
  );

CREATE INDEX "contiguous_extractions_workspaceId_actorContextHash_created_idx"
  ON "contiguous_extractions"("workspaceId", "actorContextHash", "createdAt" DESC);

ALTER TABLE "validation_envelope_reuses"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32),
  ADD CONSTRAINT "validation_envelope_reuses_actor_audit_check" CHECK (
    (
      "actorCredentialId" IS NULL AND "actorEnvironment" IS NULL AND
      "actorAuthenticationKind" IS NULL AND "actorContextHash" IS NULL AND
      "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
      "workspaceRole" IS NULL
    ) OR (
      "actorCredentialId" IS NOT NULL AND
      "actorEnvironment" IS NOT NULL AND
      "actorEnvironment" IN ('sandbox', 'production') AND
      "actorAuthenticationKind" IS NOT NULL AND
      "actorAuthenticationKind" IN ('bearer', 'ui-session') AND
      "actorContextHash" IS NOT NULL AND
      "actorContextHash" ~ '^[a-f0-9]{64}$' AND
      (
        ("actorAuthenticationKind" = 'bearer' AND
          "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
          "workspaceRole" IS NULL) OR
        ("actorAuthenticationKind" = 'ui-session' AND
          "delegatedUserId" IS NOT NULL AND "delegatedIdentityId" IS NOT NULL AND
          "workspaceRole" IN ('administrator', 'director', 'operator', 'reviewer'))
      )
    )
  );

CREATE INDEX "validation_envelope_reuses_workspaceId_actorContextHash_cre_idx"
  ON "validation_envelope_reuses"("workspaceId", "actorContextHash", "createdAt" DESC);

ALTER TABLE "validation_envelope_decisions"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32),
  ADD CONSTRAINT "validation_envelope_decisions_actor_audit_check" CHECK (
    (
      "actorCredentialId" IS NULL AND "actorEnvironment" IS NULL AND
      "actorAuthenticationKind" IS NULL AND "actorContextHash" IS NULL AND
      "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
      "workspaceRole" IS NULL
    ) OR (
      "actorCredentialId" IS NOT NULL AND
      "actorEnvironment" IS NOT NULL AND
      "actorEnvironment" IN ('sandbox', 'production') AND
      "actorAuthenticationKind" IS NOT NULL AND
      "actorAuthenticationKind" IN ('bearer', 'ui-session') AND
      "actorContextHash" IS NOT NULL AND
      "actorContextHash" ~ '^[a-f0-9]{64}$' AND
      (
        ("actorAuthenticationKind" = 'bearer' AND
          "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
          "workspaceRole" IS NULL) OR
        ("actorAuthenticationKind" = 'ui-session' AND
          "delegatedUserId" IS NOT NULL AND "delegatedIdentityId" IS NOT NULL AND
          "workspaceRole" IN ('administrator', 'director', 'operator', 'reviewer'))
      )
    )
  );

CREATE INDEX "validation_envelope_decisions_workspaceId_actorContextHash__idx"
  ON "validation_envelope_decisions"("workspaceId", "actorContextHash", "createdAt" DESC);

ALTER TABLE "proof_need_runs"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32),
  ADD CONSTRAINT "proof_need_runs_actor_audit_check" CHECK (
    (
      "actorCredentialId" IS NULL AND "actorEnvironment" IS NULL AND
      "actorAuthenticationKind" IS NULL AND "actorContextHash" IS NULL AND
      "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
      "workspaceRole" IS NULL
    ) OR (
      "actorCredentialId" IS NOT NULL AND
      "actorEnvironment" IS NOT NULL AND
      "actorEnvironment" IN ('sandbox', 'production') AND
      "actorAuthenticationKind" IS NOT NULL AND
      "actorAuthenticationKind" IN ('bearer', 'ui-session') AND
      "actorContextHash" IS NOT NULL AND
      "actorContextHash" ~ '^[a-f0-9]{64}$' AND
      (
        ("actorAuthenticationKind" = 'bearer' AND
          "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
          "workspaceRole" IS NULL) OR
        ("actorAuthenticationKind" = 'ui-session' AND
          "delegatedUserId" IS NOT NULL AND "delegatedIdentityId" IS NOT NULL AND
          "workspaceRole" IN ('administrator', 'director', 'operator', 'reviewer'))
      )
    )
  );

CREATE INDEX "proof_need_runs_workspaceId_actorContextHash_createdAt_idx"
  ON "proof_need_runs"("workspaceId", "actorContextHash", "createdAt" DESC);

ALTER TABLE "proof_integrity_runs"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32),
  ADD CONSTRAINT "proof_integrity_runs_actor_audit_check" CHECK (
    (
      "actorCredentialId" IS NULL AND "actorEnvironment" IS NULL AND
      "actorAuthenticationKind" IS NULL AND "actorContextHash" IS NULL AND
      "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
      "workspaceRole" IS NULL
    ) OR (
      "actorCredentialId" IS NOT NULL AND
      "actorEnvironment" IS NOT NULL AND
      "actorEnvironment" IN ('sandbox', 'production') AND
      "actorAuthenticationKind" IS NOT NULL AND
      "actorAuthenticationKind" IN ('bearer', 'ui-session') AND
      "actorContextHash" IS NOT NULL AND
      "actorContextHash" ~ '^[a-f0-9]{64}$' AND
      (
        ("actorAuthenticationKind" = 'bearer' AND
          "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
          "workspaceRole" IS NULL) OR
        ("actorAuthenticationKind" = 'ui-session' AND
          "delegatedUserId" IS NOT NULL AND "delegatedIdentityId" IS NOT NULL AND
          "workspaceRole" IN ('administrator', 'director', 'operator', 'reviewer'))
      )
    )
  );

CREATE INDEX "proof_integrity_runs_workspaceId_actorContextHash_createdAt_idx"
  ON "proof_integrity_runs"("workspaceId", "actorContextHash", "createdAt" DESC);

ALTER TABLE "proof_mode_runs"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32),
  ADD CONSTRAINT "proof_mode_runs_actor_audit_check" CHECK (
    (
      "actorCredentialId" IS NULL AND "actorEnvironment" IS NULL AND
      "actorAuthenticationKind" IS NULL AND "actorContextHash" IS NULL AND
      "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
      "workspaceRole" IS NULL
    ) OR (
      "actorCredentialId" IS NOT NULL AND
      "actorEnvironment" IS NOT NULL AND
      "actorEnvironment" IN ('sandbox', 'production') AND
      "actorAuthenticationKind" IS NOT NULL AND
      "actorAuthenticationKind" IN ('bearer', 'ui-session') AND
      "actorContextHash" IS NOT NULL AND
      "actorContextHash" ~ '^[a-f0-9]{64}$' AND
      (
        ("actorAuthenticationKind" = 'bearer' AND
          "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
          "workspaceRole" IS NULL) OR
        ("actorAuthenticationKind" = 'ui-session' AND
          "delegatedUserId" IS NOT NULL AND "delegatedIdentityId" IS NOT NULL AND
          "workspaceRole" IN ('administrator', 'director', 'operator', 'reviewer'))
      )
    )
  );

CREATE INDEX "proof_mode_runs_workspaceId_actorContextHash_createdAt_idx"
  ON "proof_mode_runs"("workspaceId", "actorContextHash", "createdAt" DESC);
