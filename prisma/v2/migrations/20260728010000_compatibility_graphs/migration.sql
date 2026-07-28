CREATE TABLE "compatibility_graph_runs" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "batchId" VARCHAR(128) NOT NULL,
  "takeLibraryId" VARCHAR(128) NOT NULL,
  "takeLibraryRunHash" CHAR(64) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "ruleVersion" VARCHAR(64) NOT NULL,
  "softScoreVersion" VARCHAR(64) NOT NULL,
  "acceptThreshold" DECIMAL(6,3) NOT NULL,
  "reviewThreshold" DECIMAL(6,3) NOT NULL,
  "resultJson" TEXT NOT NULL,
  "nodeCount" INTEGER NOT NULL,
  "edgeCount" INTEGER NOT NULL,
  "acceptedCount" INTEGER NOT NULL,
  "borderlineCount" INTEGER NOT NULL,
  "blockedCount" INTEGER NOT NULL,
  "hardFailureCount" INTEGER NOT NULL,
  "averageSoftScore" DECIMAL(6,3) NOT NULL,
  "runHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "compatibility_graph_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "compatibility_graph_runs_versions_check" CHECK (
    "schemaVersion" = 'compatibility-graph/v1'
    AND "ruleVersion" = 'compatibility-rules/v1'
    AND "softScoreVersion" = 'compatibility-soft-score/v1'
  ),
  CONSTRAINT "compatibility_graph_runs_thresholds_check" CHECK (
    "reviewThreshold" BETWEEN 0 AND 100
    AND "acceptThreshold" BETWEEN 0 AND 100
    AND "reviewThreshold" < "acceptThreshold"
  ),
  CONSTRAINT "compatibility_graph_runs_counts_check" CHECK (
    "nodeCount" BETWEEN 2 AND 2000
    AND "edgeCount" BETWEEN 1 AND 4000000
    AND "acceptedCount" BETWEEN 0 AND "edgeCount"
    AND "borderlineCount" BETWEEN 0 AND "edgeCount"
    AND "blockedCount" BETWEEN 0 AND "edgeCount"
    AND (
      "acceptedCount" +
      "borderlineCount" +
      "blockedCount"
    ) = "edgeCount"
    AND "hardFailureCount" BETWEEN 0 AND "edgeCount" * 7
    AND "averageSoftScore" BETWEEN 0 AND 100
  ),
  CONSTRAINT "compatibility_graph_runs_hashes_check" CHECK (
    "takeLibraryRunHash" ~ '^[a-f0-9]{64}$'
    AND "runHash" ~ '^[a-f0-9]{64}$'
    AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "compatibility_graph_runs_json_check" CHECK (
    length("resultJson") BETWEEN 2 AND 100000000
  )
);

CREATE UNIQUE INDEX "compatibility_graph_runs_id_workspaceId_key"
  ON "compatibility_graph_runs"("id", "workspaceId");
CREATE UNIQUE INDEX "compatibility_graph_runs_workspaceId_createdByClientId_idem_key"
  ON "compatibility_graph_runs"(
    "workspaceId",
    "createdByClientId",
    "idempotencyKey"
  );
CREATE INDEX "compatibility_graph_runs_workspaceId_batchId_createdAt_id_idx"
  ON "compatibility_graph_runs"(
    "workspaceId",
    "batchId",
    "createdAt" DESC,
    "id" DESC
  );
CREATE INDEX "compatibility_graph_runs_workspaceId_projectId_createdAt_idx"
  ON "compatibility_graph_runs"(
    "workspaceId",
    "projectId",
    "createdAt" DESC
  );
CREATE INDEX "compatibility_graph_runs_workspaceId_takeLibraryId_createdA_idx"
  ON "compatibility_graph_runs"(
    "workspaceId",
    "takeLibraryId",
    "createdAt" DESC
  );
CREATE INDEX "compatibility_graph_runs_workspaceId_blockedCount_borderlin_idx"
  ON "compatibility_graph_runs"(
    "workspaceId",
    "blockedCount",
    "borderlineCount",
    "createdAt" DESC
  );

CREATE TABLE "compatibility_graph_nodes" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "graphId" VARCHAR(128) NOT NULL,
  "takeId" VARCHAR(128) NOT NULL,
  "groupId" VARCHAR(128) NOT NULL,
  "scriptBlockId" VARCHAR(128),
  "role" VARCHAR(16) NOT NULL,
  "sourceArtifactId" VARCHAR(128) NOT NULL,
  "sourceHash" CHAR(64) NOT NULL,
  "contextHash" CHAR(64) NOT NULL,
  "nodeJson" TEXT NOT NULL,
  "nodeHash" CHAR(64) NOT NULL,

  CONSTRAINT "compatibility_graph_nodes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "compatibility_graph_nodes_role_check" CHECK (
    "role" IN ('hook', 'body', 'proof', 'cta')
  ),
  CONSTRAINT "compatibility_graph_nodes_hashes_check" CHECK (
    "sourceHash" ~ '^[a-f0-9]{64}$'
    AND "contextHash" ~ '^[a-f0-9]{64}$'
    AND "nodeHash" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "compatibility_graph_nodes_json_check" CHECK (
    length("nodeJson") BETWEEN 2 AND 100000
  )
);

CREATE UNIQUE INDEX "compatibility_graph_nodes_id_workspaceId_key"
  ON "compatibility_graph_nodes"("id", "workspaceId");
CREATE UNIQUE INDEX "compatibility_graph_nodes_graphId_takeId_key"
  ON "compatibility_graph_nodes"("graphId", "takeId");
