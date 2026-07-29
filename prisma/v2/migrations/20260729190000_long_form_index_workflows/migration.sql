CREATE TABLE "long_form_index_workflows" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "operationId" VARCHAR(128) NOT NULL,
  "sourceArtifactId" VARCHAR(128) NOT NULL,
  "sourceArtifactSha256" CHAR(64) NOT NULL,
  "sourceManifestId" VARCHAR(128) NOT NULL,
  "sourceManifestHash" CHAR(64) NOT NULL,
  "sourceTranscriptId" VARCHAR(128),
  "sourceTranscriptHash" CHAR(64),
  "durationMs" INTEGER NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "policyVersion" VARCHAR(64) NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "budgetCurrency" VARCHAR(8) NOT NULL,
  "maximumCostMinorUnits" INTEGER NOT NULL,
  "maximumElapsedMs" INTEGER NOT NULL,
  "maximumConcurrency" INTEGER NOT NULL,
  "completedStageCount" INTEGER NOT NULL,
  "searchableStageCount" INTEGER NOT NULL,
  "resultCount" INTEGER NOT NULL,
  "costMinorUnits" INTEGER NOT NULL,
  "elapsedMs" INTEGER NOT NULL,
  "nextStage" VARCHAR(32),
  "duplicateSegments" BOOLEAN NOT NULL,
  "resumable" BOOLEAN NOT NULL,
  "workflowJson" TEXT NOT NULL,
  "runHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "long_form_index_workflows_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "long_form_index_workflows_version_check" CHECK (
    "schemaVersion" = 'long-form-index-workflow/v1'
    AND "policyVersion" = 'long-form-index-workflow-policy/v1'
  ),
  CONSTRAINT "long_form_index_workflows_source_check" CHECK (
    "sourceArtifactSha256" ~ '^[a-f0-9]{64}$'
    AND "sourceManifestHash" ~ '^[a-f0-9]{64}$'
    AND (
      ("sourceTranscriptId" IS NULL AND "sourceTranscriptHash" IS NULL)
      OR (
        "sourceTranscriptId" IS NOT NULL
        AND "sourceTranscriptHash" ~ '^[a-f0-9]{64}$'
      )
    )
    AND "durationMs" BETWEEN 1000 AND 43200000
  ),
  CONSTRAINT "long_form_index_workflows_state_check" CHECK (
    "status" IN ('queued', 'running', 'partial', 'succeeded', 'failed')
    AND (
      "nextStage" IS NULL
      OR "nextStage" IN (
        'probe',
        'transcript',
        'diarization',
        'chunks',
        'moments'
      )
    )
    AND "completedStageCount" BETWEEN 0 AND 5
    AND "searchableStageCount" BETWEEN 0 AND "completedStageCount"
    AND "resultCount" >= 0
    AND "costMinorUnits" BETWEEN 0 AND "maximumCostMinorUnits"
    AND "elapsedMs" BETWEEN 0 AND "maximumElapsedMs"
    AND NOT "duplicateSegments"
    AND "resumable"
  ),
  CONSTRAINT "long_form_index_workflows_budget_check" CHECK (
    "budgetCurrency" = 'USD'
    AND "maximumCostMinorUnits" BETWEEN 0 AND 10000000
    AND "maximumElapsedMs" BETWEEN 1 AND 86400000
    AND "maximumConcurrency" BETWEEN 1 AND 32
  ),
  CONSTRAINT "long_form_index_workflows_integrity_check" CHECK (
    "runHash" ~ '^[a-f0-9]{64}$'
    AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
    AND length("idempotencyKey") BETWEEN 8 AND 128
    AND length("workflowJson") BETWEEN 2 AND 10000000
    AND "updatedAt" >= "createdAt"
  )
);

