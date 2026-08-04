-- Collaborative review mutations preserve the initiating credential and, for
-- annotations, bind the public author projection to that authenticated tuple.
-- Historical rows remain explicitly unattributed and are rejected by runtime
-- hydration until the authorized pre-production reset.
ALTER TABLE "review_annotations"
  ADD COLUMN "actorClientId" VARCHAR(80),
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32),
  ADD CONSTRAINT "review_annotations_actor_audit_check" CHECK (
    (
      "actorClientId" IS NULL AND "actorCredentialId" IS NULL AND
      "actorEnvironment" IS NULL AND "actorAuthenticationKind" IS NULL AND
      "actorContextHash" IS NULL AND "delegatedUserId" IS NULL AND
      "delegatedIdentityId" IS NULL AND "workspaceRole" IS NULL
    ) OR (
      "actorClientId" IS NOT NULL AND "actorCredentialId" IS NOT NULL AND
      "actorEnvironment" IS NOT NULL AND
      "actorEnvironment" IN ('sandbox', 'production') AND
      "actorAuthenticationKind" IS NOT NULL AND
      "actorAuthenticationKind" IN ('bearer', 'ui-session') AND
      "actorContextHash" IS NOT NULL AND
      "actorContextHash" ~ '^[a-f0-9]{64}$' AND
      (
        ("actorAuthenticationKind" = 'bearer' AND
          "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND
          "workspaceRole" IS NULL AND "authorType" = 'api-client' AND
          "authorId" = "actorClientId" AND "authorName" = "actorClientId") OR
        ("actorAuthenticationKind" = 'ui-session' AND
          "delegatedUserId" IS NOT NULL AND "delegatedIdentityId" IS NOT NULL AND
          "workspaceRole" IS NOT NULL AND
          "workspaceRole" IN ('administrator', 'director', 'operator', 'reviewer') AND
          "authorType" = 'user' AND "authorId" = "delegatedUserId" AND
          "authorName" = "delegatedUserId")
      )
    )
  ),
  ADD CONSTRAINT "review_annotations_actor_fkey"
    FOREIGN KEY ("actorClientId", "workspaceId")
    REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT;

CREATE INDEX "review_annotations_actor_context_idx"
  ON "review_annotations"("workspaceId", "actorContextHash", "createdAt" DESC);

ALTER TABLE "review_patch_proposals"
  ADD COLUMN "actorClientId" VARCHAR(80),
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32),
  ADD CONSTRAINT "review_patch_proposals_actor_audit_check" CHECK (
    (
      "actorClientId" IS NULL AND "actorCredentialId" IS NULL AND
      "actorEnvironment" IS NULL AND "actorAuthenticationKind" IS NULL AND
      "actorContextHash" IS NULL AND "delegatedUserId" IS NULL AND
      "delegatedIdentityId" IS NULL AND "workspaceRole" IS NULL
    ) OR (
      "actorClientId" IS NOT NULL AND "actorCredentialId" IS NOT NULL AND
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
          "workspaceRole" IS NOT NULL AND
          "workspaceRole" IN ('administrator', 'director', 'operator', 'reviewer'))
      )
    )
  ),
  ADD CONSTRAINT "review_patch_proposals_actor_fkey"
    FOREIGN KEY ("actorClientId", "workspaceId")
    REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT;

CREATE INDEX "review_patch_proposals_actor_context_idx"
  ON "review_patch_proposals"("workspaceId", "actorContextHash", "createdAt" DESC);

ALTER TABLE "review_patch_batches"
  ADD COLUMN "actorClientId" VARCHAR(80),
  ADD COLUMN "actorCredentialId" VARCHAR(128),
  ADD COLUMN "actorEnvironment" VARCHAR(16),
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16),
  ADD COLUMN "actorContextHash" CHAR(64),
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32),
  ADD CONSTRAINT "review_patch_batches_actor_audit_check" CHECK (
    (
      "actorClientId" IS NULL AND "actorCredentialId" IS NULL AND
      "actorEnvironment" IS NULL AND "actorAuthenticationKind" IS NULL AND
      "actorContextHash" IS NULL AND "delegatedUserId" IS NULL AND
      "delegatedIdentityId" IS NULL AND "workspaceRole" IS NULL
    ) OR (
      "actorClientId" IS NOT NULL AND "actorCredentialId" IS NOT NULL AND
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
          "workspaceRole" IS NOT NULL AND
          "workspaceRole" IN ('administrator', 'director', 'operator', 'reviewer'))
      )
    )
  ),
  ADD CONSTRAINT "review_patch_batches_actor_fkey"
    FOREIGN KEY ("actorClientId", "workspaceId")
    REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT;

CREATE INDEX "review_patch_batches_actor_context_idx"
  ON "review_patch_batches"("workspaceId", "actorContextHash", "createdAt" DESC);
