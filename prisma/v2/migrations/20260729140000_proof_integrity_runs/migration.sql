CREATE UNIQUE INDEX "proof_need_items_id_workspaceId_runId_key"
  ON "proof_need_items"("id", "workspaceId", "runId");

CREATE TABLE "proof_integrity_runs" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "batchId" VARCHAR(128) NOT NULL,
  "targetRecipeId" VARCHAR(128) NOT NULL,
  "targetRecipeHash" CHAR(64) NOT NULL,
  "proofNeedRunId" VARCHAR(128) NOT NULL,
  "proofNeedRunHash" CHAR(64) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "policyVersion" VARCHAR(64) NOT NULL,
  "evaluationCount" INTEGER NOT NULL,
  "approvedCount" INTEGER NOT NULL,
  "blockedCount" INTEGER NOT NULL,
  "notApplicableCount" INTEGER NOT NULL,
  "hardIssueCount" INTEGER NOT NULL,
  "fabricationSuggestionCount" INTEGER NOT NULL DEFAULT 0,
  "readyForAssembly" BOOLEAN NOT NULL,
  "runJson" TEXT NOT NULL,
  "runHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "proof_integrity_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "proof_integrity_runs_version_check" CHECK (
    "schemaVersion" = 'proof-integrity-run/v1'
    AND "policyVersion" = 'proof-integrity-policy/v1'
  ),
  CONSTRAINT "proof_integrity_runs_counts_check" CHECK (
    "evaluationCount" BETWEEN 1 AND 16
    AND "approvedCount" BETWEEN 0 AND "evaluationCount"
    AND "blockedCount" BETWEEN 0 AND "evaluationCount"
    AND "notApplicableCount" BETWEEN 0 AND "evaluationCount"
    AND (
      "approvedCount" + "blockedCount" + "notApplicableCount"
    ) = "evaluationCount"
    AND "hardIssueCount" = "blockedCount"
    AND "fabricationSuggestionCount" = 0
    AND "readyForAssembly" = ("blockedCount" = 0)
  ),
  CONSTRAINT "proof_integrity_runs_content_check" CHECK (
    length("runJson") BETWEEN 2 AND 10000000
    AND length("idempotencyKey") BETWEEN 8 AND 128
  ),
  CONSTRAINT "proof_integrity_runs_hash_check" CHECK (
    "targetRecipeHash" ~ '^[a-f0-9]{64}$'
    AND "proofNeedRunHash" ~ '^[a-f0-9]{64}$'
    AND "runHash" ~ '^[a-f0-9]{64}$'
    AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
  )
);

CREATE UNIQUE INDEX "proof_integrity_runs_id_workspaceId_key"
  ON "proof_integrity_runs"("id", "workspaceId");
CREATE UNIQUE INDEX "proof_integrity_runs_id_workspaceId_projectId_key"
  ON "proof_integrity_runs"("id", "workspaceId", "projectId");
CREATE UNIQUE INDEX "proof_integrity_runs_workspaceId_projectId_createdByClientI_key"
  ON "proof_integrity_runs"(
    "workspaceId",
    "projectId",
    "createdByClientId",
    "idempotencyKey"
  );
CREATE INDEX "proof_integrity_runs_workspaceId_projectId_createdAt_id_idx"
  ON "proof_integrity_runs"(
    "workspaceId",
    "projectId",
    "createdAt" DESC,
    "id" DESC
  );
CREATE INDEX "proof_integrity_runs_workspaceId_proofNeedRunId_createdAt_idx"
  ON "proof_integrity_runs"(
    "workspaceId",
    "proofNeedRunId",
    "createdAt" DESC
  );
CREATE INDEX "proof_integrity_runs_workspaceId_targetRecipeId_createdAt_idx"
  ON "proof_integrity_runs"(
    "workspaceId",
    "targetRecipeId",
    "createdAt" DESC
  );
CREATE INDEX "proof_integrity_runs_workspaceId_readyForAssembly_blockedCo_idx"
  ON "proof_integrity_runs"(
    "workspaceId",
    "readyForAssembly",
    "blockedCount",
    "createdAt" DESC
  );

