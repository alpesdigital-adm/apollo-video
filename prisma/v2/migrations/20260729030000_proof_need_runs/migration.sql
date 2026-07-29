CREATE TABLE "proof_need_runs" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "batchId" VARCHAR(128) NOT NULL,
  "targetRecipeId" VARCHAR(128) NOT NULL,
  "targetRecipeHash" CHAR(64) NOT NULL,
  "baseStoryPlanId" VARCHAR(128) NOT NULL,
  "baseStoryPlanHash" CHAR(64) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "policyVersion" VARCHAR(64) NOT NULL,
  "objective" VARCHAR(128) NOT NULL,
  "storyPlanJson" TEXT NOT NULL,
  "storyPlanHash" CHAR(64) NOT NULL,
  "needCount" INTEGER NOT NULL,
  "requiredCount" INTEGER NOT NULL,
  "evidenceSearchCount" INTEGER NOT NULL,
  "selectedEvidenceCount" INTEGER NOT NULL,
  "proofUnavailableCount" INTEGER NOT NULL,
  "noProofNeededCount" INTEGER NOT NULL,
  "genericCardCount" INTEGER NOT NULL DEFAULT 0,
  "runJson" TEXT NOT NULL,
  "runHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "proof_need_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "proof_need_runs_version_check" CHECK (
    "schemaVersion" = 'proof-need-run/v1'
    AND "policyVersion" = 'proof-need-policy/v1'
  ),
  CONSTRAINT "proof_need_runs_counts_check" CHECK (
    "needCount" BETWEEN 1 AND 16
    AND "requiredCount" BETWEEN 0 AND "needCount"
    AND "evidenceSearchCount" = "requiredCount"
    AND "selectedEvidenceCount" BETWEEN 0 AND "requiredCount"
    AND "proofUnavailableCount" BETWEEN 0 AND "requiredCount"
    AND "noProofNeededCount" BETWEEN 0 AND "needCount"
    AND (
      "selectedEvidenceCount"
      + "proofUnavailableCount"
      + "noProofNeededCount"
    ) = "needCount"
    AND "genericCardCount" = 0
  ),
  CONSTRAINT "proof_need_runs_content_check" CHECK (
    length("storyPlanJson") BETWEEN 2 AND 5000000
    AND length("runJson") BETWEEN 2 AND 10000000
    AND length("objective") BETWEEN 3 AND 128
    AND length("idempotencyKey") BETWEEN 8 AND 128
  ),
  CONSTRAINT "proof_need_runs_hash_check" CHECK (
    "targetRecipeHash" ~ '^[a-f0-9]{64}$'
    AND "baseStoryPlanHash" ~ '^[a-f0-9]{64}$'
    AND "storyPlanHash" ~ '^[a-f0-9]{64}$'
    AND "runHash" ~ '^[a-f0-9]{64}$'
    AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
  )
);

CREATE INDEX "proof_need_runs_workspaceId_projectId_createdAt_id_idx"
  ON "proof_need_runs"(
    "workspaceId",
    "projectId",
    "createdAt" DESC,
    "id" DESC
  );
CREATE INDEX "proof_need_runs_workspaceId_batchId_createdAt_idx"
  ON "proof_need_runs"("workspaceId", "batchId", "createdAt" DESC);
CREATE INDEX "proof_need_runs_workspaceId_targetRecipeId_createdAt_idx"
  ON "proof_need_runs"(
    "workspaceId",
    "targetRecipeId",
    "createdAt" DESC
  );
CREATE INDEX "proof_need_runs_workspaceId_proofUnavailableCount_createdAt_idx"
  ON "proof_need_runs"(
    "workspaceId",
    "proofUnavailableCount",
    "createdAt" DESC
  );
CREATE UNIQUE INDEX "proof_need_runs_id_workspaceId_key"
  ON "proof_need_runs"("id", "workspaceId");
CREATE UNIQUE INDEX "proof_need_runs_id_workspaceId_projectId_key"
  ON "proof_need_runs"("id", "workspaceId", "projectId");
CREATE UNIQUE INDEX "proof_need_runs_workspaceId_projectId_createdByClientId_ide_key"
  ON "proof_need_runs"(
    "workspaceId",
    "projectId",
    "createdByClientId",
    "idempotencyKey"
  );

