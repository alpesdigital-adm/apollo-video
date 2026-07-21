CREATE TABLE "render_element_maps" (
  "id" UUID NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "projectVersionId" VARCHAR(128) NOT NULL,
  "proxyArtifactId" VARCHAR(128) NOT NULL,
  "proxyHash" CHAR(64) NOT NULL,
  "mapHash" CHAR(64) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "fps" DOUBLE PRECISION NOT NULL,
  "durationFrames" INTEGER NOT NULL,
  "canvasWidth" INTEGER NOT NULL,
  "canvasHeight" INTEGER NOT NULL,
  "elementsJson" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "render_element_maps_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "render_element_maps_hash_check" CHECK ("proxyHash" ~ '^[a-f0-9]{64}$' AND "mapHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "render_element_maps_schema_check" CHECK ("schemaVersion" = 'render-element-map/v1'),
  CONSTRAINT "render_element_maps_dimensions_check" CHECK ("fps" > 0 AND "durationFrames" > 0 AND "canvasWidth" > 0 AND "canvasHeight" > 0),
  CONSTRAINT "render_element_maps_elements_json_check" CHECK (jsonb_typeof("elementsJson"::jsonb) = 'array')
);

CREATE UNIQUE INDEX "render_element_maps_workspaceId_projectVersionId_proxyArtif_key"
  ON "render_element_maps"("workspaceId", "projectVersionId", "proxyArtifactId");
CREATE INDEX "render_element_maps_workspaceId_projectId_createdAt_idx"
  ON "render_element_maps"("workspaceId", "projectId", "createdAt" DESC);
CREATE INDEX "render_element_maps_workspaceId_proxyArtifactId_proxyHash_idx"
  ON "render_element_maps"("workspaceId", "proxyArtifactId", "proxyHash");

ALTER TABLE "render_element_maps" ADD CONSTRAINT "render_element_maps_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "render_element_maps" ADD CONSTRAINT "render_element_maps_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "render_element_maps" ADD CONSTRAINT "render_element_maps_projectVersionId_workspaceId_fkey" FOREIGN KEY ("projectVersionId", "workspaceId") REFERENCES "project_versions"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "render_element_maps" ADD CONSTRAINT "render_element_maps_proxyArtifactId_workspaceId_fkey" FOREIGN KEY ("proxyArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
