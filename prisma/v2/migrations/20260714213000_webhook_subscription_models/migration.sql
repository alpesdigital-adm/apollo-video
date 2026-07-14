CREATE TABLE "webhook_endpoints" (
    "id" UUID NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'pending-verification',
    "createdByClientId" VARCHAR(80) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "verifiedAt" TIMESTAMPTZ(3),
    "suspendedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "webhook_endpoints_status_check" CHECK (
      "status" IN ('pending-verification', 'active', 'suspended', 'revoked')
    ),
    CONSTRAINT "webhook_endpoints_url_check" CHECK (
      "url" ~ '^https://[^/?#@:]+(?::443)?(?:/[^?#]*)?$'
    ),
    CONSTRAINT "webhook_endpoints_state_check" CHECK (
      ("status" = 'pending-verification' AND "verifiedAt" IS NULL AND "suspendedAt" IS NULL AND "revokedAt" IS NULL)
      OR ("status" = 'active' AND "verifiedAt" IS NOT NULL AND "suspendedAt" IS NULL AND "revokedAt" IS NULL)
      OR ("status" = 'suspended' AND "verifiedAt" IS NOT NULL AND "suspendedAt" IS NOT NULL AND "revokedAt" IS NULL)
      OR ("status" = 'revoked' AND "revokedAt" IS NOT NULL)
    )
);

CREATE TABLE "webhook_signing_secrets" (
    "id" UUID NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "endpointId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "algorithm" VARCHAR(32) NOT NULL DEFAULT 'hmac-sha256',
    "keyRef" VARCHAR(240) NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "webhook_signing_secrets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "webhook_signing_secrets_version_check" CHECK ("version" > 0),
    CONSTRAINT "webhook_signing_secrets_algorithm_check" CHECK ("algorithm" = 'hmac-sha256'),
    CONSTRAINT "webhook_signing_secrets_reference_check" CHECK (
      "keyRef" ~ '^[a-z][a-z0-9+.-]*://[A-Za-z0-9][A-Za-z0-9._:/-]{2,217}$'
      AND position('@' in "keyRef") = 0
      AND "fingerprint" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "webhook_signing_secrets_status_check" CHECK (
      "status" IN ('active', 'retired', 'revoked')
    ),
    CONSTRAINT "webhook_signing_secrets_state_check" CHECK (
      ("status" = 'active' AND "retiredAt" IS NULL AND "revokedAt" IS NULL)
      OR ("status" = 'retired' AND "retiredAt" IS NOT NULL AND "revokedAt" IS NULL)
      OR ("status" = 'revoked' AND "revokedAt" IS NOT NULL)
    )
);

CREATE TABLE "webhook_subscriptions" (
    "id" UUID NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "endpointId" UUID NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'pending-verification',
    "filterEventTypesJson" TEXT NOT NULL,
    "filterResourceIdsJson" TEXT,
    "filterHash" CHAR(64) NOT NULL,
    "createdByClientId" VARCHAR(80) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "pausedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "webhook_subscriptions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "webhook_subscriptions_status_check" CHECK (
      "status" IN ('pending-verification', 'active', 'paused', 'revoked')
    ),
    CONSTRAINT "webhook_subscriptions_filter_check" CHECK (
      "filterHash" ~ '^[0-9a-f]{64}$'
      AND jsonb_typeof("filterEventTypesJson"::jsonb) = 'array'
      AND jsonb_array_length("filterEventTypesJson"::jsonb) BETWEEN 1 AND 100
      AND (
        "filterResourceIdsJson" IS NULL
        OR (
          jsonb_typeof("filterResourceIdsJson"::jsonb) = 'array'
          AND jsonb_array_length("filterResourceIdsJson"::jsonb) BETWEEN 1 AND 100
        )
      )
    ),
    CONSTRAINT "webhook_subscriptions_state_check" CHECK (
      ("status" IN ('pending-verification', 'active') AND "pausedAt" IS NULL AND "revokedAt" IS NULL)
      OR ("status" = 'paused' AND "pausedAt" IS NOT NULL AND "revokedAt" IS NULL)
      OR ("status" = 'revoked' AND "revokedAt" IS NOT NULL)
    )
);

CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 8,
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "completedAt" TIMESTAMPTZ(3),
    "deadLetteredAt" TIMESTAMPTZ(3),

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "webhook_deliveries_status_check" CHECK (
      "status" IN ('pending', 'in-flight', 'retry-scheduled', 'succeeded', 'dead-lettered')
    ),
    CONSTRAINT "webhook_deliveries_attempt_check" CHECK (
      "attemptCount" >= 0 AND "maxAttempts" BETWEEN 1 AND 20 AND "attemptCount" <= "maxAttempts"
    ),
    CONSTRAINT "webhook_deliveries_state_check" CHECK (
      ("status" IN ('pending', 'in-flight', 'retry-scheduled') AND "completedAt" IS NULL AND "deadLetteredAt" IS NULL)
      OR ("status" = 'succeeded' AND "completedAt" IS NOT NULL AND "deadLetteredAt" IS NULL)
      OR ("status" = 'dead-lettered' AND "completedAt" IS NOT NULL AND "deadLetteredAt" IS NOT NULL)
    )
);

