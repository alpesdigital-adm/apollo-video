CREATE TABLE "contamination_reports" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "sourceDeconstructionReportId" VARCHAR(128) NOT NULL,
  "sourceDeconstructionReportHash" CHAR(64) NOT NULL,
  "sourceArtifactId" VARCHAR(128) NOT NULL,
  "sourceArtifactSha256" CHAR(64) NOT NULL,
  "sourceDurationMs" INTEGER NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "policyVersion" VARCHAR(64) NOT NULL,
  "analyzerProvider" VARCHAR(128) NOT NULL,
  "analyzerModel" VARCHAR(128) NOT NULL,
  "analyzerVersion" VARCHAR(128) NOT NULL,
  "observationBatchHash" CHAR(64) NOT NULL,
  "analyzerJson" TEXT NOT NULL,
  "analyzerHash" CHAR(64) NOT NULL,
  "policyJson" TEXT NOT NULL,
  "policyHash" CHAR(64) NOT NULL,
  "reportJson" TEXT NOT NULL,
  "reportHash" CHAR(64) NOT NULL,
  "decision" VARCHAR(40) NOT NULL,
  "humanReviewRequired" BOOLEAN NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "findingCount" INTEGER NOT NULL,
  "observationCount" INTEGER NOT NULL,
  "protectedRegionCount" INTEGER NOT NULL,
  "overlapCount" INTEGER NOT NULL,
  "safeCount" INTEGER NOT NULL,
  "reviewCount" INTEGER NOT NULL,
  "destructiveCount" INTEGER NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "contamination_reports_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "contamination_reports_version_check" CHECK (
    "schemaVersion" = 'contamination-report/v1'
    AND "policyVersion" = 'source-contamination/v1'
  ),
  CONSTRAINT "contamination_reports_decision_check" CHECK (
    (
      "decision" = 'cleanup-eligible'
      AND NOT "humanReviewRequired"
      AND "reviewCount" = 0
      AND "destructiveCount" = 0
    )
    OR (
      "decision" = 'human-review'
      AND "humanReviewRequired"
      AND "destructiveCount" = 0
    )
    OR (
      "decision" = 'manual-preservation-required'
      AND "humanReviewRequired"
      AND "destructiveCount" > 0
    )
  ),
  CONSTRAINT "contamination_reports_counts_check" CHECK (
    "sourceDurationMs" BETWEEN 1 AND 86400000
    AND "confidence" BETWEEN 0 AND 1
    AND "findingCount" BETWEEN 0 AND 10000
    AND "observationCount" = "findingCount"
    AND "protectedRegionCount" BETWEEN 0 AND 5000
    AND "overlapCount" BETWEEN 0 AND 50000000
    AND "safeCount" BETWEEN 0 AND "findingCount"
    AND "reviewCount" BETWEEN 0 AND "findingCount"
    AND "destructiveCount" BETWEEN 0 AND "findingCount"
    AND (
      "safeCount" + "reviewCount" + "destructiveCount"
    ) = "findingCount"
  ),
  CONSTRAINT "contamination_reports_text_check" CHECK (
    length("analyzerProvider") BETWEEN 1 AND 128
    AND length("analyzerModel") BETWEEN 1 AND 128
    AND length("analyzerVersion") BETWEEN 1 AND 128
    AND length("analyzerJson") BETWEEN 2 AND 100000
    AND length("policyJson") BETWEEN 2 AND 100000
    AND length("reportJson") BETWEEN 2 AND 20000000
    AND length("idempotencyKey") BETWEEN 8 AND 128
  ),
  CONSTRAINT "contamination_reports_hash_check" CHECK (
    "sourceDeconstructionReportHash" ~ '^[a-f0-9]{64}$'
    AND "sourceArtifactSha256" ~ '^[a-f0-9]{64}$'
    AND "observationBatchHash" ~ '^[a-f0-9]{64}$'
    AND "analyzerHash" ~ '^[a-f0-9]{64}$'
    AND "policyHash" ~ '^[a-f0-9]{64}$'
    AND "reportHash" ~ '^[a-f0-9]{64}$'
    AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
  )
);

