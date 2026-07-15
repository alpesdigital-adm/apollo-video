import { lookup } from 'node:dns/promises'
import { request as httpsRequest, type RequestOptions } from 'node:https'

import type {
  WebhookChallengeTransport,
  WebhookChallengeTransportRequest,
} from '../../application/ports/webhook-challenge-transport.ts'
import { DomainError } from '../../domain/errors.ts'
import { hashWebhookChallengeToken } from '../../domain/webhook-security.ts'
import type { SignedWebhookHeaders } from '../../domain/webhook-security.ts'
import {
  validateWebhookResolution,
  type WebhookResolvedAddress,
} from '../../domain/webhook-network.ts'
import { normalizeWebhookUrl } from '../../domain/webhook.ts'

const DEFAULT_TIMEOUT_MS = 5_000
const MAX_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 1_024

export interface WebhookDnsResolver {
  resolve(hostname: string): Promise<readonly WebhookResolvedAddress[]>
}

export interface PinnedWebhookRequest {
  url: URL
  address: Readonly<WebhookResolvedAddress>
  body: Buffer
  timeoutMs: number
  maxResponseBytes: number
  headers?: Readonly<SignedWebhookHeaders>
  userAgent?: string
}

export interface PinnedWebhookResponse {
  statusCode: number
  contentType?: string
  body: Buffer
}

export interface PinnedWebhookClient {
  post(request: Readonly<PinnedWebhookRequest>): Promise<Readonly<PinnedWebhookResponse>>
}

export function createPinnedWebhookRequestOptions(
  input: Readonly<PinnedWebhookRequest>,
): RequestOptions {
  return {
    protocol: 'https:',
    hostname: input.url.hostname,
    port: 443,
    family: input.address.family,
    method: 'POST',
    path: input.url.pathname,
    agent: false,
    servername: input.url.hostname,
    minVersion: 'TLSv1.2',
    rejectUnauthorized: true,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json; charset=utf-8',
      'content-length': input.body.length,
      'user-agent': input.userAgent ?? 'Apollo-Video-Webhook-Challenge/1.0',
      ...(input.headers ?? {}),
    },
    lookup: (_hostname, _options, callback) => {
      callback(null, input.address.address, input.address.family)
    },
  }
}

export class NodeWebhookDnsResolver implements WebhookDnsResolver {
  async resolve(hostname: string): Promise<readonly WebhookResolvedAddress[]> {
    const records = await lookup(hostname, { all: true, verbatim: true })
    return records.map(({ address, family }) => {
      if (family !== 4 && family !== 6) {
        throw new DomainError(
          'WEBHOOK_NETWORK_REJECTED',
          'Webhook DNS resolution returned an unsupported address family',
        )
      }
      return { address, family }
    })
  }
}

export class NodePinnedWebhookClient implements PinnedWebhookClient {
  async post(input: Readonly<PinnedWebhookRequest>): Promise<Readonly<PinnedWebhookResponse>> {
    return new Promise((resolve, reject) => {
      const options = createPinnedWebhookRequestOptions(input)
      let settled = false
      let deadline: NodeJS.Timeout | undefined
      const finish = <T>(handler: (value: T) => void, value: T) => {
        if (settled) return
        settled = true
        if (deadline) clearTimeout(deadline)
        handler(value)
      }
      const request = httpsRequest(options, (response) => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          size += bytes.length
          if (size > input.maxResponseBytes) {
            response.destroy(new Error('webhook-response-too-large'))
            return
          }
          chunks.push(bytes)
        })
        response.on('end', () => {
          const contentType = response.headers['content-type']
          finish(resolve, Object.freeze({
            statusCode: response.statusCode ?? 0,
            ...(typeof contentType === 'string' ? { contentType } : {}),
            body: Buffer.concat(chunks),
          }))
        })
        response.on('error', (error) => finish(reject, error))
      })
      request.setTimeout(input.timeoutMs, () => {
        request.destroy(new Error('webhook-request-timeout'))
      })
      deadline = setTimeout(() => {
        request.destroy(new Error('webhook-request-deadline'))
      }, input.timeoutMs)
      deadline.unref()
      request.on('error', (error) => finish(reject, error))
      request.end(input.body)
    })
  }
}

