ALTER TABLE "public_operations"
  ADD COLUMN "leaseOwner" VARCHAR(128),
  ADD COLUMN "leaseExpiresAt" TIMESTAMPTZ(3),
  ADD COLUMN "heartbeatAt" TIMESTAMPTZ(3),
  ADD CONSTRAINT "public_operations_lease_check" CHECK (
    (
      "status" = 'running'
      AND "leaseOwner" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
      AND "leaseExpiresAt" IS NOT NULL
      AND "heartbeatAt" IS NOT NULL
      AND "heartbeatAt" >= "startedAt"
      AND "leaseExpiresAt" > "heartbeatAt"
    )
    OR (
      "status" <> 'running'
      AND "leaseOwner" IS NULL
      AND "leaseExpiresAt" IS NULL
      AND "heartbeatAt" IS NULL
    )
  );

CREATE INDEX "public_operations_status_leaseExpiresAt_createdAt_idx"
  ON "public_operations"("status", "leaseExpiresAt", "createdAt");
