CREATE TABLE "semantic_reuse_runs" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "queryHash" CHAR(64) NOT NULL,
  "resultSetHash" CHAR(64) NOT NULL,
  "queryJson" TEXT NOT NULL,
  "semanticJson" TEXT NOT NULL,
  "rerankPolicyVersion" VARCHAR(64) NOT NULL,
  "candidateAuditJson" TEXT NOT NULL,
  "returnedIdentityKeysJson" TEXT NOT NULL,
  "reusedIdentityKeysJson" TEXT NOT NULL,
  "directorRejectionsJson" TEXT NOT NULL,
  "candidateCount" INTEGER NOT NULL,
  "returnedCount" INTEGER NOT NULL,
  "reusedCount" INTEGER NOT NULL,
  "searchEvaluatedAt" TIMESTAMPTZ(3) NOT NULL,
  "searchLatencyMs" INTEGER NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "runHash" CHAR(64) NOT NULL,

  CONSTRAINT "semantic_reuse_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "semantic_reuse_runs_policy_check"
    CHECK ("rerankPolicyVersion" = 'hybrid-rerank/v1'),
  CONSTRAINT "semantic_reuse_runs_counts_check"
    CHECK (
      "candidateCount" >= "returnedCount" AND
      "returnedCount" >= "reusedCount" AND
      "reusedCount" >= 0 AND
      "candidateCount" <= 500
    ),
  CONSTRAINT "semantic_reuse_runs_latency_check"
    CHECK ("searchLatencyMs" >= 0 AND "searchLatencyMs" <= 3600000),
  CONSTRAINT "semantic_reuse_runs_hashes_check"
    CHECK (
      "queryHash" ~ '^[a-f0-9]{64}$' AND
      "resultSetHash" ~ '^[a-f0-9]{64}$' AND
      "requestFingerprint" ~ '^[a-f0-9]{64}$' AND
      "runHash" ~ '^[a-f0-9]{64}$'
    )
);

CREATE UNIQUE INDEX "semantic_reuse_runs_id_workspaceId_key"
  ON "semantic_reuse_runs"("id", "workspaceId");
CREATE UNIQUE INDEX "semantic_reuse_runs_workspaceId_projectId_idempotencyKey_key"
  ON "semantic_reuse_runs"(
    "workspaceId",
    "projectId",
    "idempotencyKey"
  );
CREATE UNIQUE INDEX "semantic_reuse_runs_workspaceId_runHash_key"
  ON "semantic_reuse_runs"("workspaceId", "runHash");
CREATE INDEX "semantic_reuse_runs_workspaceId_projectId_createdAt_idx"
  ON "semantic_reuse_runs"(
    "workspaceId",
    "projectId",
    "createdAt" DESC
  );
CREATE INDEX "semantic_reuse_runs_workspaceId_queryHash_createdAt_idx"
  ON "semantic_reuse_runs"(
    "workspaceId",
    "queryHash",
    "createdAt" DESC
  );
CREATE INDEX "semantic_reuse_runs_workspaceId_createdByClientId_createdAt_idx"
  ON "semantic_reuse_runs"(
    "workspaceId",
    "createdByClientId",
    "createdAt" DESC
  );

ALTER TABLE "semantic_reuse_runs"
  ADD CONSTRAINT "semantic_reuse_runs_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "semantic_reuse_runs_projectId_workspaceId_fkey"
    FOREIGN KEY ("projectId", "workspaceId")
    REFERENCES "projects"("id", "workspaceId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "semantic_reuse_runs_createdByClientId_workspaceId_fkey"
    FOREIGN KEY ("createdByClientId", "workspaceId")
    REFERENCES "api_clients"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE;
