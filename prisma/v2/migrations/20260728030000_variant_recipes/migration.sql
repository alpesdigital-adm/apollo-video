CREATE UNIQUE INDEX "compat_graph_runs_recipe_scope_key"
  ON "compatibility_graph_runs"(
    "id",
    "workspaceId",
    "projectId",
    "batchId",
    "takeLibraryId",
    "runHash"
  );

CREATE TABLE "variant_recipe_runs" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "batchId" VARCHAR(128) NOT NULL,
  "compatibilityGraphId" VARCHAR(128) NOT NULL,
  "compatibilityGraphRunHash" CHAR(64) NOT NULL,
  "takeLibraryId" VARCHAR(128) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "policyVersion" VARCHAR(64) NOT NULL,
  "scoreVersion" VARCHAR(64) NOT NULL,
  "compilerVersion" VARCHAR(64) NOT NULL,
  "objective" VARCHAR(128) NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "resultJson" TEXT NOT NULL,
  "selectedTakeCount" INTEGER NOT NULL,
  "sourceSegmentCount" INTEGER NOT NULL,
  "lineageCount" INTEGER NOT NULL,
  "compatibilityEdgeCount" INTEGER NOT NULL,
  "assumptionCount" INTEGER NOT NULL,
  "estimatedDurationMs" INTEGER NOT NULL,
  "estimatedDurationFrames" INTEGER NOT NULL,
  "includesProof" BOOLEAN NOT NULL,
  "hasColdOpen" BOOLEAN NOT NULL,
  "masterReferenceCount" INTEGER NOT NULL,
  "minimumEdgeScore" DECIMAL(6,3) NOT NULL,
  "averageEdgeScore" DECIMAL(6,3) NOT NULL,
  "objectiveScore" DECIMAL(6,3) NOT NULL,
  "totalScore" DECIMAL(6,3) NOT NULL,
  "proofPolicyHash" CHAR(64) NOT NULL,
  "scoresHash" CHAR(64) NOT NULL,
  "storyPlanHash" CHAR(64) NOT NULL,
  "editPlanHash" CHAR(64) NOT NULL,
  "runHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "variant_recipe_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "variant_recipe_runs_versions_check" CHECK (
    "schemaVersion" = 'variant-recipe/v1'
    AND "policyVersion" = 'variant-recipe-policy/v1'
    AND "scoreVersion" = 'variant-recipe-score/v1'
    AND "compilerVersion" = 'variant-recipe-compiler/v1'
  ),
  CONSTRAINT "variant_recipe_runs_status_check" CHECK (
    "status" IN ('candidate', 'selected', 'excluded')
  ),
  CONSTRAINT "variant_recipe_runs_counts_check" CHECK (
    "selectedTakeCount" BETWEEN 3 AND 4
    AND "sourceSegmentCount" BETWEEN 3 AND 5
    AND "lineageCount" = "sourceSegmentCount"
    AND "compatibilityEdgeCount" BETWEEN 2 AND 3
    AND "assumptionCount" BETWEEN 0 AND 25
    AND "estimatedDurationMs" > 0
    AND "estimatedDurationFrames" > 0
    AND "masterReferenceCount" BETWEEN 1 AND "sourceSegmentCount"
    AND (
      ("includesProof" AND "selectedTakeCount" = 4
        AND "compatibilityEdgeCount" = 3)
      OR
      (NOT "includesProof" AND "selectedTakeCount" = 3
        AND "compatibilityEdgeCount" = 2)
    )
    AND (
      ("hasColdOpen"
        AND "sourceSegmentCount" = "selectedTakeCount" + 1)
      OR
      (NOT "hasColdOpen"
        AND "sourceSegmentCount" = "selectedTakeCount")
    )
  ),
  CONSTRAINT "variant_recipe_runs_scores_check" CHECK (
    "minimumEdgeScore" BETWEEN 0 AND 100
    AND "averageEdgeScore" BETWEEN 0 AND 100
    AND "objectiveScore" BETWEEN 0 AND 100
    AND "totalScore" BETWEEN 0 AND 100
    AND "minimumEdgeScore" <= "averageEdgeScore"
  ),
  CONSTRAINT "variant_recipe_runs_hashes_check" CHECK (
    "compatibilityGraphRunHash" ~ '^[a-f0-9]{64}$'
    AND "proofPolicyHash" ~ '^[a-f0-9]{64}$'
    AND "scoresHash" ~ '^[a-f0-9]{64}$'
    AND "storyPlanHash" ~ '^[a-f0-9]{64}$'
    AND "editPlanHash" ~ '^[a-f0-9]{64}$'
    AND "runHash" ~ '^[a-f0-9]{64}$'
    AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "variant_recipe_runs_json_check" CHECK (
    length("resultJson") BETWEEN 2 AND 100000000
  )
);