async function withinDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('webhook-operation-deadline')), timeoutMs)
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

function transportFailure(message: string): never {
  throw new DomainError('WEBHOOK_CHALLENGE_TRANSPORT_FAILED', message)
}

function createRequestBody(request: Readonly<WebhookChallengeTransportRequest>): Buffer {
  hashWebhookChallengeToken(request.token)
  const expiresAt = new Date(request.expiresAt)
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.toISOString() !== request.expiresAt) {
    transportFailure('Webhook challenge expiry is invalid')
  }
  const body = Buffer.from(JSON.stringify({
    type: 'apollo.webhook.challenge',
    challengeId: request.challengeId,
    token: request.token,
    expiresAt: request.expiresAt,
  }), 'utf8')
  if (body.length > MAX_RESPONSE_BYTES) {
    transportFailure('Webhook challenge request is too large')
  }
  return body
}

function parseResponse(
  response: Readonly<PinnedWebhookResponse>,
  challengeId: string,
): string {
  if (response.statusCode !== 200) {
    transportFailure('Webhook challenge endpoint returned a non-success status')
  }
  if (!Buffer.isBuffer(response.body)) {
    transportFailure('Webhook challenge endpoint returned a non-binary body')
  }
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.contentType ?? '')) {
    transportFailure('Webhook challenge endpoint returned an unsupported content type')
  }
  if (response.body.length < 2 || response.body.length > MAX_RESPONSE_BYTES) {
    transportFailure('Webhook challenge endpoint returned an invalid body size')
  }
  let payload: unknown
  try {
    payload = JSON.parse(response.body.toString('utf8'))
  } catch {
    transportFailure('Webhook challenge endpoint returned invalid JSON')
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload) ||
    Object.keys(payload).sort().join(',') !== 'challengeId,token' ||
    !('challengeId' in payload) ||
    payload.challengeId !== challengeId ||
    !('token' in payload) ||
    typeof payload.token !== 'string'
  ) {
    transportFailure('Webhook challenge endpoint returned an invalid proof')
  }
  const canonicalBody = Buffer.from(JSON.stringify({
    challengeId,
    token: payload.token,
  }), 'utf8')
  if (!response.body.equals(canonicalBody)) {
    transportFailure('Webhook challenge endpoint returned an ambiguous proof')
  }
  return payload.token
}

export class SafeWebhookChallengeTransport implements WebhookChallengeTransport {
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
      throw new DomainError(
        'WEBHOOK_CHALLENGE_TRANSPORT_FAILED',
        'Webhook challenge timeout must be between 1000 and 10000 milliseconds',
      )
    }
  }

  async send(request: Readonly<WebhookChallengeTransportRequest>) {
    const url = new URL(normalizeWebhookUrl(request.url))
    const startedAt = performance.now()
    let records: readonly WebhookResolvedAddress[]
    try {
      records = await withinDeadline(this.resolver.resolve(url.hostname), this.timeoutMs)
    } catch (error) {
      if (error instanceof DomainError) throw error
      transportFailure('Webhook DNS resolution failed')
    }
    const addresses = validateWebhookResolution(records)
    const body = createRequestBody(request)
    const remainingMs = Math.floor(this.timeoutMs - (performance.now() - startedAt))
    if (remainingMs <= 0) {
      transportFailure('Webhook challenge deadline expired before HTTPS connection')
    }
    let response: Readonly<PinnedWebhookResponse>
    try {
      response = await withinDeadline(
        this.client.post({
          url,
          address: addresses[0],
          body,
          timeoutMs: remainingMs,
          maxResponseBytes: MAX_RESPONSE_BYTES,
        }),
        remainingMs,
      )
    } catch {
      transportFailure('Webhook challenge HTTPS request failed')
    }
    return Object.freeze({ echoedToken: parseResponse(response, request.challengeId) })
  }
}
