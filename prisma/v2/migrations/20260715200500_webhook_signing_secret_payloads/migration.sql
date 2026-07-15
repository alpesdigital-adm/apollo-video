CREATE TABLE "webhook_signing_secret_payloads" (
    "secretId" UUID NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "endpointId" UUID NOT NULL,
    "secretVersion" INTEGER NOT NULL,
    "algorithm" VARCHAR(32) NOT NULL,
    "keyId" VARCHAR(64) NOT NULL,
    "nonce" VARCHAR(64) NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "authTag" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_signing_secret_payloads_pkey" PRIMARY KEY ("secretId")
);

CREATE UNIQUE INDEX "webhook_signing_secret_payloads_secretId_workspaceId_key"
  ON "webhook_signing_secret_payloads"("secretId", "workspaceId");

CREATE UNIQUE INDEX "webhook_signing_secret_payloads_secretId_workspaceId_endpoi_key"
  ON "webhook_signing_secret_payloads"("secretId", "workspaceId", "endpointId", "secretVersion");

CREATE UNIQUE INDEX "webhook_signing_secrets_id_workspaceId_endpointId_version_key"
  ON "webhook_signing_secrets"("id", "workspaceId", "endpointId", "version");

CREATE INDEX "webhook_signing_secret_payloads_workspaceId_endpointId_secr_idx"
  ON "webhook_signing_secret_payloads"("workspaceId", "endpointId", "secretVersion");

ALTER TABLE "webhook_signing_secret_payloads" ADD CONSTRAINT "webhook_signing_secret_payloads_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "webhook_signing_secret_payloads" ADD CONSTRAINT "webhook_signing_secret_payloads_secretId_workspaceId_endpo_fkey" FOREIGN KEY ("secretId", "workspaceId", "endpointId", "secretVersion") REFERENCES "webhook_signing_secrets"("id", "workspaceId", "endpointId", "version") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "webhook_signing_secret_payloads"
  ADD CONSTRAINT "webhook_signing_secret_payloads_version_check" CHECK ("secretVersion" >= 1),
  ADD CONSTRAINT "webhook_signing_secret_payloads_algorithm_check" CHECK ("algorithm" = 'aes-256-gcm'),
  ADD CONSTRAINT "webhook_signing_secret_payloads_key_check" CHECK ("keyId" ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  ADD CONSTRAINT "webhook_signing_secret_payloads_nonce_check" CHECK (length("nonce") BETWEEN 16 AND 64 AND "nonce" ~ '^[A-Za-z0-9_-]+$'),
  ADD CONSTRAINT "webhook_signing_secret_payloads_ciphertext_check" CHECK (length("ciphertext") BETWEEN 16 AND 1024 AND "ciphertext" ~ '^[A-Za-z0-9_-]+$'),
  ADD CONSTRAINT "webhook_signing_secret_payloads_auth_tag_check" CHECK (length("authTag") BETWEEN 16 AND 64 AND "authTag" ~ '^[A-Za-z0-9_-]+$');
