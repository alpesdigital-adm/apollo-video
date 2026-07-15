import { createHash } from 'node:crypto'
import { isIP } from 'node:net'

import { DomainError, assertDomain } from './errors.ts'
import { PUBLIC_EVENT_CATALOG } from './public-event.ts'

export const WEBHOOK_ENDPOINT_STATUSES = [
  'pending-verification',
  'active',
  'suspended',
  'revoked',
] as const
export type WebhookEndpointStatus = (typeof WEBHOOK_ENDPOINT_STATUSES)[number]

export const WEBHOOK_SECRET_STATUSES = ['active', 'retired', 'revoked'] as const
export type WebhookSecretStatus = (typeof WEBHOOK_SECRET_STATUSES)[number]

export const WEBHOOK_SUBSCRIPTION_STATUSES = [
  'pending-verification',
  'active',
  'paused',
  'revoked',
] as const
export type WebhookSubscriptionStatus = (typeof WEBHOOK_SUBSCRIPTION_STATUSES)[number]

export const WEBHOOK_DELIVERY_STATUSES = [
  'pending',
  'in-flight',
  'retry-scheduled',
  'succeeded',
  'dead-lettered',
] as const
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number]

export const WEBHOOK_ATTEMPT_STATUSES = [
  'scheduled',
  'in-flight',
  'succeeded',
  'failed',
] as const
export type WebhookDeliveryAttemptStatus = (typeof WEBHOOK_ATTEMPT_STATUSES)[number]

export interface WebhookEndpoint {
  schemaVersion: 1
  id: string
  workspaceId: string
  url: string
  status: WebhookEndpointStatus
  createdByClientId: string
  createdAt: string
  verifiedAt?: string
  suspendedAt?: string
  revokedAt?: string
}

export interface WebhookSigningSecret {
  schemaVersion: 1
  id: string
  workspaceId: string
  endpointId: string
  version: number
  algorithm: 'hmac-sha256'
  keyRef: string
  fingerprint: string
  status: WebhookSecretStatus
  createdAt: string
  retiredAt?: string
  revokedAt?: string
}

export interface WebhookEventFilter {
  eventTypes: readonly string[]
  resourceIds?: readonly string[]
  hash: string
}

export interface WebhookFilterableEvent {
  type: string
  resourceId: string
}

export interface WebhookSubscription {
  schemaVersion: 1
  id: string
  workspaceId: string
  endpointId: string
  status: WebhookSubscriptionStatus
  filter: Readonly<WebhookEventFilter>
  createdByClientId: string
  createdAt: string
  pausedAt?: string
  revokedAt?: string
}

export interface WebhookDelivery {
  schemaVersion: 1
  id: string
  workspaceId: string
  subscriptionId: string
  eventId: string
  status: WebhookDeliveryStatus
  attemptCount: number
  maxAttempts: number
  nextAttemptAt: string
  createdAt: string
  completedAt?: string
  deadLetteredAt?: string
}

export interface WebhookDeliveryAttempt {
  schemaVersion: 1
  id: string
  workspaceId: string
  deliveryId: string
  attemptNumber: number
  status: WebhookDeliveryAttemptStatus
  scheduledAt: string
  createdAt: string
  startedAt?: string
  completedAt?: string
  responseStatus?: number
  responseBodyHash?: string
  errorCode?: string
}

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const SECRET_REF_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9][A-Za-z0-9._:/-]{2,217}$/
const MAX_FILTER_VALUES = 100

function invalidWebhook(message: string, details: Record<string, unknown> = {}): never {
  throw new DomainError('INVALID_WEBHOOK', message, details)
}

function webhookId(value: string, field: string): string {
  const normalized = value.trim().toLowerCase()
  assertDomain(UUID_V4_PATTERN.test(normalized), 'INVALID_WEBHOOK', `${field} must be a UUID v4`)
  return normalized
}

function safeId(value: string, field: string): string {
  const normalized = value.trim()
  assertDomain(
    SAFE_ID_PATTERN.test(normalized),
    'INVALID_WEBHOOK',
    `${field} must contain 3 to 128 safe characters`,
  )
  return normalized
}

