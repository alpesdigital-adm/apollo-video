CREATE TABLE "story_plans" (
  "id" VARCHAR(128) PRIMARY KEY,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "projectVersionId" VARCHAR(128) NOT NULL,
  "schemaVersion" INTEGER NOT NULL,
  "treatmentPlanId" VARCHAR(128) NOT NULL,
  "treatmentSchemaVersion" INTEGER NOT NULL,
  "treatmentContentHash" CHAR(64) NOT NULL,
  "storyJson" TEXT NOT NULL,
  "storyHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(128) NOT NULL,
  "actorCredentialId" VARCHAR(128),
  "actorEnvironment" VARCHAR(16),
  "actorAuthenticationKind" VARCHAR(16),
  "actorContextHash" CHAR(64),
  "delegatedUserId" VARCHAR(128),
  "delegatedIdentityId" VARCHAR(128),
  "workspaceRole" VARCHAR(32),
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "story_plans_workspace_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT,
  CONSTRAINT "story_plans_project_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE,
  CONSTRAINT "story_plans_project_version_fkey" FOREIGN KEY ("projectVersionId", "projectId") REFERENCES "project_versions"("id", "projectId") ON DELETE RESTRICT,
  CONSTRAINT "story_plans_created_by_client_fkey" FOREIGN KEY ("createdByClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT,
  CONSTRAINT "story_plans_schema_check" CHECK ("schemaVersion" = 3),
  CONSTRAINT "story_plans_treatment_schema_check" CHECK ("treatmentSchemaVersion" > 0),
  CONSTRAINT "story_plans_hash_check" CHECK ("storyHash" ~ '^[a-f0-9]{64}$' AND "treatmentContentHash" ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX "story_plans_actor_idempotency_key" ON "story_plans"("workspaceId", "projectId", "createdByClientId", "idempotencyKey");
CREATE UNIQUE INDEX "story_plans_id_workspace_project_key" ON "story_plans"("id", "workspaceId", "projectId");
CREATE UNIQUE INDEX "story_plans_id_workspace_project_hash_key" ON "story_plans"("id", "workspaceId", "projectId", "storyHash");
CREATE INDEX "story_plans_project_version_created_idx" ON "story_plans"("workspaceId", "projectId", "projectVersionId", "createdAt" DESC);
