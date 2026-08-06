ALTER TABLE "director_runs"
  ADD COLUMN "objective" VARCHAR(64),
  ADD COLUMN "objectiveVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "rubricRef" VARCHAR(128),
  ADD COLUMN "supersedesRunId" VARCHAR(128);

UPDATE "director_runs" AS run
SET
  "objective" = project."objective",
  "rubricRef" = CASE project."objective"
    WHEN 'discovery' THEN 'awareness-discovery/v1'
    WHEN 'awareness' THEN 'awareness-level/v1'
    WHEN 'warming' THEN 'awareness-warming/v1'
    WHEN 'lead-generation' THEN 'conversion-lead/v1'
    WHEN 'sale' THEN 'conversion-sale/v1'
    WHEN 'whatsapp' THEN 'conversion-whatsapp/v1'
    WHEN 'booking' THEN 'conversion-booking/v1'
    WHEN 'download' THEN 'conversion-download/v1'
  END
FROM "projects" AS project
WHERE project."id" = run."projectId"
  AND project."workspaceId" = run."workspaceId";

ALTER TABLE "director_runs"
  ALTER COLUMN "objective" SET NOT NULL,
  ALTER COLUMN "rubricRef" SET NOT NULL,
  ALTER COLUMN "objectiveVersion" DROP DEFAULT;

ALTER TABLE "project_director_operations"
  ADD COLUMN "baseObjective" VARCHAR(64),
  ADD COLUMN "objective" VARCHAR(64),
  ADD COLUMN "objectiveVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "rubricRef" VARCHAR(128),
  ADD COLUMN "supersedesRunId" VARCHAR(128),
  ADD COLUMN "destination" VARCHAR(2048);

UPDATE "project_director_operations" AS operation
SET
  "baseObjective" = project."objective",
  "objective" = project."objective",
  "rubricRef" = CASE project."objective"
    WHEN 'discovery' THEN 'awareness-discovery/v1'
    WHEN 'awareness' THEN 'awareness-level/v1'
    WHEN 'warming' THEN 'awareness-warming/v1'
    WHEN 'lead-generation' THEN 'conversion-lead/v1'
    WHEN 'sale' THEN 'conversion-sale/v1'
    WHEN 'whatsapp' THEN 'conversion-whatsapp/v1'
    WHEN 'booking' THEN 'conversion-booking/v1'
    WHEN 'download' THEN 'conversion-download/v1'
  END
FROM "projects" AS project
WHERE project."id" = operation."projectId"
  AND project."workspaceId" = operation."workspaceId";

ALTER TABLE "project_director_operations"
  ALTER COLUMN "baseObjective" SET NOT NULL,
  ALTER COLUMN "objective" SET NOT NULL,
  ALTER COLUMN "rubricRef" SET NOT NULL,
  ALTER COLUMN "objectiveVersion" DROP DEFAULT;

ALTER TABLE "director_runs"
  ADD CONSTRAINT "director_runs_objective_binding_check" CHECK (
    "objectiveVersion" >= 1
    AND "objective" IN ('discovery', 'awareness', 'warming', 'lead-generation', 'sale', 'whatsapp', 'booking', 'download')
    AND (
      ("objective" = 'discovery' AND "rubricRef" = 'awareness-discovery/v1')
      OR ("objective" = 'awareness' AND "rubricRef" = 'awareness-level/v1')
      OR ("objective" = 'warming' AND "rubricRef" = 'awareness-warming/v1')
      OR ("objective" = 'lead-generation' AND "rubricRef" = 'conversion-lead/v1')
      OR ("objective" = 'sale' AND "rubricRef" = 'conversion-sale/v1')
      OR ("objective" = 'whatsapp' AND "rubricRef" = 'conversion-whatsapp/v1')
      OR ("objective" = 'booking' AND "rubricRef" = 'conversion-booking/v1')
      OR ("objective" = 'download' AND "rubricRef" = 'conversion-download/v1')
    )
    AND ("supersedesRunId" IS NULL OR "supersedesRunId" <> "id")
  );

ALTER TABLE "project_director_operations"
  ADD CONSTRAINT "project_director_operations_objective_binding_check" CHECK (
    "objectiveVersion" >= 1
    AND "baseObjective" IN ('discovery', 'awareness', 'warming', 'lead-generation', 'sale', 'whatsapp', 'booking', 'download')
    AND "objective" IN ('discovery', 'awareness', 'warming', 'lead-generation', 'sale', 'whatsapp', 'booking', 'download')
    AND (
      ("objective" = 'discovery' AND "rubricRef" = 'awareness-discovery/v1')
      OR ("objective" = 'awareness' AND "rubricRef" = 'awareness-level/v1')
      OR ("objective" = 'warming' AND "rubricRef" = 'awareness-warming/v1')
      OR ("objective" = 'lead-generation' AND "rubricRef" = 'conversion-lead/v1')
      OR ("objective" = 'sale' AND "rubricRef" = 'conversion-sale/v1')
      OR ("objective" = 'whatsapp' AND "rubricRef" = 'conversion-whatsapp/v1')
      OR ("objective" = 'booking' AND "rubricRef" = 'conversion-booking/v1')
      OR ("objective" = 'download' AND "rubricRef" = 'conversion-download/v1')
    )
    AND ("destination" IS NULL OR length(btrim("destination")) BETWEEN 1 AND 2048)
  );

ALTER TABLE "director_runs"
  ADD CONSTRAINT "director_runs_supersedesRunId_projectId_workspaceId_fkey"
  FOREIGN KEY ("supersedesRunId", "projectId", "workspaceId")
  REFERENCES "director_runs"("id", "projectId", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_director_operations"
  ADD CONSTRAINT "project_director_ops_supersedes_run_fkey"
  FOREIGN KEY ("supersedesRunId", "projectId", "workspaceId")
  REFERENCES "director_runs"("id", "projectId", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "director_runs_objective_revision_idx"
  ON "director_runs"("workspaceId", "projectId", "objective", "objectiveVersion");
