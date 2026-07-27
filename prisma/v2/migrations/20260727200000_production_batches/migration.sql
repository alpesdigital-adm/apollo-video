CREATE TABLE "production_batches" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "policyVersion" VARCHAR(64) NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "objective" VARCHAR(128) NOT NULL,
  "aggregateStatus" VARCHAR(32) NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "sourceGroupsJson" TEXT NOT NULL,
  "recipesJson" TEXT NOT NULL,
  "variantsJson" TEXT NOT NULL,
  "budgetJson" TEXT NOT NULL,
  "maxCostMinorUnits" INTEGER NOT NULL,
  "reservedCostMinorUnits" INTEGER NOT NULL,
  "itemCount" INTEGER NOT NULL,
  "definitionHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "production_batches_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "production_batches_version_check" CHECK (
    "schemaVersion" = 'production-batch/v1'
    AND "policyVersion" = 'production-batch/v1'
  ),
  CONSTRAINT "production_batches_status_check" CHECK (
    "aggregateStatus" IN (
      'queued',
      'running',
      'review',
      'partially-completed',
      'completed',
      'failed',
      'cancelled'
    )
  ),
  CONSTRAINT "production_batches_bounds_check" CHECK (
    "revision" BETWEEN 1 AND 1000000
    AND "maxCostMinorUnits" BETWEEN 0 AND 100000000
    AND "reservedCostMinorUnits" BETWEEN 0 AND "maxCostMinorUnits"
    AND "itemCount" BETWEEN 1 AND 1000
    AND "updatedAt" >= "createdAt"
  ),
  CONSTRAINT "production_batches_hash_check" CHECK (
    "definitionHash" ~ '^[a-f0-9]{64}$'
    AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "production_batches_json_check" CHECK (
    length("sourceGroupsJson") BETWEEN 2 AND 10000000
    AND length("recipesJson") BETWEEN 2 AND 10000000
    AND length("variantsJson") BETWEEN 2 AND 1000000
    AND length("budgetJson") BETWEEN 2 AND 10000
  )
);

CREATE UNIQUE INDEX "production_batches_id_workspaceId_key"
  ON "production_batches"("id", "workspaceId");
CREATE UNIQUE INDEX "production_batches_workspaceId_createdByClientId_idempotenc_key"
  ON "production_batches"(
    "workspaceId",
    "createdByClientId",
    "idempotencyKey"
  );
CREATE INDEX "production_batches_workspaceId_aggregateStatus_createdAt_id_idx"
  ON "production_batches"(
    "workspaceId",
    "aggregateStatus",
    "createdAt" DESC,
    "id" DESC
  );
CREATE INDEX "production_batches_workspaceId_projectId_createdAt_id_idx"
  ON "production_batches"(
    "workspaceId",
    "projectId",
    "createdAt" DESC,
    "id" DESC
  );
CREATE INDEX "production_batches_workspaceId_objective_createdAt_idx"
  ON "production_batches"(
    "workspaceId",
    "objective",
    "createdAt" DESC
  );

CREATE TABLE "production_batch_items" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "batchId" VARCHAR(128) NOT NULL,
  "sequence" INTEGER NOT NULL,
  "key" VARCHAR(128) NOT NULL,
  "sourceGroupId" VARCHAR(128) NOT NULL,
  "recipeId" VARCHAR(128) NOT NULL,
  "variantId" VARCHAR(128) NOT NULL,
  "state" VARCHAR(32) NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "retryCount" INTEGER NOT NULL DEFAULT 0,
  "errorCode" VARCHAR(128),
  "errorMessage" VARCHAR(500),
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  "itemHash" CHAR(64) NOT NULL,

  CONSTRAINT "production_batch_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "production_batch_items_state_check" CHECK (
    "state" IN (
      'queued',
      'planning',
      'materializing',
      'rendering',
      'reviewing',
      'completed',
      'failed',
      'cancelled',
      'superseded'
    )
  ),
  CONSTRAINT "production_batch_items_bounds_check" CHECK (
    "revision" BETWEEN 1 AND 1000000
    AND "retryCount" BETWEEN 0 AND 10000
    AND "sequence" BETWEEN 0 AND 999
    AND "updatedAt" >= "createdAt"
    AND "itemHash" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "production_batch_items_error_check" CHECK (
    (
      "state" = 'failed'
      AND "errorCode" IS NOT NULL
      AND "errorMessage" IS NOT NULL
    )
    OR (
      "state" <> 'failed'
      AND "errorCode" IS NULL
      AND "errorMessage" IS NULL
    )
  )
);

