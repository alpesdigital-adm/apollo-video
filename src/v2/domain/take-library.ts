import {
  calculateCanonicalHash,
  stableSerialize,
} from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import {
  SCRIPT_BLOCK_ROLES,
  type ScriptAlignmentCandidate,
  type ScriptAlignmentRun,
  type ScriptBlockAlignment,
  type ScriptBlockRole,
  type ScriptExtraTake,
} from './script-alignment.ts'

export const TAKE_LIBRARY_SCHEMA_VERSION = 'take-library/v1' as const
export const TAKE_GROUPING_POLICY_VERSION =
  'script-block-or-intention/v1' as const
export const TAKE_EVALUATION_POLICY_VERSION =
  'five-dimension-take-quality/v1' as const

export const TAKE_DIMENSIONS = [
  'completeness',
  'performance',
  'audio',
  'video',
  'integrity',
] as const

export type TakeDimension = (typeof TAKE_DIMENSIONS)[number]
export type TakeStatus =
  'primary' | 'alternate' | 'rejected' | 'needs-review'
export type TakeLibraryStatus =
  'completed' | 'review-required' | 'reviewed'
export type TakeSourceKind = 'alignment-candidate' | 'extra-take'
export type TakeIntentionRole = ScriptBlockRole | 'other'
export type TakeEvaluationState = 'measured' | 'derived' | 'unavailable'
export type TakeSelectionSource = 'automatic' | 'manual'

export interface TakeDimensionEvaluation {
  dimension: TakeDimension
  score: number | null
  state: TakeEvaluationState
  evaluatorVersion: string
  evidenceRefs: readonly string[]
  reasonCodes: readonly string[]
  evaluationHash: string
}

export interface TakeGroupAssignment {
  kind: 'script-block' | 'inferred-intention'
  role: TakeIntentionRole
  label: string
  confidence: number
  evidenceRefs: readonly string[]
  scriptBlockId?: string
  assignmentHash: string
}

export interface TakeRecord {
  id: string
  groupId: string
  retakeBoundaryId: string
  sourceKind: TakeSourceKind
  sourceId: string
  sourceHash: string
  transcriptId: string
  sourceArtifactId: string
  sourceRangeMs: readonly [number, number]
  evidenceWordIndices: readonly number[]
  spokenText: string
  normalizedSpokenText: string
  assignment: Readonly<TakeGroupAssignment>
  evaluations: readonly Readonly<TakeDimensionEvaluation>[]
  weightedScore: number | null
  status: TakeStatus
  protected: boolean
  selectionSource: TakeSelectionSource
  reasonCodes: readonly string[]
  takeHash: string
}

export interface TakeGroup {
  id: string
  key: string
  assignmentKind: TakeGroupAssignment['kind']
  role: TakeIntentionRole
  label: string
  scriptBlockId?: string
  takeIds: readonly string[]
  primaryTakeId?: string
  protectedTakeId?: string
  groupHash: string
}

export interface TakeLibrarySelection {
  id: string
  revision: number
  groupId: string
  takeId: string
  protect: boolean
  replacedProtectedTakeId?: string
  note?: string
  actorClientId: string
  createdAt: string
  selectionHash: string
}

export interface TakeLibrarySummary {
  groupCount: number
  takeCount: number
  primaryCount: number
  alternateCount: number
  rejectedCount: number
  needsReviewCount: number
  protectedCount: number
  measuredDimensionCount: number
  unavailableDimensionCount: number
  averageWeightedScore: number
}

export interface TakeLibraryRun {
  id: string
  workspaceId: string
  projectId: string
  batchId: string
  alignmentId: string
  alignmentRunHash: string
  schemaVersion: typeof TAKE_LIBRARY_SCHEMA_VERSION
  groupingPolicyVersion: typeof TAKE_GROUPING_POLICY_VERSION
  evaluationPolicyVersion: typeof TAKE_EVALUATION_POLICY_VERSION
  status: TakeLibraryStatus
  revision: number
  groups: readonly Readonly<TakeGroup>[]
  takes: readonly Readonly<TakeRecord>[]
  selections: readonly Readonly<TakeLibrarySelection>[]
  summary: Readonly<TakeLibrarySummary>
  createdByClientId: string
  createdAt: string
  updatedAt: string
  runHash: string
}

export interface TakeMeasuredDimensionInput {
  dimension: TakeDimension
  score: number
  evaluatorVersion: string
  evidenceRefs: readonly string[]
  reasonCodes?: readonly string[]
}

export interface TakeSourceEvaluationInput {
  sourceKind: TakeSourceKind
  sourceId: string
  expectedSourceHash: string
  dimensions: readonly TakeMeasuredDimensionInput[]
  inferredIntention?: Readonly<{
    role: TakeIntentionRole
    label: string
    confidence: number
    evidenceRefs: readonly string[]
  }>
}

