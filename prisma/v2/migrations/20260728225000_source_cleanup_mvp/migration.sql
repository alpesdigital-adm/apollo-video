ALTER TABLE "public_operations"
  DROP CONSTRAINT "public_operations_type_check";

ALTER TABLE "public_operations"
  ADD CONSTRAINT "public_operations_type_check"
  CHECK (
    "type" IN (
      'artifact-render',
      'media-ingest',
      'project-proxy-render',
      'project-final-export',
      'source-cleanup'
    )
  );

CREATE TABLE "source_cleanup_plans" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "contaminationReportId" VARCHAR(128) NOT NULL,
  "contaminationReportHash" CHAR(64) NOT NULL,
  "findingId" VARCHAR(128) NOT NULL,
  "findingHash" CHAR(64) NOT NULL,
  "sourceArtifactId" VARCHAR(128) NOT NULL,
  "sourceArtifactSha256" CHAR(64) NOT NULL,
  "sourceManifestId" VARCHAR(128) NOT NULL,
  "sourceDurationMs" INTEGER NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "policyVersion" VARCHAR(64) NOT NULL,
  "policyJson" TEXT NOT NULL,
  "policyHash" CHAR(64) NOT NULL,
  "candidatesJson" TEXT NOT NULL,
  "candidatesHash" CHAR(64) NOT NULL,
  "selectedStrategy" VARCHAR(32) NOT NULL,
  "selectedActionJson" TEXT NOT NULL,
  "selectedActionHash" CHAR(64) NOT NULL,
  "decision" VARCHAR(16) NOT NULL,
  "predictedResidualQuality" DOUBLE PRECISION NOT NULL,
  "predictedIntegrity" DOUBLE PRECISION NOT NULL,
  "predictedCost" DOUBLE PRECISION NOT NULL,
  "sourceImmutable" BOOLEAN NOT NULL DEFAULT TRUE,
  "rightsSnapshotId" VARCHAR(128),
  "rightsSnapshotHash" CHAR(64),
  "rightsDecision" VARCHAR(16) NOT NULL,
  "rightsReasonCodesJson" TEXT NOT NULL,
  "postCleanupReviewRequired" BOOLEAN NOT NULL,
  "operationId" VARCHAR(128),
  "outputArtifactId" VARCHAR(128),
  "outputManifestId" VARCHAR(128),
  "planJson" TEXT NOT NULL,
  "planHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "source_cleanup_plans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "source_cleanup_plans_version_check" CHECK (
    "schemaVersion" = 'source-cleanup-plan/v1'
    AND "policyVersion" = 'source-cleanup-mvp/v1'
  ),
  CONSTRAINT "source_cleanup_plans_strategy_check" CHECK (
    "selectedStrategy" IN ('trim', 'crop-reframe', 'cover', 'reject')
  ),
  CONSTRAINT "source_cleanup_plans_decision_check" CHECK (
    (
      "decision" = 'execute'
      AND "selectedStrategy" <> 'reject'
      AND "sourceImmutable"
      AND "postCleanupReviewRequired"
      AND "rightsDecision" = 'allow'
      AND "rightsSnapshotId" IS NOT NULL
      AND "rightsSnapshotHash" IS NOT NULL
      AND "operationId" IS NOT NULL
      AND "outputArtifactId" IS NOT NULL
      AND "outputManifestId" IS NOT NULL
    )
    OR (
      "decision" = 'reject'
      AND "selectedStrategy" = 'reject'
      AND "sourceImmutable"
      AND NOT "postCleanupReviewRequired"
      AND "operationId" IS NULL
      AND "outputArtifactId" IS NULL
      AND "outputManifestId" IS NULL
    )
  ),
  CONSTRAINT "source_cleanup_plans_score_check" CHECK (
    "sourceDurationMs" BETWEEN 1 AND 86400000
    AND "predictedResidualQuality" BETWEEN 0 AND 1
    AND "predictedIntegrity" BETWEEN 0 AND 1
    AND "predictedCost" BETWEEN 0 AND 1000000
  ),
  CONSTRAINT "source_cleanup_plans_json_check" CHECK (
    length("policyJson") BETWEEN 2 AND 100000
    AND length("candidatesJson") BETWEEN 2 AND 1000000
    AND length("selectedActionJson") BETWEEN 2 AND 100000
    AND length("rightsReasonCodesJson") BETWEEN 2 AND 100000
    AND length("planJson") BETWEEN 2 AND 5000000
    AND length("idempotencyKey") BETWEEN 8 AND 128
  ),
  CONSTRAINT "source_cleanup_plans_hash_check" CHECK (
    "contaminationReportHash" ~ '^[a-f0-9]{64}$'
    AND "findingHash" ~ '^[a-f0-9]{64}$'
    AND "sourceArtifactSha256" ~ '^[a-f0-9]{64}$'
    AND "policyHash" ~ '^[a-f0-9]{64}$'
    AND "candidatesHash" ~ '^[a-f0-9]{64}$'
    AND "selectedActionHash" ~ '^[a-f0-9]{64}$'
    AND ("rightsSnapshotHash" IS NULL OR "rightsSnapshotHash" ~ '^[a-f0-9]{64}$')
    AND "planHash" ~ '^[a-f0-9]{64}$'
    AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
  )
);

