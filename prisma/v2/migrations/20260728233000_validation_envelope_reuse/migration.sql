CREATE TABLE "validation_envelope_reuses" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "batchId" VARCHAR(128) NOT NULL,
  "validatedSegmentId" VARCHAR(128) NOT NULL,
  "validatedSegmentHash" CHAR(64) NOT NULL,
  "sourceArtifactId" VARCHAR(128) NOT NULL,
  "sourceArtifactSha256" CHAR(64) NOT NULL,
  "sourceRangeStartMs" INTEGER NOT NULL,
  "sourceRangeEndMs" INTEGER NOT NULL,
  "targetRecipeId" VARCHAR(128) NOT NULL,
  "targetRecipeHash" CHAR(64) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "policyVersion" VARCHAR(64) NOT NULL,
  "objective" VARCHAR(128) NOT NULL,
  "aspectRulesJson" TEXT NOT NULL,
  "protectedAspectsText" TEXT NOT NULL,
  "mutableAspectsText" TEXT NOT NULL,
  "requestedChangesJson" TEXT NOT NULL,
  "requestedChangeCount" INTEGER NOT NULL,
  "autoProtectedChangesText" TEXT NOT NULL,
  "approvalRequiredChangesText" TEXT NOT NULL,
  "approvalRequired" BOOLEAN NOT NULL,
  "initialValidation" VARCHAR(32) NOT NULL,
  "compositionJson" TEXT NOT NULL,
  "compositionHash" CHAR(64) NOT NULL,
  "excessMaterialIncluded" BOOLEAN NOT NULL DEFAULT FALSE,
  "validatedOutsideRangeIncluded" BOOLEAN NOT NULL DEFAULT FALSE,
  "planJson" TEXT NOT NULL,
  "planHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "validation_envelope_reuses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "validation_envelope_reuses_version_check" CHECK (
    "schemaVersion" = 'validation-envelope-reuse/v1'
    AND "policyVersion" = 'validation-envelope-policy/v1'
  ),
  CONSTRAINT "validation_envelope_reuses_range_check" CHECK (
    "sourceRangeStartMs" >= 0
    AND "sourceRangeEndMs" > "sourceRangeStartMs"
  ),
  CONSTRAINT "validation_envelope_reuses_state_check" CHECK (
    "initialValidation" IN ('preserved', 'pending-approval')
    AND (
      ("approvalRequired" AND "initialValidation" = 'pending-approval')
      OR
      (NOT "approvalRequired" AND "initialValidation" = 'preserved')
    )
  ),
  CONSTRAINT "validation_envelope_reuses_content_check" CHECK (
    "requestedChangeCount" BETWEEN 0 AND 5
    AND NOT "excessMaterialIncluded"
    AND NOT "validatedOutsideRangeIncluded"
    AND length("aspectRulesJson") BETWEEN 2 AND 100000
    AND length("requestedChangesJson") BETWEEN 2 AND 100000
    AND length("compositionJson") BETWEEN 2 AND 1000000
    AND length("planJson") BETWEEN 2 AND 5000000
    AND length("idempotencyKey") BETWEEN 8 AND 128
  ),
  CONSTRAINT "validation_envelope_reuses_hash_check" CHECK (
    "validatedSegmentHash" ~ '^[a-f0-9]{64}$'
    AND "sourceArtifactSha256" ~ '^[a-f0-9]{64}$'
    AND "targetRecipeHash" ~ '^[a-f0-9]{64}$'
    AND "compositionHash" ~ '^[a-f0-9]{64}$'
    AND "planHash" ~ '^[a-f0-9]{64}$'
    AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
  )
);

CREATE UNIQUE INDEX "validation_envelope_reuses_id_workspaceId_key"
  ON "validation_envelope_reuses"("id", "workspaceId");
CREATE UNIQUE INDEX "validation_envelope_reuses_id_workspaceId_projectId_key"
  ON "validation_envelope_reuses"(
    "id",
    "workspaceId",
    "projectId"
  );
CREATE UNIQUE INDEX "validation_envelope_reuses_workspaceId_projectId_createdByC_key"
  ON "validation_envelope_reuses"(
    "workspaceId",
    "projectId",
    "createdByClientId",
    "idempotencyKey"
  );
CREATE INDEX "validation_envelope_reuses_workspaceId_projectId_createdAt__idx"
  ON "validation_envelope_reuses"(
    "workspaceId",
    "projectId",
    "createdAt" DESC,
    "id" DESC
  );
CREATE INDEX "validation_envelope_reuses_workspaceId_validatedSegmentId_c_idx"
  ON "validation_envelope_reuses"(
    "workspaceId",
    "validatedSegmentId",
    "createdAt" DESC
  );
CREATE INDEX "validation_envelope_reuses_workspaceId_targetRecipeId_creat_idx"
  ON "validation_envelope_reuses"(
    "workspaceId",
    "targetRecipeId",
    "createdAt" DESC
  );
CREATE INDEX "validation_envelope_reuses_workspaceId_batchId_createdAt_idx"
  ON "validation_envelope_reuses"(
    "workspaceId",
    "batchId",
    "createdAt" DESC
  );
