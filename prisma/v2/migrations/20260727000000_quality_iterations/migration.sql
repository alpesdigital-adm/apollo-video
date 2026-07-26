CREATE TABLE "quality_iterations" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "projectVersionId" VARCHAR(128) NOT NULL,
  "projectVersionHash" CHAR(64) NOT NULL,
  "iteration" INTEGER NOT NULL,
  "previousIterationId" VARCHAR(128),
  "proxyReviewId" VARCHAR(128) NOT NULL,
  "proxyReviewHash" CHAR(64) NOT NULL,
  "proxyReviewRevision" INTEGER NOT NULL,
  "proxyEvidenceJson" TEXT NOT NULL,
  "assetPlacementsJson" TEXT NOT NULL,
  "rubricJson" TEXT NOT NULL,
  "rangeMetricsJson" TEXT NOT NULL,
  "datasetJson" TEXT NOT NULL,
  "score" DOUBLE PRECISION NOT NULL,
  "regression" DOUBLE PRECISION NOT NULL,
  "regressed" BOOLEAN NOT NULL,
  "validationJson" TEXT NOT NULL,
  "issuesJson" TEXT NOT NULL,
  "patchesJson" TEXT NOT NULL,
  "rerenderRangesJson" TEXT NOT NULL,
  "fullRerenderRequired" BOOLEAN NOT NULL,
  "budgetJson" TEXT NOT NULL,
  "decisionContinue" BOOLEAN NOT NULL,
  "terminalReason" VARCHAR(32),
  "reportFingerprint" CHAR(64) NOT NULL,
  "recordHash" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "createdByType" VARCHAR(32) NOT NULL,
  "createdById" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "quality_iterations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "quality_iterations_hashes_check" CHECK (
    "projectVersionHash" ~ '^[a-f0-9]{64}$'
    AND "proxyReviewHash" ~ '^[a-f0-9]{64}$'
    AND "reportFingerprint" ~ '^[a-f0-9]{64}$'
    AND "recordHash" ~ '^[a-f0-9]{64}$'
    AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "quality_iterations_sequence_check" CHECK (
    "iteration" BETWEEN 1 AND 10000
    AND "proxyReviewRevision" >= 1
    AND (
      ("iteration" = 1 AND "previousIterationId" IS NULL)
      OR ("iteration" > 1 AND "previousIterationId" IS NOT NULL)
    )
  ),
  CONSTRAINT "quality_iterations_score_check" CHECK (
    "score" BETWEEN 0 AND 100
    AND "regression" BETWEEN -100 AND 100
  ),
  CONSTRAINT "quality_iterations_json_bounds_check" CHECK (
    length("proxyEvidenceJson") BETWEEN 2 AND 500000
    AND length("assetPlacementsJson") BETWEEN 2 AND 500000
    AND length("rubricJson") BETWEEN 2 AND 250000
    AND length("rangeMetricsJson") BETWEEN 2 AND 250000
    AND length("datasetJson") BETWEEN 2 AND 50000
    AND length("validationJson") BETWEEN 2 AND 50000
    AND length("issuesJson") BETWEEN 2 AND 500000
    AND length("patchesJson") BETWEEN 2 AND 500000
    AND length("rerenderRangesJson") BETWEEN 2 AND 250000
    AND length("budgetJson") BETWEEN 2 AND 50000
  ),
  CONSTRAINT "quality_iterations_decision_check" CHECK (
    (
      "decisionContinue" = TRUE
      AND "terminalReason" IS NULL
    )
    OR
    (
      "decisionContinue" = FALSE
      AND "terminalReason" IN (
        'approval',
        'convergence',
        'budget',
        'uncorrectable',
        'human_review'
      )
    )
  ),
  CONSTRAINT "quality_iterations_creator_check" CHECK (
    "createdByType" = 'api-client'
  ),
  CONSTRAINT "quality_iterations_idempotency_check" CHECK (
    length("idempotencyKey") BETWEEN 8 AND 128
  )
);

CREATE TABLE "quality_iteration_asset_selections" (
  "qualityIterationId" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "assetSelectionId" VARCHAR(128) NOT NULL,
  "selectionHash" CHAR(64) NOT NULL,
  "ordinal" INTEGER NOT NULL,

  CONSTRAINT "quality_iteration_asset_selections_pkey"
    PRIMARY KEY ("qualityIterationId", "assetSelectionId"),
  CONSTRAINT "quality_iteration_asset_selections_hash_check"
    CHECK ("selectionHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "quality_iteration_asset_selections_ordinal_check"
    CHECK ("ordinal" BETWEEN 0 AND 99)
);

CREATE INDEX "quality_iterations_workspaceId_projectId_createdAt_idx"
  ON "quality_iterations"("workspaceId", "projectId", "createdAt" DESC);

CREATE INDEX "quality_iterations_workspaceId_projectVersionId_iteration_idx"
  ON "quality_iterations"("workspaceId", "projectVersionId", "iteration" DESC);

CREATE INDEX "quality_iterations_workspaceId_proxyReviewId_proxyReviewRev_idx"
  ON "quality_iterations"("workspaceId", "proxyReviewId", "proxyReviewRevision");

CREATE INDEX "quality_iterations_workspaceId_terminalReason_createdAt_idx"
  ON "quality_iterations"("workspaceId", "terminalReason", "createdAt" DESC);

CREATE INDEX "quality_iterations_previousIterationId_idx"
  ON "quality_iterations"("previousIterationId");

CREATE UNIQUE INDEX "quality_iterations_id_workspaceId_key"
  ON "quality_iterations"("id", "workspaceId");

CREATE UNIQUE INDEX "quality_iterations_workspaceId_projectId_idempotencyKey_key"
  ON "quality_iterations"("workspaceId", "projectId", "idempotencyKey");

CREATE UNIQUE INDEX "quality_iterations_projectVersionId_iteration_key"
  ON "quality_iterations"("projectVersionId", "iteration");

CREATE INDEX "quality_iteration_asset_selections_workspaceId_assetSelecti_idx"
  ON "quality_iteration_asset_selections"("workspaceId", "assetSelectionId");

CREATE UNIQUE INDEX "quality_iteration_asset_selections_qualityIterationId_ordin_key"
  ON "quality_iteration_asset_selections"("qualityIterationId", "ordinal");

ALTER TABLE "quality_iterations" ADD CONSTRAINT "quality_iterations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "quality_iterations" ADD CONSTRAINT "quality_iterations_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "quality_iterations" ADD CONSTRAINT "quality_iterations_projectVersionId_workspaceId_fkey" FOREIGN KEY ("projectVersionId", "workspaceId") REFERENCES "project_versions"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "quality_iterations" ADD CONSTRAINT "quality_iterations_proxyReviewId_workspaceId_fkey" FOREIGN KEY ("proxyReviewId", "workspaceId") REFERENCES "proxy_reviews"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "quality_iterations" ADD CONSTRAINT "quality_iterations_createdById_workspaceId_fkey" FOREIGN KEY ("createdById", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "quality_iterations" ADD CONSTRAINT "quality_iterations_previousIterationId_fkey" FOREIGN KEY ("previousIterationId") REFERENCES "quality_iterations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "quality_iteration_asset_selections" ADD CONSTRAINT "quality_iteration_asset_selections_qualityIterationId_work_fkey" FOREIGN KEY ("qualityIterationId", "workspaceId") REFERENCES "quality_iterations"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "quality_iteration_asset_selections" ADD CONSTRAINT "quality_iteration_asset_selections_assetSelectionId_worksp_fkey" FOREIGN KEY ("assetSelectionId", "workspaceId") REFERENCES "asset_selections"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
