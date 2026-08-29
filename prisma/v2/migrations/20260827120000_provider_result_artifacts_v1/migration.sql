-- Provider result artifacts: one row per artifact a provider effect produced
-- (audio, alignment evidence, video), content-addressed and bound to the
-- durable job, the versioned adapter identity and the authorization seal.
CREATE TABLE "provider_result_artifacts" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "jobId" VARCHAR(128) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "role" VARCHAR(32) NOT NULL,
  "providerJobRef" VARCHAR(256) NOT NULL,
  "artifactId" VARCHAR(128) NOT NULL,
  "artifactSha256" CHAR(64) NOT NULL,
  "byteSize" BIGINT NOT NULL,
  "mediaType" VARCHAR(16) NOT NULL,
  "container" VARCHAR(16) NOT NULL,
  "adapterId" VARCHAR(128) NOT NULL,
  "adapterVersion" VARCHAR(128) NOT NULL,
  "modelRef" VARCHAR(128),
  "adapterConfigHash" CHAR(64) NOT NULL,
  "inputHash" CHAR(64) NOT NULL,
  "authorizationHash" CHAR(64) NOT NULL,
  "scriptHash" CHAR(64),
  "observedCostCurrency" CHAR(3),
  "observedCostMinorUnits" INTEGER,
  "completedAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "provider_result_artifacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "provider_result_artifacts_schema_check" CHECK ("schemaVersion" = 'provider-result-artifact/v1'),
  CONSTRAINT "provider_result_artifacts_role_check" CHECK ("role" IN ('primary-audio', 'primary-video', 'alignment-evidence')),
  CONSTRAINT "provider_result_artifacts_media_check" CHECK (
    ("role" = 'primary-audio' AND "mediaType" = 'audio') OR
    ("role" = 'primary-video' AND "mediaType" = 'video') OR
    ("role" = 'alignment-evidence' AND "mediaType" = 'data')
  ),
  CONSTRAINT "provider_result_artifacts_sha_check" CHECK ("artifactSha256" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "provider_result_artifacts_size_check" CHECK ("byteSize" > 0),
  CONSTRAINT "provider_result_artifacts_cost_check" CHECK (
    ("observedCostCurrency" IS NULL AND "observedCostMinorUnits" IS NULL) OR
    ("observedCostCurrency" IS NOT NULL AND "observedCostMinorUnits" IS NOT NULL AND "observedCostMinorUnits" >= 0)
  )
);

CREATE UNIQUE INDEX "provider_result_artifacts_id_workspaceId_key"
  ON "provider_result_artifacts"("id", "workspaceId");
CREATE UNIQUE INDEX "provider_result_artifacts_jobId_role_key"
  ON "provider_result_artifacts"("jobId", "role");
CREATE INDEX "provider_result_artifacts_workspaceId_projectId_createdAt_i_idx"
  ON "provider_result_artifacts"("workspaceId", "projectId", "createdAt" DESC, "id" DESC);
CREATE INDEX "provider_result_artifacts_workspaceId_artifactId_idx"
  ON "provider_result_artifacts"("workspaceId", "artifactId");
CREATE INDEX "provider_result_artifacts_workspaceId_adapterId_providerJob_idx"
  ON "provider_result_artifacts"("workspaceId", "adapterId", "providerJobRef");

ALTER TABLE "provider_result_artifacts" ADD CONSTRAINT "provider_result_artifacts_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provider_result_artifacts" ADD CONSTRAINT "provider_result_artifacts_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "provider_result_artifacts" ADD CONSTRAINT "provider_result_artifacts_jobId_workspaceId_projectId_fkey"
  FOREIGN KEY ("jobId", "workspaceId", "projectId") REFERENCES "provider_jobs"("id", "workspaceId", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "provider_result_artifacts" ADD CONSTRAINT "provider_result_artifacts_artifactId_workspaceId_fkey"
  FOREIGN KEY ("artifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
