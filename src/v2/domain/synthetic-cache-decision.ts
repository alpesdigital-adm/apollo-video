import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import {
  assertSyntheticCacheIdentityShape,
  calculateSyntheticCacheKey,
  syntheticCacheIdentityBody,
  SYNTHETIC_CACHE_OPERATIONS,
  type SyntheticCacheOperation,
  type SyntheticCacheSubject,
} from './synthetic-cache-identity.ts'

/**
 * The durable record of one cache decision.
 *
 * Until now the decision existed only as two columns on the generation it
 * happened to produce, so a decision that produced no generation — a consent
 * block, a deferred duplicate — left no trace at all, and the money the cache
 * saved was never written down anywhere. This aggregate is that missing ledger
 * entry: immutable, content-addressed, and readable without ever exposing the
 * script, the consent evidence or any provider secret.
 */
export const SYNTHETIC_CACHE_DECISION_SCHEMA_VERSION = 'synthetic-cache-decision/v1' as const

/**
 * Domain separator for the audit digest of the decided subject. The digest is
 * taken over the canonical identity body wrapped in this envelope so it is a
 * different value from the cache key itself: the key addresses the work, this
 * digest proves *which* identity body the ledger entry was written about,
 * without the row ever carrying the text that body was derived from.
 */
export const SYNTHETIC_CACHE_DECISION_SUBJECT_HASH_VERSION = 'synthetic-cache-decision-subject/v1' as const

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
const CURRENCY = /^[A-Z]{3}$/

export const SYNTHETIC_CACHE_DECISION_REASON_MIN_LENGTH = 3
export const SYNTHETIC_CACHE_DECISION_REASON_MAX_LENGTH = 500

/**
 * What the cache actually did for one unit of synthetic work.
 *
 * `blocked` is deliberately distinct from `miss`: a miss ends in a paid
 * generation, a block ends in nothing happening at all — a revoked consent or
 * an in-flight twin — and conflating the two would let a governance stop look
 * like ordinary cache traffic.
 */
export const SYNTHETIC_CACHE_DECISION_OUTCOMES = Object.freeze([
  'hit',
  'miss',
  'forced-regenerate',
  'blocked',
] as const)
export type SyntheticCacheDecisionOutcome = (typeof SYNTHETIC_CACHE_DECISION_OUTCOMES)[number]

export const SYNTHETIC_CACHE_DECISION_REASON_CODES = Object.freeze([
  'CACHE_HIT_ELIGIBLE',
  'CACHE_MISS_NO_CANDIDATE',
  'CANDIDATE_BLOB_UNAVAILABLE',
  'CANDIDATE_CHECKSUM_DRIFT',
  'CANDIDATE_OUTPUT_MISMATCH',
  'CANDIDATE_CRITIC_REJECTED',
  'CANDIDATE_RIGHTS_BLOCKED',
  'CONSENT_REVOKED',
  'MUST_REGENERATE',
  'IN_FLIGHT_TWIN',
] as const)
export type SyntheticCacheDecisionReasonCode = (typeof SYNTHETIC_CACHE_DECISION_REASON_CODES)[number]

/**
 * Which outcome each reason can justify. A candidate rejected for its blob,
 * its checksum, its output shape, its critic report or its rights is a `miss`,
 * never a `blocked`: the work is still generated and still paid for, and only
 * the reason differs. Only a decision where nothing was generated and nothing
 * reused is `blocked`.
 */
const REASON_CODE_OUTCOMES: Readonly<Record<SyntheticCacheDecisionReasonCode, readonly SyntheticCacheDecisionOutcome[]>> =
  Object.freeze({
    CACHE_HIT_ELIGIBLE: Object.freeze(['hit'] as const),
    CACHE_MISS_NO_CANDIDATE: Object.freeze(['miss'] as const),
    CANDIDATE_BLOB_UNAVAILABLE: Object.freeze(['miss'] as const),
    CANDIDATE_CHECKSUM_DRIFT: Object.freeze(['miss'] as const),
    CANDIDATE_OUTPUT_MISMATCH: Object.freeze(['miss'] as const),
    CANDIDATE_CRITIC_REJECTED: Object.freeze(['miss'] as const),
    CANDIDATE_RIGHTS_BLOCKED: Object.freeze(['miss'] as const),
    CONSENT_REVOKED: Object.freeze(['blocked'] as const),
    MUST_REGENERATE: Object.freeze(['forced-regenerate'] as const),
    IN_FLIGHT_TWIN: Object.freeze(['blocked'] as const),
  })

