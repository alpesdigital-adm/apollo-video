import { createHash } from 'node:crypto'

import type {
  AsyncMediaProviderAdapter,
  ProviderCapabilities,
  ProviderEstimate,
  ProviderSubmitContext,
  ProviderSubmissionResult,
} from '../application/ports/async-media-provider.ts'
import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain } from '../domain/errors.ts'
import { ProviderAdapterError } from '../domain/provider-contract.ts'

/*
 * ElevenLabs TTS adapter. Facts verified against the official documentation
 * on 2026-08-27:
 * - POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/with-timestamps
 *   (https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps)
 * - Authentication: `xi-api-key` header
 *   (https://elevenlabs.io/docs/api-reference/authentication)
 * - The response is synchronous JSON: `audio_base64` plus per-character
 *   `alignment` (`characters`, `character_start_times_seconds`,
 *   `character_end_times_seconds`) for the ORIGINAL text and a separate
 *   `normalized_alignment` for the provider-normalized text.
 * - `output_format` is a query enum (mp3_..., wav_..., pcm_...); wav at 44.1kHz
 *   requires a paid tier, mp3_44100_128 is the default.
 * - `seed` (0..4294967295) is best-effort determinism only.
 * - No idempotency header exists for this endpoint; the provider-side
 *   reference for a finished generation is the `request-id` response header
 *   (the same id the `previous_request_ids` stitching field consumes).
 */
const ADAPTER_ID = 'elevenlabs-tts'
const ADAPTER_VERSION = '1.0.0'
const DEFAULT_MODEL_ID = 'eleven_multilingual_v2'
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,255}$/
const HASH = /^[a-f0-9]{64}$/
const LOCALE = /^[a-z]{2}(-[A-Z]{2})?$/
const OUTPUT_FORMATS = Object.freeze({ mp3: 'mp3_44100_128', wav: 'wav_44100' } as const)

type Fetch = typeof fetch

export interface ElevenLabsAlignment {
  characters: readonly string[]
  startTimesSeconds: readonly number[]
  endTimesSeconds: readonly number[]
}

export interface ElevenLabsTtsProviderResult {
  requestId: string
  modelId: string
  adapterConfigHash: string
  scriptHash: string
  audioBytes: Uint8Array
  audioSha256: string
  audioByteSize: number
  audioContainer: 'mp3' | 'wav'
  mediaType: 'audio'
  alignment: Readonly<ElevenLabsAlignment>
}

export class ElevenLabsProviderError extends ProviderAdapterError {
  constructor(code: string, retryable: boolean, retryAfterMs?: number) {
    super(code, retryable, retryAfterMs, 'ElevenLabs provider operation failed')
    this.name = 'ElevenLabsProviderError'
  }
}

function retryAfter(response: Response): number | undefined {
  const header = response.headers.get('retry-after')
  if (header === null || header.trim() === '') return undefined
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(Math.ceil(seconds * 1_000), 3_600_000) : undefined
}

function httpError(response: Response): ElevenLabsProviderError {
  if (response.status === 429) return new ElevenLabsProviderError('PROVIDER_RATE_LIMITED', true, retryAfter(response))
  if (response.status >= 500) return new ElevenLabsProviderError('PROVIDER_UNAVAILABLE', true, retryAfter(response))
  if (response.status === 401 || response.status === 403) return new ElevenLabsProviderError('PROVIDER_AUTHENTICATION_FAILED', false)
  if (response.status === 409) return new ElevenLabsProviderError('PROVIDER_CONFLICT', true, retryAfter(response))
  return new ElevenLabsProviderError('PROVIDER_REQUEST_REJECTED', false)
}

function finiteSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ElevenLabsProviderError('PROVIDER_ALIGNMENT_INVALID', false)
  }
  return value
}