CREATE TABLE "proof_need_items" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "runId" VARCHAR(128) NOT NULL,
  "sequence" INTEGER NOT NULL,
  "storyBlockId" VARCHAR(128) NOT NULL,
  "claimId" VARCHAR(128) NOT NULL,
  "claimText" TEXT NOT NULL,
  "claimKind" VARCHAR(32) NOT NULL,
  "type" VARCHAR(32) NOT NULL,
  "function" VARCHAR(64) NOT NULL,
  "required" BOOLEAN NOT NULL,
  "momentJson" TEXT NOT NULL,
  "momentFrame" INTEGER NOT NULL,
  "momentMs" INTEGER NOT NULL,
  "searchAttempted" BOOLEAN NOT NULL,
  "searchedCategoriesText" TEXT NOT NULL,
  "candidateCount" INTEGER NOT NULL,
  "resolution" VARCHAR(32) NOT NULL,
  "selectedEvidenceId" VARCHAR(128),
  "selectedEvidenceHash" CHAR(64),
  "proofUnavailable" BOOLEAN NOT NULL,
  "genericCardGenerated" BOOLEAN NOT NULL DEFAULT FALSE,
  "itemJson" TEXT NOT NULL,
  "itemHash" CHAR(64) NOT NULL,

  CONSTRAINT "proof_need_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "proof_need_items_sequence_check" CHECK (
    "sequence" BETWEEN 1 AND 16
    AND "momentFrame" >= 0
    AND "momentMs" >= 0
    AND "candidateCount" >= 0
  ),
  CONSTRAINT "proof_need_items_type_check" CHECK (
    (
      "claimKind" = 'outcome'
      AND "type" = 'testimonial'
      AND "function" = 'build-trust'
      AND "required"
    )
    OR (
      "claimKind" = 'quantified'
      AND "type" = 'data'
      AND "function" = 'substantiate-quantified-claim'
      AND "required"
    )
    OR (
      "claimKind" = 'mechanism'
      AND "type" = 'demonstration'
      AND "function" = 'demonstrate-mechanism'
      AND "required"
    )
    OR (
      "claimKind" = 'low-risk'
      AND "type" = 'none'
      AND "function" = 'no-proof-needed'
      AND NOT "required"
    )
  ),
  CONSTRAINT "proof_need_items_resolution_check" CHECK (
    NOT "genericCardGenerated"
    AND "searchAttempted" = "required"
    AND (
      (
        "resolution" = 'selected-evidence'
        AND "required"
        AND NOT "proofUnavailable"
        AND "selectedEvidenceId" IS NOT NULL
        AND "selectedEvidenceHash" IS NOT NULL
      )
      OR (
        "resolution" = 'proof-unavailable'
        AND "required"
        AND "proofUnavailable"
        AND "selectedEvidenceId" IS NULL
        AND "selectedEvidenceHash" IS NULL
      )
      OR (
        "resolution" = 'no-proof-needed'
        AND NOT "required"
        AND NOT "proofUnavailable"
        AND "selectedEvidenceId" IS NULL
        AND "selectedEvidenceHash" IS NULL
      )
    )
  ),
  CONSTRAINT "proof_need_items_content_check" CHECK (
    length("claimText") BETWEEN 2 AND 2000
    AND length("momentJson") BETWEEN 2 AND 100000
    AND length("searchedCategoriesText") BETWEEN 0 AND 1000
    AND length("itemJson") BETWEEN 2 AND 1000000
  ),
  CONSTRAINT "proof_need_items_hash_check" CHECK (
    (
      "selectedEvidenceHash" IS NULL
      OR "selectedEvidenceHash" ~ '^[a-f0-9]{64}$'
    )
    AND "itemHash" ~ '^[a-f0-9]{64}$'
  )
);

CREATE INDEX "proof_need_items_workspaceId_projectId_resolution_type_idx"
  ON "proof_need_items"(
    "workspaceId",
    "projectId",
    "resolution",
    "type"
  );
CREATE INDEX "proof_need_items_workspaceId_runId_sequence_idx"
  ON "proof_need_items"("workspaceId", "runId", "sequence");
CREATE INDEX "proof_need_items_workspaceId_selectedEvidenceId_idx"
  ON "proof_need_items"("workspaceId", "selectedEvidenceId");
CREATE INDEX "proof_need_items_workspaceId_proofUnavailable_type_idx"
  ON "proof_need_items"("workspaceId", "proofUnavailable", "type");
CREATE UNIQUE INDEX "proof_need_items_id_workspaceId_key"
  ON "proof_need_items"("id", "workspaceId");
CREATE UNIQUE INDEX "proof_need_items_runId_sequence_key"
  ON "proof_need_items"("runId", "sequence");
CREATE UNIQUE INDEX "proof_need_items_runId_storyBlockId_claimId_key"
  ON "proof_need_items"("runId", "storyBlockId", "claimId");

ALTER TABLE "proof_need_runs"
  ADD CONSTRAINT "proof_need_runs_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "proof_need_runs"
  ADD CONSTRAINT "proof_need_runs_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "proof_need_runs"
  ADD CONSTRAINT "proof_need_runs_batchId_workspaceId_fkey"
  FOREIGN KEY ("batchId", "workspaceId")
  REFERENCES "production_batches"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "proof_need_runs"
  ADD CONSTRAINT "proof_need_runs_targetRecipeId_workspaceId_fkey"
  FOREIGN KEY ("targetRecipeId", "workspaceId")
  REFERENCES "variant_recipe_runs"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "proof_need_runs"
  ADD CONSTRAINT "proof_need_runs_createdByClientId_workspaceId_fkey"
  FOREIGN KEY ("createdByClientId", "workspaceId")
  REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "proof_need_items"
  ADD CONSTRAINT "proof_need_items_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "proof_need_items"
  ADD CONSTRAINT "proof_need_items_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "proof_need_items"
  ADD CONSTRAINT "proof_need_items_runId_workspaceId_projectId_fkey"
  FOREIGN KEY ("runId", "workspaceId", "projectId")
  REFERENCES "proof_need_runs"("id", "workspaceId", "projectId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "proof_need_items"
  ADD CONSTRAINT "proof_need_items_selectedEvidenceId_workspaceId_fkey"
  FOREIGN KEY ("selectedEvidenceId", "workspaceId")
  REFERENCES "evidence_segments"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