CREATE INDEX "validation_envelope_reuses_workspaceId_approvalRequired_ini_idx"
  ON "validation_envelope_reuses"(
    "workspaceId",
    "approvalRequired",
    "initialValidation",
    "createdAt" DESC
  );

CREATE TABLE "validation_envelope_decisions" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "reusePlanId" VARCHAR(128) NOT NULL,
  "sequence" INTEGER NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "kind" VARCHAR(32) NOT NULL,
  "outcome" VARCHAR(32) NOT NULL,
  "validation" VARCHAR(32) NOT NULL,
  "decisionJson" TEXT NOT NULL,
  "decisionHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "actorClientId" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "validation_envelope_decisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "validation_envelope_decisions_version_check" CHECK (
    "schemaVersion" = 'validation-envelope-decision/v1'
  ),
  CONSTRAINT "validation_envelope_decisions_kind_check" CHECK (
    ("sequence" = 1 AND "kind" = 'created')
    OR
    ("sequence" = 2 AND "kind" = 'approval')
  ),
  CONSTRAINT "validation_envelope_decisions_outcome_check" CHECK (
    "outcome" IN (
      'ready',
      'approval-required',
      'approved',
      'rejected'
    )
    AND "validation" IN (
      'preserved',
      'pending-approval',
      'lost'
    )
    AND (
      ("outcome" = 'ready' AND "validation" = 'preserved')
      OR
      (
        "outcome" = 'approval-required'
        AND "validation" = 'pending-approval'
      )
      OR
      ("outcome" = 'approved' AND "validation" = 'lost')
      OR
      ("outcome" = 'rejected' AND "validation" = 'preserved')
    )
  ),
  CONSTRAINT "validation_envelope_decisions_content_check" CHECK (
    length("decisionJson") BETWEEN 2 AND 1000000
    AND length("idempotencyKey") BETWEEN 8 AND 128
  ),
  CONSTRAINT "validation_envelope_decisions_hash_check" CHECK (
    "decisionHash" ~ '^[a-f0-9]{64}$'
    AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
  )
);

CREATE UNIQUE INDEX "validation_envelope_decisions_id_workspaceId_key"
  ON "validation_envelope_decisions"("id", "workspaceId");
CREATE UNIQUE INDEX "validation_envelope_decisions_reusePlanId_sequence_key"
  ON "validation_envelope_decisions"("reusePlanId", "sequence");
CREATE UNIQUE INDEX "validation_envelope_decisions_workspaceId_projectId_actorCl_key"
  ON "validation_envelope_decisions"(
    "workspaceId",
    "projectId",
    "actorClientId",
    "idempotencyKey"
  );
CREATE INDEX "validation_envelope_decisions_workspaceId_projectId_created_idx"
  ON "validation_envelope_decisions"(
    "workspaceId",
    "projectId",
    "createdAt" DESC
  );
CREATE INDEX "validation_envelope_decisions_workspaceId_reusePlanId_seque_idx"
  ON "validation_envelope_decisions"(
    "workspaceId",
    "reusePlanId",
    "sequence"
  );
CREATE INDEX "validation_envelope_decisions_workspaceId_validation_create_idx"
  ON "validation_envelope_decisions"(
    "workspaceId",
    "validation",
    "createdAt" DESC
  );

ALTER TABLE "validation_envelope_reuses"
  ADD CONSTRAINT "validation_envelope_reuses_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "validation_envelope_reuses"
  ADD CONSTRAINT "validation_envelope_reuses_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "validation_envelope_reuses"
  ADD CONSTRAINT "validation_envelope_reuses_batchId_workspaceId_fkey"
  FOREIGN KEY ("batchId", "workspaceId")
  REFERENCES "production_batches"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "validation_envelope_reuses"
  ADD CONSTRAINT "validation_envelope_reuses_validatedSegmentId_workspaceId_fkey"
  FOREIGN KEY ("validatedSegmentId", "workspaceId")
  REFERENCES "validated_segments"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "validation_envelope_reuses"
  ADD CONSTRAINT "validation_envelope_reuses_targetRecipeId_workspaceId_fkey"
  FOREIGN KEY ("targetRecipeId", "workspaceId")
  REFERENCES "variant_recipe_runs"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "validation_envelope_reuses"
  ADD CONSTRAINT "validation_envelope_reuses_createdByClientId_workspaceId_fkey"
  FOREIGN KEY ("createdByClientId", "workspaceId")
  REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "validation_envelope_decisions"
  ADD CONSTRAINT "validation_envelope_decisions_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "validation_envelope_decisions"
  ADD CONSTRAINT "validation_envelope_decisions_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "validation_envelope_decisions"
  ADD CONSTRAINT "validation_envelope_decisions_reusePlanId_workspaceId_proj_fkey"
  FOREIGN KEY ("reusePlanId", "workspaceId", "projectId")
  REFERENCES "validation_envelope_reuses"(
    "id",
    "workspaceId",
    "projectId"
  )
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "validation_envelope_decisions"
  ADD CONSTRAINT "validation_envelope_decisions_actorClientId_workspaceId_fkey"
  FOREIGN KEY ("actorClientId", "workspaceId")
  REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
