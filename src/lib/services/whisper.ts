/**
 * Speech-to-text service.
 *
 * Default strategy:
 * 1. In auto mode, use Groq Whisper when GROQ_API_KEY is present because it
 *    returns usable word/segment timestamps for subtitles and auto-cuts.
 * 2. Fallback to OpenAI when configured or when Groq is unavailable.
 */

import OpenAI from 'openai'
import * as fs from 'fs'
import path from 'path'
import type { Transcription, TranscriptionSegment, TranscriptionWord } from '../types/project'

type TranscriptionProvider = 'groq' | 'openai'
type TranscriptionProviderPreference = 'auto' | TranscriptionProvider

function readEnvFileValue(filePath: string, key: string): string | null {
  if (!fs.existsSync(filePath)) {
    return null
  }

  const content = fs.readFileSync(filePath, 'utf8')
  const line = content
    .split(/\r?\n/)
    .find((entry) => entry.trim().startsWith(`${key}=`))

  if (!line) {
    return null
  }

  return line
    .slice(line.indexOf('=') + 1)
    .trim()
    .replace(/^['"]|['"]$/g, '')
}

function getEnvValue(key: string): string | null {
  return (
    readEnvFileValue(path.join(process.cwd(), '.env.local'), key) ||
    readEnvFileValue(path.join(process.cwd(), '.env'), key) ||
    process.env[key] ||
    null
  )
}

function getOpenAIApiKey(): string | null {
  return getEnvValue('OPENAI_API_KEY')
}

function getGroqApiKey(): string | null {
  return getEnvValue('GROQ_API_KEY')
}

function createOpenAIClient(): OpenAI {
  const apiKey = getOpenAIApiKey()
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is missing')
  }

  return new OpenAI({ apiKey })
}

function getErrorStatus(error: unknown): number | undefined {
  const status = (error as any)?.status
  return typeof status === 'number' ? status : undefined
}

function getProviderErrorCode(error: unknown): string {
  return String(
    (error as any)?.code ||
      (error as any)?.error?.code ||
      (error as any)?.response?.data?.error?.code ||
      ''
  )
}

function getProviderErrorType(error: unknown): string {
  return String(
    (error as any)?.type ||
      (error as any)?.error?.type ||
      (error as any)?.response?.data?.error?.type ||
      ''
  )
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isQuotaOrBillingError(error: unknown): boolean {
  const status = getErrorStatus(error)
  const code = getProviderErrorCode(error).toLowerCase()
  const type = getProviderErrorType(error).toLowerCase()
  const message = getErrorMessage(error).toLowerCase()

  return (
    status === 429 ||
    code.includes('quota') ||
    type.includes('quota') ||
    message.includes('quota') ||
    message.includes('billing') ||
    message.includes('hard limit')
  )
}

function isAuthOrConfigError(error: unknown): boolean {
  const status = getErrorStatus(error)
  const message = getErrorMessage(error).toLowerCase()
  return status === 401 || status === 403 || message.includes('api key') || message.includes('unauthorized')
}

function createProviderRequestError(status: number, payload: any, fallbackMessage: string): Error {
  const providerError = payload?.error || payload
  const message = providerError?.message || fallbackMessage
  return Object.assign(new Error(message), {
    status,
    code: providerError?.code,
    type: providerError?.type
  })
}

function formatTranscriptionProviderError(
  provider: TranscriptionProvider,
  model: string,
  error: unknown
): string {
  const status = getErrorStatus(error)
  const code = getProviderErrorCode(error)
  const message = getErrorMessage(error)
  const statusPart = status ? `HTTP ${status}` : 'request failed'
  const codePart = code ? `, code ${code}` : ''
  const label = provider === 'groq' ? 'Groq' : 'OpenAI'

  if (isQuotaOrBillingError(error)) {
    return `${label} transcription quota/rate/billing error on ${model} (${statusPart}${codePart}): ${message}`
  }

  if (isAuthOrConfigError(error)) {
    return `${label} transcription auth/config error on ${model} (${statusPart}${codePart}): ${message}`
  }

  return `${label} transcription failed on ${model} (${statusPart}${codePart}): ${message}`
}

function getAudioMimeType(audioPath: string): string {
  const extension = path.extname(audioPath).toLowerCase()

  if (extension === '.flac') {
    return 'audio/flac'
  }

  if (extension === '.mp3') {
    return 'audio/mpeg'
  }

  if (extension === '.m4a') {
    return 'audio/mp4'
  }

  return 'audio/wav'
}

function getGroqTranscribeModel(): string {
  return getEnvValue('GROQ_TRANSCRIBE_MODEL') || 'whisper-large-v3'
}

function createAudioFile(audioPath: string): File {
  const audioBuffer = fs.readFileSync(audioPath)
  return new File([audioBuffer], path.basename(audioPath), {
    type: getAudioMimeType(audioPath)
  })
}

function normalizeWords(words: any[]): TranscriptionWord[] {
  return words
    .map((word: any) => ({
      word: String(word.word || word.text || '').trim(),
      start: Number(word.start ?? 0),
      end: Number(word.end ?? word.start ?? 0)
    }))
    .filter((word: TranscriptionWord) => (
      word.word &&
      Number.isFinite(word.start) &&
      Number.isFinite(word.end) &&
      word.end >= word.start
    ))
}

function textFromWords(words: TranscriptionWord[]): string {
  return words.map((word) => word.word).join(' ').replace(/\s+([,.!?;:])/g, '$1').trim()
}

function buildSegmentsFromWords(words: TranscriptionWord[], fallbackText: string): TranscriptionSegment[] {
  if (words.length === 0) {
    return []
  }

  const segments: TranscriptionSegment[] = []
  let current: TranscriptionWord[] = []

  for (const word of words) {
    current.push(word)
    const first = current[0]
    const elapsed = word.end - first.start
    const text = textFromWords(current)
    const hasSentenceEnd = /[.!?]$/.test(text)
    const isLongEnough = elapsed >= 4 && current.length >= 8
    const isTooLong = elapsed >= 7 || current.length >= 18 || text.length >= 110

    if ((hasSentenceEnd && isLongEnough) || isTooLong) {
      segments.push({
        id: segments.length,
        start: first.start,
        end: word.end,
        text,
        words: current
      })
      current = []
    }
  }

  if (current.length > 0) {
    segments.push({
      id: segments.length,
      start: current[0].start,
      end: current[current.length - 1].end,
      text: textFromWords(current) || fallbackText,
      words: current
    })
  }

  return segments
}

function normalizeSegments(response: any, fallbackText: string): TranscriptionSegment[] {
  const rawSegments = Array.isArray(response?.segments) ? response.segments : []
  const topLevelWords: TranscriptionWord[] = Array.isArray(response?.words)
    ? normalizeWords(response.words)
    : []

  if (rawSegments.length > 0) {
    return rawSegments.map((segment: any, index: number) => {
      const segmentStart = Number(segment.start ?? 0)
      const segmentEnd = Number(segment.end ?? segmentStart)
      const words: TranscriptionWord[] = Array.isArray(segment.words) && segment.words.length > 0
        ? normalizeWords(segment.words)
        : topLevelWords.filter((word) => (
            word.start >= segmentStart - 0.2 &&
            word.end <= segmentEnd + 0.2
          ))
      const segmentText = String(segment.text || '').trim() || textFromWords(words)
      const start = words[0]?.start ?? segmentStart
      const end = words[words.length - 1]?.end ?? segmentEnd

      return {
        id: index,
        start,
        end,
        text: segmentText,
        words
      }
    })
  }

  if (topLevelWords.length > 0) {
    return buildSegmentsFromWords(topLevelWords, String(response?.text || fallbackText || '').trim())
  }

  const text = String(response?.text || fallbackText || '').trim()
  if (!text) {
    return []
  }

  const parts = text
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean)

  return parts.map((part, index) => ({
    id: index,
    start: index * 4,
    end: (index + 1) * 4,
    text: part,
    words: []
  }))
}

async function transcribeWithModernOpenAI(
  audioPath: string,
  model: string
): Promise<{ transcription: Transcription; hasNativeSegments: boolean }> {
  const apiKey = getOpenAIApiKey()
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is missing')
  }

  const formData = new FormData()
  formData.append('file', createAudioFile(audioPath))
  formData.append('model', model)
  formData.append('response_format', 'json')

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: formData
  })

  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw createProviderRequestError(
      response.status,
      payload,
      `OpenAI transcription request failed (${response.status})`
    )
  }

  const hasNativeSegments = Array.isArray(payload?.segments) && payload.segments.length > 0

  return {
    transcription: {
      text: String(payload?.text || ''),
      language: String(payload?.language || 'unknown'),
      segments: normalizeSegments(payload, payload?.text || '')
    },
    hasNativeSegments
  }
}

