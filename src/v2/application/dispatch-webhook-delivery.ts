import { createHash } from 'node:crypto'

import type {
  WebhookDeliveryDispatchTargetRepository,
  WebhookDeliveryTransport,
  WebhookSigningSecretProvider,
} from './ports/webhook-delivery-dispatch.ts'
import type { WebhookDeliveryRepository } from './ports/webhook-delivery-repository.ts'
import { settleWebhookDeliveryService } from './manage-webhook-delivery.ts'
import { DomainError, assertDomain } from '../domain/errors.ts'
import { hashWebhookDeliveryLeaseToken } from '../domain/webhook-delivery-lease.ts'
import { signWebhookPayload } from '../domain/webhook-security.ts'

const DEFAULT_RETRY_BASE_MS = 5_000
const DEFAULT_RETRY_MAX_MS = 15 * 60 * 1_000

export function calculateWebhookRetryAt(input: {
  deliveryId: string
  attemptNumber: number
  now: Date
  baseDelayMs?: number
  maxDelayMs?: number
}): string {
  const base = input.baseDelayMs ?? DEFAULT_RETRY_BASE_MS
  const maximum = input.maxDelayMs ?? DEFAULT_RETRY_MAX_MS
  assertDomain(
    Number.isSafeInteger(base) && base >= 1_000 &&
      Number.isSafeInteger(maximum) && maximum >= base && maximum <= 24 * 60 * 60 * 1_000,
    'INVALID_WEBHOOK',
    'Webhook retry policy is invalid',
  )
  assertDomain(
    Number.isSafeInteger(input.attemptNumber) && input.attemptNumber >= 1 && input.attemptNumber <= 20,
    'INVALID_WEBHOOK',
    'Webhook retry attempt is invalid',
  )
  assertDomain(!Number.isNaN(input.now.getTime()), 'INVALID_WEBHOOK', 'Webhook retry clock is invalid')
  const exponential = Math.min(maximum, base * 2 ** (input.attemptNumber - 1))
  const digest = createHash('sha256')
    .update(`${input.deliveryId}:${input.attemptNumber}`, 'utf8')
    .digest()
  const factor = 0.75 + (digest.readUInt16BE(0) / 65_535) * 0.5
  const delay = Math.max(1_000, Math.min(maximum, Math.round(exponential * factor)))
  return new Date(input.now.getTime() + delay).toISOString()
}

export function classifyWebhookResponse(statusCode: number): Readonly<{
  succeeded: boolean
  retryable: boolean
  errorCode?: string
}> {
  assertDomain(
    Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599,
    'WEBHOOK_DELIVERY_TRANSPORT_FAILED',
    'Webhook delivery response status is invalid',
  )
  if (statusCode >= 200 && statusCode <= 299) {
    return Object.freeze({ succeeded: true, retryable: false })
  }
  const retryable = statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500
  return Object.freeze({
    succeeded: false,
    retryable,
    errorCode: `http_${statusCode}`,
  })
}

export function dispatchWebhookDeliveryService(dependencies: {
  repository: WebhookDeliveryRepository & WebhookDeliveryDispatchTargetRepository
  secrets: WebhookSigningSecretProvider
  transport: WebhookDeliveryTransport
  clock: () => Date
  retryBaseDelayMs?: number
  retryMaxDelayMs?: number
}) {
  const settle = settleWebhookDeliveryService({
    repository: dependencies.repository,
    clock: dependencies.clock,
  })

  return async function dispatchWebhookDelivery(request: {
    workspaceId: string
    deliveryId: string
    leaseOwner: string
    leaseToken: string
    attemptNumber: number
  }) {
    const startedAt = dependencies.clock()
    const fence = {
      workspaceId: request.workspaceId,
      deliveryId: request.deliveryId,
      leaseOwner: request.leaseOwner,
      leaseTokenHash: hashWebhookDeliveryLeaseToken(request.leaseToken),
      attemptNumber: request.attemptNumber,
      now: startedAt.toISOString(),
    }
    let resolvedTarget
    try {
      resolvedTarget = await dependencies.repository.getDispatchTarget(fence)
    } catch (error) {
      if (error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT') {
        return settleFailure('dispatch_target_invalid', false)
      }
      throw error
    }
    if (!resolvedTarget) return Object.freeze({ status: 'stale' as const })
    if (resolvedTarget.status === 'blocked') {
      return settleFailure(resolvedTarget.errorCode, false)
    }
    const target = resolvedTarget.target

    let secret: Buffer | undefined
    try {
      let opened: Uint8Array
      try {
        opened = await dependencies.secrets.open({
          workspaceId: target.workspaceId,
          endpointId: target.endpointId,
          keyRef: target.secretKeyRef,
          version: target.secretVersion,
        })
      } catch {
        return settleFailure('secret_unavailable', true)
      }
      try {
        secret = Buffer.from(opened)
      } finally {
        opened.fill(0)
      }
      const fingerprint = createHash('sha256').update(secret).digest('hex')
      if (fingerprint !== target.secretFingerprint) {
        return settleFailure('signing_key_mismatch', false)
      }

      const headers = signWebhookPayload({
        secret,
        eventId: target.eventId,
        rawBody: target.rawBody,
        timestamp: startedAt,
      })
      let response
      try {
        response = await dependencies.transport.send({
          url: target.url,
          eventId: target.eventId,
          rawBody: target.rawBody,
          headers,
        })
      } catch (error) {
        if (
          error instanceof DomainError &&
          !['WEBHOOK_DELIVERY_TRANSPORT_FAILED', 'WEBHOOK_NETWORK_REJECTED'].includes(error.code)
        ) {
          throw error
        }
        return settleFailure('network_error', true)
      }
      const classification = classifyWebhookResponse(response.statusCode)
      if (classification.succeeded) {
        const settled = await settle({
          ...request,
          outcome: {
            status: 'succeeded',
            responseStatus: response.statusCode,
            responseBodyHash: response.responseBodyHash,
          },
        })
        return settled
          ? Object.freeze({ status: 'succeeded' as const, delivery: settled.delivery })
          : Object.freeze({ status: 'stale' as const })
      }
      return settleFailure(
        classification.errorCode!,
        classification.retryable,
        response.statusCode,
        response.responseBodyHash,
      )
    } finally {
      secret?.fill(0)
    }

    async function settleFailure(
      errorCode: string,
      retryable: boolean,
      responseStatus?: number,
      responseBodyHash?: string,
    ) {
      const now = dependencies.clock()
      const settled = await settle({
        ...request,
        outcome: {
          status: 'failed',
          errorCode,
          ...(responseStatus !== undefined ? { responseStatus } : {}),
          ...(responseBodyHash ? { responseBodyHash } : {}),
          ...(retryable
            ? {
                nextAttemptAt: calculateWebhookRetryAt({
                  deliveryId: request.deliveryId,
                  attemptNumber: request.attemptNumber,
                  now,
                  ...(dependencies.retryBaseDelayMs
                    ? { baseDelayMs: dependencies.retryBaseDelayMs }
                    : {}),
                  ...(dependencies.retryMaxDelayMs
                    ? { maxDelayMs: dependencies.retryMaxDelayMs }
                    : {}),
                }),
              }
            : {}),
        },
      })
      if (!settled) return Object.freeze({ status: 'stale' as const })
      if (
        settled.delivery.status !== 'retry-scheduled' &&
        settled.delivery.status !== 'dead-lettered'
      ) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Webhook failure settlement returned an invalid delivery state',
        )
      }
      return Object.freeze({ status: settled.delivery.status, delivery: settled.delivery })
    }
  }
}
