CREATE TABLE "evidence_segments" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "sourceSpeechSegmentId" VARCHAR(128) NOT NULL,
  "sourceSpeechSegmentHash" CHAR(64) NOT NULL,
  "sourceTranscriptId" VARCHAR(128) NOT NULL,
  "sourceTranscriptHash" CHAR(64) NOT NULL,
  "sourceArtifactId" VARCHAR(128) NOT NULL,
  "rightsSnapshotId" VARCHAR(128) NOT NULL,
  "rightsStatus" VARCHAR(32) NOT NULL,
  "consentStatus" VARCHAR(32) NOT NULL,
  "category" VARCHAR(32) NOT NULL,
  "speakerJson" TEXT NOT NULL,
  "speakerId" VARCHAR(240) NOT NULL,
  "claimJson" TEXT NOT NULL,
  "claimNormalized" TEXT NOT NULL,
  "resultJson" TEXT,
  "resultNormalized" TEXT,
  "contextJson" TEXT NOT NULL,
  "contextNormalized" TEXT NOT NULL,
  "qualifiersJson" TEXT NOT NULL,
  "qualifiersNormalized" TEXT NOT NULL,
  "subjectJson" TEXT NOT NULL,
  "subjectNormalized" VARCHAR(240) NOT NULL,
  "attributionJson" TEXT NOT NULL,
  "attributionNormalized" VARCHAR(240) NOT NULL,
  "compatibleOfferIdsJson" TEXT NOT NULL,
  "compatibleAudienceTagsJson" TEXT NOT NULL,
  "compatibleObjectionsJson" TEXT NOT NULL,
  "objectionsNormalized" TEXT NOT NULL,
  "credibilityScore" DOUBLE PRECISION NOT NULL,
  "specificityScore" DOUBLE PRECISION NOT NULL,
  "authenticityScore" DOUBLE PRECISION NOT NULL,
  "sourceStartMs" INTEGER NOT NULL,
  "sourceEndMs" INTEGER NOT NULL,
  "contextStartMs" INTEGER NOT NULL,
  "contextEndMs" INTEGER NOT NULL,
  "handleBeforeMs" INTEGER NOT NULL,
  "handleAfterMs" INTEGER NOT NULL,
  "exactTranscript" TEXT NOT NULL,
  "frameRefsJson" TEXT NOT NULL,
  "adjacentEvidenceIdsJson" TEXT NOT NULL,
  "requiresContext" BOOLEAN NOT NULL,
  "integrityStatus" VARCHAR(32) NOT NULL,
  "integrityReasonsJson" TEXT NOT NULL,
  "producerJson" TEXT NOT NULL,
  "integrityPolicyVersion" VARCHAR(64) NOT NULL,
  "physicalMaterialized" BOOLEAN NOT NULL DEFAULT FALSE,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByType" VARCHAR(32) NOT NULL,
  "createdById" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "evidenceHash" CHAR(64) NOT NULL,

  CONSTRAINT "evidence_segments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "evidence_segments_hashes_check" CHECK (
    "sourceSpeechSegmentHash" ~ '^[a-f0-9]{64}$'
    AND "sourceTranscriptHash" ~ '^[a-f0-9]{64}$'
    AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
    AND "evidenceHash" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "evidence_segments_category_check" CHECK (
    "category" IN (
      'testimonial',
      'financial-result',
      'before-after',
      'hearsay',
      'authority',
      'case-study',
      'demonstration'
    )
  ),
  CONSTRAINT "evidence_segments_rights_check" CHECK (
    "rightsStatus" IN (
      'approved',
      'restricted',
      'unknown',
      'expired',
      'revoked'
    )
    AND "consentStatus" IN (
      'not-required',
      'approved',
      'restricted',
      'unknown',
      'expired',
      'revoked'
    )
  ),
  CONSTRAINT "evidence_segments_scores_check" CHECK (
    "credibilityScore" BETWEEN 0 AND 1
    AND "specificityScore" BETWEEN 0 AND 1
    AND "authenticityScore" BETWEEN 0 AND 1
  ),
  CONSTRAINT "evidence_segments_ranges_check" CHECK (
    "sourceStartMs" >= 0
    AND "sourceEndMs" > "sourceStartMs"
    AND "contextStartMs" >= 0
    AND "contextStartMs" <= "sourceStartMs"
    AND "contextEndMs" >= "sourceEndMs"
    AND "handleBeforeMs" = "sourceStartMs" - "contextStartMs"
    AND "handleAfterMs" = "contextEndMs" - "sourceEndMs"
  ),
  CONSTRAINT "evidence_segments_integrity_check" CHECK (
    "integrityStatus" IN ('valid', 'context-required', 'blocked')
    AND (
      "integrityStatus" <> 'valid'
      OR "requiresContext" = FALSE
    )
    AND (
      "integrityStatus" <> 'context-required'
      OR "requiresContext" = TRUE
    )
  ),
  CONSTRAINT "evidence_segments_policy_check" CHECK (
    "integrityPolicyVersion" = 'evidence-integrity/v1'
    AND "createdByType" = 'api-client'
    AND "physicalMaterialized" = FALSE
  ),
  CONSTRAINT "evidence_segments_text_bounds_check" CHECK (
    length("exactTranscript") BETWEEN 1 AND 10000
    AND length("claimNormalized") BETWEEN 1 AND 2000
    AND length("contextNormalized") BETWEEN 1 AND 2000
    AND length("subjectNormalized") BETWEEN 1 AND 240
    AND length("attributionNormalized") BETWEEN 1 AND 240
    AND length("speakerJson") BETWEEN 2 AND 10000
    AND length("claimJson") BETWEEN 2 AND 10000
    AND length("contextJson") BETWEEN 2 AND 10000
    AND length("qualifiersJson") BETWEEN 2 AND 100000
    AND length("subjectJson") BETWEEN 2 AND 10000
    AND length("attributionJson") BETWEEN 2 AND 10000
    AND length("producerJson") BETWEEN 2 AND 10000
    AND (
      ("resultJson" IS NULL AND "resultNormalized" IS NULL)
      OR (
        "resultJson" IS NOT NULL
        AND "resultNormalized" IS NOT NULL
        AND length("resultNormalized") BETWEEN 1 AND 2000
      )
    )
  )
);

