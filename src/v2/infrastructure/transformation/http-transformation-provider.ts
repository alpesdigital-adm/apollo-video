import { createHash } from 'node:crypto'

import type {
  AsyncMediaProviderAdapter,
  ProviderCapabilities,
  ProviderSubmitContext,
  ProviderWebhookEvent,
} from '../../application/ports/async-media-provider.ts'
import { calculateCanonicalHash } from '../../domain/canonical-hash.ts'
import { assertDomain } from '../../domain/errors.ts'
import {
  ProviderAdapterError,
  PROVIDER_STATUS_VALUES,
  type ProviderCompletionMode,
  type ProviderEstimate,
  type ProviderStatus,
  type ProviderSubmissionResult,
} from '../../domain/provider-contract.ts'
import {
  PROVIDER_CALLBACK_EVENT_HEADER,
  PROVIDER_CALLBACK_SIGNATURE_HEADER,
  PROVIDER_CALLBACK_TIMESTAMP_HEADER,
  verifyProviderCallback,
} from '../../domain/provider-job-callback.ts'

/**
 * HTTP transport for generative transformation providers.
 *
 * One adapter covers three of the four transports because the difference
 * between them is the provider's declared completion mode, not the wire:
 *
 * - `synchronous` → the `api` transport; the submission response carries the
 *   finished result.
 * - `polling` → Apollo asks for status until the provider finishes.
 * - `webhook` / `both` → the provider notifies Apollo; `verifyWebhook` proves
 *   the notification is genuine before anything moves.
 *
 * The result comes back as **bytes**, never as a URL for Apollo to fetch. That
 * is deliberate. `SafeProviderResultDownloader` exists to follow URLs that
 * arrive inside a provider response — untrusted input, and therefore the
 * classic SSRF surface it guards with https, port 443 and a public-address
 * check. An adapter reading from its own operator-configured base URL is a
 * different trust model, which is why the ElevenLabs adapter has worked this
 * way since Wave 13. Nothing here relaxes that defence; this path simply never
 * needs it.
 *
 * Plain `http:` is accepted only for loopback, matching the same precedent:
 * a controlled server on 127.0.0.1 is how these adapters are exercised without
 * paid calls, and no non-loopback host may be reached without TLS.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RESULT_BYTES = 256 * 1024 * 1024
const MAXIMUM_RETRY_AFTER_MS = 60 * 60 * 1_000

export interface HttpTransformationResult {
  providerJobId: string
  mediaBytes: Uint8Array
  mediaSha256: string
  mediaByteSize: number
  container: 'mp4'
  mediaType: 'video'
  observedCost?: Readonly<{ currency: string; costMinorUnits: number }>
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after')
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isSafeInteger(seconds) && seconds >= 0) return Math.min(seconds * 1_000, MAXIMUM_RETRY_AFTER_MS)
  const at = Date.parse(header)
  if (!Number.isFinite(at)) return undefined
  return Math.min(Math.max(at - Date.now(), 0), MAXIMUM_RETRY_AFTER_MS)
}

/**
 * Turn any transport failure into a normalized, redacted adapter error.
 * Upstream bodies never travel: they routinely echo the request, which for a
 * transformation means the prompt, and sometimes a signed URL.
 */
function adapterError(response: Response): ProviderAdapterError {
  if (response.status === 429) {
    return new ProviderAdapterError('PROVIDER_RATE_LIMITED', true, retryAfterMs(response) ?? 1_000, 'Provider rate limited the request')
  }
  if (response.status === 408 || response.status === 425 || response.status >= 500) {
    return new ProviderAdapterError('PROVIDER_UNAVAILABLE', true, retryAfterMs(response), 'Provider is temporarily unavailable')
  }
  if (response.status === 401 || response.status === 403) {
    return new ProviderAdapterError('PROVIDER_UNAUTHORIZED', false, undefined, 'Provider rejected the credential')
  }
  if (response.status === 404) {
    return new ProviderAdapterError('PROVIDER_JOB_NOT_FOUND', false, undefined, 'Provider does not know this job')
  }
  return new ProviderAdapterError('PROVIDER_REJECTED_REQUEST', false, undefined, 'Provider rejected the request')
}

