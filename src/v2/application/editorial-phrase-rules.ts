import { assertDomain } from '../domain/errors.ts'
import type { MediaTranscript, TranscriptWord } from '../domain/media-transcript.ts'

/** How a removal Command was confirmed when it confirms a cut the Apollo proposed (see `confirm-speech-removal.ts`): the subject it answers and the means of the verified human. */
export interface SpeechRemovalConfirmation {
  subject: string
  medium: 'ui-session' | 'api-key-scope'
}

export interface EditorialPhraseRule {
  id: string
  label: string
  alternatives: readonly (readonly string[])[]
  /**
   * Present only on a rule read back from a removal Command that CONFIRMED a proposal. A rule without it came from an explicit Command of the client: a valid cut,
   * asked for explicitly, that is not the confirmation of any proposal (the id and the words of a proposal can be computed by anyone).
   */
  confirmation?: Readonly<SpeechRemovalConfirmation>
}

export interface SourceTimeRange {
  sourceStartSeconds: number
  sourceEndSeconds: number
}

export interface EditorialExclusionRange extends SourceTimeRange {
  ruleIds: readonly string[]
  labels: readonly string[]
  matchedText: string
}

export interface EditorialPhraseMatch extends EditorialExclusionRange {}

function normalizeToken(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/[º°]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

export function defineEditorialPhraseRules(input: readonly Readonly<{
  id: string
  label: string
  alternatives: readonly string[]
}>[]): readonly Readonly<EditorialPhraseRule>[] {
  assertDomain(input.length > 0 && input.length <= 32, 'INVALID_ARGUMENT', 'Editorial phrase rules must contain 1 to 32 entries')
  const ids = new Set<string>()
  const rules = input.map((rule) => {
    const id = rule.id.trim()
    const label = rule.label.trim()
    assertDomain(/^[a-z0-9][a-z0-9-]{1,63}$/.test(id) && !ids.has(id), 'INVALID_ARGUMENT', 'Editorial phrase rule id is invalid or duplicated')
    assertDomain(label.length > 0 && label.length <= 160, 'INVALID_ARGUMENT', 'Editorial phrase rule label is invalid')
    assertDomain(rule.alternatives.length > 0 && rule.alternatives.length <= 8, 'INVALID_ARGUMENT', 'Editorial phrase rule alternatives must contain 1 to 8 entries')
    ids.add(id)
    const alternatives = rule.alternatives.map((alternative) => {
      const tokens = alternative.trim().split(/\s+/).map(normalizeToken).filter(Boolean)
      assertDomain(tokens.length > 0 && tokens.length <= 16, 'INVALID_ARGUMENT', 'Editorial phrase alternative is invalid')
      return Object.freeze(tokens)
    })
    return Object.freeze({ id, label, alternatives: Object.freeze(alternatives) })
  })
  return Object.freeze(rules)
}

function matchesAt(words: readonly TranscriptWord[], start: number, phrase: readonly string[]): boolean {
  if (start + phrase.length > words.length) return false
  return phrase.every((token, offset) => normalizeToken(words[start + offset]!.word) === token)
}

function expandToSegments(
  transcript: Readonly<MediaTranscript>,
  sourceStartSeconds: number,
  sourceEndSeconds: number,
): SourceTimeRange {
  const containing = transcript.segments.filter((segment) =>
    segment.end > sourceStartSeconds && segment.start < sourceEndSeconds,
  )
  if (containing.length === 0) return { sourceStartSeconds, sourceEndSeconds }
  return {
    sourceStartSeconds: Math.min(sourceStartSeconds, ...containing.map((segment) => segment.start)),
    sourceEndSeconds: Math.max(sourceEndSeconds, ...containing.map((segment) => segment.end)),
  }
}

function mergeRanges(ranges: readonly EditorialExclusionRange[]): readonly EditorialExclusionRange[] {
  const sorted = [...ranges].sort((left, right) =>
    left.sourceStartSeconds - right.sourceStartSeconds || left.sourceEndSeconds - right.sourceEndSeconds,
  )
  const merged: EditorialExclusionRange[] = []
  for (const range of sorted) {
    const previous = merged.at(-1)
    if (!previous || range.sourceStartSeconds > previous.sourceEndSeconds + 0.25) {
      merged.push({ ...range })
      continue
    }
    merged[merged.length - 1] = {
      sourceStartSeconds: previous.sourceStartSeconds,
      sourceEndSeconds: Math.max(previous.sourceEndSeconds, range.sourceEndSeconds),
      ruleIds: Object.freeze([...new Set([...previous.ruleIds, ...range.ruleIds])]),
      labels: Object.freeze([...new Set([...previous.labels, ...range.labels])]),
      matchedText: `${previous.matchedText} | ${range.matchedText}`,
    }
  }
  return Object.freeze(merged.map((range) => Object.freeze(range)))
}

/**
 * The words of a text as the editorial cut compares them: split on whitespace, each normalised like a transcript word is
 * (diacritics, case, punctuation), the ones that normalise to nothing dropped.
 */
export function editorialSpeechTokens(text: string): readonly string[] {
  return Object.freeze(text.split(/\s+/).map(normalizeToken).filter(Boolean))
}

/**
 * The ids of the rules whose phrase (any alternative) is spoken in `text`: the same tokens and the same word-for-word comparison
 * that cut the phrase out of the transcript, applied to a text such as the captions of a plan.
 */
export function editorialRulesMatchingSpeech(
  text: string,
  rules: readonly Readonly<EditorialPhraseRule>[],
): readonly string[] {
  const tokens = editorialSpeechTokens(text)
  const found: string[] = []
  for (const rule of rules) {
    const present = rule.alternatives.some((phrase) => {
      for (let start = 0; start + phrase.length <= tokens.length; start += 1) {
        if (phrase.every((token, offset) => tokens[start + offset] === token)) return true
      }
      return false
    })
    if (present && !found.includes(rule.id)) found.push(rule.id)
  }
  return Object.freeze(found)
}

export function deriveEditorialExclusions(
  transcript: Readonly<MediaTranscript>,
  rules: readonly Readonly<EditorialPhraseRule>[],
): readonly EditorialExclusionRange[] {
  return mergeRanges(deriveEditorialPhraseMatches(transcript, rules).map((match) => {
    const expanded = expandToSegments(
      transcript,
      match.sourceStartSeconds,
      match.sourceEndSeconds,
    )
    return { ...match, ...expanded }
  }))
}

export function deriveEditorialPhraseMatches(
  transcript: Readonly<MediaTranscript>,
  rules: readonly Readonly<EditorialPhraseRule>[],
): readonly Readonly<EditorialPhraseMatch>[] {
  const matches: EditorialExclusionRange[] = []
  for (let wordIndex = 0; wordIndex < transcript.words.length; wordIndex += 1) {
    for (const rule of rules) {
      for (const phrase of rule.alternatives) {
        if (!matchesAt(transcript.words, wordIndex, phrase)) continue
        const matchingWords = transcript.words.slice(wordIndex, wordIndex + phrase.length)
        matches.push({
          sourceStartSeconds: matchingWords[0]!.start,
          sourceEndSeconds: matchingWords.at(-1)!.end,
          ruleIds: Object.freeze([rule.id]),
          labels: Object.freeze([rule.label]),
          matchedText: matchingWords.map((word) => word.word).join(' '),
        })
        break
      }
    }
  }
  return Object.freeze(matches.map((match) => Object.freeze(match)))
}

export function buildRetainedSourceRanges(
  durationSeconds: number,
  exclusions: readonly SourceTimeRange[],
): readonly SourceTimeRange[] {
  assertDomain(
    Number.isFinite(durationSeconds) && durationSeconds > 0,
    'INVALID_ARGUMENT',
    'Source duration is invalid',
  )
  const ordered = [...exclusions].sort((left, right) => left.sourceStartSeconds - right.sourceStartSeconds)
  const retained: SourceTimeRange[] = []
  let cursor = 0
  for (const exclusion of ordered) {
    assertDomain(
      Number.isFinite(exclusion.sourceStartSeconds) &&
        Number.isFinite(exclusion.sourceEndSeconds) &&
        exclusion.sourceStartSeconds >= cursor &&
        exclusion.sourceEndSeconds > exclusion.sourceStartSeconds &&
        exclusion.sourceEndSeconds <= durationSeconds,
      'INVALID_ARGUMENT',
      'Editorial exclusion ranges must be ordered, disjoint and inside the source duration',
    )
    if (exclusion.sourceStartSeconds - cursor >= 0.08) {
      retained.push({ sourceStartSeconds: cursor, sourceEndSeconds: exclusion.sourceStartSeconds })
    }
    cursor = exclusion.sourceEndSeconds
  }
  if (durationSeconds - cursor >= 0.08) {
    retained.push({ sourceStartSeconds: cursor, sourceEndSeconds: durationSeconds })
  }
  return Object.freeze(retained.map((range) => Object.freeze(range)))
}
