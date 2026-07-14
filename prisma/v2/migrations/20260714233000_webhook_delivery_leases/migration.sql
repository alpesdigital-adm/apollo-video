ALTER TABLE "webhook_deliveries"
  ADD COLUMN "leaseOwner" VARCHAR(128),
  ADD COLUMN "leaseTokenHash" CHAR(64),
  ADD COLUMN "leaseExpiresAt" TIMESTAMPTZ(3),
  ADD COLUMN "heartbeatAt" TIMESTAMPTZ(3);

ALTER TABLE "webhook_deliveries"
  DROP CONSTRAINT "webhook_deliveries_state_check";

ALTER TABLE "webhook_deliveries"
  ADD CONSTRAINT "webhook_deliveries_lease_check" CHECK (
    (
      "status" = 'in-flight'
      AND "leaseOwner" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
      AND "leaseTokenHash" ~ '^[0-9a-f]{64}$'
      AND "leaseExpiresAt" IS NOT NULL
      AND "heartbeatAt" IS NOT NULL
      AND "heartbeatAt" >= "createdAt"
      AND "leaseExpiresAt" > "heartbeatAt"
    )
    OR (
      "status" <> 'in-flight'
      AND "leaseOwner" IS NULL
      AND "leaseTokenHash" IS NULL
      AND "leaseExpiresAt" IS NULL
      AND "heartbeatAt" IS NULL
    )
  ),
  ADD CONSTRAINT "webhook_deliveries_state_check" CHECK (
    (
      "status" = 'pending'
      AND "attemptCount" = 0
      AND "completedAt" IS NULL
      AND "deadLetteredAt" IS NULL
    )
    OR (
      "status" = 'in-flight'
      AND "attemptCount" BETWEEN 1 AND "maxAttempts"
      AND "completedAt" IS NULL
      AND "deadLetteredAt" IS NULL
    )
    OR (
      "status" = 'retry-scheduled'
      AND "attemptCount" BETWEEN 1 AND "maxAttempts" - 1
      AND "nextAttemptAt" > "updatedAt"
      AND "completedAt" IS NULL
      AND "deadLetteredAt" IS NULL
    )
    OR (
      "status" = 'succeeded'
      AND "attemptCount" BETWEEN 1 AND "maxAttempts"
      AND "completedAt" IS NOT NULL
      AND "deadLetteredAt" IS NULL
    )
    OR (
      "status" = 'dead-lettered'
      AND "attemptCount" BETWEEN 1 AND "maxAttempts"
      AND "completedAt" IS NOT NULL
      AND "deadLetteredAt" IS NOT NULL
    )
  );

ALTER TABLE "webhook_delivery_attempts"
  ADD CONSTRAINT "webhook_delivery_attempts_dates_check" CHECK (
    ("startedAt" IS NULL OR "startedAt" >= "scheduledAt")
    AND ("completedAt" IS NULL OR ("startedAt" IS NOT NULL AND "completedAt" >= "startedAt"))
  );

CREATE INDEX "webhook_deliveries_status_leaseExpiresAt_createdAt_idx"
ON "webhook_deliveries"("status", "leaseExpiresAt", "createdAt");
