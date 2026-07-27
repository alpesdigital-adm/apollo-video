CREATE TABLE "long_form_index_runs" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "sourceArtifactId" VARCHAR(128) NOT NULL,
  "sourceArtifactSha256" CHAR(64) NOT NULL,
  "sourceManifestId" VARCHAR(128) NOT NULL,
  "sourceManifestHash" CHAR(64) NOT NULL,
  "durationMs" INTEGER NOT NULL,
  "rightsSnapshotId" VARCHAR(128) NOT NULL,
  "rightsStatus" VARCHAR(32) NOT NULL,
  "consentStatus" VARCHAR(32) NOT NULL,
  "indexPolicyVersion" VARCHAR(64) NOT NULL,
  "producerJson" TEXT NOT NULL,
  "chapterCount" INTEGER NOT NULL,
  "momentCount" INTEGER NOT NULL,
  "hierarchyHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "recordHash" CHAR(64) NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdByType" VARCHAR(32) NOT NULL,
  "createdById" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "long_form_index_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "long_form_index_runs_hashes_check" CHECK (
    "sourceArtifactSha256" ~ '^[a-f0-9]{64}$'
    AND "sourceManifestHash" ~ '^[a-f0-9]{64}$'
    AND "hierarchyHash" ~ '^[a-f0-9]{64}$'
    AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
    AND "recordHash" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "long_form_index_runs_policy_check" CHECK (
    "indexPolicyVersion" = 'long-form-index/v1'
    AND "createdByType" = 'api-client'
  ),
  CONSTRAINT "long_form_index_runs_rights_check" CHECK (
    "rightsStatus" IN (
      'approved',
      'restricted',
      'unknown',
      'expired',
      'revoked'
    )
    AND "consentStatus" IN (
      'approved',
      'not-required',
      'restricted',
      'unknown',
      'expired',
      'revoked'
    )
  ),
  CONSTRAINT "long_form_index_runs_bounds_check" CHECK (
    "durationMs" > 0
    AND "chapterCount" BETWEEN 1 AND 10000
    AND "momentCount" BETWEEN 1 AND 100000
    AND length("producerJson") BETWEEN 2 AND 10000
  )
);

CREATE UNIQUE INDEX "long_form_index_runs_id_workspaceId_key"
  ON "long_form_index_runs"("id", "workspaceId");
CREATE UNIQUE INDEX "long_form_index_runs_workspaceId_projectId_idempotencyKey_key"
  ON "long_form_index_runs"(
    "workspaceId",
    "projectId",
    "idempotencyKey"
  );
CREATE UNIQUE INDEX "long_form_index_runs_one_active_artifact_key"
  ON "long_form_index_runs"(
    "workspaceId",
    "projectId",
    "sourceArtifactId"
  )
  WHERE "active" = TRUE;
CREATE INDEX "long_form_index_runs_workspaceId_projectId_active_createdAt_idx"
  ON "long_form_index_runs"(
    "workspaceId",
    "projectId",
    "active",
    "createdAt" DESC
  );
CREATE INDEX "long_form_index_runs_workspaceId_sourceArtifactId_active_cr_idx"
  ON "long_form_index_runs"(
    "workspaceId",
    "sourceArtifactId",
    "active",
    "createdAt" DESC
  );
CREATE INDEX "long_form_index_runs_workspaceId_rightsSnapshotId_idx"
  ON "long_form_index_runs"("workspaceId", "rightsSnapshotId");

CREATE TABLE "long_form_chapters" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "indexRunId" VARCHAR(128) NOT NULL,
  "sourceArtifactId" VARCHAR(128) NOT NULL,
  "sourceChapterId" VARCHAR(128) NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "titleJson" TEXT NOT NULL,
  "titleNormalized" VARCHAR(240) NOT NULL,
  "topicPathJson" TEXT NOT NULL,
  "topicPathNormalized" TEXT NOT NULL,
  "startMs" INTEGER NOT NULL,
  "endMs" INTEGER NOT NULL,
  "physicalMaterialized" BOOLEAN NOT NULL DEFAULT FALSE,
  "indexPolicyVersion" VARCHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "chapterHash" CHAR(64) NOT NULL,

  CONSTRAINT "long_form_chapters_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "long_form_chapters_virtual_range_check" CHECK (
    "physicalMaterialized" = FALSE
    AND "ordinal" >= 0
    AND "startMs" >= 0
    AND "endMs" > "startMs"
  ),
  CONSTRAINT "long_form_chapters_policy_hash_check" CHECK (
    "indexPolicyVersion" = 'long-form-index/v1'
    AND "chapterHash" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "long_form_chapters_text_check" CHECK (
    length("titleJson") BETWEEN 2 AND 10000
    AND length("titleNormalized") BETWEEN 1 AND 240
    AND length("topicPathJson") BETWEEN 2 AND 100000
    AND length("topicPathNormalized") BETWEEN 0 AND 100000
  )
);