CREATE UNIQUE INDEX "production_batch_items_id_workspaceId_batchId_key"
  ON "production_batch_items"("id", "workspaceId", "batchId");
CREATE UNIQUE INDEX "production_batch_items_batchId_sequence_key"
  ON "production_batch_items"("batchId", "sequence");
CREATE UNIQUE INDEX "production_batch_items_batchId_key_key"
  ON "production_batch_items"("batchId", "key");
CREATE UNIQUE INDEX "production_batch_items_batchId_sourceGroupId_recipeId_varia_key"
  ON "production_batch_items"(
    "batchId",
    "sourceGroupId",
    "recipeId",
    "variantId"
  );
CREATE INDEX "production_batch_items_workspaceId_batchId_state_updatedAt_idx"
  ON "production_batch_items"(
    "workspaceId",
    "batchId",
    "state",
    "updatedAt" DESC
  );
CREATE INDEX "production_batch_items_workspaceId_recipeId_variantId_idx"
  ON "production_batch_items"(
    "workspaceId",
    "recipeId",
    "variantId"
  );

CREATE TABLE "production_batch_steps" (
  "workspaceId" VARCHAR(128) NOT NULL,
  "batchId" VARCHAR(128) NOT NULL,
  "itemId" VARCHAR(128) NOT NULL,
  "step" VARCHAR(32) NOT NULL,
  "sequence" INTEGER NOT NULL,
  "state" VARCHAR(16) NOT NULL,
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "costMinorUnits" INTEGER NOT NULL DEFAULT 0,
  "cacheHit" BOOLEAN NOT NULL DEFAULT FALSE,
  "errorCode" VARCHAR(128),
  "errorMessage" VARCHAR(500),
  "stepHash" CHAR(64) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "production_batch_steps_pkey"
    PRIMARY KEY ("itemId", "step"),
  CONSTRAINT "production_batch_steps_identity_check" CHECK (
    (
      "step" = 'planning'
      AND "sequence" = 0
    )
    OR (
      "step" = 'materializing'
      AND "sequence" = 1
    )
    OR (
      "step" = 'rendering'
      AND "sequence" = 2
    )
    OR (
      "step" = 'reviewing'
      AND "sequence" = 3
    )
  ),
  CONSTRAINT "production_batch_steps_state_check" CHECK (
    "state" IN (
      'queued',
      'running',
      'completed',
      'failed',
      'cancelled'
    )
  ),
  CONSTRAINT "production_batch_steps_bounds_check" CHECK (
    "attempt" BETWEEN 0 AND 10000
    AND "costMinorUnits" BETWEEN 0 AND 100000000
    AND "stepHash" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "production_batch_steps_error_check" CHECK (
    (
      "state" = 'failed'
      AND "errorCode" IS NOT NULL
      AND "errorMessage" IS NOT NULL
    )
    OR (
      "state" <> 'failed'
      AND "errorCode" IS NULL
      AND "errorMessage" IS NULL
    )
  )
);

CREATE UNIQUE INDEX "production_batch_steps_workspaceId_batchId_itemId_sequence_key"
  ON "production_batch_steps"(
    "workspaceId",
    "batchId",
    "itemId",
    "sequence"
  );
CREATE INDEX "production_batch_steps_workspaceId_batchId_state_sequence_idx"
  ON "production_batch_steps"(
    "workspaceId",
    "batchId",
    "state",
    "sequence"
  );

CREATE TABLE "production_batch_item_artifacts" (
  "workspaceId" VARCHAR(128) NOT NULL,
  "batchId" VARCHAR(128) NOT NULL,
  "itemId" VARCHAR(128) NOT NULL,
  "artifactId" VARCHAR(128) NOT NULL,
  "sequence" INTEGER NOT NULL,
  "attachedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "production_batch_item_artifacts_pkey"
    PRIMARY KEY ("itemId", "artifactId"),
  CONSTRAINT "production_batch_item_artifacts_sequence_check" CHECK (
    "sequence" BETWEEN 0 AND 9999
  )
);

CREATE UNIQUE INDEX "production_batch_item_artifacts_itemId_sequence_key"
  ON "production_batch_item_artifacts"("itemId", "sequence");
CREATE INDEX "production_batch_item_artifacts_workspaceId_batchId_artifac_idx"
  ON "production_batch_item_artifacts"(
    "workspaceId",
    "batchId",
    "artifactId"
  );

CREATE TABLE "production_batch_actions" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "batchId" VARCHAR(128) NOT NULL,
  "itemId" VARCHAR(128),
  "scope" VARCHAR(16) NOT NULL,
  "action" VARCHAR(32) NOT NULL,
  "step" VARCHAR(32),
  "expectedBatchRevision" INTEGER NOT NULL,
  "expectedItemRevision" INTEGER,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "responseJson" TEXT NOT NULL,
  "actorClientId" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "production_batch_actions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "production_batch_actions_scope_check" CHECK (
    (
      "scope" = 'batch'
      AND "itemId" IS NULL
      AND "expectedItemRevision" IS NULL
      AND "action" IN ('cancel', 'resume')
      AND "step" IS NULL
    )
    OR (
      "scope" = 'item'
      AND "itemId" IS NOT NULL
      AND "expectedItemRevision" IS NOT NULL
      AND "action" IN (
        'start-step',
        'complete-step',
        'fail-step',
        'cancel',
        'resume',
        'retry-step'
      )
      AND (
        (
          "action" IN (
            'start-step',
            'complete-step',
            'fail-step',
            'retry-step'
          )
          AND "step" IS NOT NULL
        )
        OR (
          "action" IN ('cancel', 'resume')
          AND "step" IS NULL
        )
      )
    )
  ),
  CONSTRAINT "production_batch_actions_bounds_check" CHECK (
    "expectedBatchRevision" BETWEEN 1 AND 1000000
    AND (
      "expectedItemRevision" IS NULL
      OR "expectedItemRevision" BETWEEN 1 AND 1000000
    )
    AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
    AND length("responseJson") BETWEEN 2 AND 50000000
  )
);

