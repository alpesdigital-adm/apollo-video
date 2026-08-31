CREATE TABLE "transformation_briefs" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "projectVersionId" VARCHAR(128) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "storyPlanId" VARCHAR(128) NOT NULL,
  "storyPlanHash" CHAR(64) NOT NULL,
  "sourceArtifactId" VARCHAR(128) NOT NULL,
  "sourceArtifactHash" CHAR(64) NOT NULL,
  "sourceStartFrame" INTEGER NOT NULL,
  "sourceEndFrame" INTEGER NOT NULL,
  "mode" VARCHAR(64) NOT NULL,
  "intent" VARCHAR(64) NOT NULL,
  "rightsSnapshotId" VARCHAR(128) NOT NULL,
  "rightsSnapshotHash" CHAR(64) NOT NULL,
  "identitySnapshotId" VARCHAR(128),
  "identitySnapshotHash" CHAR(64),
  "briefJson" TEXT NOT NULL,
  "briefHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "transformation_briefs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transformation_briefs_range_check" CHECK ("sourceStartFrame" >= 0 AND "sourceEndFrame" > "sourceStartFrame"),
  CONSTRAINT "transformation_briefs_identity_pair_check" CHECK (("identitySnapshotId" IS NULL) = ("identitySnapshotHash" IS NULL)),
  CONSTRAINT "transformation_briefs_schema_check" CHECK ("schemaVersion" = 'transformation-brief/v1'),
  CONSTRAINT "transformation_briefs_mode_check" CHECK ("mode" IN ('background-replacement','stylization','cutaway','camera-motion','relight','object-environment-change'))
);

CREATE UNIQUE INDEX "transformation_briefs_id_workspaceId_key" ON "transformation_briefs"("id", "workspaceId");
CREATE UNIQUE INDEX "transformation_briefs_workspaceId_projectId_briefHash_key" ON "transformation_briefs"("workspaceId", "projectId", "briefHash");
CREATE INDEX "transformation_briefs_workspaceId_projectId_createdAt_id_idx" ON "transformation_briefs"("workspaceId", "projectId", "createdAt" DESC, "id" DESC);
CREATE INDEX "transformation_briefs_workspaceId_projectVersionId_idx" ON "transformation_briefs"("workspaceId", "projectVersionId");
CREATE INDEX "transformation_briefs_workspaceId_mode_createdAt_idx" ON "transformation_briefs"("workspaceId", "mode", "createdAt" DESC);

CREATE TABLE "transformation_provider_definitions" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "displayName" VARCHAR(120) NOT NULL,
  "adapterId" VARCHAR(128) NOT NULL,
  "adapterVersion" VARCHAR(128) NOT NULL,
  "transport" VARCHAR(16) NOT NULL,
  "credentialRef" VARCHAR(128) NOT NULL,
  "enabled" BOOLEAN NOT NULL,
  "definitionHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "transformation_provider_definitions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transformation_provider_definitions_schema_check" CHECK ("schemaVersion" = 'transformation-provider-definition/v1'),
  CONSTRAINT "transformation_provider_definitions_transport_check" CHECK ("transport" IN ('api','mcp')),
  CONSTRAINT "transformation_provider_definitions_time_check" CHECK ("updatedAt" >= "createdAt")
);

CREATE UNIQUE INDEX "transformation_provider_definitions_id_workspaceId_key" ON "transformation_provider_definitions"("id", "workspaceId");
CREATE UNIQUE INDEX "transformation_provider_definitions_workspaceId_adapterId_a_key" ON "transformation_provider_definitions"("workspaceId", "adapterId", "adapterVersion");
CREATE INDEX "transformation_provider_definitions_workspaceId_enabled_upd_idx" ON "transformation_provider_definitions"("workspaceId", "enabled", "updatedAt" DESC);

CREATE TABLE "transformation_provider_capabilities" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "providerId" VARCHAR(128) NOT NULL,
  "operation" VARCHAR(64) NOT NULL,
  "capabilityVersion" VARCHAR(64) NOT NULL,
  "modesJson" TEXT NOT NULL,
  "regionsJson" TEXT NOT NULL,
  "maximumDurationFrames" INTEGER NOT NULL,
  "maximumWidth" INTEGER NOT NULL,
  "maximumHeight" INTEGER NOT NULL,
  "supportsAudio" BOOLEAN NOT NULL,
  "priceCurrency" CHAR(3) NOT NULL,
  "fixedMinorUnits" INTEGER NOT NULL,
  "perSecondMinorUnits" INTEGER NOT NULL,
  "qualityScoreBps" INTEGER NOT NULL,
  "dataRetention" VARCHAR(32) NOT NULL,
  "capabilityHash" CHAR(64) NOT NULL,
  CONSTRAINT "transformation_provider_capabilities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transformation_provider_capabilities_limits_check" CHECK ("maximumDurationFrames" > 0 AND "maximumWidth" > 0 AND "maximumHeight" > 0),
  CONSTRAINT "transformation_provider_capabilities_price_check" CHECK ("fixedMinorUnits" >= 0 AND "perSecondMinorUnits" >= 0),
  CONSTRAINT "transformation_provider_capabilities_quality_check" CHECK ("qualityScoreBps" BETWEEN 0 AND 10000),
  CONSTRAINT "transformation_provider_capabilities_retention_check" CHECK ("dataRetention" IN ('none','transient','provider-policy'))
);

CREATE UNIQUE INDEX "transformation_provider_capabilities_id_workspaceId_provide_key" ON "transformation_provider_capabilities"("id", "workspaceId", "providerId");
CREATE UNIQUE INDEX "transformation_provider_capabilities_providerId_operation_c_key" ON "transformation_provider_capabilities"("providerId", "operation", "capabilityVersion");
CREATE INDEX "transformation_provider_capabilities_workspaceId_operation_idx" ON "transformation_provider_capabilities"("workspaceId", "operation");

