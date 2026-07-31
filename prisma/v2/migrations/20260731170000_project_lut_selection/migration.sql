CREATE TABLE "project_lut_selections" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "commandId" VARCHAR(128) NOT NULL,
  "baseVersionId" VARCHAR(128) NOT NULL,
  "resultVersionId" VARCHAR(128) NOT NULL,
  "requestedMode" VARCHAR(32) NOT NULL,
  "requestedLutId" VARCHAR(128),
  "requestedLutVersion" INTEGER,
  "resolvedMode" VARCHAR(16) NOT NULL,
  "resolvedLutVersionId" VARCHAR(128),
  "workspaceDefaultRevision" INTEGER,
  "intensity" DOUBLE PRECISION NOT NULL,
  "selectionJson" TEXT NOT NULL,
  "selectionHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "project_lut_selections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_lut_selections_requested_check" CHECK (("requestedMode" = 'none' AND "requestedLutId" IS NULL AND "requestedLutVersion" IS NULL AND "workspaceDefaultRevision" IS NULL) OR ("requestedMode" = 'workspace-default' AND "requestedLutId" IS NULL AND "requestedLutVersion" IS NULL AND "workspaceDefaultRevision" >= 0) OR ("requestedMode" = 'lut-version' AND "requestedLutId" IS NOT NULL AND "requestedLutVersion" > 0 AND "workspaceDefaultRevision" IS NULL)),
  CONSTRAINT "project_lut_selections_resolved_check" CHECK (("resolvedMode" = 'none' AND "resolvedLutVersionId" IS NULL) OR ("resolvedMode" = 'lut-version' AND "resolvedLutVersionId" IS NOT NULL)),
  CONSTRAINT "project_lut_selections_values_check" CHECK ("intensity" BETWEEN 0 AND 1 AND "selectionHash" ~ '^[a-f0-9]{64}$')
);

CREATE TABLE "project_lut_selection_heads" (
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "selectionId" VARCHAR(128) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "project_lut_selection_heads_pkey" PRIMARY KEY ("projectId", "workspaceId")
);

CREATE UNIQUE INDEX "project_lut_selections_id_workspaceId_key" ON "project_lut_selections"("id", "workspaceId");
CREATE UNIQUE INDEX "project_lut_selections_commandId_workspaceId_key" ON "project_lut_selections"("commandId", "workspaceId");
CREATE UNIQUE INDEX "project_lut_selections_resultVersionId_workspaceId_key" ON "project_lut_selections"("resultVersionId", "workspaceId");
CREATE INDEX "project_lut_selections_workspaceId_projectId_createdAt_idx" ON "project_lut_selections"("workspaceId", "projectId", "createdAt" DESC);
CREATE INDEX "project_lut_selections_workspaceId_resolvedLutVersionId_idx" ON "project_lut_selections"("workspaceId", "resolvedLutVersionId");
CREATE UNIQUE INDEX "project_lut_selection_heads_selectionId_workspaceId_key" ON "project_lut_selection_heads"("selectionId", "workspaceId");

ALTER TABLE "project_lut_selections" ADD CONSTRAINT "project_lut_selections_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_lut_selections" ADD CONSTRAINT "project_lut_selections_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_lut_selections" ADD CONSTRAINT "project_lut_selections_commandId_workspaceId_fkey" FOREIGN KEY ("commandId", "workspaceId") REFERENCES "edit_commands"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_lut_selections" ADD CONSTRAINT "project_lut_selections_baseVersionId_workspaceId_fkey" FOREIGN KEY ("baseVersionId", "workspaceId") REFERENCES "project_versions"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_lut_selections" ADD CONSTRAINT "project_lut_selections_resultVersionId_workspaceId_fkey" FOREIGN KEY ("resultVersionId", "workspaceId") REFERENCES "project_versions"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_lut_selections" ADD CONSTRAINT "project_lut_selections_resolvedLutVersionId_workspaceId_fkey" FOREIGN KEY ("resolvedLutVersionId", "workspaceId") REFERENCES "workspace_lut_versions"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_lut_selection_heads" ADD CONSTRAINT "project_lut_selection_heads_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_lut_selection_heads" ADD CONSTRAINT "project_lut_selection_heads_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_lut_selection_heads" ADD CONSTRAINT "project_lut_selection_heads_selectionId_workspaceId_fkey" FOREIGN KEY ("selectionId", "workspaceId") REFERENCES "project_lut_selections"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