function canonicalUtc(value: string, field: string): string {
  const date = new Date(value)
  assertDomain(
    !Number.isNaN(date.getTime()) && date.toISOString() === value,
    'INVALID_WEBHOOK',
    `${field} must be canonical UTC`,
  )
  return value
}

export function normalizeWebhookUrl(value: string): string {
  const candidate = value.trim()
  assertDomain(candidate.length <= 2_048, 'INVALID_WEBHOOK', 'Webhook URL is too long')
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    invalidWebhook('Webhook URL is invalid')
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  const addressCandidate = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
  assertDomain(url.protocol === 'https:', 'INVALID_WEBHOOK', 'Webhook URL must use HTTPS')
  assertDomain(!url.username && !url.password, 'INVALID_WEBHOOK', 'Webhook URL cannot contain credentials')
  assertDomain(!url.search && !url.hash, 'INVALID_WEBHOOK', 'Webhook URL cannot contain query or fragment')
  assertDomain(!url.port || url.port === '443', 'INVALID_WEBHOOK', 'Webhook URL must use port 443')
  assertDomain(
    hostname.length >= 4 &&
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname) &&
      hostname !== 'localhost' &&
      !hostname.endsWith('.localhost') &&
      !hostname.endsWith('.local') &&
      isIP(addressCandidate) === 0,
    'INVALID_WEBHOOK',
    'Webhook URL must use a public DNS hostname',
  )
  url.hostname = hostname
  url.port = ''
  return url.toString()
}

export function createWebhookEventFilter(input: {
  eventTypes: readonly string[]
  resourceIds?: readonly string[]
}): Readonly<WebhookEventFilter> {
  const knownTypes = new Set(PUBLIC_EVENT_CATALOG.map((event) => event.type))
  assertDomain(
    input.eventTypes.length >= 1 && input.eventTypes.length <= MAX_FILTER_VALUES,
    'INVALID_WEBHOOK',
    'Webhook filter must contain 1 to 100 event types',
  )
  const eventTypes = [...input.eventTypes].map((type) => type.trim()).sort()
  assertDomain(
    new Set(eventTypes).size === eventTypes.length && eventTypes.every((type) => knownTypes.has(type)),
    'INVALID_WEBHOOK',
    'Webhook filter event types must be unique catalog entries',
  )
  const resourceIds = input.resourceIds
    ? [...input.resourceIds].map((id) => safeId(id, 'filter.resourceId')).sort()
    : undefined
  assertDomain(
    !resourceIds ||
      (resourceIds.length >= 1 &&
        resourceIds.length <= MAX_FILTER_VALUES &&
        new Set(resourceIds).size === resourceIds.length),
    'INVALID_WEBHOOK',
    'Webhook filter resource IDs must contain 1 to 100 unique values',
  )
  const filterValue = { eventTypes, ...(resourceIds ? { resourceIds } : {}) }
  const hash = createHash('sha256').update(JSON.stringify(filterValue)).digest('hex')
  return Object.freeze({
    eventTypes: Object.freeze(eventTypes),
    ...(resourceIds ? { resourceIds: Object.freeze(resourceIds) } : {}),
    hash,
  })
}

export function webhookEventMatchesFilter(
  filter: Readonly<WebhookEventFilter>,
  event: Readonly<WebhookFilterableEvent>,
): boolean {
  return (
    filter.eventTypes.includes(event.type) &&
    (!filter.resourceIds || filter.resourceIds.includes(event.resourceId))
  )
}

