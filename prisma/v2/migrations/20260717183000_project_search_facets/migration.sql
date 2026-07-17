ALTER TABLE "projects"
  ADD COLUMN "objective" VARCHAR(64),
  ADD COLUMN "format" VARCHAR(16),
  ADD COLUMN "locale" VARCHAR(35),
  ADD COLUMN "ownerId" VARCHAR(128);

CREATE INDEX "projects_workspaceId_objective_idx" ON "projects"("workspaceId", "objective");
CREATE INDEX "projects_workspaceId_format_idx" ON "projects"("workspaceId", "format");
CREATE INDEX "projects_workspaceId_locale_idx" ON "projects"("workspaceId", "locale");
CREATE INDEX "projects_workspaceId_ownerId_idx" ON "projects"("workspaceId", "ownerId");