function validatedAlignment(value: unknown, text: string): Readonly<ElevenLabsAlignment> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ElevenLabsProviderError('PROVIDER_ALIGNMENT_INVALID', false)
  }
  const input = value as Record<string, unknown>
  const characters = input.characters
  const starts = input.character_start_times_seconds
  const ends = input.character_end_times_seconds
  if (!Array.isArray(characters) || !Array.isArray(starts) || !Array.isArray(ends)) {
    throw new ElevenLabsProviderError('PROVIDER_ALIGNMENT_INVALID', false)
  }
  if (characters.length !== starts.length || characters.length !== ends.length || characters.length === 0) {
    throw new ElevenLabsProviderError('PROVIDER_ALIGNMENT_INVALID', false)
  }
  let previousEnd = 0
  for (let index = 0; index < characters.length; index += 1) {
    if (typeof characters[index] !== 'string') throw new ElevenLabsProviderError('PROVIDER_ALIGNMENT_INVALID', false)
    const start = finiteSeconds(starts[index])
    const end = finiteSeconds(ends[index])
    if (end < start || start + 1e-6 < previousEnd) throw new ElevenLabsProviderError('PROVIDER_ALIGNMENT_INVALID', false)
    previousEnd = end
  }
  // The provider documents `alignment` as timestamps for the ORIGINAL text.
  // A mismatch means the speech does not correspond to the approved script,
  // so the paid result is rejected instead of silently accepted.
  if (characters.join('') !== text) throw new ElevenLabsProviderError('PROVIDER_ALIGNMENT_MISMATCH', false)
  return Object.freeze({
    characters: Object.freeze(characters as string[]),
    startTimesSeconds: Object.freeze(starts as number[]),
    endTimesSeconds: Object.freeze(ends as number[]),
  })
}

interface MaterializedTtsInput {
  text: string
  scriptHash: string
  voiceId: string
  modelId: string
  languageCode?: string
  outputFormat: 'mp3' | 'wav'
  seed?: number
}

