CREATE TABLE "webhook_verification_challenges" (
    "id" UUID NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "endpointId" UUID NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMPTZ(3),
    "failedAt" TIMESTAMPTZ(3),

    CONSTRAINT "webhook_verification_challenges_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "webhook_verification_challenges_hash_check" CHECK (
      "tokenHash" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "webhook_verification_challenges_status_check" CHECK (
      "status" IN ('pending', 'verified', 'expired', 'failed')
    ),
    CONSTRAINT "webhook_verification_challenges_attempt_check" CHECK (
      "attemptCount" >= 0 AND "maxAttempts" BETWEEN 1 AND 10 AND "attemptCount" <= "maxAttempts"
    ),
    CONSTRAINT "webhook_verification_challenges_dates_check" CHECK (
      "expiresAt" > "createdAt"
    ),
    CONSTRAINT "webhook_verification_challenges_state_check" CHECK (
      ("status" = 'pending' AND "verifiedAt" IS NULL AND "failedAt" IS NULL AND "attemptCount" < "maxAttempts")
      OR (
        "status" = 'verified'
        AND "verifiedAt" IS NOT NULL
        AND "failedAt" IS NULL
        AND "verifiedAt" BETWEEN "createdAt" AND "expiresAt"
      )
      OR (
        "status" IN ('expired', 'failed')
        AND "verifiedAt" IS NULL
        AND "failedAt" IS NOT NULL
        AND "failedAt" >= "createdAt"
      )
    )
);

CREATE TABLE "webhook_replay_receipts" (
    "id" UUID NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "endpointId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "signatureTimestamp" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "webhook_replay_receipts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "webhook_replay_receipts_dates_check" CHECK (
      "signatureTimestamp" BETWEEN "receivedAt" - INTERVAL '15 minutes' AND "receivedAt" + INTERVAL '15 minutes'
      AND "expiresAt" > "receivedAt"
      AND "expiresAt" <= "receivedAt" + INTERVAL '24 hours'
    )
);

CREATE UNIQUE INDEX "webhook_verification_challenges_tokenHash_key" ON "webhook_verification_challenges"("tokenHash");
CREATE UNIQUE INDEX "webhook_verification_challenges_id_workspaceId_key" ON "webhook_verification_challenges"("id", "workspaceId");
CREATE UNIQUE INDEX "webhook_verification_challenges_one_pending_endpoint_idx" ON "webhook_verification_challenges"("endpointId") WHERE "status" = 'pending';
CREATE INDEX "webhook_verification_challenges_endpointId_status_createdAt_idx" ON "webhook_verification_challenges"("endpointId", "status", "createdAt" DESC);
CREATE INDEX "webhook_verification_challenges_status_expiresAt_idx" ON "webhook_verification_challenges"("status", "expiresAt");

CREATE UNIQUE INDEX "webhook_replay_receipts_id_workspaceId_key" ON "webhook_replay_receipts"("id", "workspaceId");
CREATE UNIQUE INDEX "webhook_replay_receipts_endpointId_eventId_key" ON "webhook_replay_receipts"("endpointId", "eventId");
CREATE INDEX "webhook_replay_receipts_workspaceId_expiresAt_idx" ON "webhook_replay_receipts"("workspaceId", "expiresAt");

ALTER TABLE "webhook_verification_challenges" ADD CONSTRAINT "webhook_verification_challenges_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webhook_verification_challenges" ADD CONSTRAINT "webhook_verification_challenges_endpointId_workspaceId_fkey" FOREIGN KEY ("endpointId", "workspaceId") REFERENCES "webhook_endpoints"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "webhook_replay_receipts" ADD CONSTRAINT "webhook_replay_receipts_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webhook_replay_receipts" ADD CONSTRAINT "webhook_replay_receipts_endpointId_workspaceId_fkey" FOREIGN KEY ("endpointId", "workspaceId") REFERENCES "webhook_endpoints"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
