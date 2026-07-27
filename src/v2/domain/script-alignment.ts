import {
  calculateCanonicalHash,
  stableSerialize,
} from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import type { MediaTranscript } from './media-transcript.ts'

export const SCRIPT_ALIGNMENT_SCHEMA_VERSION =
  'script-alignment-run/v1' as const
export const SCRIPT_DOCUMENT_SCHEMA_VERSION =
  'script-document/v1' as const
export const SCRIPT_ALIGNMENT_ALGORITHM_VERSION =
  'monotonic-lexical-sequence/v1' as const

export const SCRIPT_BLOCK_ROLES = [
  'hook',
  'body',
  'proof',
  'objection',
  'bridge',
  'offer',
  'cta',
] as const

export type ScriptBlockRole = (typeof SCRIPT_BLOCK_ROLES)[number]
export type ScriptAlignmentKind =
  'exact' | 'near' | 'partial' | 'missing'
export type ScriptAlignmentStatus =
  'completed' | 'review-required' | 'reviewed'
export type ScriptAlignmentReviewStatus =
  'auto-linked' | 'review-required' | 'accepted' | 'marked-missing'
export type ScriptExtraTakeReviewStatus =
  'review-required' | 'accepted' | 'rejected'
export type ScriptDeviationKind =
  | 'omission'
  | 'insertion'
  | 'paraphrase'
  | 'number-claim-change'
  | 'qualifier-change'
  | 'incomplete-ending'
  | 'restart'
  | 'off-script'

export interface ScriptBlock {
  id: string
  role: ScriptBlockRole
  originalLabel: string
  plannedText: string
  normalizedText: string
  documentOrder: number
  blockHash: string
}

export interface ScriptDocument {
  schemaVersion: typeof SCRIPT_DOCUMENT_SCHEMA_VERSION
  title: string
  locale: string
  rawText: string
  normalizedText: string
  blocks: readonly Readonly<ScriptBlock>[]
  documentHash: string
}

export interface ScriptTranscriptSource {
  transcriptId: string
  sourceArtifactId: string
  transcriptHash: string
  language: string
  roleHint?: ScriptBlockRole
  transcript: Readonly<MediaTranscript>
}

export interface ScriptAlignmentMetrics {
  semanticSimilarity: number
  lexicalCoverage: number
  expectedOrder: number
  boundaryCompleteness: number
  durationPlausibility: number
  labelSignal: number
  total: number
}

export interface ScriptTextDeviation {
  kind: ScriptDeviationKind
  plannedTokens: readonly string[]
  spokenTokens: readonly string[]
  reasonCode: string
}

export interface ScriptAlignmentCandidate {
  id: string
  transcriptId: string
  sourceArtifactId: string
  kind: Exclude<ScriptAlignmentKind, 'missing'>
  sourceRangeMs: readonly [number, number]
  evidenceWordIndices: readonly number[]
  spokenText: string
  normalizedSpokenText: string
  metrics: Readonly<ScriptAlignmentMetrics>
  deviations: readonly Readonly<ScriptTextDeviation>[]
  candidateHash: string
}

export interface ScriptBlockAlignment {
  blockId: string
  role: ScriptBlockRole
  documentOrder: number
  kind: ScriptAlignmentKind
  confidence: number
  reviewStatus: ScriptAlignmentReviewStatus
  ambiguous: boolean
  reasonCodes: readonly string[]
  selectedCandidate: Readonly<ScriptAlignmentCandidate> | null
  alternatives: readonly Readonly<ScriptAlignmentCandidate>[]
  reviewedCandidateId?: string
  reviewNote?: string
  reviewedByClientId?: string
  reviewedAt?: string
  alignmentHash: string
}

export interface ScriptExtraTake {
  id: string
  transcriptId: string
  sourceArtifactId: string
  sourceRangeMs: readonly [number, number]
  evidenceWordIndices: readonly number[]
  spokenText: string
  normalizedSpokenText: string
  reviewStatus: ScriptExtraTakeReviewStatus
  reviewNote?: string
  reviewedByClientId?: string
  reviewedAt?: string
  extraHash: string
}

export interface ScriptAlignmentSummary {
  blockCount: number
  exactCount: number
  nearCount: number
  partialCount: number
  missingCount: number
  extraTakeCount: number
  ambiguousCount: number
  reviewRequiredCount: number
  resolvedReviewCount: number
  averageConfidence: number
}

export interface ScriptAlignmentReview {
  id: string
  revision: number
  decisions: readonly Readonly<ScriptAlignmentReviewDecision>[]
  actorClientId: string
  createdAt: string
  reviewHash: string
}

export type ScriptAlignmentReviewDecision =
  | {
      targetKind: 'block'
      blockId: string
      resolution: 'accept' | 'mark-missing' | 'select-alternative'
      candidateId?: string
      note?: string
    }
  | {
      targetKind: 'extra-take'
      extraTakeId: string
      resolution: 'accept-extra' | 'reject-extra'
      note?: string
    }

