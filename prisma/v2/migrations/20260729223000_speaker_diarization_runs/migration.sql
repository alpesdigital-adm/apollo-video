CREATE TABLE "speaker_diarization_runs" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "workflowId" VARCHAR(128) NOT NULL,
  "sourceArtifactId" VARCHAR(128) NOT NULL,
  "sourceArtifactSha256" CHAR(64) NOT NULL,
  "sourceManifestId" VARCHAR(128) NOT NULL,
  "sourceManifestHash" CHAR(64) NOT NULL,
  "sourceTranscriptId" VARCHAR(128) NOT NULL,
  "sourceTranscriptHash" CHAR(64) NOT NULL,
  "durationMs" INTEGER NOT NULL,
  "providerInputJson" TEXT NOT NULL,
  "providerInputHash" CHAR(64) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "policyVersion" VARCHAR(64) NOT NULL,
  "providerId" VARCHAR(128) NOT NULL,
  "providerModel" VARCHAR(128) NOT NULL,
  "providerVersion" VARCHAR(128) NOT NULL,
  "speakerCount" INTEGER NOT NULL,
  "segmentCount" INTEGER NOT NULL,
  "usageSeconds" INTEGER NOT NULL,
  "costMinorUnits" INTEGER NOT NULL,
  "elapsedMs" INTEGER NOT NULL,
  "identityResolved" BOOLEAN NOT NULL,
  "physicalMaterialized" BOOLEAN NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "runJson" TEXT NOT NULL,
  "runHash" CHAR(64) NOT NULL,

  CONSTRAINT "speaker_diarization_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "speaker_diarization_runs_version_check" CHECK (
    "schemaVersion" = 'speaker-diarization-run/v1'
    AND "policyVersion" = 'anonymous-speaker-clusters/v1'
  ),
  CONSTRAINT "speaker_diarization_runs_source_check" CHECK (
    "sourceArtifactSha256" ~ '^[a-f0-9]{64}$'
    AND "sourceManifestHash" ~ '^[a-f0-9]{64}$'
    AND "sourceTranscriptHash" ~ '^[a-f0-9]{64}$'
    AND "providerInputHash" ~ '^[a-f0-9]{64}$'
    AND "durationMs" BETWEEN 1000 AND 43200000
    AND length("providerInputJson") BETWEEN 2 AND 5000
  ),
  CONSTRAINT "speaker_diarization_runs_result_check" CHECK (
    "speakerCount" BETWEEN 1 AND 100000
    AND "segmentCount" BETWEEN "speakerCount" AND 100000
    AND "usageSeconds" BETWEEN 1 AND 43200
    AND "costMinorUnits" BETWEEN 0 AND 10000000
    AND "elapsedMs" BETWEEN 0 AND 86400000
    AND NOT "identityResolved"
    AND NOT "physicalMaterialized"
  ),
  CONSTRAINT "speaker_diarization_runs_integrity_check" CHECK (
    "requestFingerprint" ~ '^[a-f0-9]{64}$'
    AND "runHash" ~ '^[a-f0-9]{64}$'
    AND length("idempotencyKey") BETWEEN 8 AND 128
    AND length("runJson") BETWEEN 2 AND 10000000
  )
);

CREATE TABLE "speaker_diarization_segments" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "runId" VARCHAR(128) NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "providerSegmentId" VARCHAR(128) NOT NULL,
  "providerLabel" VARCHAR(128) NOT NULL,
  "speakerKey" VARCHAR(128) NOT NULL,
  "startMs" INTEGER NOT NULL,
  "endMs" INTEGER NOT NULL,
  "text" TEXT NOT NULL,
  "textHash" CHAR(64) NOT NULL,
  "segmentJson" TEXT NOT NULL,
  "segmentHash" CHAR(64) NOT NULL,

  CONSTRAINT "speaker_diarization_segments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "speaker_diarization_segments_timing_check" CHECK (
    "ordinal" >= 0
    AND "startMs" >= 0
    AND "endMs" > "startMs"
  ),
  CONSTRAINT "speaker_diarization_segments_integrity_check" CHECK (
    "textHash" ~ '^[a-f0-9]{64}$'
    AND "segmentHash" ~ '^[a-f0-9]{64}$'
    AND length("text") BETWEEN 1 AND 10000
    AND length("segmentJson") BETWEEN 2 AND 50000
    AND "providerLabel" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND "speakerKey" ~ '^speaker-cluster-[a-f0-9]{40}$'
  )
);

