-- W65b: face evidence keyed by the SOURCE artifact's own frames (face-producer-envelope/v3).
-- Additive: the timeline-keyed tables of the W62 profile are untouched.

-- AlterTable
ALTER TABLE "face_producer_operations" ADD COLUMN     "windowStartSourceFrame" INTEGER,
ADD COLUMN     "windowEndSourceFrame" INTEGER;

-- CreateTable
CREATE TABLE "face_source_window_envelopes" (
    "id" VARCHAR(128) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "sourceArtifactId" VARCHAR(128) NOT NULL,
    "sourceSha256" CHAR(64) NOT NULL,
    "operationId" VARCHAR(128) NOT NULL,
    "operationAttempt" INTEGER NOT NULL,
    "operationFenceHash" CHAR(64) NOT NULL,
    "detectorConfigHash" CHAR(64) NOT NULL,
    "contentJson" TEXT NOT NULL,
    "envelopeHash" CHAR(64) NOT NULL,
    "schemaVersion" VARCHAR(64) NOT NULL DEFAULT 'face-producer-envelope/v3',
    "windowStartSourceFrame" INTEGER NOT NULL,
    "windowEndSourceFrame" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "face_source_window_envelopes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "face_source_window_raw_outputs" (
    "id" VARCHAR(128) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "envelopeId" VARCHAR(128) NOT NULL,
    "sampleIndex" INTEGER NOT NULL,
    "sourceFrame" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "rawBytes" BYTEA NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "face_source_window_raw_outputs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "face_source_window_envelopes_operationId_key" ON "face_source_window_envelopes"("operationId");

-- CreateIndex
CREATE INDEX "face_source_window_envelopes_window_idx" ON "face_source_window_envelopes"("workspaceId", "sourceArtifactId", "sourceSha256", "windowStartSourceFrame");

-- CreateIndex
CREATE UNIQUE INDEX "face_source_window_envelopes_id_workspaceId_key" ON "face_source_window_envelopes"("id", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "face_source_window_envelopes_operationId_workspaceId_key" ON "face_source_window_envelopes"("operationId", "workspaceId");

-- CreateIndex
CREATE INDEX "face_source_window_raw_outputs_workspaceId_envelopeId_idx" ON "face_source_window_raw_outputs"("workspaceId", "envelopeId");

-- CreateIndex
CREATE UNIQUE INDEX "face_source_window_raw_outputs_envelopeId_sampleIndex_key" ON "face_source_window_raw_outputs"("envelopeId", "sampleIndex");

-- AddForeignKey
ALTER TABLE "face_source_window_envelopes" ADD CONSTRAINT "face_source_window_envelopes_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "face_source_window_envelopes" ADD CONSTRAINT "face_source_window_envelopes_operationId_workspaceId_fkey" FOREIGN KEY ("operationId", "workspaceId") REFERENCES "public_operations"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "face_source_window_envelopes" ADD CONSTRAINT "face_source_window_envelopes_sourceArtifactId_workspaceId_fkey" FOREIGN KEY ("sourceArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "face_source_window_raw_outputs" ADD CONSTRAINT "face_source_window_raw_outputs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "face_source_window_raw_outputs" ADD CONSTRAINT "face_source_window_raw_outputs_envelopeId_workspaceId_fkey" FOREIGN KEY ("envelopeId", "workspaceId") REFERENCES "face_source_window_envelopes"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The operation row now knows three profiles. The YuNet diagnostic has no window; the V9 timeline profile (W62) a bounded window of
-- TIMELINE frames; the V9 source profile (W65b) a bounded window of SOURCE frames and none on the timeline.
ALTER TABLE "face_producer_operations" DROP CONSTRAINT "face_producer_operations_profile_window_check";
ALTER TABLE "face_producer_operations"
  ADD CONSTRAINT "face_producer_operations_profile_window_check" CHECK (
    ("detectorProfile" = 'yunet-v5-diagnostic'
      AND "windowStartTimelineFrame" IS NULL AND "windowEndTimelineFrame" IS NULL
      AND "windowStartSourceFrame" IS NULL AND "windowEndSourceFrame" IS NULL)
    OR ("detectorProfile" = 'openvino-face0204-v9'
      AND "windowStartTimelineFrame" IS NOT NULL AND "windowEndTimelineFrame" IS NOT NULL
      AND "windowStartTimelineFrame" >= 0
      AND "windowEndTimelineFrame" > "windowStartTimelineFrame"
      AND "windowEndTimelineFrame" - "windowStartTimelineFrame" <= 300
      AND "windowStartSourceFrame" IS NULL AND "windowEndSourceFrame" IS NULL
      AND "sampleIntervalFrames" BETWEEN 1 AND 300)
    OR ("detectorProfile" = 'openvino-face0204-v9-source'
      AND "windowStartTimelineFrame" IS NULL AND "windowEndTimelineFrame" IS NULL
      AND "windowStartSourceFrame" IS NOT NULL AND "windowEndSourceFrame" IS NOT NULL
      AND "windowStartSourceFrame" >= 0
      AND "windowEndSourceFrame" > "windowStartSourceFrame"
      AND "windowEndSourceFrame" - "windowStartSourceFrame" <= 300
      AND "sampleIntervalFrames" BETWEEN 1 AND 300)
  );

-- A source window envelope is one bounded window of the source's own frames.
ALTER TABLE "face_source_window_envelopes"
  ADD CONSTRAINT "face_source_window_envelopes_schema_window_check" CHECK (
    "schemaVersion" = 'face-producer-envelope/v3'
    AND "windowStartSourceFrame" >= 0
    AND "windowEndSourceFrame" > "windowStartSourceFrame"
    AND "windowEndSourceFrame" - "windowStartSourceFrame" <= 300
  );

-- One raw detector output is exactly the 5600-byte [1,1,200,7] float32 tensor of a sample of a bounded window.
ALTER TABLE "face_source_window_raw_outputs"
  ADD CONSTRAINT "face_source_window_raw_outputs_shape_check" CHECK (
    octet_length("rawBytes") = 5600
    AND "sampleIndex" BETWEEN 0 AND 59
    AND "sourceFrame" >= 0
  );
