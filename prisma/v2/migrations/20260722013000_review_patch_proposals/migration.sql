ALTER TABLE "edit_commands" DROP CONSTRAINT "edit_commands_type_check";
ALTER TABLE "edit_commands" ADD CONSTRAINT "edit_commands_type_check" CHECK ("type" IN ('remove-spoken-content', 'run-director', 'apply-review-patch'));

CREATE TABLE "review_patch_proposals" (
    "id" UUID NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "projectId" VARCHAR(128) NOT NULL,
    "annotationId" UUID NOT NULL,
    "baseVersionId" VARCHAR(128) NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "interpretationVersion" VARCHAR(128) NOT NULL,
    "choicesJson" TEXT NOT NULL,
    "patchJson" TEXT,
    "impactJson" TEXT,
    "gatesJson" TEXT NOT NULL,
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
    CONSTRAINT "review_patch_proposals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "review_patch_proposals_id_workspaceId_key" ON "review_patch_proposals"("id", "workspaceId");
CREATE UNIQUE INDEX "review_patch_proposals_workspaceId_projectId_idempotencyKey_key" ON "review_patch_proposals"("workspaceId", "projectId", "idempotencyKey");
CREATE UNIQUE INDEX "review_patch_proposals_resultVersionId_workspaceId_key" ON "review_patch_proposals"("resultVersionId", "workspaceId");
CREATE UNIQUE INDEX "review_patch_proposals_renderOperationId_workspaceId_key" ON "review_patch_proposals"("renderOperationId", "workspaceId");
CREATE INDEX "review_patch_proposals_workspaceId_projectId_annotationId_c_idx" ON "review_patch_proposals"("workspaceId", "projectId", "annotationId", "createdAt" DESC);
CREATE INDEX "review_patch_proposals_workspaceId_baseVersionId_status_idx" ON "review_patch_proposals"("workspaceId", "baseVersionId", "status");

ALTER TABLE "review_patch_proposals" ADD CONSTRAINT "review_patch_proposals_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "review_patch_proposals" ADD CONSTRAINT "review_patch_proposals_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "review_patch_proposals" ADD CONSTRAINT "review_patch_proposals_annotationId_workspaceId_fkey" FOREIGN KEY ("annotationId", "workspaceId") REFERENCES "review_annotations"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "review_patch_proposals" ADD CONSTRAINT "review_patch_proposals_baseVersionId_workspaceId_fkey" FOREIGN KEY ("baseVersionId", "workspaceId") REFERENCES "project_versions"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "review_patch_proposals" ADD CONSTRAINT "review_patch_proposals_resultVersionId_workspaceId_fkey" FOREIGN KEY ("resultVersionId", "workspaceId") REFERENCES "project_versions"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "review_patch_proposals" ADD CONSTRAINT "review_patch_proposals_renderOperationId_workspaceId_fkey" FOREIGN KEY ("renderOperationId", "workspaceId") REFERENCES "public_operations"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