CREATE TABLE "long_form_index_stage_checkpoints" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "workflowId" VARCHAR(128) NOT NULL,
  "stage" VARCHAR(32) NOT NULL,
  "sequence" INTEGER NOT NULL,
  "prerequisitesJson" TEXT NOT NULL,
  "execution" VARCHAR(16) NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "versionJson" TEXT NOT NULL,
  "budgetJson" TEXT NOT NULL,
  "concurrency" INTEGER NOT NULL,
  "inputHash" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(256) NOT NULL,
  "attempt" INTEGER NOT NULL,
  "outputHash" CHAR(64),
  "resultCount" INTEGER NOT NULL,
  "searchable" BOOLEAN NOT NULL,
  "costMinorUnits" INTEGER NOT NULL,
  "elapsedMs" INTEGER NOT NULL,
  "startedAt" TIMESTAMPTZ(3),
  "completedAt" TIMESTAMPTZ(3),
  "errorCode" VARCHAR(64),
  "errorMessage" VARCHAR(500),
  "errorRetryable" BOOLEAN,
  "stageJson" TEXT NOT NULL,
  "stageHash" CHAR(64) NOT NULL,

  CONSTRAINT "long_form_index_stage_checkpoints_pkey"
    PRIMARY KEY ("id"),
  CONSTRAINT "long_form_index_stage_checkpoints_identity_check" CHECK (
    "stage" IN (
      'probe',
      'transcript',
      'diarization',
      'chunks',
      'moments'
    )
    AND "sequence" BETWEEN 1 AND 5
    AND "execution" IN ('process', 'reuse')
    AND "status" IN (
      'pending',
      'ready',
      'running',
      'succeeded',
      'failed',
      'budget-blocked'
    )
    AND "concurrency" BETWEEN 1 AND 32
    AND "attempt" >= 0
  ),
  CONSTRAINT "long_form_index_stage_checkpoints_result_check" CHECK (
    "resultCount" >= 0
    AND "costMinorUnits" >= 0
    AND "elapsedMs" >= 0
    AND (
      ("status" = 'succeeded'
        AND "outputHash" ~ '^[a-f0-9]{64}$'
        AND "resultCount" >= 1
        AND "completedAt" IS NOT NULL
        AND "errorCode" IS NULL
        AND "errorMessage" IS NULL
        AND "errorRetryable" IS NULL)
      OR
      ("status" = 'running'
        AND "attempt" >= 1
        AND "startedAt" IS NOT NULL
        AND "completedAt" IS NULL
        AND "outputHash" IS NULL
        AND "errorCode" IS NULL
        AND "errorMessage" IS NULL
        AND "errorRetryable" IS NULL)
      OR
      ("status" = 'failed'
        AND "completedAt" IS NOT NULL
        AND "outputHash" IS NULL
        AND "errorCode" IS NOT NULL
        AND "errorMessage" IS NOT NULL
        AND "errorRetryable" IS NOT NULL)
      OR
      ("status" IN ('pending', 'ready', 'budget-blocked')
        AND "completedAt" IS NULL
        AND "outputHash" IS NULL
        AND "errorCode" IS NULL
        AND "errorMessage" IS NULL
        AND "errorRetryable" IS NULL)
    )
  ),
  CONSTRAINT "long_form_index_stage_checkpoints_integrity_check" CHECK (
    "inputHash" ~ '^[a-f0-9]{64}$'
    AND "stageHash" ~ '^[a-f0-9]{64}$'
    AND length("idempotencyKey") BETWEEN 8 AND 256
    AND length("prerequisitesJson") BETWEEN 2 AND 1000
    AND length("versionJson") BETWEEN 2 AND 1000
    AND length("budgetJson") BETWEEN 2 AND 1000
    AND length("stageJson") BETWEEN 2 AND 100000
    AND (
      "startedAt" IS NULL
      OR "completedAt" IS NULL
      OR "completedAt" >= "startedAt"
    )
  )
);

CREATE UNIQUE INDEX "long_form_index_workflows_id_workspaceId_key"
  ON "long_form_index_workflows"("id", "workspaceId");
CREATE UNIQUE INDEX "long_form_index_workflows_id_workspaceId_projectId_key"
  ON "long_form_index_workflows"("id", "workspaceId", "projectId");