CREATE UNIQUE INDEX "contamination_reports_id_workspaceId_projectId_key"
  ON "contamination_reports"("id", "workspaceId", "projectId");
CREATE UNIQUE INDEX "contamination_reports_workspace_project_actor_idem_key"
  ON "contamination_reports"(
    "workspaceId",
    "projectId",
    "createdByClientId",
    "idempotencyKey"
  );
CREATE INDEX "contamination_reports_workspace_project_created_idx"
  ON "contamination_reports"(
    "workspaceId",
    "projectId",
    "createdAt" DESC,
    "id" DESC
  );
CREATE INDEX "contamination_reports_workspace_project_source_idx"
  ON "contamination_reports"(
    "workspaceId",
    "projectId",
    "sourceDeconstructionReportId",
    "createdAt" DESC
  );
CREATE INDEX "contamination_reports_workspace_artifact_created_idx"
  ON "contamination_reports"(
    "workspaceId",
    "sourceArtifactId",
    "createdAt" DESC
  );
CREATE INDEX "contamination_reports_workspace_decision_review_idx"
  ON "contamination_reports"(
    "workspaceId",
    "decision",
    "humanReviewRequired",
    "createdAt" DESC
  );

CREATE TABLE "contamination_observations" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "reportId" VARCHAR(128) NOT NULL,
  "kind" VARCHAR(32) NOT NULL,
  "startMs" INTEGER NOT NULL,
  "endMs" INTEGER NOT NULL,
  "regionX" DOUBLE PRECISION,
  "regionY" DOUBLE PRECISION,
  "regionWidth" DOUBLE PRECISION,
  "regionHeight" DOUBLE PRECISION,
  "confidence" DOUBLE PRECISION NOT NULL,
  "detectorProvider" VARCHAR(128) NOT NULL,
  "detectorModel" VARCHAR(128) NOT NULL,
  "detectorVersion" VARCHAR(128) NOT NULL,
  "detectorHash" CHAR(64) NOT NULL,
  "signalsJson" TEXT NOT NULL,
  "signalsHash" CHAR(64) NOT NULL,
  "observationHash" CHAR(64) NOT NULL,

  CONSTRAINT "contamination_observations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "contamination_observations_kind_check" CHECK (
    "kind" IN (
      'burned-caption',
      'logo-watermark',
      'music',
      'border',
      'overlay'
    )
  ),
  CONSTRAINT "contamination_observations_range_check" CHECK (
    "startMs" >= 0
    AND "endMs" > "startMs"
    AND "confidence" BETWEEN 0 AND 1
  ),
  CONSTRAINT "contamination_observations_region_check" CHECK (
    (
      "kind" = 'music'
      AND "regionX" IS NULL
      AND "regionY" IS NULL
      AND "regionWidth" IS NULL
      AND "regionHeight" IS NULL
    )
    OR (
      "kind" <> 'music'
      AND "regionX" BETWEEN 0 AND 1
      AND "regionY" BETWEEN 0 AND 1
      AND "regionWidth" > 0
      AND "regionHeight" > 0
      AND "regionX" + "regionWidth" <= 1.0001
      AND "regionY" + "regionHeight" <= 1.0001
    )
  ),
  CONSTRAINT "contamination_observations_text_check" CHECK (
    length("detectorProvider") BETWEEN 1 AND 128
    AND length("detectorModel") BETWEEN 1 AND 128
    AND length("detectorVersion") BETWEEN 1 AND 128
    AND length("signalsJson") BETWEEN 2 AND 100000
  ),
  CONSTRAINT "contamination_observations_hash_check" CHECK (
    "detectorHash" ~ '^[a-f0-9]{64}$'
    AND "signalsHash" ~ '^[a-f0-9]{64}$'
    AND "observationHash" ~ '^[a-f0-9]{64}$'
  )
);

CREATE UNIQUE INDEX "contamination_observations_id_reportId_key"
  ON "contamination_observations"("id", "reportId");
CREATE INDEX "contamination_observations_workspace_project_report_idx"
  ON "contamination_observations"(
    "workspaceId",
    "projectId",
    "reportId",
    "startMs"
  );
CREATE INDEX "contamination_observations_workspace_kind_confidence_idx"
  ON "contamination_observations"(
    "workspaceId",
    "kind",
    "confidence" DESC
  );

