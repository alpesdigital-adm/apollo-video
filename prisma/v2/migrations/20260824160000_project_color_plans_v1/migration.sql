CREATE TABLE "project_color_plans" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "commandId" VARCHAR(128) NOT NULL,
  "baseVersionId" VARCHAR(128) NOT NULL,
  "resultVersionId" VARCHAR(128) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "planJson" TEXT NOT NULL,
  "planHash" CHAR(64) NOT NULL,
  "compiledManifestJson" TEXT NOT NULL,
  "compiledManifestHash" CHAR(64) NOT NULL,
  "recordJson" TEXT NOT NULL,
  "recordHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "project_color_plans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_color_plans_plan_json_check" CHECK (jsonb_typeof("planJson"::jsonb) = 'object'),
  CONSTRAINT "project_color_plans_compiled_json_check" CHECK (jsonb_typeof("compiledManifestJson"::jsonb) = 'object'),
  CONSTRAINT "project_color_plans_record_json_check" CHECK (jsonb_typeof("recordJson"::jsonb) = 'object')
);

CREATE TABLE "project_color_plan_heads" (
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "colorPlanId" VARCHAR(128) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "project_color_plan_heads_pkey" PRIMARY KEY ("projectId", "workspaceId")
);

CREATE UNIQUE INDEX "project_color_plans_id_workspaceId_key" ON "project_color_plans"("id", "workspaceId");
CREATE UNIQUE INDEX "project_color_plans_commandId_workspaceId_key" ON "project_color_plans"("commandId", "workspaceId");
CREATE UNIQUE INDEX "project_color_plans_resultVersionId_workspaceId_key" ON "project_color_plans"("resultVersionId", "workspaceId");
CREATE UNIQUE INDEX "project_color_plans_workspaceId_recordHash_key" ON "project_color_plans"("workspaceId", "recordHash");
CREATE INDEX "project_color_plans_workspaceId_projectId_createdAt_idx" ON "project_color_plans"("workspaceId", "projectId", "createdAt" DESC);
CREATE INDEX "project_color_plans_workspaceId_planHash_idx" ON "project_color_plans"("workspaceId", "planHash");
CREATE INDEX "project_color_plans_workspaceId_compiledManifestHash_idx" ON "project_color_plans"("workspaceId", "compiledManifestHash");
CREATE UNIQUE INDEX "project_color_plan_heads_colorPlanId_workspaceId_key" ON "project_color_plan_heads"("colorPlanId", "workspaceId");

ALTER TABLE "project_color_plans" ADD CONSTRAINT "project_color_plans_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_color_plans" ADD CONSTRAINT "project_color_plans_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_color_plans" ADD CONSTRAINT "project_color_plans_commandId_workspaceId_fkey" FOREIGN KEY ("commandId", "workspaceId") REFERENCES "edit_commands"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_color_plans" ADD CONSTRAINT "project_color_plans_baseVersionId_workspaceId_fkey" FOREIGN KEY ("baseVersionId", "workspaceId") REFERENCES "project_versions"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_color_plans" ADD CONSTRAINT "project_color_plans_resultVersionId_workspaceId_fkey" FOREIGN KEY ("resultVersionId", "workspaceId") REFERENCES "project_versions"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_color_plan_heads" ADD CONSTRAINT "project_color_plan_heads_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_color_plan_heads" ADD CONSTRAINT "project_color_plan_heads_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_color_plan_heads" ADD CONSTRAINT "project_color_plan_heads_colorPlanId_workspaceId_fkey" FOREIGN KEY ("colorPlanId", "workspaceId") REFERENCES "project_color_plans"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "edit_commands" DROP CONSTRAINT "edit_commands_type_check";
ALTER TABLE "edit_commands" ADD CONSTRAINT "edit_commands_type_check" CHECK ("type" IN (
  'apply-review-patch',
  'apply-review-patch-batch',
  'apply-subtitle-segment-override',
  'compare-action',
  'manual-edit',
  'remove-spoken-content',
  'replace-source-transcript',
  'run-director',
  'set-project-color-plan',
  'set-project-lut-selection',
  'set-project-policy-overrides',
  'set-project-subtitle-mode'
));
