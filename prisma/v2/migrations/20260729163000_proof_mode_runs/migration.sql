CREATE UNIQUE INDEX "proof_integrity_evaluations_id_workspaceId_runId_key"
  ON "proof_integrity_evaluations"("id", "workspaceId", "runId");

CREATE TABLE "proof_mode_runs" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "batchId" VARCHAR(128) NOT NULL,
  "proofIntegrityRunId" VARCHAR(128) NOT NULL,
  "proofIntegrityRunHash" CHAR(64) NOT NULL,
  "proofNeedRunId" VARCHAR(128) NOT NULL,
  "proofNeedRunHash" CHAR(64) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "policyVersion" VARCHAR(64) NOT NULL,
  "formatsText" TEXT NOT NULL,
  "formatCount" INTEGER NOT NULL,
  "rhythm" VARCHAR(16) NOT NULL,
  "approvedEvidenceCount" INTEGER NOT NULL,
  "planCount" INTEGER NOT NULL,
  "automaticCount" INTEGER NOT NULL,
  "manualOverrideCount" INTEGER NOT NULL,
  "cutawayCount" INTEGER NOT NULL,
  "splitScreenCount" INTEGER NOT NULL,
  "proofCardCount" INTEGER NOT NULL,
  "allIntegrityBindingsPreserved" BOOLEAN NOT NULL,
  "readyForCompilation" BOOLEAN NOT NULL,
  "runJson" TEXT NOT NULL,
  "runHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "proof_mode_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "proof_mode_runs_version_check" CHECK (
    "schemaVersion" = 'proof-mode-run/v1'
    AND "policyVersion" = 'proof-mode-policy/v1'
  ),
  CONSTRAINT "proof_mode_runs_counts_check" CHECK (
    "formatCount" BETWEEN 1 AND 5
    AND "approvedEvidenceCount" BETWEEN 1 AND 16
    AND "planCount" =
      "formatCount" * "approvedEvidenceCount"
    AND "planCount" BETWEEN 1 AND 80
    AND "automaticCount" BETWEEN 0 AND "planCount"
    AND "manualOverrideCount" BETWEEN 0 AND "planCount"
    AND "automaticCount" + "manualOverrideCount" = "planCount"
    AND "cutawayCount" BETWEEN 0 AND "planCount"
    AND "splitScreenCount" BETWEEN 0 AND "planCount"
    AND "proofCardCount" BETWEEN 0 AND "planCount"
    AND (
      "cutawayCount" + "splitScreenCount" + "proofCardCount"
    ) = "planCount"
    AND "allIntegrityBindingsPreserved"
    AND "readyForCompilation"
  ),
  CONSTRAINT "proof_mode_runs_values_check" CHECK (
    "rhythm" IN ('fast', 'measured')
    AND length("formatsText") BETWEEN 5 AND 64
    AND length("runJson") BETWEEN 2 AND 10000000
    AND length("idempotencyKey") BETWEEN 8 AND 128
  ),
  CONSTRAINT "proof_mode_runs_hash_check" CHECK (
    "proofIntegrityRunHash" ~ '^[a-f0-9]{64}$'
    AND "proofNeedRunHash" ~ '^[a-f0-9]{64}$'
    AND "runHash" ~ '^[a-f0-9]{64}$'
    AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
  )
);

CREATE UNIQUE INDEX "proof_mode_runs_id_workspaceId_key"
  ON "proof_mode_runs"("id", "workspaceId");
CREATE UNIQUE INDEX "proof_mode_runs_id_workspaceId_projectId_key"
  ON "proof_mode_runs"("id", "workspaceId", "projectId");
CREATE UNIQUE INDEX "proof_mode_runs_workspaceId_projectId_createdByClientId_ide_key"
  ON "proof_mode_runs"(
    "workspaceId",
    "projectId",
    "createdByClientId",
    "idempotencyKey"
  );
CREATE INDEX "proof_mode_runs_workspaceId_projectId_createdAt_id_idx"
  ON "proof_mode_runs"(
    "workspaceId",
    "projectId",
    "createdAt" DESC,
    "id" DESC
  );
CREATE INDEX "proof_mode_runs_workspaceId_proofIntegrityRunId_createdAt_idx"
  ON "proof_mode_runs"(
    "workspaceId",
    "proofIntegrityRunId",
    "createdAt" DESC
  );
