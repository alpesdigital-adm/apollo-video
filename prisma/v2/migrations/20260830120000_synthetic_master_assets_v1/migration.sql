-- Synthetic master assets: the immutable, content-addressed seal of every
-- generated performance. Composition (captions, LUT, B-roll, overlays, output
-- format) is derived downstream and deliberately has no column here.

CREATE TABLE "synthetic_master_assets" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "projectVersionId" VARCHAR(128) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "profileId" VARCHAR(128) NOT NULL,
  "profileSnapshotId" VARCHAR(128) NOT NULL,
  "profileVersion" INTEGER NOT NULL,
  "consentSnapshotHash" CHAR(64) NOT NULL,
  "authorizationHash" CHAR(64) NOT NULL,
  "rightsSnapshotId" VARCHAR(128),
  "scriptText" TEXT NOT NULL,
  "scriptHash" CHAR(64) NOT NULL,
  "alignmentHash" CHAR(64) NOT NULL,
  "locale" VARCHAR(35) NOT NULL,
  "durationMs" INTEGER NOT NULL,
  "audioDurationMs" INTEGER NOT NULL,
  "videoDurationMs" INTEGER NOT NULL,
  "adapterId" VARCHAR(128) NOT NULL,
  "adapterVersion" VARCHAR(128) NOT NULL,
  "capability" VARCHAR(64) NOT NULL,
  "modelRef" VARCHAR(128),
  "adapterConfigHash" CHAR(64) NOT NULL,
  "providerJobId" VARCHAR(128) NOT NULL,
  "providerJobRef" VARCHAR(256) NOT NULL,
  "costCurrency" CHAR(3) NOT NULL,
  "costMinorUnits" INTEGER NOT NULL,
  "latencyMs" INTEGER NOT NULL,
  "criticReportId" VARCHAR(128) NOT NULL,
  "criticReportHash" CHAR(64) NOT NULL,
  "lineageJson" TEXT NOT NULL,
  "masterJson" TEXT NOT NULL,
  "masterHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "actorCredentialId" VARCHAR(128),
  "actorEnvironment" VARCHAR(32),
  "actorAuthenticationKind" VARCHAR(32),
  "actorContextHash" CHAR(64),
  "delegatedUserId" VARCHAR(128),
  "delegatedIdentityId" VARCHAR(128),
  "workspaceRole" VARCHAR(32),
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "synthetic_master_assets_pkey" PRIMARY KEY ("id"),
  -- Audio governs the timeline and video may drift at most one 30fps frame.
  CONSTRAINT "synthetic_master_assets_duration_check"
    CHECK ("durationMs" > 0 AND "durationMs" = "audioDurationMs" AND abs("videoDurationMs" - "audioDurationMs") <= 34),
  CONSTRAINT "synthetic_master_assets_profile_version_check" CHECK ("profileVersion" >= 1),
  CONSTRAINT "synthetic_master_assets_cost_check" CHECK ("costMinorUnits" >= 0 AND "latencyMs" >= 0)
);

CREATE UNIQUE INDEX "synthetic_master_assets_id_workspace_key"
  ON "synthetic_master_assets"("id", "workspaceId");
-- Content-addressed: the same performance is never sealed twice.
CREATE UNIQUE INDEX "synthetic_master_assets_workspace_hash_key"
  ON "synthetic_master_assets"("workspaceId", "masterHash");
-- One approved provider job produces exactly one master.
CREATE UNIQUE INDEX "synthetic_master_assets_workspace_job_key"
  ON "synthetic_master_assets"("workspaceId", "providerJobId");
CREATE UNIQUE INDEX "synthetic_master_assets_workspace_actor_key"
  ON "synthetic_master_assets"("workspaceId", "projectId", "createdByClientId", "actorContextHash", "idempotencyKey");

CREATE INDEX "synthetic_master_assets_workspace_project_created_idx"
  ON "synthetic_master_assets"("workspaceId", "projectId", "createdAt" DESC, "id" DESC);
CREATE INDEX "synthetic_master_assets_workspace_profile_idx"
  ON "synthetic_master_assets"("workspaceId", "profileId", "createdAt" DESC);
CREATE INDEX "synthetic_master_assets_workspace_snapshot_idx"
  ON "synthetic_master_assets"("workspaceId", "profileSnapshotId");
CREATE INDEX "synthetic_master_assets_workspace_critic_idx"
  ON "synthetic_master_assets"("workspaceId", "criticReportId");
CREATE INDEX "synthetic_master_assets_workspace_script_idx"
  ON "synthetic_master_assets"("workspaceId", "scriptHash");

ALTER TABLE "synthetic_master_assets" ADD CONSTRAINT "synthetic_master_assets_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_master_assets" ADD CONSTRAINT "synthetic_master_assets_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "synthetic_master_assets" ADD CONSTRAINT "synthetic_master_assets_projectVersionId_workspaceId_fkey"
  FOREIGN KEY ("projectVersionId", "workspaceId") REFERENCES "project_versions"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_master_assets" ADD CONSTRAINT "synthetic_master_assets_profileSnapshotId_workspaceId_fkey"
  FOREIGN KEY ("profileSnapshotId", "workspaceId") REFERENCES "synthetic_presenter_profiles"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_master_assets" ADD CONSTRAINT "synthetic_master_assets_providerJobId_workspaceId_fkey"
  FOREIGN KEY ("providerJobId", "workspaceId") REFERENCES "provider_jobs"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_master_assets" ADD CONSTRAINT "synthetic_master_assets_createdByClientId_workspaceId_fkey"
  FOREIGN KEY ("createdByClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The four ingested roles of a master, normalized so storage integrity can be
-- verified per artifact instead of trusting a JSON blob.
CREATE TABLE "synthetic_master_artifacts" (
  "masterId" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "role" VARCHAR(32) NOT NULL,
  "artifactId" VARCHAR(128) NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "byteSize" BIGINT NOT NULL,
  "mediaType" VARCHAR(16) NOT NULL,
  "container" VARCHAR(32) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "synthetic_master_artifacts_pkey" PRIMARY KEY ("masterId", "role"),
  CONSTRAINT "synthetic_master_artifacts_role_check"
    CHECK ("role" IN ('provider-original', 'normalized-video', 'final-audio', 'alignment')),
  CONSTRAINT "synthetic_master_artifacts_size_check" CHECK ("byteSize" > 0)
);

CREATE INDEX "synthetic_master_artifacts_workspace_artifact_idx"
  ON "synthetic_master_artifacts"("workspaceId", "artifactId");
CREATE INDEX "synthetic_master_artifacts_workspace_sha_idx"
  ON "synthetic_master_artifacts"("workspaceId", "sha256");

ALTER TABLE "synthetic_master_artifacts" ADD CONSTRAINT "synthetic_master_artifacts_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_master_artifacts" ADD CONSTRAINT "synthetic_master_artifacts_masterId_workspaceId_fkey"
  FOREIGN KEY ("masterId", "workspaceId") REFERENCES "synthetic_master_assets"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "synthetic_master_artifacts" ADD CONSTRAINT "synthetic_master_artifacts_artifactId_workspaceId_fkey"
  FOREIGN KEY ("artifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
