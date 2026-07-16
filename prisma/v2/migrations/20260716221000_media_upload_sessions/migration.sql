CREATE TABLE "media_uploads" (
  "id" UUID NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "clientId" VARCHAR(80) NOT NULL,
  "kind" VARCHAR(16) NOT NULL,
  "byteSize" BIGINT NOT NULL,
  "mimeType" VARCHAR(160) NOT NULL,
  "expectedSha256" CHAR(64) NOT NULL,
  "status" VARCHAR(32) NOT NULL DEFAULT 'pending-session',
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "media_uploads_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "media_uploads_kind_check" CHECK ("kind" IN ('video','audio','image')),
  CONSTRAINT "media_uploads_size_check" CHECK ("byteSize" > 0 AND "byteSize" <= 5000000000000),
  CONSTRAINT "media_uploads_sha_check" CHECK ("expectedSha256" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "media_uploads_expiry_check" CHECK ("expiresAt" > "createdAt")
);
CREATE UNIQUE INDEX "media_uploads_id_workspaceId_key" ON "media_uploads"("id", "workspaceId");
CREATE UNIQUE INDEX "media_uploads_workspaceId_clientId_idempotencyKey_key" ON "media_uploads"("workspaceId", "clientId", "idempotencyKey");
CREATE INDEX "media_uploads_workspaceId_status_createdAt_idx" ON "media_uploads"("workspaceId", "status", "createdAt" DESC);
CREATE INDEX "media_uploads_workspaceId_status_expiresAt_idx" ON "media_uploads"("workspaceId", "status", "expiresAt");
ALTER TABLE "media_uploads" ADD CONSTRAINT "media_uploads_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_uploads" ADD CONSTRAINT "media_uploads_clientId_workspaceId_fkey" FOREIGN KEY ("clientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
