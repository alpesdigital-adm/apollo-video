import {
  calculateCanonicalHash,
  stableSerialize,
} from './canonical-hash.ts'
import { assertDomain, DomainError } from './errors.ts'

export const SOURCE_DECONSTRUCTION_SCHEMA_VERSION =
  'source-deconstruction-report/v1' as const
export const SOURCE_DECONSTRUCTION_POLICY_VERSION =
  'source-deconstruction/v1' as const
export const SOURCE_DECONSTRUCTION_ANALYZER_VERSION =
  'semantic-source-deconstructor/v1' as const

export const SOURCE_DECONSTRUCTION_ROLES = [
  'opening',
  'hook',
  'context',
  'body',
  'cta',
  'tail',
] as const
export type SourceDeconstructionRole =
  typeof SOURCE_DECONSTRUCTION_ROLES[number]

export const SOURCE_DECONSTRUCTION_DESIRED_ROLES = [
  'hook',
  'body',
  'cta',
  'complete',
] as const
export type SourceDeconstructionDesiredRole =
  typeof SOURCE_DECONSTRUCTION_DESIRED_ROLES[number]

export const SOURCE_DECONSTRUCTION_VALIDATION_SCOPES = [
  'copy',
  'take',
  'opening-edit',
  'full',
] as const
export type SourceDeconstructionValidationScope =
  typeof SOURCE_DECONSTRUCTION_VALIDATION_SCOPES[number]

export const SOURCE_DECONSTRUCTION_DECISIONS = [
  'automatic',
  'human-review',
  'reject',
] as const
export type SourceDeconstructionDecision =
  typeof SOURCE_DECONSTRUCTION_DECISIONS[number]

export type SourceSpeechClassification =
  | 'complete-thought'
  | 'incomplete'
  | 'interrupted'

export interface SourceDeconstructionIntentEvidence {
  value: string
  confidence: number
  provenance: string
}

export interface SourceDeconstructionSpeechEvidence {
  id: string
  sourceSegmentId: number
  exactText: string
  normalizedText: string
  rangeMs: readonly [number, number]
  completeThoughtScore: number
  classification: SourceSpeechClassification
  intentions: readonly Readonly<SourceDeconstructionIntentEvidence>[]
  segmentHash: string
}

export interface SourceDeconstructionBoundaryPolicy {
  preRollMs: number
  postRollMs: number
  maxJoinGapMs: number
  maxContextGapMs: number
  minCompleteThoughtScore: number
}

export interface SourceDeconstructionTargetComposition {
  objective: string
  outputSpecId: string
  targetDurationMs: number
}

export interface SourceDeconstructionSegment {
  id: string
  sourceSpeechSegmentId: string
  sourceSegmentId: number
  exactText: string
  normalizedText: string
  rangeMs: readonly [number, number]
  role: SourceDeconstructionRole
  roleConfidence: number
  roleReasonCodes: readonly string[]
  essential: boolean
  included: boolean
  includedForContext: boolean
  completeThoughtScore: number
  classification: SourceSpeechClassification
  segmentHash: string
  analysisHash: string
}

export interface SourceDeconstructionCleanRange {
  id: string
  sequence: number
  rangeMs: readonly [number, number]
  speechRangeMs: readonly [number, number]
  sourceSpeechSegmentIds: readonly string[]
  roles: readonly SourceDeconstructionRole[]
  exactText: string
  confidence: number
  contextPreserved: boolean
  boundaryReasonCodes: readonly string[]
  rangeHash: string
}

export type SemanticContaminantKind =
  | 'prior-opening'
  | 'non-target-body'
  | 'prior-cta'
  | 'removable-tail'

export interface SourceDeconstructionSemanticContaminant {
  id: string
  kind: SemanticContaminantKind
  sourceSpeechSegmentId: string
  rangeMs: readonly [number, number]
  exactText: string
  confidence: number
  overlapsEssential: false
  removableWithoutContextLoss: boolean
  contaminantHash: string
}

export interface SourceDeconstructionComparison {
  sourceRangeMs: readonly [number, number]
  cleanRangesMs: readonly (readonly [number, number])[]
  removedRangesMs: readonly (readonly [number, number])[]
  sourceDurationMs: number
  cleanDurationMs: number
  removedDurationMs: number
  retainedRatio: number
  sourceSegmentCount: number
  includedSegmentCount: number
  excludedSegmentCount: number
  sourceTranscript: string
  cleanTranscript: string
  mappings: readonly Readonly<{
    sourceSpeechSegmentId: string
    sourceRangeMs: readonly [number, number]
    cleanRangeId?: string
    role: SourceDeconstructionRole
    included: boolean
  }>[]
  comparisonHash: string
}

