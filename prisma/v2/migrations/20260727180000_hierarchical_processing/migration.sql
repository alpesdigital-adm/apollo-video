CREATE TABLE "hierarchical_processing_runs" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "sourceArtifactId" VARCHAR(128) NOT NULL,
  "sourceArtifactSha256" CHAR(64) NOT NULL,
  "sourceManifestId" VARCHAR(128) NOT NULL,
  "sourceManifestHash" CHAR(64) NOT NULL,
  "sourceTranscriptId" VARCHAR(128) NOT NULL,
  "sourceTranscriptHash" CHAR(64) NOT NULL,
  "durationMs" INTEGER NOT NULL,
  "rightsSnapshotId" VARCHAR(128) NOT NULL,
  "rightsStatus" VARCHAR(32) NOT NULL,
  "consentStatus" VARCHAR(32) NOT NULL,
  "processingPolicyVersion" VARCHAR(64) NOT NULL,
  "chunkPolicyVersion" VARCHAR(64) NOT NULL,
  "chunkDurationMs" INTEGER NOT NULL,
  "overlapMs" INTEGER NOT NULL,
  "tierVersionsJson" TEXT NOT NULL,
  "previousRunId" VARCHAR(128),
  "previousRunHash" CHAR(64),
  "planJson" TEXT NOT NULL,
  "evidenceSpansJson" TEXT NOT NULL,
  "visionObservationsJson" TEXT NOT NULL,
  "languageCandidatesJson" TEXT NOT NULL,
  "aggregationJson" TEXT NOT NULL,
  "budgetJson" TEXT NOT NULL,
  "measurementJson" TEXT NOT NULL,
  "chunkCount" INTEGER NOT NULL,
  "evidenceSpanCount" INTEGER NOT NULL,
  "chapterCount" INTEGER NOT NULL,
  "momentCount" INTEGER NOT NULL,
  "physicalMaterialized" BOOLEAN NOT NULL DEFAULT FALSE,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByType" VARCHAR(32) NOT NULL,
  "createdById" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "runHash" CHAR(64) NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT TRUE,

  CONSTRAINT "hierarchical_processing_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hierarchical_processing_runs_hashes_check" CHECK (
    "sourceArtifactSha256" ~ '^[a-f0-9]{64}$'
    AND "sourceManifestHash" ~ '^[a-f0-9]{64}$'
    AND "sourceTranscriptHash" ~ '^[a-f0-9]{64}$'
    AND (
      "previousRunHash" IS NULL
      OR "previousRunHash" ~ '^[a-f0-9]{64}$'
    )
    AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
    AND "runHash" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "hierarchical_processing_runs_policy_check" CHECK (
    "processingPolicyVersion" = 'hierarchical-processing/v1'
    AND "chunkPolicyVersion" = 'overlapping-time-chunks/v1'
    AND "createdByType" = 'api-client'
    AND "physicalMaterialized" = FALSE
  ),
  CONSTRAINT "hierarchical_processing_runs_bounds_check" CHECK (
    "durationMs" BETWEEN 1 AND 43200000
    AND "chunkDurationMs" BETWEEN 60000 AND 900000
    AND "overlapMs" BETWEEN 0 AND 60000
    AND "overlapMs" * 2 < "chunkDurationMs"
    AND "chunkCount" BETWEEN 1 AND 720
    AND "evidenceSpanCount" BETWEEN 1 AND 100000
    AND "chapterCount" BETWEEN 1 AND 10000
    AND "momentCount" BETWEEN 1 AND 100000
  ),
  CONSTRAINT "hierarchical_processing_runs_previous_check" CHECK (
    ("previousRunId" IS NULL AND "previousRunHash" IS NULL)
    OR ("previousRunId" IS NOT NULL AND "previousRunHash" IS NOT NULL)
  ),
  CONSTRAINT "hierarchical_processing_runs_rights_check" CHECK (
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
  CONSTRAINT "hierarchical_processing_runs_json_check" CHECK (
    length("tierVersionsJson") BETWEEN 2 AND 100000
    AND length("planJson") BETWEEN 2 AND 100000
    AND length("evidenceSpansJson") BETWEEN 2 AND 50000000
    AND length("visionObservationsJson") BETWEEN 2 AND 10000000
    AND length("languageCandidatesJson") BETWEEN 2 AND 50000000
    AND length("aggregationJson") BETWEEN 2 AND 50000000
    AND length("budgetJson") BETWEEN 2 AND 100000
    AND length("measurementJson") BETWEEN 2 AND 100000
  )
);

CREATE UNIQUE INDEX "hierarchical_processing_runs_id_workspaceId_key"
  ON "hierarchical_processing_runs"("id", "workspaceId");
CREATE UNIQUE INDEX "hierarchical_processing_runs_workspaceId_projectId_idempote_key"
  ON "hierarchical_processing_runs"(
    "workspaceId",
    "projectId",
    "idempotencyKey"
  );
CREATE UNIQUE INDEX "hierarchical_processing_runs_workspaceId_runHash_key"
  ON "hierarchical_processing_runs"("workspaceId", "runHash");
CREATE UNIQUE INDEX "hierarchical_processing_runs_one_active_source_key"
  ON "hierarchical_processing_runs"(
    "workspaceId",
    "projectId",
    "sourceArtifactId",
    "sourceTranscriptId"
  )
  WHERE "active" = TRUE;
CREATE INDEX "hierarchical_processing_runs_workspaceId_projectId_active_c_idx"
  ON "hierarchical_processing_runs"(
    "workspaceId",
    "projectId",
    "active",
    "createdAt" DESC
  );
CREATE INDEX "hierarchical_processing_runs_workspaceId_sourceArtifactId_a_idx"
  ON "hierarchical_processing_runs"(
    "workspaceId",
    "sourceArtifactId",
    "active",
    "createdAt" DESC
  );
CREATE INDEX "hierarchical_processing_runs_workspaceId_sourceTranscriptId_idx"
  ON "hierarchical_processing_runs"(
    "workspaceId",
    "sourceTranscriptId",
    "active",
    "createdAt" DESC
  );
CREATE INDEX "hierarchical_processing_runs_workspaceId_previousRunId_idx"
  ON "hierarchical_processing_runs"("workspaceId", "previousRunId");
CREATE INDEX "hierarchical_processing_runs_workspaceId_rightsSnapshotId_idx"
  ON "hierarchical_processing_runs"("workspaceId", "rightsSnapshotId");

CREATE TABLE "hierarchical_processing_chunks" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "runId" VARCHAR(128) NOT NULL,
  "sourceArtifactId" VARCHAR(128) NOT NULL,
  "sequence" INTEGER NOT NULL,
  "coreStartMs" INTEGER NOT NULL,
  "coreEndMs" INTEGER NOT NULL,
  "sourceStartMs" INTEGER NOT NULL,
  "sourceEndMs" INTEGER NOT NULL,
  "overlapBeforeMs" INTEGER NOT NULL,
  "overlapAfterMs" INTEGER NOT NULL,
  "evidenceSpanIdsJson" TEXT NOT NULL,
  "wordCount" INTEGER NOT NULL,
  "segmentCount" INTEGER NOT NULL,
  "speechMs" INTEGER NOT NULL,
  "physicalMaterialized" BOOLEAN NOT NULL DEFAULT FALSE,
  "chunkHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "hierarchical_processing_chunks_pkey" PRIMARY KEY ("runId", "id"),
  CONSTRAINT "hierarchical_processing_chunks_range_check" CHECK (
    "sequence" >= 0
    AND "sourceStartMs" >= 0
    AND "sourceStartMs" <= "coreStartMs"
    AND "coreEndMs" > "coreStartMs"
    AND "sourceEndMs" >= "coreEndMs"
    AND "overlapBeforeMs" = "coreStartMs" - "sourceStartMs"
    AND "overlapAfterMs" = "sourceEndMs" - "coreEndMs"
    AND "wordCount" >= 0
    AND "segmentCount" >= 0
    AND "speechMs" >= 0
    AND "physicalMaterialized" = FALSE
  ),
  CONSTRAINT "hierarchical_processing_chunks_hash_json_check" CHECK (
    "chunkHash" ~ '^[a-f0-9]{64}$'
    AND length("evidenceSpanIdsJson") BETWEEN 2 AND 10000000
  )
);

