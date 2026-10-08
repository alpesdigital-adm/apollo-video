-- CreateTable
CREATE TABLE "perception_producer_envelopes" (
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
    "modality" VARCHAR(16) NOT NULL,
    "contentJson" TEXT NOT NULL,
    "envelopeHash" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "perception_producer_envelopes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "perception_producer_operations" (
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

    CONSTRAINT "perception_producer_operations_pkey" PRIMARY KEY ("operationId")
);

-- CreateIndex
CREATE UNIQUE INDEX "perception_producer_envelopes_operationId_key" ON "perception_producer_envelopes"("operationId");

-- CreateIndex
CREATE INDEX "perception_producer_envelopes_workspaceId_projectId_project_idx" ON "perception_producer_envelopes"("workspaceId", "projectId", "projectVersionId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "perception_producer_envelopes_workspaceId_sourceArtifactId__idx" ON "perception_producer_envelopes"("workspaceId", "sourceArtifactId", "sourceSha256");

-- CreateIndex
CREATE UNIQUE INDEX "perception_producer_envelopes_id_workspaceId_key" ON "perception_producer_envelopes"("id", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "perception_producer_envelopes_operationId_workspaceId_key" ON "perception_producer_envelopes"("operationId", "workspaceId");

-- CreateIndex
CREATE INDEX "perception_producer_operations_workspaceId_projectId_projec_idx" ON "perception_producer_operations"("workspaceId", "projectId", "projectVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "perception_producer_operations_operationId_workspaceId_key" ON "perception_producer_operations"("operationId", "workspaceId");

-- AddForeignKey
ALTER TABLE "perception_producer_envelopes" ADD CONSTRAINT "perception_producer_envelopes_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "perception_producer_envelopes" ADD CONSTRAINT "perception_producer_envelopes_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "perception_producer_envelopes" ADD CONSTRAINT "perception_producer_envelopes_projectVersionId_projectId_w_fkey" FOREIGN KEY ("projectVersionId", "projectId", "workspaceId") REFERENCES "project_versions"("id", "projectId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "perception_producer_envelopes" ADD CONSTRAINT "perception_producer_envelopes_operationId_workspaceId_fkey" FOREIGN KEY ("operationId", "workspaceId") REFERENCES "public_operations"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "perception_producer_envelopes" ADD CONSTRAINT "perception_producer_envelopes_sourceArtifactId_workspaceId_fkey" FOREIGN KEY ("sourceArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "perception_producer_envelopes" ADD CONSTRAINT "perception_producer_envelopes_editPlanSnapshotId_projectId_fkey" FOREIGN KEY ("editPlanSnapshotId", "projectId", "workspaceId") REFERENCES "project_snapshots"("id", "projectId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "perception_producer_operations" ADD CONSTRAINT "perception_producer_operations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "perception_producer_operations" ADD CONSTRAINT "perception_producer_operations_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "perception_producer_operations" ADD CONSTRAINT "perception_producer_operations_projectVersionId_projectId__fkey" FOREIGN KEY ("projectVersionId", "projectId", "workspaceId") REFERENCES "project_versions"("id", "projectId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "perception_producer_operations" ADD CONSTRAINT "perception_producer_operations_operationId_workspaceId_fkey" FOREIGN KEY ("operationId", "workspaceId") REFERENCES "public_operations"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "perception_producer_operations" ADD CONSTRAINT "perception_producer_operations_sourceArtifactId_workspaceI_fkey" FOREIGN KEY ("sourceArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "perception_producer_operations" ADD CONSTRAINT "perception_producer_operations_editPlanSnapshotId_projectI_fkey" FOREIGN KEY ("editPlanSnapshotId", "projectId", "workspaceId") REFERENCES "project_snapshots"("id", "projectId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