export interface SourceDeconstructionReport {
  schemaVersion: typeof SOURCE_DECONSTRUCTION_SCHEMA_VERSION
  id: string
  workspaceId: string
  projectId: string
  sourceArtifactId: string
  sourceArtifactSha256: string
  sourceTranscriptId: string
  sourceTranscriptHash: string
  sourceDurationMs: number
  desiredRole: SourceDeconstructionDesiredRole
  validationScope: SourceDeconstructionValidationScope
  targetComposition: Readonly<SourceDeconstructionTargetComposition>
  boundaryPolicy: Readonly<SourceDeconstructionBoundaryPolicy>
  analyzer: Readonly<{
    policyVersion: typeof SOURCE_DECONSTRUCTION_POLICY_VERSION
    version: typeof SOURCE_DECONSTRUCTION_ANALYZER_VERSION
    evidenceSource: 'cataloged-speech'
  }>
  segments: readonly Readonly<SourceDeconstructionSegment>[]
  hookEnvelope: Readonly<{
    rangeMs: readonly [number, number]
    sourceSpeechSegmentIds: readonly string[]
    confidence: number
  }> | null
  bodyRanges: readonly (readonly [number, number])[]
  ctaRanges: readonly (readonly [number, number])[]
  cleanCandidateRanges: readonly Readonly<SourceDeconstructionCleanRange>[]
  semanticContaminants:
    readonly Readonly<SourceDeconstructionSemanticContaminant>[]
  comparison: Readonly<SourceDeconstructionComparison>
  confidence: number
  editabilityScore: number
  decision: SourceDeconstructionDecision
  contextPreserved: boolean
  decisionReasonCodes: readonly string[]
  createdByClientId: string
  createdAt: string
  reportHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const TOKEN = /^[a-z0-9][a-z0-9._:/-]{0,127}$/
const HASH = /^[a-f0-9]{64}$/
const OUTPUT_SPEC = /^(?:9:16|16:9|4:5|1:1|21:9|[a-z0-9][a-z0-9._:/-]{1,63})$/

function identity(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && ID.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function token(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && TOKEN.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function hash(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && HASH.test(value),
    'INVALID_ARGUMENT',
    `${field} must be a lowercase SHA-256`,
  )
  return value
}

function instant(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    'INVALID_ARGUMENT',
    `${field} must be an ISO instant`,
  )
  return value
}

function integer(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  assertDomain(
    Number.isSafeInteger(value) &&
      Number(value) >= minimum &&
      Number(value) <= maximum,
    'INVALID_ARGUMENT',
    `${field} must be an integer between ${minimum} and ${maximum}`,
  )
  return Number(value)
}

function score(value: unknown, field: string): number {
  assertDomain(
    typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 1,
    'INVALID_ARGUMENT',
    `${field} must be between zero and one`,
  )
  return Number(value.toFixed(4))
}

function boundedText(
  value: unknown,
  field: string,
  maximum: number,
  allowEmpty = false,
): string {
  assertDomain(
    typeof value === 'string' &&
      (allowEmpty || value.trim().length > 0) &&
      value.length <= maximum,
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim().replace(/\s+/g, ' ')
}

function range(
  value: readonly [number, number],
  durationMs: number,
  field: string,
): readonly [number, number] {
  assertDomain(
    Array.isArray(value) &&
      value.length === 2 &&
      Number.isSafeInteger(value[0]) &&
      Number.isSafeInteger(value[1]) &&
      value[0] >= 0 &&
      value[0] < value[1] &&
      value[1] <= durationMs,
    'INVALID_ARGUMENT',
    `${field} is outside the source duration`,
  )
  return Object.freeze([value[0], value[1]])
}

function normalizeSemanticText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeBoundaryPolicy(
  value: Readonly<SourceDeconstructionBoundaryPolicy>,
): Readonly<SourceDeconstructionBoundaryPolicy> {
  return Object.freeze({
    preRollMs: integer(value.preRollMs, 'boundaryPolicy.preRollMs', 0, 2_000),
    postRollMs: integer(
      value.postRollMs,
      'boundaryPolicy.postRollMs',
      0,
      2_000,
    ),
    maxJoinGapMs: integer(
      value.maxJoinGapMs,
      'boundaryPolicy.maxJoinGapMs',
      0,
      5_000,
    ),
    maxContextGapMs: integer(
      value.maxContextGapMs,
      'boundaryPolicy.maxContextGapMs',
      0,
      5_000,
    ),
    minCompleteThoughtScore: score(
      value.minCompleteThoughtScore,
      'boundaryPolicy.minCompleteThoughtScore',
    ),
  })
}

function normalizeTargetComposition(
  value: Readonly<SourceDeconstructionTargetComposition>,
): Readonly<SourceDeconstructionTargetComposition> {
  const objective = token(value.objective, 'targetComposition.objective')
  assertDomain(
    typeof value.outputSpecId === 'string' &&
      OUTPUT_SPEC.test(value.outputSpecId.trim()),
    'INVALID_ARGUMENT',
    'targetComposition.outputSpecId is invalid',
  )
  return Object.freeze({
    objective,
    outputSpecId: value.outputSpecId.trim(),
    targetDurationMs: integer(
      value.targetDurationMs,
      'targetComposition.targetDurationMs',
      500,
      30 * 60 * 1_000,
    ),
  })
}

function normalizedIntent(
  intent: Readonly<SourceDeconstructionIntentEvidence>,
  index: number,
): Readonly<SourceDeconstructionIntentEvidence> {
  return Object.freeze({
    value: boundedText(intent.value, `intentions[${index}].value`, 120),
    confidence: score(
      intent.confidence,
      `intentions[${index}].confidence`,
    ),
    provenance: boundedText(
      intent.provenance,
      `intentions[${index}].provenance`,
      240,
    ),
  })
}

function normalizeSpeechEvidence(
  input: Readonly<SourceDeconstructionSpeechEvidence>,
  durationMs: number,
  index: number,
): Readonly<SourceDeconstructionSpeechEvidence> {
  const exactText = boundedText(
    input.exactText,
    `speechEvidence[${index}].exactText`,
    10_000,
  )
  const normalizedText = boundedText(
    input.normalizedText,
    `speechEvidence[${index}].normalizedText`,
    10_000,
  )
  assertDomain(
    normalizeSemanticText(exactText) ===
      normalizeSemanticText(normalizedText),
    'INVALID_ARGUMENT',
    `speechEvidence[${index}] normalized text is inconsistent`,
  )
  assertDomain(
    input.classification === 'complete-thought' ||
      input.classification === 'incomplete' ||
      input.classification === 'interrupted',
    'INVALID_ARGUMENT',
    `speechEvidence[${index}].classification is invalid`,
  )
  return Object.freeze({
    id: identity(input.id, `speechEvidence[${index}].id`),
    sourceSegmentId: integer(
      input.sourceSegmentId,
      `speechEvidence[${index}].sourceSegmentId`,
      0,
      10_000_000,
    ),
    exactText,
    normalizedText,
    rangeMs: range(
      input.rangeMs,
      durationMs,
      `speechEvidence[${index}].rangeMs`,
    ),
    completeThoughtScore: score(
      input.completeThoughtScore,
      `speechEvidence[${index}].completeThoughtScore`,
    ),
    classification: input.classification,
    intentions: Object.freeze(
      input.intentions.map(normalizedIntent),
    ),
    segmentHash: hash(
      input.segmentHash,
      `speechEvidence[${index}].segmentHash`,
    ),
  })
}

const ROLE_INTENT_ALIASES: Readonly<
  Record<SourceDeconstructionRole, readonly string[]>
> = Object.freeze({
  opening: Object.freeze([
    'opening',
    'abertura',
    'pattern interrupt',
    'interrupcao de padrao',
  ]),
  hook: Object.freeze(['hook', 'gancho', 'promessa', 'curiosidade']),
  context: Object.freeze(['context', 'contexto', 'qualifier']),
  body: Object.freeze([
    'body',
    'corpo',
    'argumento',
    'explicacao',
    'conteudo',
  ]),
  cta: Object.freeze([
    'cta',
    'call to action',
    'chamada para acao',
    'oferta',
  ]),
  tail: Object.freeze([
    'tail',
    'cauda',
    'outro',
    'encerramento',
    'despedida',
  ]),
})

const LEXICAL_PATTERNS: Readonly<
  Record<Exclude<SourceDeconstructionRole, 'context'>, readonly RegExp[]>
> = Object.freeze({
  opening: Object.freeze([
    /^(?:pare|atencao|espera|olha|ei)\b/u,
    /\bnao passe este video\b/u,
  ]),
  hook: Object.freeze([
    /^(?:voce sabia|se voce|imagine|como|por que|o segredo)\b/u,
    /\?$/u,
    /\b(?:descubra|erro que|ninguem te conta|em \d+ segundos)\b/u,
  ]),
  body: Object.freeze([
    /\b(?:porque|isso acontece|primeiro|segundo|na pratica|o problema)\b/u,
  ]),
  cta: Object.freeze([
    /\b(?:clique|comente|envie|chame|whatsapp|agende|baixe|acesse|link|saiba mais|cadastre)\b/u,
  ]),
  tail: Object.freeze([
    /\b(?:ate a proxima|e isso|valeu|tchau|obrigad[oa]|nos vemos)\b/u,
  ]),
})

function classifyRole(
  evidence: Readonly<SourceDeconstructionSpeechEvidence>,
  ordinal: number,
  total: number,
): Readonly<{
  role: SourceDeconstructionRole
  confidence: number
  reasonCodes: readonly string[]
}> {
  const intentScores = new Map<SourceDeconstructionRole, number>()
  for (const intent of evidence.intentions) {
    const normalized = normalizeSemanticText(intent.value)
    for (const role of SOURCE_DECONSTRUCTION_ROLES) {
      if (
        ROLE_INTENT_ALIASES[role].some((alias) =>
          normalized === normalizeSemanticText(alias) ||
          normalized.includes(normalizeSemanticText(alias)))
      ) {
        intentScores.set(
          role,
          Math.max(intentScores.get(role) ?? 0, intent.confidence),
        )
      }
    }
  }
  const explicit = [...intentScores.entries()].sort((left, right) =>
    right[1] - left[1] ||
    SOURCE_DECONSTRUCTION_ROLES.indexOf(left[0]) -
      SOURCE_DECONSTRUCTION_ROLES.indexOf(right[0]))[0]
  if (explicit && explicit[1] >= 0.5) {
    return Object.freeze({
      role: explicit[0],
      confidence: Number(explicit[1].toFixed(4)),
      reasonCodes: Object.freeze(['catalog-intention']),
    })
  }

  const text = normalizeSemanticText(evidence.exactText)
  const lexical = ([
    'cta',
    'tail',
    'opening',
    'hook',
    'body',
  ] as const).find((role) =>
    LEXICAL_PATTERNS[role].some((pattern) => pattern.test(text)))
  if (lexical) {
    return Object.freeze({
      role: lexical,
      confidence: lexical === 'body' ? 0.72 : 0.82,
      reasonCodes: Object.freeze(['lexical-signal']),
    })
  }
  if (ordinal === 0) {
    return Object.freeze({
      role: 'hook',
      confidence: 0.62,
      reasonCodes: Object.freeze(['first-complete-thought']),
    })
  }
  if (ordinal === total - 1 && evidence.completeThoughtScore < 0.55) {
    return Object.freeze({
      role: 'tail',
      confidence: 0.58,
      reasonCodes: Object.freeze(['terminal-low-completeness']),
    })
  }
  return Object.freeze({
    role: 'body',
    confidence: 0.6,
    reasonCodes: Object.freeze(['narrative-default']),
  })
}

function roleIsEssential(
  role: SourceDeconstructionRole,
  desiredRole: SourceDeconstructionDesiredRole,
  validationScope: SourceDeconstructionValidationScope,
  evidence: Readonly<SourceDeconstructionSpeechEvidence>,
): boolean {
  if (role === 'tail') return false
  if (desiredRole === 'complete') {
    if (role === 'opening') {
      return openingBelongsToHookEnvelope(evidence.normalizedText)
    }
    return role !== 'context' || validationScope === 'full'
  }
  if (desiredRole === 'hook') {
    return role === 'hook' ||
      (role === 'opening' &&
        openingBelongsToHookEnvelope(evidence.normalizedText)) ||
      (role === 'context' && validationScope === 'opening-edit')
  }
  if (desiredRole === 'body') {
    return role === 'body' || role === 'context'
  }
  return role === 'cta' || role === 'context'
}

function openingBelongsToHookEnvelope(
  normalizedText: string,
): boolean {
  const publishedWrapper = [
    /\bantes de comecar\b/u,
    /\bdeixa eu me apresentar\b/u,
    /\bmeu nome e\b/u,
    /\bseja bem vind[oa]\b/u,
    /\bbem vind[oa]\b/u,
    /\bola[, ]/u,
  ]
  if (publishedWrapper.some((pattern) =>
    pattern.test(normalizedText))) {
    return false
  }
  const hookPrimers = [
    /\bpare de\b/u,
    /\bpreste atencao\b/u,
    /\bse voce\b/u,
    /\bvoce sabia\b/u,
    /\bimagine\b/u,
    /\bcuidado\b/u,
    /\b(?:este|esse) erro\b/u,
    /\bnunca\b/u,
    /\bsegredo\b/u,
    /\bdescubra\b/u,
  ]
  return hookPrimers.some((pattern) =>
    pattern.test(normalizedText))
}

function expandContext(
  segments: readonly Readonly<SourceDeconstructionSegment>[],
  policy: Readonly<SourceDeconstructionBoundaryPolicy>,
): ReadonlySet<string> {
  const included = new Set(
    segments.filter((segment) => segment.essential)
      .map((segment) => segment.id),
  )
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    if (!segment || !included.has(segment.id)) continue
    const needsClosingContext =
      segment.classification !== 'complete-thought' ||
      segment.completeThoughtScore < policy.minCompleteThoughtScore
    if (needsClosingContext) {
      for (
        let adjacent = index + 1;
        adjacent < segments.length;
        adjacent += 1
      ) {
        const previous = segments[adjacent - 1]!
        const candidate = segments[adjacent]!
        if (
          candidate.rangeMs[0] - previous.rangeMs[1] >
          policy.maxContextGapMs
        ) break
        included.add(candidate.id)
        if (
          candidate.classification === 'complete-thought' &&
          candidate.completeThoughtScore >=
            policy.minCompleteThoughtScore
        ) break
      }
    }
    const previous = segments[index - 1]
    if (
      previous?.role === 'context' &&
      segment.rangeMs[0] - previous.rangeMs[1] <=
        policy.maxContextGapMs
    ) {
      included.add(previous.id)
    }
  }
  return included
}

function complementRanges(
  cleanRanges: readonly Readonly<SourceDeconstructionCleanRange>[],
  durationMs: number,
): readonly (readonly [number, number])[] {
  const result: Array<readonly [number, number]> = []
  let cursor = 0
  for (const clean of cleanRanges) {
    if (clean.rangeMs[0] > cursor) {
      result.push(Object.freeze([cursor, clean.rangeMs[0]]))
    }
    cursor = Math.max(cursor, clean.rangeMs[1])
  }
  if (cursor < durationMs) {
    result.push(Object.freeze([cursor, durationMs]))
  }
  return Object.freeze(result)
}

function cleanRanges(
  segments: readonly Readonly<SourceDeconstructionSegment>[],
  durationMs: number,
  policy: Readonly<SourceDeconstructionBoundaryPolicy>,
): readonly Readonly<SourceDeconstructionCleanRange>[] {
  const included = segments.filter((segment) => segment.included)
  if (included.length === 0) return Object.freeze([])
  const groups: Array<Array<Readonly<SourceDeconstructionSegment>>> = []
  for (const segment of included) {
    const current = groups.at(-1)
    if (
      !current ||
      segment.rangeMs[0] - current.at(-1)!.rangeMs[1] >
        policy.maxJoinGapMs
    ) {
      groups.push([segment])
    } else {
      current.push(segment)
    }
  }
  return Object.freeze(groups.map((group, sequence) => {
    const first = group[0]!
    const last = group.at(-1)!
    const speechRangeMs = Object.freeze([
      first.rangeMs[0],
      last.rangeMs[1],
    ]) as readonly [number, number]
    const cleanRangeMs = Object.freeze([
      Math.max(0, speechRangeMs[0] - policy.preRollMs),
      Math.min(durationMs, speechRangeMs[1] + policy.postRollMs),
    ]) as readonly [number, number]
    const roleConfidence = group.reduce(
      (sum, segment) => sum + segment.roleConfidence,
      0,
    ) / group.length
    const thoughtConfidence = group.reduce(
      (sum, segment) => sum + segment.completeThoughtScore,
      0,
    ) / group.length
    const contextPreserved =
      last.classification === 'complete-thought' &&
      last.completeThoughtScore >= policy.minCompleteThoughtScore
    const boundaryReasonCodes = Object.freeze([
      'speech-aligned-start',
      contextPreserved
        ? 'complete-thought-end'
        : 'expanded-context-end',
      ...(policy.preRollMs > 0 ? ['pre-roll'] : []),
      ...(policy.postRollMs > 0 ? ['post-roll'] : []),
    ])
    const content = Object.freeze({
      id: `source-deconstruction-range-${calculateCanonicalHash({
        sequence,
        sourceSpeechSegmentIds: group.map((segment) =>
          segment.sourceSpeechSegmentId),
        cleanRangeMs,
      }).slice(0, 40)}`,
      sequence,
      rangeMs: cleanRangeMs,
      speechRangeMs,
      sourceSpeechSegmentIds: Object.freeze(
        group.map((segment) => segment.sourceSpeechSegmentId),
      ),
      roles: Object.freeze([
        ...new Set(group.map((segment) => segment.role)),
      ]),
      exactText: group.map((segment) => segment.exactText).join(' '),
      confidence: Number(
        (roleConfidence * 0.6 + thoughtConfidence * 0.4)
          .toFixed(4),
      ),
      contextPreserved,
      boundaryReasonCodes,
    })
    return Object.freeze({
      ...content,
      rangeHash: calculateCanonicalHash(content),
    })
  }))
}

function semanticContaminantKind(
  role: SourceDeconstructionRole,
): SemanticContaminantKind | null {
  if (role === 'opening' || role === 'hook') return 'prior-opening'
  if (role === 'body' || role === 'context') return 'non-target-body'
  if (role === 'cta') return 'prior-cta'
  if (role === 'tail') return 'removable-tail'
  return null
}

function semanticContaminants(
  segments: readonly Readonly<SourceDeconstructionSegment>[],
): readonly Readonly<SourceDeconstructionSemanticContaminant>[] {
  return Object.freeze(segments.flatMap((segment) => {
    if (segment.included) return []
    const kind = semanticContaminantKind(segment.role)
    if (!kind) return []
    const content = Object.freeze({
      id: `source-deconstruction-contaminant-${calculateCanonicalHash({
        segmentId: segment.id,
        kind,
      }).slice(0, 40)}`,
      kind,
      sourceSpeechSegmentId: segment.sourceSpeechSegmentId,
      rangeMs: segment.rangeMs,
      exactText: segment.exactText,
      confidence: segment.roleConfidence,
      overlapsEssential: false as const,
      removableWithoutContextLoss:
        segment.classification === 'complete-thought' &&
        segment.completeThoughtScore >= 0.5,
    })
    return [Object.freeze({
      ...content,
      contaminantHash: calculateCanonicalHash(content),
    })]
  }))
}

function hookEnvelope(
  segments: readonly Readonly<SourceDeconstructionSegment>[],
): SourceDeconstructionReport['hookEnvelope'] {
  const candidates = segments.filter((segment) =>
    segment.included &&
    (segment.role === 'opening' || segment.role === 'hook'))
  if (candidates.length === 0) return null
  return Object.freeze({
    rangeMs: Object.freeze([
      candidates[0]!.rangeMs[0],
      candidates.at(-1)!.rangeMs[1],
    ]) as readonly [number, number],
    sourceSpeechSegmentIds: Object.freeze(
      candidates.map((segment) => segment.sourceSpeechSegmentId),
    ),
    confidence: Number(
      (candidates.reduce(
        (sum, segment) => sum + segment.roleConfidence,
        0,
      ) / candidates.length).toFixed(4),
    ),
  })
}

function roleRanges(
  segments: readonly Readonly<SourceDeconstructionSegment>[],
  role: 'body' | 'cta',
): readonly (readonly [number, number])[] {
  return Object.freeze(
    segments
      .filter((segment) => segment.included && segment.role === role)
      .map((segment) => segment.rangeMs),
  )
}

function reportBody(
  report: Omit<SourceDeconstructionReport, 'reportHash'>,
) {
  return report
}

export function createSourceDeconstructionReport(input: {
  id: string
  workspaceId: string
  projectId: string
  sourceArtifactId: string
  sourceArtifactSha256: string
  sourceTranscriptId: string
  sourceTranscriptHash: string
  sourceDurationMs: number
  desiredRole: SourceDeconstructionDesiredRole
  validationScope: SourceDeconstructionValidationScope
  targetComposition: Readonly<SourceDeconstructionTargetComposition>
  boundaryPolicy: Readonly<SourceDeconstructionBoundaryPolicy>
  speechEvidence:
    readonly Readonly<SourceDeconstructionSpeechEvidence>[]
  createdByClientId: string
  createdAt: string
}): Readonly<SourceDeconstructionReport> {
  const sourceDurationMs = integer(
    input.sourceDurationMs,
    'sourceDurationMs',
    1,
    24 * 60 * 60 * 1_000,
  )
  assertDomain(
    SOURCE_DECONSTRUCTION_DESIRED_ROLES.includes(input.desiredRole),
    'INVALID_ARGUMENT',
    'desiredRole is invalid',
  )
  assertDomain(
    SOURCE_DECONSTRUCTION_VALIDATION_SCOPES
      .includes(input.validationScope),
    'INVALID_ARGUMENT',
    'validationScope is invalid',
  )
  assertDomain(
    Array.isArray(input.speechEvidence) &&
      input.speechEvidence.length >= 1 &&
      input.speechEvidence.length <= 10_000,
    'INVALID_ARGUMENT',
    'speechEvidence must contain one to 10000 segments',
  )
  const policy = normalizeBoundaryPolicy(input.boundaryPolicy)
  const targetComposition = normalizeTargetComposition(
    input.targetComposition,
  )
  const evidence = input.speechEvidence
    .map((item, index) =>
      normalizeSpeechEvidence(item, sourceDurationMs, index))
    .sort((left, right) =>
      left.rangeMs[0] - right.rangeMs[0] ||
      left.rangeMs[1] - right.rangeMs[1] ||
      left.id.localeCompare(right.id))
  assertDomain(
    new Set(evidence.map((item) => item.id)).size === evidence.length &&
      new Set(evidence.map((item) => item.sourceSegmentId)).size ===
        evidence.length,
    'INVALID_ARGUMENT',
    'speechEvidence contains duplicate segments',
  )
  assertDomain(
    evidence.every((item, index) =>
      index === 0 ||
      evidence[index - 1]!.rangeMs[1] <= item.rangeMs[0]),
    'INVALID_ARGUMENT',
    'speechEvidence ranges overlap',
  )

  const classified = evidence.map((item, index) => {
    const classification = classifyRole(item, index, evidence.length)
    const essential = roleIsEssential(
      classification.role,
      input.desiredRole,
      input.validationScope,
      item,
    )
    const content = Object.freeze({
      id: `source-deconstruction-segment-${calculateCanonicalHash({
        sourceSpeechSegmentId: item.id,
        desiredRole: input.desiredRole,
        validationScope: input.validationScope,
      }).slice(0, 40)}`,
      sourceSpeechSegmentId: item.id,
      sourceSegmentId: item.sourceSegmentId,
      exactText: item.exactText,
      normalizedText: item.normalizedText,
      rangeMs: item.rangeMs,
      role: classification.role,
      roleConfidence: classification.confidence,
      roleReasonCodes: classification.reasonCodes,
      essential,
      included: essential,
      includedForContext: false,
      completeThoughtScore: item.completeThoughtScore,
      classification: item.classification,
      segmentHash: item.segmentHash,
    })
    return Object.freeze({
      ...content,
      analysisHash: calculateCanonicalHash(content),
    })
  })
  const includedForContext = expandContext(classified, policy)
  const segments = Object.freeze(classified.map((segment) => {
    const included = includedForContext.has(segment.id)
    if (included === segment.included) return segment
    const content = Object.freeze({
      ...segment,
      included,
      includedForContext: included && !segment.essential,
      analysisHash: undefined,
    })
    const { analysisHash: _ignored, ...body } = content
    return Object.freeze({
      ...body,
      analysisHash: calculateCanonicalHash(body),
    })
  }))
  const candidateRanges = cleanRanges(
    segments,
    sourceDurationMs,
    policy,
  )
  assertDomain(
    candidateRanges.length >= 1,
    'SOURCE_DECONSTRUCTION_NO_CLEAN_RANGE',
    'No clean candidate range satisfies the requested role',
  )
  const removedRangesMs = complementRanges(
    candidateRanges,
    sourceDurationMs,
  )
  const cleanDurationMs = candidateRanges.reduce(
    (sum, candidate) =>
      sum + candidate.rangeMs[1] - candidate.rangeMs[0],
    0,
  )
  const removedDurationMs = sourceDurationMs - cleanDurationMs
  const mappings = Object.freeze(segments.map((segment) => {
    const cleanRange = candidateRanges.find((candidate) =>
      candidate.sourceSpeechSegmentIds
        .includes(segment.sourceSpeechSegmentId))
    return Object.freeze({
      sourceSpeechSegmentId: segment.sourceSpeechSegmentId,
      sourceRangeMs: segment.rangeMs,
      ...(cleanRange ? { cleanRangeId: cleanRange.id } : {}),
      role: segment.role,
      included: Boolean(cleanRange),
    })
  }))
  const comparisonContent = Object.freeze({
    sourceRangeMs: Object.freeze([
      0,
      sourceDurationMs,
    ]) as readonly [number, number],
    cleanRangesMs: Object.freeze(
      candidateRanges.map((candidate) => candidate.rangeMs),
    ),
    removedRangesMs,
    sourceDurationMs,
    cleanDurationMs,
    removedDurationMs,
    retainedRatio: Number(
      (cleanDurationMs / sourceDurationMs).toFixed(4),
    ),
    sourceSegmentCount: segments.length,
    includedSegmentCount: segments.filter((segment) =>
      segment.included).length,
    excludedSegmentCount: segments.filter((segment) =>
      !segment.included).length,
    sourceTranscript: segments.map((segment) =>
      segment.exactText).join(' '),
    cleanTranscript: segments.filter((segment) =>
      segment.included).map((segment) =>
      segment.exactText).join(' '),
    mappings,
  })
  const comparison = Object.freeze({
    ...comparisonContent,
    comparisonHash: calculateCanonicalHash(comparisonContent),
  })
  const contaminants = semanticContaminants(segments)
  const contextPreserved = candidateRanges.every((candidate) =>
    candidate.contextPreserved)
  const confidence = Number(
    (candidateRanges.reduce(
      (sum, candidate) => sum + candidate.confidence,
      0,
    ) / candidateRanges.length).toFixed(4),
  )
  const contextPenalty = contextPreserved ? 0 : 0.2
  const weakBoundaryPenalty = candidateRanges.some((candidate) =>
    candidate.confidence < 0.65) ? 0.1 : 0
  const editabilityScore = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        (confidence - contextPenalty - weakBoundaryPenalty) * 100,
      ),
    ),
  )
  const decision: SourceDeconstructionDecision =
    editabilityScore >= 70 && contextPreserved
      ? 'automatic'
      : editabilityScore >= 50
        ? 'human-review'
        : 'reject'
  const decisionReasonCodes = Object.freeze([
    contextPreserved
      ? 'speech-context-preserved'
      : 'speech-context-review-required',
    editabilityScore >= 70
      ? 'editability-at-least-70'
      : editabilityScore >= 50
        ? 'editability-between-50-and-69'
        : 'editability-below-50',
    contaminants.length > 0
      ? 'non-target-material-isolated'
      : 'no-non-target-material',
  ])
  const content = Object.freeze({
    schemaVersion: SOURCE_DECONSTRUCTION_SCHEMA_VERSION,
    id: identity(input.id, 'id'),
    workspaceId: identity(input.workspaceId, 'workspaceId'),
    projectId: identity(input.projectId, 'projectId'),
    sourceArtifactId: identity(
      input.sourceArtifactId,
      'sourceArtifactId',
    ),
    sourceArtifactSha256: hash(
      input.sourceArtifactSha256,
      'sourceArtifactSha256',
    ),
    sourceTranscriptId: identity(
      input.sourceTranscriptId,
      'sourceTranscriptId',
    ),
    sourceTranscriptHash: hash(
      input.sourceTranscriptHash,
      'sourceTranscriptHash',
    ),
    sourceDurationMs,
    desiredRole: input.desiredRole,
    validationScope: input.validationScope,
    targetComposition,
    boundaryPolicy: policy,
    analyzer: Object.freeze({
      policyVersion: SOURCE_DECONSTRUCTION_POLICY_VERSION,
      version: SOURCE_DECONSTRUCTION_ANALYZER_VERSION,
      evidenceSource: 'cataloged-speech' as const,
    }),
    segments,
    hookEnvelope: hookEnvelope(segments),
    bodyRanges: roleRanges(segments, 'body'),
    ctaRanges: roleRanges(segments, 'cta'),
    cleanCandidateRanges: candidateRanges,
    semanticContaminants: contaminants,
    comparison,
    confidence,
    editabilityScore,
    decision,
    contextPreserved,
    decisionReasonCodes,
    createdByClientId: identity(
      input.createdByClientId,
      'createdByClientId',
    ),
    createdAt: instant(input.createdAt, 'createdAt'),
  })
  return Object.freeze({
    ...content,
    reportHash: calculateCanonicalHash(reportBody(content)),
  })
}

