CREATE TABLE "contiguous_evaluation_runs" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "sourceIndexRunId" VARCHAR(128) NOT NULL,
  "sourceIndexRunHash" CHAR(64) NOT NULL,
  "policyVersion" VARCHAR(64) NOT NULL,
  "producerProvider" VARCHAR(128) NOT NULL,
  "producerModel" VARCHAR(128) NOT NULL,
  "producerVersion" VARCHAR(128) NOT NULL,
  "producerInputHash" CHAR(64) NOT NULL,
  "producerOutputHash" CHAR(64) NOT NULL,
  "decisionsJson" TEXT NOT NULL,
  "evaluationCount" INTEGER NOT NULL,
  "rejectedCount" INTEGER NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "runJson" TEXT NOT NULL,
  "runHash" CHAR(64) NOT NULL,

  CONSTRAINT "contiguous_evaluation_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "contiguous_evaluation_runs_policy_check"
    CHECK ("policyVersion" = 'contiguous-extraction/v1'),
  CONSTRAINT "contiguous_evaluation_runs_counts_check"
    CHECK (
      "evaluationCount" > 0 AND
      "rejectedCount" >= 0 AND
      "evaluationCount" + "rejectedCount" <= 10000
    ),
  CONSTRAINT "contiguous_evaluation_runs_hashes_check"
    CHECK (
      "sourceIndexRunHash" ~ '^[a-f0-9]{64}$' AND
      "producerInputHash" ~ '^[a-f0-9]{64}$' AND
      "producerOutputHash" ~ '^[a-f0-9]{64}$' AND
      "requestFingerprint" ~ '^[a-f0-9]{64}$' AND
      "runHash" ~ '^[a-f0-9]{64}$'
    )
);

CREATE TABLE "contiguous_evaluation_evidence" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "indexRunId" VARCHAR(128) NOT NULL,
  "momentId" VARCHAR(128) NOT NULL,
  "kind" VARCHAR(32) NOT NULL,
  "dimensionsJson" TEXT NOT NULL,
  "startMs" INTEGER NOT NULL,
  "endMs" INTEGER NOT NULL,
  "producerProvider" VARCHAR(128) NOT NULL,
  "producerModel" VARCHAR(128) NOT NULL,
  "producerVersion" VARCHAR(128) NOT NULL,
  "producerInputHash" CHAR(64) NOT NULL,
  "producerOutputHash" CHAR(64) NOT NULL,
  "factsJson" TEXT NOT NULL,
  "evidenceHash" CHAR(64) NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "contiguous_evaluation_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "contiguous_evaluation_evidence_kind_check"
    CHECK (
      "kind" IN (
        'transcript-boundary',
        'transcript-density',
        'rights-integrity',
        'audio-analysis',
        'visual-analysis'
      )
    ),
  CONSTRAINT "contiguous_evaluation_evidence_range_check"
    CHECK ("startMs" >= 0 AND "endMs" > "startMs"),
  CONSTRAINT "contiguous_evaluation_evidence_hashes_check"
    CHECK (
      "producerInputHash" ~ '^[a-f0-9]{64}$' AND
      "producerOutputHash" ~ '^[a-f0-9]{64}$' AND
      "evidenceHash" ~ '^[a-f0-9]{64}$'
    )
);

ALTER TABLE "contiguous_moment_evaluations"
  ADD COLUMN "runId" VARCHAR(128) NOT NULL;

CREATE INDEX "contiguous_evaluation_runs_workspaceId_projectId_createdAt_idx"
  ON "contiguous_evaluation_runs"("workspaceId", "projectId", "createdAt" DESC);
CREATE INDEX "contiguous_evaluation_runs_workspaceId_sourceIndexRunId_cre_idx"
  ON "contiguous_evaluation_runs"("workspaceId", "sourceIndexRunId", "createdAt" DESC);