CREATE UNIQUE INDEX "source_cleanup_plans_id_workspaceId_projectId_key"
  ON "source_cleanup_plans"("id", "workspaceId", "projectId");
CREATE UNIQUE INDEX "source_cleanup_plans_operationId_key"
  ON "source_cleanup_plans"("operationId");
CREATE UNIQUE INDEX "source_cleanup_plans_operation_workspace_key"
  ON "source_cleanup_plans"("operationId", "workspaceId");
CREATE UNIQUE INDEX "source_cleanup_plans_workspace_project_actor_idem_key"
  ON "source_cleanup_plans"(
    "workspaceId",
    "projectId",
    "createdByClientId",
    "idempotencyKey"
  );
CREATE INDEX "source_cleanup_plans_workspace_project_created_idx"
  ON "source_cleanup_plans"(
    "workspaceId",
    "projectId",
    "createdAt" DESC,
    "id" DESC
  );
CREATE INDEX "source_cleanup_plans_workspace_finding_created_idx"
  ON "source_cleanup_plans"(
    "workspaceId",
    "contaminationReportId",
    "findingId",
    "createdAt" DESC
  );
CREATE INDEX "source_cleanup_plans_workspace_source_strategy_idx"
  ON "source_cleanup_plans"(
    "workspaceId",
    "sourceArtifactId",
    "selectedStrategy",
    "decision"
  );
CREATE INDEX "source_cleanup_plans_workspace_operation_idx"
  ON "source_cleanup_plans"("workspaceId", "operationId");

CREATE TABLE "source_cleanup_results" (
  "cleanupPlanId" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "outputArtifactId" VARCHAR(128) NOT NULL,
  "outputArtifactSha256" CHAR(64) NOT NULL,
  "outputManifestId" VARCHAR(128) NOT NULL,
  "strategy" VARCHAR(32) NOT NULL,
  "visualPassed" BOOLEAN NOT NULL,
  "rightsPassed" BOOLEAN NOT NULL,
  "passed" BOOLEAN NOT NULL,
  "residualQuality" DOUBLE PRECISION NOT NULL,
  "sourceRightsSnapshotId" VARCHAR(128) NOT NULL,
  "sourceRightsSnapshotHash" CHAR(64) NOT NULL,
  "outputRightsSnapshotId" VARCHAR(128) NOT NULL,
  "outputRightsSnapshotHash" CHAR(64) NOT NULL,
  "reviewJson" TEXT NOT NULL,
  "reviewHash" CHAR(64) NOT NULL,
  "completedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "source_cleanup_results_pkey" PRIMARY KEY ("cleanupPlanId"),
  CONSTRAINT "source_cleanup_results_strategy_check" CHECK (
    "strategy" IN ('trim', 'crop-reframe', 'cover')
  ),
  CONSTRAINT "source_cleanup_results_review_check" CHECK (
    "residualQuality" BETWEEN 0 AND 1
    AND "passed" = ("visualPassed" AND "rightsPassed")
    AND length("reviewJson") BETWEEN 2 AND 1000000
  ),
  CONSTRAINT "source_cleanup_results_hash_check" CHECK (
    "outputArtifactSha256" ~ '^[a-f0-9]{64}$'
    AND "sourceRightsSnapshotHash" ~ '^[a-f0-9]{64}$'
    AND "outputRightsSnapshotHash" ~ '^[a-f0-9]{64}$'
    AND "reviewHash" ~ '^[a-f0-9]{64}$'
  )
);