export function createWebhookEndpoint(
  input: Omit<WebhookEndpoint, 'schemaVersion' | 'url'> & { url: string },
): Readonly<WebhookEndpoint> {
  const createdAt = canonicalUtc(input.createdAt, 'createdAt')
  const verifiedAt = input.verifiedAt ? canonicalUtc(input.verifiedAt, 'verifiedAt') : undefined
  const suspendedAt = input.suspendedAt
    ? canonicalUtc(input.suspendedAt, 'suspendedAt')
    : undefined
  const revokedAt = input.revokedAt ? canonicalUtc(input.revokedAt, 'revokedAt') : undefined
  assertDomain(WEBHOOK_ENDPOINT_STATUSES.includes(input.status), 'INVALID_WEBHOOK', 'Webhook endpoint status is invalid')
  assertDomain(
    (input.status === 'pending-verification' && !verifiedAt && !suspendedAt && !revokedAt) ||
      (input.status === 'active' && Boolean(verifiedAt) && !suspendedAt && !revokedAt) ||
      (input.status === 'suspended' && Boolean(verifiedAt) && Boolean(suspendedAt) && !revokedAt) ||
      (input.status === 'revoked' && Boolean(revokedAt)),
    'INVALID_WEBHOOK',
    'Webhook endpoint verification state is inconsistent',
  )
  return Object.freeze({
    schemaVersion: 1,
    id: webhookId(input.id, 'id'),
    workspaceId: safeId(input.workspaceId, 'workspaceId'),
    url: normalizeWebhookUrl(input.url),
    status: input.status,
    createdByClientId: safeId(input.createdByClientId, 'createdByClientId'),
    createdAt,
    ...(verifiedAt ? { verifiedAt } : {}),
    ...(suspendedAt ? { suspendedAt } : {}),
    ...(revokedAt ? { revokedAt } : {}),
  })
}

export function createWebhookSigningSecret(
  input: Omit<WebhookSigningSecret, 'schemaVersion' | 'algorithm'>,
): Readonly<WebhookSigningSecret> {
  assertDomain(Number.isSafeInteger(input.version) && input.version >= 1, 'INVALID_WEBHOOK', 'Webhook secret version must be positive')
  assertDomain(
    SECRET_REF_PATTERN.test(input.keyRef) && !input.keyRef.includes('@'),
    'INVALID_WEBHOOK',
    'Webhook secret must use an opaque provider reference',
  )
  assertDomain(SHA256_PATTERN.test(input.fingerprint), 'INVALID_WEBHOOK', 'Webhook secret fingerprint is invalid')
  assertDomain(WEBHOOK_SECRET_STATUSES.includes(input.status), 'INVALID_WEBHOOK', 'Webhook secret status is invalid')
  const createdAt = canonicalUtc(input.createdAt, 'createdAt')
  const retiredAt = input.retiredAt ? canonicalUtc(input.retiredAt, 'retiredAt') : undefined
  const revokedAt = input.revokedAt ? canonicalUtc(input.revokedAt, 'revokedAt') : undefined
  assertDomain(
    (input.status === 'active' && !retiredAt && !revokedAt) ||
      (input.status === 'retired' && Boolean(retiredAt) && !revokedAt) ||
      (input.status === 'revoked' && Boolean(revokedAt)),
    'INVALID_WEBHOOK',
    'Webhook secret retirement state is inconsistent',
  )
  return Object.freeze({
    schemaVersion: 1,
    id: webhookId(input.id, 'id'),
    workspaceId: safeId(input.workspaceId, 'workspaceId'),
    endpointId: webhookId(input.endpointId, 'endpointId'),
    version: input.version,
    algorithm: 'hmac-sha256',
    keyRef: input.keyRef,
    fingerprint: input.fingerprint,
    status: input.status,
    createdAt,
    ...(retiredAt ? { retiredAt } : {}),
    ...(revokedAt ? { revokedAt } : {}),
  })
}

export function createWebhookSubscription(
  input: Omit<WebhookSubscription, 'schemaVersion' | 'filter'> & {
    filter: { eventTypes: readonly string[]; resourceIds?: readonly string[] }
  },
): Readonly<WebhookSubscription> {
  assertDomain(WEBHOOK_SUBSCRIPTION_STATUSES.includes(input.status), 'INVALID_WEBHOOK', 'Webhook subscription status is invalid')
  const pausedAt = input.pausedAt ? canonicalUtc(input.pausedAt, 'pausedAt') : undefined
  const revokedAt = input.revokedAt ? canonicalUtc(input.revokedAt, 'revokedAt') : undefined
  assertDomain(
    (['pending-verification', 'active'].includes(input.status) && !pausedAt && !revokedAt) ||
      (input.status === 'paused' && Boolean(pausedAt) && !revokedAt) ||
      (input.status === 'revoked' && Boolean(revokedAt)),
    'INVALID_WEBHOOK',
    'Webhook subscription state is inconsistent',
  )
  return Object.freeze({
    schemaVersion: 1,
    id: webhookId(input.id, 'id'),
    workspaceId: safeId(input.workspaceId, 'workspaceId'),
    endpointId: webhookId(input.endpointId, 'endpointId'),
    status: input.status,
    filter: createWebhookEventFilter(input.filter),
    createdByClientId: safeId(input.createdByClientId, 'createdByClientId'),
    createdAt: canonicalUtc(input.createdAt, 'createdAt'),
    ...(pausedAt ? { pausedAt } : {}),
    ...(revokedAt ? { revokedAt } : {}),
  })
}

