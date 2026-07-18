ALTER TABLE "media_uploads"
  ADD COLUMN "projectId" VARCHAR(128),
  ADD COLUMN "fileName" VARCHAR(240),
  ADD COLUMN "rightsConfirmed" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "media_uploads_workspaceId_projectId_createdAt_idx"
  ON "media_uploads"("workspaceId", "projectId", "createdAt" DESC);

ALTER TABLE "media_uploads"
  ADD CONSTRAINT "media_uploads_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "public_operations"
  DROP CONSTRAINT "public_operations_type_check",
  DROP CONSTRAINT "public_operations_phase_check";

ALTER TABLE "public_operations"
  ADD CONSTRAINT "public_operations_type_check"
  CHECK ("type" IN ('artifact-render', 'media-ingest')),
  ADD CONSTRAINT "public_operations_phase_check"
  CHECK (
    "phase" IN (
      'queued', 'materializing', 'rendering', 'assembling', 'probing',
      'normalizing', 'transcribing', 'verifying', 'persisting',
      'waiting', 'retrying', 'completed', 'failed', 'canceled'
    )
  );

CREATE TABLE "media_ingest_operations" (
  "operationId" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "uploadId" UUID NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "sourceArtifactId" VARCHAR(128) NOT NULL,
  "sourceManifestId" VARCHAR(128) NOT NULL,
  "originalFileName" VARCHAR(240) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "media_ingest_operations_pkey" PRIMARY KEY ("operationId")
);

CREATE UNIQUE INDEX "media_ingest_operations_uploadId_key"
  ON "media_ingest_operations"("uploadId");
CREATE UNIQUE INDEX "media_ingest_operations_operationId_workspaceId_key"
  ON "media_ingest_operations"("operationId", "workspaceId");
CREATE UNIQUE INDEX "media_ingest_operations_uploadId_workspaceId_key"
  ON "media_ingest_operations"("uploadId", "workspaceId");
CREATE INDEX "media_ingest_operations_workspaceId_projectId_createdAt_idx"
  ON "media_ingest_operations"("workspaceId", "projectId", "createdAt" DESC);
CREATE INDEX "media_ingest_operations_workspaceId_sourceArtifactId_idx"
  ON "media_ingest_operations"("workspaceId", "sourceArtifactId");

ALTER TABLE "media_ingest_operations"
  ADD CONSTRAINT "media_ingest_operations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "media_ingest_operations_operationId_workspaceId_fkey" FOREIGN KEY ("operationId", "workspaceId") REFERENCES "public_operations"("id", "workspaceId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "media_ingest_operations_uploadId_workspaceId_fkey" FOREIGN KEY ("uploadId", "workspaceId") REFERENCES "media_uploads"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "media_ingest_operations_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "project_media_assets" (
  "id" UUID NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "artifactId" VARCHAR(128) NOT NULL,
  "uploadId" UUID,
  "role" VARCHAR(32) NOT NULL,
  "originalFileName" VARCHAR(240) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_media_assets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_media_assets_role_check" CHECK ("role" IN ('source-master', 'editing-proxy'))
);

CREATE UNIQUE INDEX "project_media_assets_projectId_artifactId_role_key"
  ON "project_media_assets"("projectId", "artifactId", "role");
CREATE UNIQUE INDEX "project_media_assets_uploadId_role_key"
  ON "project_media_assets"("uploadId", "role");
CREATE INDEX "project_media_assets_workspaceId_projectId_createdAt_idx"
  ON "project_media_assets"("workspaceId", "projectId", "createdAt" DESC);
CREATE INDEX "project_media_assets_workspaceId_artifactId_idx"
  ON "project_media_assets"("workspaceId", "artifactId");

ALTER TABLE "project_media_assets"
  ADD CONSTRAINT "project_media_assets_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_media_assets_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "project_media_assets_artifactId_workspaceId_fkey" FOREIGN KEY ("artifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_media_assets_uploadId_workspaceId_fkey" FOREIGN KEY ("uploadId", "workspaceId") REFERENCES "media_uploads"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "media_transcripts" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "sourceArtifactId" VARCHAR(128) NOT NULL,
  "sourceManifestId" VARCHAR(128) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "language" VARCHAR(35) NOT NULL,
  "provider" VARCHAR(64) NOT NULL,
  "model" VARCHAR(128) NOT NULL,
  "transcriptHash" CHAR(64) NOT NULL,
  "transcriptJson" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "media_transcripts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "media_transcripts_hash_check" CHECK ("transcriptHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "media_transcripts_schema_check" CHECK ("schemaVersion" = 'media-transcript/v1'),
  CONSTRAINT "media_transcripts_json_check" CHECK (jsonb_typeof("transcriptJson"::jsonb) = 'object')
);

CREATE UNIQUE INDEX "media_transcripts_sourceArtifactId_transcriptHash_key"
  ON "media_transcripts"("sourceArtifactId", "transcriptHash");
CREATE INDEX "media_transcripts_workspaceId_projectId_createdAt_idx"
  ON "media_transcripts"("workspaceId", "projectId", "createdAt" DESC);
CREATE INDEX "media_transcripts_workspaceId_sourceArtifactId_idx"
  ON "media_transcripts"("workspaceId", "sourceArtifactId");

ALTER TABLE "media_transcripts"
  ADD CONSTRAINT "media_transcripts_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "media_transcripts_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "media_transcripts_sourceArtifactId_workspaceId_fkey" FOREIGN KEY ("sourceArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "media_transcripts_sourceManifestId_workspaceId_fkey" FOREIGN KEY ("sourceManifestId", "workspaceId") REFERENCES "media_artifact_manifests"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE;
