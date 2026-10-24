import { createHash } from 'node:crypto'

import { DomainError } from '../domain/errors.ts'
import type { SpeechRemovalPassage, SpeechRemovalSearch, SpeechRemovalSegmentLine } from '../domain/editorial-policy-resolution.ts'
import type { SpeechRemovalConfirmedPassage } from '../domain/editorial-cut-impact.ts'
import type { TranscriptSegment, TranscriptWord } from '../domain/media-transcript.ts'

/**
 * A subject is spoken in a PASSAGE, not in a word (ADR-160): the sentences that mention it, and the ones between them, are one stretch of speech, and cutting
 * only the sentences that say the word leaves a talk in pieces. This module groups the mentions of a subject into passages, deterministically and without a
 * model, and applies the adjustments a person makes to a passage before confirming it.
 *
 * The grouping parameters are TECHNICAL parameters of the search, not editorial values: they are named, versioned, written into the proposal and into the
 * confirmation with their origin, and the person confirming can move the start and the end of every passage.
 */
export const SPEECH_PASSAGE_POLICY: SpeechRemovalSearch['policy'] = Object.freeze({
  name: 'speech-passage-adjacency/v1',
  /** Two mentions belong to the same passage when no more than this many seconds of speech separate their sentences... */
  maxGapSeconds: 15,
  /** ...AND no more than this many whole sentences stand between them. */
  maxGapSentences: 3,
  /** A run of segments without a sentence mark is closed after this long: a transcript that forgot its punctuation does not make one endless sentence. */
  maxSentenceSeconds: 30,
  origin: 'technical-search-parameter',
})