CREATE TABLE "proof_integrity_evaluations" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "runId" VARCHAR(128) NOT NULL,
  "proofNeedRunId" VARCHAR(128) NOT NULL,
  "proofNeedItemId" VARCHAR(128) NOT NULL,
  "proofNeedItemHash" CHAR(64) NOT NULL,
  "sequence" INTEGER NOT NULL,
  "proofNeedResolution" VARCHAR(32) NOT NULL,
  "selectedEvidenceId" VARCHAR(128),
  "selectedEvidenceHash" CHAR(64),
  "outcome" VARCHAR(32) NOT NULL,
  "allowedForAssembly" BOOLEAN NOT NULL,
  "recipeContextJson" TEXT,
  "recipeContextHash" CHAR(64),
  "useJson" TEXT NOT NULL,
  "comparisonsJson" TEXT NOT NULL,
  "comparisonCount" INTEGER NOT NULL,
  "reasonCodesText" TEXT NOT NULL,
  "reasonCount" INTEGER NOT NULL,
  "presentationJson" TEXT,
  "presentationHash" CHAR(64),
  "issueJson" TEXT,
  "issueHash" CHAR(64),
  "fabricationSuggested" BOOLEAN NOT NULL DEFAULT FALSE,
  "evaluatedAt" TIMESTAMPTZ(3) NOT NULL,
  "evaluationJson" TEXT NOT NULL,
  "evaluationHash" CHAR(64) NOT NULL,

  CONSTRAINT "proof_integrity_evaluations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "proof_integrity_evaluations_sequence_check" CHECK (
    "sequence" BETWEEN 1 AND 16
    AND "comparisonCount" BETWEEN 0 AND 8
    AND "reasonCount" BETWEEN 0 AND 32
  ),
  CONSTRAINT "proof_integrity_evaluations_outcome_check" CHECK (
    NOT "fabricationSuggested"
    AND (
      (
        "outcome" = 'approved'
        AND "proofNeedResolution" = 'selected-evidence'
        AND "allowedForAssembly"
        AND "selectedEvidenceId" IS NOT NULL
        AND "selectedEvidenceHash" IS NOT NULL
        AND "recipeContextJson" IS NOT NULL
        AND "recipeContextHash" IS NOT NULL
        AND "presentationJson" IS NOT NULL
        AND "presentationHash" IS NOT NULL
        AND "issueJson" IS NULL
        AND "issueHash" IS NULL
        AND "reasonCount" = 0
        AND "comparisonCount" = 8
      )
      OR (
        "outcome" = 'blocked'
        AND NOT "allowedForAssembly"
        AND "issueJson" IS NOT NULL
        AND "issueHash" IS NOT NULL
        AND "reasonCount" >= 1
      )
      OR (
        "outcome" = 'not-applicable'
        AND "proofNeedResolution" = 'no-proof-needed'
        AND NOT "allowedForAssembly"
        AND "selectedEvidenceId" IS NULL
        AND "selectedEvidenceHash" IS NULL
        AND "recipeContextJson" IS NULL
        AND "recipeContextHash" IS NULL
        AND "presentationJson" IS NULL
        AND "presentationHash" IS NULL
        AND "issueJson" IS NULL
        AND "issueHash" IS NULL
        AND "reasonCount" = 0
        AND "comparisonCount" = 0
      )
    )
    AND (
      (
        "proofNeedResolution" = 'selected-evidence'
        AND "selectedEvidenceId" IS NOT NULL
        AND "selectedEvidenceHash" IS NOT NULL
      )
      OR (
        "proofNeedResolution" IN (
          'proof-unavailable',
          'no-proof-needed'
        )
        AND "selectedEvidenceId" IS NULL
        AND "selectedEvidenceHash" IS NULL
      )
    )
    AND (
      ("recipeContextJson" IS NULL AND "recipeContextHash" IS NULL)
      OR
      ("recipeContextJson" IS NOT NULL AND "recipeContextHash" IS NOT NULL)
    )
    AND (
      ("presentationJson" IS NULL AND "presentationHash" IS NULL)
      OR
      ("presentationJson" IS NOT NULL AND "presentationHash" IS NOT NULL)
    )
    AND (
      ("issueJson" IS NULL AND "issueHash" IS NULL)
      OR
      ("issueJson" IS NOT NULL AND "issueHash" IS NOT NULL)
    )
  ),
  CONSTRAINT "proof_integrity_evaluations_content_check" CHECK (
    length("useJson") BETWEEN 2 AND 100000
    AND length("comparisonsJson") BETWEEN 2 AND 1000000
    AND length("reasonCodesText") BETWEEN 0 AND 4000
    AND length("evaluationJson") BETWEEN 2 AND 5000000
    AND (
      "recipeContextJson" IS NULL
      OR length("recipeContextJson") BETWEEN 2 AND 1000000
    )
    AND (
      "presentationJson" IS NULL
      OR length("presentationJson") BETWEEN 2 AND 1000000
    )
    AND (
      "issueJson" IS NULL
      OR length("issueJson") BETWEEN 2 AND 1000000
    )
  ),
  CONSTRAINT "proof_integrity_evaluations_hash_check" CHECK (
    "proofNeedItemHash" ~ '^[a-f0-9]{64}$'
    AND (
      "selectedEvidenceHash" IS NULL
      OR "selectedEvidenceHash" ~ '^[a-f0-9]{64}$'
    )
    AND (
      "recipeContextHash" IS NULL
      OR "recipeContextHash" ~ '^[a-f0-9]{64}$'
    )
    AND (
      "presentationHash" IS NULL
      OR "presentationHash" ~ '^[a-f0-9]{64}$'
    )
    AND (
      "issueHash" IS NULL
      OR "issueHash" ~ '^[a-f0-9]{64}$'
    )
    AND "evaluationHash" ~ '^[a-f0-9]{64}$'
  )
);

