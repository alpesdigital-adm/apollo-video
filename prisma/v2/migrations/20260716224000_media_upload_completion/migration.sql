ALTER TABLE "media_uploads"
  ADD COLUMN "actualSha256" CHAR(64),
  ADD COLUMN "actualByteSize" BIGINT,
  ADD COLUMN "verifiedAt" TIMESTAMP(3);

CREATE TABLE "media_upload_parts" (
  "id" UUID NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "uploadId" UUID NOT NULL,
  "partNumber" INTEGER NOT NULL,
  "byteSize" BIGINT NOT NULL,
  "etag" VARCHAR(258) NOT NULL,
  "checksum" CHAR(64) NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "media_upload_parts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "media_upload_parts_number_check" CHECK ("partNumber" BETWEEN 1 AND 10000),
  CONSTRAINT "media_upload_parts_size_check" CHECK ("byteSize" > 0),
  CONSTRAINT "media_upload_parts_checksum_check" CHECK ("checksum" ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX "media_upload_parts_uploadId_partNumber_key" ON "media_upload_parts"("uploadId", "partNumber");
CREATE INDEX "media_upload_parts_workspaceId_uploadId_partNumber_idx" ON "media_upload_parts"("workspaceId", "uploadId", "partNumber");
ALTER TABLE "media_upload_parts" ADD CONSTRAINT "media_upload_parts_uploadId_workspaceId_fkey" FOREIGN KEY ("uploadId", "workspaceId") REFERENCES "media_uploads"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
