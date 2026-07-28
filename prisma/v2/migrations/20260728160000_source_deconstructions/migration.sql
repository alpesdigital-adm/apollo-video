CREATE TABLE "source_deconstruction_reports" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "sourceArtifactId" VARCHAR(128) NOT NULL,
  "sourceArtifactSha256" CHAR(64) NOT NULL,
  "sourceTranscriptId" VARCHAR(128) NOT NULL,
  "sourceTranscriptHash" CHAR(64) NOT NULL,
  "sourceDurationMs" INTEGER NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "policyVersion" VARCHAR(64) NOT NULL,
  "analyzerVersion" VARCHAR(64) NOT NULL,
  "desiredRole" VARCHAR(16) NOT NULL,
  "validationScope" VARCHAR(24) NOT NULL,
  "targetCompositionJson" TEXT NOT NULL,
  "targetCompositionHash" CHAR(64) NOT NULL,
  "boundaryPolicyJson" TEXT NOT NULL,
  "boundaryPolicyHash" CHAR(64) NOT NULL,
  "reportJson" TEXT NOT NULL,
  "reportHash" CHAR(64) NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "editabilityScore" INTEGER NOT NULL,
  "decision" VARCHAR(24) NOT NULL,
  "contextPreserved" BOOLEAN NOT NULL,
  "segmentCount" INTEGER NOT NULL,
  "cleanRangeCount" INTEGER NOT NULL,
  "semanticContaminantCount" INTEGER NOT NULL,
  "cleanDurationMs" INTEGER NOT NULL,
  "removedDurationMs" INTEGER NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "source_deconstruction_reports_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "source_deconstruction_reports_versions_check" CHECK (
    "schemaVersion" = 'source-deconstruction-report/v1'
    AND "policyVersion" = 'source-deconstruction/v1'
    AND "analyzerVersion" = 'semantic-source-deconstructor/v1'
  ),
  CONSTRAINT "source_deconstruction_reports_request_check" CHECK (
    "desiredRole" IN ('hook', 'body', 'cta', 'complete')
    AND "validationScope" IN ('copy', 'take', 'opening-edit', 'full')
    AND length("idempotencyKey") BETWEEN 8 AND 128
  ),
  CONSTRAINT "source_deconstruction_reports_decision_check" CHECK (
    "confidence" BETWEEN 0 AND 1
    AND "editabilityScore" BETWEEN 0 AND 100
    AND (
      (
        "decision" = 'automatic'
        AND "editabilityScore" >= 70
        AND "contextPreserved"
      )
      OR (
        "decision" = 'human-review'
        AND "editabilityScore" >= 50
        AND (
          "editabilityScore" < 70
          OR NOT "contextPreserved"
        )
      )
      OR (
        "decision" = 'reject'
        AND "editabilityScore" < 50
      )
    )
  ),
  CONSTRAINT "source_deconstruction_reports_counts_check" CHECK (
    "sourceDurationMs" BETWEEN 1 AND 86400000
    AND "segmentCount" BETWEEN 1 AND 10000
    AND "cleanRangeCount" BETWEEN 1 AND 1000
    AND "semanticContaminantCount" BETWEEN 0 AND "segmentCount"
    AND "cleanDurationMs" BETWEEN 1 AND "sourceDurationMs"
    AND "removedDurationMs" = "sourceDurationMs" - "cleanDurationMs"
  ),
  CONSTRAINT "source_deconstruction_reports_json_check" CHECK (
    length("targetCompositionJson") BETWEEN 2 AND 100000
    AND length("boundaryPolicyJson") BETWEEN 2 AND 100000
    AND length("reportJson") BETWEEN 2 AND 10000000
  ),
  CONSTRAINT "source_deconstruction_reports_hash_check" CHECK (
    "sourceArtifactSha256" ~ '^[a-f0-9]{64}$'
    AND "sourceTranscriptHash" ~ '^[a-f0-9]{64}$'
    AND "targetCompositionHash" ~ '^[a-f0-9]{64}$'
    AND "boundaryPolicyHash" ~ '^[a-f0-9]{64}$'
    AND "reportHash" ~ '^[a-f0-9]{64}$'
    AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
  )
);

CREATE UNIQUE INDEX "source_deconstruction_reports_id_workspaceId_projectId_key"
  ON "source_deconstruction_reports"(
    "id",
    "workspaceId",
    "projectId"
  );
CREATE UNIQUE INDEX "source_deconstruction_reports_workspaceId_projectId_created_key"
  ON "source_deconstruction_reports"(
    "workspaceId",
    "projectId",
    "createdByClientId",
    "idempotencyKey"
  );
CREATE INDEX "source_deconstruction_reports_workspaceId_projectId_created_idx"
  ON "source_deconstruction_reports"(
    "workspaceId",
    "projectId",
    "createdAt" DESC,
    "id" DESC
  );
