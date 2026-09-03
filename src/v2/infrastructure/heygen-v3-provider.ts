import { createHash } from 'node:crypto'

import type {
  AsyncMediaProviderAdapter,
  ProviderCapabilities,
  ProviderEstimate,
  ProviderStatus,
  ProviderSubmitContext,
  ProviderSubmissionResult,
} from '../application/ports/async-media-provider.ts'
import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain } from '../domain/errors.ts'
import { ProviderAdapterError } from '../domain/provider-contract.ts'

/*
 * HeyGen v3 adapter. Facts verified against the official documentation on
 * 2026-09-02 (https://developers.heygen.com/reference/create-video,
 * .../upload-asset.md, .../get-video.md):
 * - POST /v3/assets (multipart, max 32MB, mp3/wav supported) → data.asset_id;
 *   POST /v3/videos (type avatar + audio_asset_id for lip-synced speech,
 *   mutually exclusive with script) → data.video_id; GET /v3/videos/{id} →
 *   data.status + data.video_url. Auth: X-Api-Key header.
 * - Upload Asset and Create Video both accept Idempotency-Key for 24 hours.
 *   Apollo derives a provider-safe key from its persisted operation key and
 *   sends it to both mutations; endpoint scoping keeps the two effects apart.
 * - VideoStatus is exactly pending | processing | completed | failed; any
 *   other value fails closed as PROVIDER_STATUS_UNKNOWN.
 * - There is no documented cancellation of a processing video (Delete Video
 *   destroys finished artifacts), so supportsCancellation stays false and no
 *   cancel() method exists.
 * - Webhooks exist upstream, but this adapter does not implement webhook
 *   verification, so completion is declared as 'polling' only.
 * - Lip-sync is a separate official product (Create Lipsync); this adapter
 *   only implements audio-avatar and its capabilities say exactly that.
 */
const ADAPTER_ID = 'heygen-v3'
const ADAPTER_VERSION = '3.1.0'
const MAX_RESPONSE_BYTES = 1024 * 1024
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,255}$/
const HASH = /^[a-f0-9]{64}$/
const MAX_ASSET_BYTES = 32 * 1024 * 1024

type Fetch = typeof fetch

export interface HeyGenV3ProviderResult {
  providerJobId: string
  downloadUrl: string
  mediaType: 'video'
}

export class HeyGenProviderError extends ProviderAdapterError {
  constructor(code: string, retryable: boolean, retryAfterMs?: number) {
    super(code, retryable, retryAfterMs, 'HeyGen provider operation failed')
    this.name = 'HeyGenProviderError'
  }
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HeyGenProviderError(`INVALID_${field.toUpperCase()}`, false)
  }
  return value as Record<string, unknown>
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !PROVIDER_ID.test(value)) {
    throw new HeyGenProviderError(`INVALID_${field.toUpperCase()}`, false)
  }
  return value
}

function retryAfter(response: Response): number | undefined {
  const header = response.headers.get('retry-after')
  if (header === null || header.trim() === '') return undefined
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(Math.ceil(seconds * 1_000), 3_600_000) : undefined
}

