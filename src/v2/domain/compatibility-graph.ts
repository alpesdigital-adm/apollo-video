import {
  calculateCanonicalHash,
  stableSerialize,
} from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import {
  hydrateTakeLibraryRun,
  type TakeLibraryRun,
  type TakeRecord,
} from './take-library.ts'

/**
 * ADR-160 F8. v2 is what is created: a context the requester did not state is `unspecified`, the check that needs it is `not-evaluable`,
 * and the soft dimension that needs it is left out of the weighted score (the weights of the others are renormalized). v1 graphs, made when
 * every context was required, stay readable and keep their sealed bodies.
 */
export const COMPATIBILITY_GRAPH_SCHEMA_VERSION =
  'compatibility-graph/v2' as const
export const COMPATIBILITY_RULE_VERSION =
  'compatibility-rules/v2' as const
export const COMPATIBILITY_SOFT_SCORE_VERSION =
  'compatibility-soft-score/v2' as const
export const COMPATIBILITY_GRAPH_SCHEMA_VERSION_V1 =
  'compatibility-graph/v1' as const
export const COMPATIBILITY_RULE_VERSION_V1 =
  'compatibility-rules/v1' as const
export const COMPATIBILITY_SOFT_SCORE_VERSION_V1 =
  'compatibility-soft-score/v1' as const

/** The value of a context the requester did not state (identifiers and tags), and the undetermined locale. Never a guess. */
export const UNSPECIFIED_CONTEXT = 'unspecified' as const
export const UNSPECIFIED_LOCALE = 'und' as const
/** The context fields that can be left unstated, in the order they are listed on a node. */
export const COMPATIBILITY_CONTEXT_FIELDS = [
  'audienceTags',
  'desiredAction',
  'energy',
  'experiment',
  'locale',
  'narrativeTags',
  'offerId',
  'personaId',
  'tone',
  'visual',
] as const
export type CompatibilityContextField = (typeof COMPATIBILITY_CONTEXT_FIELDS)[number]

export const COMPATIBILITY_ROLES = [
  'hook',
  'body',
  'proof',
  'cta',
] as const
export const COMPATIBILITY_RELATIONS = [
  'hook-body',
  'body-proof',
  'body-cta',
  'proof-cta',
] as const
export const COMPATIBILITY_SOFT_DIMENSIONS = [
  'narrative',
  'tone',
  'energy',
  'duration',
  'visual',
  'experiment',
] as const
export const COMPATIBILITY_HARD_REASON_CODES = [
  'OFFER_MISMATCH',
  'AUDIENCE_CONFLICT',
  'CLAIM_CONTRADICTION',
  'PERSONA_MISMATCH',
  'LOCALE_MISMATCH',
  'CTA_ACTION_MISMATCH',
  'REQUIRED_CONTINUITY_MISSING',
] as const

export type CompatibilityRole = (typeof COMPATIBILITY_ROLES)[number]
export type CompatibilityRelation =
  (typeof COMPATIBILITY_RELATIONS)[number]
export type CompatibilitySoftDimension =
  (typeof COMPATIBILITY_SOFT_DIMENSIONS)[number]
export type CompatibilityHardReasonCode =
  (typeof COMPATIBILITY_HARD_REASON_CODES)[number]
export type CompatibilityEdgeDecision =
  'accepted' | 'borderline' | 'blocked'

export interface CompatibilityClaim {
  key: string
  value: string
}

/**
 * What the requester stated about a take's context. Every semantic field is optional: an absent one is `unspecified`
 * (ADR-160 F8), never a default. An empty tag list is absent too.
 */
export interface CompatibilityNodeContextInput {
  takeId: string
  expectedTakeHash: string
  offerId?: string
  audienceTags?: readonly string[]
  claims: readonly Readonly<CompatibilityClaim>[]
  personaId?: string
  locale?: string
  desiredAction?: string
  continuityProvides: readonly string[]
  continuityRequires: readonly string[]
  narrativeTags?: readonly string[]
  tone?: number
  energy?: number
  visual?: number
  experiment?: number
  evidenceRefs: readonly string[]
}

export interface CompatibilityNode {
  id: string
  takeId: string
  takeHash: string
  groupId: string
  scriptBlockId?: string
  role: CompatibilityRole
  sourceArtifactId: string
  sourceHash: string
  sourceRangeMs: readonly [number, number]
  durationMs: number
  offerId: string
  audienceTags: readonly string[]
  claims: readonly Readonly<CompatibilityClaim>[]
  personaId: string
  locale: string
  desiredAction?: string
  continuityProvides: readonly string[]
  continuityRequires: readonly string[]
  narrativeTags: readonly string[]
  /** null = the requester did not state it (v2): the dimension it feeds is not evaluated. */
  tone: number | null
  energy: number | null
  visual: number | null
  experiment: number | null
  evidenceRefs: readonly string[]
  /** v2: the context fields the requester did not state. Their values above are the sentinels, and the checks they feed are not evaluable. */
  unspecified?: readonly CompatibilityContextField[]
  contextHash: string
  nodeHash: string
}

export interface CompatibilityHardFailure {
  code: CompatibilityHardReasonCode
  field: string
  message: string
  evidenceRefs: readonly string[]
  failureHash: string
}

export interface CompatibilitySoftScore {
  dimension: CompatibilitySoftDimension
  /** null = not evaluable (v2): a context it needs was not stated; weight is then 0 and it is left out of the weighted score. */
  score: number | null
  weight: number
  reasonCode: string
  evidenceRefs: readonly string[]
  scoreHash: string
}

