ALTER TABLE "director_runs"
  ADD COLUMN "decisionLogJson" TEXT,
  ADD COLUMN "decisionLogHash" CHAR(64);

ALTER TABLE "director_runs"
  ADD CONSTRAINT "director_runs_decision_log_pair_chk"
  CHECK (("decisionLogJson" IS NULL) = ("decisionLogHash" IS NULL));

CREATE INDEX "director_runs_workspace_project_decision_log_idx"
  ON "director_runs" ("workspaceId", "projectId", "createdAt" DESC)
  WHERE "decisionLogHash" IS NOT NULL;