/**
 * Names a ledger entry must never carry. The ledger is read by operators and
 * exported to dashboards, so the script, the consent evidence and every
 * provider credential stay outside it: hashes and identifiers only.
 *
 * This list is intentionally not the cache-identity forbidden list — cost,
 * currency and project belong in a ledger entry precisely because they are
 * observational, which is exactly why they are banned from the cache key.
 */
export const SYNTHETIC_CACHE_DECISION_FORBIDDEN_FIELDS = Object.freeze([
  'exactText',
  'scriptText',
  'text',
  'transcript',
  'normalizedText',
  'consent',
  'consentEvidence',
  'consentEvidenceArtifactId',
  'apiKey',
  'apiSecret',
  'secret',
  'credential',
  'authorization',
  'signedUrl',
  'providerPayload',
  'providerInput',
] as const)

export interface SyntheticCacheDecision {
  schemaVersion: typeof SYNTHETIC_CACHE_DECISION_SCHEMA_VERSION
  id: string
  workspaceId: string
  projectId: string
  operation: SyntheticCacheOperation
  /** The canonical cache address the decision was taken about. */
  cacheKey: string
  /** Schema version of the identity body that produced `cacheKey`. */
  cacheKeyVersion: string
  outcome: SyntheticCacheDecisionOutcome
  reasonCode: SyntheticCacheDecisionReasonCode
  /** Human-readable justification; the operator-facing half of the reason. */
  reason: string
  /** The candidate that was considered, when there was one. */
  candidateGenerationId: string | null
  candidateMasterId: string | null
  /** The eligibility policy in force when the decision was taken. */
  policyVersion: string
  criticReportHash: string | null
  /** What a regeneration was estimated to cost, from persisted evidence. */
  estimatedSavingMinorUnits: number
  /** What was actually not paid. Non-zero only on a real reuse. */
  avoidedCostMinorUnits: number
  currency: string
  /** Audit digest of the decided identity body — never the text itself. */
  subjectHash: string
  decidedAt: string
  decisionHash: string
}

function instant(value: string, field: string): string {
  assertDomain(
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
    'INVALID_ARGUMENT',
    `${field} must be a canonical ISO instant`,
  )
  return value
}

function minorUnits(value: number, field: string): number {
  assertDomain(
    Number.isSafeInteger(value) && value >= 0,
    'INVALID_ARGUMENT',
    `${field} must be a non-negative integer amount in minor units`,
  )
  return value
}

/**
 * Audit digest of the identity the decision was taken about. Derived from the
 * same canonical body the cache key is derived from, so an auditor holding the
 * subject can reproduce it, and a ledger entry can never claim a subject it
 * was not written for.
 */
export function calculateSyntheticCacheDecisionSubjectHash(subject: Readonly<SyntheticCacheSubject>): string {
  assertSyntheticCacheIdentityShape(subject)
  return calculateCanonicalHash({
    schemaVersion: SYNTHETIC_CACHE_DECISION_SUBJECT_HASH_VERSION,
    identity: syntheticCacheIdentityBody(subject),
  })
}

/**
 * Content address of the decision. Everything the entry asserts participates,
 * so a row edited behind the application's back stops verifying.
 */
export function calculateSyntheticCacheDecisionHash(
  decision: Omit<SyntheticCacheDecision, 'decisionHash'>,
): string {
  return calculateCanonicalHash({
    schemaVersion: decision.schemaVersion,
    id: decision.id,
    workspaceId: decision.workspaceId,
    projectId: decision.projectId,
    operation: decision.operation,
    cacheKey: decision.cacheKey,
    cacheKeyVersion: decision.cacheKeyVersion,
    outcome: decision.outcome,
    reasonCode: decision.reasonCode,
    reason: decision.reason,
    candidateGenerationId: decision.candidateGenerationId,
    candidateMasterId: decision.candidateMasterId,
    policyVersion: decision.policyVersion,
    criticReportHash: decision.criticReportHash,
    estimatedSavingMinorUnits: decision.estimatedSavingMinorUnits,
    avoidedCostMinorUnits: decision.avoidedCostMinorUnits,
    currency: decision.currency,
    subjectHash: decision.subjectHash,
    decidedAt: decision.decidedAt,
  })
}