CREATE UNIQUE INDEX "long_form_chapters_id_workspaceId_key"
  ON "long_form_chapters"("id", "workspaceId");
CREATE UNIQUE INDEX "long_form_chapters_indexRunId_sourceChapterId_key"
  ON "long_form_chapters"("indexRunId", "sourceChapterId");
CREATE UNIQUE INDEX "long_form_chapters_indexRunId_chapterHash_key"
  ON "long_form_chapters"("indexRunId", "chapterHash");
CREATE UNIQUE INDEX "long_form_chapters_indexRunId_ordinal_key"
  ON "long_form_chapters"("indexRunId", "ordinal");
CREATE INDEX "long_form_chapters_workspaceId_projectId_createdAt_idx"
  ON "long_form_chapters"("workspaceId", "projectId", "createdAt" DESC);
CREATE INDEX "long_form_chapters_workspaceId_indexRunId_startMs_idx"
  ON "long_form_chapters"("workspaceId", "indexRunId", "startMs");
CREATE INDEX "long_form_chapters_workspaceId_sourceArtifactId_startMs_idx"
  ON "long_form_chapters"(
    "workspaceId",
    "sourceArtifactId",
    "startMs"
  );
CREATE INDEX "long_form_chapters_workspaceId_titleNormalized_idx"
  ON "long_form_chapters"("workspaceId", "titleNormalized");

CREATE TABLE "long_form_moments" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "indexRunId" VARCHAR(128) NOT NULL,
  "chapterId" VARCHAR(128) NOT NULL,
  "sourceArtifactId" VARCHAR(128) NOT NULL,
  "sourceMomentId" VARCHAR(128) NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "topicJson" TEXT NOT NULL,
  "topicNormalized" VARCHAR(500) NOT NULL,
  "summaryJson" TEXT NOT NULL,
  "summaryNormalized" TEXT NOT NULL,
  "keyQuoteJson" TEXT,
  "keyQuoteNormalized" TEXT,
  "speakerIdsJson" TEXT NOT NULL,
  "speakersNormalized" TEXT NOT NULL,
  "rangesJson" TEXT NOT NULL,
  "recommendedRangeIndex" INTEGER NOT NULL,
  "recommendedStartMs" INTEGER NOT NULL,
  "recommendedEndMs" INTEGER NOT NULL,
  "evidenceSpanIdsJson" TEXT NOT NULL,
  "salience" DOUBLE PRECISION NOT NULL,
  "hookPotential" DOUBLE PRECISION NOT NULL,
  "standaloneScore" DOUBLE PRECISION NOT NULL,
  "contextScore" DOUBLE PRECISION NOT NULL,
  "insightDensity" DOUBLE PRECISION NOT NULL,
  "rolesJson" TEXT NOT NULL,
  "rolesNormalized" TEXT NOT NULL,
  "tagsJson" TEXT NOT NULL,
  "tagsNormalized" TEXT NOT NULL,
  "searchTextNormalized" TEXT NOT NULL,
  "physicalMaterialized" BOOLEAN NOT NULL DEFAULT FALSE,
  "indexPolicyVersion" VARCHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "momentHash" CHAR(64) NOT NULL,

  CONSTRAINT "long_form_moments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "long_form_moments_virtual_range_check" CHECK (
    "physicalMaterialized" = FALSE
    AND "ordinal" >= 0
    AND "recommendedRangeIndex" >= 0
    AND "recommendedStartMs" >= 0
    AND "recommendedEndMs" > "recommendedStartMs"
  ),
  CONSTRAINT "long_form_moments_scores_check" CHECK (
    "salience" BETWEEN 0 AND 1
    AND "hookPotential" BETWEEN 0 AND 1
    AND "standaloneScore" BETWEEN 0 AND 1
    AND "contextScore" BETWEEN 0 AND 1
    AND "insightDensity" BETWEEN 0 AND 1
  ),
  CONSTRAINT "long_form_moments_policy_hash_check" CHECK (
    "indexPolicyVersion" = 'long-form-index/v1'
    AND "momentHash" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "long_form_moments_text_check" CHECK (
    length("topicJson") BETWEEN 2 AND 10000
    AND length("topicNormalized") BETWEEN 1 AND 500
    AND length("summaryJson") BETWEEN 2 AND 100000
    AND length("summaryNormalized") BETWEEN 1 AND 100000
    AND ("keyQuoteJson" IS NULL OR length("keyQuoteJson") BETWEEN 2 AND 100000)
    AND ("keyQuoteNormalized" IS NULL OR length("keyQuoteNormalized") BETWEEN 1 AND 100000)
    AND length("speakerIdsJson") BETWEEN 2 AND 100000
    AND length("rangesJson") BETWEEN 2 AND 100000
    AND length("evidenceSpanIdsJson") BETWEEN 2 AND 100000
    AND length("rolesJson") BETWEEN 2 AND 100000
    AND length("tagsJson") BETWEEN 2 AND 100000
    AND length("searchTextNormalized") BETWEEN 1 AND 300000
  )
);