CREATE TABLE "variant_recipe_lineage" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "recipeId" VARCHAR(128) NOT NULL,
  "compatibilityGraphId" VARCHAR(128) NOT NULL,
  "sequence" INTEGER NOT NULL,
  "usage" VARCHAR(16) NOT NULL,
  "role" VARCHAR(16) NOT NULL,
  "nodeId" VARCHAR(128) NOT NULL,
  "takeId" VARCHAR(128) NOT NULL,
  "takeHash" CHAR(64) NOT NULL,
  "scriptBlockId" VARCHAR(128) NOT NULL,
  "groupId" VARCHAR(128) NOT NULL,
  "sourceSegmentId" VARCHAR(128) NOT NULL,
  "sourceArtifactId" VARCHAR(128) NOT NULL,
  "sourceHash" CHAR(64) NOT NULL,
  "sourceRangeStartMs" DECIMAL(14,3) NOT NULL,
  "sourceRangeEndMs" DECIMAL(14,3) NOT NULL,
  "lineageJson" TEXT NOT NULL,
  "lineageHash" CHAR(64) NOT NULL,

  CONSTRAINT "variant_recipe_lineage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "variant_recipe_lineage_sequence_check" CHECK (
    "sequence" BETWEEN 0 AND 4
  ),
  CONSTRAINT "variant_recipe_lineage_usage_check" CHECK (
    "usage" IN ('primary', 'cold-open')
  ),
  CONSTRAINT "variant_recipe_lineage_role_check" CHECK (
    "role" IN ('hook', 'body', 'proof', 'cta')
  ),
  CONSTRAINT "variant_recipe_lineage_range_check" CHECK (
    "sourceRangeStartMs" >= 0
    AND "sourceRangeEndMs" > "sourceRangeStartMs"
  ),
  CONSTRAINT "variant_recipe_lineage_hashes_check" CHECK (
    "takeHash" ~ '^[a-f0-9]{64}$'
    AND "sourceHash" ~ '^[a-f0-9]{64}$'
    AND "lineageHash" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "variant_recipe_lineage_json_check" CHECK (
    length("lineageJson") BETWEEN 2 AND 100000
  )
);

CREATE INDEX "variant_recipe_runs_workspaceId_batchId_createdAt_id_idx"
  ON "variant_recipe_runs"(
    "workspaceId",
    "batchId",
    "createdAt" DESC,
    "id" DESC
  );
CREATE INDEX "variant_recipe_runs_workspaceId_projectId_status_totalScore_idx"
  ON "variant_recipe_runs"(
    "workspaceId",
    "projectId",
    "status",
    "totalScore" DESC
  );
CREATE INDEX "variant_recipe_runs_workspaceId_compatibilityGraphId_create_idx"
  ON "variant_recipe_runs"(
    "workspaceId",
    "compatibilityGraphId",
    "createdAt" DESC
  );
CREATE INDEX "variant_recipe_runs_workspaceId_takeLibraryId_createdAt_idx"
  ON "variant_recipe_runs"(
    "workspaceId",
    "takeLibraryId",
    "createdAt" DESC
  );
CREATE INDEX "variant_recipe_runs_workspaceId_includesProof_hasColdOpen_t_idx"
  ON "variant_recipe_runs"(
    "workspaceId",
    "includesProof",
    "hasColdOpen",
    "totalScore" DESC
  );
CREATE UNIQUE INDEX "variant_recipe_runs_id_workspaceId_key"
  ON "variant_recipe_runs"("id", "workspaceId");
