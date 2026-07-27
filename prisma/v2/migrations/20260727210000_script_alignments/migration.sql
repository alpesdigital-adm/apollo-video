CREATE TABLE "script_alignment_runs" (
    "id" VARCHAR(128) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "projectId" VARCHAR(128) NOT NULL,
    "batchId" VARCHAR(128) NOT NULL,
    "schemaVersion" VARCHAR(64) NOT NULL,
    "algorithmVersion" VARCHAR(64) NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "documentHash" CHAR(64) NOT NULL,
    "documentJson" TEXT NOT NULL,
    "sourceRefsJson" TEXT NOT NULL,
    "resultJson" TEXT NOT NULL,
    "blockCount" INTEGER NOT NULL,
    "reviewRequiredCount" INTEGER NOT NULL,
    "extraTakeCount" INTEGER NOT NULL,
    "runHash" CHAR(64) NOT NULL,
    "requestFingerprint" CHAR(64) NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "createdByClientId" VARCHAR(80) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "script_alignment_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "script_alignment_runs_schema_check" CHECK (
      "schemaVersion" = 'script-alignment-run/v1'
      AND "algorithmVersion" = 'monotonic-lexical-sequence/v1'
    ),
    CONSTRAINT "script_alignment_runs_status_check" CHECK (
      "status" IN ('completed', 'review-required', 'reviewed')
    ),
    CONSTRAINT "script_alignment_runs_revision_check" CHECK (
      "revision" >= 1
    ),
    CONSTRAINT "script_alignment_runs_hash_check" CHECK (
      "documentHash" ~ '^[a-f0-9]{64}$'
      AND "runHash" ~ '^[a-f0-9]{64}$'
      AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
    ),
    CONSTRAINT "script_alignment_runs_counts_check" CHECK (
      "blockCount" BETWEEN 1 AND 500
      AND "extraTakeCount" BETWEEN 0 AND 2000
      AND "reviewRequiredCount" BETWEEN 0
        AND "blockCount" + "extraTakeCount"
    ),
    CONSTRAINT "script_alignment_runs_json_check" CHECK (
      jsonb_typeof("documentJson"::jsonb) = 'object'
      AND jsonb_typeof("sourceRefsJson"::jsonb) = 'array'
      AND jsonb_array_length("sourceRefsJson"::jsonb) BETWEEN 1 AND 50
      AND jsonb_typeof("resultJson"::jsonb) = 'object'
    ),
    CONSTRAINT "script_alignment_runs_dates_check" CHECK (
      "updatedAt" >= "createdAt"
    )
);

CREATE TABLE "script_alignment_reviews" (
    "id" VARCHAR(128) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "runId" VARCHAR(128) NOT NULL,
    "expectedRevision" INTEGER NOT NULL,
    "resultRevision" INTEGER NOT NULL,
    "decisionsJson" TEXT NOT NULL,
    "reviewHash" CHAR(64) NOT NULL,
    "resultRunJson" TEXT NOT NULL,
    "resultRunHash" CHAR(64) NOT NULL,
    "requestFingerprint" CHAR(64) NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "actorClientId" VARCHAR(80) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "script_alignment_reviews_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "script_alignment_reviews_revision_check" CHECK (
      "expectedRevision" >= 1
      AND "resultRevision" = "expectedRevision" + 1
    ),
    CONSTRAINT "script_alignment_reviews_hash_check" CHECK (
      "reviewHash" ~ '^[a-f0-9]{64}$'
      AND "resultRunHash" ~ '^[a-f0-9]{64}$'
      AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
    ),
    CONSTRAINT "script_alignment_reviews_json_check" CHECK (
      jsonb_typeof("decisionsJson"::jsonb) = 'array'
      AND jsonb_array_length("decisionsJson"::jsonb) BETWEEN 1 AND 500
      AND jsonb_typeof("resultRunJson"::jsonb) = 'object'
    )
);

CREATE INDEX "script_alignment_runs_workspaceId_batchId_createdAt_id_idx"
ON "script_alignment_runs"(
  "workspaceId",
  "batchId",
  "createdAt" DESC,
  "id" DESC
);

CREATE INDEX "script_alignment_runs_workspaceId_projectId_status_updatedA_idx"
ON "script_alignment_runs"(
  "workspaceId",
  "projectId",
  "status",
  "updatedAt" DESC
);

CREATE INDEX "script_alignment_runs_workspaceId_status_reviewRequiredCoun_idx"
ON "script_alignment_runs"(
  "workspaceId",
  "status",
  "reviewRequiredCount",
  "updatedAt" DESC
);

CREATE UNIQUE INDEX "script_alignment_runs_id_workspaceId_key"
ON "script_alignment_runs"("id", "workspaceId");

CREATE UNIQUE INDEX "script_alignment_runs_workspaceId_createdByClientId_idempot_key"
ON "script_alignment_runs"(
  "workspaceId",
  "createdByClientId",
  "idempotencyKey"
);

CREATE INDEX "script_alignment_reviews_workspaceId_runId_createdAt_idx"
ON "script_alignment_reviews"(
  "workspaceId",
  "runId",
  "createdAt" DESC
);

CREATE UNIQUE INDEX "script_alignment_reviews_workspaceId_actorClientId_idempote_key"
ON "script_alignment_reviews"(
  "workspaceId",
  "actorClientId",
  "idempotencyKey"
);

CREATE UNIQUE INDEX "script_alignment_reviews_runId_resultRevision_key"
ON "script_alignment_reviews"("runId", "resultRevision");

ALTER TABLE "script_alignment_runs"
ADD CONSTRAINT "script_alignment_runs_workspaceId_fkey"
FOREIGN KEY ("workspaceId")
REFERENCES "workspaces"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;

ALTER TABLE "script_alignment_runs"
ADD CONSTRAINT "script_alignment_runs_projectId_workspaceId_fkey"
FOREIGN KEY ("projectId", "workspaceId")
REFERENCES "projects"("id", "workspaceId")
ON DELETE CASCADE
ON UPDATE CASCADE;

ALTER TABLE "script_alignment_runs"
ADD CONSTRAINT "script_alignment_runs_batchId_workspaceId_fkey"
FOREIGN KEY ("batchId", "workspaceId")
REFERENCES "production_batches"("id", "workspaceId")
ON DELETE CASCADE
ON UPDATE CASCADE;

ALTER TABLE "script_alignment_runs"
ADD CONSTRAINT "script_alignment_runs_createdByClientId_workspaceId_fkey"
FOREIGN KEY ("createdByClientId", "workspaceId")
REFERENCES "api_clients"("id", "workspaceId")
ON DELETE RESTRICT
ON UPDATE CASCADE;

ALTER TABLE "script_alignment_reviews"
ADD CONSTRAINT "script_alignment_reviews_workspaceId_fkey"
FOREIGN KEY ("workspaceId")
REFERENCES "workspaces"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;

ALTER TABLE "script_alignment_reviews"
ADD CONSTRAINT "script_alignment_reviews_runId_workspaceId_fkey"
FOREIGN KEY ("runId", "workspaceId")
REFERENCES "script_alignment_runs"("id", "workspaceId")
ON DELETE CASCADE
ON UPDATE CASCADE;

ALTER TABLE "script_alignment_reviews"
ADD CONSTRAINT "script_alignment_reviews_actorClientId_workspaceId_fkey"
FOREIGN KEY ("actorClientId", "workspaceId")
REFERENCES "api_clients"("id", "workspaceId")
ON DELETE RESTRICT
ON UPDATE CASCADE;
