CREATE TABLE "webhook_signing_secret_rotations" (
  "id" UUID NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "endpointId" UUID NOT NULL,
  "requestedByClientId" VARCHAR(80) NOT NULL,
  "previousSecretId" UUID NOT NULL,
  "candidateSecretId" UUID NOT NULL,
  "candidateVersion" INTEGER NOT NULL,
  "algorithm" VARCHAR(32) NOT NULL DEFAULT 'hmac-sha256',
  "keyRef" VARCHAR(240) NOT NULL,
  "fingerprint" CHAR(64) NOT NULL,
  "status" VARCHAR(32) NOT NULL DEFAULT 'staged',
  "overlapSeconds" INTEGER NOT NULL,
  "payloadAlgorithm" VARCHAR(32) NOT NULL,
  "payloadKeyId" VARCHAR(64) NOT NULL,
  "payloadNonce" VARCHAR(64) NOT NULL,
  "payloadCiphertext" TEXT NOT NULL,
  "payloadAuthTag" VARCHAR(64) NOT NULL,
  "baseRevision" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "activatedAt" TIMESTAMPTZ(3),
  "cancelledAt" TIMESTAMPTZ(3),

  CONSTRAINT "webhook_signing_secret_rotations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "webhook_signing_secret_rotations_lifecycle_check" CHECK (
    ("status" = 'staged' AND "activatedAt" IS NULL AND "cancelledAt" IS NULL)
    OR ("status" = 'activated' AND "activatedAt" IS NOT NULL AND "cancelledAt" IS NULL)
    OR ("status" IN ('cancelled', 'expired') AND "activatedAt" IS NULL AND "cancelledAt" IS NOT NULL)
  ),
  CONSTRAINT "webhook_signing_secret_rotations_overlap_check" CHECK ("overlapSeconds" BETWEEN 60 AND 86400),
  CONSTRAINT "webhook_signing_secret_rotations_expiry_check" CHECK ("expiresAt" > "createdAt"),
  CONSTRAINT "webhook_signing_secret_rotations_version_check" CHECK ("candidateVersion" > 0),
  CONSTRAINT "webhook_signing_secret_rotations_algorithm_check" CHECK (
    "algorithm" = 'hmac-sha256' AND "payloadAlgorithm" = 'aes-256-gcm'
  ),
  CONSTRAINT "webhook_signing_secret_rotations_fingerprint_check" CHECK ("fingerprint" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "webhook_signing_secret_rotations_revision_check" CHECK ("baseRevision" ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX "webhook_signing_secret_rotations_keyRef_key"
  ON "webhook_signing_secret_rotations"("keyRef");
CREATE UNIQUE INDEX "webhook_signing_secret_rotations_id_workspaceId_key"
  ON "webhook_signing_secret_rotations"("id", "workspaceId");
CREATE UNIQUE INDEX "webhook_signing_secret_rotations_endpointId_candidateVersio_key"
  ON "webhook_signing_secret_rotations"("endpointId", "candidateVersion");
CREATE UNIQUE INDEX "webhook_signing_secret_rotations_one_staged_per_endpoint"
  ON "webhook_signing_secret_rotations"("endpointId") WHERE "status" = 'staged';
CREATE INDEX "webhook_signing_secret_rotations_workspaceId_status_created_idx"
  ON "webhook_signing_secret_rotations"("workspaceId", "status", "createdAt" DESC);
CREATE INDEX "webhook_signing_secret_rotations_endpointId_status_expiresA_idx"
  ON "webhook_signing_secret_rotations"("endpointId", "status", "expiresAt");

ALTER TABLE "webhook_signing_secret_rotations" ADD CONSTRAINT "webhook_signing_secret_rotations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webhook_signing_secret_rotations" ADD CONSTRAINT "webhook_signing_secret_rotations_endpointId_workspaceId_fkey" FOREIGN KEY ("endpointId", "workspaceId") REFERENCES "webhook_endpoints"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webhook_signing_secret_rotations"
  ADD CONSTRAINT "webhook_signing_secret_rotations_requestedByClientId_workspaceId_fkey"
  FOREIGN KEY ("requestedByClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webhook_signing_secret_rotations"
  ADD CONSTRAINT "webhook_signing_secret_rotations_previousSecretId_workspaceId_fkey"
  FOREIGN KEY ("previousSecretId", "workspaceId") REFERENCES "webhook_signing_secrets"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