export interface SyntheticCacheDecisionInput {
  id: string
  workspaceId: string
  projectId: string
  /** The identity that was decided; hashed, never stored. */
  subject: Readonly<SyntheticCacheSubject>
  outcome: SyntheticCacheDecisionOutcome
  reasonCode: SyntheticCacheDecisionReasonCode
  reason: string
  candidateGenerationId?: string | null
  candidateMasterId?: string | null
  policyVersion: string
  criticReportHash?: string | null
  estimatedSavingMinorUnits: number
  avoidedCostMinorUnits: number
  currency: string
  decidedAt: string
}

export function createSyntheticCacheDecision(
  input: Readonly<SyntheticCacheDecisionInput>,
): Readonly<SyntheticCacheDecision> {
  for (const [field, value] of Object.entries({
    id: input.id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    policyVersion: input.policyVersion,
  })) {
    assertDomain(ID.test(value), 'INVALID_ARGUMENT', `cache decision ${field} is invalid`)
  }
  assertDomain(
    SYNTHETIC_CACHE_OPERATIONS.includes(input.subject.operation),
    'INVALID_ARGUMENT',
    'cache decision operation is not a synthetic cache operation',
  )
  assertDomain(
    SYNTHETIC_CACHE_DECISION_OUTCOMES.includes(input.outcome),
    'INVALID_ARGUMENT',
    `cache decision outcome ${input.outcome} is not part of the ledger`,
  )
  assertDomain(
    SYNTHETIC_CACHE_DECISION_REASON_CODES.includes(input.reasonCode),
    'INVALID_ARGUMENT',
    `cache decision reason code ${input.reasonCode} is not canonical`,
  )
  assertDomain(
    REASON_CODE_OUTCOMES[input.reasonCode].includes(input.outcome),
    'INVALID_ARGUMENT',
    `cache decision reason ${input.reasonCode} cannot justify outcome ${input.outcome}`,
  )
  const reason = input.reason.trim()
  assertDomain(
    reason.length >= SYNTHETIC_CACHE_DECISION_REASON_MIN_LENGTH &&
      reason.length <= SYNTHETIC_CACHE_DECISION_REASON_MAX_LENGTH,
    'INVALID_ARGUMENT',
    'cache decision reason must be between 3 and 500 characters',
  )

  const candidateGenerationId = input.candidateGenerationId ?? null
  const candidateMasterId = input.candidateMasterId ?? null
  assertDomain(
    candidateGenerationId === null || ID.test(candidateGenerationId),
    'INVALID_ARGUMENT',
    'cache decision candidateGenerationId is invalid',
  )
  assertDomain(
    candidateMasterId === null || ID.test(candidateMasterId),
    'INVALID_ARGUMENT',
    'cache decision candidateMasterId is invalid',
  )
  const criticReportHash = input.criticReportHash ?? null
  assertDomain(
    criticReportHash === null || HASH.test(criticReportHash),
    'INVALID_ARGUMENT',
    'cache decision criticReportHash is invalid',
  )
  assertDomain(CURRENCY.test(input.currency), 'INVALID_ARGUMENT', 'cache decision currency is invalid')

  const estimatedSavingMinorUnits = minorUnits(input.estimatedSavingMinorUnits, 'cache decision estimatedSavingMinorUnits')
  const avoidedCostMinorUnits = minorUnits(input.avoidedCostMinorUnits, 'cache decision avoidedCostMinorUnits')

  // A hit is the only outcome that avoided money, and it can only have avoided
  // money by reusing something that exists: no candidate, no saving.
  if (input.outcome === 'hit') {
    assertDomain(
      candidateGenerationId !== null || candidateMasterId !== null,
      'INVALID_ARGUMENT',
      'a cache hit must name the candidate it reused',
    )
    assertDomain(
      avoidedCostMinorUnits > 0,
      'INVALID_ARGUMENT',
      'a cache hit must record the cost it actually avoided',
    )
  } else {
    assertDomain(
      avoidedCostMinorUnits === 0,
      'INVALID_ARGUMENT',
      `outcome ${input.outcome} avoided no cost and must not claim one`,
    )
  }
  // A block reused nothing, so it must not point at a reusable candidate: that
  // would read as "this was available and we took it" in every report.
  if (input.outcome === 'blocked') {
    assertDomain(
      candidateGenerationId === null && candidateMasterId === null,
      'INVALID_ARGUMENT',
      'a blocked decision must not name a reusable candidate',
    )
  }
  assertDomain(
    estimatedSavingMinorUnits >= avoidedCostMinorUnits,
    'INVALID_ARGUMENT',
    'cache decision cannot have avoided more than it estimated',
  )

  const decision: Omit<SyntheticCacheDecision, 'decisionHash'> = {
    schemaVersion: SYNTHETIC_CACHE_DECISION_SCHEMA_VERSION,
    id: input.id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    operation: input.subject.operation,
    cacheKey: calculateSyntheticCacheKey(input.subject),
    cacheKeyVersion: String(syntheticCacheIdentityBody(input.subject).schemaVersion),
    outcome: input.outcome,
    reasonCode: input.reasonCode,
    reason,
    candidateGenerationId,
    candidateMasterId,
    policyVersion: input.policyVersion,
    criticReportHash,
    estimatedSavingMinorUnits,
    avoidedCostMinorUnits,
    currency: input.currency,
    subjectHash: calculateSyntheticCacheDecisionSubjectHash(input.subject),
    decidedAt: instant(input.decidedAt, 'cache decision decidedAt'),
  }
  const sealed = Object.freeze({
    ...decision,
    decisionHash: calculateSyntheticCacheDecisionHash(decision),
  })
  assertSyntheticCacheDecisionPrivacy(sealed)
  return sealed
}

