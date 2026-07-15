ALTER TABLE "webhook_signing_secrets" ADD COLUMN "usableUntil" TIMESTAMPTZ(3);

ALTER TABLE "webhook_signing_secret_rotations"
  ADD COLUMN "overlapUntil" TIMESTAMPTZ(3),
  ALTER COLUMN "payloadAlgorithm" DROP NOT NULL,
  ALTER COLUMN "payloadKeyId" DROP NOT NULL,
  ALTER COLUMN "payloadNonce" DROP NOT NULL,
  ALTER COLUMN "payloadCiphertext" DROP NOT NULL,
  ALTER COLUMN "payloadAuthTag" DROP NOT NULL;

ALTER TABLE "webhook_signing_secret_rotations"
  DROP CONSTRAINT "webhook_signing_secret_rotations_lifecycle_check";
ALTER TABLE "webhook_signing_secret_rotations"
  ADD CONSTRAINT "webhook_signing_secret_rotations_lifecycle_check" CHECK (
    (
      "status" = 'staged'
      AND "activatedAt" IS NULL
      AND "overlapUntil" IS NULL
      AND "cancelledAt" IS NULL
      AND "payloadAlgorithm" IS NOT NULL
      AND "payloadKeyId" IS NOT NULL
      AND "payloadNonce" IS NOT NULL
      AND "payloadCiphertext" IS NOT NULL
      AND "payloadAuthTag" IS NOT NULL
    )
    OR (
      "status" = 'activated'
      AND "activatedAt" IS NOT NULL
      AND "overlapUntil" > "activatedAt"
      AND "cancelledAt" IS NULL
      AND "payloadAlgorithm" IS NULL
      AND "payloadKeyId" IS NULL
      AND "payloadNonce" IS NULL
      AND "payloadCiphertext" IS NULL
      AND "payloadAuthTag" IS NULL
    )
    OR (
      "status" IN ('cancelled', 'expired')
      AND "activatedAt" IS NULL
      AND "overlapUntil" IS NULL
      AND "cancelledAt" IS NOT NULL
    )
  );

ALTER TABLE "webhook_signing_secrets"
  DROP CONSTRAINT "webhook_signing_secrets_lifecycle_check";
ALTER TABLE "webhook_signing_secrets"
  ADD CONSTRAINT "webhook_signing_secrets_lifecycle_check" CHECK (
    ("status" = 'active' AND "retiredAt" IS NULL AND "usableUntil" IS NULL AND "revokedAt" IS NULL)
    OR (
      "status" = 'retired'
      AND "retiredAt" IS NOT NULL
      AND ("usableUntil" IS NULL OR "usableUntil" > "retiredAt")
      AND "revokedAt" IS NULL
    )
    OR ("status" = 'revoked' AND "revokedAt" IS NOT NULL)
  );

CREATE INDEX "webhook_signing_secrets_endpointId_status_usableUntil_idx"
  ON "webhook_signing_secrets"("endpointId", "status", "usableUntil");