export interface CompatibilityEdgeEvidence {
  fromTakeHash: string
  toTakeHash: string
  fromSourceHash: string
  toSourceHash: string
  fromContextHash: string
  toContextHash: string
  ruleVersion: typeof COMPATIBILITY_RULE_VERSION | typeof COMPATIBILITY_RULE_VERSION_V1
  softScoreVersion: typeof COMPATIBILITY_SOFT_SCORE_VERSION | typeof COMPATIBILITY_SOFT_SCORE_VERSION_V1
  evidenceHash: string
}

/** v2. A hard check that could not be made because a context it needs was not stated on one of the two takes. */
export interface CompatibilityNotEvaluableCheck {
  check: CompatibilityHardReasonCode
  fields: readonly CompatibilityContextField[]
}

export interface CompatibilityEdge {
  id: string
  fromNodeId: string
  toNodeId: string
  relation: CompatibilityRelation
  decision: CompatibilityEdgeDecision
  eligible: boolean
  hardFailures: readonly Readonly<CompatibilityHardFailure>[]
  softScores: readonly Readonly<CompatibilitySoftScore>[]
  softScore: number
  reasonCodes: readonly string[]
  /** v2: the checks that were not evaluable, and the fields that were missing for each. */
  notEvaluable?: readonly Readonly<CompatibilityNotEvaluableCheck>[]
  evidence: Readonly<CompatibilityEdgeEvidence>
  edgeHash: string
}

export interface CompatibilityGraphSummary {
  nodeCount: number
  edgeCount: number
  acceptedCount: number
  borderlineCount: number
  blockedCount: number
  hardFailureCount: number
  averageSoftScore: number
  /** v2: how many edges have at least one check or dimension that was not evaluable. */
  notEvaluableEdgeCount?: number
}

export interface CompatibilityGraphRun {
  id: string
  workspaceId: string
  projectId: string
  batchId: string
  takeLibraryId: string
  takeLibraryRunHash: string
  schemaVersion: typeof COMPATIBILITY_GRAPH_SCHEMA_VERSION | typeof COMPATIBILITY_GRAPH_SCHEMA_VERSION_V1
  ruleVersion: typeof COMPATIBILITY_RULE_VERSION | typeof COMPATIBILITY_RULE_VERSION_V1
  softScoreVersion: typeof COMPATIBILITY_SOFT_SCORE_VERSION | typeof COMPATIBILITY_SOFT_SCORE_VERSION_V1
  acceptThreshold: number
  reviewThreshold: number
  nodes: readonly Readonly<CompatibilityNode>[]
  edges: readonly Readonly<CompatibilityEdge>[]
  summary: Readonly<CompatibilityGraphSummary>
  createdByClientId: string
  createdAt: string
  runHash: string
}