export function createWebhookDelivery(
  input: Omit<WebhookDelivery, 'schemaVersion'>,
): Readonly<WebhookDelivery> {
  assertDomain(WEBHOOK_DELIVERY_STATUSES.includes(input.status), 'INVALID_WEBHOOK', 'Webhook delivery status is invalid')
  assertDomain(Number.isSafeInteger(input.attemptCount) && input.attemptCount >= 0, 'INVALID_WEBHOOK', 'Webhook delivery attempt count is invalid')
  assertDomain(Number.isSafeInteger(input.maxAttempts) && input.maxAttempts >= 1 && input.maxAttempts <= 20, 'INVALID_WEBHOOK', 'Webhook delivery max attempts is invalid')
  assertDomain(input.attemptCount <= input.maxAttempts, 'INVALID_WEBHOOK', 'Webhook delivery attempts exceed maximum')
  const completedAt = input.completedAt ? canonicalUtc(input.completedAt, 'completedAt') : undefined
  const deadLetteredAt = input.deadLetteredAt
    ? canonicalUtc(input.deadLetteredAt, 'deadLetteredAt')
    : undefined
  assertDomain(
    (['pending', 'in-flight', 'retry-scheduled'].includes(input.status) &&
      !completedAt &&
      !deadLetteredAt) ||
      (input.status === 'succeeded' && Boolean(completedAt) && !deadLetteredAt) ||
      (input.status === 'dead-lettered' && Boolean(completedAt) && Boolean(deadLetteredAt)),
    'INVALID_WEBHOOK',
    'Webhook delivery terminal state is inconsistent',
  )
  assertDomain(
    (input.status === 'pending' && input.attemptCount === 0) ||
      (input.status === 'in-flight' && input.attemptCount >= 1) ||
      (input.status === 'retry-scheduled' &&
        input.attemptCount >= 1 &&
        input.attemptCount < input.maxAttempts) ||
      (['succeeded', 'dead-lettered'].includes(input.status) && input.attemptCount >= 1),
    'INVALID_WEBHOOK',
    'Webhook delivery attempt lifecycle is inconsistent',
  )
  return Object.freeze({
    schemaVersion: 1,
    id: webhookId(input.id, 'id'),
    workspaceId: safeId(input.workspaceId, 'workspaceId'),
    subscriptionId: webhookId(input.subscriptionId, 'subscriptionId'),
    eventId: webhookId(input.eventId, 'eventId'),
    status: input.status,
    attemptCount: input.attemptCount,
    maxAttempts: input.maxAttempts,
    nextAttemptAt: canonicalUtc(input.nextAttemptAt, 'nextAttemptAt'),
    createdAt: canonicalUtc(input.createdAt, 'createdAt'),
    ...(completedAt ? { completedAt } : {}),
    ...(deadLetteredAt ? { deadLetteredAt } : {}),
  })
}

