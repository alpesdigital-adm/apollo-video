ALTER TABLE "public_operations"
  ADD COLUMN "nextAttemptAt" TIMESTAMPTZ(3),
  ADD COLUMN "deadLetteredAt" TIMESTAMPTZ(3);

UPDATE "public_operations"
SET "nextAttemptAt" = GREATEST(
  "updatedAt" + INTERVAL '5 seconds',
  CURRENT_TIMESTAMP + INTERVAL '5 seconds'
)
WHERE "status" = 'retrying';

ALTER TABLE "public_operations"
  ADD CONSTRAINT "public_operations_retry_schedule_check" CHECK (
    (
      "status" = 'retrying'
      AND "retryable" = true
      AND "nextAttemptAt" IS NOT NULL
      AND "nextAttemptAt" > "updatedAt"
      AND "deadLetteredAt" IS NULL
    )
    OR (
      "status" = 'failed'
      AND "nextAttemptAt" IS NULL
      AND ("deadLetteredAt" IS NULL OR "deadLetteredAt" = "completedAt")
    )
    OR (
      "status" NOT IN ('retrying', 'failed')
      AND "nextAttemptAt" IS NULL
      AND "deadLetteredAt" IS NULL
    )
  );

CREATE INDEX "public_operations_status_nextAttemptAt_createdAt_idx"
  ON "public_operations"("status", "nextAttemptAt", "createdAt");
