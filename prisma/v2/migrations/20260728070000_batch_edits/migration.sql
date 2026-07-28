CREATE TABLE "batch_edit_policies" (
  "workspaceId" VARCHAR(128) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "defaultMode" VARCHAR(32) NOT NULL,
  "maxItemCount" INTEGER NOT NULL,
  "diffSampleSize" INTEGER NOT NULL,
  "replaceCtaCostMinorUnits" INTEGER NOT NULL,
  "subtitleStyleCostMinorUnits" INTEGER NOT NULL,
  "brandKitCostMinorUnits" INTEGER NOT NULL,
  "confirmationTtlSeconds" INTEGER NOT NULL,
  "policyJson" TEXT NOT NULL,
  "policyHash" CHAR(64) NOT NULL,
  "updatedByClientId" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "batch_edit_policies_pkey"
    PRIMARY KEY ("workspaceId", "revision"),
  CONSTRAINT "batch_edit_policies_version_check"
    CHECK ("schemaVersion" = 'batch-edit-policy/v1'),
  CONSTRAINT "batch_edit_policies_revision_check"
    CHECK ("revision" BETWEEN 1 AND 1000000),
  CONSTRAINT "batch_edit_policies_mode_check"
    CHECK ("defaultMode" IN ('all-or-nothing', 'skip-failures')),
  CONSTRAINT "batch_edit_policies_limits_check" CHECK (
    "maxItemCount" BETWEEN 1 AND 1000
    AND "diffSampleSize" BETWEEN 1 AND LEAST("maxItemCount", 25)
    AND "confirmationTtlSeconds" BETWEEN 60 AND 86400
  ),
  CONSTRAINT "batch_edit_policies_costs_check" CHECK (
    "replaceCtaCostMinorUnits" BETWEEN 0 AND 1000000
    AND "subtitleStyleCostMinorUnits" BETWEEN 0 AND 1000000
    AND "brandKitCostMinorUnits" BETWEEN 0 AND 1000000
  ),
  CONSTRAINT "batch_edit_policies_hash_check"
    CHECK ("policyHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "batch_edit_policies_json_check"
    CHECK (length("policyJson") BETWEEN 2 AND 100000)
);

CREATE UNIQUE INDEX "batch_edit_policies_workspaceId_policyHash_key"
  ON "batch_edit_policies"("workspaceId", "policyHash");
CREATE INDEX "batch_edit_policies_workspaceId_revision_idx"
  ON "batch_edit_policies"("workspaceId", "revision");
CREATE INDEX "batch_edit_policies_updatedByClientId_updatedAt_idx"
  ON "batch_edit_policies"("updatedByClientId", "updatedAt" DESC);

CREATE TABLE "batch_edit_item_state_versions" (
  "workspaceId" VARCHAR(128) NOT NULL,
  "batchId" VARCHAR(128) NOT NULL,
  "itemId" VARCHAR(128) NOT NULL,
  "revision" INTEGER NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "directivesJson" TEXT NOT NULL,
  "protectedOperationsJson" TEXT NOT NULL,
  "stateJson" TEXT NOT NULL,
  "stateHash" CHAR(64) NOT NULL,
  "previousStateHash" CHAR(64),
  "sourceCommandId" VARCHAR(128),
  "createdByClientId" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "batch_edit_item_state_versions_pkey"
    PRIMARY KEY ("itemId", "revision"),
  CONSTRAINT "batch_edit_item_state_versions_version_check"
    CHECK ("schemaVersion" = 'batch-edit-item-state/v1'),
  CONSTRAINT "batch_edit_item_state_versions_lineage_check" CHECK (
    (
      "revision" = 1
      AND "previousStateHash" IS NULL
      AND "sourceCommandId" IS NULL
    )
    OR
    (
      "revision" BETWEEN 2 AND 1000000
      AND "previousStateHash" IS NOT NULL
      AND "sourceCommandId" IS NOT NULL
    )
  ),
  CONSTRAINT "batch_edit_item_state_versions_hashes_check" CHECK (
    "stateHash" ~ '^[a-f0-9]{64}$'
    AND (
      "previousStateHash" IS NULL
      OR "previousStateHash" ~ '^[a-f0-9]{64}$'
    )
  ),
  CONSTRAINT "batch_edit_item_state_versions_json_check" CHECK (
    length("directivesJson") BETWEEN 2 AND 100000
    AND length("protectedOperationsJson") BETWEEN 2 AND 100000
    AND length("stateJson") BETWEEN 2 AND 1000000
  )
);

CREATE UNIQUE INDEX "batch_edit_item_state_versions_itemId_stateHash_key"
  ON "batch_edit_item_state_versions"("itemId", "stateHash");
CREATE INDEX "batch_edit_item_state_versions_workspaceId_batchId_itemId_r_idx"
  ON "batch_edit_item_state_versions"(
    "workspaceId",
    "batchId",
    "itemId",
    "revision" DESC
  );
CREATE INDEX "batch_edit_item_state_versions_workspaceId_sourceCommandId_idx"
  ON "batch_edit_item_state_versions"(
    "workspaceId",
    "sourceCommandId"
  );
CREATE INDEX "batch_edit_item_state_versions_createdByClientId_createdAt_idx"
  ON "batch_edit_item_state_versions"(
    "createdByClientId",
    "createdAt" DESC
  );

CREATE TABLE "batch_edit_preflight_runs" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "batchId" VARCHAR(128) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "impactVersion" VARCHAR(64) NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "mode" VARCHAR(32) NOT NULL,
  "operationType" VARCHAR(32) NOT NULL,
  "operationValueRef" VARCHAR(128) NOT NULL,
  "resultJson" TEXT NOT NULL,
  "policyHash" CHAR(64) NOT NULL,
  "batchRevision" INTEGER NOT NULL,
  "batchDefinitionHash" CHAR(64) NOT NULL,
  "scopeHash" CHAR(64) NOT NULL,
  "budgetRemainingMinorUnits" INTEGER NOT NULL,
  "affectedItemCount" INTEGER NOT NULL,
  "applicableItemCount" INTEGER NOT NULL,
  "protectedConflictCount" INTEGER NOT NULL,
  "unchangedItemCount" INTEGER NOT NULL,
  "invalidationCount" INTEGER NOT NULL,
  "estimatedCostMinorUnits" INTEGER NOT NULL,
  "budgetExceeded" BOOLEAN NOT NULL,
  "confirmationExpiresAt" TIMESTAMPTZ(3),
  "costFingerprint" CHAR(64) NOT NULL,
  "preflightHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "batch_edit_preflight_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "batch_edit_preflight_runs_versions_check" CHECK (
    "schemaVersion" = 'batch-edit-preflight/v1'
    AND "impactVersion" = 'batch-edit-impact/v1'
  ),
  CONSTRAINT "batch_edit_preflight_runs_status_check"
    CHECK ("status" IN ('ready', 'partial-ready', 'blocked', 'no-change')),
  CONSTRAINT "batch_edit_preflight_runs_mode_check"
    CHECK ("mode" IN ('all-or-nothing', 'skip-failures')),
  CONSTRAINT "batch_edit_preflight_runs_operation_check"
    CHECK ("operationType" IN ('replace-cta', 'subtitle-style', 'brand-kit')),
  CONSTRAINT "batch_edit_preflight_runs_counts_check" CHECK (
    "batchRevision" BETWEEN 1 AND 1000000
    AND "budgetRemainingMinorUnits" BETWEEN 0 AND 100000000
    AND "affectedItemCount" BETWEEN 1 AND 1000
    AND "applicableItemCount" BETWEEN 0 AND "affectedItemCount"
    AND "protectedConflictCount" BETWEEN 0 AND "affectedItemCount"
    AND "unchangedItemCount" BETWEEN 0 AND "affectedItemCount"
    AND "affectedItemCount" =
      "applicableItemCount" +
      "protectedConflictCount" +
      "unchangedItemCount"
    AND "invalidationCount" >= 0
    AND "estimatedCostMinorUnits" BETWEEN 0 AND 100000000
  ),
  CONSTRAINT "batch_edit_preflight_runs_invalidations_check" CHECK (
    "invalidationCount" = "applicableItemCount" * (
      CASE "operationType"
        WHEN 'replace-cta' THEN 4
        WHEN 'subtitle-style' THEN 2
        WHEN 'brand-kit' THEN 3
      END
    )
  ),
  CONSTRAINT "batch_edit_preflight_runs_budget_check"
    CHECK (
      "budgetExceeded" =
        ("estimatedCostMinorUnits" > "budgetRemainingMinorUnits")
    ),
  CONSTRAINT "batch_edit_preflight_runs_status_coherence_check" CHECK (
    (
      "status" = 'ready'
      AND NOT "budgetExceeded"
      AND "applicableItemCount" > 0
      AND "protectedConflictCount" = 0
    )
    OR
    (
      "status" = 'partial-ready'
      AND NOT "budgetExceeded"
      AND "mode" = 'skip-failures'
      AND "applicableItemCount" > 0
      AND "protectedConflictCount" > 0
    )
    OR
    (
      "status" = 'blocked'
      AND (
        "budgetExceeded"
        OR (
          "mode" = 'all-or-nothing'
          AND "protectedConflictCount" > 0
        )
        OR (
          "mode" = 'skip-failures'
          AND "applicableItemCount" = 0
          AND "protectedConflictCount" > 0
        )
      )
    )
    OR
    (
      "status" = 'no-change'
      AND NOT "budgetExceeded"
      AND "applicableItemCount" = 0
      AND "protectedConflictCount" = 0
    )
  ),
  CONSTRAINT "batch_edit_preflight_runs_confirmation_check" CHECK (
    (
      "status" IN ('ready', 'partial-ready')
      AND "confirmationExpiresAt" IS NOT NULL
      AND "confirmationExpiresAt" > "createdAt"
    )
    OR
    (
      "status" IN ('blocked', 'no-change')
      AND "confirmationExpiresAt" IS NULL
    )
  ),
  CONSTRAINT "batch_edit_preflight_runs_hashes_check" CHECK (
    "policyHash" ~ '^[a-f0-9]{64}$'
    AND "batchDefinitionHash" ~ '^[a-f0-9]{64}$'
    AND "scopeHash" ~ '^[a-f0-9]{64}$'
    AND "costFingerprint" ~ '^[a-f0-9]{64}$'
    AND "preflightHash" ~ '^[a-f0-9]{64}$'
    AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "batch_edit_preflight_runs_json_check"
    CHECK (length("resultJson") BETWEEN 2 AND 100000000)
);

CREATE UNIQUE INDEX "batch_edit_preflight_runs_id_workspaceId_batchId_preflightH_key"
  ON "batch_edit_preflight_runs"(
    "id",
    "workspaceId",
    "batchId",
    "preflightHash"
  );
CREATE UNIQUE INDEX "batch_edit_preflight_runs_workspaceId_createdByClientId_ide_key"
  ON "batch_edit_preflight_runs"(
    "workspaceId",
    "createdByClientId",
    "idempotencyKey"
  );
CREATE INDEX "batch_edit_preflight_runs_workspaceId_batchId_createdAt_id_idx"
  ON "batch_edit_preflight_runs"(
    "workspaceId",
    "batchId",
    "createdAt" DESC,
    "id" DESC
  );
CREATE INDEX "batch_edit_preflight_runs_workspaceId_batchId_status_create_idx"
  ON "batch_edit_preflight_runs"(
    "workspaceId",
    "batchId",
    "status",
    "createdAt" DESC
  );
CREATE INDEX "batch_edit_preflight_runs_workspaceId_policyHash_idx"
  ON "batch_edit_preflight_runs"("workspaceId", "policyHash");

CREATE TABLE "batch_edit_commands" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "batchId" VARCHAR(128) NOT NULL,
  "preflightId" VARCHAR(128) NOT NULL,
  "preflightHash" CHAR(64) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "mode" VARCHAR(32) NOT NULL,
  "operationType" VARCHAR(32) NOT NULL,
  "operationValueRef" VARCHAR(128) NOT NULL,
  "resultJson" TEXT NOT NULL,
  "batchRevision" INTEGER NOT NULL,
  "batchDefinitionHash" CHAR(64) NOT NULL,
  "policyHash" CHAR(64) NOT NULL,
  "scopeHash" CHAR(64) NOT NULL,
  "affectedItemCount" INTEGER NOT NULL,
  "appliedItemCount" INTEGER NOT NULL,
  "skippedItemCount" INTEGER NOT NULL,
  "unchangedItemCount" INTEGER NOT NULL,
  "invalidationCount" INTEGER NOT NULL,
  "costMinorUnits" INTEGER NOT NULL,
  "commandHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "batch_edit_commands_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "batch_edit_commands_version_check"
    CHECK ("schemaVersion" = 'batch-edit-command/v1'),
  CONSTRAINT "batch_edit_commands_status_check"
    CHECK ("status" IN ('committed', 'partial')),
  CONSTRAINT "batch_edit_commands_mode_check"
    CHECK ("mode" IN ('all-or-nothing', 'skip-failures')),
  CONSTRAINT "batch_edit_commands_operation_check"
    CHECK ("operationType" IN ('replace-cta', 'subtitle-style', 'brand-kit')),
  CONSTRAINT "batch_edit_commands_counts_check" CHECK (
    "batchRevision" BETWEEN 1 AND 1000000
    AND "affectedItemCount" BETWEEN 1 AND 1000
    AND "appliedItemCount" BETWEEN 1 AND "affectedItemCount"
    AND "skippedItemCount" BETWEEN 0 AND "affectedItemCount"
    AND "unchangedItemCount" BETWEEN 0 AND "affectedItemCount"
    AND "affectedItemCount" =
      "appliedItemCount" +
      "skippedItemCount" +
      "unchangedItemCount"
    AND "invalidationCount" = "appliedItemCount" * (
      CASE "operationType"
        WHEN 'replace-cta' THEN 4
        WHEN 'subtitle-style' THEN 2
        WHEN 'brand-kit' THEN 3
      END
    )
    AND "costMinorUnits" BETWEEN 0 AND 100000000
  ),
  CONSTRAINT "batch_edit_commands_status_coherence_check" CHECK (
    (
      "status" = 'committed'
      AND "skippedItemCount" = 0
    )
    OR
    (
      "status" = 'partial'
      AND "mode" = 'skip-failures'
      AND "skippedItemCount" > 0
    )
  ),
  CONSTRAINT "batch_edit_commands_atomic_mode_check"
    CHECK ("mode" = 'skip-failures' OR "skippedItemCount" = 0),
  CONSTRAINT "batch_edit_commands_hashes_check" CHECK (
    "preflightHash" ~ '^[a-f0-9]{64}$'
    AND "batchDefinitionHash" ~ '^[a-f0-9]{64}$'
    AND "policyHash" ~ '^[a-f0-9]{64}$'
    AND "scopeHash" ~ '^[a-f0-9]{64}$'
    AND "commandHash" ~ '^[a-f0-9]{64}$'
    AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "batch_edit_commands_json_check"
    CHECK (length("resultJson") BETWEEN 2 AND 100000000)
);

CREATE UNIQUE INDEX "batch_edit_commands_preflightId_key"
  ON "batch_edit_commands"("preflightId");
CREATE UNIQUE INDEX "batch_edit_commands_id_workspaceId_batchId_key"
  ON "batch_edit_commands"("id", "workspaceId", "batchId");
CREATE UNIQUE INDEX "batch_edit_commands_preflightId_workspaceId_batchId_preflig_key"
  ON "batch_edit_commands"(
    "preflightId",
    "workspaceId",
    "batchId",
    "preflightHash"
  );
CREATE UNIQUE INDEX "batch_edit_commands_workspaceId_createdByClientId_idempoten_key"
  ON "batch_edit_commands"(
    "workspaceId",
    "createdByClientId",
    "idempotencyKey"
  );
CREATE INDEX "batch_edit_commands_workspaceId_batchId_createdAt_id_idx"
  ON "batch_edit_commands"(
    "workspaceId",
    "batchId",
    "createdAt" DESC,
    "id" DESC
  );
CREATE INDEX "batch_edit_commands_workspaceId_batchId_status_createdAt_idx"
  ON "batch_edit_commands"(
    "workspaceId",
    "batchId",
    "status",
    "createdAt" DESC
  );
CREATE INDEX "batch_edit_commands_workspaceId_policyHash_idx"
  ON "batch_edit_commands"("workspaceId", "policyHash");

CREATE TABLE "batch_edit_command_items" (
  "workspaceId" VARCHAR(128) NOT NULL,
  "batchId" VARCHAR(128) NOT NULL,
  "commandId" VARCHAR(128) NOT NULL,
  "itemId" VARCHAR(128) NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "targetRef" VARCHAR(260) NOT NULL,
  "beforeStateRevision" INTEGER NOT NULL,
  "beforeStateHash" CHAR(64) NOT NULL,
  "afterStateRevision" INTEGER,
  "afterStateHash" CHAR(64),
  "costMinorUnits" INTEGER NOT NULL,
  "resultJson" TEXT NOT NULL,
  "resultHash" CHAR(64) NOT NULL,

  CONSTRAINT "batch_edit_command_items_pkey"
    PRIMARY KEY ("commandId", "itemId"),
  CONSTRAINT "batch_edit_command_items_status_check"
    CHECK ("status" IN ('applied', 'skipped', 'unchanged')),
  CONSTRAINT "batch_edit_command_items_revision_check"
    CHECK ("beforeStateRevision" BETWEEN 1 AND 1000000),
  CONSTRAINT "batch_edit_command_items_result_check" CHECK (
    (
      "status" = 'applied'
      AND "afterStateRevision" = "beforeStateRevision" + 1
      AND "afterStateHash" IS NOT NULL
    )
    OR
    (
      "status" IN ('skipped', 'unchanged')
      AND "afterStateRevision" IS NULL
      AND "afterStateHash" IS NULL
      AND "costMinorUnits" = 0
    )
  ),
  CONSTRAINT "batch_edit_command_items_cost_check"
    CHECK ("costMinorUnits" BETWEEN 0 AND 1000000),
  CONSTRAINT "batch_edit_command_items_hashes_check" CHECK (
    "beforeStateHash" ~ '^[a-f0-9]{64}$'
    AND (
      "afterStateHash" IS NULL
      OR "afterStateHash" ~ '^[a-f0-9]{64}$'
    )
    AND "resultHash" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "batch_edit_command_items_json_check"
    CHECK (length("resultJson") BETWEEN 2 AND 1000000)
);

CREATE INDEX "batch_edit_command_items_workspaceId_batchId_itemId_idx"
  ON "batch_edit_command_items"("workspaceId", "batchId", "itemId");
CREATE INDEX "batch_edit_command_items_workspaceId_commandId_status_idx"
  ON "batch_edit_command_items"("workspaceId", "commandId", "status");
CREATE INDEX "batch_edit_command_items_itemId_beforeStateRevision_idx"
  ON "batch_edit_command_items"("itemId", "beforeStateRevision");
CREATE INDEX "batch_edit_command_items_itemId_afterStateRevision_idx"
  ON "batch_edit_command_items"("itemId", "afterStateRevision");

CREATE TABLE "batch_edit_invalidations" (
  "workspaceId" VARCHAR(128) NOT NULL,
  "batchId" VARCHAR(128) NOT NULL,
  "commandId" VARCHAR(128) NOT NULL,
  "itemId" VARCHAR(128) NOT NULL,
  "step" VARCHAR(32) NOT NULL,
  "sequence" INTEGER NOT NULL,
  "targetRef" VARCHAR(260) NOT NULL,
  "invalidationHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "batch_edit_invalidations_pkey"
    PRIMARY KEY ("commandId", "itemId", "step"),
  CONSTRAINT "batch_edit_invalidations_step_check"
    CHECK ("step" IN ('planning', 'materializing', 'rendering', 'reviewing')),
  CONSTRAINT "batch_edit_invalidations_sequence_check"
    CHECK ("sequence" BETWEEN 0 AND 3),
  CONSTRAINT "batch_edit_invalidations_hash_check"
    CHECK ("invalidationHash" ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX "batch_edit_invalidations_commandId_itemId_sequence_key"
  ON "batch_edit_invalidations"("commandId", "itemId", "sequence");
CREATE INDEX "batch_edit_invalidations_workspaceId_batchId_itemId_sequenc_idx"
  ON "batch_edit_invalidations"(
    "workspaceId",
    "batchId",
    "itemId",
    "sequence"
  );
CREATE INDEX "batch_edit_invalidations_workspaceId_step_createdAt_idx"
  ON "batch_edit_invalidations"(
    "workspaceId",
    "step",
    "createdAt" DESC
  );

ALTER TABLE "batch_edit_policies"
  ADD CONSTRAINT "batch_edit_policies_workspaceId_fkey"
  FOREIGN KEY ("workspaceId")
  REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "batch_edit_policies"
  ADD CONSTRAINT "batch_edit_policies_updatedByClientId_workspaceId_fkey"
  FOREIGN KEY ("updatedByClientId", "workspaceId")
  REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "batch_edit_item_state_versions"
  ADD CONSTRAINT "batch_edit_item_state_versions_workspaceId_fkey"
  FOREIGN KEY ("workspaceId")
  REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "batch_edit_item_state_versions"
  ADD CONSTRAINT "batch_edit_item_state_versions_batchId_workspaceId_fkey"
  FOREIGN KEY ("batchId", "workspaceId")
  REFERENCES "production_batches"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "batch_edit_item_state_versions"
  ADD CONSTRAINT "batch_edit_item_state_versions_itemId_workspaceId_batchId_fkey"
  FOREIGN KEY ("itemId", "workspaceId", "batchId")
  REFERENCES "production_batch_items"("id", "workspaceId", "batchId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "batch_edit_item_state_versions"
  ADD CONSTRAINT "batch_edit_item_state_versions_createdByClientId_workspace_fkey"
  FOREIGN KEY ("createdByClientId", "workspaceId")
  REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "batch_edit_item_state_versions"
  ADD CONSTRAINT "batch_edit_item_state_versions_itemId_previousStateHash_fkey"
  FOREIGN KEY ("itemId", "previousStateHash")
  REFERENCES "batch_edit_item_state_versions"("itemId", "stateHash")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "batch_edit_item_state_versions"
  ADD CONSTRAINT "batch_edit_item_state_versions_sourceCommandId_workspaceId_fkey"
  FOREIGN KEY ("sourceCommandId", "workspaceId", "batchId")
  REFERENCES "batch_edit_commands"("id", "workspaceId", "batchId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "batch_edit_preflight_runs"
  ADD CONSTRAINT "batch_edit_preflight_runs_workspaceId_fkey"
  FOREIGN KEY ("workspaceId")
  REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "batch_edit_preflight_runs"
  ADD CONSTRAINT "batch_edit_preflight_runs_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "batch_edit_preflight_runs"
  ADD CONSTRAINT "batch_edit_preflight_runs_batchId_workspaceId_fkey"
  FOREIGN KEY ("batchId", "workspaceId")
  REFERENCES "production_batches"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "batch_edit_preflight_runs"
  ADD CONSTRAINT "batch_edit_preflight_runs_workspaceId_policyHash_fkey"
  FOREIGN KEY ("workspaceId", "policyHash")
  REFERENCES "batch_edit_policies"("workspaceId", "policyHash")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "batch_edit_preflight_runs"
  ADD CONSTRAINT "batch_edit_preflight_runs_createdByClientId_workspaceId_fkey"
  FOREIGN KEY ("createdByClientId", "workspaceId")
  REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "batch_edit_commands"
  ADD CONSTRAINT "batch_edit_commands_workspaceId_fkey"
  FOREIGN KEY ("workspaceId")
  REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "batch_edit_commands"
  ADD CONSTRAINT "batch_edit_commands_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "batch_edit_commands"
  ADD CONSTRAINT "batch_edit_commands_batchId_workspaceId_fkey"
  FOREIGN KEY ("batchId", "workspaceId")
  REFERENCES "production_batches"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "batch_edit_commands"
  ADD CONSTRAINT "batch_edit_commands_preflightId_workspaceId_batchId_prefli_fkey"
  FOREIGN KEY (
    "preflightId",
    "workspaceId",
    "batchId",
    "preflightHash"
  )
  REFERENCES "batch_edit_preflight_runs"(
    "id",
    "workspaceId",
    "batchId",
    "preflightHash"
  )
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "batch_edit_commands"
  ADD CONSTRAINT "batch_edit_commands_createdByClientId_workspaceId_fkey"
  FOREIGN KEY ("createdByClientId", "workspaceId")
  REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "batch_edit_command_items"
  ADD CONSTRAINT "batch_edit_command_items_workspaceId_fkey"
  FOREIGN KEY ("workspaceId")
  REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "batch_edit_command_items"
  ADD CONSTRAINT "batch_edit_command_items_batchId_workspaceId_fkey"
  FOREIGN KEY ("batchId", "workspaceId")
  REFERENCES "production_batches"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "batch_edit_command_items"
  ADD CONSTRAINT "batch_edit_command_items_commandId_workspaceId_batchId_fkey"
  FOREIGN KEY ("commandId", "workspaceId", "batchId")
  REFERENCES "batch_edit_commands"("id", "workspaceId", "batchId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "batch_edit_command_items"
  ADD CONSTRAINT "batch_edit_command_items_itemId_workspaceId_batchId_fkey"
  FOREIGN KEY ("itemId", "workspaceId", "batchId")
  REFERENCES "production_batch_items"("id", "workspaceId", "batchId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "batch_edit_command_items"
  ADD CONSTRAINT "batch_edit_command_items_itemId_beforeStateHash_fkey"
  FOREIGN KEY ("itemId", "beforeStateHash")
  REFERENCES "batch_edit_item_state_versions"("itemId", "stateHash")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "batch_edit_command_items"
  ADD CONSTRAINT "batch_edit_command_items_itemId_afterStateHash_fkey"
  FOREIGN KEY ("itemId", "afterStateHash")
  REFERENCES "batch_edit_item_state_versions"("itemId", "stateHash")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "batch_edit_invalidations"
  ADD CONSTRAINT "batch_edit_invalidations_workspaceId_fkey"
  FOREIGN KEY ("workspaceId")
  REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "batch_edit_invalidations"
  ADD CONSTRAINT "batch_edit_invalidations_batchId_workspaceId_fkey"
  FOREIGN KEY ("batchId", "workspaceId")
  REFERENCES "production_batches"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "batch_edit_invalidations"
  ADD CONSTRAINT "batch_edit_invalidations_itemId_workspaceId_batchId_fkey"
  FOREIGN KEY ("itemId", "workspaceId", "batchId")
  REFERENCES "production_batch_items"("id", "workspaceId", "batchId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "batch_edit_invalidations"
  ADD CONSTRAINT "batch_edit_invalidations_commandId_itemId_fkey"
  FOREIGN KEY ("commandId", "itemId")
  REFERENCES "batch_edit_command_items"("commandId", "itemId")
  ON DELETE CASCADE ON UPDATE CASCADE;