CREATE UNIQUE INDEX "long_form_moments_id_workspaceId_key"
  ON "long_form_moments"("id", "workspaceId");
CREATE UNIQUE INDEX "long_form_moments_indexRunId_sourceMomentId_key"
  ON "long_form_moments"("indexRunId", "sourceMomentId");
CREATE UNIQUE INDEX "long_form_moments_indexRunId_momentHash_key"
  ON "long_form_moments"("indexRunId", "momentHash");
CREATE UNIQUE INDEX "long_form_moments_indexRunId_ordinal_key"
  ON "long_form_moments"("indexRunId", "ordinal");
CREATE INDEX "long_form_moments_workspaceId_projectId_salience_createdAt_idx"
  ON "long_form_moments"(
    "workspaceId",
    "projectId",
    "salience" DESC,
    "createdAt" DESC
  );
CREATE INDEX "long_form_moments_workspaceId_indexRunId_recommendedStartMs_idx"
  ON "long_form_moments"(
    "workspaceId",
    "indexRunId",
    "recommendedStartMs"
  );
CREATE INDEX "long_form_moments_workspaceId_chapterId_salience_idx"
  ON "long_form_moments"(
    "workspaceId",
    "chapterId",
    "salience" DESC
  );
CREATE INDEX "long_form_moments_workspaceId_sourceArtifactId_recommendedS_idx"
  ON "long_form_moments"(
    "workspaceId",
    "sourceArtifactId",
    "recommendedStartMs"
  );
CREATE INDEX "long_form_moments_workspaceId_topicNormalized_idx"
  ON "long_form_moments"("workspaceId", "topicNormalized");

ALTER TABLE "long_form_index_runs"
  ADD CONSTRAINT "long_form_index_runs_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "long_form_index_runs"
  ADD CONSTRAINT "long_form_index_runs_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "long_form_index_runs"
  ADD CONSTRAINT "long_form_index_runs_sourceArtifactId_workspaceId_fkey"
  FOREIGN KEY ("sourceArtifactId", "workspaceId")
  REFERENCES "media_artifacts"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "long_form_index_runs"
  ADD CONSTRAINT "long_form_index_runs_sourceManifestId_workspaceId_fkey"
  FOREIGN KEY ("sourceManifestId", "workspaceId")
  REFERENCES "media_artifact_manifests"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "long_form_index_runs"
  ADD CONSTRAINT "long_form_index_runs_rightsSnapshotId_workspaceId_fkey"
  FOREIGN KEY ("rightsSnapshotId", "workspaceId")
  REFERENCES "asset_rights_snapshots"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "long_form_index_runs"
  ADD CONSTRAINT "long_form_index_runs_createdById_workspaceId_fkey"
  FOREIGN KEY ("createdById", "workspaceId")
  REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "long_form_chapters"
  ADD CONSTRAINT "long_form_chapters_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "long_form_chapters"
  ADD CONSTRAINT "long_form_chapters_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "long_form_chapters"
  ADD CONSTRAINT "long_form_chapters_indexRunId_workspaceId_fkey"
  FOREIGN KEY ("indexRunId", "workspaceId")
  REFERENCES "long_form_index_runs"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "long_form_chapters"
  ADD CONSTRAINT "long_form_chapters_sourceArtifactId_workspaceId_fkey"
  FOREIGN KEY ("sourceArtifactId", "workspaceId")
  REFERENCES "media_artifacts"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "long_form_moments"
  ADD CONSTRAINT "long_form_moments_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "long_form_moments"
  ADD CONSTRAINT "long_form_moments_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "long_form_moments"
  ADD CONSTRAINT "long_form_moments_indexRunId_workspaceId_fkey"
  FOREIGN KEY ("indexRunId", "workspaceId")
  REFERENCES "long_form_index_runs"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "long_form_moments"
  ADD CONSTRAINT "long_form_moments_chapterId_workspaceId_fkey"
  FOREIGN KEY ("chapterId", "workspaceId")
  REFERENCES "long_form_chapters"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "long_form_moments"
  ADD CONSTRAINT "long_form_moments_sourceArtifactId_workspaceId_fkey"
  FOREIGN KEY ("sourceArtifactId", "workspaceId")
  REFERENCES "media_artifacts"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