CREATE TABLE "transformation_provider_health" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "providerId" VARCHAR(128) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "circuitState" VARCHAR(16) NOT NULL,
  "consecutiveFailures" INTEGER NOT NULL,
  "observedLatencyMs" INTEGER,
  "cooldownUntil" TIMESTAMPTZ(3),
  "observedAt" TIMESTAMPTZ(3) NOT NULL,
  "healthHash" CHAR(64) NOT NULL,
  CONSTRAINT "transformation_provider_health_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transformation_provider_health_schema_check" CHECK ("schemaVersion" = 'transformation-provider-health/v1'),
  CONSTRAINT "transformation_provider_health_status_check" CHECK ("status" IN ('healthy','degraded','unavailable')),
  CONSTRAINT "transformation_provider_health_circuit_check" CHECK ("circuitState" IN ('closed','open','half-open')),
  CONSTRAINT "transformation_provider_health_values_check" CHECK ("consecutiveFailures" >= 0 AND ("observedLatencyMs" IS NULL OR "observedLatencyMs" >= 0)),
  CONSTRAINT "transformation_provider_health_open_check" CHECK ("circuitState" <> 'open' OR "cooldownUntil" IS NOT NULL)
);

CREATE UNIQUE INDEX "transformation_provider_health_providerId_observedAt_key" ON "transformation_provider_health"("providerId", "observedAt");
CREATE INDEX "transformation_provider_health_workspaceId_providerId_obser_idx" ON "transformation_provider_health"("workspaceId", "providerId", "observedAt" DESC);
CREATE INDEX "transformation_provider_health_workspaceId_status_circuitSt_idx" ON "transformation_provider_health"("workspaceId", "status", "circuitState", "observedAt" DESC);

CREATE TABLE "transformation_provider_selections" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "projectVersionId" VARCHAR(128) NOT NULL,
  "briefId" VARCHAR(128) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "briefHash" CHAR(64) NOT NULL,
  "selectedProviderId" VARCHAR(128),
  "selectedCapabilityId" VARCHAR(128),
  "policyJson" TEXT NOT NULL,
  "candidatesJson" TEXT NOT NULL,
  "selectedReason" VARCHAR(300) NOT NULL,
  "selectionHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "transformation_provider_selections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "transformation_provider_selections_schema_check" CHECK ("schemaVersion" = 'transformation-provider-selection/v1'),
  CONSTRAINT "transformation_provider_selections_selected_pair_check" CHECK (("selectedProviderId" IS NULL) = ("selectedCapabilityId" IS NULL))
);

CREATE UNIQUE INDEX "transformation_provider_selections_id_workspaceId_key" ON "transformation_provider_selections"("id", "workspaceId");
CREATE UNIQUE INDEX "transformation_provider_selections_workspaceId_projectId_se_key" ON "transformation_provider_selections"("workspaceId", "projectId", "selectionHash");
CREATE INDEX "transformation_provider_selections_workspaceId_projectId_cr_idx" ON "transformation_provider_selections"("workspaceId", "projectId", "createdAt" DESC, "id" DESC);
CREATE INDEX "transformation_provider_selections_workspaceId_selectedProv_idx" ON "transformation_provider_selections"("workspaceId", "selectedProviderId", "createdAt" DESC);

ALTER TABLE "transformation_briefs" ADD CONSTRAINT "transformation_briefs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transformation_briefs" ADD CONSTRAINT "transformation_briefs_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "transformation_briefs" ADD CONSTRAINT "transformation_briefs_projectVersionId_projectId_workspace_fkey" FOREIGN KEY ("projectVersionId", "projectId", "workspaceId") REFERENCES "project_versions"("id", "projectId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transformation_provider_definitions" ADD CONSTRAINT "transformation_provider_definitions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transformation_provider_capabilities" ADD CONSTRAINT "transformation_provider_capabilities_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transformation_provider_capabilities" ADD CONSTRAINT "transformation_provider_capabilities_providerId_workspaceI_fkey" FOREIGN KEY ("providerId", "workspaceId") REFERENCES "transformation_provider_definitions"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "transformation_provider_health" ADD CONSTRAINT "transformation_provider_health_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transformation_provider_health" ADD CONSTRAINT "transformation_provider_health_providerId_workspaceId_fkey" FOREIGN KEY ("providerId", "workspaceId") REFERENCES "transformation_provider_definitions"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "transformation_provider_selections" ADD CONSTRAINT "transformation_provider_selections_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transformation_provider_selections" ADD CONSTRAINT "transformation_provider_selections_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "transformation_provider_selections" ADD CONSTRAINT "transformation_provider_selections_projectVersionId_projec_fkey" FOREIGN KEY ("projectVersionId", "projectId", "workspaceId") REFERENCES "project_versions"("id", "projectId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transformation_provider_selections" ADD CONSTRAINT "transformation_provider_selections_briefId_workspaceId_fkey" FOREIGN KEY ("briefId", "workspaceId") REFERENCES "transformation_briefs"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transformation_provider_selections" ADD CONSTRAINT "transformation_provider_selections_selectedProviderId_work_fkey" FOREIGN KEY ("selectedProviderId", "workspaceId") REFERENCES "transformation_provider_definitions"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transformation_provider_selections" ADD CONSTRAINT "transformation_provider_selections_selectedCapabilityId_wo_fkey" FOREIGN KEY ("selectedCapabilityId", "workspaceId", "selectedProviderId") REFERENCES "transformation_provider_capabilities"("id", "workspaceId", "providerId") ON DELETE RESTRICT ON UPDATE CASCADE;
