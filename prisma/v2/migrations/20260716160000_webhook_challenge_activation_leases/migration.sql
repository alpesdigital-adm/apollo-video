CREATE TABLE "webhook_endpoint_activation_leases" (
    "endpointId" UUID NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "leaseTokenHash" CHAR(64) NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL,
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_endpoint_activation_leases_pkey" PRIMARY KEY ("endpointId"),
    CONSTRAINT "webhook_endpoint_activation_leases_token_check"
      CHECK ("leaseTokenHash" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "webhook_endpoint_activation_leases_dates_check"
      CHECK ("leaseExpiresAt" > "claimedAt")
);

CREATE UNIQUE INDEX "webhook_endpoint_activation_leases_endpointId_workspaceId_key"
ON "webhook_endpoint_activation_leases"("endpointId", "workspaceId");

CREATE INDEX "webhook_endpoint_activation_leases_workspaceId_leaseExpires_idx"
ON "webhook_endpoint_activation_leases"("workspaceId", "leaseExpiresAt");

ALTER TABLE "webhook_endpoint_activation_leases"
ADD CONSTRAINT "webhook_endpoint_activation_leases_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "webhook_endpoint_activation_leases"
ADD CONSTRAINT "webhook_endpoint_activation_leases_endpointId_workspaceId_fkey" FOREIGN KEY ("endpointId", "workspaceId") REFERENCES "webhook_endpoints"("id", "workspaceId")
ON DELETE CASCADE ON UPDATE CASCADE;
