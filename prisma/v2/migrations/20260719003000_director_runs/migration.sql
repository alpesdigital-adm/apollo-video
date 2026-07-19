ALTER TABLE "project_versions"
  ADD COLUMN "treatmentSnapshotId" VARCHAR(128),
  ADD COLUMN "storySnapshotId" VARCHAR(128);

ALTER TABLE "project_versions"
  ADD CONSTRAINT "project_versions_treatmentSnapshotId_fkey" FOREIGN KEY ("treatmentSnapshotId") REFERENCES "project_snapshots"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_versions"
  ADD CONSTRAINT "project_versions_storySnapshotId_fkey" FOREIGN KEY ("storySnapshotId") REFERENCES "project_snapshots"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "project_versions_treatmentSnapshotId_idx"
  ON "project_versions"("treatmentSnapshotId");

CREATE INDEX "project_versions_storySnapshotId_idx"
  ON "project_versions"("storySnapshotId");

CREATE TABLE "director_runs" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "commandId" VARCHAR(128) NOT NULL,
  "baseVersionId" VARCHAR(128) NOT NULL,
  "resultVersionId" VARCHAR(128) NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "plannerVersion" VARCHAR(64) NOT NULL,
  "criticVersion" VARCHAR(64) NOT NULL,
  "perceptionSnapshotId" VARCHAR(128) NOT NULL,
  "treatmentSnapshotId" VARCHAR(128) NOT NULL,
  "storySnapshotId" VARCHAR(128) NOT NULL,
  "editPlanSnapshotId" VARCHAR(128) NOT NULL,
  "qualitySnapshotId" VARCHAR(128) NOT NULL,
  "decisionsJson" TEXT NOT NULL,
  "assumptionsJson" TEXT NOT NULL,
  "initiatedByType" VARCHAR(32) NOT NULL,
  "initiatedById" VARCHAR(128) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "director_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "director_runs_status_check"
    CHECK ("status" IN ('planned', 'rendering', 'succeeded', 'failed')),
  CONSTRAINT "director_runs_decisions_json_check"
    CHECK (jsonb_typeof("decisionsJson"::jsonb) = 'array'),
  CONSTRAINT "director_runs_assumptions_json_check"
    CHECK (jsonb_typeof("assumptionsJson"::jsonb) = 'array')
);

CREATE UNIQUE INDEX "director_runs_id_workspaceId_key"
  ON "director_runs"("id", "workspaceId");

CREATE UNIQUE INDEX "director_runs_commandId_workspaceId_key"
  ON "director_runs"("commandId", "workspaceId");

CREATE UNIQUE INDEX "director_runs_resultVersionId_workspaceId_key"
  ON "director_runs"("resultVersionId", "workspaceId");

CREATE INDEX "director_runs_workspaceId_projectId_createdAt_idx"
  ON "director_runs"("workspaceId", "projectId", "createdAt" DESC);

CREATE INDEX "director_runs_workspaceId_status_updatedAt_idx"
  ON "director_runs"("workspaceId", "status", "updatedAt" DESC);

ALTER TABLE "director_runs"
  ADD CONSTRAINT "director_runs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "director_runs"
  ADD CONSTRAINT "director_runs_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "director_runs"
  ADD CONSTRAINT "director_runs_commandId_workspaceId_fkey" FOREIGN KEY ("commandId", "workspaceId") REFERENCES "edit_commands"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "director_runs"
  ADD CONSTRAINT "director_runs_baseVersionId_workspaceId_fkey" FOREIGN KEY ("baseVersionId", "workspaceId") REFERENCES "project_versions"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "director_runs"
  ADD CONSTRAINT "director_runs_resultVersionId_workspaceId_fkey" FOREIGN KEY ("resultVersionId", "workspaceId") REFERENCES "project_versions"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "director_runs"
  ADD CONSTRAINT "director_runs_perceptionSnapshotId_fkey" FOREIGN KEY ("perceptionSnapshotId") REFERENCES "project_snapshots"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "director_runs"
  ADD CONSTRAINT "director_runs_treatmentSnapshotId_fkey" FOREIGN KEY ("treatmentSnapshotId") REFERENCES "project_snapshots"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "director_runs"
  ADD CONSTRAINT "director_runs_storySnapshotId_fkey" FOREIGN KEY ("storySnapshotId") REFERENCES "project_snapshots"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "director_runs"
  ADD CONSTRAINT "director_runs_editPlanSnapshotId_fkey" FOREIGN KEY ("editPlanSnapshotId") REFERENCES "project_snapshots"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "director_runs"
  ADD CONSTRAINT "director_runs_qualitySnapshotId_fkey" FOREIGN KEY ("qualitySnapshotId") REFERENCES "project_snapshots"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