CREATE UNIQUE INDEX "source_cleanup_results_workspace_outputArtifactId_key"
  ON "source_cleanup_results"("workspaceId", "outputArtifactId");
CREATE UNIQUE INDEX "source_cleanup_results_workspace_outputManifestId_key"
  ON "source_cleanup_results"("workspaceId", "outputManifestId");
CREATE UNIQUE INDEX "source_cleanup_results_plan_workspace_project_key"
  ON "source_cleanup_results"(
    "cleanupPlanId",
    "workspaceId",
    "projectId"
  );
CREATE INDEX "source_cleanup_results_workspace_project_completed_idx"
  ON "source_cleanup_results"(
    "workspaceId",
    "projectId",
    "completedAt" DESC
  );
CREATE INDEX "source_cleanup_results_workspace_passed_idx"
  ON "source_cleanup_results"(
    "workspaceId",
    "passed",
    "completedAt" DESC
  );

ALTER TABLE "source_cleanup_plans"
  ADD CONSTRAINT "source_cleanup_plans_workspace_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "source_cleanup_plans"
  ADD CONSTRAINT "source_cleanup_plans_project_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "source_cleanup_plans"
  ADD CONSTRAINT "source_cleanup_plans_report_fkey"
  FOREIGN KEY ("contaminationReportId", "workspaceId", "projectId")
  REFERENCES "contamination_reports"("id", "workspaceId", "projectId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "source_cleanup_plans"
  ADD CONSTRAINT "source_cleanup_plans_finding_fkey"
  FOREIGN KEY ("findingId", "contaminationReportId")
  REFERENCES "contamination_findings"("id", "reportId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "source_cleanup_plans"
  ADD CONSTRAINT "source_cleanup_plans_source_artifact_fkey"
  FOREIGN KEY ("sourceArtifactId", "workspaceId")
  REFERENCES "media_artifacts"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "source_cleanup_plans"
  ADD CONSTRAINT "source_cleanup_plans_source_manifest_fkey"
  FOREIGN KEY ("sourceManifestId", "workspaceId")
  REFERENCES "media_artifact_manifests"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "source_cleanup_plans"
  ADD CONSTRAINT "source_cleanup_plans_creator_fkey"
  FOREIGN KEY ("createdByClientId", "workspaceId")
  REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "source_cleanup_plans"
  ADD CONSTRAINT "source_cleanup_plans_rights_snapshot_fkey"
  FOREIGN KEY ("rightsSnapshotId", "workspaceId")
  REFERENCES "asset_rights_snapshots"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "source_cleanup_plans"
  ADD CONSTRAINT "source_cleanup_plans_operation_fkey"
  FOREIGN KEY ("operationId", "workspaceId")
  REFERENCES "public_operations"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "source_cleanup_results"
  ADD CONSTRAINT "source_cleanup_results_workspace_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "source_cleanup_results"
  ADD CONSTRAINT "source_cleanup_results_project_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "source_cleanup_results"
  ADD CONSTRAINT "source_cleanup_results_plan_fkey"
  FOREIGN KEY ("cleanupPlanId", "workspaceId", "projectId")
  REFERENCES "source_cleanup_plans"("id", "workspaceId", "projectId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "source_cleanup_results"
  ADD CONSTRAINT "source_cleanup_results_output_artifact_fkey"
  FOREIGN KEY ("outputArtifactId", "workspaceId")
  REFERENCES "media_artifacts"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "source_cleanup_results"
  ADD CONSTRAINT "source_cleanup_results_output_manifest_fkey"
  FOREIGN KEY ("outputManifestId", "workspaceId")
  REFERENCES "media_artifact_manifests"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "source_cleanup_results"
  ADD CONSTRAINT "source_cleanup_results_source_rights_fkey"
  FOREIGN KEY ("sourceRightsSnapshotId", "workspaceId")
  REFERENCES "asset_rights_snapshots"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "source_cleanup_results"
  ADD CONSTRAINT "source_cleanup_results_output_rights_fkey"
  FOREIGN KEY ("outputRightsSnapshotId", "workspaceId")
  REFERENCES "asset_rights_snapshots"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
