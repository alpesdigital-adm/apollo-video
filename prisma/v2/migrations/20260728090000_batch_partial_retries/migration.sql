ALTER TABLE "production_batch_actions"
  ADD COLUMN "retryManifestJson" TEXT,
  ADD COLUMN "retryManifestHash" CHAR(64);

ALTER TABLE "production_batch_actions"
  DROP CONSTRAINT "production_batch_actions_scope_check";

ALTER TABLE "production_batch_actions"
  ADD CONSTRAINT "production_batch_actions_scope_check" CHECK (
    (
      "scope" = 'batch'
      AND "itemId" IS NULL
      AND "expectedItemRevision" IS NULL
      AND "action" IN ('cancel', 'resume', 'partial-retry')
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
  );

ALTER TABLE "production_batch_actions"
  ADD CONSTRAINT "production_batch_actions_retry_manifest_check" CHECK (
    (
      "action" = 'partial-retry'
      AND "scope" = 'batch'
      AND "retryManifestJson" IS NOT NULL
      AND length("retryManifestJson") BETWEEN 2 AND 10000000
      AND "retryManifestHash" ~ '^[a-f0-9]{64}$'
    )
    OR (
      "action" <> 'partial-retry'
      AND "retryManifestJson" IS NULL
      AND "retryManifestHash" IS NULL
    )
  );

CREATE UNIQUE INDEX "production_batch_actions_id_workspaceId_batchId_key"
  ON "production_batch_actions"("id", "workspaceId", "batchId");

CREATE TABLE "production_batch_retry_jobs" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "batchId" VARCHAR(128) NOT NULL,
  "itemId" VARCHAR(128) NOT NULL,
  "actionId" VARCHAR(128) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "step" VARCHAR(32) NOT NULL,
  "executorClass" VARCHAR(32) NOT NULL,
  "status" VARCHAR(16) NOT NULL,
  "lineageKey" CHAR(64) NOT NULL,
  "failedAttempt" INTEGER NOT NULL,
  "retryAttempt" INTEGER NOT NULL,
  "previousStepHash" CHAR(64) NOT NULL,
  "queuedStepHash" CHAR(64) NOT NULL,
  "failureCode" VARCHAR(128) NOT NULL,
  "failureMessage" VARCHAR(500) NOT NULL,
  "preservedArtifactIdsJson" TEXT NOT NULL,
  "preservedArtifactCount" INTEGER NOT NULL,
  "chargedMinorUnitsAtEnqueue" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "jobHash" CHAR(64) NOT NULL,

  CONSTRAINT "production_batch_retry_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "production_batch_retry_jobs_version_check" CHECK (
    "schemaVersion" = 'batch-partial-retry-job/v1'
  ),
  CONSTRAINT "production_batch_retry_jobs_executor_check" CHECK (
    (
      "step" = 'planning'
      AND "executorClass" = 'director'
    )
    OR (
      "step" = 'materializing'
      AND "executorClass" = 'provider'
    )
    OR (
      "step" = 'rendering'
      AND "executorClass" = 'renderer'
    )
    OR (
      "step" = 'reviewing'
      AND "executorClass" = 'validator'
    )
  ),
  CONSTRAINT "production_batch_retry_jobs_state_check" CHECK (
    "status" = 'queued'
  ),
  CONSTRAINT "production_batch_retry_jobs_attempt_check" CHECK (
    "failedAttempt" BETWEEN 1 AND 10000
    AND "retryAttempt" = "failedAttempt" + 1
  ),
  CONSTRAINT "production_batch_retry_jobs_artifact_check" CHECK (
    "preservedArtifactCount" BETWEEN 0 AND 1000
    AND length("preservedArtifactIdsJson") BETWEEN 2 AND 1000000
  ),
  CONSTRAINT "production_batch_retry_jobs_cost_check" CHECK (
    "chargedMinorUnitsAtEnqueue" = 0
  ),
  CONSTRAINT "production_batch_retry_jobs_hash_check" CHECK (
    "lineageKey" ~ '^[a-f0-9]{64}$'
    AND "previousStepHash" ~ '^[a-f0-9]{64}$'
    AND "queuedStepHash" ~ '^[a-f0-9]{64}$'
    AND "jobHash" ~ '^[a-f0-9]{64}$'
  )
);

CREATE UNIQUE INDEX "production_batch_retry_jobs_actionId_itemId_step_key"
  ON "production_batch_retry_jobs"("actionId", "itemId", "step");
CREATE UNIQUE INDEX "production_batch_retry_jobs_workspaceId_lineageKey_retryAtt_key"
  ON "production_batch_retry_jobs"(
    "workspaceId",
    "lineageKey",
    "retryAttempt"
  );
CREATE INDEX "production_batch_retry_jobs_workspaceId_batchId_createdAt_i_idx"
  ON "production_batch_retry_jobs"(
    "workspaceId",
    "batchId",
    "createdAt" DESC,
    "id" DESC
  );
CREATE INDEX "production_batch_retry_jobs_workspaceId_status_executorClas_idx"
  ON "production_batch_retry_jobs"(
    "workspaceId",
    "status",
    "executorClass",
    "createdAt",
    "id"
  );
CREATE INDEX "production_batch_retry_jobs_workspaceId_itemId_step_retryAt_idx"
  ON "production_batch_retry_jobs"(
    "workspaceId",
    "itemId",
    "step",
    "retryAttempt" DESC
  );

ALTER TABLE "production_batch_retry_jobs"
  ADD CONSTRAINT "production_batch_retry_jobs_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production_batch_retry_jobs"
  ADD CONSTRAINT "production_batch_retry_jobs_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "production_batch_retry_jobs"
  ADD CONSTRAINT "production_batch_retry_jobs_batchId_workspaceId_fkey"
  FOREIGN KEY ("batchId", "workspaceId")
  REFERENCES "production_batches"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "production_batch_retry_jobs"
  ADD CONSTRAINT "production_batch_retry_jobs_itemId_workspaceId_batchId_fkey"
  FOREIGN KEY ("itemId", "workspaceId", "batchId")
  REFERENCES "production_batch_items"("id", "workspaceId", "batchId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "production_batch_retry_jobs"
  ADD CONSTRAINT "production_batch_retry_jobs_actionId_workspaceId_batchId_fkey"
  FOREIGN KEY ("actionId", "workspaceId", "batchId")
  REFERENCES "production_batch_actions"("id", "workspaceId", "batchId")
  ON DELETE CASCADE ON UPDATE CASCADE;
