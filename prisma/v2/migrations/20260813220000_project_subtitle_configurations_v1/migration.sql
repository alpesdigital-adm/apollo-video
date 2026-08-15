CREATE TABLE "project_subtitle_configurations" (
  "id" VARCHAR(128) PRIMARY KEY,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "commandId" VARCHAR(128) NOT NULL,
  "baseVersionId" VARCHAR(128) NOT NULL,
  "resultVersionId" VARCHAR(128) NOT NULL,
  "variantId" VARCHAR(128) NOT NULL,
  "action" VARCHAR(16) NOT NULL,
  "previousConfigurationId" VARCHAR(128),
  "requestedMode" VARCHAR(32) NOT NULL,
  "resolvedPresetId" VARCHAR(64),
  "resolvedPresetHash" CHAR(64),
  "origin" VARCHAR(16) NOT NULL,
  "transcriptHash" CHAR(64) NOT NULL,
  "workspaceDefaultRevision" INTEGER,
  "configurationJson" TEXT NOT NULL,
  "configurationHash" CHAR(64) NOT NULL,
  "impactJson" TEXT NOT NULL,
  "impactHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "project_subtitle_configurations_mode_check" CHECK ("requestedMode" IN ('auto','workspace-default','manual','none')),
  CONSTRAINT "project_subtitle_configurations_origin_check" CHECK ("origin" IN ('director','workspace','project','disabled')),
  CONSTRAINT "project_subtitle_configurations_action_check" CHECK ("action" IN ('set','revert')),
  CONSTRAINT "project_subtitle_configurations_revert_check" CHECK ("action" <> 'revert' OR "previousConfigurationId" IS NOT NULL),
  CONSTRAINT "project_subtitle_configurations_chain_check" CHECK ("previousConfigurationId" IS NULL OR "previousConfigurationId" <> "id"),
  CONSTRAINT "project_subtitle_configurations_resolution_check" CHECK (("requestedMode" = 'none' AND "resolvedPresetId" IS NULL AND "resolvedPresetHash" IS NULL AND "origin" = 'disabled') OR ("requestedMode" <> 'none' AND "resolvedPresetId" IS NOT NULL AND "resolvedPresetHash" IS NOT NULL AND "origin" <> 'disabled')),
  CONSTRAINT "project_subtitle_configurations_workspace_revision_check" CHECK (("requestedMode" = 'workspace-default' AND "workspaceDefaultRevision" >= 0) OR ("requestedMode" <> 'workspace-default' AND "workspaceDefaultRevision" IS NULL))
);
CREATE UNIQUE INDEX "project_subtitle_configurations_id_workspaceId_key" ON "project_subtitle_configurations"("id","workspaceId");
CREATE UNIQUE INDEX "project_subtitle_configurations_commandId_workspaceId_key" ON "project_subtitle_configurations"("commandId","workspaceId");
CREATE UNIQUE INDEX "project_subtitle_configurations_resultVersionId_workspaceId_key" ON "project_subtitle_configurations"("resultVersionId","workspaceId");
CREATE UNIQUE INDEX "project_subtitle_configurations_previousConfigurationId_wor_key" ON "project_subtitle_configurations"("previousConfigurationId","workspaceId");
CREATE INDEX "project_subtitle_configurations_workspaceId_projectId_varia_idx" ON "project_subtitle_configurations"("workspaceId","projectId","variantId","createdAt" DESC);

CREATE TABLE "project_subtitle_configuration_heads" (
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "variantId" VARCHAR(128) NOT NULL,
  "configurationId" VARCHAR(128) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "project_subtitle_configuration_heads_pkey" PRIMARY KEY ("projectId","workspaceId","variantId")
);
CREATE UNIQUE INDEX "project_subtitle_configuration_heads_configurationId_worksp_key" ON "project_subtitle_configuration_heads"("configurationId","workspaceId");
ALTER TABLE "project_subtitle_configurations" ADD CONSTRAINT "project_subtitle_configurations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_subtitle_configurations" ADD CONSTRAINT "project_subtitle_configurations_projectId_workspaceId_fkey" FOREIGN KEY ("projectId","workspaceId") REFERENCES "projects"("id","workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_subtitle_configurations" ADD CONSTRAINT "project_subtitle_configurations_commandId_workspaceId_fkey" FOREIGN KEY ("commandId","workspaceId") REFERENCES "edit_commands"("id","workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_subtitle_configurations" ADD CONSTRAINT "project_subtitle_configurations_baseVersionId_workspaceId_fkey" FOREIGN KEY ("baseVersionId","workspaceId") REFERENCES "project_versions"("id","workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_subtitle_configurations" ADD CONSTRAINT "project_subtitle_configurations_resultVersionId_workspaceI_fkey" FOREIGN KEY ("resultVersionId","workspaceId") REFERENCES "project_versions"("id","workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_subtitle_configurations" ADD CONSTRAINT "project_subtitle_configurations_previousConfigurationId_wo_fkey" FOREIGN KEY ("previousConfigurationId","workspaceId") REFERENCES "project_subtitle_configurations"("id","workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_subtitle_configuration_heads" ADD CONSTRAINT "project_subtitle_configuration_heads_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_subtitle_configuration_heads" ADD CONSTRAINT "project_subtitle_configuration_heads_projectId_workspaceId_fkey" FOREIGN KEY ("projectId","workspaceId") REFERENCES "projects"("id","workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_subtitle_configuration_heads" ADD CONSTRAINT "project_subtitle_configuration_heads_configurationId_works_fkey" FOREIGN KEY ("configurationId","workspaceId") REFERENCES "project_subtitle_configurations"("id","workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The canonical EditCommand registry gained `set-project-subtitle-mode`; the closed
-- PostgreSQL constraint has to say exactly the same thing as
-- src/v2/domain/edit-command-registry.ts, and tests/v2/edit-command-registry.test.mjs
-- compares the two.
ALTER TABLE "edit_commands"
  DROP CONSTRAINT "edit_commands_type_check";

ALTER TABLE "edit_commands"
  ADD CONSTRAINT "edit_commands_type_check"
  CHECK ("type" IN (
      'remove-spoken-content',
      'run-director',
      'apply-review-patch',
      'apply-review-patch-batch',
      'manual-edit',
      'compare-action',
      'replace-source-transcript',
      'set-project-lut-selection',
      'set-project-policy-overrides',
      'set-project-subtitle-mode'
    ));