CREATE TABLE "contamination_protected_regions" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "reportId" VARCHAR(128) NOT NULL,
  "kind" VARCHAR(32) NOT NULL,
  "startMs" INTEGER NOT NULL,
  "endMs" INTEGER NOT NULL,
  "regionX" DOUBLE PRECISION NOT NULL,
  "regionY" DOUBLE PRECISION NOT NULL,
  "regionWidth" DOUBLE PRECISION NOT NULL,
  "regionHeight" DOUBLE PRECISION NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "source" VARCHAR(128) NOT NULL,
  "regionHash" CHAR(64) NOT NULL,

  CONSTRAINT "contamination_protected_regions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "contamination_protected_regions_kind_check" CHECK (
    "kind" IN (
      'face',
      'speaker',
      'essential-text',
      'product',
      'screen-content'
    )
  ),
  CONSTRAINT "contamination_protected_regions_range_check" CHECK (
    "startMs" >= 0
    AND "endMs" > "startMs"
    AND "confidence" BETWEEN 0 AND 1
  ),
  CONSTRAINT "contamination_protected_regions_region_check" CHECK (
    "regionX" BETWEEN 0 AND 1
    AND "regionY" BETWEEN 0 AND 1
    AND "regionWidth" > 0
    AND "regionHeight" > 0
    AND "regionX" + "regionWidth" <= 1.0001
    AND "regionY" + "regionHeight" <= 1.0001
  ),
  CONSTRAINT "contamination_protected_regions_hash_check" CHECK (
    "regionHash" ~ '^[a-f0-9]{64}$'
  )
);

CREATE UNIQUE INDEX "contamination_protected_regions_id_reportId_key"
  ON "contamination_protected_regions"("id", "reportId");
CREATE INDEX "contamination_protected_regions_workspace_project_report_idx"
  ON "contamination_protected_regions"(
    "workspaceId",
    "projectId",
    "reportId",
    "startMs"
  );
CREATE INDEX "contamination_protected_regions_workspace_kind_conf_idx"
  ON "contamination_protected_regions"(
    "workspaceId",
    "kind",
    "confidence" DESC
  );

CREATE TABLE "contamination_findings" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "reportId" VARCHAR(128) NOT NULL,
  "observationId" VARCHAR(128) NOT NULL,
  "kind" VARCHAR(32) NOT NULL,
  "startMs" INTEGER NOT NULL,
  "endMs" INTEGER NOT NULL,
  "regionX" DOUBLE PRECISION,
  "regionY" DOUBLE PRECISION,
  "regionWidth" DOUBLE PRECISION,
  "regionHeight" DOUBLE PRECISION,
  "confidence" DOUBLE PRECISION NOT NULL,
  "overlapsEssentialTime" BOOLEAN NOT NULL,
  "essentialOverlapRatio" DOUBLE PRECISION NOT NULL,
  "protectedRegionIdsJson" TEXT NOT NULL,
  "protectedRegionIntersectionRatio" DOUBLE PRECISION NOT NULL,
  "removalImpact" VARCHAR(32) NOT NULL,
  "removalWouldDestroyEssential" BOOLEAN NOT NULL,
  "requiresHumanReview" BOOLEAN NOT NULL,
  "reasonCodesJson" TEXT NOT NULL,
  "observationHash" CHAR(64) NOT NULL,
  "findingHash" CHAR(64) NOT NULL,

  CONSTRAINT "contamination_findings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "contamination_findings_kind_check" CHECK (
    "kind" IN (
      'burned-caption',
      'logo-watermark',
      'music',
      'border',
      'overlay'
    )
  ),
  CONSTRAINT "contamination_findings_range_check" CHECK (
    "startMs" >= 0
    AND "endMs" > "startMs"
    AND "confidence" BETWEEN 0 AND 1
    AND "essentialOverlapRatio" BETWEEN 0 AND 1
    AND "protectedRegionIntersectionRatio" BETWEEN 0 AND 1
    AND "overlapsEssentialTime" =
      ("essentialOverlapRatio" > 0)
  ),
  CONSTRAINT "contamination_findings_region_check" CHECK (
    (
      "kind" = 'music'
      AND "regionX" IS NULL
      AND "regionY" IS NULL
      AND "regionWidth" IS NULL
      AND "regionHeight" IS NULL
    )
    OR (
      "kind" <> 'music'
      AND "regionX" BETWEEN 0 AND 1
      AND "regionY" BETWEEN 0 AND 1
      AND "regionWidth" > 0
      AND "regionHeight" > 0
      AND "regionX" + "regionWidth" <= 1.0001
      AND "regionY" + "regionHeight" <= 1.0001
    )
  ),
  CONSTRAINT "contamination_findings_impact_check" CHECK (
    (
      "removalImpact" = 'safe'
      AND NOT "removalWouldDestroyEssential"
    )
    OR (
      "removalImpact" = 'review-required'
      AND NOT "removalWouldDestroyEssential"
      AND "requiresHumanReview"
    )
    OR (
      "removalImpact" = 'destructive'
      AND "removalWouldDestroyEssential"
      AND "requiresHumanReview"
    )
  ),
  CONSTRAINT "contamination_findings_json_check" CHECK (
    length("protectedRegionIdsJson") BETWEEN 2 AND 1000000
    AND length("reasonCodesJson") BETWEEN 2 AND 100000
  ),
  CONSTRAINT "contamination_findings_hash_check" CHECK (
    "observationHash" ~ '^[a-f0-9]{64}$'
    AND "findingHash" ~ '^[a-f0-9]{64}$'
  )
);