CREATE UNIQUE INDEX "variant_recipe_runs_lineage_scope_key"
  ON "variant_recipe_runs"(
    "id",
    "workspaceId",
    "compatibilityGraphId"
  );
CREATE UNIQUE INDEX "variant_recipe_runs_workspaceId_createdByClientId_idempoten_key"
  ON "variant_recipe_runs"(
    "workspaceId",
    "createdByClientId",
    "idempotencyKey"
  );

CREATE INDEX "variant_recipe_lineage_workspaceId_recipeId_role_sequence_idx"
  ON "variant_recipe_lineage"(
    "workspaceId",
    "recipeId",
    "role",
    "sequence"
  );
CREATE INDEX "variant_recipe_lineage_workspaceId_compatibilityGraphId_nod_idx"
  ON "variant_recipe_lineage"(
    "workspaceId",
    "compatibilityGraphId",
    "nodeId"
  );
CREATE INDEX "variant_recipe_lineage_workspaceId_takeId_scriptBlockId_idx"
  ON "variant_recipe_lineage"(
    "workspaceId",
    "takeId",
    "scriptBlockId"
  );
CREATE INDEX "variant_recipe_lineage_workspaceId_sourceArtifactId_sourceR_idx"
  ON "variant_recipe_lineage"(
    "workspaceId",
    "sourceArtifactId",
    "sourceRangeStartMs"
  );
CREATE UNIQUE INDEX "variant_recipe_lineage_recipeId_sequence_key"
  ON "variant_recipe_lineage"("recipeId", "sequence");
CREATE UNIQUE INDEX "variant_recipe_lineage_recipeId_sourceSegmentId_key"
  ON "variant_recipe_lineage"("recipeId", "sourceSegmentId");

ALTER TABLE "variant_recipe_runs"
  ADD CONSTRAINT "variant_recipe_runs_workspaceId_fkey"
  FOREIGN KEY ("workspaceId")
  REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "variant_recipe_runs"
  ADD CONSTRAINT "variant_recipe_runs_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "variant_recipe_runs"
  ADD CONSTRAINT "variant_recipe_runs_batchId_workspaceId_fkey"
  FOREIGN KEY ("batchId", "workspaceId")
  REFERENCES "production_batches"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "variant_recipe_runs"
  ADD CONSTRAINT "variant_recipe_runs_graph_scope_fkey"
  FOREIGN KEY (
    "compatibilityGraphId",
    "workspaceId",
    "projectId",
    "batchId",
    "takeLibraryId",
    "compatibilityGraphRunHash"
  )
  REFERENCES "compatibility_graph_runs"(
    "id",
    "workspaceId",
    "projectId",
    "batchId",
    "takeLibraryId",
    "runHash"
  )
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "variant_recipe_runs"
  ADD CONSTRAINT "variant_recipe_runs_takeLibraryId_workspaceId_fkey"
  FOREIGN KEY ("takeLibraryId", "workspaceId")
  REFERENCES "take_library_runs"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "variant_recipe_runs"
  ADD CONSTRAINT "variant_recipe_runs_createdByClientId_workspaceId_fkey"
  FOREIGN KEY ("createdByClientId", "workspaceId")
  REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "variant_recipe_lineage"
  ADD CONSTRAINT "variant_recipe_lineage_workspaceId_fkey"
  FOREIGN KEY ("workspaceId")
  REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "variant_recipe_lineage"
  ADD CONSTRAINT "variant_recipe_lineage_recipe_scope_fkey"
  FOREIGN KEY (
    "recipeId",
    "workspaceId",
    "compatibilityGraphId"
  )
  REFERENCES "variant_recipe_runs"(
    "id",
    "workspaceId",
    "compatibilityGraphId"
  )
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "variant_recipe_lineage"
  ADD CONSTRAINT "variant_recipe_lineage_nodeId_workspaceId_compatibilityGra_fkey"
  FOREIGN KEY (
    "nodeId",
    "workspaceId",
    "compatibilityGraphId"
  )
  REFERENCES "compatibility_graph_nodes"(
    "id",
    "workspaceId",
    "graphId"
  )
  ON DELETE RESTRICT ON UPDATE CASCADE;
