CREATE TABLE "synthetic_script_plans" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "currentVersionId" VARCHAR(128),
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "actorCredentialId" VARCHAR(128),
  "actorEnvironment" VARCHAR(16),
  "actorAuthenticationKind" VARCHAR(16),
  "actorContextHash" CHAR(64),
  "delegatedUserId" VARCHAR(128),
  "delegatedIdentityId" VARCHAR(128),
  "workspaceRole" VARCHAR(32),
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "synthetic_script_plans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "synthetic_script_plans_schema_check" CHECK ("schemaVersion" = 'synthetic-script-plan/v1'),
  CONSTRAINT "synthetic_script_plans_fingerprint_check" CHECK ("requestFingerprint" ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX "synthetic_script_plans_id_workspaceId_key"
  ON "synthetic_script_plans"("id", "workspaceId");
CREATE UNIQUE INDEX "synthetic_script_plans_workspace_actor_key"
  ON "synthetic_script_plans"("workspaceId", "projectId", "createdByClientId", "actorContextHash", "idempotencyKey");
CREATE INDEX "synthetic_script_plans_workspace_project_created_idx"
  ON "synthetic_script_plans"("workspaceId", "projectId", "createdAt" DESC, "id" DESC);

CREATE TABLE "synthetic_script_plan_versions" (
  "id" VARCHAR(128) NOT NULL,
  "planId" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "sequence" INTEGER NOT NULL,
  "parentVersionId" VARCHAR(128),
  "projectVersionId" VARCHAR(128) NOT NULL,
  "profileSnapshotId" VARCHAR(128) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "locale" VARCHAR(35) NOT NULL,
  "segmentationVersion" VARCHAR(64) NOT NULL,
  "scriptHash" CHAR(64) NOT NULL,
  "commandType" VARCHAR(32) NOT NULL,
  "blockSequenceJson" TEXT NOT NULL,
  "impactJson" TEXT NOT NULL,
  "commandImpactHash" CHAR(64) NOT NULL,
  "planVersionHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "actorCredentialId" VARCHAR(128),
  "actorEnvironment" VARCHAR(16),
  "actorAuthenticationKind" VARCHAR(16),
  "actorContextHash" CHAR(64),
  "delegatedUserId" VARCHAR(128),
  "delegatedIdentityId" VARCHAR(128),
  "workspaceRole" VARCHAR(32),
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "synthetic_script_plan_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "synthetic_script_plan_versions_schema_check" CHECK ("schemaVersion" = 'synthetic-script-plan-version/v1'),
  CONSTRAINT "synthetic_script_plan_versions_segmentation_check" CHECK ("segmentationVersion" = 'synthetic-script-segmentation/v1'),
  CONSTRAINT "synthetic_script_plan_versions_sequence_check" CHECK ("sequence" >= 1),
  CONSTRAINT "synthetic_script_plan_versions_command_check" CHECK (
    "commandType" IN ('create-plan', 'insert-block', 'update-block', 'remove-block', 'reorder-blocks', 'set-profile', 'regenerate-block', 'compile-audio')
  ),
  CONSTRAINT "synthetic_script_plan_versions_lineage_check" CHECK (
    ("sequence" = 1 AND "parentVersionId" IS NULL AND "commandType" = 'create-plan') OR
    ("sequence" > 1 AND "parentVersionId" IS NOT NULL AND "commandType" <> 'create-plan')
  ),
  CONSTRAINT "synthetic_script_plan_versions_hash_check" CHECK (
    "scriptHash" ~ '^[a-f0-9]{64}$' AND "planVersionHash" ~ '^[a-f0-9]{64}$' AND
    "commandImpactHash" ~ '^[a-f0-9]{64}$' AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "synthetic_script_plan_versions_sequence_json_check" CHECK (jsonb_typeof("blockSequenceJson"::jsonb) = 'array'),
  CONSTRAINT "synthetic_script_plan_versions_impact_json_check" CHECK (jsonb_typeof("impactJson"::jsonb) = 'object')
);

CREATE UNIQUE INDEX "synthetic_script_plan_versions_id_workspaceId_key"
  ON "synthetic_script_plan_versions"("id", "workspaceId");
CREATE UNIQUE INDEX "synthetic_script_plan_versions_id_planId_workspaceId_key"
  ON "synthetic_script_plan_versions"("id", "planId", "workspaceId");
CREATE UNIQUE INDEX "synthetic_script_plan_versions_plan_sequence_key"
  ON "synthetic_script_plan_versions"("workspaceId", "planId", "sequence");
CREATE UNIQUE INDEX "synthetic_script_plan_versions_actor_key"
  ON "synthetic_script_plan_versions"("workspaceId", "planId", "createdByClientId", "actorContextHash", "idempotencyKey");
CREATE INDEX "synthetic_script_plan_versions_project_version_idx"
  ON "synthetic_script_plan_versions"("workspaceId", "projectId", "projectVersionId");
CREATE INDEX "synthetic_script_plan_versions_plan_created_idx"
  ON "synthetic_script_plan_versions"("workspaceId", "planId", "createdAt" DESC);

CREATE TABLE "synthetic_script_blocks" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "planId" VARCHAR(128) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "exactText" TEXT NOT NULL,
  "normalizedTextHash" CHAR(64) NOT NULL,
  "locale" VARCHAR(35) NOT NULL,
  "occurrence" INTEGER NOT NULL,
  "createdInVersionId" VARCHAR(128) NOT NULL,
  "retiredInVersionId" VARCHAR(128),
  "originKind" VARCHAR(32) NOT NULL,
  "originBlockId" VARCHAR(128),
  "blockHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "synthetic_script_blocks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "synthetic_script_blocks_schema_check" CHECK ("schemaVersion" = 'synthetic-script-block/v1'),
  CONSTRAINT "synthetic_script_blocks_text_check" CHECK (length("exactText") > 0 AND length("exactText") <= 10000),
  CONSTRAINT "synthetic_script_blocks_occurrence_check" CHECK ("occurrence" >= 1),
  CONSTRAINT "synthetic_script_blocks_origin_kind_check" CHECK ("originKind" IN ('initial-segmentation', 'inserted', 'edited')),
  CONSTRAINT "synthetic_script_blocks_origin_check" CHECK (
    ("originKind" = 'edited' AND "originBlockId" IS NOT NULL) OR
    ("originKind" = 'initial-segmentation' AND "originBlockId" IS NULL) OR
    ("originKind" = 'inserted')
  ),
  CONSTRAINT "synthetic_script_blocks_hash_check" CHECK (
    "normalizedTextHash" ~ '^[a-f0-9]{64}$' AND "blockHash" ~ '^[a-f0-9]{64}$'
  )
);

CREATE UNIQUE INDEX "synthetic_script_blocks_id_workspaceId_key"
  ON "synthetic_script_blocks"("id", "workspaceId");
CREATE INDEX "synthetic_script_blocks_plan_text_idx"
  ON "synthetic_script_blocks"("workspaceId", "planId", "normalizedTextHash", "occurrence");
CREATE INDEX "synthetic_script_blocks_plan_created_idx"
  ON "synthetic_script_blocks"("workspaceId", "planId", "createdAt" DESC, "id" DESC);

ALTER TABLE "synthetic_script_plans" ADD CONSTRAINT "synthetic_script_plans_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_script_plans" ADD CONSTRAINT "synthetic_script_plans_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "synthetic_script_plans" ADD CONSTRAINT "synthetic_script_plans_currentVersionId_id_workspaceId_fkey"
  FOREIGN KEY ("currentVersionId", "id", "workspaceId") REFERENCES "synthetic_script_plan_versions"("id", "planId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_script_plans" ADD CONSTRAINT "synthetic_script_plans_createdByClientId_workspaceId_fkey"
  FOREIGN KEY ("createdByClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "synthetic_script_plan_versions" ADD CONSTRAINT "synthetic_script_plan_versions_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_script_plan_versions" ADD CONSTRAINT "synthetic_script_plan_versions_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "synthetic_script_plan_versions" ADD CONSTRAINT "synthetic_script_plan_versions_planId_workspaceId_fkey"
  FOREIGN KEY ("planId", "workspaceId") REFERENCES "synthetic_script_plans"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "synthetic_script_plan_versions" ADD CONSTRAINT "synthetic_script_plan_versions_parentVersionId_workspaceId_fkey"
  FOREIGN KEY ("parentVersionId", "workspaceId") REFERENCES "synthetic_script_plan_versions"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_script_plan_versions" ADD CONSTRAINT "synthetic_script_plan_versions_projectVersionId_projectId__fkey"
  FOREIGN KEY ("projectVersionId", "projectId", "workspaceId") REFERENCES "project_versions"("id", "projectId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_script_plan_versions" ADD CONSTRAINT "synthetic_script_plan_versions_profileSnapshotId_workspace_fkey"
  FOREIGN KEY ("profileSnapshotId", "workspaceId") REFERENCES "synthetic_presenter_profiles"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_script_plan_versions" ADD CONSTRAINT "synthetic_script_plan_versions_createdByClientId_workspace_fkey"
  FOREIGN KEY ("createdByClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "synthetic_script_blocks" ADD CONSTRAINT "synthetic_script_blocks_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_script_blocks" ADD CONSTRAINT "synthetic_script_blocks_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "synthetic_script_blocks" ADD CONSTRAINT "synthetic_script_blocks_planId_workspaceId_fkey"
  FOREIGN KEY ("planId", "workspaceId") REFERENCES "synthetic_script_plans"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "synthetic_script_blocks" ADD CONSTRAINT "synthetic_script_blocks_createdInVersionId_workspaceId_fkey"
  FOREIGN KEY ("createdInVersionId", "workspaceId") REFERENCES "synthetic_script_plan_versions"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_script_blocks" ADD CONSTRAINT "synthetic_script_blocks_retiredInVersionId_workspaceId_fkey"
  FOREIGN KEY ("retiredInVersionId", "workspaceId") REFERENCES "synthetic_script_plan_versions"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_script_blocks" ADD CONSTRAINT "synthetic_script_blocks_originBlockId_workspaceId_fkey"
  FOREIGN KEY ("originBlockId", "workspaceId") REFERENCES "synthetic_script_blocks"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
