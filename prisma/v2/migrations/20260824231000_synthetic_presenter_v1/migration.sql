CREATE TABLE "synthetic_presenter_profiles" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "profileId" VARCHAR(128) NOT NULL,
  "version" INTEGER NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "status" VARCHAR(16) NOT NULL,
  "actorIdentityId" VARCHAR(128) NOT NULL,
  "defaultLocale" VARCHAR(35) NOT NULL,
  "disclosure" VARCHAR(500) NOT NULL,
  "consentSnapshotHash" CHAR(64) NOT NULL,
  "profileJson" TEXT NOT NULL,
  "profileHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "actorCredentialId" VARCHAR(128),
  "actorEnvironment" VARCHAR(16),
  "actorAuthenticationKind" VARCHAR(16),
  "actorContextHash" CHAR(64),
  "delegatedUserId" VARCHAR(128),
  "delegatedIdentityId" VARCHAR(128),
  "workspaceRole" VARCHAR(32),
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "synthetic_presenter_profiles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "synthetic_presenter_profiles_profile_json_check"
    CHECK (jsonb_typeof("profileJson"::jsonb) = 'object'),
  CONSTRAINT "synthetic_presenter_profiles_version_check"
    CHECK ("version" >= 1),
  CONSTRAINT "synthetic_presenter_profiles_status_check"
    CHECK ("status" IN ('active', 'disabled', 'expired'))
);

CREATE UNIQUE INDEX "synthetic_presenter_profiles_id_workspaceId_key"
  ON "synthetic_presenter_profiles"("id", "workspaceId");
CREATE UNIQUE INDEX "synthetic_presenter_profiles_workspaceId_profileId_version_key"
  ON "synthetic_presenter_profiles"("workspaceId", "profileId", "version");
CREATE UNIQUE INDEX "synthetic_presenter_profiles_workspaceId_createdByClientId__key"
  ON "synthetic_presenter_profiles"("workspaceId", "createdByClientId", "actorContextHash", "idempotencyKey");
CREATE INDEX "synthetic_presenter_profiles_workspaceId_profileId_createdA_idx"
  ON "synthetic_presenter_profiles"("workspaceId", "profileId", "createdAt" DESC);
CREATE INDEX "synthetic_presenter_profiles_workspaceId_status_defaultLoca_idx"
  ON "synthetic_presenter_profiles"("workspaceId", "status", "defaultLocale");
CREATE INDEX "synthetic_presenter_profiles_workspaceId_consentSnapshotHas_idx"
  ON "synthetic_presenter_profiles"("workspaceId", "consentSnapshotHash");

ALTER TABLE "synthetic_presenter_profiles"
  ADD CONSTRAINT "synthetic_presenter_profiles_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_presenter_profiles"
  ADD CONSTRAINT "synthetic_presenter_profiles_createdByClientId_workspaceId_fkey"
  FOREIGN KEY ("createdByClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "synthetic_production_runs" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "projectVersionId" VARCHAR(128) NOT NULL,
  "profileSnapshotId" VARCHAR(128) NOT NULL,
  "editPlanSnapshotId" VARCHAR(128) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "policyVersion" VARCHAR(64) NOT NULL,
  "status" VARCHAR(24) NOT NULL,
  "use" VARCHAR(64) NOT NULL,
  "market" VARCHAR(64) NOT NULL,
  "locale" VARCHAR(35) NOT NULL,
  "durationMs" INTEGER NOT NULL,
  "authorizationId" VARCHAR(128) NOT NULL,
  "authorizationHash" CHAR(64) NOT NULL,
  "planJson" TEXT NOT NULL,
  "planHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "actorCredentialId" VARCHAR(128),
  "actorEnvironment" VARCHAR(16),
  "actorAuthenticationKind" VARCHAR(16),
  "actorContextHash" CHAR(64),
  "delegatedUserId" VARCHAR(128),
  "delegatedIdentityId" VARCHAR(128),
  "workspaceRole" VARCHAR(32),
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "synthetic_production_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "synthetic_production_runs_plan_json_check"
    CHECK (jsonb_typeof("planJson"::jsonb) = 'object'),
  CONSTRAINT "synthetic_production_runs_duration_check"
    CHECK ("durationMs" > 0),
  CONSTRAINT "synthetic_production_runs_status_check"
    CHECK ("status" IN ('compiled', 'rendering', 'completed', 'failed', 'canceled'))
);

CREATE UNIQUE INDEX "synthetic_production_runs_id_workspaceId_key"
  ON "synthetic_production_runs"("id", "workspaceId");
CREATE UNIQUE INDEX "synthetic_production_runs_id_workspaceId_projectId_key"
  ON "synthetic_production_runs"("id", "workspaceId", "projectId");
