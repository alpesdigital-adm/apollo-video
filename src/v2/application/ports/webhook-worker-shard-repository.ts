export interface WebhookWorkerShardLeaseRecord {
  id: string
  poolId: string
  shardIndex: number
  shardCount: number
  leaseOwner: string
  leaseTokenHash: string
  heartbeatAt: string
  leaseExpiresAt: string
  createdAt: string
}

export interface ClaimWebhookWorkerShardCommand {
  id: string
  poolId: string
  shardCount: number
  leaseOwner: string
  leaseTokenHash: string
  now: string
  leaseUntil: string
}

export interface WebhookWorkerShardFence {
  id: string
  poolId: string
  shardIndex: number
  shardCount: number
  leaseOwner: string
  leaseTokenHash: string
  now: string
}

export interface HeartbeatWebhookWorkerShardCommand extends WebhookWorkerShardFence {
  leaseUntil: string
}

export interface WebhookWorkerShardRepository {
  claim(
    command: Readonly<ClaimWebhookWorkerShardCommand>,
  ): Promise<Readonly<WebhookWorkerShardLeaseRecord> | null>
  heartbeat(command: Readonly<HeartbeatWebhookWorkerShardCommand>): Promise<boolean>
  release(fence: Readonly<WebhookWorkerShardFence>): Promise<boolean>
}
