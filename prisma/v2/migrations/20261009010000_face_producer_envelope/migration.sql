-- CreateTable
CREATE TABLE "face_producer_envelopes" (
    "id" VARCHAR(128) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "projectId" VARCHAR(128) NOT NULL,
    "projectVersionId" VARCHAR(128) NOT NULL,
    "operationId" VARCHAR(128) NOT NULL,
    "operationAttempt" INTEGER NOT NULL,
    "operationFenceHash" CHAR(64) NOT NULL,
    "sourceArtifactId" VARCHAR(128) NOT NULL,
    "sourceSha256" CHAR(64) NOT NULL,
    "editPlanSnapshotId" VARCHAR(128) NOT NULL,
    "editPlanSnapshotHash" CHAR(64) NOT NULL,
    "timeMapHash" CHAR(64) NOT NULL,
    "detectorConfigHash" CHAR(64) NOT NULL,
    "contentJson" TEXT NOT NULL,
    "envelopeHash" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "face_producer_envelopes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "face_producer_operations" (
    "operationId" VARCHAR(128) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "projectId" VARCHAR(128) NOT NULL,
    "projectVersionId" VARCHAR(128) NOT NULL,
    "projectVersionHash" CHAR(64) NOT NULL,
    "sourceArtifactId" VARCHAR(128) NOT NULL,
    "sourceSha256" CHAR(64) NOT NULL,
    "editPlanSnapshotId" VARCHAR(128) NOT NULL,
    "editPlanSnapshotHash" CHAR(64) NOT NULL,
    "sampleIntervalFrames" INTEGER NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "face_producer_operations_pkey" PRIMARY KEY ("operationId")
);

-- CreateIndex
CREATE UNIQUE INDEX "face_producer_envelopes_operationId_key" ON "face_producer_envelopes"("operationId");

