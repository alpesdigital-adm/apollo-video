import { DomainError, assertDomain } from '../domain/errors.ts'
import type { MediaTranscript, TranscriptWord } from '../domain/media-transcript.ts'

export const RECOVERY_EDITORIAL_EXCLUSION_RULES = Object.freeze([
  Object.freeze({
    id: 'date-january-31',
    label: '31 de janeiro',
    alternatives: Object.freeze([
      Object.freeze(['31', 'de', 'janeiro']),
      Object.freeze(['trinta', 'e', 'um', 'de', 'janeiro']),
    ]),
  }),
  Object.freeze({
    id: 'date-february-1',
    label: '1 de fevereiro',
    alternatives: Object.freeze([
      Object.freeze(['1', 'de', 'fevereiro']),
      Object.freeze(['primeiro', 'de', 'fevereiro']),
    ]),
  }),
  Object.freeze({
    id: 'duration-two-days',
    label: 'dois dias',
    alternatives: Object.freeze([
      Object.freeze(['dois', 'dias']),
      Object.freeze(['2', 'dias']),
    ]),
  }),
] as const)

export type RecoveryEditorialExclusionRuleId =
  (typeof RECOVERY_EDITORIAL_EXCLUSION_RULES)[number]['id']

export interface EditorialPhraseRule {
  id: string
  label: string
  alternatives: readonly (readonly string[])[]
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

export function deriveRecoveryEditorialExclusions(
  transcript: Readonly<MediaTranscript>,
): readonly EditorialExclusionRange[] {
  return deriveEditorialExclusions(transcript, RECOVERY_EDITORIAL_EXCLUSION_RULES)
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

function overlaps(left: SourceTimeRange, right: SourceTimeRange): boolean {
  return left.sourceStartSeconds < right.sourceEndSeconds - 0.001 &&
    right.sourceStartSeconds < left.sourceEndSeconds - 0.001
}

export function validateRecoveryEditorialAcceptance(input: {
  transcript: Readonly<MediaTranscript>
  retainedSourceRanges: readonly SourceTimeRange[]
}): Readonly<{
  accepted: true
  excludedRuleIds: readonly RecoveryEditorialExclusionRuleId[]
  exclusions: readonly EditorialExclusionRange[]
}> {
  const exclusions = deriveRecoveryEditorialExclusions(input.transcript)
  const matchedRuleIds = new Set(exclusions.flatMap((range) => range.ruleIds))
  const missing = RECOVERY_EDITORIAL_EXCLUSION_RULES
    .map((rule) => rule.id)
    .filter((ruleId) => !matchedRuleIds.has(ruleId))
  if (missing.length > 0) {
    throw new DomainError(
      'EDITORIAL_ACCEPTANCE_FAILED',
      'The recovery master does not prove every required editorial exclusion',
      { missingRuleIds: missing },
    )
  }
  const retainedForbidden = exclusions.filter((exclusion) =>
    input.retainedSourceRanges.some((retained) => overlaps(exclusion, retained)),
  )
  if (retainedForbidden.length > 0) {
    throw new DomainError(
      'EDITORIAL_ACCEPTANCE_FAILED',
      'The EditPlan still retains forbidden date or duration speech',
      {
        retainedRuleIds: [...new Set(retainedForbidden.flatMap((range) => range.ruleIds))],
        retainedRanges: retainedForbidden.map((range) => ({
          sourceStartSeconds: range.sourceStartSeconds,
          sourceEndSeconds: range.sourceEndSeconds,
        })),
      },
    )
  }
  return Object.freeze({
    accepted: true as const,
    excludedRuleIds: Object.freeze([...matchedRuleIds].sort()) as readonly RecoveryEditorialExclusionRuleId[],
    exclusions,
  })
}