export interface HttpTransformationProviderConfig {
  id: string
  adapterVersion: string
  baseUrl: string
  apiKey: string
  completion: ProviderCompletionMode
  modes: readonly string[]
  callbackSecret?: Uint8Array
  modelRef?: string
  timeoutMs?: number
  maxResultBytes?: number
  supportsCancellation?: boolean
  priceFixedMinorUnits?: number
  pricePerSecondMinorUnits?: number
  currency?: string
  fetchImplementation?: FetchLike
}

export class HttpTransformationProviderAdapter
implements AsyncMediaProviderAdapter<Readonly<Record<string, unknown>>, HttpTransformationResult> {
  readonly id: string
  readonly adapterVersion: string
  readonly modelRef?: string
  readonly configHash: string

  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly completion: ProviderCompletionMode
  private readonly modes: readonly string[]
  private readonly callbackSecret?: Uint8Array
  private readonly timeoutMs: number
  private readonly maxResultBytes: number
  private readonly cancellable: boolean
  private readonly priceFixedMinorUnits: number
  private readonly pricePerSecondMinorUnits: number
  private readonly currency: string
  private readonly fetchImplementation: FetchLike

  constructor(config: HttpTransformationProviderConfig) {
    const baseUrl = new URL(config.baseUrl)
    const loopback = LOOPBACK_HOSTS.has(baseUrl.hostname)
    assertDomain(
      (baseUrl.protocol === 'https:' || (baseUrl.protocol === 'http:' && loopback)) &&
        !baseUrl.username && !baseUrl.password && !baseUrl.search && !baseUrl.hash,
      'PERSISTENCE_NOT_CONFIGURED',
      'Transformation provider base URL is invalid',
    )
    assertDomain(config.apiKey.trim().length >= 8, 'PERSISTENCE_NOT_CONFIGURED', 'Transformation provider credential is invalid')
    assertDomain(config.modes.length > 0, 'PERSISTENCE_NOT_CONFIGURED', 'Transformation provider declares no modes')
    if (config.completion === 'webhook' || config.completion === 'both') {
      assertDomain(
        Boolean(config.callbackSecret && config.callbackSecret.byteLength >= 32),
        'PERSISTENCE_NOT_CONFIGURED',
        'A webhook-completing provider needs an inbound callback secret',
      )
    }
    this.id = config.id
    this.adapterVersion = config.adapterVersion
    this.modelRef = config.modelRef
    this.baseUrl = baseUrl.toString().replace(/\/$/, '')
    this.apiKey = config.apiKey.trim()
    this.completion = config.completion
    this.modes = Object.freeze([...config.modes])
    this.callbackSecret = config.callbackSecret
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxResultBytes = config.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES
    this.cancellable = config.supportsCancellation ?? true
    this.priceFixedMinorUnits = config.priceFixedMinorUnits ?? 0
    this.pricePerSecondMinorUnits = config.pricePerSecondMinorUnits ?? 100
    this.currency = config.currency ?? 'USD'
    this.fetchImplementation = config.fetchImplementation ?? ((url, init) => fetch(url, init))
    assertDomain(
      Number.isSafeInteger(this.timeoutMs) && this.timeoutMs >= 1_000 && this.timeoutMs <= 600_000,
      'PERSISTENCE_NOT_CONFIGURED',
      'Transformation provider timeout is invalid',
    )
    // The credential is never part of the config hash: the hash is written into
    // every artifact manifest, and a manifest is not a place for a secret.
    this.configHash = calculateCanonicalHash({
      schemaVersion: 'http-transformation-provider-config/v1',
      id: this.id,
      adapterVersion: this.adapterVersion,
      baseUrl: this.baseUrl,
      completion: this.completion,
      modes: this.modes,
      modelRef: this.modelRef ?? null,
      timeoutMs: this.timeoutMs,
      maxResultBytes: this.maxResultBytes,
      supportsCancellation: this.cancellable,
      price: { currency: this.currency, fixedMinorUnits: this.priceFixedMinorUnits, perSecondMinorUnits: this.pricePerSecondMinorUnits },
    })
  }

  private async call(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('provider-timeout')), this.timeoutMs)
    const abort = () => controller.abort(new Error('caller-aborted'))
    signal?.addEventListener('abort', abort, { once: true })
    try {
      return await this.fetchImplementation(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { ...(init.headers ?? {}), 'x-api-key': this.apiKey, 'content-type': 'application/json' },
      })
    } catch (error) {
      if (signal?.aborted) throw error
      // A timeout is retryable: the provider may simply be slow, and the
      // durable job carries the deadline that decides when to stop trying.
      throw new ProviderAdapterError('PROVIDER_TIMEOUT', true, undefined, 'Provider did not answer in time')
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    }
  }

  async getCapabilities(signal?: AbortSignal): Promise<Readonly<ProviderCapabilities>> {
    const response = await this.call('/capabilities', { method: 'GET' }, signal)
    if (!response.ok) throw adapterError(response)
    const payload = (await response.json()) as Record<string, unknown>
    const now = Date.now()
    return Object.freeze({
      operations: Object.freeze(['video-to-video', 'background-replace', 'camera-motion'] as const),
      inputFormats: Object.freeze(['mp4']),
      outputFormats: Object.freeze(['mp4']),
      duration: Object.freeze({
        minSeconds: typeof payload.minSeconds === 'number' ? payload.minSeconds : 1,
        maxSeconds: typeof payload.maxSeconds === 'number' ? payload.maxSeconds : 60,
      }),
      identityReference: 'video',
      supportsSeed: true,
      supportsIdempotency: true,
      supportsCancellation: this.cancellable,
      completion: this.completion,
      fetchedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 10 * 60_000).toISOString(),
    })
  }

  async estimate(input: Readonly<Record<string, unknown>>): Promise<Readonly<ProviderEstimate>> {
    const durationFrames = typeof input.durationFrames === 'number' ? input.durationFrames : 0
    const fps = typeof input.fps === 'number' && input.fps > 0 ? input.fps : 30
    const seconds = Math.max(1, Math.ceil(durationFrames / fps))
    return Object.freeze({
      currency: this.currency,
      costMinorUnits: this.priceFixedMinorUnits + this.pricePerSecondMinorUnits * seconds,
      estimatedLatencyMs: seconds * 2_000,
    })
  }

  async submit(
    input: Readonly<Record<string, unknown>>,
    context: Readonly<ProviderSubmitContext>,
  ): Promise<Readonly<ProviderSubmissionResult<HttpTransformationResult>>> {
    const response = await this.call('/transformations', {
      method: 'POST',
      // The provider's own idempotency key, when it honours one. Apollo's
      // replay protection is independent and always applies.
      headers: { 'idempotency-key': context.idempotencyKey },
      body: JSON.stringify({ input, operationId: context.operationId }),
    }, context.signal)
    if (!response.ok) throw adapterError(response)
    const payload = (await response.json()) as Record<string, unknown>
    if (typeof payload.providerJobId !== 'string' || payload.providerJobId.length === 0) {
      throw new ProviderAdapterError('PROVIDER_MALFORMED_RESPONSE', false, undefined, 'Provider did not return a job identifier')
    }
    if (this.completion !== 'synchronous') {
      return Object.freeze({ kind: 'accepted' as const, providerJobId: payload.providerJobId })
    }
    const result = await this.readResult(payload.providerJobId, payload)
    return Object.freeze({
      kind: 'completed' as const,
      bundle: Object.freeze({
        providerJobRef: result.providerJobId,
        result,
        completedAt: typeof payload.completedAt === 'string' ? new Date(payload.completedAt).toISOString() : new Date().toISOString(),
        ...(result.observedCost ? { observedCost: result.observedCost } : {}),
      }),
    })
  }

  async getStatus(providerJobId: string, signal?: AbortSignal): Promise<ProviderStatus> {
    const response = await this.call(`/transformations/${encodeURIComponent(providerJobId)}`, { method: 'GET' }, signal)
    if (!response.ok) throw adapterError(response)
    const payload = (await response.json()) as Record<string, unknown>
    if (typeof payload.status !== 'string' || !PROVIDER_STATUS_VALUES.includes(payload.status as ProviderStatus)) {
      throw new ProviderAdapterError('PROVIDER_MALFORMED_RESPONSE', false, undefined, 'Provider returned an unsupported status')
    }
    return payload.status as ProviderStatus
  }

  async retrieve(providerJobId: string, signal?: AbortSignal): Promise<Readonly<HttpTransformationResult>> {
    const response = await this.call(`/transformations/${encodeURIComponent(providerJobId)}/result`, { method: 'GET' }, signal)
    if (!response.ok) throw adapterError(response)
    return this.readResult(providerJobId, (await response.json()) as Record<string, unknown>)
  }

  async cancel(providerJobId: string, signal?: AbortSignal): Promise<void> {
    if (!this.cancellable) {
      // Declaring a capability the provider does not have would let Apollo
      // report a job cancelled that is still running and still billing.
      throw new ProviderAdapterError('PROVIDER_CANCELLATION_UNSUPPORTED', false, undefined, 'Provider does not support cancellation')
    }
    const response = await this.call(`/transformations/${encodeURIComponent(providerJobId)}/cancel`, { method: 'POST', body: '{}' }, signal)
    if (!response.ok) throw adapterError(response)
  }

  async verifyWebhook(request: unknown): Promise<Readonly<ProviderWebhookEvent>> {
    assertDomain(Boolean(this.callbackSecret), 'PRECONDITION_REQUIRED', 'This provider was not configured for webhook completion')
    const envelope = request as { rawBody?: Uint8Array; headers?: Record<string, string | undefined>; job?: Parameters<typeof verifyProviderCallback>[0]['job'] }
    assertDomain(
      Boolean(envelope?.rawBody && envelope.headers && envelope.job),
      'INVALID_ARGUMENT',
      'Webhook verification needs the exact bytes, the headers and the job it claims to be about',
    )
    const verification = verifyProviderCallback({
      secret: this.callbackSecret!,
      rawBody: envelope.rawBody!,
      headers: envelope.headers!,
      job: envelope.job!,
      now: new Date(),
    })
    if (verification.outcome === 'rejected') {
      throw new ProviderAdapterError(`PROVIDER_CALLBACK_${verification.reason.toUpperCase().replace(/-/g, '_')}`, false, undefined, 'Provider callback failed verification')
    }
    return Object.freeze({
      eventId: verification.event.eventId,
      providerJobId: verification.event.providerJobId,
      status: verification.event.status,
      occurredAt: verification.event.occurredAt,
    })
  }

  /** Headers a controlled provider must send. Exposed for tests and stubs. */
  static callbackHeaderNames(): Readonly<Record<string, string>> {
    return Object.freeze({
      event: PROVIDER_CALLBACK_EVENT_HEADER,
      timestamp: PROVIDER_CALLBACK_TIMESTAMP_HEADER,
      signature: PROVIDER_CALLBACK_SIGNATURE_HEADER,
    })
  }

  private async readResult(providerJobId: string, payload: Record<string, unknown>): Promise<Readonly<HttpTransformationResult>> {
    if (typeof payload.mediaBase64 !== 'string' || payload.mediaBase64.length === 0) {
      throw new ProviderAdapterError('PROVIDER_MALFORMED_RESPONSE', false, undefined, 'Provider result carried no media')
    }
    let mediaBytes: Buffer
    try {
      mediaBytes = Buffer.from(payload.mediaBase64, 'base64')
    } catch {
      throw new ProviderAdapterError('PROVIDER_MALFORMED_RESPONSE', false, undefined, 'Provider result media is not decodable')
    }
    if (mediaBytes.byteLength === 0 || mediaBytes.byteLength > this.maxResultBytes) {
      throw new ProviderAdapterError('PROVIDER_MALFORMED_RESPONSE', false, undefined, 'Provider result media size is out of bounds')
    }
    const mediaSha256 = createHash('sha256').update(mediaBytes).digest('hex')
    // The provider states a checksum; Apollo recomputes it over the bytes it
    // actually received. Trusting the stated value would make the check a
    // decoration.
    if (typeof payload.mediaSha256 === 'string' && payload.mediaSha256 !== mediaSha256) {
      throw new ProviderAdapterError('PROVIDER_RESULT_CORRUPTED', false, undefined, 'Provider result checksum does not match its bytes')
    }
    const cost = payload.observedCost as { currency?: unknown; costMinorUnits?: unknown } | undefined
    return Object.freeze({
      providerJobId,
      mediaBytes,
      mediaSha256,
      mediaByteSize: mediaBytes.byteLength,
      container: 'mp4' as const,
      mediaType: 'video' as const,
      ...(cost && typeof cost.currency === 'string' && Number.isSafeInteger(cost.costMinorUnits)
        ? { observedCost: Object.freeze({ currency: cost.currency, costMinorUnits: cost.costMinorUnits as number }) }
        : {}),
    })
  }
}