CREATE UNIQUE INDEX "contamination_findings_id_reportId_key"
  ON "contamination_findings"("id", "reportId");
CREATE UNIQUE INDEX "contamination_findings_observationId_reportId_key"
  ON "contamination_findings"("observationId", "reportId");
CREATE INDEX "contamination_findings_workspace_project_report_idx"
  ON "contamination_findings"(
    "workspaceId",
    "projectId",
    "reportId",
    "startMs"
  );
CREATE INDEX "contamination_findings_workspace_kind_impact_idx"
  ON "contamination_findings"(
    "workspaceId",
    "kind",
    "removalImpact",
    "confidence" DESC
  );
CREATE INDEX "contamination_findings_workspace_review_confidence_idx"
  ON "contamination_findings"(
    "workspaceId",
    "requiresHumanReview",
    "confidence" DESC
  );

CREATE TABLE "contamination_overlaps" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "reportId" VARCHAR(128) NOT NULL,
  "leftFindingId" VARCHAR(128) NOT NULL,
  "rightFindingId" VARCHAR(128) NOT NULL,
  "startMs" INTEGER NOT NULL,
  "endMs" INTEGER NOT NULL,
  "spatiallyOverlapping" BOOLEAN NOT NULL,
  "intersectionX" DOUBLE PRECISION,
  "intersectionY" DOUBLE PRECISION,
  "intersectionWidth" DOUBLE PRECISION,
  "intersectionHeight" DOUBLE PRECISION,
  "confidence" DOUBLE PRECISION NOT NULL,
  "overlapHash" CHAR(64) NOT NULL,

  CONSTRAINT "contamination_overlaps_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "contamination_overlaps_pair_check" CHECK (
    "leftFindingId" < "rightFindingId"
    AND "startMs" >= 0
    AND "endMs" > "startMs"
    AND "spatiallyOverlapping"
    AND "confidence" BETWEEN 0 AND 1
  ),
  CONSTRAINT "contamination_overlaps_region_check" CHECK (
    (
      "intersectionX" IS NULL
      AND "intersectionY" IS NULL
      AND "intersectionWidth" IS NULL
      AND "intersectionHeight" IS NULL
    )
    OR (
      "intersectionX" BETWEEN 0 AND 1
      AND "intersectionY" BETWEEN 0 AND 1
      AND "intersectionWidth" > 0
      AND "intersectionHeight" > 0
      AND "intersectionX" + "intersectionWidth" <= 1.0001
      AND "intersectionY" + "intersectionHeight" <= 1.0001
    )
  ),
  CONSTRAINT "contamination_overlaps_hash_check" CHECK (
    "overlapHash" ~ '^[a-f0-9]{64}$'
  )
);

