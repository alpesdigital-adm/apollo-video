import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'

export interface TranscriptWord {
  word: string
  start: number
  end: number
}

export interface TranscriptSegment {
  id: number
  start: number
  end: number
  text: string
  confidence?: number
}

/**
 * Where the language of a transcript comes from (ADR-160): `detected-from-media` - the provider was asked without a language and reported the one
 * it heard; `declared-not-verified` - the provider was told the language (the project's) and transcribed under it, so the speech was not checked
 * against it. A transcript with neither mark (made before it existed) is read as declared and not verified.
 */
export type TranscriptLanguageBasis = 'detected-from-media' | 'declared-not-verified'
export const TRANSCRIPT_LANGUAGE_BASES: readonly TranscriptLanguageBasis[] = Object.freeze(['detected-from-media', 'declared-not-verified'] as const)

export interface MediaTranscript {
  schemaVersion: 'media-transcript/v1'
  language: string
  /** Absent on a transcript made before the basis was recorded. */
  languageBasis?: TranscriptLanguageBasis
  text: string
  words: readonly TranscriptWord[]
  segments: readonly TranscriptSegment[]
  provider: string
  model: string
  transcriptHash: string
}

const TOKEN = /^[a-z0-9][a-z0-9._/-]{0,127}$/

export function createMediaTranscript(input: Omit<MediaTranscript, 'schemaVersion' | 'transcriptHash'>): Readonly<MediaTranscript> {
  const language = Intl.getCanonicalLocales(input.language.trim())[0]
  assertDomain(Boolean(language), 'INVALID_ARGUMENT', 'Transcript language is invalid')
  assertDomain(input.languageBasis === undefined || TRANSCRIPT_LANGUAGE_BASES.includes(input.languageBasis), 'INVALID_ARGUMENT', 'Transcript language basis is invalid')
  const text = input.text.trim()
  assertDomain(text.length > 0 && text.length <= 2_000_000, 'INVALID_ARGUMENT', 'Transcript text is invalid')
  assertDomain(TOKEN.test(input.provider) && TOKEN.test(input.model), 'INVALID_ARGUMENT', 'Transcript provider identity is invalid')
  assertDomain(input.words.length <= 500_000 && input.segments.length <= 100_000, 'INVALID_ARGUMENT', 'Transcript alignment is too large')
  let previousWordStart = 0
  const words = input.words.map((word) => {
    const normalized = word.word.trim()
    // Speech providers may legitimately overlap adjacent word intervals. Timeline
    // ordering is defined by start time; rejecting overlap discards valid alignment.
    assertDomain(normalized.length > 0 && normalized.length <= 240 && Number.isFinite(word.start) && Number.isFinite(word.end) && word.start >= 0 && word.end >= word.start && word.start + 0.05 >= previousWordStart, 'INVALID_ARGUMENT', 'Transcript word alignment is invalid')
    previousWordStart = word.start
    return Object.freeze({ word: normalized, start: word.start, end: word.end })
  })
  let previousSegmentStart = 0
  const segments = input.segments.map((segment, index) => {
    const segmentText = segment.text.trim()
    assertDomain(Number.isInteger(segment.id) && segment.id >= 0 && segmentText.length > 0 && segmentText.length <= 10_000 && Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.start >= 0 && segment.end >= segment.start && segment.start + 0.05 >= previousSegmentStart, 'INVALID_ARGUMENT', 'Transcript segment alignment is invalid')
    assertDomain(index === 0 || segment.id > input.segments[index - 1]!.id, 'INVALID_ARGUMENT', 'Transcript segment IDs must increase')
    if (segment.confidence !== undefined) assertDomain(Number.isFinite(segment.confidence) && segment.confidence >= 0 && segment.confidence <= 1, 'INVALID_ARGUMENT', 'Transcript confidence is invalid')
    previousSegmentStart = segment.start
    return Object.freeze({ id: segment.id, start: segment.start, end: segment.end, text: segmentText, ...(segment.confidence !== undefined ? { confidence: segment.confidence } : {}) })
  })
  const body = {
    schemaVersion: 'media-transcript/v1' as const,
    language,
    ...(input.languageBasis !== undefined ? { languageBasis: input.languageBasis } : {}),
    text,
    words: Object.freeze(words),
    segments: Object.freeze(segments),
    provider: input.provider,
    model: input.model,
  }
  return Object.freeze({ ...body, transcriptHash: calculateCanonicalHash(body) })
}
