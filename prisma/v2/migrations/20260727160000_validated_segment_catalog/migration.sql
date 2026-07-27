CREATE TABLE "validated_segments" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "sourceArtifactId" VARCHAR(128) NOT NULL,
  "sourceArtifactSha256" CHAR(64) NOT NULL,
  "sourceManifestId" VARCHAR(128) NOT NULL,
  "sourceManifestHash" CHAR(64) NOT NULL,
  "sourceSpeechSegmentId" VARCHAR(128),
  "sourceSpeechSegmentHash" CHAR(64),
  "scopeUnit" VARCHAR(32) NOT NULL,
  "evidenceScope" VARCHAR(32) NOT NULL,
  "wholeVideoValidated" BOOLEAN NOT NULL,
  "sourceJson" TEXT NOT NULL,
  "platformNormalized" VARCHAR(128) NOT NULL,
  "publicationRefNormalized" VARCHAR(240) NOT NULL,
  "performanceJson" TEXT NOT NULL,
  "metricNormalized" VARCHAR(128) NOT NULL,
  "protectedEnvelopeJson" TEXT NOT NULL,
  "protectedAspectsText" TEXT NOT NULL,
  "searchTextNormalized" TEXT NOT NULL,
  "rightsSnapshotId" VARCHAR(128) NOT NULL,
  "rightsStatus" VARCHAR(32) NOT NULL,
  "consentStatus" VARCHAR(32) NOT NULL,
  "validatedAt" TIMESTAMPTZ(3) NOT NULL,
  "expiresAt" TIMESTAMPTZ(3),
  "claimPolicyVersion" VARCHAR(64) NOT NULL,
  "causalClaimAllowed" BOOLEAN NOT NULL DEFAULT FALSE,
  "policyVersion" VARCHAR(64) NOT NULL,
  "physicalMaterialized" BOOLEAN NOT NULL DEFAULT FALSE,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByType" VARCHAR(32) NOT NULL,
  "createdById" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "validatedSegmentHash" CHAR(64) NOT NULL,

  CONSTRAINT "validated_segments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "validated_segments_hashes_check" CHECK (
    "sourceArtifactSha256" ~ '^[a-f0-9]{64}$'
    AND "sourceManifestHash" ~ '^[a-f0-9]{64}$'
    AND (
      (
        "sourceSpeechSegmentId" IS NULL
        AND "sourceSpeechSegmentHash" IS NULL
      )
      OR (
        "sourceSpeechSegmentId" IS NOT NULL
        AND "sourceSpeechSegmentHash" ~ '^[a-f0-9]{64}$'
      )
    )
    AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
    AND "validatedSegmentHash" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "validated_segments_scope_check" CHECK (
    "scopeUnit" IN ('hook', 'segment', 'whole-video')
    AND "evidenceScope" IN ('copy', 'spoken-take', 'opening-edit')
    AND "wholeVideoValidated" = ("scopeUnit" = 'whole-video')
    AND (
      (
        "scopeUnit" = 'whole-video'
        AND "sourceSpeechSegmentId" IS NULL
      )
      OR (
        "scopeUnit" <> 'whole-video'
        AND "sourceSpeechSegmentId" IS NOT NULL
      )
    )
  ),
  CONSTRAINT "validated_segments_policy_check" CHECK (
    "claimPolicyVersion" = 'historical-association/v1'
    AND "causalClaimAllowed" = FALSE
    AND "policyVersion" = 'validated-segment/v1'
    AND "physicalMaterialized" = FALSE
    AND "createdByType" = 'api-client'
  ),
  CONSTRAINT "validated_segments_rights_check" CHECK (
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
  CONSTRAINT "validated_segments_chronology_check" CHECK (
    "validatedAt" <= "createdAt"
    AND ("expiresAt" IS NULL OR "expiresAt" > "validatedAt")
  ),
  CONSTRAINT "validated_segments_text_check" CHECK (
    length("sourceJson") BETWEEN 2 AND 100000
    AND length("platformNormalized") BETWEEN 1 AND 128
    AND length("publicationRefNormalized") BETWEEN 1 AND 240
    AND length("performanceJson") BETWEEN 2 AND 100000
    AND length("metricNormalized") BETWEEN 1 AND 128
    AND length("protectedEnvelopeJson") BETWEEN 2 AND 100000
    AND length("protectedAspectsText") BETWEEN 3 AND 1000
    AND length("searchTextNormalized") BETWEEN 1 AND 300000
  )
);

CREATE UNIQUE INDEX "validated_segments_id_workspaceId_key"
  ON "validated_segments"("id", "workspaceId");
CREATE UNIQUE INDEX "validated_segments_workspaceId_projectId_idempotencyKey_key"
  ON "validated_segments"(
    "workspaceId",
    "projectId",
    "idempotencyKey"
  );
CREATE UNIQUE INDEX "validated_segments_workspaceId_validatedSegmentHash_key"
  ON "validated_segments"("workspaceId", "validatedSegmentHash");
CREATE INDEX "validated_segments_workspaceId_projectId_validatedAt_idx"
  ON "validated_segments"(
    "workspaceId",
    "projectId",
    "validatedAt" DESC
  );
CREATE INDEX "validated_segments_workspaceId_sourceArtifactId_validatedAt_idx"
  ON "validated_segments"(
    "workspaceId",
    "sourceArtifactId",
    "validatedAt" DESC
  );
CREATE INDEX "validated_segments_workspaceId_sourceSpeechSegmentId_idx"
  ON "validated_segments"("workspaceId", "sourceSpeechSegmentId");
CREATE INDEX "validated_segments_workspaceId_platformNormalized_idx"
  ON "validated_segments"("workspaceId", "platformNormalized");
CREATE INDEX "validated_segments_workspaceId_scopeUnit_evidenceScope_idx"
  ON "validated_segments"(
    "workspaceId",
    "scopeUnit",
    "evidenceScope"
  );
CREATE INDEX "validated_segments_workspaceId_metricNormalized_idx"
  ON "validated_segments"("workspaceId", "metricNormalized");
CREATE INDEX "validated_segments_workspaceId_expiresAt_idx"
  ON "validated_segments"("workspaceId", "expiresAt");
CREATE INDEX "validated_segments_workspaceId_rightsSnapshotId_idx"
  ON "validated_segments"("workspaceId", "rightsSnapshotId");

ALTER TABLE "validated_segments"
  ADD CONSTRAINT "validated_segments_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "validated_segments"
  ADD CONSTRAINT "validated_segments_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId")
  REFERENCES "projects"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "validated_segments"
  ADD CONSTRAINT "validated_segments_sourceArtifactId_workspaceId_fkey"
  FOREIGN KEY ("sourceArtifactId", "workspaceId")
  REFERENCES "media_artifacts"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "validated_segments"
  ADD CONSTRAINT "validated_segments_sourceManifestId_workspaceId_fkey"
  FOREIGN KEY ("sourceManifestId", "workspaceId")
  REFERENCES "media_artifact_manifests"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "validated_segments"
  ADD CONSTRAINT "validated_segments_sourceSpeechSegmentId_workspaceId_fkey"
  FOREIGN KEY ("sourceSpeechSegmentId", "workspaceId")
  REFERENCES "speech_segments"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "validated_segments"
  ADD CONSTRAINT "validated_segments_rightsSnapshotId_workspaceId_fkey"
  FOREIGN KEY ("rightsSnapshotId", "workspaceId")
  REFERENCES "asset_rights_snapshots"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "validated_segments"
  ADD CONSTRAINT "validated_segments_createdById_workspaceId_fkey"
  FOREIGN KEY ("createdById", "workspaceId")
  REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