CREATE UNIQUE INDEX "contamination_overlaps_id_reportId_key"
  ON "contamination_overlaps"("id", "reportId");
CREATE UNIQUE INDEX "contamination_overlaps_report_pair_key"
  ON "contamination_overlaps"(
    "reportId",
    "leftFindingId",
    "rightFindingId"
  );
CREATE INDEX "contamination_overlaps_workspace_project_report_idx"
  ON "contamination_overlaps"(
    "workspaceId",
    "projectId",
    "reportId",
    "startMs"
  );
CREATE INDEX "contamination_overlaps_workspace_confidence_idx"
  ON "contamination_overlaps"(
    "workspaceId",
    "confidence" DESC
  );

ALTER TABLE "contamination_reports"
  ADD CONSTRAINT "contamination_reports_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "contamination_reports"
  ADD CONSTRAINT "contamination_reports_project_workspace_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "contamination_reports"
  ADD CONSTRAINT "contamination_reports_source_deconstruction_fkey"
  FOREIGN KEY (
    "sourceDeconstructionReportId",
    "workspaceId",
    "projectId"
  )
  REFERENCES "source_deconstruction_reports"(
    "id",
    "workspaceId",
    "projectId"
  )
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "contamination_reports"
  ADD CONSTRAINT "contamination_reports_source_artifact_fkey"
  FOREIGN KEY ("sourceArtifactId", "workspaceId")
  REFERENCES "media_artifacts"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "contamination_reports"
  ADD CONSTRAINT "contamination_reports_creator_fkey"
  FOREIGN KEY ("createdByClientId", "workspaceId")
  REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "contamination_observations"
  ADD CONSTRAINT "contamination_observations_workspace_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "contamination_observations"
  ADD CONSTRAINT "contamination_observations_project_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "contamination_observations"
  ADD CONSTRAINT "contamination_observations_report_fkey"
  FOREIGN KEY ("reportId", "workspaceId", "projectId")
  REFERENCES "contamination_reports"(
    "id",
    "workspaceId",
    "projectId"
  )
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "contamination_protected_regions"
  ADD CONSTRAINT "contamination_protected_regions_workspace_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "contamination_protected_regions"
  ADD CONSTRAINT "contamination_protected_regions_project_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "contamination_protected_regions"
  ADD CONSTRAINT "contamination_protected_regions_report_fkey"
  FOREIGN KEY ("reportId", "workspaceId", "projectId")
  REFERENCES "contamination_reports"(
    "id",
    "workspaceId",
    "projectId"
  )
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "contamination_findings"
  ADD CONSTRAINT "contamination_findings_workspace_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "contamination_findings"
  ADD CONSTRAINT "contamination_findings_project_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "contamination_findings"
  ADD CONSTRAINT "contamination_findings_report_fkey"
  FOREIGN KEY ("reportId", "workspaceId", "projectId")
  REFERENCES "contamination_reports"(
    "id",
    "workspaceId",
    "projectId"
  )
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "contamination_findings"
  ADD CONSTRAINT "contamination_findings_observation_fkey"
  FOREIGN KEY ("observationId", "reportId")
  REFERENCES "contamination_observations"("id", "reportId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "contamination_overlaps"
  ADD CONSTRAINT "contamination_overlaps_workspace_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "contamination_overlaps"
  ADD CONSTRAINT "contamination_overlaps_project_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "contamination_overlaps"
  ADD CONSTRAINT "contamination_overlaps_report_fkey"
  FOREIGN KEY ("reportId", "workspaceId", "projectId")
  REFERENCES "contamination_reports"(
    "id",
    "workspaceId",
    "projectId"
  )
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "contamination_overlaps"
  ADD CONSTRAINT "contamination_overlaps_left_finding_fkey"
  FOREIGN KEY ("leftFindingId", "reportId")
  REFERENCES "contamination_findings"("id", "reportId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "contamination_overlaps"
  ADD CONSTRAINT "contamination_overlaps_right_finding_fkey"
  FOREIGN KEY ("rightFindingId", "reportId")
  REFERENCES "contamination_findings"("id", "reportId")
  ON DELETE CASCADE ON UPDATE CASCADE;