CREATE UNIQUE INDEX "proof_integrity_evaluations_id_workspaceId_key"
  ON "proof_integrity_evaluations"("id", "workspaceId");
CREATE UNIQUE INDEX "proof_integrity_evaluations_runId_sequence_key"
  ON "proof_integrity_evaluations"("runId", "sequence");
CREATE UNIQUE INDEX "proof_integrity_evaluations_runId_proofNeedItemId_key"
  ON "proof_integrity_evaluations"("runId", "proofNeedItemId");
CREATE INDEX "proof_integrity_evaluations_workspaceId_projectId_outcome_e_idx"
  ON "proof_integrity_evaluations"(
    "workspaceId",
    "projectId",
    "outcome",
    "evaluatedAt" DESC
  );
CREATE INDEX "proof_integrity_evaluations_workspaceId_runId_sequence_idx"
  ON "proof_integrity_evaluations"(
    "workspaceId",
    "runId",
    "sequence"
  );
CREATE INDEX "proof_integrity_evaluations_workspaceId_proofNeedRunId_proo_idx"
  ON "proof_integrity_evaluations"(
    "workspaceId",
    "proofNeedRunId",
    "proofNeedItemId"
  );
CREATE INDEX "proof_integrity_evaluations_workspaceId_selectedEvidenceId_idx"
  ON "proof_integrity_evaluations"(
    "workspaceId",
    "selectedEvidenceId"
  );
CREATE INDEX "proof_integrity_evaluations_workspaceId_allowedForAssembly__idx"
  ON "proof_integrity_evaluations"(
    "workspaceId",
    "allowedForAssembly",
    "outcome"
  );

ALTER TABLE "proof_integrity_runs"
  ADD CONSTRAINT "proof_integrity_runs_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "proof_integrity_runs"
  ADD CONSTRAINT "proof_integrity_runs_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "proof_integrity_runs"
  ADD CONSTRAINT "proof_integrity_runs_batchId_workspaceId_fkey"
  FOREIGN KEY ("batchId", "workspaceId")
  REFERENCES "production_batches"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "proof_integrity_runs"
  ADD CONSTRAINT "proof_integrity_runs_targetRecipeId_workspaceId_fkey"
  FOREIGN KEY ("targetRecipeId", "workspaceId")
  REFERENCES "variant_recipe_runs"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "proof_integrity_runs"
  ADD CONSTRAINT "proof_integrity_runs_proofNeedRunId_workspaceId_projectId_fkey"
  FOREIGN KEY ("proofNeedRunId", "workspaceId", "projectId")
  REFERENCES "proof_need_runs"("id", "workspaceId", "projectId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "proof_integrity_runs"
  ADD CONSTRAINT "proof_integrity_runs_createdByClientId_workspaceId_fkey"
  FOREIGN KEY ("createdByClientId", "workspaceId")
  REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "proof_integrity_evaluations"
  ADD CONSTRAINT "proof_integrity_evaluations_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "proof_integrity_evaluations"
  ADD CONSTRAINT "proof_integrity_evaluations_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "proof_integrity_evaluations"
  ADD CONSTRAINT "proof_integrity_evaluations_runId_workspaceId_projectId_fkey"
  FOREIGN KEY ("runId", "workspaceId", "projectId")
  REFERENCES "proof_integrity_runs"("id", "workspaceId", "projectId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "proof_integrity_evaluations"
  ADD CONSTRAINT "proof_integrity_evaluations_proofNeedItemId_workspaceId_pr_fkey"
  FOREIGN KEY ("proofNeedItemId", "workspaceId", "proofNeedRunId")
  REFERENCES "proof_need_items"("id", "workspaceId", "runId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "proof_integrity_evaluations"
  ADD CONSTRAINT "proof_integrity_evaluations_selectedEvidenceId_workspaceId_fkey"
  FOREIGN KEY ("selectedEvidenceId", "workspaceId")
  REFERENCES "evidence_segments"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
