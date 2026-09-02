CREATE TABLE "review_cleanup_masks" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "projectVersionId" VARCHAR(128) NOT NULL,
  "rootId" VARCHAR(128) NOT NULL,
  "revision" INTEGER NOT NULL,
  "supersedesId" VARCHAR(128),
  "schemaVersion" VARCHAR(64) NOT NULL,
  "policyVersion" VARCHAR(64) NOT NULL,
  "annotationId" UUID NOT NULL,
  "annotationHash" CHAR(64) NOT NULL,
  "proxyArtifactId" VARCHAR(128) NOT NULL,
  "proxyHash" CHAR(64) NOT NULL,
  "sourceArtifactId" VARCHAR(128) NOT NULL,
  "sourceArtifactHash" CHAR(64) NOT NULL,
  "transformationBriefId" VARCHAR(128) NOT NULL,
  "transformationBriefHash" CHAR(64) NOT NULL,
  "outputSpecId" VARCHAR(128) NOT NULL,
  "formatWidth" INTEGER NOT NULL,
  "formatHeight" INTEGER NOT NULL,
  "rangeStartFrame" INTEGER NOT NULL,
  "rangeEndFrame" INTEGER NOT NULL,
  "regionX" DOUBLE PRECISION NOT NULL,
  "regionY" DOUBLE PRECISION NOT NULL,
  "regionWidth" DOUBLE PRECISION NOT NULL,
  "regionHeight" DOUBLE PRECISION NOT NULL,
  "keyframesJson" TEXT NOT NULL,
  "keyframesHash" CHAR(64) NOT NULL,
  "preserveRegionsJson" TEXT NOT NULL,
  "preserveRegionsHash" CHAR(64) NOT NULL,
  "trackingStatus" VARCHAR(16) NOT NULL,
  "trackingConfidenceBps" INTEGER NOT NULL,
  "formatChangeJson" TEXT,
  "formatChangeHash" CHAR(64),
  "createdByClientId" VARCHAR(80) NOT NULL,
  "actorCredentialId" VARCHAR(128),
  "actorEnvironment" VARCHAR(16),
  "actorAuthenticationKind" VARCHAR(16),
  "actorContextHash" CHAR(64),
  "delegatedUserId" VARCHAR(128),
  "delegatedIdentityId" VARCHAR(128),
  "workspaceRole" VARCHAR(32),
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "maskJson" TEXT NOT NULL,
  "maskHash" CHAR(64) NOT NULL,

  CONSTRAINT "review_cleanup_masks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "review_cleanup_masks_revision_check" CHECK ("revision" >= 1),
  CONSTRAINT "review_cleanup_masks_schema_check" CHECK ("schemaVersion" = 'review-cleanup-mask/v1'),
  CONSTRAINT "review_cleanup_masks_policy_check" CHECK ("policyVersion" = 'review-cleanup-mask-policy/v1'),
  CONSTRAINT "review_cleanup_masks_range_check" CHECK ("rangeStartFrame" >= 0 AND "rangeEndFrame" > "rangeStartFrame"),
  CONSTRAINT "review_cleanup_masks_format_check" CHECK ("formatWidth" > 0 AND "formatWidth" <= 16384 AND "formatHeight" > 0 AND "formatHeight" <= 16384),
  CONSTRAINT "review_cleanup_masks_region_check" CHECK (
    "regionX" >= 0 AND "regionY" >= 0 AND
    "regionWidth" > 0 AND "regionHeight" > 0 AND
    "regionX" + "regionWidth" <= 1 AND
    "regionY" + "regionHeight" <= 1
  ),
  CONSTRAINT "review_cleanup_masks_tracking_check" CHECK ("trackingStatus" IN ('static', 'tracked', 'uncertain')),
  CONSTRAINT "review_cleanup_masks_confidence_check" CHECK ("trackingConfidenceBps" BETWEEN 0 AND 10000),
  CONSTRAINT "review_cleanup_masks_format_change_pair_check" CHECK (("formatChangeJson" IS NULL) = ("formatChangeHash" IS NULL)),
  CONSTRAINT "review_cleanup_masks_hashes_check" CHECK (
    "annotationHash" ~ '^[0-9a-f]{64}$' AND
    "proxyHash" ~ '^[0-9a-f]{64}$' AND
    "sourceArtifactHash" ~ '^[0-9a-f]{64}$' AND
    "transformationBriefHash" ~ '^[0-9a-f]{64}$' AND
    "keyframesHash" ~ '^[0-9a-f]{64}$' AND
    "preserveRegionsHash" ~ '^[0-9a-f]{64}$' AND
    "maskHash" ~ '^[0-9a-f]{64}$' AND
    "requestFingerprint" ~ '^[0-9a-f]{64}$' AND
    ("actorContextHash" IS NULL OR "actorContextHash" ~ '^[0-9a-f]{64}$')
  )
);

