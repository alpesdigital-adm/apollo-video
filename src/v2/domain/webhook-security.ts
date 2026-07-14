import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

import { assertDomain, type DomainErrorCode } from './errors.ts'

export const WEBHOOK_CHALLENGE_STATUSES = [
  'pending',
  'verified',
  'expired',
  'failed',
] as const
export type WebhookChallengeStatus = (typeof WEBHOOK_CHALLENGE_STATUSES)[number]

export interface WebhookVerificationChallenge {
  schemaVersion: 1
  id: string
  workspaceId: string
  endpointId: string
  tokenHash: string
  status: WebhookChallengeStatus
  attemptCount: number
  maxAttempts: number
  expiresAt: string
  createdAt: string
  verifiedAt?: string
  failedAt?: string
}

export interface SignedWebhookHeaders {
  'apollo-webhook-id': string
  'apollo-webhook-timestamp': string
  'apollo-webhook-signature': string
}

export interface VerifiedWebhookSignature {
  eventId: string
  timestamp: string
  signatureVersion: 'v1'
}

export interface WebhookReplayReceipt {
  schemaVersion: 1
  id: string
  workspaceId: string
  endpointId: string
  eventId: string
  signatureTimestamp: string
  receivedAt: string
  expiresAt: string
}

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const CHALLENGE_TOKEN_PATTERN = /^whc_[A-Za-z0-9_-]{43}$/
const SIGNATURE_PATTERN = /^v1=([0-9a-f]{64})$/
const MAX_SIGNED_BODY_BYTES = 256 * 1024

function uuid(
  value: unknown,
  field: string,
  errorCode: DomainErrorCode = 'INVALID_WEBHOOK',
): string {
  assertDomain(typeof value === 'string', errorCode, `${field} must be a UUID v4`)
  const normalized = value.trim().toLowerCase()
  assertDomain(UUID_V4_PATTERN.test(normalized), errorCode, `${field} must be a UUID v4`)
  return normalized
}

function safeId(value: string, field: string): string {
  const normalized = value.trim()
  assertDomain(SAFE_ID_PATTERN.test(normalized), 'INVALID_WEBHOOK', `${field} is invalid`)
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

function secretBuffer(secret: unknown): Buffer {
  assertDomain(
    secret instanceof Uint8Array,
    'WEBHOOK_SIGNATURE_INVALID',
    'Webhook signing key must be bytes',
  )
  const value = Buffer.from(secret)
  assertDomain(
    value.length >= 32 && value.length <= 128,
    'WEBHOOK_SIGNATURE_INVALID',
    'Webhook signing key must contain 32 to 128 bytes',
  )
  return value
}

function rawBodyBuffer(rawBody: unknown): Buffer {
  assertDomain(
    rawBody instanceof Uint8Array,
    'WEBHOOK_SIGNATURE_INVALID',
    'Webhook body must be exact bytes',
  )
  const body = Buffer.from(rawBody)
  assertDomain(
    body.length <= MAX_SIGNED_BODY_BYTES,
    'WEBHOOK_SIGNATURE_INVALID',
    'Webhook body exceeds 256 KiB',
  )
  return body
}

function signaturePayload(timestamp: string, eventId: string, rawBody: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`apollo-webhook-v1\n${timestamp}\n${eventId}\n`, 'utf8'),
    rawBody,
  ])
}

export function issueWebhookChallengeToken(
  random: (size: number) => Buffer = randomBytes,
): Readonly<{ token: string; tokenHash: string }> {
  const bytes = random(32)
  assertDomain(bytes.length === 32, 'INVALID_WEBHOOK', 'Challenge entropy source is invalid')
  const token = `whc_${bytes.toString('base64url')}`
  return Object.freeze({ token, tokenHash: hashWebhookChallengeToken(token) })
}