export function hydrateSourceDeconstructionReport(
  value: Readonly<SourceDeconstructionReport>,
): Readonly<SourceDeconstructionReport> {
  const rebuilt = createSourceDeconstructionReport({
    id: value.id,
    workspaceId: value.workspaceId,
    projectId: value.projectId,
    sourceArtifactId: value.sourceArtifactId,
    sourceArtifactSha256: value.sourceArtifactSha256,
    sourceTranscriptId: value.sourceTranscriptId,
    sourceTranscriptHash: value.sourceTranscriptHash,
    sourceDurationMs: value.sourceDurationMs,
    desiredRole: value.desiredRole,
    validationScope: value.validationScope,
    targetComposition: value.targetComposition,
    boundaryPolicy: value.boundaryPolicy,
    speechEvidence: value.segments.map((segment) =>
      Object.freeze({
        id: segment.sourceSpeechSegmentId,
        sourceSegmentId: segment.sourceSegmentId,
        exactText: segment.exactText,
        normalizedText: segment.normalizedText,
        rangeMs: segment.rangeMs,
        completeThoughtScore: segment.completeThoughtScore,
        classification: segment.classification,
        intentions: segment.roleReasonCodes.includes('catalog-intention')
          ? Object.freeze([{
              value: segment.role,
              confidence: segment.roleConfidence,
              provenance: 'persisted-role-projection',
            }])
          : Object.freeze([]),
        segmentHash: segment.segmentHash,
      })),
    createdByClientId: value.createdByClientId,
    createdAt: value.createdAt,
  })
  assertDomain(
    stableSerialize(rebuilt) === stableSerialize(value) &&
      rebuilt.reportHash === value.reportHash,
    'PERSISTENCE_CONFLICT',
    'Stored source deconstruction report is inconsistent',
  )
  return rebuilt
}