CREATE INDEX "proof_mode_runs_workspaceId_proofNeedRunId_createdAt_idx"
  ON "proof_mode_runs"(
    "workspaceId",
    "proofNeedRunId",
    "createdAt" DESC
  );
CREATE INDEX "proof_mode_runs_workspaceId_readyForCompilation_createdAt_idx"
  ON "proof_mode_runs"(
    "workspaceId",
    "readyForCompilation",
    "createdAt" DESC
  );

CREATE TABLE "proof_mode_plans" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "runId" VARCHAR(128) NOT NULL,
  "proofIntegrityRunId" VARCHAR(128) NOT NULL,
  "proofIntegrityEvaluationId" VARCHAR(128) NOT NULL,
  "proofIntegrityEvaluationHash" CHAR(64) NOT NULL,
  "proofNeedRunId" VARCHAR(128) NOT NULL,
  "proofNeedItemId" VARCHAR(128) NOT NULL,
  "proofNeedItemHash" CHAR(64) NOT NULL,
  "claimText" VARCHAR(500) NOT NULL,
  "sourceEvidenceId" VARCHAR(128) NOT NULL,
  "sourceEvidenceHash" CHAR(64) NOT NULL,
  "sourceArtifactId" VARCHAR(128) NOT NULL,
  "sourceMediaType" VARCHAR(16) NOT NULL,
  "sequence" INTEGER NOT NULL,
  "format" VARCHAR(8) NOT NULL,
  "rhythm" VARCHAR(16) NOT NULL,
  "mode" VARCHAR(32) NOT NULL,
  "selection" VARCHAR(32) NOT NULL,
  "contextRequired" BOOLEAN NOT NULL,
  "identificationRequired" BOOLEAN NOT NULL,
  "reasonCodesText" TEXT NOT NULL,
  "reasonCount" INTEGER NOT NULL,
  "presentationJson" TEXT NOT NULL,
  "presentationHash" CHAR(64) NOT NULL,
  "timingJson" TEXT NOT NULL,
  "timingHash" CHAR(64) NOT NULL,
  "layoutJson" TEXT NOT NULL,
  "layoutHash" CHAR(64) NOT NULL,
  "planJson" TEXT NOT NULL,
  "planHash" CHAR(64) NOT NULL,

  CONSTRAINT "proof_mode_plans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "proof_mode_plans_values_check" CHECK (
    "sequence" BETWEEN 1 AND 80
    AND "format" IN ('9:16', '16:9', '4:5', '1:1', '21:9')
    AND "rhythm" IN ('fast', 'measured')
    AND "mode" IN ('cutaway', 'split-screen', 'proof-card')
    AND "selection" IN ('automatic', 'manual-override')
    AND "sourceMediaType" IN (
      'video',
      'image',
      'audio',
      'document'
    )
    AND "identificationRequired"
    AND length("claimText") BETWEEN 2 AND 500
    AND "reasonCount" BETWEEN 1 AND 8
  ),
  CONSTRAINT "proof_mode_plans_compatibility_check" CHECK (
    (
      "mode" = 'proof-card'
      OR "sourceMediaType" IN ('video', 'image')
    )
    AND NOT ("contextRequired" AND "mode" = 'proof-card')
  ),
  CONSTRAINT "proof_mode_plans_content_check" CHECK (
    length("reasonCodesText") BETWEEN 3 AND 1000
    AND length("presentationJson") BETWEEN 2 AND 1000000
    AND length("timingJson") BETWEEN 2 AND 100000
    AND length("layoutJson") BETWEEN 2 AND 100000
    AND length("planJson") BETWEEN 2 AND 2000000
  ),
  CONSTRAINT "proof_mode_plans_hash_check" CHECK (
    "proofIntegrityEvaluationHash" ~ '^[a-f0-9]{64}$'
    AND "proofNeedItemHash" ~ '^[a-f0-9]{64}$'
    AND "sourceEvidenceHash" ~ '^[a-f0-9]{64}$'
    AND "presentationHash" ~ '^[a-f0-9]{64}$'
    AND "timingHash" ~ '^[a-f0-9]{64}$'
    AND "layoutHash" ~ '^[a-f0-9]{64}$'
    AND "planHash" ~ '^[a-f0-9]{64}$'
  )
);

CREATE UNIQUE INDEX "proof_mode_plans_id_workspaceId_key"
  ON "proof_mode_plans"("id", "workspaceId");
CREATE UNIQUE INDEX "proof_mode_plans_runId_sequence_key"
  ON "proof_mode_plans"("runId", "sequence");