CREATE INDEX "compatibility_graph_nodes_workspaceId_graphId_role_id_idx"
  ON "compatibility_graph_nodes"(
    "workspaceId",
    "graphId",
    "role",
    "id"
  );
CREATE INDEX "compatibility_graph_nodes_workspaceId_takeId_graphId_idx"
  ON "compatibility_graph_nodes"(
    "workspaceId",
    "takeId",
    "graphId"
  );
CREATE INDEX "compatibility_graph_nodes_workspaceId_scriptBlockId_role_idx"
  ON "compatibility_graph_nodes"(
    "workspaceId",
    "scriptBlockId",
    "role"
  );

CREATE TABLE "compatibility_graph_edges" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "graphId" VARCHAR(128) NOT NULL,
  "fromNodeId" VARCHAR(128) NOT NULL,
  "toNodeId" VARCHAR(128) NOT NULL,
  "relation" VARCHAR(32) NOT NULL,
  "decision" VARCHAR(16) NOT NULL,
  "eligible" BOOLEAN NOT NULL,
  "softScore" DECIMAL(6,3) NOT NULL,
  "reasonCodesJson" TEXT NOT NULL,
  "evidenceJson" TEXT NOT NULL,
  "edgeJson" TEXT NOT NULL,
  "edgeHash" CHAR(64) NOT NULL,

  CONSTRAINT "compatibility_graph_edges_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "compatibility_graph_edges_relation_check" CHECK (
    "relation" IN (
      'hook-body',
      'body-proof',
      'body-cta',
      'proof-cta'
    )
  ),
  CONSTRAINT "compatibility_graph_edges_decision_check" CHECK (
    "decision" IN ('accepted', 'borderline', 'blocked')
    AND "eligible" = ("decision" = 'accepted')
  ),
  CONSTRAINT "compatibility_graph_edges_score_check" CHECK (
    "softScore" BETWEEN 0 AND 100
  ),
  CONSTRAINT "compatibility_graph_edges_hash_check" CHECK (
    "edgeHash" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "compatibility_graph_edges_json_check" CHECK (
    length("reasonCodesJson") BETWEEN 2 AND 10000
    AND length("evidenceJson") BETWEEN 2 AND 100000
    AND length("edgeJson") BETWEEN 2 AND 500000
  )
);

CREATE UNIQUE INDEX "compatibility_graph_edges_graphId_fromNodeId_toNodeId_relat_key"
  ON "compatibility_graph_edges"(
    "graphId",
    "fromNodeId",
    "toNodeId",
    "relation"
  );
CREATE INDEX "compatibility_graph_edges_workspaceId_graphId_decision_soft_idx"
  ON "compatibility_graph_edges"(
    "workspaceId",
    "graphId",
    "decision",
    "softScore" DESC
  );
CREATE INDEX "compatibility_graph_edges_workspaceId_fromNodeId_relation_d_idx"
  ON "compatibility_graph_edges"(
    "workspaceId",
    "fromNodeId",
    "relation",
    "decision"
  );
CREATE INDEX "compatibility_graph_edges_workspaceId_toNodeId_relation_dec_idx"
  ON "compatibility_graph_edges"(
    "workspaceId",
    "toNodeId",
    "relation",
    "decision"
  );

ALTER TABLE "compatibility_graph_runs"
  ADD CONSTRAINT "compatibility_graph_runs_workspaceId_fkey"
  FOREIGN KEY ("workspaceId")
  REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "compatibility_graph_runs"
  ADD CONSTRAINT "compatibility_graph_runs_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "compatibility_graph_runs"
  ADD CONSTRAINT "compatibility_graph_runs_batchId_workspaceId_fkey"
  FOREIGN KEY ("batchId", "workspaceId")
  REFERENCES "production_batches"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "compatibility_graph_runs"
  ADD CONSTRAINT "compatibility_graph_runs_takeLibraryId_workspaceId_fkey"
  FOREIGN KEY ("takeLibraryId", "workspaceId")
  REFERENCES "take_library_runs"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "compatibility_graph_runs"
  ADD CONSTRAINT "compatibility_graph_runs_createdByClientId_workspaceId_fkey"
  FOREIGN KEY ("createdByClientId", "workspaceId")
  REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "compatibility_graph_nodes"
  ADD CONSTRAINT "compatibility_graph_nodes_workspaceId_fkey"
  FOREIGN KEY ("workspaceId")
  REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "compatibility_graph_nodes"
  ADD CONSTRAINT "compatibility_graph_nodes_graphId_workspaceId_fkey"
  FOREIGN KEY ("graphId", "workspaceId")
  REFERENCES "compatibility_graph_runs"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "compatibility_graph_edges"
  ADD CONSTRAINT "compatibility_graph_edges_workspaceId_fkey"
  FOREIGN KEY ("workspaceId")
  REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "compatibility_graph_edges"
  ADD CONSTRAINT "compatibility_graph_edges_graphId_workspaceId_fkey"
  FOREIGN KEY ("graphId", "workspaceId")
  REFERENCES "compatibility_graph_runs"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "compatibility_graph_edges"
  ADD CONSTRAINT "compatibility_graph_edges_fromNodeId_workspaceId_fkey"
  FOREIGN KEY ("fromNodeId", "workspaceId")
  REFERENCES "compatibility_graph_nodes"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "compatibility_graph_edges"
  ADD CONSTRAINT "compatibility_graph_edges_toNodeId_workspaceId_fkey"
  FOREIGN KEY ("toNodeId", "workspaceId")
  REFERENCES "compatibility_graph_nodes"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
