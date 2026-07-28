CREATE TABLE "variant_portfolio_policies" (
  "workspaceId" VARCHAR(128) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "defaultRecipeLimit" INTEGER NOT NULL,
  "maxRecipeLimit" INTEGER NOT NULL,
  "maxOutputCount" INTEGER NOT NULL,
  "minCompatibilityEdgeScore" DECIMAL(6,3) NOT NULL,
  "minRecipeScore" DECIMAL(6,3) NOT NULL,
  "minHookCoverage" INTEGER NOT NULL,
  "minBodyCoverage" INTEGER NOT NULL,
  "minCtaCoverage" INTEGER NOT NULL,
  "maxRecipesPerSemanticCluster" INTEGER NOT NULL,
  "maxCandidateScanCount" INTEGER NOT NULL,
  "estimatedCostPerOutputMinorUnits" INTEGER NOT NULL,
  "estimatedDurationSecondsPerOutput" INTEGER NOT NULL,
  "estimatedStorageBytesPerOutput" BIGINT NOT NULL,
  "maxConcurrentJobs" INTEGER NOT NULL,
  "confirmationTtlSeconds" INTEGER NOT NULL,
  "policyJson" TEXT NOT NULL,
  "policyHash" CHAR(64) NOT NULL,
  "updatedByClientId" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "variant_portfolio_policies_pkey"
    PRIMARY KEY ("workspaceId", "revision"),
  CONSTRAINT "variant_portfolio_policies_version_check"
    CHECK ("schemaVersion" = 'variant-portfolio-policy/v1'),
  CONSTRAINT "variant_portfolio_policies_revision_check"
    CHECK ("revision" >= 1),
  CONSTRAINT "variant_portfolio_policies_limits_check" CHECK (
    "defaultRecipeLimit" BETWEEN 1 AND 1000
    AND "maxRecipeLimit" BETWEEN "defaultRecipeLimit" AND 1000
    AND "maxOutputCount" BETWEEN 1 AND 50000
    AND "maxCandidateScanCount" BETWEEN 100 AND 1000000
    AND "maxRecipesPerSemanticCluster" BETWEEN 1 AND 100
  ),
  CONSTRAINT "variant_portfolio_policies_quality_check" CHECK (
    "minCompatibilityEdgeScore" BETWEEN 0 AND 100
    AND "minRecipeScore" BETWEEN 0 AND 100
    AND "minHookCoverage" BETWEEN 1 AND 100
    AND "minBodyCoverage" BETWEEN 1 AND 100
    AND "minCtaCoverage" BETWEEN 1 AND 100
  ),
  CONSTRAINT "variant_portfolio_policies_estimates_check" CHECK (
    "estimatedCostPerOutputMinorUnits" > 0
    AND "estimatedDurationSecondsPerOutput" > 0
    AND "estimatedStorageBytesPerOutput" > 0
    AND "maxConcurrentJobs" BETWEEN 1 AND 1000
    AND "confirmationTtlSeconds" BETWEEN 60 AND 86400
  ),
  CONSTRAINT "variant_portfolio_policies_hash_check"
    CHECK ("policyHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "variant_portfolio_policies_json_check"
    CHECK (length("policyJson") BETWEEN 2 AND 100000)
);

CREATE UNIQUE INDEX "variant_portfolio_policies_workspaceId_policyHash_key"
  ON "variant_portfolio_policies"("workspaceId", "policyHash");
CREATE INDEX "variant_portfolio_policies_workspaceId_revision_idx"
  ON "variant_portfolio_policies"("workspaceId", "revision");
CREATE INDEX "variant_portfolio_policies_updatedByClientId_updatedAt_idx"
  ON "variant_portfolio_policies"(
    "updatedByClientId",
    "updatedAt" DESC
  );

CREATE TABLE "variant_portfolio_preflight_runs" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "batchId" VARCHAR(128) NOT NULL,
  "compatibilityGraphId" VARCHAR(128) NOT NULL,
  "compatibilityGraphRunHash" CHAR(64) NOT NULL,
  "takeLibraryId" VARCHAR(128) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "selectionVersion" VARCHAR(64) NOT NULL,
  "objective" VARCHAR(128) NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "resultJson" TEXT NOT NULL,
  "policyHash" CHAR(64) NOT NULL,
  "requestedRecipeCount" INTEGER NOT NULL,
  "effectiveRecipeLimit" INTEGER NOT NULL,
  "batchVariantCount" INTEGER NOT NULL,
  "budgetRemainingMinorUnits" INTEGER NOT NULL,
  "theoreticalCandidateCount" DECIMAL(38,0) NOT NULL,
  "eligibleCandidateCount" DECIMAL(38,0) NOT NULL,
  "scannedCandidateCount" INTEGER NOT NULL,
  "selectedRecipeCount" INTEGER NOT NULL,
  "outputVariantCount" INTEGER NOT NULL,
  "plannedJobCount" INTEGER NOT NULL,
  "jobsCreated" INTEGER NOT NULL DEFAULT 0,
  "estimatedCostMinorUnits" INTEGER NOT NULL,
  "estimatedDurationSeconds" INTEGER NOT NULL,
  "estimatedStorageBytes" BIGINT NOT NULL,
  "reusedRecipeCount" INTEGER NOT NULL,
  "productMaterialized" BOOLEAN NOT NULL DEFAULT false,
  "confirmationRequired" BOOLEAN NOT NULL,
  "confirmationSatisfied" BOOLEAN NOT NULL,
  "confirmationExpiresAt" TIMESTAMPTZ(3),
  "runHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "variant_portfolio_preflight_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "variant_portfolio_preflight_versions_check" CHECK (
    "schemaVersion" = 'variant-portfolio-preflight/v1'
    AND "selectionVersion" = 'variant-portfolio-selection/v1'
  ),
  CONSTRAINT "variant_portfolio_preflight_status_check" CHECK (
    "status" IN (
      'ready',
      'confirmation-required',
      'no-eligible-recipes'
    )
  ),
  CONSTRAINT "variant_portfolio_preflight_counts_check" CHECK (
    "requestedRecipeCount" BETWEEN 1 AND 1000
    AND "effectiveRecipeLimit" BETWEEN 0 AND "requestedRecipeCount"
    AND "batchVariantCount" BETWEEN 1 AND 50
    AND "budgetRemainingMinorUnits" >= 0
    AND "theoreticalCandidateCount" >= 0
    AND "eligibleCandidateCount" BETWEEN 0 AND "theoreticalCandidateCount"
    AND "scannedCandidateCount" >= 0
    AND "selectedRecipeCount" BETWEEN 0 AND "effectiveRecipeLimit"
    AND "outputVariantCount" =
      "selectedRecipeCount" * "batchVariantCount"
    AND "plannedJobCount" BETWEEN 0 AND "outputVariantCount"
    AND "reusedRecipeCount" BETWEEN 0 AND "selectedRecipeCount"
  ),
  CONSTRAINT "variant_portfolio_preflight_no_jobs_check" CHECK (
    "jobsCreated" = 0
    AND NOT "productMaterialized"
  ),
  CONSTRAINT "variant_portfolio_preflight_estimates_check" CHECK (
    "estimatedCostMinorUnits" >= 0
    AND "estimatedDurationSeconds" >= 0
    AND "estimatedStorageBytes" >= 0
  ),
  CONSTRAINT "variant_portfolio_preflight_confirmation_check" CHECK (
    NOT ("confirmationRequired" AND "confirmationSatisfied")
    AND (
      ("confirmationRequired" AND "confirmationExpiresAt" IS NOT NULL)
      OR
      (NOT "confirmationRequired")
    )
  ),
  CONSTRAINT "variant_portfolio_preflight_hashes_check" CHECK (
    "compatibilityGraphRunHash" ~ '^[a-f0-9]{64}$'
    AND "policyHash" ~ '^[a-f0-9]{64}$'
    AND "runHash" ~ '^[a-f0-9]{64}$'
    AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "variant_portfolio_preflight_json_check"
    CHECK (length("resultJson") BETWEEN 2 AND 100000000)
);

CREATE UNIQUE INDEX "variant_portfolio_preflight_runs_id_workspaceId_key"
  ON "variant_portfolio_preflight_runs"("id", "workspaceId");
CREATE UNIQUE INDEX "variant_portfolio_preflight_runs_workspaceId_createdByClien_key"
  ON "variant_portfolio_preflight_runs"(
    "workspaceId",
    "createdByClientId",
    "idempotencyKey"
  );
CREATE INDEX "variant_portfolio_preflight_runs_workspaceId_batchId_create_idx"
  ON "variant_portfolio_preflight_runs"(
    "workspaceId",
    "batchId",
    "createdAt" DESC,
    "id" DESC
  );
CREATE INDEX "variant_portfolio_preflight_runs_workspaceId_compatibilityG_idx"
  ON "variant_portfolio_preflight_runs"(
    "workspaceId",
    "compatibilityGraphId",
    "createdAt" DESC
  );
CREATE INDEX "variant_portfolio_preflight_runs_workspaceId_status_confirm_idx"
  ON "variant_portfolio_preflight_runs"(
    "workspaceId",
    "status",
    "confirmationRequired",
    "createdAt" DESC
  );
CREATE INDEX "variant_portfolio_preflight_runs_workspaceId_policyHash_idx"
  ON "variant_portfolio_preflight_runs"(
    "workspaceId",
    "policyHash"
  );

ALTER TABLE "variant_portfolio_policies"
  ADD CONSTRAINT "variant_portfolio_policies_workspaceId_fkey"
  FOREIGN KEY ("workspaceId")
  REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "variant_portfolio_policies"
  ADD CONSTRAINT "variant_portfolio_policies_updatedByClientId_workspaceId_fkey"
  FOREIGN KEY ("updatedByClientId", "workspaceId")
  REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "variant_portfolio_preflight_runs"
  ADD CONSTRAINT "variant_portfolio_preflight_runs_workspaceId_fkey"
  FOREIGN KEY ("workspaceId")
  REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "variant_portfolio_preflight_runs"
  ADD CONSTRAINT "variant_portfolio_preflight_runs_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "variant_portfolio_preflight_runs"
  ADD CONSTRAINT "variant_portfolio_preflight_runs_batchId_workspaceId_fkey"
  FOREIGN KEY ("batchId", "workspaceId")
  REFERENCES "production_batches"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "variant_portfolio_preflight_runs"
  ADD CONSTRAINT "variant_portfolio_preflight_graph_scope_fkey"
  FOREIGN KEY (
    "compatibilityGraphId",
    "workspaceId",
    "projectId",
    "batchId",
    "takeLibraryId",
    "compatibilityGraphRunHash"
  )
  REFERENCES "compatibility_graph_runs"(
    "id",
    "workspaceId",
    "projectId",
    "batchId",
    "takeLibraryId",
    "runHash"
  )
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "variant_portfolio_preflight_runs"
  ADD CONSTRAINT "variant_portfolio_preflight_policy_scope_fkey"
  FOREIGN KEY ("workspaceId", "policyHash")
  REFERENCES "variant_portfolio_policies"(
    "workspaceId",
    "policyHash"
  )
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "variant_portfolio_preflight_runs"
  ADD CONSTRAINT "variant_portfolio_preflight_runs_createdByClientId_workspa_fkey"
  FOREIGN KEY ("createdByClientId", "workspaceId")
  REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
