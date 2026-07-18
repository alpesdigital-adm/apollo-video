import type { PrismaClient, V2WebhookWorkerShardLease } from '../../../../generated/prisma-v2/index.js'

import type { WebhookWorkerShardRepository } from '../../application/ports/webhook-worker-shard-repository.ts'
import { DomainError } from '../../domain/errors.ts'

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

function hydrate(row: V2WebhookWorkerShardLease) {
  return Object.freeze({
    id: row.id,
    poolId: row.poolId,
    shardIndex: row.shardIndex,
    shardCount: row.shardCount,
    leaseOwner: row.leaseOwner,
    leaseTokenHash: row.leaseTokenHash,
    heartbeatAt: row.heartbeatAt.toISOString(),
    leaseExpiresAt: row.leaseExpiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  })
}

function validCoordinates(input: {
  poolId: string
  shardIndex?: number
  shardCount: number
  leaseOwner: string
}) {
  return SAFE_ID_PATTERN.test(input.poolId) &&
    SAFE_ID_PATTERN.test(input.leaseOwner) &&
    Number.isSafeInteger(input.shardCount) &&
    input.shardCount >= 1 &&
    input.shardCount <= 1_024 &&
    (input.shardIndex === undefined || (
      Number.isSafeInteger(input.shardIndex) &&
      input.shardIndex >= 0 &&
      input.shardIndex < input.shardCount
    ))
}

export class PrismaWebhookWorkerShardRepository implements WebhookWorkerShardRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient) {
    this.client = client
  }

  async claim(command: Parameters<WebhookWorkerShardRepository['claim']>[0]) {
    const now = new Date(command.now)
    const leaseUntil = new Date(command.leaseUntil)
    if (
      !UUID_V4_PATTERN.test(command.id) ||
      !validCoordinates(command) ||
      !SHA256_PATTERN.test(command.leaseTokenHash) ||
      Number.isNaN(now.getTime()) ||
      Number.isNaN(leaseUntil.getTime()) ||
      leaseUntil <= now
    ) {
      throw new DomainError('INVALID_WEBHOOK', 'Webhook shard claim is invalid')
    }
    try {
      return await this.client.$transaction(async (transaction) => {
        await transaction.v2WebhookWorkerShardLease.deleteMany({
          where: { poolId: command.poolId, leaseExpiresAt: { lte: now } },
        })
        const incompatible = await transaction.v2WebhookWorkerShardLease.findFirst({
          where: { poolId: command.poolId, shardCount: { not: command.shardCount } },
          select: { id: true },
        })
        if (incompatible) {
          throw new DomainError(
            'WEBHOOK_SHARD_COORDINATION_REJECTED',
            'Webhook worker pool has an incompatible active shard topology',
          )
        }
        const rows = await transaction.v2WebhookWorkerShardLease.findMany({
          where: { poolId: command.poolId },
          select: { shardIndex: true, leaseOwner: true },
          orderBy: { shardIndex: 'asc' },
        })
        if (rows.some((row) => row.leaseOwner === command.leaseOwner)) return null
        const occupied = new Set(rows.map((row) => row.shardIndex))
        let shardIndex = 0
        while (shardIndex < command.shardCount && occupied.has(shardIndex)) shardIndex += 1
        if (shardIndex >= command.shardCount) return null
        const created = await transaction.v2WebhookWorkerShardLease.create({
          data: {
            id: command.id,
            poolId: command.poolId,
            shardIndex,
            shardCount: command.shardCount,
            leaseOwner: command.leaseOwner,
            leaseTokenHash: command.leaseTokenHash,
            heartbeatAt: now,
            leaseExpiresAt: leaseUntil,
            createdAt: now,
            updatedAt: now,
          },
        })
        return hydrate(created)
      })
    } catch (error) {
      if (isUniqueConstraintError(error)) return null
      throw error
    }
  }

  async heartbeat(command: Parameters<WebhookWorkerShardRepository['heartbeat']>[0]) {
    const now = new Date(command.now)
    const leaseUntil = new Date(command.leaseUntil)
    if (
      !UUID_V4_PATTERN.test(command.id) ||
      !validCoordinates(command) ||
      !SHA256_PATTERN.test(command.leaseTokenHash) ||
      Number.isNaN(now.getTime()) ||
      Number.isNaN(leaseUntil.getTime()) ||
      leaseUntil <= now
    ) {
      throw new DomainError('INVALID_WEBHOOK', 'Webhook shard heartbeat is invalid')
    }
    const updated = await this.client.v2WebhookWorkerShardLease.updateMany({
      where: {
        id: command.id,
        poolId: command.poolId,
        shardIndex: command.shardIndex,
        shardCount: command.shardCount,
        leaseOwner: command.leaseOwner,
        leaseTokenHash: command.leaseTokenHash,
        heartbeatAt: { lte: now },
        leaseExpiresAt: { gt: now },
      },
      data: { heartbeatAt: now, leaseExpiresAt: leaseUntil, updatedAt: now },
    })
    return updated.count === 1
  }

  async release(command: Parameters<WebhookWorkerShardRepository['release']>[0]) {
    const now = new Date(command.now)
    if (
      !UUID_V4_PATTERN.test(command.id) ||
      !validCoordinates(command) ||
      !SHA256_PATTERN.test(command.leaseTokenHash) ||
      Number.isNaN(now.getTime())
    ) {
      throw new DomainError('INVALID_WEBHOOK', 'Webhook shard release is invalid')
    }
    const removed = await this.client.v2WebhookWorkerShardLease.deleteMany({
      where: {
        id: command.id,
        poolId: command.poolId,
        shardIndex: command.shardIndex,
        shardCount: command.shardCount,
        leaseOwner: command.leaseOwner,
        leaseTokenHash: command.leaseTokenHash,
      },
    })
    return removed.count === 1
  }
}