-- CreateIndex
CREATE INDEX "face_producer_envelopes_workspaceId_projectId_projectVersio_idx" ON "face_producer_envelopes"("workspaceId", "projectId", "projectVersionId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "face_producer_envelopes_workspaceId_sourceArtifactId_source_idx" ON "face_producer_envelopes"("workspaceId", "sourceArtifactId", "sourceSha256");

-- CreateIndex
CREATE UNIQUE INDEX "face_producer_envelopes_id_workspaceId_key" ON "face_producer_envelopes"("id", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "face_producer_envelopes_operationId_workspaceId_key" ON "face_producer_envelopes"("operationId", "workspaceId");

-- CreateIndex
CREATE INDEX "face_producer_operations_workspaceId_projectId_projectVersi_idx" ON "face_producer_operations"("workspaceId", "projectId", "projectVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "face_producer_operations_operationId_workspaceId_key" ON "face_producer_operations"("operationId", "workspaceId");

-- AddForeignKey
ALTER TABLE "face_producer_envelopes" ADD CONSTRAINT "face_producer_envelopes_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "face_producer_envelopes" ADD CONSTRAINT "face_producer_envelopes_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "face_producer_envelopes" ADD CONSTRAINT "face_producer_envelopes_projectVersionId_projectId_workspa_fkey" FOREIGN KEY ("projectVersionId", "projectId", "workspaceId") REFERENCES "project_versions"("id", "projectId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "face_producer_envelopes" ADD CONSTRAINT "face_producer_envelopes_operationId_workspaceId_fkey" FOREIGN KEY ("operationId", "workspaceId") REFERENCES "public_operations"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "face_producer_envelopes" ADD CONSTRAINT "face_producer_envelopes_sourceArtifactId_workspaceId_fkey" FOREIGN KEY ("sourceArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "face_producer_envelopes" ADD CONSTRAINT "face_producer_envelopes_editPlanSnapshotId_projectId_works_fkey" FOREIGN KEY ("editPlanSnapshotId", "projectId", "workspaceId") REFERENCES "project_snapshots"("id", "projectId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "face_producer_operations" ADD CONSTRAINT "face_producer_operations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "face_producer_operations" ADD CONSTRAINT "face_producer_operations_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "face_producer_operations" ADD CONSTRAINT "face_producer_operations_projectVersionId_projectId_worksp_fkey" FOREIGN KEY ("projectVersionId", "projectId", "workspaceId") REFERENCES "project_versions"("id", "projectId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "face_producer_operations" ADD CONSTRAINT "face_producer_operations_operationId_workspaceId_fkey" FOREIGN KEY ("operationId", "workspaceId") REFERENCES "public_operations"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "face_producer_operations" ADD CONSTRAINT "face_producer_operations_sourceArtifactId_workspaceId_fkey" FOREIGN KEY ("sourceArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "face_producer_operations" ADD CONSTRAINT "face_producer_operations_editPlanSnapshotId_projectId_work_fkey" FOREIGN KEY ("editPlanSnapshotId", "projectId", "workspaceId") REFERENCES "project_snapshots"("id", "projectId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Extend the latest PublicOperation constraints for one independent facial subtype.
-- Existing phase, scope, progress, and type/target invariants remain intact.
ALTER TABLE "public_operations"
  DROP CONSTRAINT "public_operations_type_check",
  DROP CONSTRAINT "public_operations_type_target_check",
  DROP CONSTRAINT "public_operations_project_scope_check",
  DROP CONSTRAINT "public_operations_progress_check";

ALTER TABLE "public_operations"
  ADD CONSTRAINT "public_operations_type_check"
  CHECK ("type" IN ('artifact-render', 'synthetic-production-render', 'media-ingest', 'project-proxy-render', 'project-final-export', 'source-cleanup', 'long-form-index', 'project-director-run', 'perception-producer-run', 'perception-temporal-run', 'perception-face-run')),
  ADD CONSTRAINT "public_operations_type_target_check"
  CHECK (
    ("type" IN ('project-director-run', 'synthetic-production-render', 'perception-producer-run', 'perception-temporal-run', 'perception-face-run') AND "targetType" = 'project-version')
    OR
    ("type" NOT IN ('project-director-run', 'synthetic-production-render', 'perception-producer-run', 'perception-temporal-run', 'perception-face-run') AND "targetType" = 'media-artifact')
  ),
  ADD CONSTRAINT "public_operations_project_scope_check"
  CHECK (
    ("type" = 'artifact-render' AND "projectId" IS NULL)
    OR
    ("type" IN ('media-ingest', 'project-proxy-render', 'project-final-export', 'source-cleanup', 'long-form-index', 'project-director-run', 'synthetic-production-render', 'perception-producer-run', 'perception-temporal-run', 'perception-face-run') AND "projectId" IS NOT NULL)
  ),
  ADD CONSTRAINT "public_operations_progress_check" CHECK (
    "progressCompleted" IS NOT NULL
    AND "progressTotal" IS NOT NULL
    AND "progressUnit" IS NOT NULL
    AND "progressTotal" = CASE
      WHEN "type" IN ('artifact-render', 'synthetic-production-render', 'project-proxy-render', 'project-final-export', 'source-cleanup', 'perception-producer-run', 'perception-temporal-run', 'perception-face-run') THEN 4
      WHEN "type" IN ('media-ingest', 'long-form-index') THEN 6
      WHEN "type" = 'project-director-run' THEN 2
    END
    AND "progressUnit" = CASE
      WHEN "type" IN ('artifact-render', 'synthetic-production-render', 'project-proxy-render', 'project-final-export', 'source-cleanup') THEN 'render'
      ELSE 'stage'
    END
    AND ("type" <> 'perception-producer-run' OR "status" <> 'running'
      OR "phase" IN ('probing', 'transcribing', 'verifying', 'persisting'))
    AND ("type" <> 'perception-temporal-run' OR "status" <> 'running'
      OR "phase" IN ('probing', 'analyzing', 'verifying', 'persisting'))
    AND ("type" <> 'perception-face-run' OR "status" <> 'running'
      OR "phase" IN ('probing', 'analyzing', 'verifying', 'persisting'))
    AND (
      ("status" = 'queued' AND "phase" = 'queued' AND "progressCompleted" = 0)
      OR ("status" = 'running' AND "progressCompleted" = CASE
        WHEN "type" IN ('artifact-render', 'synthetic-production-render', 'project-proxy-render', 'project-final-export', 'source-cleanup') AND "phase" = 'materializing' THEN 0
        WHEN "type" IN ('artifact-render', 'synthetic-production-render', 'project-proxy-render', 'project-final-export', 'source-cleanup') AND "phase" = 'rendering' THEN 1
        WHEN "type" IN ('artifact-render', 'synthetic-production-render', 'project-proxy-render', 'project-final-export', 'source-cleanup') AND "phase" = 'verifying' THEN 2
        WHEN "type" IN ('artifact-render', 'synthetic-production-render', 'project-proxy-render', 'project-final-export', 'source-cleanup') AND "phase" = 'persisting' THEN 3
        WHEN "type" = 'media-ingest' AND "phase" = 'assembling' THEN 0
        WHEN "type" = 'media-ingest' AND "phase" = 'probing' THEN 1
        WHEN "type" = 'media-ingest' AND "phase" = 'normalizing' THEN 2
        WHEN "type" = 'media-ingest' AND "phase" = 'transcribing' THEN 3
        WHEN "type" = 'media-ingest' AND "phase" = 'verifying' THEN 4
        WHEN "type" = 'media-ingest' AND "phase" = 'persisting' THEN 5
        WHEN "type" = 'long-form-index' AND "phase" = 'probing' THEN 0
        WHEN "type" = 'long-form-index' AND "phase" = 'transcribing' THEN 1
        WHEN "type" = 'long-form-index' AND "phase" = 'diarizing' THEN 2
        WHEN "type" = 'long-form-index' AND "phase" = 'chunking' THEN 3
        WHEN "type" = 'long-form-index' AND "phase" = 'indexing' THEN 4
        WHEN "type" = 'long-form-index' AND "phase" = 'persisting' THEN 5
        WHEN "type" = 'project-director-run' AND "phase" = 'directing' THEN 0
        WHEN "type" = 'project-director-run' AND "phase" = 'persisting' THEN 1
        WHEN "type" = 'perception-producer-run' AND "phase" = 'probing' THEN 0
        WHEN "type" = 'perception-producer-run' AND "phase" = 'transcribing' THEN 1
        WHEN "type" = 'perception-producer-run' AND "phase" = 'verifying' THEN 2
        WHEN "type" = 'perception-producer-run' AND "phase" = 'persisting' THEN 3
        WHEN "type" = 'perception-temporal-run' AND "phase" = 'probing' THEN 0
        WHEN "type" = 'perception-temporal-run' AND "phase" = 'analyzing' THEN 1
        WHEN "type" = 'perception-temporal-run' AND "phase" = 'verifying' THEN 2
        WHEN "type" = 'perception-temporal-run' AND "phase" = 'persisting' THEN 3
        WHEN "type" = 'perception-face-run' AND "phase" = 'probing' THEN 0
        WHEN "type" = 'perception-face-run' AND "phase" = 'analyzing' THEN 1
        WHEN "type" = 'perception-face-run' AND "phase" = 'verifying' THEN 2
        WHEN "type" = 'perception-face-run' AND "phase" = 'persisting' THEN 3
      END)
      OR ("status" = 'succeeded' AND "phase" = 'completed' AND "progressCompleted" = "progressTotal")
      OR ("status" IN ('waiting', 'retrying', 'failed', 'canceled')
        AND "phase" = "status" AND "progressCompleted" >= 0 AND "progressCompleted" < "progressTotal")
    )
  );
