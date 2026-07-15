CREATE TABLE "webhook_worker_shard_leases" (
    "id" UUID NOT NULL,
    "poolId" VARCHAR(128) NOT NULL,
    "shardIndex" INTEGER NOT NULL,
    "shardCount" INTEGER NOT NULL,
    "leaseOwner" VARCHAR(128) NOT NULL,
    "leaseTokenHash" CHAR(64) NOT NULL,
    "heartbeatAt" TIMESTAMP(3) NOT NULL,
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_worker_shard_leases_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "webhook_worker_shard_leases_coordinates_check"
      CHECK (
        "shardCount" >= 1 AND "shardCount" <= 1024 AND
        "shardIndex" >= 0 AND "shardIndex" < "shardCount"
      ),
    CONSTRAINT "webhook_worker_shard_leases_identity_check"
      CHECK (
        "poolId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$' AND
        "leaseOwner" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
      ),
    CONSTRAINT "webhook_worker_shard_leases_token_check"
      CHECK ("leaseTokenHash" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "webhook_worker_shard_leases_dates_check"
      CHECK ("leaseExpiresAt" > "heartbeatAt")
);

CREATE UNIQUE INDEX "webhook_worker_shard_leases_poolId_shardIndex_key"
ON "webhook_worker_shard_leases"("poolId", "shardIndex");

CREATE UNIQUE INDEX "webhook_worker_shard_leases_poolId_leaseOwner_key"
ON "webhook_worker_shard_leases"("poolId", "leaseOwner");

CREATE INDEX "webhook_worker_shard_leases_poolId_leaseExpiresAt_shardInde_idx"
ON "webhook_worker_shard_leases"("poolId", "leaseExpiresAt", "shardIndex");