CREATE UNIQUE INDEX "hierarchical_processing_chunks_runId_sequence_key"
  ON "hierarchical_processing_chunks"("runId", "sequence");
CREATE UNIQUE INDEX "hierarchical_processing_chunks_runId_chunkHash_key"
  ON "hierarchical_processing_chunks"("runId", "chunkHash");
CREATE INDEX "hierarchical_processing_chunks_workspaceId_projectId_coreSt_idx"
  ON "hierarchical_processing_chunks"(
    "workspaceId",
    "projectId",
    "coreStartMs"
  );
CREATE INDEX "hierarchical_processing_chunks_workspaceId_runId_sequence_idx"
  ON "hierarchical_processing_chunks"(
    "workspaceId",
    "runId",
    "sequence"
  );
CREATE INDEX "hierarchical_processing_chunks_workspaceId_sourceArtifactId_idx"
  ON "hierarchical_processing_chunks"(
    "workspaceId",
    "sourceArtifactId",
    "sourceStartMs"
  );

CREATE TABLE "hierarchical_tier_executions" (
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "runId" VARCHAR(128) NOT NULL,
  "tier" VARCHAR(32) NOT NULL,
  "sequence" INTEGER NOT NULL,
  "provider" VARCHAR(64) NOT NULL,
  "model" VARCHAR(128) NOT NULL,
  "version" VARCHAR(64) NOT NULL,
  "prerequisitesJson" TEXT NOT NULL,
  "status" VARCHAR(16) NOT NULL,
  "reusedFromRunId" VARCHAR(128),
  "startedAt" TIMESTAMPTZ(3) NOT NULL,
  "completedAt" TIMESTAMPTZ(3) NOT NULL,
  "elapsedMs" INTEGER NOT NULL,
  "workingSetBytes" BIGINT NOT NULL,
  "costMinorUnits" INTEGER NOT NULL,
  "outputHash" CHAR(64) NOT NULL,

  CONSTRAINT "hierarchical_tier_executions_pkey"
    PRIMARY KEY ("runId", "tier"),
  CONSTRAINT "hierarchical_tier_executions_tier_check" CHECK (
    "tier" IN ('cheap-signals', 'vision', 'language', 'aggregation')
    AND "sequence" BETWEEN 0 AND 3
    AND (
      ("tier" = 'cheap-signals' AND "sequence" = 0)
      OR ("tier" = 'vision' AND "sequence" = 1)
      OR ("tier" = 'language' AND "sequence" = 2)
      OR ("tier" = 'aggregation' AND "sequence" = 3)
    )
  ),
  CONSTRAINT "hierarchical_tier_executions_status_check" CHECK (
    (
      "status" = 'processed'
      AND "reusedFromRunId" IS NULL
      AND "elapsedMs" >= 1
    )
    OR (
      "status" = 'reused'
      AND "reusedFromRunId" IS NOT NULL
      AND "elapsedMs" = 0
      AND "workingSetBytes" = 0
      AND "costMinorUnits" = 0
    )
  ),
  CONSTRAINT "hierarchical_tier_executions_bounds_check" CHECK (
    "completedAt" >= "startedAt"
    AND "workingSetBytes" >= 0
    AND "costMinorUnits" >= 0
    AND "outputHash" ~ '^[a-f0-9]{64}$'
    AND length("prerequisitesJson") BETWEEN 2 AND 10000
  )
);

