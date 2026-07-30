CREATE TABLE "contiguous_evidence_runs" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "sourceIndexRunId" VARCHAR(128) NOT NULL,
  "sourceIndexRunHash" CHAR(64) NOT NULL,
  "analyzerKind" VARCHAR(32) NOT NULL,
  "analyzerProvider" VARCHAR(128) NOT NULL,
  "analyzerModel" VARCHAR(128) NOT NULL,
  "analyzerVersion" VARCHAR(128) NOT NULL,
  "evidenceCount" INTEGER NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "runJson" TEXT NOT NULL,
  "runHash" CHAR(64) NOT NULL,

  CONSTRAINT "contiguous_evidence_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "contiguous_evidence_runs_kind_check"
    CHECK (
      "analyzerKind" IN (
        'transcript-boundary',
        'transcript-density',
        'rights-integrity',
        'audio-analysis',
        'visual-analysis'
      )
    ),
  CONSTRAINT "contiguous_evidence_runs_count_check"
    CHECK ("evidenceCount" > 0 AND "evidenceCount" <= 10000),
  CONSTRAINT "contiguous_evidence_runs_hashes_check"
    CHECK (
      "sourceIndexRunHash" ~ '^[a-f0-9]{64}$' AND
      "requestFingerprint" ~ '^[a-f0-9]{64}$' AND
      "runHash" ~ '^[a-f0-9]{64}$'
    )
);

ALTER TABLE "contiguous_evaluation_evidence"
  ADD COLUMN "runId" VARCHAR(128) NOT NULL;

CREATE INDEX "contiguous_evidence_runs_workspaceId_projectId_createdAt_idx"
  ON "contiguous_evidence_runs"("workspaceId", "projectId", "createdAt" DESC);
CREATE INDEX "contiguous_evidence_runs_workspaceId_sourceIndexRunId_analy_idx"
  ON "contiguous_evidence_runs"(
    "workspaceId",
    "sourceIndexRunId",
    "analyzerKind",
    "createdAt" DESC
  );
CREATE UNIQUE INDEX "contiguous_evidence_runs_id_workspaceId_key"
  ON "contiguous_evidence_runs"("id", "workspaceId");
CREATE UNIQUE INDEX "contiguous_evidence_runs_workspaceId_projectId_sourceIndexR_key"
  ON "contiguous_evidence_runs"(
    "workspaceId",
    "projectId",
    "sourceIndexRunId",
    "createdByClientId",
    "idempotencyKey"
  );
CREATE UNIQUE INDEX "contiguous_evidence_runs_workspaceId_runHash_key"
  ON "contiguous_evidence_runs"("workspaceId", "runHash");
CREATE INDEX "contiguous_evaluation_evidence_workspaceId_runId_idx"
  ON "contiguous_evaluation_evidence"("workspaceId", "runId");

ALTER TABLE "contiguous_evidence_runs"
  ADD CONSTRAINT "contiguous_evidence_runs_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "contiguous_evidence_runs_projectId_workspaceId_fkey"
    FOREIGN KEY ("projectId", "workspaceId")
    REFERENCES "projects"("id", "workspaceId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "contiguous_evidence_runs_sourceIndexRunId_workspaceId_fkey"
    FOREIGN KEY ("sourceIndexRunId", "workspaceId")
    REFERENCES "long_form_index_runs"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "contiguous_evidence_runs_createdByClientId_workspaceId_fkey"
    FOREIGN KEY ("createdByClientId", "workspaceId")
    REFERENCES "api_clients"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "contiguous_evaluation_evidence"
  ADD CONSTRAINT "contiguous_evaluation_evidence_runId_workspaceId_fkey"
    FOREIGN KEY ("runId", "workspaceId")
    REFERENCES "contiguous_evidence_runs"("id", "workspaceId")
    ON DELETE CASCADE ON UPDATE CASCADE;