export interface CreateCompatibilityGraphInput {
  id: string
  workspaceId: string
  projectId: string
  batchId: string
  takeLibrary: Readonly<TakeLibraryRun>
  contexts: readonly Readonly<CompatibilityNodeContextInput>[]
  acceptThreshold?: number
  reviewThreshold?: number
  createdByClientId: string
  createdAt: string
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
const LOCALE = /^[a-z]{2,3}(?:-[A-Z][A-Za-z0-9]{1,7})?$/
const REASON = /^[A-Z][A-Z0-9_]{2,79}$/
/** The weight of the context (everything but the duration) that must be evaluated for the Apollo to decide a link by itself: the strongest single signal. */
export const MIN_CONTEXT_WEIGHT_FOR_DECISION = 0.3
const SOFT_WEIGHTS: Readonly<
  Record<CompatibilitySoftDimension, number>
> = Object.freeze({
  narrative: 0.3,
  tone: 0.15,
  energy: 0.15,
  duration: 0.15,
  visual: 0.15,
  experiment: 0.1,
})

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

function threshold(value: unknown, field: string): number {
  assertDomain(
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100,
    'INVALID_ARGUMENT',
    `${field} must be between 0 and 100`,
  )
  return Number(value.toFixed(3))
}

function instant(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && Number.isFinite(Date.parse(value)),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return new Date(value).toISOString()
}

function sortedUniqueTokens(
  values: unknown,
  field: string,
  minimum = 0,
  maximum = 100,
): readonly string[] {
  assertDomain(
    Array.isArray(values) &&
    values.length >= minimum &&
    values.length <= maximum,
    'INVALID_ARGUMENT',
    `${field} must contain ${minimum} to ${maximum} entries`,
  )
  const normalized = values.map((entry, index) =>
    identity(entry, `${field}[${index}]`))
  assertDomain(
    new Set(normalized).size === normalized.length,
    'INVALID_ARGUMENT',
    `${field} must not contain duplicates`,
  )
  return Object.freeze(normalized.toSorted())
}

function claims(
  values: unknown,
  field: string,
): readonly Readonly<CompatibilityClaim>[] {
  assertDomain(
    Array.isArray(values) && values.length <= 100,
    'INVALID_ARGUMENT',
    `${field} must contain at most 100 entries`,
  )
  const result = values.map((entry, index) => {
    assertDomain(
      typeof entry === 'object' &&
      entry !== null &&
      !Array.isArray(entry),
      'INVALID_ARGUMENT',
      `${field}[${index}] is invalid`,
    )
    const value = entry as Record<string, unknown>
    assertDomain(
      Object.keys(value).every((key) =>
        ['key', 'value'].includes(key)),
      'INVALID_ARGUMENT',
      `${field}[${index}] contains unknown fields`,
    )
    return Object.freeze({
      key: identity(value.key, `${field}[${index}].key`),
      value: boundedText(
        value.value,
        `${field}[${index}].value`,
        1,
        500,
      ),
    })
  }).toSorted((left, right) =>
    left.key.localeCompare(right.key) ||
    left.value.localeCompare(right.value))
  assertDomain(
    new Set(result.map((claim) => claim.key)).size === result.length,
    'INVALID_ARGUMENT',
    `${field} must not contain duplicate keys`,
  )
  return Object.freeze(result)
}

function role(value: unknown, field: string): CompatibilityRole {
  assertDomain(
    typeof value === 'string' &&
    COMPATIBILITY_ROLES.includes(value as CompatibilityRole),
    'INVALID_ARGUMENT',
    `${field} is not eligible for compatibility`,
  )
  return value as CompatibilityRole
}

function relation(
  from: CompatibilityRole,
  to: CompatibilityRole,
): CompatibilityRelation | null {
  const key = `${from}-${to}` as CompatibilityRelation
  return COMPATIBILITY_RELATIONS.includes(key) ? key : null
}

function contextBody(value: CompatibilityNode, v2: boolean) {
  return {
    offerId: value.offerId,
    audienceTags: value.audienceTags,
    claims: value.claims,
    personaId: value.personaId,
    locale: value.locale,
    ...(value.desiredAction
      ? { desiredAction: value.desiredAction }
      : {}),
    continuityProvides: value.continuityProvides,
    continuityRequires: value.continuityRequires,
    narrativeTags: value.narrativeTags,
    tone: value.tone,
    energy: value.energy,
    visual: value.visual,
    experiment: value.experiment,
    evidenceRefs: value.evidenceRefs,
    ...(v2 ? { unspecified: value.unspecified ?? [] } : {}),
  }
}

function nodeBody(value: CompatibilityNode, v2: boolean) {
  return {
    id: value.id,
    takeId: value.takeId,
    takeHash: value.takeHash,
    groupId: value.groupId,
    ...(value.scriptBlockId
      ? { scriptBlockId: value.scriptBlockId }
      : {}),
    role: value.role,
    sourceArtifactId: value.sourceArtifactId,
    sourceHash: value.sourceHash,
    sourceRangeMs: value.sourceRangeMs,
    durationMs: value.durationMs,
    ...contextBody(value, v2),
    contextHash: value.contextHash,
  }
}

function compatibilityNode(
  graphId: string,
  take: Readonly<TakeRecord>,
  input: Readonly<CompatibilityNodeContextInput>,
): Readonly<CompatibilityNode> {
  assertDomain(
    take.id === identity(input.takeId, 'context.takeId') &&
    take.takeHash === input.expectedTakeHash,
    'VERSION_CONFLICT',
    `Take ${input.takeId} changed before compatibility analysis`,
  )
  const nodeRole = role(take.assignment.role, 'take.assignment.role')
  assertDomain(
    take.status === 'primary' || take.status === 'alternate',
    'PRECONDITION_REQUIRED',
    `Take ${take.id} is not eligible for compatibility`,
  )
  const unspecified: CompatibilityContextField[] = []
  const given = (value: unknown, field: CompatibilityContextField): boolean => {
    const given = value !== undefined && value !== null &&
      !(Array.isArray(value) && value.length === 0)
    if (!given) unspecified.push(field)
    return given
  }
  const offerId = given(input.offerId, 'offerId')
    ? identity(input.offerId, 'context.offerId')
    : UNSPECIFIED_CONTEXT
  const audienceTags = given(input.audienceTags, 'audienceTags')
    ? sortedUniqueTokens(input.audienceTags, 'context.audienceTags', 1)
    : Object.freeze([UNSPECIFIED_CONTEXT])
  const personaId = given(input.personaId, 'personaId')
    ? identity(input.personaId, 'context.personaId')
    : UNSPECIFIED_CONTEXT
  let locale: string = UNSPECIFIED_LOCALE
  if (given(input.locale, 'locale')) {
    locale = boundedText(input.locale, 'context.locale', 2, 16)
    assertDomain(
      LOCALE.test(locale),
      'INVALID_ARGUMENT',
      'context.locale is invalid',
    )
  }
  const desiredAction = given(input.desiredAction, 'desiredAction')
    ? identity(input.desiredAction, 'context.desiredAction')
    : undefined
  const narrativeTags = given(input.narrativeTags, 'narrativeTags')
    ? sortedUniqueTokens(input.narrativeTags, 'context.narrativeTags', 1)
    : Object.freeze([UNSPECIFIED_CONTEXT])
  const tone = given(input.tone, 'tone') ? unit(input.tone, 'context.tone') : null
  const energy = given(input.energy, 'energy') ? unit(input.energy, 'context.energy') : null
  const visual = given(input.visual, 'visual') ? unit(input.visual, 'context.visual') : null
  const experiment = given(input.experiment, 'experiment')
    ? unit(input.experiment, 'context.experiment')
    : null
  const prepared = {
    id: `compat-node-${calculateCanonicalHash({
      graphId,
      takeId: take.id,
      takeHash: take.takeHash,
    }).slice(0, 48)}`,
    takeId: take.id,
    takeHash: take.takeHash,
    groupId: take.groupId,
    ...(take.assignment.scriptBlockId
      ? { scriptBlockId: take.assignment.scriptBlockId }
      : {}),
    role: nodeRole,
    sourceArtifactId: take.sourceArtifactId,
    sourceHash: take.sourceHash,
    sourceRangeMs: Object.freeze([
      take.sourceRangeMs[0],
      take.sourceRangeMs[1],
    ]) as readonly [number, number],
    durationMs: take.sourceRangeMs[1] - take.sourceRangeMs[0],
    offerId,
    audienceTags,
    claims: claims(input.claims, 'context.claims'),
    personaId,
    locale,
    ...(desiredAction ? { desiredAction } : {}),
    continuityProvides: sortedUniqueTokens(
      input.continuityProvides,
      'context.continuityProvides',
    ),
    continuityRequires: sortedUniqueTokens(
      input.continuityRequires,
      'context.continuityRequires',
    ),
    narrativeTags,
    tone,
    energy,
    visual,
    experiment,
    evidenceRefs: sortedUniqueTokens(
      input.evidenceRefs,
      'context.evidenceRefs',
      1,
    ),
    unspecified: Object.freeze(unspecified.toSorted()),
  }
  const contextHash = calculateCanonicalHash(
    contextBody(prepared as unknown as CompatibilityNode, true),
  )
  const body = {
    ...prepared,
    contextHash,
  } as unknown as CompatibilityNode
  return Object.freeze({
    ...body,
    nodeHash: calculateCanonicalHash(nodeBody(body, true)),
  })
}

function hardFailure(
  code: CompatibilityHardReasonCode,
  field: string,
  message: string,
  evidenceRefs: readonly string[],
): Readonly<CompatibilityHardFailure> {
  const body = {
    code,
    field,
    message,
    evidenceRefs: Object.freeze([...new Set(evidenceRefs)].toSorted()),
  }
  return Object.freeze({
    ...body,
    failureHash: calculateCanonicalHash(body),
  })
}

function overlap(
  left: readonly string[],
  right: readonly string[],
): readonly string[] {
  const values = new Set(right)
  return Object.freeze(left.filter((value) => values.has(value)))
}

function jaccard(
  left: readonly string[],
  right: readonly string[],
): number {
  const union = new Set([...left, ...right])
  if (union.size === 0) return 1
  return overlap(left, right).length / union.size
}

function similarity(left: number, right: number): number {
  return 1 - Math.min(1, Math.abs(left - right))
}

function durationSimilarity(left: number, right: number): number {
  const maximum = Math.max(left, right)
  return maximum === 0 ? 1 : Math.min(left, right) / maximum
}

function softScore(
  dimension: CompatibilitySoftDimension,
  score: number | null,
  from: CompatibilityNode,
  to: CompatibilityNode,
): Readonly<CompatibilitySoftScore> {
  const evaluable = score !== null
  const body = {
    dimension,
    score: evaluable
      ? Number(Math.max(0, Math.min(1, score)).toFixed(6))
      : null,
    weight: evaluable ? SOFT_WEIGHTS[dimension] : 0,
    reasonCode: evaluable
      ? `${dimension.toUpperCase()}_CONTINUITY`
      : `${dimension.toUpperCase()}_NOT_EVALUABLE`,
    evidenceRefs: Object.freeze([
      from.contextHash,
      to.contextHash,
      from.takeHash,
      to.takeHash,
    ]),
  }
  return Object.freeze({
    ...body,
    scoreHash: calculateCanonicalHash(body),
  })
}

function edgeEvidence(
  from: CompatibilityNode,
  to: CompatibilityNode,
): Readonly<CompatibilityEdgeEvidence> {
  const body = {
    fromTakeHash: from.takeHash,
    toTakeHash: to.takeHash,
    fromSourceHash: from.sourceHash,
    toSourceHash: to.sourceHash,
    fromContextHash: from.contextHash,
    toContextHash: to.contextHash,
    ruleVersion: COMPATIBILITY_RULE_VERSION,
    softScoreVersion: COMPATIBILITY_SOFT_SCORE_VERSION,
  }
  return Object.freeze({
    ...body,
    evidenceHash: calculateCanonicalHash(body),
  })
}

function stated(
  field: CompatibilityContextField,
  from: CompatibilityNode,
  to: CompatibilityNode,
): boolean {
  return !(from.unspecified ?? []).includes(field) &&
    !(to.unspecified ?? []).includes(field)
}

function failures(
  from: CompatibilityNode,
  to: CompatibilityNode,
): {
  hardFailures: readonly Readonly<CompatibilityHardFailure>[]
  notEvaluable: readonly Readonly<CompatibilityNotEvaluableCheck>[]
} {
  const result: CompatibilityHardFailure[] = []
  const notEvaluable: CompatibilityNotEvaluableCheck[] = []
  const check = (
    code: CompatibilityHardReasonCode,
    field: CompatibilityContextField,
  ): boolean => {
    if (stated(field, from, to)) return true
    notEvaluable.push({ check: code, fields: [field] })
    return false
  }
  const refs = [from.contextHash, to.contextHash]
  if (check('OFFER_MISMATCH', 'offerId') && from.offerId !== to.offerId) {
    result.push(hardFailure(
      'OFFER_MISMATCH',
      'offerId',
      `Offer ${from.offerId} does not match ${to.offerId}`,
      refs,
    ))
  }
  if (
    check('AUDIENCE_CONFLICT', 'audienceTags') &&
    overlap(from.audienceTags, to.audienceTags).length === 0
  ) {
    result.push(hardFailure(
      'AUDIENCE_CONFLICT',
      'audienceTags',
      'Nodes have no compatible audience tag',
      refs,
    ))
  }
  const toClaims = new Map(to.claims.map((claim) =>
    [claim.key, claim.value]))
  const contradictions = from.claims.filter((claim) =>
    toClaims.has(claim.key) &&
    toClaims.get(claim.key) !== claim.value)
  if (contradictions.length > 0) {
    result.push(hardFailure(
      'CLAIM_CONTRADICTION',
      'claims',
      `Claim ${contradictions.map((claim) => claim.key).join(', ')} contradicts`,
      refs,
    ))
  }
  if (check('PERSONA_MISMATCH', 'personaId') && from.personaId !== to.personaId) {
    result.push(hardFailure(
      'PERSONA_MISMATCH',
      'personaId',
      `Persona ${from.personaId} does not match ${to.personaId}`,
      refs,
    ))
  }
  if (check('LOCALE_MISMATCH', 'locale') && from.locale !== to.locale) {
    result.push(hardFailure(
      'LOCALE_MISMATCH',
      'locale',
      `Locale ${from.locale} does not match ${to.locale}`,
      refs,
    ))
  }
  if (
    to.role === 'cta' &&
    check('CTA_ACTION_MISMATCH', 'desiredAction') &&
    from.desiredAction !== to.desiredAction
  ) {
    result.push(hardFailure(
      'CTA_ACTION_MISMATCH',
      'desiredAction',
      `Action ${from.desiredAction} does not match CTA ${to.desiredAction}`,
      refs,
    ))
  }
  const provided = new Set(from.continuityProvides)
  const missing = to.continuityRequires.filter((key) =>
    !provided.has(key))
  if (missing.length > 0) {
    result.push(hardFailure(
      'REQUIRED_CONTINUITY_MISSING',
      'continuityRequires',
      `Required continuity is missing: ${missing.join(', ')}`,
      refs,
    ))
  }
  return {
    hardFailures: Object.freeze(result),
    notEvaluable: Object.freeze(notEvaluable),
  }
}

function edgeBody(value: CompatibilityEdge, v2: boolean) {
  return {
    id: value.id,
    fromNodeId: value.fromNodeId,
    toNodeId: value.toNodeId,
    relation: value.relation,
    decision: value.decision,
    eligible: value.eligible,
    hardFailures: value.hardFailures,
    softScores: value.softScores,
    softScore: value.softScore,
    reasonCodes: value.reasonCodes,
    ...(v2 ? { notEvaluable: value.notEvaluable ?? [] } : {}),
    evidence: value.evidence,
  }
}

function compatibilityEdge(
  from: CompatibilityNode,
  to: CompatibilityNode,
  edgeRelation: CompatibilityRelation,
  acceptThreshold: number,
  reviewThreshold: number,
): Readonly<CompatibilityEdge> {
  const { hardFailures, notEvaluable } = failures(from, to)
  const dimension = (
    field: CompatibilityContextField,
    value: (() => number),
  ): number | null => stated(field, from, to) ? value() : null
  const softScores = Object.freeze([
    softScore(
      'narrative',
      dimension('narrativeTags', () =>
        jaccard(from.narrativeTags, to.narrativeTags)),
      from,
      to,
    ),
    softScore(
      'tone',
      dimension('tone', () => similarity(from.tone!, to.tone!)),
      from,
      to,
    ),
    softScore(
      'energy',
      dimension('energy', () => similarity(from.energy!, to.energy!)),
      from,
      to,
    ),
    softScore(
      'duration',
      durationSimilarity(from.durationMs, to.durationMs),
      from,
      to,
    ),
    softScore(
      'visual',
      dimension('visual', () => similarity(from.visual!, to.visual!)),
      from,
      to,
    ),
    softScore(
      'experiment',
      dimension('experiment', () =>
        similarity(from.experiment!, to.experiment!)),
      from,
      to,
    ),
  ])
  // Only what was evaluated is scored: the weights of the dimensions left out are not spread by guessing, the others are renormalized.
  const evaluatedWeight = softScores.reduce((sum, score) =>
    sum + score.weight, 0)
  const weighted = Number((
    softScores.reduce((sum, score) =>
      sum + (score.score ?? 0) * score.weight, 0) / evaluatedWeight * 100
  ).toFixed(3))
  const contextNotEvaluable = notEvaluable.length > 0 ||
    softScores.some((score) => score.score === null)
  // The length of two takes is read from the takes themselves, but it says little about whether one leads to the other. When what was stated
  // about the takes does not carry a decision (no more than the duration, or less than the weight of the strongest single signal), the Apollo
  // neither approves nor blocks the link on its own: it is left for the owner to confirm, with the missing context named.
  const contextWeight = softScores.reduce((sum, score) =>
    sum + (score.dimension === 'duration' ? 0 : score.weight), 0)
  const needsOwner = hardFailures.length === 0 && contextWeight + 1e-9 < MIN_CONTEXT_WEIGHT_FOR_DECISION
  const decision: CompatibilityEdgeDecision = hardFailures.length > 0
    ? 'blocked'
    : needsOwner
      ? 'borderline'
      : weighted >= acceptThreshold
      ? 'accepted'
      : weighted >= reviewThreshold
        ? 'borderline'
        : 'blocked'
  const reasonCodes = Object.freeze([
    ...hardFailures.map((failure) => failure.code),
    ...(hardFailures.length === 0
      ? [
          needsOwner
            ? 'CONTEXT_REQUIRED_FOR_DECISION'
            : decision === 'accepted'
            ? 'COMPATIBLE'
            : decision === 'borderline'
              ? 'BORDERLINE_SOFT_SCORE'
              : 'LOW_SOFT_SCORE',
        ]
      : []),
    ...(contextNotEvaluable ? ['CONTEXT_NOT_EVALUABLE'] : []),
  ].toSorted())
  const evidence = edgeEvidence(from, to)
  const id = `compat-edge-${calculateCanonicalHash({
    fromNodeId: from.id,
    toNodeId: to.id,
    relation: edgeRelation,
  }).slice(0, 48)}`
  const body = {
    id,
    fromNodeId: from.id,
    toNodeId: to.id,
    relation: edgeRelation,
    decision,
    eligible: decision === 'accepted',
    hardFailures,
    softScores,
    softScore: weighted,
    reasonCodes,
    notEvaluable,
    evidence,
  } as CompatibilityEdge
  return Object.freeze({
    ...body,
    edgeHash: calculateCanonicalHash(edgeBody(body, true)),
  })
}

function graphSummary(
  nodes: readonly CompatibilityNode[],
  edges: readonly CompatibilityEdge[],
  v2: boolean,
): Readonly<CompatibilityGraphSummary> {
  return Object.freeze({
    nodeCount: nodes.length,
    edgeCount: edges.length,
    acceptedCount: edges.filter((edge) =>
      edge.decision === 'accepted').length,
    borderlineCount: edges.filter((edge) =>
      edge.decision === 'borderline').length,
    blockedCount: edges.filter((edge) =>
      edge.decision === 'blocked').length,
    hardFailureCount: edges.reduce((sum, edge) =>
      sum + edge.hardFailures.length, 0),
    averageSoftScore: edges.length === 0
      ? 0
      : Number((
          edges.reduce((sum, edge) => sum + edge.softScore, 0) /
          edges.length
        ).toFixed(3)),
    ...(v2
      ? {
          notEvaluableEdgeCount: edges.filter((edge) =>
            (edge.notEvaluable?.length ?? 0) > 0 ||
            edge.softScores.some((score) => score.score === null)).length,
        }
      : {}),
  })
}

function runBody(value: CompatibilityGraphRun) {
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    projectId: value.projectId,
    batchId: value.batchId,
    takeLibraryId: value.takeLibraryId,
    takeLibraryRunHash: value.takeLibraryRunHash,
    schemaVersion: value.schemaVersion,
    ruleVersion: value.ruleVersion,
    softScoreVersion: value.softScoreVersion,
    acceptThreshold: value.acceptThreshold,
    reviewThreshold: value.reviewThreshold,
    nodes: value.nodes,
    edges: value.edges,
    summary: value.summary,
    createdByClientId: value.createdByClientId,
    createdAt: value.createdAt,
  }
}