CREATE UNIQUE INDEX "speaker_diarization_runs_id_workspaceId_key"
  ON "speaker_diarization_runs"("id", "workspaceId");
CREATE UNIQUE INDEX "speaker_diarization_runs_id_workspaceId_projectId_key"
  ON "speaker_diarization_runs"("id", "workspaceId", "projectId");
CREATE UNIQUE INDEX "speaker_diarization_runs_workspaceId_workflowId_idempotency_key"
  ON "speaker_diarization_runs"(
    "workspaceId",
    "workflowId",
    "idempotencyKey"
  );
CREATE INDEX "speaker_diarization_runs_workspaceId_projectId_createdAt_idx"
  ON "speaker_diarization_runs"(
    "workspaceId",
    "projectId",
    "createdAt" DESC
  );
CREATE INDEX "speaker_diarization_runs_workspaceId_sourceArtifactId_creat_idx"
  ON "speaker_diarization_runs"(
    "workspaceId",
    "sourceArtifactId",
    "createdAt" DESC
  );

CREATE UNIQUE INDEX "speaker_diarization_segments_runId_ordinal_key"
  ON "speaker_diarization_segments"("runId", "ordinal");
CREATE UNIQUE INDEX "speaker_diarization_segments_runId_providerSegmentId_key"
  ON "speaker_diarization_segments"("runId", "providerSegmentId");
CREATE INDEX "speaker_diarization_segments_workspaceId_projectId_runId_or_idx"
  ON "speaker_diarization_segments"(
    "workspaceId",
    "projectId",
    "runId",
    "ordinal"
  );
CREATE INDEX "speaker_diarization_segments_workspaceId_speakerKey_startMs_idx"
  ON "speaker_diarization_segments"(
    "workspaceId",
    "speakerKey",
    "startMs"
  );

ALTER TABLE "speaker_diarization_runs"
  ADD CONSTRAINT "speaker_diarization_runs_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "speaker_diarization_runs"
  ADD CONSTRAINT "speaker_diarization_runs_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "speaker_diarization_runs"
  ADD CONSTRAINT "speaker_diarization_runs_workflowId_workspaceId_projectId_fkey"
  FOREIGN KEY ("workflowId", "workspaceId", "projectId")
  REFERENCES "long_form_index_workflows"(
    "id",
    "workspaceId",
    "projectId"
  )
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "speaker_diarization_runs"
  ADD CONSTRAINT "speaker_diarization_runs_sourceArtifactId_workspaceId_fkey"
  FOREIGN KEY ("sourceArtifactId", "workspaceId")
  REFERENCES "media_artifacts"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "speaker_diarization_runs"
  ADD CONSTRAINT "speaker_diarization_runs_sourceManifestId_workspaceId_fkey"
  FOREIGN KEY ("sourceManifestId", "workspaceId")
  REFERENCES "media_artifact_manifests"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "speaker_diarization_runs"
  ADD CONSTRAINT "speaker_diarization_runs_sourceTranscriptId_workspaceId_fkey"
  FOREIGN KEY ("sourceTranscriptId", "workspaceId")
  REFERENCES "media_transcripts"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "speaker_diarization_runs"
  ADD CONSTRAINT "speaker_diarization_runs_createdByClientId_workspaceId_fkey"
  FOREIGN KEY ("createdByClientId", "workspaceId")
  REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "speaker_diarization_segments"
  ADD CONSTRAINT "speaker_diarization_segments_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "speaker_diarization_segments"
  ADD CONSTRAINT "speaker_diarization_segments_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "speaker_diarization_segments"
  ADD CONSTRAINT "speaker_diarization_segments_runId_workspaceId_projectId_fkey"
  FOREIGN KEY ("runId", "workspaceId", "projectId")
  REFERENCES "speaker_diarization_runs"(
    "id",
    "workspaceId",
    "projectId"
  )
  ON DELETE CASCADE ON UPDATE CASCADE;
