ALTER TABLE "media_uploads"
  ADD COLUMN "inspectionStatus" VARCHAR(16) NOT NULL DEFAULT 'pending',
  ADD COLUMN "detectedMimeType" VARCHAR(160),
  ADD COLUMN "detectedExtension" VARCHAR(8),
  ADD COLUMN "probeJson" TEXT,
  ADD COLUMN "inspectionErrorJson" TEXT,
  ADD COLUMN "inspectedAt" TIMESTAMPTZ(3);

ALTER TABLE "media_uploads"
  ADD CONSTRAINT "media_uploads_inspection_check" CHECK (
    ("inspectionStatus" = 'pending' AND "detectedMimeType" IS NULL AND "detectedExtension" IS NULL AND "probeJson" IS NULL AND "inspectionErrorJson" IS NULL AND "inspectedAt" IS NULL)
    OR
    ("inspectionStatus" = 'usable' AND "detectedMimeType" IS NOT NULL AND "detectedExtension" IS NOT NULL AND "probeJson" IS NOT NULL AND "inspectionErrorJson" IS NULL AND "inspectedAt" IS NOT NULL)
    OR
    ("inspectionStatus" = 'quarantined' AND "detectedMimeType" IS NOT NULL AND "detectedExtension" IS NOT NULL AND "inspectionErrorJson" IS NOT NULL AND "inspectedAt" IS NOT NULL)
  );

CREATE INDEX "media_uploads_workspaceId_inspectionStatus_createdAt_idx"
  ON "media_uploads"("workspaceId", "inspectionStatus", "createdAt" DESC);
