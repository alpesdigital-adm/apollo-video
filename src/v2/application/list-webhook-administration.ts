import { createHash } from 'node:crypto'

import type {
  WebhookAdministrationQueryRepository,
  WebhookEndpointListQuery,
  WebhookSubscriptionListQuery,
} from './ports/webhook-administration-query-repository.ts'
import { DomainError, assertDomain } from '../domain/errors.ts'
import {
  WEBHOOK_ENDPOINT_STATUSES,
  WEBHOOK_SUBSCRIPTION_STATUSES,
  type WebhookEndpointStatus,
  type WebhookSubscriptionStatus,
} from '../domain/webhook.ts'

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{8,1024}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

interface Cursor { v: 1; createdAt: string; id: string; filterHash: string }

function workspaceId(value: string): string {
  const normalized = value.trim()
  assertDomain(SAFE_ID_PATTERN.test(normalized), 'INVALID_ARGUMENT', 'workspaceId is invalid')
  return normalized
}

function optionalUuid(value: string | undefined, field: string): string | undefined {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return undefined
  assertDomain(UUID_V4_PATTERN.test(normalized), 'INVALID_ARGUMENT', `${field} must be a UUID v4`)
  return normalized
}

function filterHash(value: object): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function decodeCursor(value: string, expected: string): Cursor {
  assertDomain(CURSOR_PATTERN.test(value), 'INVALID_ARGUMENT', 'after is not a valid webhook cursor')
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>
    assertDomain(
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) &&
        Object.keys(parsed).length === 4 && parsed.v === 1 &&
        typeof parsed.createdAt === 'string' && new Date(parsed.createdAt).toISOString() === parsed.createdAt &&
        typeof parsed.id === 'string' && UUID_V4_PATTERN.test(parsed.id) &&
        typeof parsed.filterHash === 'string' && SHA256_PATTERN.test(parsed.filterHash) &&
        parsed.filterHash === expected,
      'INVALID_ARGUMENT',
      'after does not match this webhook query',
    )
    return parsed as unknown as Cursor
  } catch (error) {
    if (error instanceof DomainError) throw error
    throw new DomainError('INVALID_ARGUMENT', 'after is not a valid webhook cursor')
  }
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function pageRequest(input: { workspaceId: string; limit?: number; after?: string }, hash: string) {
  const limit = input.limit ?? 20
  assertDomain(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'INVALID_ARGUMENT', 'limit must be an integer from 1 to 100')
  const afterValue = input.after?.trim()
  return { limit, after: afterValue ? decodeCursor(afterValue, hash) : undefined }
}

function pageResult<T>(records: readonly T[], limit: number, hash: string, identity: (value: T) => { id: string; createdAt: string }) {
  assertDomain(records.length <= limit + 1, 'PERSISTENCE_CONFLICT', 'Webhook query returned too many records')
  const page = records.slice(0, limit)
  const last = page.at(-1)
  return Object.freeze({
    records: Object.freeze(page),
    ...(records.length > limit && last
      ? { nextCursor: encodeCursor({ v: 1, ...identity(last), filterHash: hash }) }
      : {}),
  })
}

export function listWebhookEndpointsService(dependencies: { repository: WebhookAdministrationQueryRepository }) {
  return async (request: { workspaceId: string; limit?: number; after?: string; status?: string }) => {
    const scopedWorkspaceId = workspaceId(request.workspaceId)
    const statusValue = request.status?.trim()
    assertDomain(!statusValue || WEBHOOK_ENDPOINT_STATUSES.includes(statusValue as WebhookEndpointStatus), 'INVALID_ARGUMENT', 'status is not supported')
    const status = statusValue as WebhookEndpointStatus | undefined
    const hash = filterHash({ kind: 'endpoint', workspaceId: scopedWorkspaceId, status: status ?? null })
    const page = pageRequest({ workspaceId: scopedWorkspaceId, limit: request.limit, after: request.after }, hash)
    const query: WebhookEndpointListQuery = {
      workspaceId: scopedWorkspaceId,
      limit: page.limit + 1,
      ...(status ? { status } : {}),
      ...(page.after ? { after: { createdAt: page.after.createdAt, id: page.after.id } } : {}),
    }
    const records = await dependencies.repository.listEndpoints(query)
    const result = pageResult(records, page.limit, hash, (record) => record.endpoint)
    return Object.freeze({ endpoints: result.records, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) })
  }
}

export function listWebhookSubscriptionsService(dependencies: { repository: WebhookAdministrationQueryRepository }) {
  return async (request: { workspaceId: string; limit?: number; after?: string; status?: string; endpointId?: string }) => {
    const scopedWorkspaceId = workspaceId(request.workspaceId)
    const statusValue = request.status?.trim()
    assertDomain(!statusValue || WEBHOOK_SUBSCRIPTION_STATUSES.includes(statusValue as WebhookSubscriptionStatus), 'INVALID_ARGUMENT', 'status is not supported')
    const status = statusValue as WebhookSubscriptionStatus | undefined
    const endpointId = optionalUuid(request.endpointId, 'endpointId')
    const hash = filterHash({ kind: 'subscription', workspaceId: scopedWorkspaceId, status: status ?? null, endpointId: endpointId ?? null })
    const page = pageRequest({ workspaceId: scopedWorkspaceId, limit: request.limit, after: request.after }, hash)
    const query: WebhookSubscriptionListQuery = {
      workspaceId: scopedWorkspaceId,
      limit: page.limit + 1,
      ...(status ? { status } : {}),
      ...(endpointId ? { endpointId } : {}),
      ...(page.after ? { after: { createdAt: page.after.createdAt, id: page.after.id } } : {}),
    }
    const records = await dependencies.repository.listSubscriptions(query)
    const result = pageResult(records, page.limit, hash, (record) => record)
    return Object.freeze({ subscriptions: result.records, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) })
  }
}