export function replayWebhookDelivery(
  delivery: Readonly<WebhookDelivery>,
  requestedAtValue: string,
  nextAttemptAtValue: string,
): Readonly<WebhookDelivery> {
  const requestedAt = canonicalUtc(requestedAtValue, 'requestedAt')
  const nextAttemptAt = canonicalUtc(nextAttemptAtValue, 'nextAttemptAt')
  assertDomain(
    ['succeeded', 'dead-lettered'].includes(delivery.status),
    'WEBHOOK_DELIVERY_REPLAY_REJECTED',
    'Only a terminal webhook delivery can be replayed',
  )
  assertDomain(
    delivery.attemptCount < 20,
    'WEBHOOK_DELIVERY_REPLAY_REJECTED',
    'Webhook delivery reached the absolute attempt limit',
  )
  assertDomain(
    Date.parse(requestedAt) >= Date.parse(delivery.createdAt) &&
      Date.parse(nextAttemptAt) > Date.parse(requestedAt),
    'WEBHOOK_DELIVERY_REPLAY_REJECTED',
    'Webhook delivery replay schedule is invalid',
  )
  return createWebhookDelivery({
    id: delivery.id,
    workspaceId: delivery.workspaceId,
    subscriptionId: delivery.subscriptionId,
    eventId: delivery.eventId,
    status: 'retry-scheduled',
    attemptCount: delivery.attemptCount,
    maxAttempts: Math.max(delivery.maxAttempts, delivery.attemptCount + 1),
    nextAttemptAt,
    createdAt: delivery.createdAt,
  })
}

export function createWebhookDeliveryAttempt(
  input: Omit<WebhookDeliveryAttempt, 'schemaVersion'>,
): Readonly<WebhookDeliveryAttempt> {
  assertDomain(WEBHOOK_ATTEMPT_STATUSES.includes(input.status), 'INVALID_WEBHOOK', 'Webhook attempt status is invalid')
  assertDomain(Number.isSafeInteger(input.attemptNumber) && input.attemptNumber >= 1 && input.attemptNumber <= 20, 'INVALID_WEBHOOK', 'Webhook attempt number is invalid')
  const startedAt = input.startedAt ? canonicalUtc(input.startedAt, 'startedAt') : undefined
  const completedAt = input.completedAt ? canonicalUtc(input.completedAt, 'completedAt') : undefined
  assertDomain(
    input.responseStatus === undefined ||
      (Number.isInteger(input.responseStatus) && input.responseStatus >= 100 && input.responseStatus <= 599),
    'INVALID_WEBHOOK',
    'Webhook attempt response status is invalid',
  )
  assertDomain(
    input.responseBodyHash === undefined || SHA256_PATTERN.test(input.responseBodyHash),
    'INVALID_WEBHOOK',
    'Webhook attempt response hash is invalid',
  )
  assertDomain(
    input.errorCode === undefined || /^[a-z][a-z0-9_-]{2,63}$/.test(input.errorCode),
    'INVALID_WEBHOOK',
    'Webhook attempt error code is invalid',
  )
  assertDomain(
    (input.status === 'scheduled' &&
      !startedAt &&
      !completedAt &&
      input.responseStatus === undefined &&
      input.errorCode === undefined) ||
      (input.status === 'in-flight' && Boolean(startedAt) && !completedAt) ||
      (input.status === 'succeeded' &&
        Boolean(startedAt) &&
        Boolean(completedAt) &&
        input.responseStatus !== undefined &&
        input.responseStatus >= 200 &&
        input.responseStatus <= 299 &&
        input.errorCode === undefined) ||
      (input.status === 'failed' &&
        Boolean(startedAt) &&
        Boolean(completedAt) &&
        (input.responseStatus !== undefined || input.errorCode !== undefined)),
    'INVALID_WEBHOOK',
    'Webhook attempt state is inconsistent',
  )
  const scheduledAt = canonicalUtc(input.scheduledAt, 'scheduledAt')
  const createdAt = canonicalUtc(input.createdAt, 'createdAt')
  assertDomain(
    (!startedAt || scheduledAt <= startedAt) &&
      (!completedAt || (Boolean(startedAt) && startedAt! <= completedAt)),
    'INVALID_WEBHOOK',
    'Webhook attempt chronology is inconsistent',
  )
  return Object.freeze({
    schemaVersion: 1,
    id: webhookId(input.id, 'id'),
    workspaceId: safeId(input.workspaceId, 'workspaceId'),
    deliveryId: webhookId(input.deliveryId, 'deliveryId'),
    attemptNumber: input.attemptNumber,
    status: input.status,
    scheduledAt,
    createdAt,
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(input.responseStatus !== undefined ? { responseStatus: input.responseStatus } : {}),
    ...(input.responseBodyHash ? { responseBodyHash: input.responseBodyHash } : {}),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
  })
}