CREATE UNIQUE INDEX "proof_mode_plans_runId_proofNeedItemId_format_key"
  ON "proof_mode_plans"(
    "runId",
    "proofNeedItemId",
    "format"
  );
CREATE INDEX "proof_mode_plans_workspaceId_projectId_mode_format_idx"
  ON "proof_mode_plans"(
    "workspaceId",
    "projectId",
    "mode",
    "format"
  );
CREATE INDEX "proof_mode_plans_workspaceId_proofIntegrityRunId_proofInteg_idx"
  ON "proof_mode_plans"(
    "workspaceId",
    "proofIntegrityRunId",
    "proofIntegrityEvaluationId"
  );
CREATE INDEX "proof_mode_plans_workspaceId_proofNeedRunId_proofNeedItemId_idx"
  ON "proof_mode_plans"(
    "workspaceId",
    "proofNeedRunId",
    "proofNeedItemId"
  );
CREATE INDEX "proof_mode_plans_workspaceId_sourceEvidenceId_idx"
  ON "proof_mode_plans"("workspaceId", "sourceEvidenceId");
CREATE INDEX "proof_mode_plans_workspaceId_sourceArtifactId_idx"
  ON "proof_mode_plans"("workspaceId", "sourceArtifactId");
CREATE INDEX "proof_mode_plans_workspaceId_selection_format_idx"
  ON "proof_mode_plans"(
    "workspaceId",
    "selection",
    "format"
  );

ALTER TABLE "proof_mode_runs"
  ADD CONSTRAINT "proof_mode_runs_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "proof_mode_runs"
  ADD CONSTRAINT "proof_mode_runs_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "proof_mode_runs"
  ADD CONSTRAINT "proof_mode_runs_batchId_workspaceId_fkey"
  FOREIGN KEY ("batchId", "workspaceId")
  REFERENCES "production_batches"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "proof_mode_runs"
  ADD CONSTRAINT "proof_mode_runs_proofIntegrityRunId_workspaceId_projectId_fkey"
  FOREIGN KEY ("proofIntegrityRunId", "workspaceId", "projectId")
  REFERENCES "proof_integrity_runs"("id", "workspaceId", "projectId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "proof_mode_runs"
  ADD CONSTRAINT "proof_mode_runs_proofNeedRunId_workspaceId_projectId_fkey"
  FOREIGN KEY ("proofNeedRunId", "workspaceId", "projectId")
  REFERENCES "proof_need_runs"("id", "workspaceId", "projectId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "proof_mode_runs"
  ADD CONSTRAINT "proof_mode_runs_createdByClientId_workspaceId_fkey"
  FOREIGN KEY ("createdByClientId", "workspaceId")
  REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "proof_mode_plans"
  ADD CONSTRAINT "proof_mode_plans_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "proof_mode_plans"
  ADD CONSTRAINT "proof_mode_plans_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "proof_mode_plans"
  ADD CONSTRAINT "proof_mode_plans_runId_workspaceId_projectId_fkey"
  FOREIGN KEY ("runId", "workspaceId", "projectId")
  REFERENCES "proof_mode_runs"("id", "workspaceId", "projectId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "proof_mode_plans"
  ADD CONSTRAINT "proof_mode_plans_proofIntegrityEvaluationId_workspaceId_pr_fkey"
  FOREIGN KEY (
    "proofIntegrityEvaluationId",
    "workspaceId",
    "proofIntegrityRunId"
  )
  REFERENCES "proof_integrity_evaluations"(
    "id",
    "workspaceId",
    "runId"
  )
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "proof_mode_plans"
  ADD CONSTRAINT "proof_mode_plans_proofNeedItemId_workspaceId_proofNeedRunI_fkey"
  FOREIGN KEY (
    "proofNeedItemId",
    "workspaceId",
    "proofNeedRunId"
  )
  REFERENCES "proof_need_items"("id", "workspaceId", "runId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "proof_mode_plans"
  ADD CONSTRAINT "proof_mode_plans_sourceEvidenceId_workspaceId_fkey"
  FOREIGN KEY ("sourceEvidenceId", "workspaceId")
  REFERENCES "evidence_segments"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "proof_mode_plans"
  ADD CONSTRAINT "proof_mode_plans_sourceArtifactId_workspaceId_fkey"
  FOREIGN KEY ("sourceArtifactId", "workspaceId")
  REFERENCES "media_artifacts"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
