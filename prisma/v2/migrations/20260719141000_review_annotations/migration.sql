CREATE TABLE "review_annotations" (
  "id" UUID NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "projectVersionId" VARCHAR(128) NOT NULL,
  "proxyArtifactId" VARCHAR(128) NOT NULL,
  "proxyHash" CHAR(64) NOT NULL,
  "frame" INTEGER NOT NULL,
  "timeStartMs" INTEGER NOT NULL,
  "timeEndMs" INTEGER NOT NULL,
  "scope" VARCHAR(16) NOT NULL,
  "regionX" DOUBLE PRECISION,
  "regionY" DOUBLE PRECISION,
  "regionWidth" DOUBLE PRECISION,
  "regionHeight" DOUBLE PRECISION,
  "targetIdsJson" TEXT NOT NULL,
  "screenshotRef" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "authorType" VARCHAR(32) NOT NULL,
  "authorId" VARCHAR(128) NOT NULL,
  "authorName" VARCHAR(120) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'open',
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "review_annotations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "review_annotations_proxy_hash_check" CHECK ("proxyHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "review_annotations_request_fingerprint_check" CHECK ("requestFingerprint" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "review_annotations_frame_time_check" CHECK ("frame" >= 0 AND "timeStartMs" >= 0 AND "timeEndMs" >= "timeStartMs"),
  CONSTRAINT "review_annotations_scope_check" CHECK ("scope" IN ('point', 'region', 'scene')),
  CONSTRAINT "review_annotations_status_check" CHECK ("status" IN ('open', 'applied', 'dismissed')),
  CONSTRAINT "review_annotations_author_check" CHECK ("authorType" IN ('user', 'api-client') AND length(trim("authorId")) >= 3 AND length(trim("authorName")) >= 1),
  CONSTRAINT "review_annotations_region_check" CHECK (
    ("scope" <> 'region' AND "regionX" IS NULL AND "regionY" IS NULL AND "regionWidth" IS NULL AND "regionHeight" IS NULL)
    OR
    ("scope" = 'region' AND "regionX" BETWEEN 0 AND 1 AND "regionY" BETWEEN 0 AND 1
      AND "regionWidth" > 0 AND "regionHeight" > 0
      AND "regionX" + "regionWidth" <= 1 AND "regionY" + "regionHeight" <= 1)
  )
);

CREATE UNIQUE INDEX "review_annotations_id_workspaceId_key"
  ON "review_annotations"("id", "workspaceId");
CREATE UNIQUE INDEX "review_annotations_workspaceId_projectId_idempotencyKey_key"
  ON "review_annotations"("workspaceId", "projectId", "idempotencyKey");
CREATE INDEX "review_annotations_workspaceId_projectId_createdAt_idx"
  ON "review_annotations"("workspaceId", "projectId", "createdAt" DESC);
CREATE INDEX "review_annotations_workspaceId_projectVersionId_status_idx"
  ON "review_annotations"("workspaceId", "projectVersionId", "status");
CREATE INDEX "review_annotations_workspaceId_proxyArtifactId_idx"
  ON "review_annotations"("workspaceId", "proxyArtifactId");

ALTER TABLE "review_annotations" ADD CONSTRAINT "review_annotations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "review_annotations" ADD CONSTRAINT "review_annotations_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "review_annotations" ADD CONSTRAINT "review_annotations_projectVersionId_workspaceId_fkey" FOREIGN KEY ("projectVersionId", "workspaceId") REFERENCES "project_versions"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "review_annotations" ADD CONSTRAINT "review_annotations_proxyArtifactId_workspaceId_fkey" FOREIGN KEY ("proxyArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
