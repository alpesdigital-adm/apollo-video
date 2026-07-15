import { createHash } from 'node:crypto'

import type { WebhookWorkspaceDiscoveryRepository } from './ports/webhook-workspace-discovery-repository.ts'
import { DomainError, assertDomain } from '../domain/errors.ts'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{16,2048}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

interface DiscoveryCursor {
  v: 1
  asOf: string
  afterWorkspaceId: string
  queryHash: string
}

function queryHash(shardIndex: number, shardCount: number): string {
  return createHash('sha256')
    .update(JSON.stringify({ shardIndex, shardCount }), 'utf8')
    .digest('hex')
}

function encodeCursor(cursor: DiscoveryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeCursor(value: string, expectedQueryHash: string): DiscoveryCursor {
  assertDomain(
    CURSOR_PATTERN.test(value),
    'INVALID_WEBHOOK',
    'Webhook discovery cursor is invalid',
  )
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    assertDomain(
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed),
      'INVALID_WEBHOOK',
      'Webhook discovery cursor is invalid',
    )
    const cursor = parsed as Record<string, unknown>
    assertDomain(
      Object.keys(cursor).length === 4 &&
        cursor.v === 1 &&
        typeof cursor.asOf === 'string' &&
        new Date(cursor.asOf).toISOString() === cursor.asOf &&
        typeof cursor.afterWorkspaceId === 'string' &&
        ID_PATTERN.test(cursor.afterWorkspaceId) &&
        typeof cursor.queryHash === 'string' &&
        SHA256_PATTERN.test(cursor.queryHash) &&
        cursor.queryHash === expectedQueryHash,
      'INVALID_WEBHOOK',
      'Webhook discovery cursor does not match this shard',
    )
    return cursor as unknown as DiscoveryCursor
  } catch (error) {
    if (error instanceof DomainError) throw error
    throw new DomainError('INVALID_WEBHOOK', 'Webhook discovery cursor is invalid')
  }
}

export function webhookWorkspaceShard(workspaceId: string, shardCount: number): number {
  assertDomain(ID_PATTERN.test(workspaceId), 'INVALID_WEBHOOK', 'Webhook workspace ID is invalid')
  assertDomain(
    Number.isSafeInteger(shardCount) && shardCount >= 1 && shardCount <= 1_024,
    'INVALID_WEBHOOK',
    'Webhook shard count must be between 1 and 1024',
  )
  return createHash('sha256').update(workspaceId, 'utf8').digest().readUInt32BE(0) % shardCount
}

export function discoverRunnableWebhookWorkspacesService(dependencies: {
  repository: WebhookWorkspaceDiscoveryRepository
  clock: () => Date
}) {
  return async function discoverRunnableWebhookWorkspaces(request: {
    shardIndex?: number
    shardCount?: number
    scanLimit?: number
    cursor?: string
  } = {}) {
    const shardCount = request.shardCount ?? 1
    const shardIndex = request.shardIndex ?? 0
    const scanLimit = request.scanLimit ?? 100
    assertDomain(
      Number.isSafeInteger(shardCount) && shardCount >= 1 && shardCount <= 1_024 &&
        Number.isSafeInteger(shardIndex) && shardIndex >= 0 && shardIndex < shardCount,
      'INVALID_WEBHOOK',
      'Webhook shard coordinates are invalid',
    )
    assertDomain(
      Number.isSafeInteger(scanLimit) && scanLimit >= 1 && scanLimit <= 500,
      'INVALID_WEBHOOK',
      'Webhook discovery scan limit must be between 1 and 500',
    )
    const expectedQueryHash = queryHash(shardIndex, shardCount)
    const decoded = request.cursor
      ? decodeCursor(request.cursor, expectedQueryHash)
      : undefined
    const now = decoded ? new Date(decoded.asOf) : dependencies.clock()
    assertDomain(!Number.isNaN(now.getTime()), 'INVALID_WEBHOOK', 'Webhook discovery clock is invalid')
    const rows = await dependencies.repository.listRunnableWorkspaceIds({
      asOf: now.toISOString(),
      limit: scanLimit + 1,
      ...(decoded ? { afterWorkspaceId: decoded.afterWorkspaceId } : {}),
    })
    assertDomain(
      rows.length <= scanLimit + 1 &&
        rows.every((workspaceId) => ID_PATTERN.test(workspaceId)) &&
        rows.every((workspaceId, index) => index === 0 || rows[index - 1] < workspaceId),
      'PERSISTENCE_CONFLICT',
      'Webhook workspace discovery returned an invalid page',
    )
    const scanned = rows.slice(0, scanLimit)
    const workspaceIds = scanned.filter(
      (workspaceId) => webhookWorkspaceShard(workspaceId, shardCount) === shardIndex,
    )
    const hasMore = rows.length > scanLimit
    return Object.freeze({
      asOf: now.toISOString(),
      workspaceIds: Object.freeze(workspaceIds),
      ...(hasMore && scanned.length > 0
        ? {
            nextCursor: encodeCursor({
              v: 1,
              asOf: now.toISOString(),
              afterWorkspaceId: scanned[scanned.length - 1],
              queryHash: expectedQueryHash,
            }),
          }
        : {}),
    })
  }
}
