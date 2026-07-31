CREATE TABLE "retrieval_scale_evaluations" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "policyVersion" VARCHAR(64) NOT NULL,
  "rerankPolicyVersion" VARCHAR(64) NOT NULL,
  "scope" VARCHAR(16) NOT NULL,
  "librarySize" INTEGER NOT NULL,
  "k" INTEGER NOT NULL,
  "caseCount" INTEGER NOT NULL,
  "casesJson" TEXT NOT NULL,
  "aggregateQualityJson" TEXT NOT NULL,
  "aggregateLatencyJson" TEXT NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "reportHash" CHAR(64) NOT NULL,

  CONSTRAINT "retrieval_scale_evaluations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "retrieval_scale_evaluations_policy_check"
    CHECK (
      "policyVersion" = 'retrieval-scale-eval/v1' AND
      "rerankPolicyVersion" = 'hybrid-rerank/v1'
    ),
  CONSTRAINT "retrieval_scale_evaluations_scope_check"
    CHECK ("scope" IN ('project', 'workspace')),
  CONSTRAINT "retrieval_scale_evaluations_counts_check"
    CHECK (
      "librarySize" >= 1 AND
      "k" BETWEEN 1 AND 100 AND
      "caseCount" BETWEEN 3 AND 50
    ),
  CONSTRAINT "retrieval_scale_evaluations_hashes_check"
    CHECK (
      "requestFingerprint" ~ '^[a-f0-9]{64}$' AND
      "reportHash" ~ '^[a-f0-9]{64}$'
    )
);

CREATE UNIQUE INDEX "retrieval_scale_evaluations_id_workspaceId_key"
  ON "retrieval_scale_evaluations"("id", "workspaceId");
CREATE UNIQUE INDEX "retrieval_scale_evaluations_workspaceId_projectId_idempoten_key"
  ON "retrieval_scale_evaluations"("workspaceId", "projectId", "idempotencyKey");
CREATE UNIQUE INDEX "retrieval_scale_evaluations_workspaceId_reportHash_key"
  ON "retrieval_scale_evaluations"("workspaceId", "reportHash");
CREATE INDEX "retrieval_scale_evaluations_workspaceId_projectId_scope_lib_idx"
  ON "retrieval_scale_evaluations"("workspaceId", "projectId", "scope", "librarySize", "createdAt" DESC);
CREATE INDEX "retrieval_scale_evaluations_workspaceId_policyVersion_reran_idx"
  ON "retrieval_scale_evaluations"("workspaceId", "policyVersion", "rerankPolicyVersion");

ALTER TABLE "retrieval_scale_evaluations"
  ADD CONSTRAINT "retrieval_scale_evaluations_workspaceId_fkey"
  FOREIGN KEY ("workspaceId")
  REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "retrieval_scale_evaluations"
  ADD CONSTRAINT "retrieval_scale_evaluations_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "retrieval_scale_evaluations"
  ADD CONSTRAINT "retrieval_scale_evaluations_createdByClientId_workspaceId_fkey"
  FOREIGN KEY ("createdByClientId", "workspaceId")
  REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