CREATE UNIQUE INDEX "production_batch_actions_workspaceId_actorClientId_idempote_key"
  ON "production_batch_actions"(
    "workspaceId",
    "actorClientId",
    "idempotencyKey"
  );
CREATE INDEX "production_batch_actions_workspaceId_batchId_createdAt_idx"
  ON "production_batch_actions"(
    "workspaceId",
    "batchId",
    "createdAt" DESC
  );
CREATE INDEX "production_batch_actions_workspaceId_itemId_createdAt_idx"
  ON "production_batch_actions"(
    "workspaceId",
    "itemId",
    "createdAt" DESC
  );

ALTER TABLE "production_batches"
  ADD CONSTRAINT "production_batches_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production_batches"
  ADD CONSTRAINT "production_batches_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "production_batches"
  ADD CONSTRAINT "production_batches_createdByClientId_workspaceId_fkey"
  FOREIGN KEY ("createdByClientId", "workspaceId")
  REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "production_batch_items"
  ADD CONSTRAINT "production_batch_items_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production_batch_items"
  ADD CONSTRAINT "production_batch_items_batchId_workspaceId_fkey"
  FOREIGN KEY ("batchId", "workspaceId")
  REFERENCES "production_batches"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "production_batch_steps"
  ADD CONSTRAINT "production_batch_steps_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production_batch_steps"
  ADD CONSTRAINT "production_batch_steps_itemId_workspaceId_batchId_fkey"
  FOREIGN KEY ("itemId", "workspaceId", "batchId")
  REFERENCES "production_batch_items"("id", "workspaceId", "batchId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "production_batch_item_artifacts"
  ADD CONSTRAINT "production_batch_item_artifacts_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production_batch_item_artifacts"
  ADD CONSTRAINT "production_batch_item_artifacts_itemId_workspaceId_batchId_fkey"
  FOREIGN KEY ("itemId", "workspaceId", "batchId")
  REFERENCES "production_batch_items"("id", "workspaceId", "batchId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "production_batch_item_artifacts"
  ADD CONSTRAINT "production_batch_item_artifacts_artifactId_workspaceId_fkey"
  FOREIGN KEY ("artifactId", "workspaceId")
  REFERENCES "media_artifacts"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "production_batch_actions"
  ADD CONSTRAINT "production_batch_actions_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production_batch_actions"
  ADD CONSTRAINT "production_batch_actions_batchId_workspaceId_fkey"
  FOREIGN KEY ("batchId", "workspaceId")
  REFERENCES "production_batches"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "production_batch_actions"
  ADD CONSTRAINT "production_batch_actions_itemId_fkey"
  FOREIGN KEY ("itemId") REFERENCES "production_batch_items"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production_batch_actions"
  ADD CONSTRAINT "production_batch_actions_actorClientId_workspaceId_fkey"
  FOREIGN KEY ("actorClientId", "workspaceId")
  REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
