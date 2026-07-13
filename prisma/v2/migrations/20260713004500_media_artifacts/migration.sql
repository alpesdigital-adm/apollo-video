-- Immutable media artifacts, deterministic manifests and workspace-scoped lineage.

-- CreateTable
CREATE TABLE "media_artifacts" (
    "id" VARCHAR(128) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "artifactKey" VARCHAR(512) NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "byteSize" BIGINT NOT NULL,
    "mediaType" VARCHAR(16) NOT NULL,
    "container" VARCHAR(32) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'available',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "media_artifacts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "media_artifacts_hash_check" CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "media_artifacts_size_check" CHECK ("byteSize" > 0),
    CONSTRAINT "media_artifacts_type_check" CHECK ("mediaType" IN ('video', 'audio', 'image')),
    CONSTRAINT "media_artifacts_container_check" CHECK ("container" ~ '^[a-z0-9][a-z0-9._-]*$'),
    CONSTRAINT "media_artifacts_status_check" CHECK ("status" IN ('available', 'quarantined', 'deleted')),
    CONSTRAINT "media_artifacts_key_check" CHECK (
      "artifactKey" !~ '(^/|^[A-Za-z]:|\\\\|(^|/)\\.\\.?(/|$)|//)'
    )
);

-- CreateTable
CREATE TABLE "media_artifact_manifests" (
    "id" VARCHAR(128) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "artifactId" VARCHAR(128) NOT NULL,
    "schemaVersion" VARCHAR(64) NOT NULL,
    "manifestHash" CHAR(64) NOT NULL,
    "recipeId" VARCHAR(64) NOT NULL,
    "recipeVersion" VARCHAR(64) NOT NULL,
    "parametersHash" CHAR(64) NOT NULL,
    "manifestJson" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "media_artifact_manifests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "media_artifact_manifests_schema_check" CHECK ("schemaVersion" = 'media-artifact-manifest/v1'),
    CONSTRAINT "media_artifact_manifests_hash_check" CHECK ("manifestHash" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "media_artifact_manifests_parameters_hash_check" CHECK ("parametersHash" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "media_artifact_manifests_recipe_check" CHECK (
      "recipeId" ~ '^[a-z0-9][a-z0-9._-]*$' AND
      "recipeVersion" ~ '^[a-z0-9][a-z0-9._-]*$'
    ),
    CONSTRAINT "media_artifact_manifests_json_check" CHECK (jsonb_typeof("manifestJson"::jsonb) = 'object')
);

-- CreateTable
CREATE TABLE "media_artifact_lineage" (
    "id" VARCHAR(128) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "manifestId" VARCHAR(128) NOT NULL,
    "sourceArtifactId" VARCHAR(128) NOT NULL,
    "role" VARCHAR(64) NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "media_artifact_lineage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "media_artifact_lineage_role_check" CHECK ("role" ~ '^[a-z0-9][a-z0-9._-]*$'),
    CONSTRAINT "media_artifact_lineage_ordinal_check" CHECK ("ordinal" >= 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "media_artifacts_id_workspaceId_key" ON "media_artifacts"("id", "workspaceId");
CREATE UNIQUE INDEX "media_artifacts_workspaceId_artifactKey_key" ON "media_artifacts"("workspaceId", "artifactKey");
CREATE INDEX "media_artifacts_workspaceId_sha256_idx" ON "media_artifacts"("workspaceId", "sha256");
CREATE INDEX "media_artifacts_workspaceId_mediaType_status_idx" ON "media_artifacts"("workspaceId", "mediaType", "status");
CREATE UNIQUE INDEX "media_artifact_manifests_id_workspaceId_key" ON "media_artifact_manifests"("id", "workspaceId");
CREATE UNIQUE INDEX "media_artifact_manifests_artifactId_manifestHash_key" ON "media_artifact_manifests"("artifactId", "manifestHash");
CREATE INDEX "media_artifact_manifests_workspaceId_recipeId_recipeVersion_idx" ON "media_artifact_manifests"("workspaceId", "recipeId", "recipeVersion");
CREATE INDEX "media_artifact_manifests_workspaceId_createdAt_idx" ON "media_artifact_manifests"("workspaceId", "createdAt" DESC);
CREATE UNIQUE INDEX "media_artifact_lineage_manifestId_ordinal_key" ON "media_artifact_lineage"("manifestId", "ordinal");
CREATE UNIQUE INDEX "media_artifact_lineage_manifestId_sourceArtifactId_role_key" ON "media_artifact_lineage"("manifestId", "sourceArtifactId", "role");
CREATE INDEX "media_artifact_lineage_workspaceId_sourceArtifactId_idx" ON "media_artifact_lineage"("workspaceId", "sourceArtifactId");

-- AddForeignKey
ALTER TABLE "media_artifacts" ADD CONSTRAINT "media_artifacts_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_artifact_manifests" ADD CONSTRAINT "media_artifact_manifests_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_artifact_manifests" ADD CONSTRAINT "media_artifact_manifests_artifactId_workspaceId_fkey" FOREIGN KEY ("artifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_artifact_lineage" ADD CONSTRAINT "media_artifact_lineage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_artifact_lineage" ADD CONSTRAINT "media_artifact_lineage_manifestId_workspaceId_fkey" FOREIGN KEY ("manifestId", "workspaceId") REFERENCES "media_artifact_manifests"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_artifact_lineage" ADD CONSTRAINT "media_artifact_lineage_sourceArtifactId_workspaceId_fkey" FOREIGN KEY ("sourceArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
