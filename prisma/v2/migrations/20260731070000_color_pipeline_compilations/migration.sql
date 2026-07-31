CREATE UNIQUE INDEX "media_artifact_manifests_id_artifactId_workspaceId_key"
  ON "media_artifact_manifests"("id", "artifactId", "workspaceId");

ALTER TABLE "media_color_probes"
  DROP CONSTRAINT "media_color_probes_manifestId_workspaceId_fkey";
ALTER TABLE "media_color_probes"
  ADD CONSTRAINT "media_color_probes_manifestId_artifactId_workspaceId_fkey"
  FOREIGN KEY ("manifestId", "artifactId", "workspaceId")
  REFERENCES "media_artifact_manifests"("id", "artifactId", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "color_pipeline_compilations" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "sourceArtifactId" VARCHAR(128) NOT NULL,
  "sourceManifestId" VARCHAR(128) NOT NULL,
  "colorProbeId" VARCHAR(128) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "pipelineHash" CHAR(64) NOT NULL,
  "transformVersionsJson" TEXT NOT NULL,
  "compilationJson" TEXT NOT NULL,
  "compilationHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "color_pipeline_compilations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "color_pipeline_compilations_schema_check"
    CHECK ("schemaVersion" = 'color-pipeline-compilation/v1'),
  CONSTRAINT "color_pipeline_compilations_hashes_check"
    CHECK (
      "pipelineHash" ~ '^[a-f0-9]{64}$' AND
      "compilationHash" ~ '^[a-f0-9]{64}$' AND
      "requestFingerprint" ~ '^[a-f0-9]{64}$'
    )
);

CREATE UNIQUE INDEX "color_pipeline_compilations_id_workspaceId_key"
  ON "color_pipeline_compilations"("id", "workspaceId");
CREATE UNIQUE INDEX "color_pipeline_compilations_workspace_project_actor_idempotency_key"
  ON "color_pipeline_compilations"("workspaceId", "projectId", "createdByClientId", "idempotencyKey");
CREATE UNIQUE INDEX "color_pipeline_compilations_workspace_compilationHash_key"
  ON "color_pipeline_compilations"("workspaceId", "compilationHash");
CREATE INDEX "color_pipeline_compilations_workspace_project_createdAt_id_idx"
  ON "color_pipeline_compilations"("workspaceId", "projectId", "createdAt" DESC, "id" DESC);
CREATE INDEX "color_pipeline_compilations_workspace_source_idx"
  ON "color_pipeline_compilations"("workspaceId", "sourceArtifactId", "sourceManifestId");
CREATE INDEX "color_pipeline_compilations_workspace_colorProbeId_idx"
  ON "color_pipeline_compilations"("workspaceId", "colorProbeId");

ALTER TABLE "color_pipeline_compilations" ADD CONSTRAINT "color_pipeline_compilations_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "color_pipeline_compilations" ADD CONSTRAINT "color_pipeline_compilations_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "color_pipeline_compilations" ADD CONSTRAINT "color_pipeline_compilations_sourceArtifactId_workspaceId_fkey"
  FOREIGN KEY ("sourceArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "color_pipeline_compilations" ADD CONSTRAINT "color_pipeline_compilations_sourceManifestId_sourceArtifactId_workspaceId_fkey"
  FOREIGN KEY ("sourceManifestId", "sourceArtifactId", "workspaceId") REFERENCES "media_artifact_manifests"("id", "artifactId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "color_pipeline_compilations" ADD CONSTRAINT "color_pipeline_compilations_colorProbeId_workspaceId_fkey"
  FOREIGN KEY ("colorProbeId", "workspaceId") REFERENCES "media_color_probes"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "color_pipeline_compilations" ADD CONSTRAINT "color_pipeline_compilations_createdByClientId_workspaceId_fkey"
  FOREIGN KEY ("createdByClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