CREATE INDEX "source_deconstruction_reports_workspaceId_projectId_sourceA_idx"
  ON "source_deconstruction_reports"(
    "workspaceId",
    "projectId",
    "sourceArtifactId",
    "createdAt" DESC
  );
CREATE INDEX "source_deconstruction_reports_workspaceId_sourceTranscriptI_idx"
  ON "source_deconstruction_reports"(
    "workspaceId",
    "sourceTranscriptId",
    "createdAt" DESC
  );
CREATE INDEX "source_deconstruction_reports_workspaceId_decision_createdA_idx"
  ON "source_deconstruction_reports"(
    "workspaceId",
    "decision",
    "createdAt" DESC
  );

CREATE TABLE "source_deconstruction_segments" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "reportId" VARCHAR(128) NOT NULL,
  "sourceArtifactId" VARCHAR(128) NOT NULL,
  "sourceSpeechSegmentId" VARCHAR(128) NOT NULL,
  "sourceSegmentId" INTEGER NOT NULL,
  "startMs" INTEGER NOT NULL,
  "endMs" INTEGER NOT NULL,
  "semanticRole" VARCHAR(16) NOT NULL,
  "roleConfidence" DOUBLE PRECISION NOT NULL,
  "roleReasonCodesJson" TEXT NOT NULL,
  "essential" BOOLEAN NOT NULL,
  "included" BOOLEAN NOT NULL,
  "includedForContext" BOOLEAN NOT NULL,
  "completeThoughtScore" DOUBLE PRECISION NOT NULL,
  "classification" VARCHAR(24) NOT NULL,
  "exactText" TEXT NOT NULL,
  "normalizedText" TEXT NOT NULL,
  "sourceSegmentHash" CHAR(64) NOT NULL,
  "analysisHash" CHAR(64) NOT NULL,

  CONSTRAINT "source_deconstruction_segments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "source_deconstruction_segments_role_check" CHECK (
    "semanticRole" IN (
      'opening',
      'hook',
      'context',
      'body',
      'cta',
      'tail'
    )
    AND "roleConfidence" BETWEEN 0 AND 1
  ),
  CONSTRAINT "source_deconstruction_segments_state_check" CHECK (
    "classification" IN (
      'complete-thought',
      'incomplete',
      'interrupted'
    )
    AND "completeThoughtScore" BETWEEN 0 AND 1
    AND (NOT "essential" OR "included")
    AND (
      NOT "includedForContext"
      OR ("included" AND NOT "essential")
    )
  ),
  CONSTRAINT "source_deconstruction_segments_range_check" CHECK (
    "sourceSegmentId" BETWEEN 0 AND 10000000
    AND "startMs" >= 0
    AND "endMs" > "startMs"
  ),
  CONSTRAINT "source_deconstruction_segments_text_check" CHECK (
    length("exactText") BETWEEN 1 AND 10000
    AND length("normalizedText") BETWEEN 1 AND 10000
    AND length("roleReasonCodesJson") BETWEEN 2 AND 10000
  ),
  CONSTRAINT "source_deconstruction_segments_hash_check" CHECK (
    "sourceSegmentHash" ~ '^[a-f0-9]{64}$'
    AND "analysisHash" ~ '^[a-f0-9]{64}$'
  )
);

CREATE UNIQUE INDEX "source_deconstruction_segments_reportId_sourceSpeechSegment_key"
  ON "source_deconstruction_segments"(
    "reportId",
    "sourceSpeechSegmentId"
  );
CREATE UNIQUE INDEX "source_deconstruction_segments_reportId_sourceSegmentId_key"
  ON "source_deconstruction_segments"(
    "reportId",
    "sourceSegmentId"
  );
CREATE INDEX "source_deconstruction_segments_workspaceId_projectId_report_idx"
  ON "source_deconstruction_segments"(
    "workspaceId",
    "projectId",
    "reportId",
    "startMs"
  );
CREATE INDEX "source_deconstruction_segments_workspaceId_sourceArtifactId_idx"
  ON "source_deconstruction_segments"(
    "workspaceId",
    "sourceArtifactId",
    "startMs"
  );
CREATE INDEX "source_deconstruction_segments_workspaceId_semanticRole_inc_idx"
  ON "source_deconstruction_segments"(
    "workspaceId",
    "semanticRole",
    "included"
  );

