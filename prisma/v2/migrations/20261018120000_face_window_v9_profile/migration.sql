-- AlterTable
ALTER TABLE "face_producer_envelopes" ADD COLUMN     "schemaVersion" VARCHAR(64) NOT NULL DEFAULT 'face-producer-envelope/v1',
ADD COLUMN     "windowStartTimelineFrame" INTEGER,
ADD COLUMN     "windowEndTimelineFrame" INTEGER;

-- AlterTable
ALTER TABLE "face_producer_operations" ADD COLUMN     "detectorProfile" VARCHAR(64) NOT NULL DEFAULT 'yunet-v5-diagnostic',
ADD COLUMN     "windowStartTimelineFrame" INTEGER,
ADD COLUMN     "windowEndTimelineFrame" INTEGER;

-- CreateTable
CREATE TABLE "face_producer_raw_outputs" (
    "id" VARCHAR(128) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "envelopeId" VARCHAR(128) NOT NULL,
    "sampleIndex" INTEGER NOT NULL,
    "timelineFrame" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "rawBytes" BYTEA NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "face_producer_raw_outputs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "face_producer_envelopes_window_idx" ON "face_producer_envelopes"("workspaceId", "projectId", "projectVersionId", "sourceArtifactId", "windowStartTimelineFrame");

-- CreateIndex
CREATE INDEX "face_producer_raw_outputs_workspaceId_envelopeId_idx" ON "face_producer_raw_outputs"("workspaceId", "envelopeId");

-- CreateIndex
CREATE UNIQUE INDEX "face_producer_raw_outputs_envelopeId_sampleIndex_key" ON "face_producer_raw_outputs"("envelopeId", "sampleIndex");

-- AddForeignKey
ALTER TABLE "face_producer_raw_outputs" ADD CONSTRAINT "face_producer_raw_outputs_envelopeId_workspaceId_fkey" FOREIGN KEY ("envelopeId", "workspaceId") REFERENCES "face_producer_envelopes"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Legacy rows are the YuNet diagnostic: whole timeline, no window. The owner-accepted V9 profile always has a bounded
-- window of at most 300 frames; envelopes carry the same window as the operation that produced them.
ALTER TABLE "face_producer_operations"
  ADD CONSTRAINT "face_producer_operations_profile_window_check" CHECK (
    ("detectorProfile" = 'yunet-v5-diagnostic'
      AND "windowStartTimelineFrame" IS NULL AND "windowEndTimelineFrame" IS NULL)
    OR ("detectorProfile" = 'openvino-face0204-v9'
      AND "windowStartTimelineFrame" IS NOT NULL AND "windowEndTimelineFrame" IS NOT NULL
      AND "windowStartTimelineFrame" >= 0
      AND "windowEndTimelineFrame" > "windowStartTimelineFrame"
      AND "windowEndTimelineFrame" - "windowStartTimelineFrame" <= 300
      AND "sampleIntervalFrames" BETWEEN 1 AND 300)
  );

ALTER TABLE "face_producer_envelopes"
  ADD CONSTRAINT "face_producer_envelopes_schema_window_check" CHECK (
    ("schemaVersion" = 'face-producer-envelope/v1'
      AND "windowStartTimelineFrame" IS NULL AND "windowEndTimelineFrame" IS NULL)
    OR ("schemaVersion" = 'face-producer-envelope/v2'
      AND "windowStartTimelineFrame" IS NOT NULL AND "windowEndTimelineFrame" IS NOT NULL
      AND "windowStartTimelineFrame" >= 0
      AND "windowEndTimelineFrame" > "windowStartTimelineFrame"
      AND "windowEndTimelineFrame" - "windowStartTimelineFrame" <= 300)
  );

-- One raw detector output is exactly the 5600-byte [1,1,200,7] float32 tensor of a sample of a bounded window.
ALTER TABLE "face_producer_raw_outputs"
  ADD CONSTRAINT "face_producer_raw_outputs_shape_check" CHECK (
    octet_length("rawBytes") = 5600
    AND "sampleIndex" BETWEEN 0 AND 59
    AND "timelineFrame" >= 0
  );