export function hashWebhookChallengeToken(token: string): string {
  assertDomain(
    CHALLENGE_TOKEN_PATTERN.test(token),
    'WEBHOOK_CHALLENGE_REJECTED',
    'Webhook challenge response is invalid',
  )
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function createWebhookVerificationChallenge(
  input: Omit<WebhookVerificationChallenge, 'schemaVersion'>,
): Readonly<WebhookVerificationChallenge> {
  assertDomain(SHA256_PATTERN.test(input.tokenHash), 'INVALID_WEBHOOK', 'Challenge token hash is invalid')
  assertDomain(WEBHOOK_CHALLENGE_STATUSES.includes(input.status), 'INVALID_WEBHOOK', 'Challenge status is invalid')
  assertDomain(Number.isSafeInteger(input.attemptCount) && input.attemptCount >= 0, 'INVALID_WEBHOOK', 'Challenge attempt count is invalid')
  assertDomain(Number.isSafeInteger(input.maxAttempts) && input.maxAttempts >= 1 && input.maxAttempts <= 10, 'INVALID_WEBHOOK', 'Challenge max attempts is invalid')
  assertDomain(input.attemptCount <= input.maxAttempts, 'INVALID_WEBHOOK', 'Challenge attempts exceed maximum')
  const createdAt = canonicalUtc(input.createdAt, 'createdAt')
  const expiresAt = canonicalUtc(input.expiresAt, 'expiresAt')
  const verifiedAt = input.verifiedAt ? canonicalUtc(input.verifiedAt, 'verifiedAt') : undefined
  const failedAt = input.failedAt ? canonicalUtc(input.failedAt, 'failedAt') : undefined
  assertDomain(new Date(expiresAt) > new Date(createdAt), 'INVALID_WEBHOOK', 'Challenge expiry must follow creation')
  assertDomain(
    (input.status === 'pending' && !verifiedAt && !failedAt && input.attemptCount < input.maxAttempts) ||
      (input.status === 'verified' &&
        Boolean(verifiedAt) &&
        !failedAt &&
        new Date(verifiedAt!) >= new Date(createdAt) &&
        new Date(verifiedAt!) <= new Date(expiresAt)) ||
      (['expired', 'failed'].includes(input.status) &&
        !verifiedAt &&
        Boolean(failedAt) &&
        new Date(failedAt!) >= new Date(createdAt)),
    'INVALID_WEBHOOK',
    'Challenge lifecycle is inconsistent',
  )
  return Object.freeze({
    schemaVersion: 1,
    id: uuid(input.id, 'id'),
    workspaceId: safeId(input.workspaceId, 'workspaceId'),
    endpointId: uuid(input.endpointId, 'endpointId'),
    tokenHash: input.tokenHash,
    status: input.status,
    attemptCount: input.attemptCount,
    maxAttempts: input.maxAttempts,
    expiresAt,
    createdAt,
    ...(verifiedAt ? { verifiedAt } : {}),
    ...(failedAt ? { failedAt } : {}),
  })
}

export function signWebhookPayload(input: {
  secret: Uint8Array
  eventId: string
  rawBody: Uint8Array
  timestamp: Date
}): Readonly<SignedWebhookHeaders> {
  const secret = secretBuffer(input.secret)
  const eventId = uuid(input.eventId, 'eventId')
  const body = rawBodyBuffer(input.rawBody)
  assertDomain(!Number.isNaN(input.timestamp.getTime()), 'WEBHOOK_SIGNATURE_INVALID', 'Webhook timestamp is invalid')
  const timestamp = String(Math.floor(input.timestamp.getTime() / 1_000))
  const signature = createHmac('sha256', secret)
    .update(signaturePayload(timestamp, eventId, body))
    .digest('hex')
  return Object.freeze({
    'apollo-webhook-id': eventId,
    'apollo-webhook-timestamp': timestamp,
    'apollo-webhook-signature': `v1=${signature}`,
  })
}

export function verifyWebhookSignature(input: {
  secret: Uint8Array
  rawBody: Uint8Array
  headers: SignedWebhookHeaders
  now: Date
  toleranceSeconds?: number
}): Readonly<VerifiedWebhookSignature> {
  const tolerance = input.toleranceSeconds ?? 300
  assertDomain(
    Number.isSafeInteger(tolerance) && tolerance >= 30 && tolerance <= 900,
    'WEBHOOK_SIGNATURE_INVALID',
    'Webhook timestamp tolerance is invalid',
  )
  const eventId = uuid(
    input.headers?.['apollo-webhook-id'],
    'eventId',
    'WEBHOOK_SIGNATURE_INVALID',
  )
  const timestamp = input.headers['apollo-webhook-timestamp']
  assertDomain(/^\d{1,12}$/.test(timestamp), 'WEBHOOK_SIGNATURE_INVALID', 'Webhook timestamp header is invalid')
  const epochSeconds = Number(timestamp)
  const nowSeconds = Math.floor(input.now.getTime() / 1_000)
  assertDomain(
    Number.isSafeInteger(epochSeconds) &&
      Number.isSafeInteger(nowSeconds) &&
      Math.abs(nowSeconds - epochSeconds) <= tolerance,
    'WEBHOOK_SIGNATURE_INVALID',
    'Webhook timestamp is outside the accepted window',
  )
  const match = SIGNATURE_PATTERN.exec(input.headers['apollo-webhook-signature'])
  assertDomain(match, 'WEBHOOK_SIGNATURE_INVALID', 'Webhook signature header is invalid')
  const expected = createHmac('sha256', secretBuffer(input.secret))
    .update(signaturePayload(timestamp, eventId, rawBodyBuffer(input.rawBody)))
    .digest()
  const received = Buffer.from(match[1], 'hex')
  assertDomain(
    received.length === expected.length && timingSafeEqual(received, expected),
    'WEBHOOK_SIGNATURE_INVALID',
    'Webhook signature does not match',
  )
  return Object.freeze({
    eventId,
    timestamp: new Date(epochSeconds * 1_000).toISOString(),
    signatureVersion: 'v1',
  })
}

export function createWebhookReplayReceipt(
  input: Omit<WebhookReplayReceipt, 'schemaVersion'>,
): Readonly<WebhookReplayReceipt> {
  const signatureTimestamp = canonicalUtc(input.signatureTimestamp, 'signatureTimestamp')
  const receivedAt = canonicalUtc(input.receivedAt, 'receivedAt')
  const expiresAt = canonicalUtc(input.expiresAt, 'expiresAt')
  assertDomain(
    new Date(expiresAt) > new Date(receivedAt) &&
      new Date(expiresAt).getTime() - new Date(receivedAt).getTime() <= 24 * 60 * 60 * 1_000,
    'INVALID_WEBHOOK',
    'Replay receipt expiry is invalid',
  )
  return Object.freeze({
    schemaVersion: 1,
    id: uuid(input.id, 'id'),
    workspaceId: safeId(input.workspaceId, 'workspaceId'),
    endpointId: uuid(input.endpointId, 'endpointId'),
    eventId: uuid(input.eventId, 'eventId'),
    signatureTimestamp,
    receivedAt,
    expiresAt,
  })
}