function providerIdempotencyKey(value: string): string {
  return `apollo:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

function httpError(response: Response): HeyGenProviderError {
  if (response.status === 429) return new HeyGenProviderError('PROVIDER_RATE_LIMITED', true, retryAfter(response))
  if (response.status >= 500) return new HeyGenProviderError('PROVIDER_UNAVAILABLE', true, retryAfter(response))
  if (response.status === 401 || response.status === 403) return new HeyGenProviderError('PROVIDER_AUTHENTICATION_FAILED', false)
  if (response.status === 404) return new HeyGenProviderError('PROVIDER_JOB_NOT_FOUND', false)
  if (response.status === 409) return new HeyGenProviderError('PROVIDER_CONFLICT', true, retryAfter(response))
  return new HeyGenProviderError('PROVIDER_REQUEST_REJECTED', false)
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw httpError(response)
  const text = await response.text()
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new HeyGenProviderError('PROVIDER_RESPONSE_TOO_LARGE', false)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new HeyGenProviderError('PROVIDER_RESPONSE_INVALID', false)
  }
  return object(parsed, 'response')
}

function statusFromProvider(value: unknown): ProviderStatus {
  // Official VideoStatus enum only; anything else fails closed instead of
  // being optimistically normalized.
  if (value === 'pending') return 'queued'
  if (value === 'processing') return 'processing'
  if (value === 'completed') return 'completed'
  if (value === 'failed') return 'failed'
  throw new HeyGenProviderError('PROVIDER_STATUS_UNKNOWN', false)
}

function materializedInput(value: Readonly<Record<string, unknown>>) {
  const allowed = ['avatarId', 'audioBytes', 'audioSha256', 'audioByteSize', 'audioContainer', 'durationMs', 'aspectRatio']
  if (!Object.keys(value).every((key) => allowed.includes(key))) {
    throw new HeyGenProviderError('PROVIDER_INPUT_INVALID', false)
  }
  const avatarId = identifier(value.avatarId, 'avatar_id')
  if (!(value.audioBytes instanceof Uint8Array)) throw new HeyGenProviderError('INVALID_AUDIO_BYTES', false)
  if (typeof value.audioSha256 !== 'string' || !HASH.test(value.audioSha256)) throw new HeyGenProviderError('INVALID_AUDIO_HASH', false)
  const audioByteSize = Number(value.audioByteSize)
  if (!Number.isSafeInteger(audioByteSize) || audioByteSize <= 0 || audioByteSize > MAX_ASSET_BYTES) throw new HeyGenProviderError('INVALID_AUDIO_SIZE', false)
  if (value.audioContainer !== 'mp3' && value.audioContainer !== 'wav') throw new HeyGenProviderError('INVALID_AUDIO_CONTAINER', false)
  const durationMs = Number(value.durationMs)
  if (!Number.isSafeInteger(durationMs) || durationMs < 1_000 || durationMs > 1_800_000) {
    throw new HeyGenProviderError('INVALID_DURATION', false)
  }
  const aspectRatio = value.aspectRatio ?? '9:16'
  if (aspectRatio !== '9:16' && aspectRatio !== '16:9') throw new HeyGenProviderError('INVALID_ASPECT_RATIO', false)
  return Object.freeze({ avatarId, audioBytes: value.audioBytes, audioSha256: value.audioSha256, audioByteSize, audioContainer: value.audioContainer, durationMs, aspectRatio })
}

export class HeyGenV3AsyncMediaProviderAdapter
implements AsyncMediaProviderAdapter<Readonly<Record<string, unknown>>, HeyGenV3ProviderResult> {
  readonly id = ADAPTER_ID
  readonly adapterVersion = ADAPTER_VERSION
  readonly configHash: string
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetch: Fetch
  private readonly clock: () => Date
  private readonly costMinorUnitsPerMinute: number
  private readonly requestTimeoutMs: number

  constructor(input: {
    apiKey: string
    fetch?: Fetch
    baseUrl?: string
    clock?: () => Date
    costMinorUnitsPerMinute: number
    requestTimeoutMs?: number
  }) {
    assertDomain(input.apiKey.trim().length >= 8, 'PERSISTENCE_NOT_CONFIGURED', 'HeyGen API credential is unavailable')
    assertDomain(Number.isSafeInteger(input.costMinorUnitsPerMinute) && input.costMinorUnitsPerMinute >= 0, 'PERSISTENCE_NOT_CONFIGURED', 'HeyGen cost configuration is invalid')
    const requestTimeoutMs = input.requestTimeoutMs ?? 20_000
    assertDomain(Number.isSafeInteger(requestTimeoutMs) && requestTimeoutMs >= 1_000 && requestTimeoutMs <= 120_000, 'PERSISTENCE_NOT_CONFIGURED', 'HeyGen timeout configuration is invalid')
    const baseUrl = new URL(input.baseUrl ?? 'https://api.heygen.com')
    assertDomain(baseUrl.protocol === 'https:' && !baseUrl.username && !baseUrl.password && !baseUrl.search && !baseUrl.hash, 'PERSISTENCE_NOT_CONFIGURED', 'HeyGen API base URL is invalid')
    this.apiKey = input.apiKey.trim()
    this.baseUrl = baseUrl.toString().replace(/\/$/, '')
    this.fetch = input.fetch ?? globalThis.fetch
    this.clock = input.clock ?? (() => new Date())
    this.costMinorUnitsPerMinute = input.costMinorUnitsPerMinute
    this.requestTimeoutMs = requestTimeoutMs
    // Runtime identity of this adapter instance: versioned adapter code +
    // non-secret configuration. The API key is deliberately excluded so the
    // hash can be persisted in artifact lineage.
    this.configHash = calculateCanonicalHash({
      adapterId: ADAPTER_ID,
      adapterVersion: ADAPTER_VERSION,
      baseUrl: this.baseUrl,
      costMinorUnitsPerMinute: this.costMinorUnitsPerMinute,
      requestTimeoutMs: this.requestTimeoutMs,
    })
  }

  async getCapabilities(): Promise<Readonly<ProviderCapabilities>> {
    const fetchedAt = this.clock()
    if (!Number.isFinite(fetchedAt.getTime())) throw new HeyGenProviderError('PROVIDER_CLOCK_INVALID', false)
    return Object.freeze({
      operations: Object.freeze(['audio-avatar'] as const),
      inputFormats: Object.freeze(['mp3', 'wav']),
      outputFormats: Object.freeze(['mp4']),
      aspectRatios: Object.freeze(['9:16', '16:9']),
      duration: Object.freeze({ minSeconds: 1, maxSeconds: 1_800 }),
      identityReference: 'profile-id' as const,
      supportsSeed: false,
      supportsIdempotency: true,
      supportsCancellation: false,
      completion: 'polling' as const,
      fetchedAt: fetchedAt.toISOString(),
      expiresAt: new Date(fetchedAt.getTime() + 15 * 60_000).toISOString(),
    })
  }

  async estimate(input: Readonly<Record<string, unknown>>): Promise<Readonly<ProviderEstimate>> {
    const durationMs = Number(input.durationMs)
    if (!Number.isSafeInteger(durationMs) || durationMs < 1_000 || durationMs > 1_800_000) {
      throw new HeyGenProviderError('INVALID_DURATION', false)
    }
    return Object.freeze({
      currency: 'USD',
      costMinorUnits: Math.ceil(durationMs / 60_000) * this.costMinorUnitsPerMinute,
      estimatedLatencyMs: Math.max(60_000, Math.ceil(durationMs * 2.5)),
    })
  }

  async submit(input: Readonly<Record<string, unknown>>, context: Readonly<ProviderSubmitContext>): Promise<Readonly<ProviderSubmissionResult<HeyGenV3ProviderResult>>> {
    const value = materializedInput(input)
    const bytes = value.audioBytes
    if (bytes.byteLength !== value.audioByteSize || createHash('sha256').update(bytes).digest('hex') !== value.audioSha256) {
      throw new HeyGenProviderError('AUDIO_MATERIALIZATION_MISMATCH', false)
    }
    const form = new FormData()
    const mediaType = value.audioContainer === 'mp3' ? 'audio/mpeg' : 'audio/wav'
    form.append('file', new Blob([new Uint8Array(bytes)], { type: mediaType }), `apollo-${value.audioSha256}.${value.audioContainer}`)
    const uploaded = await this.request('/v3/assets', {
      method: 'POST',
      headers: { 'idempotency-key': providerIdempotencyKey(context.idempotencyKey) },
      body: form,
    }, context.signal)
    const assetId = identifier(object(uploaded.data, 'data').asset_id, 'asset_id')
    const response = await this.request('/v3/videos', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': providerIdempotencyKey(context.idempotencyKey),
      },
      body: JSON.stringify({
        type: 'avatar', avatar_id: value.avatarId, audio_asset_id: assetId,
        aspect_ratio: value.aspectRatio, fit: 'cover', output_format: 'mp4',
      }),
    }, context.signal)
    const data = object(response.data, 'data')
    return Object.freeze({ kind: 'accepted' as const, providerJobId: identifier(data.video_id, 'video_id') })
  }

  async getStatus(providerJobId: string, signal?: AbortSignal): Promise<ProviderStatus> {
    const response = await this.request(`/v3/videos/${encodeURIComponent(identifier(providerJobId, 'provider_job_id'))}`, { method: 'GET' }, signal)
    return statusFromProvider(object(response.data, 'data').status)
  }

  async retrieve(providerJobId: string, signal?: AbortSignal): Promise<Readonly<HeyGenV3ProviderResult>> {
    const id = identifier(providerJobId, 'provider_job_id')
    const response = await this.request(`/v3/videos/${encodeURIComponent(id)}`, { method: 'GET' }, signal)
    const data = object(response.data, 'data')
    if (statusFromProvider(data.status) !== 'completed' || typeof data.video_url !== 'string') {
      throw new HeyGenProviderError('PROVIDER_RESULT_UNAVAILABLE', true)
    }
    let downloadUrl: URL
    try {
      downloadUrl = new URL(data.video_url)
    } catch {
      throw new HeyGenProviderError('PROVIDER_RESULT_INVALID', false)
    }
    if (downloadUrl.protocol !== 'https:' || downloadUrl.username || downloadUrl.password || downloadUrl.hash) {
      throw new HeyGenProviderError('PROVIDER_RESULT_INVALID', false)
    }
    return Object.freeze({ providerJobId: id, downloadUrl: downloadUrl.toString(), mediaType: 'video' as const })
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs)
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
    let response: Response
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        ...init,
        redirect: 'error',
        signal: requestSignal,
        headers: { accept: 'application/json', 'x-api-key': this.apiKey, ...init.headers },
      })
    } catch (error) {
      if (error instanceof HeyGenProviderError) throw error
      throw new HeyGenProviderError(requestSignal.aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_NETWORK_FAILURE', true)
    }
    return responseBody(response)
  }
}