CREATE UNIQUE INDEX "review_cleanup_masks_id_workspaceId_key"
  ON "review_cleanup_masks"("id", "workspaceId");
CREATE UNIQUE INDEX "review_cleanup_masks_root_revision_key"
  ON "review_cleanup_masks"("workspaceId", "projectId", "rootId", "revision");
CREATE UNIQUE INDEX "review_cleanup_masks_hash_key"
  ON "review_cleanup_masks"("workspaceId", "projectId", "maskHash");
CREATE UNIQUE INDEX "review_cleanup_masks_idempotency_key"
  ON "review_cleanup_masks"("workspaceId", "projectId", "createdByClientId", "idempotencyKey");
CREATE INDEX "review_cleanup_masks_project_created_idx"
  ON "review_cleanup_masks"("workspaceId", "projectId", "createdAt" DESC, "id" DESC);
CREATE INDEX "review_cleanup_masks_annotation_revision_idx"
  ON "review_cleanup_masks"("workspaceId", "annotationId", "revision" DESC);
CREATE INDEX "review_cleanup_masks_brief_revision_idx"
  ON "review_cleanup_masks"("workspaceId", "transformationBriefId", "revision" DESC);
CREATE INDEX "review_cleanup_masks_source_tracking_idx"
  ON "review_cleanup_masks"("workspaceId", "sourceArtifactId", "trackingStatus");

ALTER TABLE "review_cleanup_masks"
  ADD CONSTRAINT "review_cleanup_masks_workspace_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "review_cleanup_masks"
  ADD CONSTRAINT "review_cleanup_masks_project_fkey"
  FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "review_cleanup_masks"
  ADD CONSTRAINT "review_cleanup_masks_project_version_fkey"
  FOREIGN KEY ("projectVersionId", "projectId", "workspaceId") REFERENCES "project_versions"("id", "projectId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "review_cleanup_masks"
  ADD CONSTRAINT "review_cleanup_masks_annotation_fkey"
  FOREIGN KEY ("annotationId", "workspaceId") REFERENCES "review_annotations"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "review_cleanup_masks"
  ADD CONSTRAINT "review_cleanup_masks_proxy_artifact_fkey"
  FOREIGN KEY ("proxyArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "review_cleanup_masks"
  ADD CONSTRAINT "review_cleanup_masks_source_artifact_fkey"
  FOREIGN KEY ("sourceArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "review_cleanup_masks"
  ADD CONSTRAINT "review_cleanup_masks_brief_fkey"
  FOREIGN KEY ("transformationBriefId", "workspaceId") REFERENCES "transformation_briefs"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "review_cleanup_masks"
  ADD CONSTRAINT "review_cleanup_masks_creator_fkey"
  FOREIGN KEY ("createdByClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "review_cleanup_masks"
  ADD CONSTRAINT "review_cleanup_masks_supersedes_fkey"
  FOREIGN KEY ("supersedesId", "workspaceId") REFERENCES "review_cleanup_masks"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
