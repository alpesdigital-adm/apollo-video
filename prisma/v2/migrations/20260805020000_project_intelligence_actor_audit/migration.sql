ALTER TABLE "speech_segment_catalog_runs"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32);

ALTER TABLE "speech_segment_catalog_runs"
  ADD CONSTRAINT "speech_segment_catalog_runs_actor_audit_check" CHECK (
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
          "delegatedUserId" IS NULL AND
          "delegatedIdentityId" IS NULL AND
          "workspaceRole" IS NULL) OR
        ("actorAuthenticationKind" = 'ui-session' AND
          "delegatedUserId" IS NOT NULL AND
          "delegatedIdentityId" IS NOT NULL AND
          "workspaceRole" IN ('administrator', 'operator', 'director', 'reviewer'))
      )
    )
  );

CREATE INDEX "speech_catalog_runs_actor_context_idx"
  ON "speech_segment_catalog_runs"("workspaceId", "actorContextHash", "createdAt" DESC);

ALTER TABLE "evidence_segments"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32);

ALTER TABLE "evidence_segments"
  ADD CONSTRAINT "evidence_segments_actor_audit_check" CHECK (
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
          "delegatedUserId" IS NULL AND
          "delegatedIdentityId" IS NULL AND
          "workspaceRole" IS NULL) OR
        ("actorAuthenticationKind" = 'ui-session' AND
          "delegatedUserId" IS NOT NULL AND
          "delegatedIdentityId" IS NOT NULL AND
          "workspaceRole" IN ('administrator', 'operator', 'director', 'reviewer'))
      )
    )
  );

CREATE INDEX "evidence_segments_actor_context_idx"
  ON "evidence_segments"("workspaceId", "actorContextHash", "createdAt" DESC);

ALTER TABLE "validated_segments"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32);

ALTER TABLE "validated_segments"
  ADD CONSTRAINT "validated_segments_actor_audit_check" CHECK (
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
          "delegatedUserId" IS NULL AND
          "delegatedIdentityId" IS NULL AND
          "workspaceRole" IS NULL) OR
        ("actorAuthenticationKind" = 'ui-session' AND
          "delegatedUserId" IS NOT NULL AND
          "delegatedIdentityId" IS NOT NULL AND
          "workspaceRole" IN ('administrator', 'operator', 'director', 'reviewer'))
      )
    )
  );

CREATE INDEX "validated_segments_actor_context_idx"
  ON "validated_segments"("workspaceId", "actorContextHash", "createdAt" DESC);

ALTER TABLE "semantic_search_documents"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32);

ALTER TABLE "semantic_search_documents"
  ADD CONSTRAINT "semantic_search_documents_actor_audit_check" CHECK (
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
          "delegatedUserId" IS NULL AND
          "delegatedIdentityId" IS NULL AND
          "workspaceRole" IS NULL) OR
        ("actorAuthenticationKind" = 'ui-session' AND
          "delegatedUserId" IS NOT NULL AND
          "delegatedIdentityId" IS NOT NULL AND
          "workspaceRole" IN ('administrator', 'operator', 'director', 'reviewer'))
      )
    )
  );

CREATE INDEX "semantic_documents_actor_context_idx"
  ON "semantic_search_documents"("workspaceId", "actorContextHash", "createdAt" DESC);

ALTER TABLE "retrieval_evaluations"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32);

ALTER TABLE "retrieval_evaluations"
  ADD CONSTRAINT "retrieval_evaluations_actor_audit_check" CHECK (
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
          "delegatedUserId" IS NULL AND
          "delegatedIdentityId" IS NULL AND
          "workspaceRole" IS NULL) OR
        ("actorAuthenticationKind" = 'ui-session' AND
          "delegatedUserId" IS NOT NULL AND
          "delegatedIdentityId" IS NOT NULL AND
          "workspaceRole" IN ('administrator', 'operator', 'director', 'reviewer'))
      )
    )
  );

CREATE INDEX "retrieval_evaluations_actor_context_idx"
  ON "retrieval_evaluations"("workspaceId", "actorContextHash", "createdAt" DESC);

ALTER TABLE "retrieval_scale_evaluations"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32);

ALTER TABLE "retrieval_scale_evaluations"
  ADD CONSTRAINT "retrieval_scale_evaluations_actor_audit_check" CHECK (
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
          "delegatedUserId" IS NULL AND
          "delegatedIdentityId" IS NULL AND
          "workspaceRole" IS NULL) OR
        ("actorAuthenticationKind" = 'ui-session' AND
          "delegatedUserId" IS NOT NULL AND
          "delegatedIdentityId" IS NOT NULL AND
          "workspaceRole" IN ('administrator', 'operator', 'director', 'reviewer'))
      )
    )
  );

CREATE INDEX "retrieval_scale_evaluations_actor_context_idx"
  ON "retrieval_scale_evaluations"("workspaceId", "actorContextHash", "createdAt" DESC);

ALTER TABLE "semantic_reuse_runs"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32);

ALTER TABLE "semantic_reuse_runs"
  ADD CONSTRAINT "semantic_reuse_runs_actor_audit_check" CHECK (
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
          "delegatedUserId" IS NULL AND
          "delegatedIdentityId" IS NULL AND
          "workspaceRole" IS NULL) OR
        ("actorAuthenticationKind" = 'ui-session' AND
          "delegatedUserId" IS NOT NULL AND
          "delegatedIdentityId" IS NOT NULL AND
          "workspaceRole" IN ('administrator', 'operator', 'director', 'reviewer'))
      )
    )
  );

CREATE INDEX "semantic_reuse_runs_actor_context_idx"
  ON "semantic_reuse_runs"("workspaceId", "actorContextHash", "createdAt" DESC);

ALTER TABLE "source_deconstruction_reports"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32);

ALTER TABLE "source_deconstruction_reports"
  ADD CONSTRAINT "source_deconstruction_reports_actor_audit_check" CHECK (
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
          "delegatedUserId" IS NULL AND
          "delegatedIdentityId" IS NULL AND
          "workspaceRole" IS NULL) OR
        ("actorAuthenticationKind" = 'ui-session' AND
          "delegatedUserId" IS NOT NULL AND
          "delegatedIdentityId" IS NOT NULL AND
          "workspaceRole" IN ('administrator', 'operator', 'director', 'reviewer'))
      )
    )
  );

CREATE INDEX "source_deconstruction_actor_context_idx"
  ON "source_deconstruction_reports"("workspaceId", "actorContextHash", "createdAt" DESC);

ALTER TABLE "contamination_reports"
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32);

ALTER TABLE "contamination_reports"
  ADD CONSTRAINT "contamination_reports_actor_audit_check" CHECK (
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
          "delegatedUserId" IS NULL AND
          "delegatedIdentityId" IS NULL AND
          "workspaceRole" IS NULL) OR
        ("actorAuthenticationKind" = 'ui-session' AND
          "delegatedUserId" IS NOT NULL AND
          "delegatedIdentityId" IS NOT NULL AND
          "workspaceRole" IN ('administrator', 'operator', 'director', 'reviewer'))
      )
    )
  );

CREATE INDEX "contamination_reports_actor_context_idx"
  ON "contamination_reports"("workspaceId", "actorContextHash", "createdAt" DESC);
