-- Expand ApiClient so credentials can rotate independently. Legacy hashes are
-- copied before the old columns are retired in a later contract migration.

-- CreateIndex
CREATE UNIQUE INDEX "api_clients_id_workspaceId_key" ON "api_clients"("id", "workspaceId");

-- CreateTable
CREATE TABLE "api_credentials" (
    "id" VARCHAR(80) NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "clientId" VARCHAR(80) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'active',
    "secretSalt" VARCHAR(128) NOT NULL,
    "secretHash" VARCHAR(128) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    CONSTRAINT "api_credentials_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "api_credentials_status_check" CHECK ("status" IN ('active', 'revoked')),
    CONSTRAINT "api_credentials_hash_check" CHECK ("secretHash" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "api_credentials_revocation_check" CHECK (
      ("status" = 'active' AND "revokedAt" IS NULL) OR
      ("status" = 'revoked' AND "revokedAt" IS NOT NULL)
    )
);

-- BackfillCredential
INSERT INTO "api_credentials" (
    "id", "workspaceId", "clientId", "status", "secretSalt", "secretHash", "createdAt", "lastUsedAt"
)
SELECT
    "id", "workspaceId", "id", 'active', "secretSalt", "secretHash", "createdAt", "lastUsedAt"
FROM "api_clients";

-- CreateIndex
CREATE UNIQUE INDEX "api_credentials_id_clientId_key" ON "api_credentials"("id", "clientId");
CREATE INDEX "api_credentials_clientId_status_idx" ON "api_credentials"("clientId", "status");
CREATE INDEX "api_credentials_workspaceId_status_idx" ON "api_credentials"("workspaceId", "status");
CREATE INDEX "api_credentials_expiresAt_idx" ON "api_credentials"("expiresAt");

-- AddForeignKey
ALTER TABLE "api_credentials" ADD CONSTRAINT "api_credentials_clientId_workspaceId_fkey" FOREIGN KEY ("clientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
