import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

import type {
  SourceSeparationProvider,
  SourceSeparationResult,
} from '../application/ports/source-separation-provider.ts'
import { calculateCanonicalHash, stableSerialize } from '../domain/canonical-hash.ts'
import { DomainError, assertDomain } from '../domain/errors.ts'
import type { SourceSeparationOffer } from '../domain/source-cleanup.ts'
import { calculateFileSha256 } from './media/local-artifact-manifest.ts'

const ADAPTER_ID = 'elevenlabs-voice-isolation'
const ADAPTER_VERSION = '1.0.0'
const PROVIDER = 'elevenlabs'
const MODEL_REF = 'voice-isolator/v1'
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/

type Fetch = typeof fetch

function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate)
  assertDomain(
    !rel.startsWith('..') && !isAbsolute(rel),
    'PERSISTENCE_CONFLICT',
    'Voice isolation work path escaped its root',
  )
}

function providerReference(response: Response): string {
  const value = response.headers.get('request-id') ??
    response.headers.get('history-item-id') ??
    response.headers.get('x-request-id')
  assertDomain(
    typeof value === 'string' && ID.test(value),
    'RENDER_OUTPUT_INVALID',
    'Voice isolation response has no provider reference',
  )
  return value
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get('retry-after')
  if (!raw) return undefined
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(3_600_000, Math.ceil(seconds * 1_000))
    : undefined
}

