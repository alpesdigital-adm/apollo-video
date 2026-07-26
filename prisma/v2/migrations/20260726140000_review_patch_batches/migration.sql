ALTER TABLE "edit_commands" DROP CONSTRAINT "edit_commands_type_check";
ALTER TABLE "edit_commands" ADD CONSTRAINT "edit_commands_type_check" CHECK ("type" IN ('remove-spoken-content', 'run-director', 'apply-review-patch', 'apply-review-patch-batch'));

CREATE TABLE "review_patch_batches" (
    "id" UUID NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "projectId" VARCHAR(128) NOT NULL,
    "baseVersionId" VARCHAR(128) NOT NULL,
    "mode" VARCHAR(32) NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "patchJson" TEXT,
    "impactJson" TEXT,
    "conflictsJson" TEXT NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "requestFingerprint" CHAR(64) NOT NULL,
    "applyIdempotencyKey" VARCHAR(128),
    "applyRequestFingerprint" CHAR(64),
    "resultCommandId" VARCHAR(128),
    "resultVersionId" VARCHAR(128),
    "renderOperationId" VARCHAR(128),
    "comparisonJson" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "appliedAt" TIMESTAMPTZ(3),
    CONSTRAINT "review_patch_batches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "review_patch_batch_items" (
    "id" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "annotationId" UUID NOT NULL,
    "proposalId" UUID NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "operationJson" TEXT,
    "conflictIdsJson" TEXT NOT NULL,
    "reasonCode" VARCHAR(64),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "review_patch_batch_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "review_patch_batches_id_workspaceId_key" ON "review_patch_batches"("id", "workspaceId");
CREATE UNIQUE INDEX "review_patch_batches_workspaceId_projectId_idempotencyKey_key" ON "review_patch_batches"("workspaceId", "projectId", "idempotencyKey");
CREATE UNIQUE INDEX "review_patch_batches_resultVersionId_workspaceId_key" ON "review_patch_batches"("resultVersionId", "workspaceId");
CREATE UNIQUE INDEX "review_patch_batches_renderOperationId_workspaceId_key" ON "review_patch_batches"("renderOperationId", "workspaceId");
CREATE INDEX "review_patch_batches_workspaceId_projectId_createdAt_idx" ON "review_patch_batches"("workspaceId", "projectId", "createdAt" DESC);
CREATE INDEX "review_patch_batches_workspaceId_baseVersionId_status_idx" ON "review_patch_batches"("workspaceId", "baseVersionId", "status");

CREATE UNIQUE INDEX "review_patch_batch_items_batchId_annotationId_key" ON "review_patch_batch_items"("batchId", "annotationId");
CREATE UNIQUE INDEX "review_patch_batch_items_batchId_proposalId_key" ON "review_patch_batch_items"("batchId", "proposalId");
CREATE INDEX "review_patch_batch_items_workspaceId_annotationId_status_idx" ON "review_patch_batch_items"("workspaceId", "annotationId", "status");
CREATE INDEX "review_patch_batch_items_workspaceId_proposalId_idx" ON "review_patch_batch_items"("workspaceId", "proposalId");

ALTER TABLE "review_patch_batches" ADD CONSTRAINT "review_patch_batches_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "review_patch_batches" ADD CONSTRAINT "review_patch_batches_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "review_patch_batches" ADD CONSTRAINT "review_patch_batches_baseVersionId_workspaceId_fkey" FOREIGN KEY ("baseVersionId", "workspaceId") REFERENCES "project_versions"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "review_patch_batches" ADD CONSTRAINT "review_patch_batches_resultVersionId_workspaceId_fkey" FOREIGN KEY ("resultVersionId", "workspaceId") REFERENCES "project_versions"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "review_patch_batches" ADD CONSTRAINT "review_patch_batches_renderOperationId_workspaceId_fkey" FOREIGN KEY ("renderOperationId", "workspaceId") REFERENCES "public_operations"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "review_patch_batch_items" ADD CONSTRAINT "review_patch_batch_items_batchId_workspaceId_fkey" FOREIGN KEY ("batchId", "workspaceId") REFERENCES "review_patch_batches"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "review_patch_batch_items" ADD CONSTRAINT "review_patch_batch_items_annotationId_workspaceId_fkey" FOREIGN KEY ("annotationId", "workspaceId") REFERENCES "review_annotations"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "review_patch_batch_items" ADD CONSTRAINT "review_patch_batch_items_proposalId_workspaceId_fkey" FOREIGN KEY ("proposalId", "workspaceId") REFERENCES "review_patch_proposals"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
