ALTER TABLE "public_operations"
  DROP CONSTRAINT "public_operations_type_check",
  DROP CONSTRAINT "public_operations_phase_check",
  DROP CONSTRAINT "public_operations_target_check",
  DROP CONSTRAINT "public_operations_project_scope_check";

ALTER TABLE "public_operations"
  ADD CONSTRAINT "public_operations_type_check"
  CHECK (
    "type" IN (
      'artifact-render',
      'media-ingest',
      'project-proxy-render',
      'project-final-export',
      'source-cleanup',
      'long-form-index',
      'project-director-run'
    )
  ),
  ADD CONSTRAINT "public_operations_phase_check"
  CHECK (
    "phase" IN (
      'queued',
      'materializing',
      'rendering',
      'assembling',
      'probing',
      'normalizing',
      'transcribing',
      'diarizing',
      'chunking',
      'indexing',
      'directing',
      'verifying',
      'persisting',
      'waiting',
      'retrying',
      'completed',
      'failed',
      'canceled'
    )
  ),
  ADD CONSTRAINT "public_operations_target_check"
  CHECK ("targetType" IN ('media-artifact', 'project-version')),
  ADD CONSTRAINT "public_operations_type_target_check"
  CHECK (
    ("type" = 'project-director-run' AND "targetType" = 'project-version')
    OR
    ("type" <> 'project-director-run' AND "targetType" = 'media-artifact')
  ),
  ADD CONSTRAINT "public_operations_project_scope_check"
  CHECK (
    ("type" = 'artifact-render' AND "projectId" IS NULL)
    OR
    (
      "type" IN (
        'media-ingest',
        'project-proxy-render',
        'project-final-export',
        'source-cleanup',
        'long-form-index',
        'project-director-run'
      )
      AND "projectId" IS NOT NULL
    )
  );

CREATE TABLE "project_director_operations" (
  "operationId" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "baseVersionId" VARCHAR(128) NOT NULL,
  "baseHash" CHAR(64) NOT NULL,
  "resultVersionId" VARCHAR(128) NOT NULL,
  "delegatedUserId" VARCHAR(128),
  "reason" VARCHAR(1000),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "project_director_operations_pkey" PRIMARY KEY ("operationId"),
  CONSTRAINT "project_director_operations_base_hash_check"
    CHECK ("baseHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "project_director_operations_reason_check"
    CHECK ("reason" IS NULL OR length(btrim("reason")) BETWEEN 1 AND 1000)
);

CREATE UNIQUE INDEX "project_director_operations_operationId_workspaceId_key"
  ON "project_director_operations"("operationId", "workspaceId");
CREATE UNIQUE INDEX "project_director_operations_workspaceId_projectId_resultVer_key"
  ON "project_director_operations"("workspaceId", "projectId", "resultVersionId");
CREATE INDEX "project_director_operations_workspaceId_projectId_createdAt_idx"
  ON "project_director_operations"("workspaceId", "projectId", "createdAt" DESC);

ALTER TABLE "project_director_operations"
  ADD CONSTRAINT "project_director_operations_operationId_workspaceId_fkey"
    FOREIGN KEY ("operationId", "workspaceId")
    REFERENCES "public_operations"("id", "workspaceId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "project_director_operations_projectId_workspaceId_fkey"
    FOREIGN KEY ("projectId", "workspaceId")
    REFERENCES "projects"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_director_operations_baseVersionId_projectId_worksp_fkey"
    FOREIGN KEY ("baseVersionId", "projectId", "workspaceId")
    REFERENCES "project_versions"("id", "projectId", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "director_runs"
  ADD COLUMN "operationId" VARCHAR(128);

CREATE UNIQUE INDEX "director_runs_operationId_workspaceId_key"
  ON "director_runs"("operationId", "workspaceId");

ALTER TABLE "director_runs"
  ADD CONSTRAINT "director_runs_operationId_workspaceId_fkey"
  FOREIGN KEY ("operationId", "workspaceId")
  REFERENCES "project_director_operations"("operationId", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
