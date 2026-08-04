-- Pre-production lifecycle transitions predate complete authentication attribution.
-- Their identity cannot be truthfully backfilled, so remove their replay records and
-- immutable rows before making the complete actor tuple mandatory.
DELETE FROM "idempotency_records" AS replay
USING "media_artifact_lifecycle_transitions" AS transition
WHERE replay."workspaceId" = transition."workspaceId"
  AND replay."clientId" = transition."actorClientId"
  AND replay."key" = transition."idempotencyKey"
  AND replay."responseJson" = CONCAT('{"transitionId":"', transition."id"::text, '"}');

TRUNCATE TABLE "media_artifact_lifecycle_transitions";

ALTER TABLE "media_artifact_lifecycle_transitions"
  ADD COLUMN "actorCredentialId" VARCHAR(128) NOT NULL,
  ADD COLUMN "actorEnvironment" VARCHAR(16) NOT NULL,
  ADD COLUMN "actorAuthenticationKind" VARCHAR(16) NOT NULL,
  ADD COLUMN "actorContextHash" CHAR(64) NOT NULL,
  ADD COLUMN "delegatedUserId" VARCHAR(128),
  ADD COLUMN "delegatedIdentityId" VARCHAR(128),
  ADD COLUMN "workspaceRole" VARCHAR(32);

ALTER TABLE "media_artifact_lifecycle_transitions"
  ADD CONSTRAINT "media_artifact_lifecycle_actor_environment_check"
    CHECK ("actorEnvironment" IN ('sandbox', 'production')),
  ADD CONSTRAINT "media_artifact_lifecycle_actor_auth_kind_check"
    CHECK ("actorAuthenticationKind" IN ('bearer', 'ui-session')),
  ADD CONSTRAINT "media_artifact_lifecycle_actor_hash_check"
    CHECK ("actorContextHash" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "media_artifact_lifecycle_delegation_check"
    CHECK (
      ("actorAuthenticationKind" = 'bearer' AND "delegatedUserId" IS NULL AND "delegatedIdentityId" IS NULL AND "workspaceRole" IS NULL)
      OR
      ("actorAuthenticationKind" = 'ui-session' AND "delegatedUserId" IS NOT NULL AND "delegatedIdentityId" IS NOT NULL AND "workspaceRole" IN ('administrator', 'director', 'operator', 'reviewer'))
    );

CREATE INDEX "media_artifact_lifecycle_transitions_workspaceId_actorConte_idx"
  ON "media_artifact_lifecycle_transitions"("workspaceId", "actorContextHash", "createdAt" DESC);

ALTER TABLE "media_artifact_lifecycle_transitions"
  ADD CONSTRAINT "media_artifact_lifecycle_transitions_actorClientId_workspa_fkey"
  FOREIGN KEY ("actorClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