export interface ScriptAlignmentRun {
  id: string
  workspaceId: string
  projectId: string
  batchId: string
  schemaVersion: typeof SCRIPT_ALIGNMENT_SCHEMA_VERSION
  algorithmVersion: typeof SCRIPT_ALIGNMENT_ALGORITHM_VERSION
  status: ScriptAlignmentStatus
  revision: number
  document: Readonly<ScriptDocument>
  sourceRefs: readonly Readonly<{
    transcriptId: string
    sourceArtifactId: string
    transcriptHash: string
    language: string
    roleHint?: ScriptBlockRole
  }>[]
  alignments: readonly Readonly<ScriptBlockAlignment>[]
  extraTakes: readonly Readonly<ScriptExtraTake>[]
  reviews: readonly Readonly<ScriptAlignmentReview>[]
  summary: Readonly<ScriptAlignmentSummary>
  createdByClientId: string
  createdAt: string
  updatedAt: string
  runHash: string
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const LABEL = /^(?:#{1,6}\s*)?(?:\[\s*)?(hook|gancho|body|corpo|proof|prova|objection|objecao|objeção|bridge|ponte|offer|oferta|cta)(?:\s*[-_#]?\s*(\d{1,3}))?(?:\s*\])?\s*(?::|[-–—])\s*(.*)$/iu
const ROLE_BY_LABEL: Readonly<Record<string, ScriptBlockRole>> = {
  hook: 'hook',
  gancho: 'hook',
  body: 'body',
  corpo: 'body',
  proof: 'proof',
  prova: 'proof',
  objection: 'objection',
  objecao: 'objection',
  objeção: 'objection',
  bridge: 'bridge',
  ponte: 'bridge',
  offer: 'offer',
  oferta: 'offer',
  cta: 'cta',
}
const QUALIFIERS = new Set([
  'nao',
  'nunca',
  'apenas',
  'somente',
  'ate',
  'mais',
  'menos',
  'sem',
  'no',
  'not',
  'never',
  'only',
  'until',
  'without',
])
const NUMBER_WORDS = new Set([
  'zero',
  'um',
  'uma',
  'dois',
  'duas',
  'tres',
  'quatro',
  'cinco',
  'seis',
  'sete',
  'oito',
  'nove',
  'dez',
  'onze',
  'doze',
  'treze',
  'quatorze',
  'quinze',
  'vinte',
  'trinta',
  'quarenta',
  'cinquenta',
  'sessenta',
  'setenta',
  'oitenta',
  'noventa',
  'cem',
  'cento',
  'duzentos',
  'mil',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'hundred',
  'thousand',
  'uno',
  'dos',
  'tres',
  'cuatro',
  'cinco',
  'seis',
  'siete',
  'ocho',
  'nueve',
  'diez',
  'cien',
  'mil',
])

function normalizedInstant(value: string, name: string) {
  const date = new Date(value)
  assertDomain(
    !Number.isNaN(date.getTime()) && date.toISOString() === value,
    'INVALID_ARGUMENT',
    `${name} must be an ISO instant`,
  )
  return value
}

export function normalizeScriptText(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('und')
    .replace(/[^\p{L}\p{N}%$€£\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizedTokens(value: string) {
  const normalized = normalizeScriptText(value)
  return normalized ? normalized.split(' ') : []
}

function canonicalLocale(value: string) {
  let locale: string | undefined
  try {
    locale = Intl.getCanonicalLocales(value.trim())[0]
  } catch {
    locale = undefined
  }
  assertDomain(
    Boolean(locale),
    'INVALID_ARGUMENT',
    'Script document locale is invalid',
  )
  return locale!
}

export function importScriptDocument(input: {
  title: string
  locale: string
  rawText: string
}): Readonly<ScriptDocument> {
  const title = input.title.trim()
  const rawText = input.rawText
    .replace(/\r\n?/g, '\n')
    .trim()
  assertDomain(
    title.length >= 2 && title.length <= 200,
    'INVALID_ARGUMENT',
    'Script document title is invalid',
  )
  assertDomain(
    rawText.length >= 3 && rawText.length <= 500_000,
    'INVALID_ARGUMENT',
    'Script document text is invalid',
  )

  const parsed: {
    role: ScriptBlockRole
    label: string
    lines: string[]
  }[] = []
  for (const line of rawText.split('\n')) {
    const match = LABEL.exec(line)
    if (match) {
      const role = ROLE_BY_LABEL[normalizeScriptText(match[1]!)]
      assertDomain(
        Boolean(role),
        'INVALID_ARGUMENT',
        `Unsupported script block label ${match[1]}`,
      )
      parsed.push({
        role,
        label: line.slice(0, line.length - (match[3]?.length ?? 0))
          .replace(/[\s:–—-]+$/u, '')
          .trim(),
        lines: match[3]?.trim() ? [match[3].trim()] : [],
      })
      continue
    }
    if (!line.trim()) {
      if (parsed.at(-1)?.lines.length) parsed.at(-1)!.lines.push('')
      continue
    }
    assertDomain(
      parsed.length > 0,
      'INVALID_ARGUMENT',
      'Script text must begin with an identifiable block label',
    )
    parsed.at(-1)!.lines.push(line.trim())
  }

  assertDomain(
    parsed.length > 0 && parsed.length <= 500,
    'INVALID_ARGUMENT',
    'Script document must contain 1-500 identifiable blocks',
  )
  const blocks = parsed.map((item, documentOrder) => {
    const plannedText = item.lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    const normalizedText = normalizeScriptText(plannedText)
    assertDomain(
      plannedText.length > 0 &&
      plannedText.length <= 20_000 &&
      normalizedText.length > 0,
      'INVALID_ARGUMENT',
      `Script block ${documentOrder + 1} is empty or too large`,
    )
    const content = {
      id: `script-block-${documentOrder + 1}`,
      role: item.role,
      originalLabel: item.label.slice(0, 120),
      plannedText,
      normalizedText,
      documentOrder,
    }
    return Object.freeze({
      ...content,
      blockHash: calculateCanonicalHash(content),
    })
  })
  const body = {
    schemaVersion: SCRIPT_DOCUMENT_SCHEMA_VERSION,
    title,
    locale: canonicalLocale(input.locale),
    rawText,
    normalizedText: normalizeScriptText(rawText),
    blocks: Object.freeze(blocks),
  }
  return Object.freeze({
    ...body,
    documentHash: calculateCanonicalHash(body),
  })
}

function multisetCoverage(planned: readonly string[], spoken: readonly string[]) {
  const available = new Map<string, number>()
  for (const token of spoken) {
    available.set(token, (available.get(token) ?? 0) + 1)
  }
  let matched = 0
  for (const token of planned) {
    const count = available.get(token) ?? 0
    if (count > 0) {
      matched += 1
      available.set(token, count - 1)
    }
  }
  return planned.length ? matched / planned.length : 0
}

function lcsRatio(left: readonly string[], right: readonly string[]) {
  if (!left.length || !right.length) return 0
  let previous = new Uint16Array(right.length + 1)
  for (const leftToken of left) {
    const current = new Uint16Array(right.length + 1)
    for (let index = 1; index <= right.length; index += 1) {
      current[index] = leftToken === right[index - 1]
        ? previous[index - 1]! + 1
        : Math.max(previous[index]!, current[index - 1]!)
    }
    previous = current
  }
  return previous[right.length]! / left.length
}

function roundMetric(value: number) {
  return Number(Math.max(0, Math.min(1, value)).toFixed(4))
}

function numberTokens(tokens: readonly string[]) {
  return tokens.filter((token) =>
    /[\d%$€£]/u.test(token) || NUMBER_WORDS.has(token))
}

function changedTokens(
  planned: readonly string[],
  spoken: readonly string[],
) {
  const plannedSet = new Set(planned)
  const spokenSet = new Set(spoken)
  return {
    missing: planned.filter((token) => !spokenSet.has(token)),
    inserted: spoken.filter((token) => !plannedSet.has(token)),
  }
}

function deviations(
  planned: readonly string[],
  spoken: readonly string[],
  metrics: ScriptAlignmentMetrics,
): readonly Readonly<ScriptTextDeviation>[] {
  const changed = changedTokens(planned, spoken)
  const values: ScriptTextDeviation[] = []
  const push = (
    kind: ScriptDeviationKind,
    reasonCode: string,
    plannedTokens: readonly string[],
    spokenTokens: readonly string[],
  ) => values.push({
    kind,
    reasonCode,
    plannedTokens: Object.freeze([...new Set(plannedTokens)].slice(0, 50)),
    spokenTokens: Object.freeze([...new Set(spokenTokens)].slice(0, 50)),
  })

  if (changed.missing.length) {
    push('omission', 'SCRIPT_WORDS_OMITTED', changed.missing, [])
  }
  if (changed.inserted.length) {
    push('insertion', 'OFF_SCRIPT_WORDS_INSERTED', [], changed.inserted)
  }
  const plannedNumbers = numberTokens(planned)
  const spokenNumbers = numberTokens(spoken)
  if (plannedNumbers.join('|') !== spokenNumbers.join('|')) {
    push(
      'number-claim-change',
      'NUMBER_OR_CLAIM_CHANGED',
      plannedNumbers,
      spokenNumbers,
    )
  }
  const plannedQualifiers = planned.filter((token) => QUALIFIERS.has(token))
  const spokenQualifiers = spoken.filter((token) => QUALIFIERS.has(token))
  if (plannedQualifiers.join('|') !== spokenQualifiers.join('|')) {
    push(
      'qualifier-change',
      'QUALIFIER_CHANGED',
      plannedQualifiers,
      spokenQualifiers,
    )
  }
  const ending = planned.slice(-Math.min(3, planned.length))
  if (ending.length && lcsRatio(ending, spoken.slice(-ending.length - 2)) < .67) {
    push('incomplete-ending', 'SCRIPT_ENDING_INCOMPLETE', ending, spoken.slice(-5))
  }
  const opening = planned.slice(0, Math.min(3, planned.length)).join(' ')
  const spokenText = spoken.join(' ')
  if (opening && spokenText.indexOf(opening) !== spokenText.lastIndexOf(opening)) {
    push('restart', 'SPEAKER_RESTART_DETECTED', planned.slice(0, 3), spoken)
  }
  if (
    metrics.semanticSimilarity >= .65 &&
    metrics.lexicalCoverage < .9 &&
    metrics.lexicalCoverage >= .45
  ) {
    push('paraphrase', 'SCRIPT_PARAPHRASED', planned, spoken)
  }
  if (metrics.total < 60) {
    push('off-script', 'LOW_SCRIPT_SIMILARITY', planned, spoken)
  }
  return Object.freeze(values.map((value) => Object.freeze(value)))
}

interface CandidateWindow {
  source: ScriptTranscriptSource
  start: number
  endExclusive: number
  spokenTokens: readonly string[]
  metrics: ScriptAlignmentMetrics
}

function sourceWordTokens(source: ScriptTranscriptSource) {
  return source.transcript.words.map((word) => normalizeScriptText(word.word))
}

function candidateStarts(
  planned: readonly string[],
  sourceTokens: readonly string[],
  minimumStart: number,
) {
  const plannedSet = new Set(planned)
  const starts: number[] = []
  for (let index = minimumStart; index < sourceTokens.length; index += 1) {
    if (plannedSet.has(sourceTokens[index]!)) starts.push(index)
  }
  return starts.slice(0, 5_000)
}

function boundaryScore(
  source: ScriptTranscriptSource,
  start: number,
  endExclusive: number,
) {
  const startMs = source.transcript.words[start]!.start * 1_000
  const endMs = source.transcript.words[endExclusive - 1]!.end * 1_000
  if (!source.transcript.segments.length) return .65
  const startsNearBoundary = source.transcript.segments.some((segment) =>
    Math.abs(segment.start * 1_000 - startMs) <= 750)
  const endsNearBoundary = source.transcript.segments.some((segment) =>
    Math.abs(segment.end * 1_000 - endMs) <= 900)
  return startsNearBoundary && endsNearBoundary
    ? 1
    : startsNearBoundary || endsNearBoundary ? .8 : .55
}

function scoreWindow(
  planned: readonly string[],
  spoken: readonly string[],
  source: ScriptTranscriptSource,
  role: ScriptBlockRole,
  start: number,
  endExclusive: number,
): ScriptAlignmentMetrics {
  const lexicalCoverage = multisetCoverage(planned, spoken)
  const matchedTokenCount = lexicalCoverage * planned.length
  const lexicalPrecision = spoken.length
    ? matchedTokenCount / spoken.length
    : 0
  const lexicalF1 = lexicalCoverage + lexicalPrecision
    ? 2 * lexicalCoverage * lexicalPrecision /
      (lexicalCoverage + lexicalPrecision)
    : 0
  const expectedOrder = lcsRatio(planned, spoken)
  const semanticSimilarity = (lexicalF1 + expectedOrder) / 2
  const boundaryCompleteness =
    boundaryScore(source, start, endExclusive)
  const durationRatio = spoken.length / Math.max(1, planned.length)
  const durationPlausibility = durationRatio >= .8 && durationRatio <= 1.2
    ? 1
    : durationRatio >= .65 && durationRatio <= 1.45
      ? .65
      : durationRatio >= .5 && durationRatio <= 1.7 ? .3 : .05
  const labelSignal = source.roleHint
    ? source.roleHint === role ? 1 : 0
    : .5
  const total =
    semanticSimilarity * 35 +
    lexicalCoverage * 20 +
    expectedOrder * 15 +
    boundaryCompleteness * 15 +
    durationPlausibility * 5 +
    labelSignal * 10
  return {
    semanticSimilarity: roundMetric(semanticSimilarity),
    lexicalCoverage: roundMetric(lexicalCoverage),
    expectedOrder: roundMetric(expectedOrder),
    boundaryCompleteness: roundMetric(boundaryCompleteness),
    durationPlausibility: roundMetric(durationPlausibility),
    labelSignal: roundMetric(labelSignal),
    total: Number(Math.max(0, Math.min(100, total)).toFixed(2)),
  }
}

function bestWindowsForSource(
  block: ScriptBlock,
  source: ScriptTranscriptSource,
  minimumStart: number,
) {
  const planned = normalizedTokens(block.plannedText)
  const sourceTokens = sourceWordTokens(source)
  if (!planned.length || minimumStart >= sourceTokens.length) return []
  const minimumLength = Math.max(1, Math.floor(planned.length * .6))
  const maximumLength = Math.min(
    sourceTokens.length,
    Math.max(minimumLength, Math.ceil(planned.length * 1.45) + 3),
  )
  const starts = candidateStarts(planned, sourceTokens, minimumStart)
  const windows: CandidateWindow[] = []
  for (const start of starts) {
    const lengthCandidates = new Set([
      minimumLength,
      Math.max(minimumLength, planned.length - 2),
      planned.length,
      Math.min(maximumLength, planned.length + 2),
      maximumLength,
    ])
    for (const length of lengthCandidates) {
      const endExclusive = Math.min(sourceTokens.length, start + length)
      if (endExclusive <= start) continue
      const spokenTokens = sourceTokens.slice(start, endExclusive)
      const metrics = scoreWindow(
        planned,
        spokenTokens,
        source,
        block.role,
        start,
        endExclusive,
      )
      windows.push({ source, start, endExclusive, spokenTokens, metrics })
    }
  }
  return windows
    .sort((left, right) =>
      right.metrics.total - left.metrics.total ||
      left.start - right.start ||
      left.endExclusive - right.endExclusive)
    .filter((window, index, all) => {
      const duplicate = all.slice(0, index).some((previous) =>
        Math.abs(previous.start - window.start) <= 1 &&
        Math.abs(previous.endExclusive - window.endExclusive) <= 2)
      return !duplicate
    })
    .slice(0, 3)
}

function candidateFromWindow(
  block: ScriptBlock,
  window: CandidateWindow,
): Readonly<ScriptAlignmentCandidate> {
  const { source, start, endExclusive, spokenTokens, metrics } = window
  const words = source.transcript.words.slice(start, endExclusive)
  const spokenText = words.map((word) => word.word).join(' ').trim()
  const normalizedSpokenText = normalizeScriptText(spokenText)
  const plannedTokens = normalizedTokens(block.plannedText)
  const kind: Exclude<ScriptAlignmentKind, 'missing'> =
    block.normalizedText === normalizedSpokenText && metrics.total >= 95
      ? 'exact'
      : metrics.total >= 75 ? 'near' : 'partial'
  const body = {
    id: `script-candidate-${calculateCanonicalHash({
      blockId: block.id,
      transcriptId: source.transcriptId,
      start,
      endExclusive,
    }).slice(0, 32)}`,
    transcriptId: source.transcriptId,
    sourceArtifactId: source.sourceArtifactId,
    kind,
    sourceRangeMs: Object.freeze([
      Math.round(words[0]!.start * 1_000),
      Math.round(words.at(-1)!.end * 1_000),
    ]) as readonly [number, number],
    evidenceWordIndices: Object.freeze(
      Array.from(
        { length: endExclusive - start },
        (_, index) => start + index,
      ),
    ),
    spokenText,
    normalizedSpokenText,
    metrics: Object.freeze(metrics),
    deviations: deviations(plannedTokens, spokenTokens, metrics),
  }
  return Object.freeze({
    ...body,
    candidateHash: calculateCanonicalHash(body),
  })
}

function alignmentHash(
  value: Omit<ScriptBlockAlignment, 'alignmentHash'>,
) {
  return calculateCanonicalHash(value)
}

function alignBlock(
  block: ScriptBlock,
  sources: readonly ScriptTranscriptSource[],
  cursors: ReadonlyMap<string, number>,
) {
  const candidates = sources.flatMap((source) =>
    bestWindowsForSource(
      block,
      source,
      cursors.get(source.transcriptId) ?? 0,
    ).map((window) => candidateFromWindow(block, window)))
    .sort((left, right) =>
      right.metrics.total - left.metrics.total ||
      left.sourceRangeMs[0] - right.sourceRangeMs[0])
    .slice(0, 6)
  const selected = candidates[0]
  if (!selected || selected.metrics.total < 60) {
    const body: Omit<ScriptBlockAlignment, 'alignmentHash'> = {
      blockId: block.id,
      role: block.role,
      documentOrder: block.documentOrder,
      kind: 'missing',
      confidence: selected?.metrics.total ?? 0,
      reviewStatus: 'review-required',
      ambiguous: false,
      reasonCodes: Object.freeze(['SCRIPT_BLOCK_NOT_FOUND']),
      selectedCandidate: null,
      alternatives: Object.freeze(candidates.slice(0, 3)),
    }
    return Object.freeze({ ...body, alignmentHash: alignmentHash(body) })
  }

  const second = candidates[1]
  const ambiguous = Boolean(
    second &&
    selected.metrics.total - second.metrics.total < 5 &&
    (
      selected.transcriptId !== second.transcriptId ||
      Math.abs(
        selected.sourceRangeMs[0] - second.sourceRangeMs[0],
      ) > 1_000
    ),
  )
  const criticalDeviation = selected.deviations.some((deviation) =>
    deviation.kind === 'number-claim-change' ||
    deviation.kind === 'qualifier-change' ||
    deviation.kind === 'incomplete-ending')
  const autoLinked =
    selected.metrics.total >= 80 &&
    !ambiguous &&
    !criticalDeviation &&
    selected.kind !== 'partial'
  const reasonCodes = [
    ...(ambiguous ? ['ALIGNMENT_AMBIGUOUS'] : []),
    ...(selected.kind === 'partial' ? ['ALIGNMENT_PARTIAL'] : []),
    ...(selected.metrics.total < 80 ? ['ALIGNMENT_BELOW_AUTO_THRESHOLD'] : []),
    ...selected.deviations
      .filter((deviation) =>
        deviation.kind === 'number-claim-change' ||
        deviation.kind === 'qualifier-change' ||
        deviation.kind === 'incomplete-ending')
      .map((deviation) => deviation.reasonCode),
  ]
  const body: Omit<ScriptBlockAlignment, 'alignmentHash'> = {
    blockId: block.id,
    role: block.role,
    documentOrder: block.documentOrder,
    kind: selected.kind,
    confidence: selected.metrics.total,
    reviewStatus: autoLinked ? 'auto-linked' : 'review-required',
    ambiguous,
    reasonCodes: Object.freeze([...new Set(reasonCodes)]),
    selectedCandidate: selected,
    alternatives: Object.freeze(candidates.slice(1, 4)),
  }
  return Object.freeze({ ...body, alignmentHash: alignmentHash(body) })
}

function contiguousGroups(indices: readonly number[]) {
  const groups: number[][] = []
  for (const index of indices) {
    const previous = groups.at(-1)
    if (!previous || previous.at(-1)! + 1 !== index) groups.push([index])
    else previous.push(index)
  }
  return groups
}

function deriveExtraTakes(
  sources: readonly ScriptTranscriptSource[],
  alignments: readonly ScriptBlockAlignment[],
) {
  const usedByTranscript = new Map<string, Set<number>>()
  for (const alignment of alignments) {
    const selected = alignment.selectedCandidate
    if (!selected) continue
    const used = usedByTranscript.get(selected.transcriptId) ?? new Set<number>()
    selected.evidenceWordIndices.forEach((index) => used.add(index))
    usedByTranscript.set(selected.transcriptId, used)
  }
  const extras: ScriptExtraTake[] = []
  for (const source of sources) {
    const used = usedByTranscript.get(source.transcriptId) ?? new Set<number>()
    const unused = source.transcript.words
      .map((_, index) => index)
      .filter((index) => !used.has(index))
    for (const group of contiguousGroups(unused)) {
      const first = source.transcript.words[group[0]!]!
      const last = source.transcript.words[group.at(-1)!]!
      if (group.length === 1 && last.end - first.start < .2) continue
      const spokenText = group
        .map((index) => source.transcript.words[index]!.word)
        .join(' ')
        .trim()
      const body = {
        id: `script-extra-${calculateCanonicalHash({
          transcriptId: source.transcriptId,
          first: group[0],
          last: group.at(-1),
        }).slice(0, 32)}`,
        transcriptId: source.transcriptId,
        sourceArtifactId: source.sourceArtifactId,
        sourceRangeMs: Object.freeze([
          Math.round(first.start * 1_000),
          Math.round(last.end * 1_000),
        ]) as readonly [number, number],
        evidenceWordIndices: Object.freeze(group),
        spokenText,
        normalizedSpokenText: normalizeScriptText(spokenText),
        reviewStatus: 'review-required' as const,
      }
      extras.push({
        ...body,
        extraHash: calculateCanonicalHash(body),
      })
      assertDomain(
        extras.length <= 2_000,
        'INVALID_ARGUMENT',
        'Script alignment produced too many extra takes',
      )
    }
  }
  return Object.freeze(extras.map((extra) => Object.freeze(extra)))
}

function summary(
  alignments: readonly ScriptBlockAlignment[],
  extraTakes: readonly ScriptExtraTake[],
): Readonly<ScriptAlignmentSummary> {
  const reviewRequiredCount = alignments.filter((alignment) =>
    alignment.reviewStatus === 'review-required').length +
    extraTakes.filter((extra) =>
      extra.reviewStatus === 'review-required').length
  const resolvedReviewCount = alignments.filter((alignment) =>
    alignment.reviewStatus === 'accepted' ||
    alignment.reviewStatus === 'marked-missing').length +
    extraTakes.filter((extra) =>
      extra.reviewStatus === 'accepted' ||
      extra.reviewStatus === 'rejected').length
  return Object.freeze({
    blockCount: alignments.length,
    exactCount: alignments.filter((value) => value.kind === 'exact').length,
    nearCount: alignments.filter((value) => value.kind === 'near').length,
    partialCount: alignments.filter((value) => value.kind === 'partial').length,
    missingCount: alignments.filter((value) => value.kind === 'missing').length,
    extraTakeCount: extraTakes.length,
    ambiguousCount: alignments.filter((value) => value.ambiguous).length,
    reviewRequiredCount,
    resolvedReviewCount,
    averageConfidence: alignments.length
      ? Number((
          alignments.reduce(
            (total, alignment) => total + alignment.confidence,
            0,
          ) / alignments.length
        ).toFixed(2))
      : 0,
  })
}

function runHash(value: Omit<ScriptAlignmentRun, 'runHash'>) {
  return calculateCanonicalHash(value)
}

function validateSources(sources: readonly ScriptTranscriptSource[]) {
  assertDomain(
    sources.length > 0 && sources.length <= 50,
    'INVALID_ARGUMENT',
    'Script alignment requires 1-50 transcript sources',
  )
  const identities = new Set<string>()
  return Object.freeze(sources.map((source) => {
    assertDomain(
      TOKEN.test(source.transcriptId) &&
      TOKEN.test(source.sourceArtifactId) &&
      /^[a-f0-9]{64}$/.test(source.transcriptHash) &&
      source.transcript.transcriptHash === source.transcriptHash &&
      (
        source.roleHint === undefined ||
        SCRIPT_BLOCK_ROLES.includes(source.roleHint)
      ) &&
      source.transcript.words.length > 0,
      'INVALID_ARGUMENT',
      'Script transcript source is invalid',
    )
    assertDomain(
      !identities.has(source.transcriptId),
      'INVALID_ARGUMENT',
      `Transcript source ${source.transcriptId} is duplicated`,
    )
    identities.add(source.transcriptId)
    return Object.freeze(source)
  }))
}

export function createScriptAlignmentRun(input: {
  id: string
  workspaceId: string
  projectId: string
  batchId: string
  document: Readonly<ScriptDocument>
  sources: readonly ScriptTranscriptSource[]
  createdByClientId: string
  createdAt: string
}): Readonly<ScriptAlignmentRun> {
  for (const [name, value] of Object.entries({
    id: input.id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    batchId: input.batchId,
    createdByClientId: input.createdByClientId,
  })) {
    assertDomain(
      TOKEN.test(value),
      'INVALID_ARGUMENT',
      `Script alignment ${name} is invalid`,
    )
  }
  const createdAt = normalizedInstant(input.createdAt, 'createdAt')
  const sources = validateSources(input.sources)
  const cursors = new Map<string, number>()
  const alignments: ScriptBlockAlignment[] = []
  for (const block of input.document.blocks) {
    const alignment = alignBlock(block, sources, cursors)
    alignments.push(alignment)
    if (alignment.selectedCandidate) {
      cursors.set(
        alignment.selectedCandidate.transcriptId,
        alignment.selectedCandidate.evidenceWordIndices.at(-1)! + 1,
      )
    }
  }
  const extraTakes = deriveExtraTakes(sources, alignments)
  const runSummary = summary(alignments, extraTakes)
  const status: ScriptAlignmentStatus =
    runSummary.reviewRequiredCount > 0 ? 'review-required' : 'completed'
  const body: Omit<ScriptAlignmentRun, 'runHash'> = {
    id: input.id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    batchId: input.batchId,
    schemaVersion: SCRIPT_ALIGNMENT_SCHEMA_VERSION,
    algorithmVersion: SCRIPT_ALIGNMENT_ALGORITHM_VERSION,
    status,
    revision: 1,
    document: input.document,
    sourceRefs: Object.freeze(sources.map((source) => Object.freeze({
      transcriptId: source.transcriptId,
      sourceArtifactId: source.sourceArtifactId,
      transcriptHash: source.transcriptHash,
      language: source.language,
      ...(source.roleHint ? { roleHint: source.roleHint } : {}),
    }))),
    alignments: Object.freeze(alignments),
    extraTakes,
    reviews: Object.freeze([]),
    summary: runSummary,
    createdByClientId: input.createdByClientId,
    createdAt,
    updatedAt: createdAt,
  }
  return Object.freeze({ ...body, runHash: runHash(body) })
}

export function reviewScriptAlignmentRun(input: {
  run: Readonly<ScriptAlignmentRun>
  expectedRevision: number
  reviewId: string
  actorClientId: string
  decisions: readonly ScriptAlignmentReviewDecision[]
  createdAt: string
}): Readonly<ScriptAlignmentRun> {
  const run = hydrateScriptAlignmentRun(input.run)
  assertDomain(
    run.revision === input.expectedRevision,
    'VERSION_CONFLICT',
    'Script alignment revision is stale',
    { currentRevision: run.revision },
  )
  assertDomain(
    TOKEN.test(input.reviewId) &&
    TOKEN.test(input.actorClientId) &&
    input.decisions.length > 0 &&
    input.decisions.length <= 500,
    'INVALID_ARGUMENT',
    'Script alignment review is invalid',
  )
  const createdAt = normalizedInstant(input.createdAt, 'review.createdAt')
  assertDomain(
    Date.parse(createdAt) >= Date.parse(run.updatedAt),
    'VERSION_CONFLICT',
    'Script alignment review cannot move time backwards',
  )
  const seen = new Set<string>()
  const decisions = input.decisions.map((decision) => {
    const targetId = decision.targetKind === 'block'
      ? decision.blockId
      : decision.extraTakeId
    assertDomain(
      TOKEN.test(targetId) &&
      !seen.has(`${decision.targetKind}:${targetId}`),
      'INVALID_ARGUMENT',
      `Script alignment review target ${targetId} is invalid`,
    )
    seen.add(`${decision.targetKind}:${targetId}`)
    const note = decision.note?.trim()
    assertDomain(
      note === undefined || note.length <= 1_000,
      'INVALID_ARGUMENT',
      'Script alignment review note is too large',
    )
    if (decision.targetKind === 'extra-take') {
      assertDomain(
        run.extraTakes.some((extra) => extra.id === decision.extraTakeId),
        'INVALID_ARGUMENT',
        `Script extra take ${decision.extraTakeId} was not found`,
      )
      return Object.freeze({
        targetKind: decision.targetKind,
        extraTakeId: decision.extraTakeId,
        resolution: decision.resolution,
        ...(note ? { note } : {}),
      })
    }
    const alignment = run.alignments.find((candidate) =>
      candidate.blockId === decision.blockId)
    assertDomain(
      Boolean(alignment),
      'INVALID_ARGUMENT',
      `Script alignment block ${decision.blockId} was not found`,
    )
    if (decision.resolution === 'select-alternative') {
      assertDomain(
        Boolean(
          decision.candidateId &&
          alignment!.alternatives.some((candidate) =>
            candidate.id === decision.candidateId),
        ),
        'INVALID_ARGUMENT',
        'Selected script alignment alternative is invalid',
      )
    } else {
      assertDomain(
        decision.candidateId === undefined,
        'INVALID_ARGUMENT',
        'Candidate is only valid for select-alternative',
      )
    }
    return Object.freeze({
      targetKind: decision.targetKind,
      blockId: decision.blockId,
      resolution: decision.resolution,
      ...(decision.candidateId ? { candidateId: decision.candidateId } : {}),
      ...(note ? { note } : {}),
    })
  })
  const alignments = run.alignments.map((alignment) => {
    const decision = decisions.find((candidate) =>
      candidate.targetKind === 'block' &&
      candidate.blockId === alignment.blockId)
    if (!decision || decision.targetKind !== 'block') return alignment
    const selectedCandidate = decision.resolution === 'select-alternative'
      ? alignment.alternatives.find((candidate) =>
          candidate.id === decision.candidateId)!
      : decision.resolution === 'accept'
        ? alignment.selectedCandidate
        : null
    assertDomain(
      decision.resolution === 'mark-missing' ||
      Boolean(selectedCandidate),
      'INVALID_ARGUMENT',
      'Cannot accept an alignment without a candidate',
    )
    const alternatives = decision.resolution === 'select-alternative'
      ? Object.freeze([
          ...(alignment.selectedCandidate
            ? [alignment.selectedCandidate]
            : []),
          ...alignment.alternatives.filter((candidate) =>
            candidate.id !== decision.candidateId),
        ].slice(0, 3))
      : alignment.alternatives
    const {
      alignmentHash: _previousAlignmentHash,
      ...currentAlignment
    } = alignment
    const body: Omit<ScriptBlockAlignment, 'alignmentHash'> = {
      ...currentAlignment,
      kind: selectedCandidate?.kind ?? 'missing',
      confidence: selectedCandidate?.metrics.total ?? 0,
      reviewStatus: decision.resolution === 'mark-missing'
        ? 'marked-missing'
        : 'accepted',
      ambiguous: false,
      reasonCodes: Object.freeze(
        decision.resolution === 'mark-missing'
          ? ['MANUALLY_MARKED_MISSING']
          : ['MANUALLY_ACCEPTED'],
      ),
      selectedCandidate,
      alternatives,
      ...(selectedCandidate
        ? { reviewedCandidateId: selectedCandidate.id }
        : {}),
      ...(decision.note ? { reviewNote: decision.note } : {}),
      reviewedByClientId: input.actorClientId,
      reviewedAt: createdAt,
    }
    return Object.freeze({ ...body, alignmentHash: alignmentHash(body) })
  })
  const extraTakes = run.extraTakes.map((extra) => {
    const decision = decisions.find((candidate) =>
      candidate.targetKind === 'extra-take' &&
      candidate.extraTakeId === extra.id)
    if (!decision || decision.targetKind !== 'extra-take') return extra
    const { extraHash: _previousExtraHash, ...currentExtra } = extra
    const body: Omit<ScriptExtraTake, 'extraHash'> = {
      ...currentExtra,
      reviewStatus: decision.resolution === 'accept-extra'
        ? 'accepted'
        : 'rejected',
      ...(decision.note ? { reviewNote: decision.note } : {}),
      reviewedByClientId: input.actorClientId,
      reviewedAt: createdAt,
    }
    return Object.freeze({
      ...body,
      extraHash: calculateCanonicalHash(body),
    })
  })
  const nextSummary = summary(alignments, extraTakes)
  const reviewBody = {
    id: input.reviewId,
    revision: run.revision + 1,
    decisions: Object.freeze(decisions),
    actorClientId: input.actorClientId,
    createdAt,
  }
  const review = Object.freeze({
    ...reviewBody,
    reviewHash: calculateCanonicalHash(reviewBody),
  })
  const unresolvedBlocks = alignments.some((alignment) =>
    alignment.reviewStatus === 'review-required')
  const unresolvedExtras = extraTakes.some((extra) =>
    extra.reviewStatus === 'review-required')
  const { runHash: _previousRunHash, ...currentRun } = run
  const body: Omit<ScriptAlignmentRun, 'runHash'> = {
    ...currentRun,
    status: unresolvedBlocks || unresolvedExtras
      ? 'review-required'
      : 'reviewed',
    revision: run.revision + 1,
    alignments: Object.freeze(alignments),
    extraTakes: Object.freeze(extraTakes),
    reviews: Object.freeze([...run.reviews, review]),
    summary: nextSummary,
    updatedAt: createdAt,
  }
  return Object.freeze({ ...body, runHash: runHash(body) })
}

export function hydrateScriptAlignmentRun(
  value: Readonly<ScriptAlignmentRun>,
): Readonly<ScriptAlignmentRun> {
  assertDomain(
    value.schemaVersion === SCRIPT_ALIGNMENT_SCHEMA_VERSION &&
    value.algorithmVersion === SCRIPT_ALIGNMENT_ALGORITHM_VERSION &&
    TOKEN.test(value.id) &&
    TOKEN.test(value.workspaceId) &&
    TOKEN.test(value.projectId) &&
    TOKEN.test(value.batchId) &&
    TOKEN.test(value.createdByClientId) &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 1 &&
    ['completed', 'review-required', 'reviewed'].includes(value.status) &&
    value.document.documentHash === calculateCanonicalHash({
      schemaVersion: value.document.schemaVersion,
      title: value.document.title,
      locale: value.document.locale,
      rawText: value.document.rawText,
      normalizedText: value.document.normalizedText,
      blocks: value.document.blocks,
    }),
    'PERSISTENCE_CONFLICT',
    'Script alignment identity or document failed integrity validation',
  )
  for (const block of value.document.blocks) {
    assertDomain(
      block.blockHash === calculateCanonicalHash({
        id: block.id,
        role: block.role,
        originalLabel: block.originalLabel,
        plannedText: block.plannedText,
        normalizedText: block.normalizedText,
        documentOrder: block.documentOrder,
      }),
      'PERSISTENCE_CONFLICT',
      `Script block ${block.id} failed integrity validation`,
    )
  }
  for (const alignment of value.alignments) {
    const { alignmentHash: stored, ...body } = alignment
    assertDomain(
      stored === alignmentHash(body) &&
      value.document.blocks.some((block) =>
        block.id === alignment.blockId),
      'PERSISTENCE_CONFLICT',
      `Script alignment ${alignment.blockId} failed integrity validation`,
    )
  }
  for (const extra of value.extraTakes) {
    const { extraHash: stored, ...body } = extra
    assertDomain(
      stored === calculateCanonicalHash(body) &&
      ['review-required', 'accepted', 'rejected'].includes(
        extra.reviewStatus,
      ),
      'PERSISTENCE_CONFLICT',
      `Script extra take ${extra.id} failed integrity validation`,
    )
  }
  const { runHash: storedRunHash, ...body } = value
  assertDomain(
    storedRunHash === runHash(body),
    'PERSISTENCE_CONFLICT',
    'Script alignment run hash failed integrity validation',
  )
  assertDomain(
    value.alignments.length === value.document.blocks.length,
    'PERSISTENCE_CONFLICT',
    'Script alignment run cardinality failed integrity validation',
  )
  assertDomain(
    stableSerialize(summary(value.alignments, value.extraTakes)) ===
      stableSerialize(value.summary),
    'PERSISTENCE_CONFLICT',
    'Script alignment run summary failed integrity validation',
  )
  return Object.freeze(value)
}