async function transcribeWithWhisperTimestamps(audioPath: string): Promise<Transcription> {
  const response = await createOpenAIClient().audio.transcriptions.create({
    file: createAudioFile(audioPath),
    model: 'whisper-1',
    response_format: 'verbose_json',
    timestamp_granularities: ['word', 'segment']
  })

  const verboseResponse = response as any
  return {
    text: verboseResponse.text || '',
    language: verboseResponse.language || 'unknown',
    segments: normalizeSegments(verboseResponse, verboseResponse.text || '')
  }
}

async function transcribeWithOpenAI(audioPath: string): Promise<Transcription> {
  const preferredModel = getEnvValue('OPENAI_TRANSCRIBE_MODEL') || 'gpt-4o-transcribe'

  if (preferredModel !== 'whisper-1') {
    try {
      const result = await transcribeWithModernOpenAI(audioPath, preferredModel)
      if (result.transcription.text.trim() && result.hasNativeSegments) {
        return result.transcription
      }

      if (result.transcription.text.trim()) {
        const timestamped = await transcribeWithWhisperTimestamps(audioPath)
        return {
          text: result.transcription.text,
          language: result.transcription.language || timestamped.language,
          segments: timestamped.segments
        }
      }
    } catch (error) {
      if (isQuotaOrBillingError(error)) {
        throw new Error(formatTranscriptionProviderError('openai', preferredModel, error))
      }

      console.warn(
        `Modern OpenAI transcription model failed, retrying whisper-1: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  try {
    return await transcribeWithWhisperTimestamps(audioPath)
  } catch (error) {
    throw new Error(formatTranscriptionProviderError('openai', 'whisper-1', error))
  }
}

async function transcribeWithGroq(audioPath: string): Promise<Transcription> {
  const apiKey = getGroqApiKey()
  if (!apiKey) {
    throw new Error('GROQ_API_KEY is missing')
  }

  const model = getGroqTranscribeModel()
  const baseUrl = (getEnvValue('GROQ_BASE_URL') || 'https://api.groq.com/openai/v1').replace(/\/+$/, '')
  const formData = new FormData()
  formData.append('file', createAudioFile(audioPath))
  formData.append('model', model)
  formData.append('language', getEnvValue('TRANSCRIBE_LANGUAGE') || 'pt')
  formData.append('temperature', '0')
  formData.append('response_format', 'verbose_json')
  formData.append('timestamp_granularities[]', 'word')
  formData.append('timestamp_granularities[]', 'segment')

  const response = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: formData
  })

  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw createProviderRequestError(
      response.status,
      payload,
      `Groq transcription request failed (${response.status})`
    )
  }

  const text = String(payload?.text || '')
  return {
    text,
    language: String(payload?.language || getEnvValue('TRANSCRIBE_LANGUAGE') || 'unknown'),
    segments: normalizeSegments(payload, text)
  }
}

function getProviderPreference(): TranscriptionProviderPreference {
  const raw = String(getEnvValue('TRANSCRIBE_PROVIDER') || 'auto').toLowerCase()

  if (raw === 'groq' || raw === 'openai') {
    return raw
  }

  return 'auto'
}

function getProviderOrder(): TranscriptionProvider[] {
  const preference = getProviderPreference()

  if (preference === 'groq' || preference === 'openai') {
    return [preference]
  }

  const providers: TranscriptionProvider[] = []
  if (getGroqApiKey()) {
    providers.push('groq')
  }

  if (getOpenAIApiKey()) {
    providers.push('openai')
  }

  return providers
}

export function getPreferredTranscriptionAudioExtension(): 'flac' | 'wav' {
  return getGroqApiKey() ? 'flac' : 'wav'
}

export async function transcribeAudio(audioPath: string): Promise<Transcription> {
  try {
    if (!fs.existsSync(audioPath)) {
      throw new Error(`Audio file not found: ${audioPath}`)
    }

    const providers = getProviderOrder()
    if (providers.length === 0) {
      throw new Error('No transcription provider configured. Add GROQ_API_KEY or OPENAI_API_KEY.')
    }

    const errors: string[] = []
    for (const provider of providers) {
      try {
        const transcription = provider === 'groq'
          ? await transcribeWithGroq(audioPath)
          : await transcribeWithOpenAI(audioPath)

        if (!transcription.text.trim()) {
          throw new Error(`${provider} returned an empty transcription`)
        }

        return transcription
      } catch (error) {
        const message = provider === 'groq'
          ? formatTranscriptionProviderError('groq', getGroqTranscribeModel(), error)
          : error instanceof Error
            ? error.message
            : String(error)
        errors.push(message)

        if (getProviderPreference() !== 'auto' || isAuthOrConfigError(error)) {
          throw new Error(message)
        }

        console.warn(
          `${provider} transcription failed, trying next provider if available: ${message}`
        )
      }
    }

    throw new Error(errors.join(' | ') || 'All transcription providers failed')
  } catch (error) {
    throw new Error(`Transcription failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