CREATE TABLE "webhook_delivery_attempts" (
    "id" UUID NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "deliveryId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'scheduled',
    "scheduledAt" TIMESTAMPTZ(3) NOT NULL,
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "responseStatus" INTEGER,
    "responseBodyHash" CHAR(64),
    "errorCode" VARCHAR(64),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_delivery_attempts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "webhook_delivery_attempts_number_check" CHECK ("attemptNumber" BETWEEN 1 AND 20),
    CONSTRAINT "webhook_delivery_attempts_status_check" CHECK (
      "status" IN ('scheduled', 'in-flight', 'succeeded', 'failed')
    ),
    CONSTRAINT "webhook_delivery_attempts_response_check" CHECK (
      ("responseStatus" IS NULL OR "responseStatus" BETWEEN 100 AND 599)
      AND ("responseBodyHash" IS NULL OR "responseBodyHash" ~ '^[0-9a-f]{64}$')
      AND ("errorCode" IS NULL OR "errorCode" ~ '^[a-z][a-z0-9_-]{2,63}$')
    ),
    CONSTRAINT "webhook_delivery_attempts_state_check" CHECK (
      ("status" = 'scheduled' AND "startedAt" IS NULL AND "completedAt" IS NULL AND "responseStatus" IS NULL AND "errorCode" IS NULL)
      OR ("status" = 'in-flight' AND "startedAt" IS NOT NULL AND "completedAt" IS NULL)
      OR ("status" = 'succeeded' AND "startedAt" IS NOT NULL AND "completedAt" IS NOT NULL AND "responseStatus" BETWEEN 200 AND 299 AND "errorCode" IS NULL)
      OR ("status" = 'failed' AND "startedAt" IS NOT NULL AND "completedAt" IS NOT NULL AND ("responseStatus" IS NOT NULL OR "errorCode" IS NOT NULL))
    )
);

CREATE UNIQUE INDEX "webhook_endpoints_id_workspaceId_key" ON "webhook_endpoints"("id", "workspaceId");
CREATE UNIQUE INDEX "webhook_endpoints_workspaceId_url_key" ON "webhook_endpoints"("workspaceId", "url");
CREATE INDEX "webhook_endpoints_workspaceId_status_createdAt_idx" ON "webhook_endpoints"("workspaceId", "status", "createdAt" DESC);

CREATE UNIQUE INDEX "webhook_signing_secrets_keyRef_key" ON "webhook_signing_secrets"("keyRef");
CREATE UNIQUE INDEX "webhook_signing_secrets_id_workspaceId_key" ON "webhook_signing_secrets"("id", "workspaceId");
CREATE UNIQUE INDEX "webhook_signing_secrets_endpointId_version_key" ON "webhook_signing_secrets"("endpointId", "version");
CREATE UNIQUE INDEX "webhook_signing_secrets_one_active_per_endpoint_idx" ON "webhook_signing_secrets"("endpointId") WHERE "status" = 'active';
CREATE INDEX "webhook_signing_secrets_workspaceId_status_createdAt_idx" ON "webhook_signing_secrets"("workspaceId", "status", "createdAt" DESC);

CREATE UNIQUE INDEX "webhook_subscriptions_id_workspaceId_key" ON "webhook_subscriptions"("id", "workspaceId");
CREATE UNIQUE INDEX "webhook_subscriptions_endpointId_filterHash_key" ON "webhook_subscriptions"("endpointId", "filterHash");
CREATE INDEX "webhook_subscriptions_workspaceId_status_createdAt_idx" ON "webhook_subscriptions"("workspaceId", "status", "createdAt" DESC);

CREATE UNIQUE INDEX "webhook_deliveries_id_workspaceId_key" ON "webhook_deliveries"("id", "workspaceId");
CREATE UNIQUE INDEX "webhook_deliveries_subscriptionId_eventId_key" ON "webhook_deliveries"("subscriptionId", "eventId");
CREATE INDEX "webhook_deliveries_status_nextAttemptAt_createdAt_idx" ON "webhook_deliveries"("status", "nextAttemptAt", "createdAt");
CREATE INDEX "webhook_deliveries_workspaceId_status_createdAt_idx" ON "webhook_deliveries"("workspaceId", "status", "createdAt" DESC);

CREATE UNIQUE INDEX "webhook_delivery_attempts_id_workspaceId_key" ON "webhook_delivery_attempts"("id", "workspaceId");
CREATE UNIQUE INDEX "webhook_delivery_attempts_deliveryId_attemptNumber_key" ON "webhook_delivery_attempts"("deliveryId", "attemptNumber");
CREATE INDEX "webhook_delivery_attempts_workspaceId_status_scheduledAt_idx" ON "webhook_delivery_attempts"("workspaceId", "status", "scheduledAt");

ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_createdByClientId_workspaceId_fkey" FOREIGN KEY ("createdByClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webhook_signing_secrets" ADD CONSTRAINT "webhook_signing_secrets_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webhook_signing_secrets" ADD CONSTRAINT "webhook_signing_secrets_endpointId_workspaceId_fkey" FOREIGN KEY ("endpointId", "workspaceId") REFERENCES "webhook_endpoints"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_endpointId_workspaceId_fkey" FOREIGN KEY ("endpointId", "workspaceId") REFERENCES "webhook_endpoints"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_createdByClientId_workspaceId_fkey" FOREIGN KEY ("createdByClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscriptionId_workspaceId_fkey" FOREIGN KEY ("subscriptionId", "workspaceId") REFERENCES "webhook_subscriptions"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_eventId_workspaceId_fkey" FOREIGN KEY ("eventId", "workspaceId") REFERENCES "public_event_outbox"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webhook_delivery_attempts" ADD CONSTRAINT "webhook_delivery_attempts_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webhook_delivery_attempts" ADD CONSTRAINT "webhook_delivery_attempts_deliveryId_workspaceId_fkey" FOREIGN KEY ("deliveryId", "workspaceId") REFERENCES "webhook_deliveries"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