export class ElevenLabsVoiceIsolationProvider
implements SourceSeparationProvider {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetch: Fetch
  private readonly workRoot: string
  private readonly requestTimeoutMs: number
  private readonly maxInputBytes: number
  private readonly maxOutputBytes: number
  private readonly maxDurationMs: number
  private readonly minDurationMs: number
  private readonly normalizedCost: number
  private readonly configHash: string
  private readonly capabilityHash: string

  constructor(input: {
    apiKey: string
    workRoot: string
    fetch?: Fetch
    baseUrl?: string
    requestTimeoutMs?: number
    maxInputBytes?: number
    maxOutputBytes?: number
    maxDurationMs?: number
    minDurationMs?: number
    normalizedCost?: number
  }) {
    assertDomain(
      input.apiKey.trim().length >= 8,
      'PERSISTENCE_NOT_CONFIGURED',
      'ElevenLabs voice isolation credential is unavailable',
    )
    const baseUrl = new URL(input.baseUrl ?? 'https://api.elevenlabs.io')
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname)
    assertDomain(
      (baseUrl.protocol === 'https:' || (baseUrl.protocol === 'http:' && loopback)) &&
        !baseUrl.username && !baseUrl.password && !baseUrl.search && !baseUrl.hash,
      'PERSISTENCE_NOT_CONFIGURED',
      'ElevenLabs voice isolation base URL is invalid',
    )
    this.requestTimeoutMs = input.requestTimeoutMs ?? 10 * 60_000
    this.maxInputBytes = input.maxInputBytes ?? 500 * 1024 * 1024
    this.maxOutputBytes = input.maxOutputBytes ?? 256 * 1024 * 1024
    this.maxDurationMs = input.maxDurationMs ?? 3_600_000
    this.minDurationMs = input.minDurationMs ?? 4_600
    this.normalizedCost = input.normalizedCost ?? 0.6
    assertDomain(
      Number.isSafeInteger(this.requestTimeoutMs) && this.requestTimeoutMs >= 1_000 && this.requestTimeoutMs <= 30 * 60_000 &&
        Number.isSafeInteger(this.maxInputBytes) && this.maxInputBytes >= 1_024 && this.maxInputBytes <= 500 * 1024 * 1024 &&
        Number.isSafeInteger(this.maxOutputBytes) && this.maxOutputBytes >= 1_024 && this.maxOutputBytes <= 500 * 1024 * 1024 &&
        Number.isSafeInteger(this.minDurationMs) && this.minDurationMs >= 1_000 &&
        Number.isSafeInteger(this.maxDurationMs) && this.maxDurationMs >= this.minDurationMs && this.maxDurationMs <= 3_600_000 &&
        Number.isFinite(this.normalizedCost) && this.normalizedCost >= 0 && this.normalizedCost <= 1_000_000,
      'PERSISTENCE_NOT_CONFIGURED',
      'ElevenLabs voice isolation limits are invalid',
    )
    this.apiKey = input.apiKey.trim()
    this.baseUrl = baseUrl.toString().replace(/\/$/, '')
    this.fetch = input.fetch ?? globalThis.fetch
    this.workRoot = resolve(input.workRoot)
    this.configHash = calculateCanonicalHash({
      adapterId: ADAPTER_ID,
      adapterVersion: ADAPTER_VERSION,
      provider: PROVIDER,
      modelRef: MODEL_REF,
      baseUrl: this.baseUrl,
      requestTimeoutMs: this.requestTimeoutMs,
      maxInputBytes: this.maxInputBytes,
      maxOutputBytes: this.maxOutputBytes,
      maxDurationMs: this.maxDurationMs,
      minDurationMs: this.minDurationMs,
      normalizedCost: this.normalizedCost,
    })
    this.capabilityHash = calculateCanonicalHash({
      operation: 'audio-isolation',
      inputFormats: ['audio', 'video'],
      outputFormats: ['audio/mpeg'],
      maxDurationMs: this.maxDurationMs,
      minDurationMs: this.minDurationMs,
      synchronous: true,
      supportsIdempotency: false,
    })
  }

  offer(sourceDurationMs: number): Readonly<SourceSeparationOffer> {
    assertDomain(
      Number.isSafeInteger(sourceDurationMs) && sourceDurationMs >= 1,
      'INVALID_ARGUMENT',
      'Source duration is invalid for voice isolation',
    )
    return Object.freeze({
      adapterId: ADAPTER_ID,
      adapterVersion: ADAPTER_VERSION,
      provider: PROVIDER,
      modelRef: MODEL_REF,
      configHash: this.configHash,
      capabilityHash: this.capabilityHash,
      minDurationMs: this.minDurationMs,
      maxDurationMs: this.maxDurationMs,
      normalizedCost: this.normalizedCost,
      predictedSpeechRetention: 0.92,
      predictedMusicRemoval: 0.9,
      predictedIntegrity: 0.95,
      billing: Object.freeze({
        unit: 'provider-characters' as const,
        quantity: Math.max(1_000, Math.ceil(sourceDurationMs / 60_000) * 1_000),
      }),
    })
  }

  async isolate(
    input: Parameters<SourceSeparationProvider['isolate']>[0],
  ): Promise<Readonly<SourceSeparationResult>> {
    assertDomain(
      ID.test(input.operationId) && isAbsolute(input.sourcePath) && HASH.test(input.sourceSha256),
      'INVALID_RENDER_INPUT',
      'Voice isolation input binding is invalid',
    )
    const currentOffer = this.offer(input.sourceDurationMs)
    assertDomain(
      stableSerialize(input.expectedOffer) === stableSerialize(currentOffer),
      'PERSISTENCE_CONFLICT',
      'Voice isolation provider binding changed after planning',
    )
    const sourceStat = await stat(input.sourcePath)
    assertDomain(
      sourceStat.isFile() && sourceStat.size > 0 && sourceStat.size <= this.maxInputBytes,
      'INVALID_RENDER_INPUT',
      'Voice isolation input exceeds configured limits',
    )
    assertDomain(
      await calculateFileSha256(input.sourcePath) === input.sourceSha256,
      'PERSISTENCE_CONFLICT',
      'Voice isolation source checksum changed',
    )
    const directory = join(this.workRoot, input.operationId)
    assertContained(this.workRoot, directory)
    await mkdir(directory, { recursive: true })
    const outputPath = join(directory, 'isolated-speech.mp3')
    const evidencePath = join(directory, 'isolation-result.json')
    const submissionPath = join(directory, 'isolation-submission.json')
    const temporaryPath = `${outputPath}.partial`
    const temporaryEvidencePath = `${evidencePath}.partial`
    const outputStat = await stat(outputPath).catch(() => undefined)
    const evidenceStat = await stat(evidencePath).catch(() => undefined)
    if (outputStat || evidenceStat) {
      if (!outputStat?.isFile() || !evidenceStat?.isFile()) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Voice isolation paid-result cache is incomplete',
        )
      }
      let cached: {
        sourceSha256?: string
        isolatedAudioSha256?: string
        isolatedAudioByteSize?: number
        providerRequestId?: string
        offer?: SourceSeparationOffer
      }
      try {
        cached = JSON.parse(await readFile(evidencePath, 'utf8')) as typeof cached
      } catch {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Voice isolation paid-result evidence is invalid',
        )
      }
      const cachedSha256 = await calculateFileSha256(outputPath)
      assertDomain(
        cached.sourceSha256 === input.sourceSha256 &&
        cached.isolatedAudioSha256 === cachedSha256 &&
        cached.isolatedAudioByteSize === outputStat.size &&
        cached.providerRequestId && ID.test(cached.providerRequestId) &&
        stableSerialize(cached.offer) === stableSerialize(input.expectedOffer),
        'PERSISTENCE_CONFLICT',
        'Voice isolation paid-result cache does not match the immutable request',
      )
      await rm(submissionPath, { force: true })
      return Object.freeze({
        isolatedAudioPath: outputPath,
        isolatedAudioSha256: cachedSha256,
        isolatedAudioByteSize: outputStat.size,
        providerRequestId: cached.providerRequestId,
        offer: input.expectedOffer,
      })
    }
    const ambiguousState = await Promise.all([
      stat(submissionPath).catch(() => undefined),
      stat(temporaryPath).catch(() => undefined),
      stat(temporaryEvidencePath).catch(() => undefined),
    ])
    assertDomain(
      ambiguousState.every((entry) => entry === undefined),
      'PERSISTENCE_CONFLICT',
      'Voice isolation has an unresolved paid submission',
    )
    await writeFile(
      submissionPath,
      stableSerialize({
        operationId: input.operationId,
        sourceSha256: input.sourceSha256,
        offer: input.expectedOffer,
      }),
      { flag: 'wx' },
    )
    const sourceBytes = await readFile(input.sourcePath)
    const form = new FormData()
    form.append('audio', new Blob([sourceBytes]), `${input.operationId}.mp4`)
    form.append('file_format', 'other')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs)
    timeout.unref?.()
    const abort = () => controller.abort()
    input.signal?.addEventListener('abort', abort, { once: true })
    let response: Response
    try {
      response = await this.fetch(`${this.baseUrl}/v1/audio-isolation`, {
        method: 'POST',
        headers: { 'xi-api-key': this.apiKey },
        body: form,
        signal: controller.signal,
      })
    } catch (error) {
      throw new DomainError(
        'RENDER_OUTPUT_CONFLICT',
        'Voice isolation transport ended without a durable provider result',
        { cause: error instanceof Error ? error.name : 'unknown' },
      )
    } finally {
      clearTimeout(timeout)
      input.signal?.removeEventListener('abort', abort)
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500
      await rm(submissionPath, { force: true })
      throw new DomainError(
        retryable ? 'RENDER_EXECUTION_FAILED' : 'INVALID_RENDER_INPUT',
        'Voice isolation provider rejected the request',
        { status: response.status, retryAfterMs: retryAfterMs(response), retryable },
      )
    }
    const requestId = providerReference(response)
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim()
    assertDomain(
      contentType?.startsWith('audio/') === true || contentType === 'application/octet-stream',
      'RENDER_OUTPUT_INVALID',
      'Voice isolation provider returned an unexpected media type',
    )
    const bytes = new Uint8Array(await response.arrayBuffer())
    assertDomain(
      bytes.byteLength >= 1_024 && bytes.byteLength <= this.maxOutputBytes,
      'RENDER_OUTPUT_INVALID',
      'Voice isolation provider returned invalid media bytes',
    )
    await writeFile(temporaryPath, bytes, { flag: 'wx' })
    await rename(temporaryPath, outputPath)
    const isolatedAudioSha256 = createHash('sha256').update(bytes).digest('hex')
    const evidence = {
      sourceSha256: input.sourceSha256,
      isolatedAudioSha256,
      isolatedAudioByteSize: bytes.byteLength,
      providerRequestId: requestId,
      offer: input.expectedOffer,
    }
    await writeFile(temporaryEvidencePath, stableSerialize(evidence), { flag: 'wx' })
    await rename(temporaryEvidencePath, evidencePath)
    await rm(submissionPath, { force: true })
    return Object.freeze({
      isolatedAudioPath: outputPath,
      isolatedAudioSha256,
      isolatedAudioByteSize: bytes.byteLength,
      providerRequestId: requestId,
      offer: input.expectedOffer,
    })
  }
}

export function createElevenLabsVoiceIsolationProviderFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ElevenLabsVoiceIsolationProvider | undefined {
  const apiKey = environment.APOLLO_V2_ELEVENLABS_API_KEY?.trim()
  if (!apiKey) return undefined
  const workRoot = environment.APOLLO_V2_SOURCE_CLEANUP_WORK_ROOT?.trim() ||
    environment.APOLLO_V2_RENDER_OUTPUT_ROOT?.trim()
  assertDomain(
    Boolean(workRoot),
    'PERSISTENCE_NOT_CONFIGURED',
    'Source cleanup work storage is not configured',
  )
  return new ElevenLabsVoiceIsolationProvider({
    apiKey,
    workRoot: workRoot!,
    ...(environment.APOLLO_V2_ELEVENLABS_BASE_URL?.trim()
      ? { baseUrl: environment.APOLLO_V2_ELEVENLABS_BASE_URL.trim() }
      : {}),
    ...(environment.APOLLO_V2_VOICE_ISOLATION_TIMEOUT_MS
      ? { requestTimeoutMs: Number(environment.APOLLO_V2_VOICE_ISOLATION_TIMEOUT_MS) }
      : {}),
    ...(environment.APOLLO_V2_VOICE_ISOLATION_MIN_DURATION_MS
      ? { minDurationMs: Number(environment.APOLLO_V2_VOICE_ISOLATION_MIN_DURATION_MS) }
      : {}),
    ...(environment.APOLLO_V2_VOICE_ISOLATION_NORMALIZED_COST
      ? { normalizedCost: Number(environment.APOLLO_V2_VOICE_ISOLATION_NORMALIZED_COST) }
      : {}),
  })
}
