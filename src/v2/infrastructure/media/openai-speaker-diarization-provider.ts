import { readFile } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'

import type {
  SpeakerDiarizationProvider,
} from '../../application/ports/speaker-diarization-provider.ts'
import { DomainError } from '../../domain/errors.ts'

interface OpenAiDiarizedResponse {
  task?: unknown
  duration?: unknown
  text?: unknown
  segments?: unknown
  usage?: unknown
}

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.flac': 'audio/flac',
  '.mp3': 'audio/mpeg',
  '.mp4': 'audio/mp4',
  '.mpeg': 'audio/mpeg',
  '.mpga': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
})

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined
}

function providerFailure(responseStatus?: number): DomainError {
  return new DomainError(
    'RENDER_EXECUTION_FAILED',
    responseStatus === 429 || responseStatus === 408 ||
      (responseStatus !== undefined && responseStatus >= 500)
      ? 'Speaker diarization provider is temporarily unavailable'
      : 'Speaker diarization provider rejected the request',
  )
}

export class OpenAiSpeakerDiarizationProvider
implements SpeakerDiarizationProvider {
  private readonly options: {
    apiKey: string
    model: 'gpt-4o-transcribe-diarize'
    timeoutMs: number
    maximumFileBytes: number
    fetchImplementation?: typeof fetch
  }

  constructor(options: {
    apiKey: string
    model?: string
    timeoutMs?: number
    maximumFileBytes?: number
    fetchImplementation?: typeof fetch
  }) {
    const apiKey = options.apiKey.trim()
    const model =
      options.model?.trim() || 'gpt-4o-transcribe-diarize'
    const timeoutMs = options.timeoutMs ?? 30 * 60_000
    const maximumFileBytes =
      options.maximumFileBytes ?? 100 * 1024 * 1024
    if (
      apiKey.length < 20 ||
      model !== 'gpt-4o-transcribe-diarize' ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1_000 ||
      timeoutMs > 60 * 60_000 ||
      !Number.isSafeInteger(maximumFileBytes) ||
      maximumFileBytes < 1_024 ||
      maximumFileBytes > 512 * 1024 * 1024
    ) {
      throw new DomainError(
        'PERSISTENCE_NOT_CONFIGURED',
        'OpenAI speaker diarization configuration is invalid',
      )
    }
    this.options = {
      apiKey,
      model,
      timeoutMs,
      maximumFileBytes,
      ...(options.fetchImplementation
        ? { fetchImplementation: options.fetchImplementation }
        : {}),
    }
  }

  async diarize(input: {
    audioPath: string
    language: string
    expectedDurationMs: number
    signal: AbortSignal
  }) {
    if (
      !isAbsolute(input.audioPath) ||
      !Number.isSafeInteger(input.expectedDurationMs) ||
      input.expectedDurationMs < 1_000 ||
      input.expectedDurationMs > 43_200_000
    ) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Speaker diarization audio input is invalid',
      )
    }
    let locale: string | undefined
    try {
      locale = Intl.getCanonicalLocales(input.language.trim())[0]
    } catch {
      locale = undefined
    }
    if (!locale) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Speaker diarization language is invalid',
      )
    }
    const extension = extname(input.audioPath).toLowerCase()
    const contentType = CONTENT_TYPES[extension]
    if (!contentType) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Speaker diarization audio format is unsupported',
      )
    }
    let bytes: Buffer
    try {
      bytes = await readFile(input.audioPath)
    } catch {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Speaker diarization audio could not be read',
      )
    }
    if (
      bytes.length < 1 ||
      bytes.length > this.options.maximumFileBytes
    ) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Speaker diarization audio exceeds the configured request size',
      )
    }
    const form = new FormData()
    form.append(
      'file',
      new Blob([Uint8Array.from(bytes)], { type: contentType }),
      basename(input.audioPath),
    )
    form.append('model', this.options.model)
    form.append('response_format', 'diarized_json')
    form.append('chunking_strategy', 'auto')
    form.append('language', locale.split('-')[0]!.toLowerCase())
    let response: Response
    try {
      response = await (
        this.options.fetchImplementation ?? fetch
      )('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: form,
        signal: AbortSignal.any([
          input.signal,
          AbortSignal.timeout(this.options.timeoutMs),
        ]),
      })
    } catch {
      throw providerFailure()
    }
    if (!response.ok) throw providerFailure(response.status)
    let payload: OpenAiDiarizedResponse
    try {
      payload = await response.json() as OpenAiDiarizedResponse
    } catch {
      throw new DomainError(
        'RENDER_OUTPUT_INVALID',
        'Speaker diarization response is not valid JSON',
      )
    }
    const durationSeconds = finiteNumber(payload.duration)
    const usage = (
      typeof payload.usage === 'object' &&
      payload.usage !== null &&
      !Array.isArray(payload.usage)
    )
      ? payload.usage as Record<string, unknown>
      : undefined
    const usageSeconds = finiteNumber(usage?.seconds)
    if (
      payload.task !== 'transcribe' ||
      typeof payload.text !== 'string' ||
      !Array.isArray(payload.segments) ||
      !durationSeconds ||
      durationSeconds <= 0 ||
      usage?.type !== 'duration' ||
      !usageSeconds ||
      usageSeconds <= 0 ||
      Math.abs(durationSeconds * 1_000 -
        input.expectedDurationMs) > 3_000
    ) {
      throw new DomainError(
        'RENDER_OUTPUT_INVALID',
        'Speaker diarization response is incomplete or misaligned',
      )
    }
    let previousStartMs = 0
    const providerIds = new Set<string>()
    const segments = payload.segments.map((raw, ordinal) => {
      if (
        typeof raw !== 'object' ||
        raw === null ||
        Array.isArray(raw)
      ) {
        throw new DomainError(
          'RENDER_OUTPUT_INVALID',
          'Speaker diarization segment is invalid',
        )
      }
      const segment = raw as Record<string, unknown>
      const providerSegmentId =
        typeof segment.id === 'string' ? segment.id.trim() : ''
      const providerLabel =
        typeof segment.speaker === 'string'
          ? segment.speaker.trim()
          : ''
      const text =
        typeof segment.text === 'string'
          ? segment.text.trim().replace(/\s+/gu, ' ')
          : ''
      const start = finiteNumber(segment.start)
      const end = finiteNumber(segment.end)
      const startMs = start === undefined
        ? -1
        : Math.round(start * 1_000)
      const endMs = end === undefined
        ? -1
        : Math.min(
            input.expectedDurationMs,
            Math.round(end * 1_000),
          )
      if (
        segment.type !== 'transcript.text.segment' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/.test(
          providerSegmentId,
        ) ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(
          providerLabel,
        ) ||
        text.length < 1 ||
        text.length > 10_000 ||
        startMs < 0 ||
        endMs <= startMs ||
        endMs > input.expectedDurationMs ||
        (ordinal > 0 && startMs < previousStartMs) ||
        providerIds.has(providerSegmentId)
      ) {
        throw new DomainError(
          'RENDER_OUTPUT_INVALID',
          'Speaker diarization segment evidence is invalid',
        )
      }
      previousStartMs = startMs
      providerIds.add(providerSegmentId)
      return Object.freeze({
        providerSegmentId,
        providerLabel,
        startMs,
        endMs,
        text,
      })
    })
    if (segments.length < 1 || segments.length > 100_000) {
      throw new DomainError(
        'RENDER_OUTPUT_INVALID',
        'Speaker diarization returned no usable segments',
      )
    }
    return Object.freeze({
      provider: Object.freeze({
        id: 'openai',
        model: this.options.model,
        version: 'diarized-json/v1',
      }),
      segments: Object.freeze(segments),
      usageSeconds: Math.max(1, Math.ceil(usageSeconds)),
    })
  }
}

export function createOpenAiSpeakerDiarizationProviderFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const timeoutMs = Number(
    environment.OPENAI_DIARIZATION_TIMEOUT_MS,
  )
  const maximumFileBytes = Number(
    environment.OPENAI_DIARIZATION_MAX_FILE_BYTES,
  )
  return new OpenAiSpeakerDiarizationProvider({
    apiKey: environment.OPENAI_API_KEY ?? '',
    model:
      environment.OPENAI_DIARIZATION_MODEL?.trim() ||
      'gpt-4o-transcribe-diarize',
    ...(Number.isSafeInteger(timeoutMs) && timeoutMs > 0
      ? { timeoutMs }
      : {}),
    ...(Number.isSafeInteger(maximumFileBytes) &&
      maximumFileBytes > 0
      ? { maximumFileBytes }
      : {}),
  })
}