CREATE UNIQUE INDEX "long_form_index_workflows_operationId_key"
  ON "long_form_index_workflows"("operationId");
CREATE UNIQUE INDEX "long_form_index_workflows_operationId_workspaceId_key"
  ON "long_form_index_workflows"("operationId", "workspaceId");
CREATE UNIQUE INDEX "long_form_index_workflows_workspaceId_projectId_createdByCl_key"
  ON "long_form_index_workflows"(
    "workspaceId",
    "projectId",
    "createdByClientId",
    "idempotencyKey"
  );
CREATE INDEX "long_form_index_workflows_workspaceId_projectId_createdAt_i_idx"
  ON "long_form_index_workflows"(
    "workspaceId",
    "projectId",
    "createdAt" DESC,
    "id" DESC
  );
CREATE INDEX "long_form_index_workflows_workspaceId_sourceArtifactId_crea_idx"
  ON "long_form_index_workflows"(
    "workspaceId",
    "sourceArtifactId",
    "createdAt" DESC
  );
CREATE INDEX "long_form_index_workflows_workspaceId_status_updatedAt_idx"
  ON "long_form_index_workflows"(
    "workspaceId",
    "status",
    "updatedAt" DESC
  );

CREATE UNIQUE INDEX "long_form_index_stage_checkpoints_workflowId_sequence_key"
  ON "long_form_index_stage_checkpoints"("workflowId", "sequence");
CREATE UNIQUE INDEX "long_form_index_stage_checkpoints_workflowId_stage_key"
  ON "long_form_index_stage_checkpoints"("workflowId", "stage");
CREATE UNIQUE INDEX "long_form_index_stage_checkpoints_workflowId_idempotencyKey_key"
  ON "long_form_index_stage_checkpoints"(
    "workflowId",
    "idempotencyKey"
  );
CREATE INDEX "long_form_index_stage_checkpoints_workspaceId_projectId_wor_idx"
  ON "long_form_index_stage_checkpoints"(
    "workspaceId",
    "projectId",
    "workflowId",
    "sequence"
  );
CREATE INDEX "long_form_index_stage_checkpoints_workspaceId_status_stage_idx"
  ON "long_form_index_stage_checkpoints"(
    "workspaceId",
    "status",
    "stage"
  );

ALTER TABLE "long_form_index_workflows"
  ADD CONSTRAINT "long_form_index_workflows_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "long_form_index_workflows"
  ADD CONSTRAINT "long_form_index_workflows_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "long_form_index_workflows"
  ADD CONSTRAINT "long_form_index_workflows_operationId_workspaceId_fkey"
  FOREIGN KEY ("operationId", "workspaceId")
  REFERENCES "public_operations"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "long_form_index_workflows"
  ADD CONSTRAINT "long_form_index_workflows_sourceArtifactId_workspaceId_fkey"
  FOREIGN KEY ("sourceArtifactId", "workspaceId")
  REFERENCES "media_artifacts"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "long_form_index_workflows"
  ADD CONSTRAINT "long_form_index_workflows_sourceManifestId_workspaceId_fkey"
  FOREIGN KEY ("sourceManifestId", "workspaceId")
  REFERENCES "media_artifact_manifests"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "long_form_index_workflows"
  ADD CONSTRAINT "long_form_index_workflows_sourceTranscriptId_workspaceId_fkey"
  FOREIGN KEY ("sourceTranscriptId", "workspaceId")
  REFERENCES "media_transcripts"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "long_form_index_workflows"
  ADD CONSTRAINT "long_form_index_workflows_createdByClientId_workspaceId_fkey"
  FOREIGN KEY ("createdByClientId", "workspaceId")
  REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "long_form_index_stage_checkpoints"
  ADD CONSTRAINT "long_form_index_stage_checkpoints_workflowId_workspaceId_p_fkey"
  FOREIGN KEY ("workflowId", "workspaceId", "projectId")
  REFERENCES "long_form_index_workflows"(
    "id",
    "workspaceId",
    "projectId"
  )
  ON DELETE CASCADE ON UPDATE CASCADE;