export interface CleanupContaminationInput {
  id: string
  rangeMs: readonly [number, number]
  region: {
    x: number
    y: number
    width: number
    height: number
  }
  confidence: number
  overlapsEssential: boolean
}

export type CleanupStrategy =
  | 'trim'
  | 'crop-reframe'
  | 'cover'
  | 'reject'

export function planCleanup(input: {
  sourceArtifactId: string
  contamination: CleanupContaminationInput
  residualQuality: number
  integrity: number
  costs: Readonly<
    Record<Exclude<CleanupStrategy, 'reject'>, number>
  >
  maxCost: number
}) {
  const contamination = input.contamination
  const viable: Array<{
    strategy: CleanupStrategy
    score: number
    reason: string
  }> = []
  if (
    contamination.rangeMs[0] === 0 ||
    contamination.rangeMs[1] > 0
  ) {
    viable.push({
      strategy: 'trim',
      score: input.integrity -
        (contamination.overlapsEssential ? 0.8 : 0),
      reason: 'remove-time-range',
    })
  }
  if (
    contamination.region.width < 0.25 ||
    contamination.region.height < 0.2
  ) {
    viable.push({
      strategy: 'crop-reframe',
      score: input.residualQuality -
        (input.costs['crop-reframe'] > input.maxCost ? 0.5 : 0),
      reason: 'remove-edge-region',
    })
  }
  viable.push({
    strategy: 'cover',
    score: input.residualQuality -
      (contamination.overlapsEssential ? 0.7 : 0) -
      (input.costs.cover > input.maxCost ? 0.5 : 0),
    reason: 'replace-region',
  })
  const best = viable.sort((left, right) =>
    right.score - left.score)[0]
  const selected: CleanupStrategy =
    !best || best.score < 0.55 ? 'reject' : best.strategy
  return Object.freeze({
    selected,
    candidates: Object.freeze(viable),
    derivative: selected === 'reject'
      ? null
      : Object.freeze({
          id: `derived_${input.sourceArtifactId}_${contamination.id}`,
          sourceArtifactId: input.sourceArtifactId,
          sourceImmutable: true as const,
          strategy: selected,
        }),
    postCleanupReview: Object.freeze({
      rightsReevaluationRequired: selected !== 'reject',
      visualReevaluationRequired: selected !== 'reject',
    }),
    rejected: selected === 'reject',
  })
}
