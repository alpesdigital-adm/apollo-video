CREATE TABLE "media_download_grants" (
  "id" UUID NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "clientId" VARCHAR(80) NOT NULL,
  "artifactId" VARCHAR(128) NOT NULL,
  "tokenHash" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'active',
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMPTZ(3),
  CONSTRAINT "media_download_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "media_download_grants_status_check" CHECK ("status" IN ('active', 'revoked')),
  CONSTRAINT "media_download_grants_expiry_check" CHECK ("expiresAt" > "createdAt")
);

CREATE INDEX "media_download_grants_workspaceId_clientId_status_expiresAt_idx" ON "media_download_grants"("workspaceId", "clientId", "status", "expiresAt");
CREATE INDEX "media_download_grants_workspaceId_artifactId_status_idx" ON "media_download_grants"("workspaceId", "artifactId", "status");
CREATE UNIQUE INDEX "media_download_grants_workspaceId_clientId_idempotencyKey_key" ON "media_download_grants"("workspaceId", "clientId", "idempotencyKey");
ALTER TABLE "media_download_grants" ADD CONSTRAINT "media_download_grants_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_download_grants" ADD CONSTRAINT "media_download_grants_clientId_workspaceId_fkey" FOREIGN KEY ("clientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_download_grants" ADD CONSTRAINT "media_download_grants_artifactId_workspaceId_fkey" FOREIGN KEY ("artifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