/** Segments of context shown before and after a passage, to move its start or end by. */
const CONTEXT_SEGMENTS = 3
/** Times of a transcript are compared to this tolerance (one millisecond): the one the editorial cut uses to place a word inside a range. */
const EPSILON = 0.001
const TERMINAL = /[.!?…。！？]["'”’)\]»]*$/u

export interface SpeechMention {
  startSeconds: number
  endSeconds: number
  text: string
}

interface Unit {
  start: number
  end: number
}

function endsSentence(text: string): boolean {
  return TERMINAL.test(text.trim())
}

/** The sentences of a transcript, as stretches of time: runs of segments closed by a sentence mark; or, with no segments, runs of words closed by one. */
function sentenceUnits(words: readonly TranscriptWord[], segments: readonly TranscriptSegment[], policy: SpeechRemovalSearch['policy']): { units: Unit[]; boundary: SpeechRemovalPassage['boundary'] } {
  if (segments.length > 0) {
    if (!segments.some((segment) => endsSentence(segment.text))) {
      return { units: segments.map((segment) => ({ start: segment.start, end: segment.end })), boundary: 'segment' }
    }
    const units: Unit[] = []
    let open: Unit | null = null
    for (const segment of segments) {
      open = open === null ? { start: segment.start, end: segment.end } : { start: open.start, end: Math.max(open.end, segment.end) }
      if (endsSentence(segment.text) || open.end - open.start > policy.maxSentenceSeconds) {
        units.push(open)
        open = null
      }
    }
    if (open !== null) units.push(open)
    return { units, boundary: 'sentence' }
  }
  if (words.some((word) => endsSentence(word.word))) {
    const units: Unit[] = []
    let open: Unit | null = null
    for (const word of words) {
      open = open === null ? { start: word.start, end: word.end } : { start: open.start, end: Math.max(open.end, word.end) }
      if (endsSentence(word.word) || open.end - open.start > policy.maxSentenceSeconds) {
        units.push(open)
        open = null
      }
    }
    if (open !== null) units.push(open)
    return { units, boundary: 'sentence' }
  }
  return { units: [], boundary: 'word' }
}

function textOfRange(words: readonly TranscriptWord[], segments: readonly TranscriptSegment[], start: number, end: number): string {
  const inside = segments.filter((segment) => segment.start >= start - EPSILON && segment.end <= end + EPSILON)
  if (inside.length > 0) return inside.map((segment) => segment.text.trim()).join(' ')
  return words.filter((word) => word.start >= start - EPSILON && word.end <= end + EPSILON).map((word) => word.word.trim()).join(' ')
}

function passageId(ruleId: string, start: number, end: number): string {
  return `passage-${createHash('sha256').update(`${ruleId}|${start}|${end}`, 'utf8').digest('hex').slice(0, 10)}`
}

/** The first and the last instant of speech of a transcript: a passage never goes beyond them. */
function speechSpan(words: readonly TranscriptWord[], segments: readonly TranscriptSegment[]): { start: number; end: number } {
  // (A loop, not Math.min(...all): a transcript may hold hundreds of thousands of words.)
  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY
  for (const word of words) { start = Math.min(start, word.start); end = Math.max(end, word.end) }
  for (const segment of segments) { start = Math.min(start, segment.start); end = Math.max(end, segment.end) }
  return { start: Number.isFinite(start) ? start : 0, end: Number.isFinite(end) ? end : 0 }
}

/**
 * The passages the mentions of a subject are spoken in: each mention is placed in its sentence; sentences whose gap (in seconds AND in whole sentences between
 * them) is within the policy are one passage, with every sentence between; the passage is a block from the first instant of its first sentence to the last of
 * its last. A mention in no sentence of the transcript is a passage of its own word.
 */
export function groupSpeechPassages(input: Readonly<{
  ruleId: string
  words: readonly TranscriptWord[]
  segments: readonly TranscriptSegment[]
  mentions: readonly Readonly<SpeechMention>[]
  policy?: SpeechRemovalSearch['policy']
}>): readonly Readonly<SpeechRemovalPassage>[] {
  const policy = input.policy ?? SPEECH_PASSAGE_POLICY
  const segments = [...input.segments].sort((left, right) => left.start - right.start || left.end - right.end)
  const mentions = [...input.mentions].sort((left, right) => left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds)
  if (mentions.length === 0) return Object.freeze([])
  const base = sentenceUnits(input.words, segments, policy)
  const placeOf = (mention: Readonly<SpeechMention>) => {
    const middle = (mention.startSeconds + mention.endSeconds) / 2
    return base.units.findIndex((unit) => middle >= unit.start - EPSILON && middle <= unit.end + EPSILON)
  }
  // A mention that no sentence holds is a sentence of its own word, placed among the others by its time.
  const units = [...base.units]
  for (const mention of mentions) {
    if (placeOf(mention) < 0) units.push({ start: mention.startSeconds, end: mention.endSeconds })
  }
  units.sort((left, right) => left.start - right.start || left.end - right.end)
  const unitIndexOf = (mention: Readonly<SpeechMention>) => {
    const middle = (mention.startSeconds + mention.endSeconds) / 2
    return units.findIndex((unit) => middle >= unit.start - EPSILON && middle <= unit.end + EPSILON)
  }
  const placed = mentions.map((mention) => ({ mention, unit: unitIndexOf(mention) }))

  const groups: { first: number; last: number; mentions: SpeechMention[] }[] = []
  for (const { mention, unit } of placed) {
    const current = groups.at(-1)
    if (current !== undefined) {
      const sentencesBetween = Math.max(0, unit - current.last - 1)
      const secondsBetween = Math.max(0, units[unit]!.start - units[current.last]!.end)
      if (unit <= current.last || (sentencesBetween <= policy.maxGapSentences && secondsBetween <= policy.maxGapSeconds)) {
        current.last = Math.max(current.last, unit)
        current.mentions.push(mention)
        continue
      }
    }
    groups.push({ first: unit, last: unit, mentions: [mention] })
  }

  const span = speechSpan(input.words, segments)
  const bounds = groups.map((group) => ({ start: units[group.first]!.start, end: units[group.last]!.end }))
  return Object.freeze(groups.map((group, index) => {
    const { start, end } = bounds[index]!
    const overlapping = segments.flatMap((segment, position) => (segment.end > start + EPSILON && segment.start < end - EPSILON ? [position] : []))
    const firstSegment = Math.max(0, (overlapping[0] ?? 0) - CONTEXT_SEGMENTS)
    const lastSegment = Math.min(segments.length - 1, (overlapping.at(-1) ?? -1) + CONTEXT_SEGMENTS)
    const context: SpeechRemovalSegmentLine[] = []
    for (let position = firstSegment; position <= lastSegment; position += 1) {
      const segment = segments[position]!
      context.push(Object.freeze({
        id: segment.id, startSeconds: segment.start, endSeconds: segment.end, text: segment.text.trim(),
        inPassage: segment.end > start + EPSILON && segment.start < end - EPSILON,
      }))
    }
    return Object.freeze({
      id: passageId(input.ruleId, start, end),
      startSeconds: start,
      endSeconds: end,
      text: textOfRange(input.words, segments, start, end),
      mentions: Object.freeze(group.mentions.map((mention) => Object.freeze({ startSeconds: mention.startSeconds, endSeconds: mention.endSeconds, text: mention.text }))),
      limits: Object.freeze({ earliestStartSeconds: index === 0 ? Math.min(span.start, start) : bounds[index - 1]!.end, latestEndSeconds: index === groups.length - 1 ? Math.max(span.end, end) : bounds[index + 1]!.start }),
      segments: Object.freeze(context),
      boundary: base.boundary,
    })
  }))
}

/** What a person asks for a passage: where it starts and ends instead. */
export interface SpeechPassageAdjustment {
  passageId: string
  startSeconds: number
  endSeconds: number
}

function boundaryNear(candidates: readonly number[], seconds: number): number | undefined {
  let best: number | undefined
  for (const candidate of candidates) {
    if (Math.abs(candidate - seconds) <= EPSILON && (best === undefined || Math.abs(candidate - seconds) < Math.abs(best - seconds))) best = candidate
  }
  return best
}

/**
 * The passages as they are CONFIRMED: the proposed ones, with the start and end the person moved. An adjustment is accepted only when
 *  - it names a passage of this proposal (once), with a start before its end;
 *  - the start is the start of a word or of a segment of the transcript and the end is the end of one (the speech is never cut inside a word, and never
 *    beyond the speech);
 *  - it stays between the limits of the passage (not into the neighbouring passage);
 *  - it still holds every mention that anchors the passage.
 * Anything else is refused whole: the cut is exactly what the person confirmed or it is not made. A passage with no adjustment is the proposed one.
 */
export function confirmSpeechPassages(input: Readonly<{
  passages: readonly Readonly<SpeechRemovalPassage>[]
  words: readonly TranscriptWord[]
  segments: readonly TranscriptSegment[]
  adjustments?: readonly Readonly<SpeechPassageAdjustment>[]
}>): readonly Readonly<SpeechRemovalConfirmedPassage>[] {
  const adjustments = input.adjustments ?? []
  if (!Array.isArray(adjustments) || adjustments.length > input.passages.length) {
    throw new DomainError('INVALID_ARGUMENT', 'adjustments must name each passage of the proposal at most once')
  }
  const byId = new Map(input.passages.map((passage) => [passage.id, passage] as const))
  const adjusted = new Map<string, Readonly<SpeechPassageAdjustment>>()
  for (const adjustment of adjustments) {
    const valid = typeof adjustment === 'object' && adjustment !== null && typeof adjustment.passageId === 'string' &&
      typeof adjustment.startSeconds === 'number' && Number.isFinite(adjustment.startSeconds) && typeof adjustment.endSeconds === 'number' && Number.isFinite(adjustment.endSeconds)
    if (!valid) throw new DomainError('INVALID_ARGUMENT', 'An adjustment must carry passageId, startSeconds and endSeconds')
    if (!byId.has(adjustment.passageId)) throw new DomainError('INVALID_ARGUMENT', 'An adjustment names a passage that this proposal does not have', { passageId: adjustment.passageId })
    if (adjusted.has(adjustment.passageId)) throw new DomainError('INVALID_ARGUMENT', 'A passage is adjusted once', { passageId: adjustment.passageId })
    adjusted.set(adjustment.passageId, adjustment)
  }
  const starts = [...input.words.map((word) => word.start), ...input.segments.map((segment) => segment.start)]
  const ends = [...input.words.map((word) => word.end), ...input.segments.map((segment) => segment.end)]
  return Object.freeze(input.passages.map((passage) => {
    const adjustment = adjusted.get(passage.id)
    let start = passage.startSeconds
    let end = passage.endSeconds
    if (adjustment !== undefined) {
      const snappedStart = boundaryNear(starts, adjustment.startSeconds)
      const snappedEnd = boundaryNear(ends, adjustment.endSeconds)
      const refuse = (message: string) => new DomainError('INVALID_ARGUMENT', message, { passageId: passage.id })
      if (snappedStart === undefined) throw refuse('The start of a passage must be the start of a word or of a segment of the transcript')
      if (snappedEnd === undefined) throw refuse('The end of a passage must be the end of a word or of a segment of the transcript')
      if (snappedEnd <= snappedStart) throw refuse('A passage must end after it starts')
      if (snappedStart < passage.limits.earliestStartSeconds - EPSILON || snappedEnd > passage.limits.latestEndSeconds + EPSILON) {
        throw refuse('A passage cannot be moved beyond its limits (the neighbouring passage and the speech)')
      }
      const first = passage.mentions[0]!
      const last = passage.mentions.reduce((latest, mention) => (mention.endSeconds > latest.endSeconds ? mention : latest), first)
      const earliest = passage.mentions.reduce((soonest, mention) => (mention.startSeconds < soonest.startSeconds ? mention : soonest), first)
      if (snappedStart > earliest.startSeconds + EPSILON || snappedEnd < last.endSeconds - EPSILON) {
        throw refuse('A passage must keep every mention of the subject that anchors it')
      }
      start = snappedStart
      end = snappedEnd
    }
    return Object.freeze({
      id: passage.id, startSeconds: start, endSeconds: end,
      proposedStartSeconds: passage.startSeconds, proposedEndSeconds: passage.endSeconds,
      adjusted: start !== passage.startSeconds || end !== passage.endSeconds,
    })
  }))
}
