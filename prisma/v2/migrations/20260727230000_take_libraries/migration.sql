CREATE TABLE "take_library_runs" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "batchId" VARCHAR(128) NOT NULL,
  "alignmentId" VARCHAR(128) NOT NULL,
  "alignmentRunHash" CHAR(64) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "groupingPolicyVersion" VARCHAR(64) NOT NULL,
  "evaluationPolicyVersion" VARCHAR(64) NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "resultJson" TEXT NOT NULL,
  "groupCount" INTEGER NOT NULL,
  "takeCount" INTEGER NOT NULL,
  "primaryCount" INTEGER NOT NULL,
  "alternateCount" INTEGER NOT NULL,
  "rejectedCount" INTEGER NOT NULL,
  "needsReviewCount" INTEGER NOT NULL,
  "protectedCount" INTEGER NOT NULL,
  "measuredDimensionCount" INTEGER NOT NULL,
  "unavailableDimensionCount" INTEGER NOT NULL,
  "runHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "take_library_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "take_library_runs_versions_check" CHECK (
    "schemaVersion" = 'take-library/v1'
    AND "groupingPolicyVersion" = 'script-block-or-intention/v1'
    AND "evaluationPolicyVersion" = 'five-dimension-take-quality/v1'
  ),
  CONSTRAINT "take_library_runs_status_check" CHECK (
    "status" IN ('completed', 'review-required', 'reviewed')
  ),
  CONSTRAINT "take_library_runs_counts_check" CHECK (
    "revision" BETWEEN 1 AND 1000000
    AND "groupCount" BETWEEN 1 AND 2000
    AND "takeCount" BETWEEN 1 AND 2000
    AND "primaryCount" BETWEEN 0 AND "takeCount"
    AND "alternateCount" BETWEEN 0 AND "takeCount"
    AND "rejectedCount" BETWEEN 0 AND "takeCount"
    AND "needsReviewCount" BETWEEN 0 AND "takeCount"
    AND (
      "primaryCount" +
      "alternateCount" +
      "rejectedCount" +
      "needsReviewCount"
    ) = "takeCount"
    AND "protectedCount" BETWEEN 0 AND "primaryCount"
    AND "measuredDimensionCount" BETWEEN 0 AND "takeCount" * 5
    AND "unavailableDimensionCount" BETWEEN 0 AND "takeCount" * 5
    AND "updatedAt" >= "createdAt"
  ),
  CONSTRAINT "take_library_runs_hashes_check" CHECK (
    "alignmentRunHash" ~ '^[a-f0-9]{64}$'
    AND "runHash" ~ '^[a-f0-9]{64}$'
    AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "take_library_runs_json_check" CHECK (
    length("resultJson") BETWEEN 2 AND 50000000
  )
);

CREATE UNIQUE INDEX "take_library_runs_id_workspaceId_key"
  ON "take_library_runs"("id", "workspaceId");
CREATE UNIQUE INDEX "take_library_runs_workspaceId_createdByClientId_idempotency_key"
  ON "take_library_runs"(
    "workspaceId",
    "createdByClientId",
    "idempotencyKey"
  );
CREATE INDEX "take_library_runs_workspaceId_batchId_createdAt_id_idx"
  ON "take_library_runs"(
    "workspaceId",
    "batchId",
    "createdAt" DESC,
    "id" DESC
  );
CREATE INDEX "take_library_runs_workspaceId_projectId_status_updatedAt_idx"
  ON "take_library_runs"(
    "workspaceId",
    "projectId",
    "status",
    "updatedAt" DESC
  );
CREATE INDEX "take_library_runs_workspaceId_alignmentId_createdAt_idx"
  ON "take_library_runs"(
    "workspaceId",
    "alignmentId",
    "createdAt" DESC
  );
CREATE INDEX "take_library_runs_workspaceId_status_needsReviewCount_updat_idx"
  ON "take_library_runs"(
    "workspaceId",
    "status",
    "needsReviewCount",
    "updatedAt" DESC
  );

CREATE TABLE "take_library_selections" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "runId" VARCHAR(128) NOT NULL,
  "expectedRevision" INTEGER NOT NULL,
  "resultRevision" INTEGER NOT NULL,
  "groupId" VARCHAR(128) NOT NULL,
  "takeId" VARCHAR(128) NOT NULL,
  "protect" BOOLEAN NOT NULL,
  "replacedProtectedTakeId" VARCHAR(128),
  "selectionJson" TEXT NOT NULL,
  "selectionHash" CHAR(64) NOT NULL,
  "resultRunJson" TEXT NOT NULL,
  "resultRunHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "actorClientId" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "take_library_selections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "take_library_selections_revision_check" CHECK (
    "expectedRevision" BETWEEN 1 AND 999999
    AND "resultRevision" = "expectedRevision" + 1
  ),
  CONSTRAINT "take_library_selections_hashes_check" CHECK (
    "selectionHash" ~ '^[a-f0-9]{64}$'
    AND "resultRunHash" ~ '^[a-f0-9]{64}$'
    AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "take_library_selections_json_check" CHECK (
    length("selectionJson") BETWEEN 2 AND 100000
    AND length("resultRunJson") BETWEEN 2 AND 50000000
  )
);

CREATE UNIQUE INDEX "take_library_selections_workspaceId_actorClientId_idempoten_key"
  ON "take_library_selections"(
    "workspaceId",
    "actorClientId",
    "idempotencyKey"
  );
CREATE UNIQUE INDEX "take_library_selections_runId_resultRevision_key"
  ON "take_library_selections"("runId", "resultRevision");
CREATE INDEX "take_library_selections_workspaceId_runId_createdAt_idx"
  ON "take_library_selections"(
    "workspaceId",
    "runId",
    "createdAt" DESC
  );
CREATE INDEX "take_library_selections_workspaceId_groupId_takeId_createdA_idx"
  ON "take_library_selections"(
    "workspaceId",
    "groupId",
    "takeId",
    "createdAt" DESC
  );

ALTER TABLE "take_library_runs"
  ADD CONSTRAINT "take_library_runs_workspaceId_fkey"
  FOREIGN KEY ("workspaceId")
  REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "take_library_runs"
  ADD CONSTRAINT "take_library_runs_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "take_library_runs"
  ADD CONSTRAINT "take_library_runs_batchId_workspaceId_fkey"
  FOREIGN KEY ("batchId", "workspaceId")
  REFERENCES "production_batches"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "take_library_runs"
  ADD CONSTRAINT "take_library_runs_alignmentId_workspaceId_fkey"
  FOREIGN KEY ("alignmentId", "workspaceId")
  REFERENCES "script_alignment_runs"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "take_library_runs"
  ADD CONSTRAINT "take_library_runs_createdByClientId_workspaceId_fkey"
  FOREIGN KEY ("createdByClientId", "workspaceId")
  REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "take_library_selections"
  ADD CONSTRAINT "take_library_selections_workspaceId_fkey"
  FOREIGN KEY ("workspaceId")
  REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "take_library_selections"
  ADD CONSTRAINT "take_library_selections_runId_workspaceId_fkey"
  FOREIGN KEY ("runId", "workspaceId")
  REFERENCES "take_library_runs"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "take_library_selections"
  ADD CONSTRAINT "take_library_selections_actorClientId_workspaceId_fkey"
  FOREIGN KEY ("actorClientId", "workspaceId")
  REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