CREATE TABLE "source_deconstruction_ranges" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "reportId" VARCHAR(128) NOT NULL,
  "sequence" INTEGER NOT NULL,
  "startMs" INTEGER NOT NULL,
  "endMs" INTEGER NOT NULL,
  "speechStartMs" INTEGER NOT NULL,
  "speechEndMs" INTEGER NOT NULL,
  "sourceSpeechSegmentIdsJson" TEXT NOT NULL,
  "rolesJson" TEXT NOT NULL,
  "exactText" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "contextPreserved" BOOLEAN NOT NULL,
  "boundaryReasonCodesJson" TEXT NOT NULL,
  "rangeHash" CHAR(64) NOT NULL,

  CONSTRAINT "source_deconstruction_ranges_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "source_deconstruction_ranges_timing_check" CHECK (
    "sequence" BETWEEN 0 AND 999
    AND "startMs" >= 0
    AND "endMs" > "startMs"
    AND "speechStartMs" >= "startMs"
    AND "speechEndMs" <= "endMs"
    AND "speechEndMs" > "speechStartMs"
  ),
  CONSTRAINT "source_deconstruction_ranges_content_check" CHECK (
    "confidence" BETWEEN 0 AND 1
    AND length("sourceSpeechSegmentIdsJson") BETWEEN 2 AND 1000000
    AND length("rolesJson") BETWEEN 2 AND 10000
    AND length("exactText") BETWEEN 1 AND 100000
    AND length("boundaryReasonCodesJson") BETWEEN 2 AND 10000
  ),
  CONSTRAINT "source_deconstruction_ranges_hash_check" CHECK (
    "rangeHash" ~ '^[a-f0-9]{64}$'
  )
);

CREATE UNIQUE INDEX "source_deconstruction_ranges_reportId_sequence_key"
  ON "source_deconstruction_ranges"("reportId", "sequence");
CREATE UNIQUE INDEX "source_deconstruction_ranges_reportId_id_key"
  ON "source_deconstruction_ranges"("reportId", "id");
CREATE INDEX "source_deconstruction_ranges_workspaceId_projectId_reportId_idx"
  ON "source_deconstruction_ranges"(
    "workspaceId",
    "projectId",
    "reportId",
    "sequence"
  );
CREATE INDEX "source_deconstruction_ranges_workspaceId_contextPreserved_c_idx"
  ON "source_deconstruction_ranges"(
    "workspaceId",
    "contextPreserved",
    "confidence" DESC
  );

ALTER TABLE "source_deconstruction_reports"
  ADD CONSTRAINT "source_deconstruction_reports_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "source_deconstruction_reports"
  ADD CONSTRAINT "source_deconstruction_reports_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "source_deconstruction_reports"
  ADD CONSTRAINT "source_deconstruction_reports_sourceArtifactId_workspaceId_fkey"
  FOREIGN KEY ("sourceArtifactId", "workspaceId")
  REFERENCES "media_artifacts"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "source_deconstruction_reports"
  ADD CONSTRAINT "source_deconstruction_reports_sourceTranscriptId_workspace_fkey"
  FOREIGN KEY ("sourceTranscriptId", "workspaceId")
  REFERENCES "media_transcripts"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "source_deconstruction_reports"
  ADD CONSTRAINT "source_deconstruction_reports_createdByClientId_workspaceI_fkey"
  FOREIGN KEY ("createdByClientId", "workspaceId")
  REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "source_deconstruction_segments"
  ADD CONSTRAINT "source_deconstruction_segments_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "source_deconstruction_segments"
  ADD CONSTRAINT "source_deconstruction_segments_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "source_deconstruction_segments"
  ADD CONSTRAINT "source_deconstruction_segments_reportId_workspaceId_projec_fkey"
  FOREIGN KEY ("reportId", "workspaceId", "projectId")
  REFERENCES "source_deconstruction_reports"(
    "id",
    "workspaceId",
    "projectId"
  )
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "source_deconstruction_segments"
  ADD CONSTRAINT "source_deconstruction_segments_sourceArtifactId_workspaceI_fkey"
  FOREIGN KEY ("sourceArtifactId", "workspaceId")
  REFERENCES "media_artifacts"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "source_deconstruction_segments"
  ADD CONSTRAINT "source_deconstruction_segments_sourceSpeechSegmentId_works_fkey"
  FOREIGN KEY ("sourceSpeechSegmentId", "workspaceId")
  REFERENCES "speech_segments"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "source_deconstruction_ranges"
  ADD CONSTRAINT "source_deconstruction_ranges_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "source_deconstruction_ranges"
  ADD CONSTRAINT "source_deconstruction_ranges_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "source_deconstruction_ranges"
  ADD CONSTRAINT "source_deconstruction_ranges_reportId_workspaceId_projectI_fkey"
  FOREIGN KEY ("reportId", "workspaceId", "projectId")
  REFERENCES "source_deconstruction_reports"(
    "id",
    "workspaceId",
    "projectId"
  )
  ON DELETE CASCADE ON UPDATE CASCADE;
