import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

import type { MediaTranscriber } from '../../application/ports/media-ingest.ts'
import { DomainError } from '../../domain/errors.ts'
import { createMediaTranscript } from '../../domain/media-transcript.ts'

interface GroqVerboseTranscript {
  text?: unknown
  language?: unknown
  words?: unknown
  segments?: unknown
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export class GroqMediaTranscriber implements MediaTranscriber {
  private readonly options: { apiKey: string; model: string; fetchImplementation?: typeof fetch }

  constructor(options: { apiKey: string; model: string; fetchImplementation?: typeof fetch }) {
    if (options.apiKey.trim().length < 20) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Groq transcription credential is not configured')
    if (!/^[a-z0-9][a-z0-9._/-]{0,127}$/.test(options.model)) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Groq transcription model is invalid')
    this.options = options
  }

  async transcribe(input: { audioPath: string; language: string; signal?: AbortSignal }) {
    const bytes = await readFile(input.audioPath)
    if (bytes.length <= 0 || bytes.length > 100 * 1024 * 1024) throw new DomainError('INVALID_ARGUMENT', 'Transcription audio must contain at most 100 MB')
    const form = new FormData()
    form.append('file', new Blob([bytes], { type: 'audio/flac' }), basename(input.audioPath))
    form.append('model', this.options.model)
    form.append('response_format', 'verbose_json')
    form.append('timestamp_granularities[]', 'word')
    form.append('timestamp_granularities[]', 'segment')
    form.append('temperature', '0')
    form.append('language', input.language.split('-')[0]!.toLowerCase())
    const response = await (this.options.fetchImplementation ?? fetch)('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.options.apiKey}` },
      body: form,
      signal: input.signal ?? AbortSignal.timeout(5 * 60_000),
    })
    if (!response.ok) throw new DomainError('RENDER_EXECUTION_FAILED', 'Speech transcription provider rejected the media')
    const payload = await response.json() as GroqVerboseTranscript
    if (typeof payload.text !== 'string' || !Array.isArray(payload.words) || !Array.isArray(payload.segments)) {
      throw new DomainError('RENDER_OUTPUT_INVALID', 'Speech transcription response is incomplete')
    }
    let previousWordStart = 0
    const words = payload.words.map((value) => {
      const word = value as Record<string, unknown>
      const providerStart = finiteNumber(word.start)
      const providerEnd = finiteNumber(word.end)
      const start = providerStart === undefined || providerStart < 0 ? -1 : Math.max(providerStart, previousWordStart)
      const end = providerEnd === undefined || providerEnd < 0 ? -1 : Math.max(providerEnd, start)
      if (start >= 0) previousWordStart = start
      return { word: typeof word.word === 'string' ? word.word : '', start, end }
    })
    let previousSegmentStart = 0
    const segments = payload.segments.map((value, index) => {
      const segment = value as Record<string, unknown>
      const averageLogProbability = finiteNumber(segment.avg_logprob)
      const confidence = averageLogProbability === undefined ? undefined : Math.max(0, Math.min(1, Math.exp(averageLogProbability)))
      const providerStart = finiteNumber(segment.start)
      const providerEnd = finiteNumber(segment.end)
      const start = providerStart === undefined || providerStart < 0 ? -1 : Math.max(providerStart, previousSegmentStart)
      const end = providerEnd === undefined || providerEnd < 0 ? -1 : Math.max(providerEnd, start)
      if (start >= 0) previousSegmentStart = start
      return {
        id: Number.isInteger(segment.id) ? segment.id as number : index,
        text: typeof segment.text === 'string' ? segment.text : '',
        start,
        end,
        ...(confidence !== undefined ? { confidence } : {}),
      }
    })
    return createMediaTranscript({
      language: input.language,
      text: payload.text,
      words,
      segments,
      provider: 'groq',
      model: this.options.model,
    })
  }
}

export function createMediaTranscriberFromEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const provider = (environment.TRANSCRIBE_PROVIDER ?? 'groq').trim().toLowerCase()
  if (provider !== 'groq') throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Configured transcription provider is not supported by the V2 ingest worker')
  return new GroqMediaTranscriber({
    apiKey: environment.GROQ_API_KEY ?? '',
    model: environment.GROQ_TRANSCRIBE_MODEL?.trim() || 'whisper-large-v3-turbo',
  })
}