/**
 * Fail-closed rehydration. A ledger entry whose stored hash disagrees with its
 * content was tampered with or written by an older writer; either way it must
 * never be counted as evidence of what the cache decided or saved.
 */
export function assertSyntheticCacheDecisionIntegrity(
  decision: Readonly<SyntheticCacheDecision>,
): Readonly<SyntheticCacheDecision> {
  assertDomain(
    decision.schemaVersion === SYNTHETIC_CACHE_DECISION_SCHEMA_VERSION,
    'PERSISTENCE_CONFLICT',
    'synthetic cache decision schema version is not the ledger schema',
  )
  assertDomain(
    HASH.test(decision.cacheKey) && HASH.test(decision.subjectHash),
    'PERSISTENCE_CONFLICT',
    'synthetic cache decision carries an invalid digest',
  )
  assertDomain(
    calculateSyntheticCacheDecisionHash(decision) === decision.decisionHash,
    'PERSISTENCE_CONFLICT',
    'synthetic cache decision hash does not match its stored content',
  )
  return decision
}

function collectKeys(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, into)
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      into.add(key)
      collectKeys(nested, into)
    }
  }
}

/**
 * The ledger is an audit surface, not a copy of the work. This refuses any
 * entry that grew a field carrying the script, the consent evidence or a
 * provider secret.
 */
export function assertSyntheticCacheDecisionPrivacy(decision: Readonly<SyntheticCacheDecision>): void {
  const keys = new Set<string>()
  collectKeys(decision, keys)
  for (const forbidden of SYNTHETIC_CACHE_DECISION_FORBIDDEN_FIELDS) {
    assertDomain(
      !keys.has(forbidden),
      'INVALID_ARGUMENT',
      `Cache decision must not carry ${forbidden}: the ledger records hashes, never the work itself`,
    )
  }
}

/** Reason codes a given outcome accepts, for callers building a decision. */
export function syntheticCacheDecisionReasonsFor(
  outcome: SyntheticCacheDecisionOutcome,
): readonly SyntheticCacheDecisionReasonCode[] {
  return Object.freeze(
    SYNTHETIC_CACHE_DECISION_REASON_CODES.filter((code) => REASON_CODE_OUTCOMES[code].includes(outcome)),
  )
}