CREATE UNIQUE INDEX "evidence_segments_id_workspaceId_key"
  ON "evidence_segments"("id", "workspaceId");
CREATE UNIQUE INDEX "evidence_segments_workspaceId_projectId_idempotencyKey_key"
  ON "evidence_segments"("workspaceId", "projectId", "idempotencyKey");
CREATE UNIQUE INDEX "evidence_segments_workspaceId_evidenceHash_key"
  ON "evidence_segments"("workspaceId", "evidenceHash");
CREATE INDEX "evidence_segments_workspaceId_projectId_createdAt_idx"
  ON "evidence_segments"("workspaceId", "projectId", "createdAt" DESC);
CREATE INDEX "evidence_segments_workspaceId_sourceSpeechSegmentId_idx"
  ON "evidence_segments"("workspaceId", "sourceSpeechSegmentId");
CREATE INDEX "evidence_segments_workspaceId_sourceArtifactId_sourceStartM_idx"
  ON "evidence_segments"("workspaceId", "sourceArtifactId", "sourceStartMs");
CREATE INDEX "evidence_segments_workspaceId_category_integrityStatus_idx"
  ON "evidence_segments"("workspaceId", "category", "integrityStatus");
CREATE INDEX "evidence_segments_workspaceId_subjectNormalized_idx"
  ON "evidence_segments"("workspaceId", "subjectNormalized");
CREATE INDEX "evidence_segments_workspaceId_attributionNormalized_idx"
  ON "evidence_segments"("workspaceId", "attributionNormalized");
CREATE INDEX "evidence_segments_workspaceId_rightsSnapshotId_idx"
  ON "evidence_segments"("workspaceId", "rightsSnapshotId");

ALTER TABLE "evidence_segments"
  ADD CONSTRAINT "evidence_segments_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "evidence_segments"
  ADD CONSTRAINT "evidence_segments_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "evidence_segments"
  ADD CONSTRAINT "evidence_segments_sourceSpeechSegmentId_workspaceId_fkey"
  FOREIGN KEY ("sourceSpeechSegmentId", "workspaceId")
  REFERENCES "speech_segments"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "evidence_segments"
  ADD CONSTRAINT "evidence_segments_sourceTranscriptId_workspaceId_fkey"
  FOREIGN KEY ("sourceTranscriptId", "workspaceId")
  REFERENCES "media_transcripts"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "evidence_segments"
  ADD CONSTRAINT "evidence_segments_sourceArtifactId_workspaceId_fkey"
  FOREIGN KEY ("sourceArtifactId", "workspaceId")
  REFERENCES "media_artifacts"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "evidence_segments"
  ADD CONSTRAINT "evidence_segments_rightsSnapshotId_workspaceId_fkey"
  FOREIGN KEY ("rightsSnapshotId", "workspaceId")
  REFERENCES "asset_rights_snapshots"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "evidence_segments"
  ADD CONSTRAINT "evidence_segments_createdById_workspaceId_fkey"
  FOREIGN KEY ("createdById", "workspaceId")
  REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