CREATE UNIQUE INDEX "hierarchical_tier_executions_workspaceId_runId_sequence_key"
  ON "hierarchical_tier_executions"(
    "workspaceId",
    "runId",
    "sequence"
  );
CREATE INDEX "hierarchical_tier_executions_workspaceId_projectId_tier_sta_idx"
  ON "hierarchical_tier_executions"(
    "workspaceId",
    "projectId",
    "tier",
    "status"
  );
CREATE INDEX "hierarchical_tier_executions_workspaceId_reusedFromRunId_idx"
  ON "hierarchical_tier_executions"(
    "workspaceId",
    "reusedFromRunId"
  );

ALTER TABLE "hierarchical_processing_runs"
  ADD CONSTRAINT "hierarchical_processing_runs_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hierarchical_processing_runs"
  ADD CONSTRAINT "hierarchical_processing_runs_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hierarchical_processing_runs"
  ADD CONSTRAINT "hierarchical_processing_runs_sourceArtifactId_workspaceId_fkey"
  FOREIGN KEY ("sourceArtifactId", "workspaceId")
  REFERENCES "media_artifacts"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hierarchical_processing_runs"
  ADD CONSTRAINT "hierarchical_processing_runs_sourceManifestId_workspaceId_fkey"
  FOREIGN KEY ("sourceManifestId", "workspaceId")
  REFERENCES "media_artifact_manifests"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hierarchical_processing_runs"
  ADD CONSTRAINT "hierarchical_processing_runs_sourceTranscriptId_workspaceI_fkey"
  FOREIGN KEY ("sourceTranscriptId", "workspaceId")
  REFERENCES "media_transcripts"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hierarchical_processing_runs"
  ADD CONSTRAINT "hierarchical_processing_runs_rightsSnapshotId_workspaceId_fkey"
  FOREIGN KEY ("rightsSnapshotId", "workspaceId")
  REFERENCES "asset_rights_snapshots"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hierarchical_processing_runs"
  ADD CONSTRAINT "hierarchical_processing_runs_createdById_workspaceId_fkey"
  FOREIGN KEY ("createdById", "workspaceId")
  REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hierarchical_processing_runs"
  ADD CONSTRAINT "hierarchical_processing_runs_previousRunId_workspaceId_fkey"
  FOREIGN KEY ("previousRunId", "workspaceId")
  REFERENCES "hierarchical_processing_runs"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "hierarchical_processing_chunks"
  ADD CONSTRAINT "hierarchical_processing_chunks_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hierarchical_processing_chunks"
  ADD CONSTRAINT "hierarchical_processing_chunks_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hierarchical_processing_chunks"
  ADD CONSTRAINT "hierarchical_processing_chunks_runId_workspaceId_fkey"
  FOREIGN KEY ("runId", "workspaceId")
  REFERENCES "hierarchical_processing_runs"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hierarchical_processing_chunks"
  ADD CONSTRAINT "hierarchical_processing_chunks_sourceArtifactId_workspaceI_fkey"
  FOREIGN KEY ("sourceArtifactId", "workspaceId")
  REFERENCES "media_artifacts"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "hierarchical_tier_executions"
  ADD CONSTRAINT "hierarchical_tier_executions_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hierarchical_tier_executions"
  ADD CONSTRAINT "hierarchical_tier_executions_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hierarchical_tier_executions"
  ADD CONSTRAINT "hierarchical_tier_executions_runId_workspaceId_fkey"
  FOREIGN KEY ("runId", "workspaceId")
  REFERENCES "hierarchical_processing_runs"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
