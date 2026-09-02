import { createHmac, timingSafeEqual } from 'node:crypto'

import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import { PROVIDER_STATUS_VALUES, type ProviderStatus } from './provider-contract.ts'

/**
 * Inbound provider callbacks.
 *
 * This is the opposite direction from `webhook-security.ts`: there Apollo signs
 * what it sends to a customer; here a provider sends us something and every
 * field of it is untrusted until proven otherwise.
 *
 * The whole verification runs over the **exact bytes** received. Parsing the
 * body and re-serialising it before checking the signature would let a caller
 * reorder keys, change number formatting or smuggle a second `providerJobId`
 * past the check — the signature must cover what actually arrived on the wire.
 *
 * Nothing here reads or writes state. Verification returns a decision; the
 * application service decides what to persist. A callback that fails any check
 * must leave the job exactly as it was.
 */
export const PROVIDER_CALLBACK_EVENT_SCHEMA_VERSION = 'provider-callback-event/v1' as const

export const PROVIDER_CALLBACK_SIGNATURE_HEADER = 'apollo-provider-signature'
export const PROVIDER_CALLBACK_TIMESTAMP_HEADER = 'apollo-provider-timestamp'
export const PROVIDER_CALLBACK_EVENT_HEADER = 'apollo-provider-event-id'

export const PROVIDER_CALLBACK_REJECTIONS = [
  'signature-invalid',
  'timestamp-outside-window',
  'timestamp-malformed',
  'event-id-malformed',
  'body-too-large',
  'body-malformed',
  'correlation-mismatch',
  'provider-mismatch',
  'workspace-mismatch',
  'status-unsupported',
  'job-terminal',
] as const
export type ProviderCallbackRejection = (typeof PROVIDER_CALLBACK_REJECTIONS)[number]

export const PROVIDER_CALLBACK_OUTCOMES = ['accepted', 'duplicate', 'rejected'] as const
export type ProviderCallbackOutcome = (typeof PROVIDER_CALLBACK_OUTCOMES)[number]

export interface ProviderCallbackBody {
  providerJobId: string
  status: ProviderStatus
  occurredAt: string
  retryAfterMs?: number
}

export interface ProviderCallbackEvent {
  schemaVersion: typeof PROVIDER_CALLBACK_EVENT_SCHEMA_VERSION
  workspaceId: string
  providerId: string
  eventId: string
  jobId: string
  providerJobId: string
  status: ProviderStatus
  occurredAt: string
  retryAfterMs: number | null
  /**
   * SHA-256 of the exact bytes received. Two callbacks carrying the same event
   * id but different bytes are a tampering signal, not a duplicate.
   */
  payloadSha256: string
  receivedAt: string
  eventHash: string
}

export type ProviderCallbackVerification =
  | Readonly<{ outcome: 'accepted'; event: Readonly<ProviderCallbackEvent> }>
  | Readonly<{ outcome: 'rejected'; reason: ProviderCallbackRejection }>

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const SIGNATURE = /^v1=([a-f0-9]{64})$/
const MAXIMUM_BODY_BYTES = 64 * 1_024
const MAXIMUM_RETRY_AFTER_MS = 60 * 60 * 1_000

function signaturePayload(timestamp: string, eventId: string, body: Uint8Array): Buffer {
  // Length-prefixed so no field can eat another: a provider id containing a dot
  // must not be able to impersonate a different timestamp/event split.
  const prefix = Buffer.from(`${timestamp.length}.${timestamp}.${eventId.length}.${eventId}.`, 'utf8')
  return Buffer.concat([prefix, Buffer.from(body)])
}

/** Test/adapter helper: produce exactly the headers a provider must send. */
export function signProviderCallback(input: {
  secret: Uint8Array
  eventId: string
  rawBody: Uint8Array
  timestamp: Date
}): Readonly<Record<string, string>> {
  assertDomain(input.secret.byteLength >= 32, 'INVALID_ARGUMENT', 'Provider callback secret is too short')
  assertDomain(ID.test(input.eventId), 'INVALID_ARGUMENT', 'eventId is invalid')
  assertDomain(!Number.isNaN(input.timestamp.getTime()), 'INVALID_ARGUMENT', 'timestamp is invalid')
  const timestamp = String(Math.floor(input.timestamp.getTime() / 1_000))
  const signature = createHmac('sha256', Buffer.from(input.secret))
    .update(signaturePayload(timestamp, input.eventId, input.rawBody))
    .digest('hex')
  return Object.freeze({
    [PROVIDER_CALLBACK_EVENT_HEADER]: input.eventId,
    [PROVIDER_CALLBACK_TIMESTAMP_HEADER]: timestamp,
    [PROVIDER_CALLBACK_SIGNATURE_HEADER]: `v1=${signature}`,
  })
}

function rejected(reason: ProviderCallbackRejection): ProviderCallbackVerification {
  return Object.freeze({ outcome: 'rejected' as const, reason })
}

/**
 * Verify a raw inbound callback against the job it claims to be about.
 *
 * Order matters and is deliberate: cheap structural checks first, then the
 * constant-time signature, then the semantic bindings. A caller must not be
 * able to learn whether a job exists by timing the signature check, so the job
 * bindings are only consulted after the signature proves the sender holds the
 * shared secret for this provider.
 */
