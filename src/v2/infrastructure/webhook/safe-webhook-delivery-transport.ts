import { createHash } from 'node:crypto'

import type {
  WebhookDeliveryTransport,
  WebhookDeliveryTransportRequest,
} from '../../application/ports/webhook-delivery-dispatch.ts'
import { DomainError } from '../../domain/errors.ts'
import { validateWebhookResolution } from '../../domain/webhook-network.ts'
import { normalizeWebhookUrl } from '../../domain/webhook.ts'
import {
  NodePinnedWebhookClient,
  NodeWebhookDnsResolver,
  type PinnedWebhookClient,
  type PinnedWebhookResponse,
  type WebhookDnsResolver,
} from './safe-webhook-challenge-transport.ts'

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_TIMEOUT_MS = 15_000
const MAX_REQUEST_BYTES = 256 * 1024
const MAX_RESPONSE_BYTES = 64 * 1024

function transportFailure(message: string): never {
  throw new DomainError('WEBHOOK_DELIVERY_TRANSPORT_FAILED', message)
}

async function withinDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('webhook-delivery-deadline')), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(deadline)
        resolve(value)
      },
      (error) => {
        clearTimeout(deadline)
        reject(error)
      },
    )
  })
}

function validateResponse(response: Readonly<PinnedWebhookResponse>) {
  if (
    !Number.isInteger(response.statusCode) ||
    response.statusCode < 100 ||
    response.statusCode > 599 ||
    !Buffer.isBuffer(response.body) ||
    response.body.length > MAX_RESPONSE_BYTES
  ) {
    transportFailure('Webhook delivery endpoint returned an invalid response')
  }
  return Object.freeze({
    statusCode: response.statusCode,
    responseBodyHash: createHash('sha256').update(response.body).digest('hex'),
  })
}

export class SafeWebhookDeliveryTransport implements WebhookDeliveryTransport {
  private readonly resolver: WebhookDnsResolver
  private readonly client: PinnedWebhookClient
  private readonly timeoutMs: number

  constructor(options: {
    resolver?: WebhookDnsResolver
    client?: PinnedWebhookClient
    timeoutMs?: number
  } = {}) {
    this.resolver = options.resolver ?? new NodeWebhookDnsResolver()
    this.client = options.client ?? new NodePinnedWebhookClient()
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1_000 ||
      this.timeoutMs > MAX_TIMEOUT_MS
    ) {
      transportFailure('Webhook delivery timeout must be between 1000 and 15000 milliseconds')
    }
  }

  async send(request: Readonly<WebhookDeliveryTransportRequest>) {
    const url = new URL(normalizeWebhookUrl(request.url))
    const body = Buffer.from(request.rawBody)
    if (
      request.headers['apollo-webhook-id'] !== request.eventId ||
      !/^\d{1,12}$/.test(request.headers['apollo-webhook-timestamp']) ||
      !/^v1=[0-9a-f]{64}$/.test(request.headers['apollo-webhook-signature'])
    ) {
      transportFailure('Webhook delivery signed headers are invalid')
    }
    if (body.length > MAX_REQUEST_BYTES) {
      transportFailure('Webhook delivery request exceeds 256 KiB')
    }
    const startedAt = performance.now()
    let addresses
    try {
      addresses = validateWebhookResolution(
        await withinDeadline(this.resolver.resolve(url.hostname), this.timeoutMs),
      )
    } catch (error) {
      if (error instanceof DomainError) throw error
      transportFailure('Webhook delivery DNS resolution failed')
    }
    const remainingMs = Math.floor(this.timeoutMs - (performance.now() - startedAt))
    if (remainingMs <= 0) {
      transportFailure('Webhook delivery deadline expired before HTTPS connection')
    }
    try {
      const response = await withinDeadline(
        this.client.post({
          url,
          address: addresses[0],
          body,
          headers: request.headers,
          userAgent: 'Apollo-Video-Webhook/1.0',
          timeoutMs: remainingMs,
          maxResponseBytes: MAX_RESPONSE_BYTES,
        }),
        remainingMs,
      )
      return validateResponse(response)
    } catch (error) {
      if (error instanceof DomainError) throw error
      transportFailure('Webhook delivery HTTPS request failed')
    }
  }
}