function freezeRun(
  value: Omit<CompatibilityGraphRun, 'runHash'>,
): Readonly<CompatibilityGraphRun> {
  const body = value as CompatibilityGraphRun
  return Object.freeze({
    ...value,
    runHash: calculateCanonicalHash(runBody(body)),
  })
}

function eligibleTakes(
  library: Readonly<TakeLibraryRun>,
): readonly Readonly<TakeRecord>[] {
  return Object.freeze(library.takes.filter((take) =>
    (take.status === 'primary' || take.status === 'alternate') &&
    COMPATIBILITY_ROLES.includes(
      take.assignment.role as CompatibilityRole,
    )))
}

export function createCompatibilityGraph(
  input: Readonly<CreateCompatibilityGraphInput>,
): Readonly<CompatibilityGraphRun> {
  const graphId = identity(input.id, 'compatibilityGraphId')
  const library = hydrateTakeLibraryRun(input.takeLibrary)
  assertDomain(
    library.workspaceId === input.workspaceId &&
    library.projectId === input.projectId &&
    library.batchId === input.batchId,
    'INVALID_ARGUMENT',
    'Take library does not belong to compatibility graph context',
  )
  const acceptThreshold = threshold(
    input.acceptThreshold ?? 70,
    'acceptThreshold',
  )
  const reviewThreshold = threshold(
    input.reviewThreshold ?? 60,
    'reviewThreshold',
  )
  assertDomain(
    reviewThreshold < acceptThreshold,
    'INVALID_ARGUMENT',
    'reviewThreshold must be lower than acceptThreshold',
  )
  assertDomain(
    Array.isArray(input.contexts) && input.contexts.length <= 2_000,
    'INVALID_ARGUMENT',
    'contexts must contain at most 2000 entries',
  )
  const contexts = new Map<string, CompatibilityNodeContextInput>()
  for (const [index, value] of input.contexts.entries()) {
    const takeId = identity(value?.takeId, `contexts[${index}].takeId`)
    assertDomain(
      !contexts.has(takeId),
      'INVALID_ARGUMENT',
      `Context for take ${takeId} is duplicated`,
    )
    contexts.set(takeId, value)
  }
  const takes = eligibleTakes(library)
  assertDomain(
    takes.length >= 2,
    'PRECONDITION_REQUIRED',
    'Compatibility graph requires at least two eligible takes',
  )
  assertDomain(
    contexts.size === takes.length &&
    takes.every((take) => contexts.has(take.id)),
    'PRECONDITION_REQUIRED',
    'Every eligible take requires exactly one compatibility context',
  )
  const nodes = Object.freeze(takes.map((take) =>
    compatibilityNode(graphId, take, contexts.get(take.id)!))
    .toSorted((left, right) =>
      COMPATIBILITY_ROLES.indexOf(left.role) -
      COMPATIBILITY_ROLES.indexOf(right.role) ||
      left.takeId.localeCompare(right.takeId)))
  const edges: CompatibilityEdge[] = []
  for (const from of nodes) {
    for (const to of nodes) {
      const edgeRelation = relation(from.role, to.role)
      if (edgeRelation) {
        edges.push(compatibilityEdge(
          from,
          to,
          edgeRelation,
          acceptThreshold,
          reviewThreshold,
        ))
      }
    }
  }
  assertDomain(
    edges.length >= 1,
    'PRECONDITION_REQUIRED',
    'Eligible takes do not form any supported compatibility relation',
  )
  const frozenEdges = Object.freeze(edges.toSorted((left, right) =>
    left.relation.localeCompare(right.relation) ||
    left.fromNodeId.localeCompare(right.fromNodeId) ||
    left.toNodeId.localeCompare(right.toNodeId)))
  return freezeRun({
    id: graphId,
    workspaceId: identity(input.workspaceId, 'workspaceId'),
    projectId: identity(input.projectId, 'projectId'),
    batchId: identity(input.batchId, 'batchId'),
    takeLibraryId: library.id,
    takeLibraryRunHash: library.runHash,
    schemaVersion: COMPATIBILITY_GRAPH_SCHEMA_VERSION,
    ruleVersion: COMPATIBILITY_RULE_VERSION,
    softScoreVersion: COMPATIBILITY_SOFT_SCORE_VERSION,
    acceptThreshold,
    reviewThreshold,
    nodes,
    edges: frozenEdges,
    summary: graphSummary(nodes, frozenEdges, true),
    createdByClientId: identity(
      input.createdByClientId,
      'createdByClientId',
    ),
    createdAt: instant(input.createdAt, 'createdAt'),
  })
}