export interface CreateTakeLibraryRunInput {
  id: string
  workspaceId: string
  projectId: string
  batchId: string
  alignment: Readonly<ScriptAlignmentRun>
  evaluations: readonly TakeSourceEvaluationInput[]
  createdByClientId: string
  createdAt: string
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
const REASON = /^[A-Z][A-Z0-9_]{2,79}$/
const INTENTION_WORDS = new Set([
  'a',
  'as',
  'ao',
  'aos',
  'de',
  'da',
  'das',
  'do',
  'dos',
  'e',
  'em',
  'o',
  'os',
  'para',
  'que',
  'the',
  'to',
  'and',
  'of',
])
const DIMENSION_WEIGHT: Readonly<Record<TakeDimension, number>> = {
  completeness: 0.28,
  performance: 0.22,
  audio: 0.18,
  video: 0.14,
  integrity: 0.18,
}

function identity(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && TOKEN.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function boundedText(
  value: unknown,
  field: string,
  minimum = 1,
  maximum = 500,
): string {
  assertDomain(
    typeof value === 'string' &&
    value.trim().length >= minimum &&
    value.trim().length <= maximum,
    'INVALID_ARGUMENT',
    `${field} must contain ${minimum} to ${maximum} characters`,
  )
  return value.trim()
}

function instant(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && Number.isFinite(Date.parse(value)),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return new Date(value).toISOString()
}

function unit(value: unknown, field: string): number {
  assertDomain(
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1,
    'INVALID_ARGUMENT',
    `${field} must be between 0 and 1`,
  )
  return Number(value.toFixed(6))
}

function uniqueTokens(
  values: unknown,
  field: string,
  maximum = 100,
): readonly string[] {
  assertDomain(
    Array.isArray(values) && values.length <= maximum,
    'INVALID_ARGUMENT',
    `${field} must contain at most ${maximum} entries`,
  )
  const tokens = values.map((value, index) =>
    identity(value, `${field}[${index}]`))
  assertDomain(
    new Set(tokens).size === tokens.length,
    'INVALID_ARGUMENT',
    `${field} must not contain duplicates`,
  )
  return Object.freeze(tokens)
}

function uniqueReasonCodes(
  values: unknown,
  field: string,
): readonly string[] {
  assertDomain(
    Array.isArray(values) && values.length <= 50,
    'INVALID_ARGUMENT',
    `${field} must contain at most 50 entries`,
  )
  const codes = values.map((value, index) => {
    assertDomain(
      typeof value === 'string' && REASON.test(value),
      'INVALID_ARGUMENT',
      `${field}[${index}] is invalid`,
    )
    return value
  })
  assertDomain(
    new Set(codes).size === codes.length,
    'INVALID_ARGUMENT',
    `${field} must not contain duplicates`,
  )
  return Object.freeze(codes)
}

function rounded(value: number): number {
  return Number(value.toFixed(6))
}

function isArray(value: unknown): boolean {
  return Array.isArray(value)
}

function deduplicatedSorted(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort())
}

function assignmentBody(
  value: Omit<TakeGroupAssignment, 'assignmentHash'>,
) {
  return {
    kind: value.kind,
    role: value.role,
    label: value.label,
    confidence: value.confidence,
    evidenceRefs: value.evidenceRefs,
    ...(value.scriptBlockId
      ? { scriptBlockId: value.scriptBlockId }
      : {}),
  }
}

function assignment(
  value: Omit<TakeGroupAssignment, 'assignmentHash'>,
): Readonly<TakeGroupAssignment> {
  const body = assignmentBody({
    ...value,
    confidence: unit(value.confidence, 'assignment.confidence'),
  })
  return Object.freeze({
    ...body,
    assignmentHash: calculateCanonicalHash(body),
  })
}

function evaluationBody(
  value: Omit<TakeDimensionEvaluation, 'evaluationHash'>,
) {
  return {
    dimension: value.dimension,
    score: value.score,
    state: value.state,
    evaluatorVersion: value.evaluatorVersion,
    evidenceRefs: value.evidenceRefs,
    reasonCodes: value.reasonCodes,
  }
}

function dimensionEvaluation(
  value: Omit<TakeDimensionEvaluation, 'evaluationHash'>,
): Readonly<TakeDimensionEvaluation> {
  const body = evaluationBody(value)
  return Object.freeze({
    ...body,
    evaluationHash: calculateCanonicalHash(body),
  })
}

function measuredDimension(
  value: TakeMeasuredDimensionInput,
  field: string,
): Readonly<TakeDimensionEvaluation> {
  assertDomain(
    TAKE_DIMENSIONS.includes(value?.dimension),
    'INVALID_ARGUMENT',
    `${field}.dimension is invalid`,
  )
  return dimensionEvaluation({
    dimension: value.dimension,
    score: unit(value.score, `${field}.score`),
    state: 'measured',
    evaluatorVersion: identity(
      value.evaluatorVersion,
      `${field}.evaluatorVersion`,
    ),
    evidenceRefs: uniqueTokens(
      value.evidenceRefs,
      `${field}.evidenceRefs`,
      50,
    ),
    reasonCodes: uniqueReasonCodes(
      value.reasonCodes ?? [],
      `${field}.reasonCodes`,
    ),
  })
}

function derivedDimension(
  dimension: TakeDimension,
  score: number,
  reasonCodes: readonly string[],
  evidenceRefs: readonly string[],
): Readonly<TakeDimensionEvaluation> {
  return dimensionEvaluation({
    dimension,
    score: rounded(Math.max(0, Math.min(1, score))),
    state: 'derived',
    evaluatorVersion: TAKE_EVALUATION_POLICY_VERSION,
    evidenceRefs: deduplicatedSorted(evidenceRefs),
    reasonCodes: deduplicatedSorted(reasonCodes),
  })
}

function unavailableDimension(
  dimension: TakeDimension,
  reasonCode: string,
  sourceHash: string,
): Readonly<TakeDimensionEvaluation> {
  return dimensionEvaluation({
    dimension,
    score: null,
    state: 'unavailable',
    evaluatorVersion: TAKE_EVALUATION_POLICY_VERSION,
    evidenceRefs: Object.freeze([sourceHash]),
    reasonCodes: Object.freeze([reasonCode]),
  })
}

function normalizedWords(value: string): readonly string[] {
  return Object.freeze(
    value
      .normalize('NFKD')
      .replace(/\p{Diacritic}/gu, '')
      .toLocaleLowerCase('pt-BR')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .split(/\s+/u)
      .filter(Boolean),
  )
}

function inferIntention(
  text: string,
  evidenceRef: string,
): Readonly<TakeGroupAssignment> {
  const words = normalizedWords(text)
  const joined = words.join(' ')
  const has = (tokens: readonly string[]) =>
    tokens.some((token) => joined.includes(token))
  let role: TakeIntentionRole = 'body'
  let confidence = 0.55
  const reasons = [evidenceRef]
  if (has([
    'clique',
    'chame',
    'fale com',
    'whatsapp',
    'baixe',
    'agende',
    'inscreva',
    'preencha',
    'compre',
  ])) {
    role = 'cta'
    confidence = 0.76
  } else if (has([
    'depoimento',
    'resultado',
    'comprov',
    'clientes',
    'por cento',
    'casos',
  ])) {
    role = 'proof'
    confidence = 0.69
  } else if (
    words.length <= 24 &&
    has(['voce', 'sabia', 'pare', 'imagine', 'segredo', 'erro'])
  ) {
    role = 'hook'
    confidence = 0.64
  } else if (words.length < 4) {
    role = 'other'
    confidence = 0.35
  }
  const labelWords = words
    .filter((word) => !INTENTION_WORDS.has(word))
    .slice(0, 8)
  const label = labelWords.length > 0
    ? `${role}:${labelWords.join('-')}`
    : `${role}:sem-contexto`
  return assignment({
    kind: 'inferred-intention',
    role,
    label: boundedText(label, 'inferred intention label', 1, 240),
    confidence: rounded(confidence),
    evidenceRefs: Object.freeze(reasons),
  })
}

function suppliedIntention(
  value: NonNullable<TakeSourceEvaluationInput['inferredIntention']>,
  sourceHash: string,
  field: string,
): Readonly<TakeGroupAssignment> {
  assertDomain(
    [...SCRIPT_BLOCK_ROLES, 'other'].includes(value?.role),
    'INVALID_ARGUMENT',
    `${field}.role is invalid`,
  )
  const refs = uniqueTokens(
    value.evidenceRefs,
    `${field}.evidenceRefs`,
    50,
  )
  assertDomain(
    refs.length > 0,
    'INVALID_ARGUMENT',
    `${field}.evidenceRefs must not be empty`,
  )
  return assignment({
    kind: 'inferred-intention',
    role: value.role,
    label: boundedText(value.label, `${field}.label`, 1, 240),
    confidence: unit(value.confidence, `${field}.confidence`),
    evidenceRefs: deduplicatedSorted([...refs, sourceHash]),
  })
}

function blockAssignment(
  alignment: Readonly<ScriptBlockAlignment>,
  blockLabel: string,
  candidateHash: string,
): Readonly<TakeGroupAssignment> {
  return assignment({
    kind: 'script-block',
    role: alignment.role,
    label: blockLabel,
    confidence: alignment.confidence / 100,
    evidenceRefs: Object.freeze([
      alignment.alignmentHash,
      candidateHash,
    ]),
    scriptBlockId: alignment.blockId,
  })
}

interface TakeSourceDraft {
  sourceKind: TakeSourceKind
  sourceId: string
  sourceHash: string
  transcriptId: string
  sourceArtifactId: string
  sourceRangeMs: readonly [number, number]
  evidenceWordIndices: readonly number[]
  spokenText: string
  normalizedSpokenText: string
  assignment: Readonly<TakeGroupAssignment>
  sourceReasonCodes: readonly string[]
  candidate?: Readonly<ScriptAlignmentCandidate>
  extra?: Readonly<ScriptExtraTake>
}

function sourceKey(value: {
  sourceKind: TakeSourceKind
  sourceId: string
}): string {
  return `${value.sourceKind}:${value.sourceId}`
}

function sourceDrafts(
  alignment: Readonly<ScriptAlignmentRun>,
  evaluations: ReadonlyMap<string, TakeSourceEvaluationInput>,
): readonly Readonly<TakeSourceDraft>[] {
  const blocks = new Map(
    alignment.document.blocks.map((block) => [block.id, block]),
  )
  const candidates = new Map<string, {
    candidate: Readonly<ScriptAlignmentCandidate>
    alignments: ScriptBlockAlignment[]
  }>()
  for (const blockAlignment of alignment.alignments) {
    for (const candidate of [
      ...(blockAlignment.selectedCandidate
        ? [blockAlignment.selectedCandidate]
        : []),
      ...blockAlignment.alternatives,
    ]) {
      const key = sourceKey({
        sourceKind: 'alignment-candidate',
        sourceId: candidate.id,
      })
      const current = candidates.get(key)
      if (current) {
        assertDomain(
          current.candidate.candidateHash === candidate.candidateHash,
          'INVALID_ARGUMENT',
          `Alignment candidate ${candidate.id} has conflicting hashes`,
        )
        current.alignments.push(blockAlignment)
      } else {
        candidates.set(key, {
          candidate,
          alignments: [blockAlignment],
        })
      }
    }
  }
  const drafts: TakeSourceDraft[] = []
  for (const [key, value] of candidates) {
    const distinctBlocks = [
      ...new Map(
        value.alignments.map((entry) => [entry.blockId, entry]),
      ).values(),
    ]
    const selectedBlocks = distinctBlocks.filter((entry) =>
      entry.selectedCandidate?.id === value.candidate.id)
    const chosenPool = selectedBlocks.length > 0
      ? selectedBlocks
      : distinctBlocks
    const chosen = chosenPool
      .toSorted((left, right) =>
        right.confidence - left.confidence ||
        left.documentOrder - right.documentOrder)[0]!
    const block = blocks.get(chosen.blockId)
    assertDomain(
      Boolean(block),
      'INVALID_ARGUMENT',
      `Script block ${chosen.blockId} is missing`,
    )
    const ambiguous = chosenPool.length > 1
    const evaluation = evaluations.get(key)
    const chosenAssignment = ambiguous
      ? (
          evaluation?.inferredIntention
            ? suppliedIntention(
                evaluation.inferredIntention,
                value.candidate.candidateHash,
                `${key}.inferredIntention`,
              )
            : inferIntention(
                value.candidate.spokenText,
                value.candidate.candidateHash,
              )
        )
      : blockAssignment(
          chosen,
          block!.originalLabel,
          value.candidate.candidateHash,
        )
    drafts.push({
      sourceKind: 'alignment-candidate',
      sourceId: value.candidate.id,
      sourceHash: value.candidate.candidateHash,
      transcriptId: value.candidate.transcriptId,
      sourceArtifactId: value.candidate.sourceArtifactId,
      sourceRangeMs: value.candidate.sourceRangeMs,
      evidenceWordIndices: value.candidate.evidenceWordIndices,
      spokenText: value.candidate.spokenText,
      normalizedSpokenText: value.candidate.normalizedSpokenText,
      assignment: chosenAssignment,
      sourceReasonCodes: Object.freeze([
        ...(ambiguous ? ['AMBIGUOUS_SCRIPT_BLOCK'] : []),
        ...value.candidate.deviations.map((deviation) =>
          deviation.reasonCode),
      ]),
      candidate: value.candidate,
    })
  }
  for (const extra of alignment.extraTakes) {
    const key = sourceKey({
      sourceKind: 'extra-take',
      sourceId: extra.id,
    })
    const evaluation = evaluations.get(key)
    drafts.push({
      sourceKind: 'extra-take',
      sourceId: extra.id,
      sourceHash: extra.extraHash,
      transcriptId: extra.transcriptId,
      sourceArtifactId: extra.sourceArtifactId,
      sourceRangeMs: extra.sourceRangeMs,
      evidenceWordIndices: extra.evidenceWordIndices,
      spokenText: extra.spokenText,
      normalizedSpokenText: extra.normalizedSpokenText,
      assignment: evaluation?.inferredIntention
        ? suppliedIntention(
            evaluation.inferredIntention,
            extra.extraHash,
            `${key}.inferredIntention`,
          )
        : inferIntention(extra.spokenText, extra.extraHash),
      sourceReasonCodes: Object.freeze([
        'SOURCE_EXTRA_TAKE',
        ...(extra.reviewStatus === 'rejected'
          ? ['SOURCE_REVIEW_REJECTED']
          : []),
      ]),
      extra,
    })
  }
  return Object.freeze(
    drafts.toSorted((left, right) =>
      alignment.sourceRefs.findIndex((source) =>
        source.transcriptId === left.transcriptId) -
      alignment.sourceRefs.findIndex((source) =>
        source.transcriptId === right.transcriptId) ||
      left.sourceRangeMs[0] - right.sourceRangeMs[0] ||
      left.sourceRangeMs[1] - right.sourceRangeMs[1] ||
      left.sourceId.localeCompare(right.sourceId)),
  )
}

function inputEvaluations(
  values: readonly TakeSourceEvaluationInput[],
): ReadonlyMap<string, TakeSourceEvaluationInput> {
  assertDomain(
    isArray(values) && values.length <= 2_000,
    'INVALID_ARGUMENT',
    'evaluations must contain at most 2000 entries',
  )
  const result = new Map<string, TakeSourceEvaluationInput>()
  for (const [index, value] of values.entries()) {
    assertDomain(
      value?.sourceKind === 'alignment-candidate' ||
      value?.sourceKind === 'extra-take',
      'INVALID_ARGUMENT',
      `evaluations[${index}].sourceKind is invalid`,
    )
    const sourceId = identity(
      value.sourceId,
      `evaluations[${index}].sourceId`,
    )
    assertDomain(
      HASH.test(value.expectedSourceHash ?? ''),
      'INVALID_ARGUMENT',
      `evaluations[${index}].expectedSourceHash is invalid`,
    )
    assertDomain(
      isArray(value.dimensions) &&
      value.dimensions.length <= TAKE_DIMENSIONS.length,
      'INVALID_ARGUMENT',
      `evaluations[${index}].dimensions is invalid`,
    )
    const dimensions = value.dimensions.map((dimension, dimensionIndex) =>
      measuredDimension(
        dimension,
        `evaluations[${index}].dimensions[${dimensionIndex}]`,
      ))
    assertDomain(
      new Set(dimensions.map((dimension) => dimension.dimension)).size ===
      dimensions.length,
      'INVALID_ARGUMENT',
      `evaluations[${index}].dimensions contains duplicates`,
    )
    const key = sourceKey({
      sourceKind: value.sourceKind,
      sourceId,
    })
    assertDomain(
      !result.has(key),
      'INVALID_ARGUMENT',
      `Evaluation ${key} is duplicated`,
    )
    result.set(key, Object.freeze({
      sourceKind: value.sourceKind,
      sourceId,
      expectedSourceHash: value.expectedSourceHash,
      dimensions: Object.freeze(dimensions.map((dimension) =>
        Object.freeze({
          dimension: dimension.dimension,
          score: dimension.score!,
          evaluatorVersion: dimension.evaluatorVersion,
          evidenceRefs: dimension.evidenceRefs,
          reasonCodes: dimension.reasonCodes,
        }))),
      ...(value.inferredIntention
        ? { inferredIntention: value.inferredIntention }
        : {}),
    }))
  }
  return result
}

function defaultEvaluations(
  source: Readonly<TakeSourceDraft>,
): readonly Readonly<TakeDimensionEvaluation>[] {
  if (source.candidate) {
    const candidate = source.candidate
    const deviationKinds = new Set(
      candidate.deviations.map((deviation) => deviation.kind),
    )
    const integrityPenalty =
      (deviationKinds.has('number-claim-change') ? 0.35 : 0) +
      (deviationKinds.has('qualifier-change') ? 0.2 : 0) +
      (deviationKinds.has('incomplete-ending') ? 0.2 : 0) +
      (deviationKinds.has('off-script') ? 0.25 : 0)
    return Object.freeze([
      derivedDimension(
        'completeness',
        (
          candidate.metrics.lexicalCoverage +
          candidate.metrics.boundaryCompleteness
        ) / 2,
        ['DERIVED_FROM_ALIGNMENT_COVERAGE'],
        [candidate.candidateHash],
      ),
      derivedDimension(
        'performance',
        Math.max(
          0,
          candidate.metrics.durationPlausibility -
          (deviationKinds.has('restart') ? 0.25 : 0),
        ),
        ['DERIVED_FROM_DELIVERY_TIMING'],
        [candidate.candidateHash],
      ),
      unavailableDimension(
        'audio',
        'AUDIO_MEASUREMENT_REQUIRED',
        candidate.candidateHash,
      ),
      unavailableDimension(
        'video',
        'VIDEO_MEASUREMENT_REQUIRED',
        candidate.candidateHash,
      ),
      derivedDimension(
        'integrity',
        1 - integrityPenalty,
        ['DERIVED_FROM_TEXT_DEVIATIONS'],
        [candidate.candidateHash],
      ),
    ])
  }
  const extra = source.extra!
  return Object.freeze([
    derivedDimension(
      'completeness',
      source.assignment.confidence,
      ['DERIVED_FROM_INFERRED_INTENTION'],
      [extra.extraHash],
    ),
    unavailableDimension(
      'performance',
      'PERFORMANCE_MEASUREMENT_REQUIRED',
      extra.extraHash,
    ),
    unavailableDimension(
      'audio',
      'AUDIO_MEASUREMENT_REQUIRED',
      extra.extraHash,
    ),
    unavailableDimension(
      'video',
      'VIDEO_MEASUREMENT_REQUIRED',
      extra.extraHash,
    ),
    derivedDimension(
      'integrity',
      extra.reviewStatus === 'rejected'
        ? 0
        : extra.reviewStatus === 'accepted'
          ? 0.85
          : 0.6,
      ['DERIVED_FROM_EXTRA_TAKE_REVIEW'],
      [extra.extraHash],
    ),
  ])
}

function resolvedEvaluations(
  source: Readonly<TakeSourceDraft>,
  supplied: TakeSourceEvaluationInput | undefined,
): readonly Readonly<TakeDimensionEvaluation>[] {
  assertDomain(
    !supplied || supplied.expectedSourceHash === source.sourceHash,
    'VERSION_CONFLICT',
    `Take source ${source.sourceId} changed before evaluation`,
  )
  const defaults = new Map(
    defaultEvaluations(source).map((entry) => [entry.dimension, entry]),
  )
  for (const [index, dimension] of (
    supplied?.dimensions ?? []
  ).entries()) {
    const measured = measuredDimension(
      dimension,
      `${sourceKey(source)}.dimensions[${index}]`,
    )
    defaults.set(measured.dimension, measured)
  }
  return Object.freeze(
    TAKE_DIMENSIONS.map((dimension) => defaults.get(dimension)!),
  )
}

function weightedScore(
  values: readonly Readonly<TakeDimensionEvaluation>[],
): number | null {
  if (values.some((value) => value.score === null)) return null
  return rounded(values.reduce(
    (sum, value) =>
      sum + value.score! * DIMENSION_WEIGHT[value.dimension],
    0,
  ))
}

function groupKey(value: Readonly<TakeGroupAssignment>): string {
  return value.kind === 'script-block'
    ? `script-block:${value.scriptBlockId}`
    : `intention:${value.role}:${normalizedWords(value.label).join('-')}`
}

function takeBody(value: Omit<TakeRecord, 'takeHash'>) {
  return {
    id: value.id,
    groupId: value.groupId,
    retakeBoundaryId: value.retakeBoundaryId,
    sourceKind: value.sourceKind,
    sourceId: value.sourceId,
    sourceHash: value.sourceHash,
    transcriptId: value.transcriptId,
    sourceArtifactId: value.sourceArtifactId,
    sourceRangeMs: value.sourceRangeMs,
    evidenceWordIndices: value.evidenceWordIndices,
    spokenText: value.spokenText,
    normalizedSpokenText: value.normalizedSpokenText,
    assignment: value.assignment,
    evaluations: value.evaluations,
    weightedScore: value.weightedScore,
    status: value.status,
    protected: value.protected,
    selectionSource: value.selectionSource,
    reasonCodes: value.reasonCodes,
  }
}

function takeRecord(
  value: Omit<TakeRecord, 'takeHash'>,
): Readonly<TakeRecord> {
  const body = takeBody(value)
  return Object.freeze({
    ...body,
    takeHash: calculateCanonicalHash(body),
  })
}

function groupBody(value: Omit<TakeGroup, 'groupHash'>) {
  return {
    id: value.id,
    key: value.key,
    assignmentKind: value.assignmentKind,
    role: value.role,
    label: value.label,
    ...(value.scriptBlockId
      ? { scriptBlockId: value.scriptBlockId }
      : {}),
    takeIds: value.takeIds,
    ...(value.primaryTakeId
      ? { primaryTakeId: value.primaryTakeId }
      : {}),
    ...(value.protectedTakeId
      ? { protectedTakeId: value.protectedTakeId }
      : {}),
  }
}

function takeGroup(
  value: Omit<TakeGroup, 'groupHash'>,
): Readonly<TakeGroup> {
  const body = groupBody(value)
  return Object.freeze({
    ...body,
    groupHash: calculateCanonicalHash(body),
  })
}

function classifyGroup(
  drafts: readonly Readonly<TakeRecord>[],
): readonly Readonly<TakeRecord>[] {
  const rejected = new Set<string>()
  const review = new Set<string>()
  for (const take of drafts) {
    const integrity = take.evaluations.find((entry) =>
      entry.dimension === 'integrity')!
    if (
      (integrity.score !== null && integrity.score < 0.5) ||
      take.reasonCodes.includes('SOURCE_REVIEW_REJECTED')
    ) {
      rejected.add(take.id)
      continue
    }
    if (
      take.weightedScore === null ||
      take.weightedScore < 0.65 ||
      take.assignment.confidence < 0.6 ||
      take.reasonCodes.includes('AMBIGUOUS_SCRIPT_BLOCK') ||
      take.reasonCodes.some((code) =>
        [
          'NUMBER_CLAIM_CHANGE',
          'QUALIFIER_CHANGE',
          'INCOMPLETE_ENDING',
        ].includes(code))
    ) {
      review.add(take.id)
    }
  }
  const eligible = drafts
    .filter((take) => !rejected.has(take.id) && !review.has(take.id))
    .toSorted((left, right) =>
      right.weightedScore! - left.weightedScore! ||
      left.sourceRangeMs[0] - right.sourceRangeMs[0] ||
      left.id.localeCompare(right.id))
  if (
    eligible.length > 1 &&
    eligible[0]!.weightedScore! - eligible[1]!.weightedScore! < 0.02
  ) {
    review.add(eligible[0]!.id)
    review.add(eligible[1]!.id)
  }
  const primary = eligible.find((take) => !review.has(take.id))?.id
  return Object.freeze(drafts.map((take) => {
    const status: TakeStatus = rejected.has(take.id)
      ? 'rejected'
      : review.has(take.id)
        ? 'needs-review'
        : take.id === primary
          ? 'primary'
          : 'alternate'
    const reasons = deduplicatedSorted([
      ...take.reasonCodes,
      ...(status === 'rejected'
        ? ['TAKE_INTEGRITY_REJECTED']
        : []),
      ...(status === 'needs-review'
        ? ['TAKE_REVIEW_REQUIRED']
        : []),
      ...(status === 'primary'
        ? ['TAKE_AUTOMATIC_PRIMARY']
        : []),
      ...(status === 'alternate'
        ? ['TAKE_AUTOMATIC_ALTERNATE']
        : []),
    ])
    return takeRecord({
      ...take,
      status,
      reasonCodes: reasons,
    })
  }))
}

function createTakesAndGroups(
  alignment: Readonly<ScriptAlignmentRun>,
  supplied: ReadonlyMap<string, TakeSourceEvaluationInput>,
): Readonly<{
  takes: readonly Readonly<TakeRecord>[]
  groups: readonly Readonly<TakeGroup>[]
}> {
  const allDrafts = sourceDrafts(alignment, supplied)
  assertDomain(
    allDrafts.length >= 1 && allDrafts.length <= 2_000,
    'INVALID_ARGUMENT',
    'Alignment must expose 1 to 2000 take boundaries',
  )
  const sourceKeys = new Set(allDrafts.map((draft) => sourceKey(draft)))
  for (const key of supplied.keys()) {
    assertDomain(
      sourceKeys.has(key),
      'INVALID_ARGUMENT',
      `Evaluation ${key} does not belong to the alignment`,
    )
  }
  const selectedCandidateIds = new Set(
    alignment.alignments.flatMap((entry) =>
      entry.selectedCandidate ? [entry.selectedCandidate.id] : []),
  )
  const boundaryDrafts = new Map<string, TakeSourceDraft[]>()
  for (const draft of allDrafts) {
    const boundaryKey = calculateCanonicalHash({
      transcriptId: draft.transcriptId,
      sourceArtifactId: draft.sourceArtifactId,
      sourceRangeMs: draft.sourceRangeMs,
      evidenceWordIndices: draft.evidenceWordIndices,
    })
    boundaryDrafts.set(boundaryKey, [
      ...(boundaryDrafts.get(boundaryKey) ?? []),
      draft,
    ])
  }
  const drafts = [...boundaryDrafts.values()].map((aliases) =>
    aliases.toSorted((left, right) =>
      Number(selectedCandidateIds.has(right.sourceId)) -
        Number(selectedCandidateIds.has(left.sourceId)) ||
      (right.candidate?.metrics.total ?? 0) -
        (left.candidate?.metrics.total ?? 0) ||
      left.sourceId.localeCompare(right.sourceId))[0]!)
  const grouped = new Map<string, TakeRecord[]>()
  for (const draft of drafts) {
    const key = groupKey(draft.assignment)
    const groupId = `take-group-${calculateCanonicalHash({
      alignmentId: alignment.id,
      key,
    }).slice(0, 48)}`
    const boundaryHash = calculateCanonicalHash({
      transcriptId: draft.transcriptId,
      sourceArtifactId: draft.sourceArtifactId,
      sourceRangeMs: draft.sourceRangeMs,
      evidenceWordIndices: draft.evidenceWordIndices,
    })
    const retakeBoundaryId = `retake-boundary-${boundaryHash.slice(0, 48)}`
    const id = `take-${calculateCanonicalHash({
      alignmentId: alignment.id,
      groupId,
      retakeBoundaryId,
      sourceHash: draft.sourceHash,
    }).slice(0, 48)}`
    const evaluations = resolvedEvaluations(
      draft,
      supplied.get(sourceKey(draft)),
    )
    const record = takeRecord({
      id,
      groupId,
      retakeBoundaryId,
      sourceKind: draft.sourceKind,
      sourceId: draft.sourceId,
      sourceHash: draft.sourceHash,
      transcriptId: draft.transcriptId,
      sourceArtifactId: draft.sourceArtifactId,
      sourceRangeMs: draft.sourceRangeMs,
      evidenceWordIndices: Object.freeze([...draft.evidenceWordIndices]),
      spokenText: draft.spokenText,
      normalizedSpokenText: draft.normalizedSpokenText,
      assignment: draft.assignment,
      evaluations,
      weightedScore: weightedScore(evaluations),
      status: 'needs-review',
      protected: false,
      selectionSource: 'automatic',
      reasonCodes: deduplicatedSorted(draft.sourceReasonCodes),
    })
    grouped.set(key, [...(grouped.get(key) ?? []), record])
  }
  const groups: TakeGroup[] = []
  const takes: TakeRecord[] = []
  for (const [key, groupDrafts] of grouped) {
    const classified = classifyGroup(groupDrafts)
    const representative = classified[0]!
    const primary = classified.find((take) => take.status === 'primary')
    groups.push(takeGroup({
      id: representative.groupId,
      key,
      assignmentKind: representative.assignment.kind,
      role: representative.assignment.role,
      label: representative.assignment.label,
      ...(representative.assignment.scriptBlockId
        ? { scriptBlockId: representative.assignment.scriptBlockId }
        : {}),
      takeIds: Object.freeze(classified.map((take) => take.id)),
      ...(primary ? { primaryTakeId: primary.id } : {}),
    }))
    takes.push(...classified)
  }
  const orderedGroups = groups.toSorted((left, right) =>
    left.key.localeCompare(right.key))
  const groupOrder = new Map(
    orderedGroups.map((group, index) => [group.id, index]),
  )
  const orderedTakes = takes.toSorted((left, right) =>
    groupOrder.get(left.groupId)! - groupOrder.get(right.groupId)! ||
    left.sourceRangeMs[0] - right.sourceRangeMs[0] ||
    left.sourceRangeMs[1] - right.sourceRangeMs[1] ||
    left.id.localeCompare(right.id))
  assertDomain(
    new Set(orderedTakes.map((take) => take.retakeBoundaryId)).size ===
    orderedTakes.length,
    'INVALID_ARGUMENT',
    'Every take must have a unique retake boundary',
  )
  return Object.freeze({
    groups: Object.freeze(orderedGroups),
    takes: Object.freeze(orderedTakes),
  })
}

function summary(
  groups: readonly Readonly<TakeGroup>[],
  takes: readonly Readonly<TakeRecord>[],
): Readonly<TakeLibrarySummary> {
  const numericScores = takes
    .map((take) => take.weightedScore)
    .filter((value): value is number => value !== null)
  return Object.freeze({
    groupCount: groups.length,
    takeCount: takes.length,
    primaryCount: takes.filter((take) => take.status === 'primary').length,
    alternateCount: takes.filter((take) =>
      take.status === 'alternate').length,
    rejectedCount: takes.filter((take) =>
      take.status === 'rejected').length,
    needsReviewCount: takes.filter((take) =>
      take.status === 'needs-review').length,
    protectedCount: takes.filter((take) => take.protected).length,
    measuredDimensionCount: takes.reduce(
      (count, take) =>
        count + take.evaluations.filter((entry) =>
          entry.state === 'measured').length,
      0,
    ),
    unavailableDimensionCount: takes.reduce(
      (count, take) =>
        count + take.evaluations.filter((entry) =>
          entry.state === 'unavailable').length,
      0,
    ),
    averageWeightedScore: numericScores.length > 0
      ? rounded(
          numericScores.reduce((sum, value) => sum + value, 0) /
          numericScores.length,
        )
      : 0,
  })
}

function runBody(value: Omit<TakeLibraryRun, 'runHash'>) {
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    projectId: value.projectId,
    batchId: value.batchId,
    alignmentId: value.alignmentId,
    alignmentRunHash: value.alignmentRunHash,
    schemaVersion: value.schemaVersion,
    groupingPolicyVersion: value.groupingPolicyVersion,
    evaluationPolicyVersion: value.evaluationPolicyVersion,
    status: value.status,
    revision: value.revision,
    groups: value.groups,
    takes: value.takes,
    selections: value.selections,
    summary: value.summary,
    createdByClientId: value.createdByClientId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

function frozenRun(
  value: Omit<TakeLibraryRun, 'runHash'>,
): Readonly<TakeLibraryRun> {
  const body = runBody(value)
  return Object.freeze({
    ...body,
    runHash: calculateCanonicalHash(body),
  })
}

function deriveStatus(
  takes: readonly Readonly<TakeRecord>[],
  selections: readonly Readonly<TakeLibrarySelection>[],
): TakeLibraryStatus {
  if (takes.some((take) => take.status === 'needs-review')) {
    return 'review-required'
  }
  return selections.length > 0 ? 'reviewed' : 'completed'
}

export function createTakeLibraryRun(
  input: Readonly<CreateTakeLibraryRunInput>,
): Readonly<TakeLibraryRun> {
  assertDomain(
    input.alignment.workspaceId === input.workspaceId &&
    input.alignment.projectId === input.projectId &&
    input.alignment.batchId === input.batchId,
    'INVALID_ARGUMENT',
    'Alignment does not belong to the requested take library context',
  )
  const supplied = inputEvaluations(input.evaluations)
  const result = createTakesAndGroups(input.alignment, supplied)
  const createdAt = instant(input.createdAt, 'createdAt')
  const selections = Object.freeze([]) as readonly TakeLibrarySelection[]
  return frozenRun({
    id: identity(input.id, 'takeLibraryId'),
    workspaceId: identity(input.workspaceId, 'workspaceId'),
    projectId: identity(input.projectId, 'projectId'),
    batchId: identity(input.batchId, 'batchId'),
    alignmentId: identity(input.alignment.id, 'alignmentId'),
    alignmentRunHash: input.alignment.runHash,
    schemaVersion: TAKE_LIBRARY_SCHEMA_VERSION,
    groupingPolicyVersion: TAKE_GROUPING_POLICY_VERSION,
    evaluationPolicyVersion: TAKE_EVALUATION_POLICY_VERSION,
    status: deriveStatus(result.takes, selections),
    revision: 1,
    groups: result.groups,
    takes: result.takes,
    selections,
    summary: summary(result.groups, result.takes),
    createdByClientId: identity(
      input.createdByClientId,
      'createdByClientId',
    ),
    createdAt,
    updatedAt: createdAt,
  })
}

function selectionBody(
  value: Omit<TakeLibrarySelection, 'selectionHash'>,
) {
  return {
    id: value.id,
    revision: value.revision,
    groupId: value.groupId,
    takeId: value.takeId,
    protect: value.protect,
    ...(value.replacedProtectedTakeId
      ? { replacedProtectedTakeId: value.replacedProtectedTakeId }
      : {}),
    ...(value.note ? { note: value.note } : {}),
    actorClientId: value.actorClientId,
    createdAt: value.createdAt,
  }
}

function selection(
  value: Omit<TakeLibrarySelection, 'selectionHash'>,
): Readonly<TakeLibrarySelection> {
  const body = selectionBody(value)
  return Object.freeze({
    ...body,
    selectionHash: calculateCanonicalHash(body),
  })
}

export function selectTakeManually(input: {
  run: Readonly<TakeLibraryRun>
  selectionId: string
  expectedRevision: number
  groupId: string
  takeId: string
  protect: boolean
  replacedProtectedTakeId?: string
  note?: string
  actorClientId: string
  createdAt: string
}): Readonly<{
  run: Readonly<TakeLibraryRun>
  selection: Readonly<TakeLibrarySelection>
}> {
  const run = hydrateTakeLibraryRun(input.run)
  assertDomain(
    Number.isSafeInteger(input.expectedRevision) &&
    input.expectedRevision === run.revision,
    'VERSION_CONFLICT',
    'Take library revision does not match',
  )
  const groupId = identity(input.groupId, 'groupId')
  const takeId = identity(input.takeId, 'takeId')
  const group = run.groups.find((candidate) => candidate.id === groupId)
  const selected = run.takes.find((candidate) =>
    candidate.id === takeId && candidate.groupId === groupId)
  assertDomain(
    Boolean(group && selected),
    'INVALID_ARGUMENT',
    'Selected take does not belong to the requested group',
  )
  assertDomain(
    selected!.status !== 'rejected',
    'PRECONDITION_REQUIRED',
    'Rejected take cannot become primary without a new integrity evaluation',
  )
  const existingProtected = group!.protectedTakeId
  if (existingProtected && existingProtected !== takeId) {
    assertDomain(
      input.replacedProtectedTakeId === existingProtected,
      'PRECONDITION_REQUIRED',
      'Replacing a protected take requires its exact current ID',
      { protectedTakeId: existingProtected },
    )
  } else {
    assertDomain(
      input.replacedProtectedTakeId === undefined,
      'INVALID_ARGUMENT',
      'replacedProtectedTakeId is not applicable',
    )
  }
  const createdAt = instant(input.createdAt, 'selection.createdAt')
  assertDomain(
    Date.parse(createdAt) >= Date.parse(run.updatedAt),
    'VERSION_CONFLICT',
    'Take selection cannot move time backwards',
  )
  const selectionRecord = selection({
    id: identity(input.selectionId, 'selectionId'),
    revision: run.revision + 1,
    groupId,
    takeId,
    protect: Boolean(input.protect),
    ...(existingProtected && existingProtected !== takeId
      ? { replacedProtectedTakeId: existingProtected }
      : {}),
    ...(input.note
      ? { note: boundedText(input.note, 'selection.note', 1, 500) }
      : {}),
    actorClientId: identity(input.actorClientId, 'actorClientId'),
    createdAt,
  })
  const takes = Object.freeze(run.takes.map((take) => {
    if (take.groupId !== groupId) return take
    const nextStatus: TakeStatus = take.id === takeId
      ? 'primary'
      : take.status === 'primary'
        ? 'alternate'
        : take.status
    return takeRecord({
      ...take,
      status: nextStatus,
      protected: take.id === takeId && Boolean(input.protect),
      selectionSource: take.id === takeId
        ? 'manual'
        : take.selectionSource,
      reasonCodes: deduplicatedSorted([
        ...take.reasonCodes.filter((reason) =>
          ![
            'TAKE_AUTOMATIC_PRIMARY',
            'TAKE_MANUAL_PRIMARY',
            'TAKE_PROTECTED',
          ].includes(reason)),
        ...(take.id === takeId
          ? ['TAKE_MANUAL_PRIMARY']
          : []),
        ...(take.id === takeId && input.protect
          ? ['TAKE_PROTECTED']
          : []),
      ]),
    })
  }))
  const groups = Object.freeze(run.groups.map((candidate) => {
    if (candidate.id !== groupId) return candidate
    return takeGroup({
      id: candidate.id,
      key: candidate.key,
      assignmentKind: candidate.assignmentKind,
      role: candidate.role,
      label: candidate.label,
      ...(candidate.scriptBlockId
        ? { scriptBlockId: candidate.scriptBlockId }
        : {}),
      takeIds: candidate.takeIds,
      primaryTakeId: takeId,
      ...(input.protect ? { protectedTakeId: takeId } : {}),
    })
  }))
  const selections = Object.freeze([
    ...run.selections,
    selectionRecord,
  ])
  const next = frozenRun({
    ...run,
    status: deriveStatus(takes, selections),
    revision: run.revision + 1,
    groups,
    takes,
    selections,
    summary: summary(groups, takes),
    updatedAt: createdAt,
  })
  return Object.freeze({
    run: next,
    selection: selectionRecord,
  })
}

export function hydrateTakeLibraryRun(
  value: Readonly<TakeLibraryRun>,
): Readonly<TakeLibraryRun> {
  assertDomain(
    value?.schemaVersion === TAKE_LIBRARY_SCHEMA_VERSION &&
    value.groupingPolicyVersion === TAKE_GROUPING_POLICY_VERSION &&
    value.evaluationPolicyVersion === TAKE_EVALUATION_POLICY_VERSION &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 1 &&
    value.revision <= 1_000_000 &&
    HASH.test(value.alignmentRunHash ?? '') &&
    isArray(value.groups) &&
    isArray(value.takes) &&
    isArray(value.selections),
    'INVALID_ARGUMENT',
    'Take library has an invalid envelope',
  )
  const ids = new Set<string>()
  const boundaries = new Set<string>()
  const takeById = new Map<string, TakeRecord>()
  for (const take of value.takes) {
    assertDomain(
      !ids.has(take.id) &&
      !boundaries.has(take.retakeBoundaryId) &&
      HASH.test(take.sourceHash) &&
      TAKE_DIMENSIONS.every((dimension) =>
        take.evaluations.some((entry) =>
          entry.dimension === dimension)) &&
      take.evaluations.length === TAKE_DIMENSIONS.length &&
      take.evaluations.every((entry) =>
        entry.evaluationHash === calculateCanonicalHash(
          evaluationBody(entry),
        )) &&
      take.assignment.assignmentHash === calculateCanonicalHash(
        assignmentBody(take.assignment),
      ) &&
      take.takeHash === calculateCanonicalHash(takeBody(take)),
      'INVALID_ARGUMENT',
      `Take ${take.id} failed integrity validation`,
    )
    ids.add(take.id)
    boundaries.add(take.retakeBoundaryId)
    takeById.set(take.id, take)
  }
  const groupIds = new Set<string>()
  for (const group of value.groups) {
    const members = group.takeIds.map((takeId) => takeById.get(takeId))
    const primary = members.filter((take) => take?.status === 'primary')
    const protectedTakes = members.filter((take) => take?.protected)
    assertDomain(
      !groupIds.has(group.id) &&
      members.length >= 1 &&
      members.every((take) => take?.groupId === group.id) &&
      primary.length <= 1 &&
      protectedTakes.length <= 1 &&
      (!group.primaryTakeId ||
        primary[0]?.id === group.primaryTakeId) &&
      (!group.protectedTakeId ||
        (
          protectedTakes[0]?.id === group.protectedTakeId &&
          group.primaryTakeId === group.protectedTakeId
        )) &&
      group.groupHash === calculateCanonicalHash(groupBody(group)),
      'INVALID_ARGUMENT',
      `Take group ${group.id} failed integrity validation`,
    )
    groupIds.add(group.id)
  }
  assertDomain(
    value.takes.every((take) => groupIds.has(take.groupId)) &&
    new Set(value.groups.flatMap((group) => group.takeIds)).size ===
    value.takes.length,
    'INVALID_ARGUMENT',
    'Take library group membership is incomplete',
  )
  for (const [index, entry] of value.selections.entries()) {
    assertDomain(
      entry.revision === index + 2 &&
      groupIds.has(entry.groupId) &&
      takeById.get(entry.takeId)?.groupId === entry.groupId &&
      entry.selectionHash === calculateCanonicalHash(
        selectionBody(entry),
      ),
      'INVALID_ARGUMENT',
      `Take selection ${entry.id} failed integrity validation`,
    )
  }
  assertDomain(
    value.revision === value.selections.length + 1 &&
    value.status === deriveStatus(value.takes, value.selections) &&
    stableSerialize(value.summary) === stableSerialize(
      summary(value.groups, value.takes),
    ) &&
    value.runHash === calculateCanonicalHash(runBody(value)),
    'INVALID_ARGUMENT',
    'Take library aggregate failed integrity validation',
  )
  return frozenRun({
    ...value,
    groups: Object.freeze(value.groups.map((group) =>
      Object.freeze({
        ...group,
        takeIds: Object.freeze([...group.takeIds]),
      }))),
    takes: Object.freeze(value.takes.map((take) =>
      Object.freeze({
        ...take,
        sourceRangeMs: Object.freeze([...take.sourceRangeMs]) as
          readonly [number, number],
        evidenceWordIndices: Object.freeze([
          ...take.evidenceWordIndices,
        ]),
        assignment: Object.freeze({
          ...take.assignment,
          evidenceRefs: Object.freeze([
            ...take.assignment.evidenceRefs,
          ]),
        }),
        evaluations: Object.freeze(take.evaluations.map((entry) =>
          Object.freeze({
            ...entry,
            evidenceRefs: Object.freeze([...entry.evidenceRefs]),
            reasonCodes: Object.freeze([...entry.reasonCodes]),
          }))),
        reasonCodes: Object.freeze([...take.reasonCodes]),
      }))),
    selections: Object.freeze(value.selections.map((entry) =>
      Object.freeze({ ...entry }))),
    summary: Object.freeze({ ...value.summary }),
  })
}