export function verifyProviderCallback(input: {
  secret: Uint8Array
  rawBody: Uint8Array
  headers: Readonly<Record<string, string | undefined>>
  job: Readonly<{
    id: string
    workspaceId: string
    providerId: string
    providerJobId?: string
    terminal: boolean
  }>
  now: Date
  toleranceSeconds?: number
}): ProviderCallbackVerification {
  const tolerance = input.toleranceSeconds ?? 300
  assertDomain(Number.isSafeInteger(tolerance) && tolerance >= 30 && tolerance <= 900, 'INVALID_ARGUMENT', 'Callback tolerance is invalid')

  if (input.rawBody.byteLength > MAXIMUM_BODY_BYTES) return rejected('body-too-large')

  const eventId = input.headers[PROVIDER_CALLBACK_EVENT_HEADER]
  if (typeof eventId !== 'string' || !ID.test(eventId)) return rejected('event-id-malformed')

  const timestamp = input.headers[PROVIDER_CALLBACK_TIMESTAMP_HEADER]
  if (typeof timestamp !== 'string' || !/^\d{1,12}$/.test(timestamp)) return rejected('timestamp-malformed')
  const epochSeconds = Number(timestamp)
  const nowSeconds = Math.floor(input.now.getTime() / 1_000)
  if (!Number.isSafeInteger(epochSeconds) || !Number.isSafeInteger(nowSeconds)) return rejected('timestamp-malformed')
  if (Math.abs(nowSeconds - epochSeconds) > tolerance) return rejected('timestamp-outside-window')

  const supplied = SIGNATURE.exec(input.headers[PROVIDER_CALLBACK_SIGNATURE_HEADER] ?? '')
  if (!supplied) return rejected('signature-invalid')
  const expected = createHmac('sha256', Buffer.from(input.secret))
    .update(signaturePayload(timestamp, eventId, input.rawBody))
    .digest()
  const received = Buffer.from(supplied[1], 'hex')
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return rejected('signature-invalid')

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(input.rawBody).toString('utf8'))
  } catch {
    return rejected('body-malformed')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return rejected('body-malformed')
  const body = parsed as Record<string, unknown>

  if (typeof body.providerJobId !== 'string' || !ID.test(body.providerJobId)) return rejected('body-malformed')
  if (typeof body.occurredAt !== 'string' || Number.isNaN(Date.parse(body.occurredAt))) return rejected('body-malformed')
  if (typeof body.status !== 'string' || !PROVIDER_STATUS_VALUES.includes(body.status as ProviderStatus)) return rejected('status-unsupported')
  let retryAfterMs: number | null = null
  if (body.retryAfterMs !== undefined) {
    if (!Number.isSafeInteger(body.retryAfterMs) || (body.retryAfterMs as number) < 0 || (body.retryAfterMs as number) > MAXIMUM_RETRY_AFTER_MS) {
      return rejected('body-malformed')
    }
    retryAfterMs = body.retryAfterMs as number
  }

  // Workspace and provider come from the routed job, not from the payload: a
  // signed body must never be able to name the tenant it lands in.
  if (typeof body.workspaceId === 'string' && body.workspaceId !== input.job.workspaceId) return rejected('workspace-mismatch')
  if (typeof body.providerId === 'string' && body.providerId !== input.job.providerId) return rejected('provider-mismatch')
  if (input.job.providerJobId !== undefined && body.providerJobId !== input.job.providerJobId) return rejected('correlation-mismatch')
  if (input.job.terminal) return rejected('job-terminal')

  const receivedAt = new Date(input.now.getTime()).toISOString()
  const payloadSha256 = calculateCanonicalHash({ bytes: Buffer.from(input.rawBody).toString('base64') })
  const eventBody = Object.freeze({
    schemaVersion: PROVIDER_CALLBACK_EVENT_SCHEMA_VERSION,
    workspaceId: input.job.workspaceId,
    providerId: input.job.providerId,
    eventId,
    jobId: input.job.id,
    providerJobId: body.providerJobId,
    status: body.status as ProviderStatus,
    occurredAt: new Date(Date.parse(body.occurredAt)).toISOString(),
    retryAfterMs,
    payloadSha256,
    receivedAt,
  })
  return Object.freeze({
    outcome: 'accepted' as const,
    event: Object.freeze({ ...eventBody, eventHash: calculateCanonicalHash(eventBody) }),
  })
}

export function assertProviderCallbackEvent(event: Readonly<ProviderCallbackEvent>): Readonly<ProviderCallbackEvent> {
  assertDomain(event.schemaVersion === PROVIDER_CALLBACK_EVENT_SCHEMA_VERSION, 'PERSISTENCE_CONFLICT', 'Stored callback event schema is invalid')
  const { eventHash, ...body } = event
  assertDomain(calculateCanonicalHash(body) === eventHash, 'PERSISTENCE_CONFLICT', 'Stored callback event hash does not match its body')
  return event
}

/**
 * Decide what a second arrival of the same event id means.
 *
 * Same bytes → a duplicate delivery, which providers do routinely; it is
 * acknowledged and must not ingest anything twice. Different bytes under the
 * same event id → the id is being reused to say something new, which is a
 * replay attempt and is rejected.
 */
export function classifyProviderCallbackReplay(input: {
  stored: Readonly<ProviderCallbackEvent>
  incoming: Readonly<ProviderCallbackEvent>
}): Readonly<{ outcome: Extract<ProviderCallbackOutcome, 'duplicate' | 'rejected'>; reason?: ProviderCallbackRejection }> {
  assertProviderCallbackEvent(input.stored)
  if (input.stored.payloadSha256 === input.incoming.payloadSha256 && input.stored.jobId === input.incoming.jobId) {
    return Object.freeze({ outcome: 'duplicate' as const })
  }
  return Object.freeze({ outcome: 'rejected' as const, reason: 'correlation-mismatch' as const })
}