CREATE UNIQUE INDEX "synthetic_production_runs_workspaceId_projectId_createdByCl_key"
  ON "synthetic_production_runs"("workspaceId", "projectId", "createdByClientId", "actorContextHash", "idempotencyKey");
CREATE INDEX "synthetic_production_runs_workspaceId_projectId_createdAt_i_idx"
  ON "synthetic_production_runs"("workspaceId", "projectId", "createdAt" DESC, "id" DESC);
CREATE INDEX "synthetic_production_runs_workspaceId_projectVersionId_idx"
  ON "synthetic_production_runs"("workspaceId", "projectVersionId");
CREATE INDEX "synthetic_production_runs_workspaceId_profileSnapshotId_idx"
  ON "synthetic_production_runs"("workspaceId", "profileSnapshotId");
CREATE INDEX "synthetic_production_runs_workspaceId_status_createdAt_idx"
  ON "synthetic_production_runs"("workspaceId", "status", "createdAt" DESC);

ALTER TABLE "synthetic_production_runs"
  ADD CONSTRAINT "synthetic_production_runs_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_production_runs"
  ADD CONSTRAINT "synthetic_production_runs_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "synthetic_production_runs"
  ADD CONSTRAINT "synthetic_production_runs_projectVersionId_projectId_works_fkey"
  FOREIGN KEY ("projectVersionId", "projectId", "workspaceId") REFERENCES "project_versions"("id", "projectId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_production_runs"
  ADD CONSTRAINT "synthetic_production_runs_profileSnapshotId_workspaceId_fkey"
  FOREIGN KEY ("profileSnapshotId", "workspaceId") REFERENCES "synthetic_presenter_profiles"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_production_runs"
  ADD CONSTRAINT "synthetic_production_runs_editPlanSnapshotId_projectId_wor_fkey"
  FOREIGN KEY ("editPlanSnapshotId", "projectId", "workspaceId") REFERENCES "project_snapshots"("id", "projectId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_production_runs"
  ADD CONSTRAINT "synthetic_production_runs_createdByClientId_workspaceId_fkey"
  FOREIGN KEY ("createdByClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "synthetic_production_assets" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "runId" VARCHAR(128) NOT NULL,
  "artifactId" VARCHAR(128) NOT NULL,
  "role" VARCHAR(32) NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "startMs" INTEGER,
  "endMs" INTEGER,
  "providerJobId" VARCHAR(128),
  "criticHash" CHAR(64),
  "artifactSha256" CHAR(64) NOT NULL,
  CONSTRAINT "synthetic_production_assets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "synthetic_production_assets_range_check"
    CHECK (("startMs" IS NULL AND "endMs" IS NULL) OR ("startMs" >= 0 AND "endMs" > "startMs")),
  CONSTRAINT "synthetic_production_assets_ordinal_check"
    CHECK ("ordinal" >= 0),
  CONSTRAINT "synthetic_production_assets_role_check"
    CHECK ("role" IN ('audio-master', 'synthetic-block', 'b-roll', 'overlay'))
);

CREATE UNIQUE INDEX "synthetic_production_assets_id_workspaceId_key"
  ON "synthetic_production_assets"("id", "workspaceId");
CREATE UNIQUE INDEX "synthetic_production_assets_runId_ordinal_key"
  ON "synthetic_production_assets"("runId", "ordinal");
CREATE UNIQUE INDEX "synthetic_production_assets_runId_artifactId_key"
  ON "synthetic_production_assets"("runId", "artifactId");
CREATE INDEX "synthetic_production_assets_workspaceId_projectId_role_idx"
  ON "synthetic_production_assets"("workspaceId", "projectId", "role");
CREATE INDEX "synthetic_production_assets_workspaceId_artifactId_idx"
  ON "synthetic_production_assets"("workspaceId", "artifactId");
CREATE INDEX "synthetic_production_assets_workspaceId_providerJobId_idx"
  ON "synthetic_production_assets"("workspaceId", "providerJobId");

ALTER TABLE "synthetic_production_assets"
  ADD CONSTRAINT "synthetic_production_assets_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_production_assets"
  ADD CONSTRAINT "synthetic_production_assets_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "synthetic_production_assets"
  ADD CONSTRAINT "synthetic_production_assets_runId_workspaceId_projectId_fkey"
  FOREIGN KEY ("runId", "workspaceId", "projectId") REFERENCES "synthetic_production_runs"("id", "workspaceId", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "synthetic_production_assets"
  ADD CONSTRAINT "synthetic_production_assets_artifactId_workspaceId_fkey"
  FOREIGN KEY ("artifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