export class ElevenLabsTtsProviderAdapter
implements AsyncMediaProviderAdapter<Readonly<Record<string, unknown>>, ElevenLabsTtsProviderResult> {
  readonly id = ADAPTER_ID
  readonly adapterVersion = ADAPTER_VERSION
  readonly modelRef = DEFAULT_MODEL_ID
  readonly configHash: string
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetch: Fetch
  private readonly clock: () => Date
  private readonly costMinorUnitsPerThousandCharacters: number
  private readonly requestTimeoutMs: number
  private readonly maxAudioBytes: number
  private readonly maxCharacters: number

  constructor(input: {
    apiKey: string
    costMinorUnitsPerThousandCharacters: number
    fetch?: Fetch
    baseUrl?: string
    clock?: () => Date
    requestTimeoutMs?: number
    maxAudioBytes?: number
    maxCharacters?: number
  }) {
    assertDomain(input.apiKey.trim().length >= 8, 'PERSISTENCE_NOT_CONFIGURED', 'ElevenLabs API credential is unavailable')
    assertDomain(Number.isSafeInteger(input.costMinorUnitsPerThousandCharacters) && input.costMinorUnitsPerThousandCharacters >= 0, 'PERSISTENCE_NOT_CONFIGURED', 'ElevenLabs cost configuration is invalid')
    const requestTimeoutMs = input.requestTimeoutMs ?? 60_000
    assertDomain(Number.isSafeInteger(requestTimeoutMs) && requestTimeoutMs >= 1_000 && requestTimeoutMs <= 300_000, 'PERSISTENCE_NOT_CONFIGURED', 'ElevenLabs timeout configuration is invalid')
    const maxAudioBytes = input.maxAudioBytes ?? 32 * 1024 * 1024
    assertDomain(Number.isSafeInteger(maxAudioBytes) && maxAudioBytes >= 1_024 && maxAudioBytes <= 256 * 1024 * 1024, 'PERSISTENCE_NOT_CONFIGURED', 'ElevenLabs audio size configuration is invalid')
    // Apollo-side text ceiling; the provider documents no per-request
    // character maximum on this endpoint, so the boundary is ours.
    const maxCharacters = input.maxCharacters ?? 5_000
    assertDomain(Number.isSafeInteger(maxCharacters) && maxCharacters >= 1 && maxCharacters <= 40_000, 'PERSISTENCE_NOT_CONFIGURED', 'ElevenLabs text limit configuration is invalid')
    const baseUrl = new URL(input.baseUrl ?? 'https://api.elevenlabs.io')
    assertDomain(baseUrl.protocol === 'https:' && !baseUrl.username && !baseUrl.password && !baseUrl.search && !baseUrl.hash, 'PERSISTENCE_NOT_CONFIGURED', 'ElevenLabs API base URL is invalid')
    this.apiKey = input.apiKey.trim()
    this.baseUrl = baseUrl.toString().replace(/\/$/, '')
    this.fetch = input.fetch ?? globalThis.fetch
    this.clock = input.clock ?? (() => new Date())
    this.costMinorUnitsPerThousandCharacters = input.costMinorUnitsPerThousandCharacters
    this.requestTimeoutMs = requestTimeoutMs
    this.maxAudioBytes = maxAudioBytes
    this.maxCharacters = maxCharacters
    // The API key is deliberately excluded so the hash can be persisted in
    // artifact lineage without ever encoding the secret.
    this.configHash = calculateCanonicalHash({
      adapterId: ADAPTER_ID,
      adapterVersion: ADAPTER_VERSION,
      baseUrl: this.baseUrl,
      costMinorUnitsPerThousandCharacters: this.costMinorUnitsPerThousandCharacters,
      requestTimeoutMs: this.requestTimeoutMs,
      maxAudioBytes: this.maxAudioBytes,
      maxCharacters: this.maxCharacters,
    })
  }

  async getCapabilities(): Promise<Readonly<ProviderCapabilities>> {
    const fetchedAt = this.clock()
    if (!Number.isFinite(fetchedAt.getTime())) throw new ElevenLabsProviderError('PROVIDER_CLOCK_INVALID', false)
    return Object.freeze({
      operations: Object.freeze(['tts'] as const),
      inputFormats: Object.freeze(['text']),
      outputFormats: Object.freeze(['mp3', 'wav']),
      duration: Object.freeze({ minSeconds: 0, maxSeconds: 3_600 }),
      identityReference: 'profile-id' as const,
      supportsSeed: true,
      supportsIdempotency: false,
      supportsCancellation: false,
      completion: 'synchronous' as const,
      fetchedAt: fetchedAt.toISOString(),
      expiresAt: new Date(fetchedAt.getTime() + 15 * 60_000).toISOString(),
    })
  }

  async estimate(input: Readonly<Record<string, unknown>>): Promise<Readonly<ProviderEstimate>> {
    const text = input.text
    if (typeof text !== 'string' || text.trim().length === 0 || text.length > this.maxCharacters) {
      throw new ElevenLabsProviderError('INVALID_TEXT', false)
    }
    return Object.freeze({
      currency: 'USD',
      costMinorUnits: Math.ceil(text.length / 1_000) * this.costMinorUnitsPerThousandCharacters,
      estimatedLatencyMs: Math.min(120_000, Math.max(5_000, text.length * 20)),
    })
  }

  async submit(input: Readonly<Record<string, unknown>>, context: Readonly<ProviderSubmitContext>): Promise<Readonly<ProviderSubmissionResult<ElevenLabsTtsProviderResult>>> {
    const value = this.materializedInput(input)
    const body: Record<string, unknown> = { text: value.text, model_id: value.modelId }
    if (value.languageCode !== undefined) body.language_code = value.languageCode
    if (value.seed !== undefined) body.seed = value.seed
    const path = `/v1/text-to-speech/${encodeURIComponent(value.voiceId)}/with-timestamps?output_format=${OUTPUT_FORMATS[value.outputFormat]}`
    const response = await this.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, context.signal)
    // The provider-side reference for this finished paid effect is the
    // request-id response header; without it the result has no provable
    // provider identity, so the adapter fails closed instead of inventing one.
    const requestId = response.headers.get('request-id') ?? response.headers.get('history-item-id')
    if (requestId === null || !PROVIDER_ID.test(requestId)) {
      throw new ElevenLabsProviderError('PROVIDER_REFERENCE_MISSING', false)
    }
    const payload = await this.responseBody(response)
    if (typeof payload.audio_base64 !== 'string' || payload.audio_base64.length === 0) {
      throw new ElevenLabsProviderError('PROVIDER_RESPONSE_INVALID', false)
    }
    let audioBytes: Buffer
    try {
      audioBytes = Buffer.from(payload.audio_base64, 'base64')
    } catch {
      throw new ElevenLabsProviderError('PROVIDER_RESPONSE_INVALID', false)
    }
    if (audioBytes.byteLength === 0) throw new ElevenLabsProviderError('PROVIDER_RESPONSE_INVALID', false)
    if (audioBytes.byteLength > this.maxAudioBytes) throw new ElevenLabsProviderError('PROVIDER_RESPONSE_TOO_LARGE', false)
    this.assertContainer(audioBytes, value.outputFormat)
    const alignment = validatedAlignment(payload.alignment, value.text)
    const result: ElevenLabsTtsProviderResult = Object.freeze({
      requestId,
      modelId: value.modelId,
      adapterConfigHash: this.configHash,
      scriptHash: value.scriptHash,
      audioBytes: new Uint8Array(audioBytes),
      audioSha256: createHash('sha256').update(audioBytes).digest('hex'),
      audioByteSize: audioBytes.byteLength,
      audioContainer: value.outputFormat,
      mediaType: 'audio' as const,
      alignment,
    })
    return Object.freeze({
      kind: 'completed' as const,
      bundle: Object.freeze({
        providerJobRef: requestId,
        result,
        completedAt: this.clock().toISOString(),
      }),
    })
  }

  private materializedInput(value: Readonly<Record<string, unknown>>): MaterializedTtsInput {
    const allowed = ['text', 'scriptHash', 'voiceId', 'modelId', 'languageCode', 'outputFormat', 'seed']
    if (!Object.keys(value).every((key) => allowed.includes(key))) {
      throw new ElevenLabsProviderError('PROVIDER_INPUT_INVALID', false)
    }
    const text = value.text
    if (typeof text !== 'string' || text.trim().length === 0 || text.length > this.maxCharacters || text.includes('\u0000')) {
      throw new ElevenLabsProviderError('INVALID_TEXT', false)
    }
    if (typeof value.scriptHash !== 'string' || !HASH.test(value.scriptHash)) {
      throw new ElevenLabsProviderError('INVALID_SCRIPT_HASH', false)
    }
    // Fail closed when the materialized text is not the approved script:
    // no silent rewriting can reach the provider.
    if (createHash('sha256').update(text, 'utf8').digest('hex') !== value.scriptHash) {
      throw new ElevenLabsProviderError('SCRIPT_MATERIALIZATION_MISMATCH', false)
    }
    if (typeof value.voiceId !== 'string' || !PROVIDER_ID.test(value.voiceId)) {
      throw new ElevenLabsProviderError('INVALID_VOICE_ID', false)
    }
    const modelId = value.modelId ?? DEFAULT_MODEL_ID
    if (typeof modelId !== 'string' || !PROVIDER_ID.test(modelId)) {
      throw new ElevenLabsProviderError('INVALID_MODEL_ID', false)
    }
    if (value.languageCode !== undefined && (typeof value.languageCode !== 'string' || !LOCALE.test(value.languageCode))) {
      throw new ElevenLabsProviderError('INVALID_LANGUAGE_CODE', false)
    }
    if (value.outputFormat !== 'mp3' && value.outputFormat !== 'wav') {
      throw new ElevenLabsProviderError('INVALID_OUTPUT_FORMAT', false)
    }
    if (value.seed !== undefined && (!Number.isSafeInteger(value.seed) || Number(value.seed) < 0 || Number(value.seed) > 4_294_967_295)) {
      throw new ElevenLabsProviderError('INVALID_SEED', false)
    }
    return {
      text,
      scriptHash: value.scriptHash,
      voiceId: value.voiceId,
      modelId,
      ...(value.languageCode === undefined ? {} : { languageCode: value.languageCode }),
      outputFormat: value.outputFormat,
      ...(value.seed === undefined ? {} : { seed: Number(value.seed) }),
    }
  }

  private assertContainer(bytes: Buffer, outputFormat: 'mp3' | 'wav'): void {
    const isWav = bytes.byteLength >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WAVE'
    const isMp3 = bytes.byteLength >= 3
      && (bytes.toString('latin1', 0, 3) === 'ID3' || (bytes[0] === 0xff && ((bytes[1] as number) & 0xe0) === 0xe0))
    if ((outputFormat === 'wav' && !isWav) || (outputFormat === 'mp3' && !isMp3)) {
      throw new ElevenLabsProviderError('PROVIDER_CONTAINER_MISMATCH', false)
    }
  }

  private async responseBody(response: Response): Promise<Record<string, unknown>> {
    // Base64 inflates the payload by ~4/3 and the JSON envelope adds the
    // alignment arrays, so the byte ceiling scales from the audio limit.
    const maxResponseBytes = Math.ceil(this.maxAudioBytes * 2) + 1024 * 1024
    const text = await response.text()
    if (Buffer.byteLength(text) > maxResponseBytes) throw new ElevenLabsProviderError('PROVIDER_RESPONSE_TOO_LARGE', false)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new ElevenLabsProviderError('PROVIDER_RESPONSE_INVALID', false)
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ElevenLabsProviderError('PROVIDER_RESPONSE_INVALID', false)
    }
    return parsed as Record<string, unknown>
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs)
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
    let response: Response
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        ...init,
        redirect: 'error',
        signal: requestSignal,
        headers: { accept: 'application/json', 'xi-api-key': this.apiKey, ...init.headers },
      })
    } catch (error) {
      if (error instanceof ElevenLabsProviderError) throw error
      throw new ElevenLabsProviderError(requestSignal.aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_NETWORK_FAILURE', true)
    }
    if (!response.ok) throw httpError(response)
    return response
  }
}