export function hydrateCompatibilityGraph(
  value: Readonly<CompatibilityGraphRun>,
): Readonly<CompatibilityGraphRun> {
  const v2 = value?.schemaVersion === COMPATIBILITY_GRAPH_SCHEMA_VERSION
  assertDomain(
    (
      v2 &&
      value.ruleVersion === COMPATIBILITY_RULE_VERSION &&
      value.softScoreVersion === COMPATIBILITY_SOFT_SCORE_VERSION
    ) || (
      value?.schemaVersion === COMPATIBILITY_GRAPH_SCHEMA_VERSION_V1 &&
      value.ruleVersion === COMPATIBILITY_RULE_VERSION_V1 &&
      value.softScoreVersion === COMPATIBILITY_SOFT_SCORE_VERSION_V1
    ),
    'INVALID_ARGUMENT',
    'Compatibility graph has an invalid envelope',
  )
  assertDomain(
    HASH.test(value.takeLibraryRunHash ?? '') &&
    Array.isArray(value.nodes) &&
    value.nodes.length >= 2 &&
    Array.isArray(value.edges) &&
    value.edges.length >= 1,
    'INVALID_ARGUMENT',
    'Compatibility graph has an invalid envelope',
  )
  const acceptThreshold = threshold(
    value.acceptThreshold,
    'acceptThreshold',
  )
  const reviewThreshold = threshold(
    value.reviewThreshold,
    'reviewThreshold',
  )
  assertDomain(
    reviewThreshold < acceptThreshold,
    'INVALID_ARGUMENT',
    'Compatibility graph thresholds are invalid',
  )
  const nodeById = new Map<string, CompatibilityNode>()
  for (const node of value.nodes) {
    assertDomain(
      !nodeById.has(node.id) &&
      COMPATIBILITY_ROLES.includes(node.role) &&
      HASH.test(node.takeHash) &&
      HASH.test(node.sourceHash) &&
      HASH.test(node.contextHash) &&
      HASH.test(node.nodeHash) &&
      node.contextHash === calculateCanonicalHash(contextBody(node, v2)) &&
      node.nodeHash === calculateCanonicalHash(nodeBody(node, v2)),
      'INVALID_ARGUMENT',
      `Compatibility node ${node.id} failed integrity validation`,
    )
    if (v2) {
      // A context the requester did not state carries its sentinel and nothing else.
      const listed = node.unspecified ?? []
      assertDomain(
        listed.every((field: CompatibilityContextField) => COMPATIBILITY_CONTEXT_FIELDS.includes(field)) &&
        new Set(listed).size === listed.length &&
        (node.offerId === UNSPECIFIED_CONTEXT) === listed.includes('offerId') &&
        (node.personaId === UNSPECIFIED_CONTEXT) === listed.includes('personaId') &&
        (node.locale === UNSPECIFIED_LOCALE) === listed.includes('locale') &&
        (node.desiredAction === undefined) === listed.includes('desiredAction') &&
        (node.tone === null) === listed.includes('tone') &&
        (node.energy === null) === listed.includes('energy') &&
        (node.visual === null) === listed.includes('visual') &&
        (node.experiment === null) === listed.includes('experiment') &&
        node.audienceTags.includes(UNSPECIFIED_CONTEXT) === listed.includes('audienceTags') &&
        node.narrativeTags.includes(UNSPECIFIED_CONTEXT) === listed.includes('narrativeTags'),
        'INVALID_ARGUMENT',
        `Compatibility node ${node.id} lists unspecified fields that do not match its context`,
      )
    }
    nodeById.set(node.id, node)
  }
  const edgeIds = new Set<string>()
  for (const edge of value.edges) {
    const from = nodeById.get(edge.fromNodeId)
    const to = nodeById.get(edge.toNodeId)
    assertDomain(
      !edgeIds.has(edge.id) &&
      Boolean(from) &&
      Boolean(to) &&
      relation(from!.role, to!.role) === edge.relation &&
      edge.eligible === (edge.decision === 'accepted') &&
      edge.hardFailures.every((
        failure: Readonly<CompatibilityHardFailure>,
      ) =>
        COMPATIBILITY_HARD_REASON_CODES.includes(failure.code) &&
        failure.failureHash === calculateCanonicalHash({
          code: failure.code,
          field: failure.field,
          message: failure.message,
          evidenceRefs: failure.evidenceRefs,
        })) &&
      edge.softScores.length === COMPATIBILITY_SOFT_DIMENSIONS.length &&
      (!v2 || Array.isArray(edge.notEvaluable)) &&
      (edge.notEvaluable ?? []).every((
        item: Readonly<CompatibilityNotEvaluableCheck>,
      ) =>
        COMPATIBILITY_HARD_REASON_CODES.includes(item.check) &&
        item.fields.every((field: CompatibilityContextField) =>
          COMPATIBILITY_CONTEXT_FIELDS.includes(field))) &&
      edge.softScores.every((
        score: Readonly<CompatibilitySoftScore>,
      ) =>
        COMPATIBILITY_SOFT_DIMENSIONS.includes(score.dimension) &&
        (v2 || score.score !== null) &&
        score.scoreHash === calculateCanonicalHash({
          dimension: score.dimension,
          score: score.score,
          weight: score.weight,
          reasonCode: score.reasonCode,
          evidenceRefs: score.evidenceRefs,
        })) &&
      edge.evidence.evidenceHash === calculateCanonicalHash({
        fromTakeHash: edge.evidence.fromTakeHash,
        toTakeHash: edge.evidence.toTakeHash,
        fromSourceHash: edge.evidence.fromSourceHash,
        toSourceHash: edge.evidence.toSourceHash,
        fromContextHash: edge.evidence.fromContextHash,
        toContextHash: edge.evidence.toContextHash,
        ruleVersion: edge.evidence.ruleVersion,
        softScoreVersion: edge.evidence.softScoreVersion,
      }) &&
      edge.edgeHash === calculateCanonicalHash(edgeBody(edge, v2)),
      'INVALID_ARGUMENT',
      `Compatibility edge ${edge.id} failed integrity validation`,
    )
    edgeIds.add(edge.id)
  }
  assertDomain(
    stableSerialize(value.summary) === stableSerialize(
      graphSummary(value.nodes, value.edges, v2),
    ) &&
    value.runHash === calculateCanonicalHash(runBody(value)),
    'INVALID_ARGUMENT',
    'Compatibility graph aggregate failed integrity validation',
  )
  return Object.freeze({
    ...value,
    nodes: Object.freeze(value.nodes.map((node) =>
      Object.freeze({
        ...node,
        sourceRangeMs: Object.freeze([...node.sourceRangeMs]) as
          readonly [number, number],
        audienceTags: Object.freeze([...node.audienceTags]),
        claims: Object.freeze(node.claims.map((
          claim: Readonly<CompatibilityClaim>,
        ) =>
          Object.freeze({ ...claim }))),
        continuityProvides: Object.freeze([
          ...node.continuityProvides,
        ]),
        continuityRequires: Object.freeze([
          ...node.continuityRequires,
        ]),
        narrativeTags: Object.freeze([...node.narrativeTags]),
        evidenceRefs: Object.freeze([...node.evidenceRefs]),
        ...(node.unspecified
          ? { unspecified: Object.freeze([...node.unspecified]) }
          : {}),
      }))),
    edges: Object.freeze(value.edges.map((edge) =>
      Object.freeze({
        ...edge,
        hardFailures: Object.freeze(edge.hardFailures.map((
          failure: Readonly<CompatibilityHardFailure>,
        ) =>
          Object.freeze({
            ...failure,
            evidenceRefs: Object.freeze([...failure.evidenceRefs]),
          }))),
        softScores: Object.freeze(edge.softScores.map((
          score: Readonly<CompatibilitySoftScore>,
        ) =>
          Object.freeze({
            ...score,
            evidenceRefs: Object.freeze([...score.evidenceRefs]),
          }))),
        reasonCodes: Object.freeze([...edge.reasonCodes]),
        ...(edge.notEvaluable
          ? {
              notEvaluable: Object.freeze(edge.notEvaluable.map((
                item: Readonly<CompatibilityNotEvaluableCheck>,
              ) =>
                Object.freeze({
                  ...item,
                  fields: Object.freeze([...item.fields]),
                }))),
            }
          : {}),
        evidence: Object.freeze({ ...edge.evidence }),
      }))),
    summary: Object.freeze({ ...value.summary }),
  })
}