CREATE INDEX "contiguous_evaluation_runs_workspaceId_producerProvider_pro_idx"
  ON "contiguous_evaluation_runs"(
    "workspaceId",
    "producerProvider",
    "producerModel",
    "producerVersion",
    "createdAt" DESC
  );
CREATE UNIQUE INDEX "contiguous_evaluation_runs_id_workspaceId_key"
  ON "contiguous_evaluation_runs"("id", "workspaceId");
CREATE UNIQUE INDEX "contiguous_evaluation_runs_workspaceId_projectId_sourceInde_key"
  ON "contiguous_evaluation_runs"(
    "workspaceId",
    "projectId",
    "sourceIndexRunId",
    "createdByClientId",
    "idempotencyKey"
  );
CREATE UNIQUE INDEX "contiguous_evaluation_runs_workspaceId_runHash_key"
  ON "contiguous_evaluation_runs"("workspaceId", "runHash");

CREATE INDEX "contiguous_evaluation_evidence_workspaceId_projectId_active_idx"
  ON "contiguous_evaluation_evidence"(
    "workspaceId",
    "projectId",
    "active",
    "createdAt" DESC
  );
CREATE INDEX "contiguous_evaluation_evidence_workspaceId_indexRunId_activ_idx"
  ON "contiguous_evaluation_evidence"("workspaceId", "indexRunId", "active");
CREATE INDEX "contiguous_evaluation_evidence_workspaceId_momentId_active_idx"
  ON "contiguous_evaluation_evidence"("workspaceId", "momentId", "active");
CREATE INDEX "contiguous_evaluation_evidence_workspaceId_kind_active_idx"
  ON "contiguous_evaluation_evidence"("workspaceId", "kind", "active");
CREATE UNIQUE INDEX "contiguous_evaluation_evidence_id_workspaceId_key"
  ON "contiguous_evaluation_evidence"("id", "workspaceId");
CREATE UNIQUE INDEX "contiguous_evaluation_evidence_workspaceId_momentId_evidenc_key"
  ON "contiguous_evaluation_evidence"("workspaceId", "momentId", "evidenceHash");

CREATE INDEX "contiguous_moment_evaluations_workspaceId_runId_idx"
  ON "contiguous_moment_evaluations"("workspaceId", "runId");

ALTER TABLE "contiguous_evaluation_runs"
  ADD CONSTRAINT "contiguous_evaluation_runs_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "contiguous_evaluation_runs_projectId_workspaceId_fkey"
    FOREIGN KEY ("projectId", "workspaceId")
    REFERENCES "projects"("id", "workspaceId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "contiguous_evaluation_runs_sourceIndexRunId_workspaceId_fkey"
    FOREIGN KEY ("sourceIndexRunId", "workspaceId")
    REFERENCES "long_form_index_runs"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "contiguous_evaluation_runs_createdByClientId_workspaceId_fkey"
    FOREIGN KEY ("createdByClientId", "workspaceId")
    REFERENCES "api_clients"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "contiguous_evaluation_evidence"
  ADD CONSTRAINT "contiguous_evaluation_evidence_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "contiguous_evaluation_evidence_projectId_workspaceId_fkey"
    FOREIGN KEY ("projectId", "workspaceId")
    REFERENCES "projects"("id", "workspaceId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "contiguous_evaluation_evidence_indexRunId_workspaceId_fkey"
    FOREIGN KEY ("indexRunId", "workspaceId")
    REFERENCES "long_form_index_runs"("id", "workspaceId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "contiguous_evaluation_evidence_momentId_workspaceId_fkey"
    FOREIGN KEY ("momentId", "workspaceId")
    REFERENCES "long_form_moments"("id", "workspaceId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "contiguous_moment_evaluations"
  ADD CONSTRAINT "contiguous_moment_evaluations_runId_workspaceId_fkey"
    FOREIGN KEY ("runId", "workspaceId")
    REFERENCES "contiguous_evaluation_runs"("id", "workspaceId")
    ON DELETE CASCADE ON UPDATE CASCADE;
