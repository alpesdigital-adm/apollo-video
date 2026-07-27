import { calculateCanonicalHash } from './canonical-hash.ts'
import {
  ASSET_CONSENT_STATUSES,
  ASSET_RIGHTS_STATUSES,
  type AssetConsentStatus,
  type AssetRightsStatus,
} from './asset-rights.ts'
import { assertDomain } from './errors.ts'
import {
  normalizeSpeechText,
  type CatalogedSpeechSegment,
  type SpeechCatalogObservation,
} from './speech-segment-catalog.ts'

export const EVIDENCE_INTEGRITY_POLICY_VERSION =
  'evidence-integrity/v1' as const

export const EVIDENCE_CATEGORIES = [
  'testimonial',
  'financial-result',
  'before-after',
  'hearsay',
  'authority',
  'case-study',
  'demonstration',
] as const

export type EvidenceCategory = typeof EVIDENCE_CATEGORIES[number]
export type EvidenceIntegrityStatus =
  | 'valid'
  | 'context-required'
  | 'blocked'

export interface EvidenceObservationInput {
  value: string
  confidence: number
}

export interface EvidenceProducer {
  provider: string
  model: string
  version: string
  confidence: number
}

export interface EvidenceObservation {
  value: string
  normalizedValue: string
  provenance: Readonly<{
    source: 'evidence-observation'
    provider: string
    model: string
    version: string
    confidence: number
    observedAt: string
  }>
}

export interface EvidenceRightsSnapshot {
  id: string
  rightsStatus: AssetRightsStatus
  consentStatus: AssetConsentStatus
  rightsExpiresAt?: string
  consentExpiresAt?: string
}

export interface CatalogedEvidenceSegment {
  schemaVersion: 'evidence-segment/v1'
  id: string
  workspaceId: string
  projectId: string
  sourceSpeechSegmentId: string
  sourceSpeechSegmentHash: string
  sourceTranscriptId: string
  sourceTranscriptHash: string
  sourceArtifactId: string
  rightsSnapshotId: string
  rightsStatus: AssetRightsStatus
  consentStatus: AssetConsentStatus
  category: EvidenceCategory
  speaker: Readonly<SpeechCatalogObservation>
  speakerId: string
  claim: Readonly<EvidenceObservation>
  result?: Readonly<EvidenceObservation>
  context: Readonly<EvidenceObservation>
  qualifiers: readonly Readonly<EvidenceObservation>[]
  subject: Readonly<EvidenceObservation>
  attribution: Readonly<EvidenceObservation>
  compatibleOfferIds: readonly string[]
  compatibleAudienceTags: readonly string[]
  compatibleObjections: readonly string[]
  credibilityScore: number
  specificityScore: number
  authenticityScore: number
  sourceRangeMs: readonly [number, number]
  contextRangeMs: readonly [number, number]
  handlesMs: Readonly<{ before: number; after: number }>
  exactTranscript: string
  frameRefs: readonly string[]
  adjacentEvidenceIds: readonly string[]
  requiresContext: boolean
  integrityStatus: EvidenceIntegrityStatus
  integrityReasons: readonly string[]
  producer: Readonly<EvidenceProducer>
  integrityPolicyVersion: typeof EVIDENCE_INTEGRITY_POLICY_VERSION
  physicalMaterialized: false
  createdBy: Readonly<{ type: 'api-client'; id: string }>
  createdAt: string
  evidenceHash: string
}

export interface EvidenceReuseDecision {
  allowed: boolean
  reasons: readonly string[]
  requiredContextRangeMs: readonly [number, number]
  requiredAdjacentEvidenceIds: readonly string[]
  requiredQualifierValues: readonly string[]
  rightsSnapshotId: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const TOKEN = /^[a-z0-9][a-z0-9._/-]{0,127}$/

function identity(value: string, field: string): string {
  const normalized = value.trim()
  assertDomain(ID.test(normalized), 'INVALID_ARGUMENT', `${field} is invalid`)
  return normalized
}

function boundedText(
  value: string,
  field: string,
  maxLength = 2_000,
): string {
  const normalized = value.trim()
  assertDomain(
    normalized.length > 0 && normalized.length <= maxLength,
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return normalized
}

function score(value: number, field: string): number {
  assertDomain(
    Number.isFinite(value) && value >= 0 && value <= 1,
    'INVALID_ARGUMENT',
    `${field} must be between 0 and 1`,
  )
  return value
}

function producer(input: EvidenceProducer): Readonly<EvidenceProducer> {
  const provider = input.provider.trim()
  const model = input.model.trim()
  const version = input.version.trim()
  assertDomain(
    TOKEN.test(provider) && TOKEN.test(model) && TOKEN.test(version),
    'INVALID_ARGUMENT',
    'Evidence producer identity is invalid',
  )
  return Object.freeze({
    provider,
    model,
    version,
    confidence: score(input.confidence, 'producer.confidence'),
  })
}

function observation(
  input: EvidenceObservationInput,
  evidenceProducer: Readonly<EvidenceProducer>,
  observedAt: string,
  field: string,
  maxLength = 2_000,
): Readonly<EvidenceObservation> {
  const value = boundedText(input.value, field, maxLength)
  const normalizedValue = normalizeSpeechText(value)
  assertDomain(
    normalizedValue.length > 0,
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return Object.freeze({
    value,
    normalizedValue,
    provenance: Object.freeze({
      source: 'evidence-observation' as const,
      provider: evidenceProducer.provider,
      model: evidenceProducer.model,
      version: evidenceProducer.version,
      confidence: score(input.confidence, `${field}.confidence`),
      observedAt,
    }),
  })
}

function tokenList(
  values: readonly string[],
  field: string,
): readonly string[] {
  assertDomain(
    Array.isArray(values) && values.length <= 64,
    'INVALID_ARGUMENT',
    `${field} must contain at most 64 values`,
  )
  const normalized = values.map((value) => {
    assertDomain(
      typeof value === 'string',
      'INVALID_ARGUMENT',
      `${field} must contain strings`,
    )
    return boundedText(value, field, 240)
  })
  assertDomain(
    new Set(normalized.map(normalizeSpeechText)).size === normalized.length,
    'INVALID_ARGUMENT',
    `${field} contains duplicates`,
  )
  return Object.freeze([...normalized].sort((left, right) =>
    normalizeSpeechText(left).localeCompare(normalizeSpeechText(right))))
}

function referenceList(
  values: readonly string[],
  field: string,
): readonly string[] {
  assertDomain(
    Array.isArray(values) && values.length <= 64,
    'INVALID_ARGUMENT',
    `${field} must contain at most 64 references`,
  )
  const normalized = values.map((value) => identity(value, field))
  assertDomain(
    new Set(normalized).size === normalized.length,
    'INVALID_ARGUMENT',
    `${field} contains duplicates`,
  )
  return Object.freeze([...normalized].sort())
}

function validDate(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined
  const date = new Date(value)
  assertDomain(
    !Number.isNaN(date.getTime()) && date.toISOString() === value,
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value
}

function effectiveRights(
  rights: Readonly<EvidenceRightsSnapshot>,
  createdAt: string,
) {
  assertDomain(
    ASSET_RIGHTS_STATUSES.includes(rights.rightsStatus) &&
      ASSET_CONSENT_STATUSES.includes(rights.consentStatus),
    'INVALID_ARGUMENT',
    'Evidence rights snapshot is invalid',
  )
  const now = Date.parse(createdAt)
  const rightsExpiresAt = validDate(
    rights.rightsExpiresAt,
    'rights.rightsExpiresAt',
  )
  const consentExpiresAt = validDate(
    rights.consentExpiresAt,
    'rights.consentExpiresAt',
  )
  return Object.freeze({
    id: identity(rights.id, 'rights.id'),
    rightsStatus:
      rightsExpiresAt && Date.parse(rightsExpiresAt) <= now
        ? 'expired' as const
        : rights.rightsStatus,
    consentStatus:
      consentExpiresAt && Date.parse(consentExpiresAt) <= now
        ? 'expired' as const
        : rights.consentStatus,
  })
}

function requiresApprovedConsent(category: EvidenceCategory): boolean {
  return category !== 'demonstration'
}

export function createCatalogedEvidenceSegment(input: {
  id: string
  workspaceId: string
  projectId: string
  sourceSpeechSegment: Readonly<CatalogedSpeechSegment>
  transcriptDurationMs: number
  rights: Readonly<EvidenceRightsSnapshot>
  category: EvidenceCategory
  claim: EvidenceObservationInput
  result?: EvidenceObservationInput
  context: EvidenceObservationInput
  qualifiers: readonly EvidenceObservationInput[]
  subject: EvidenceObservationInput
  attribution: EvidenceObservationInput
  compatibleOfferIds: readonly string[]
  compatibleAudienceTags: readonly string[]
  compatibleObjections: readonly string[]
  credibilityScore: number
  specificityScore: number
  authenticityScore: number
  contextRangeMs: readonly [number, number]
  frameRefs: readonly string[]
  adjacentEvidenceIds: readonly string[]
  requiresContext: boolean
  producer: EvidenceProducer
  actorId: string
  createdAt: string
}): Readonly<CatalogedEvidenceSegment> {
  const createdAtDate = new Date(input.createdAt)
  assertDomain(
    !Number.isNaN(createdAtDate.getTime()) &&
      createdAtDate.toISOString() === input.createdAt,
    'INVALID_ARGUMENT',
    'Evidence createdAt is invalid',
  )
  assertDomain(
    EVIDENCE_CATEGORIES.includes(input.category),
    'INVALID_ARGUMENT',
    'Evidence category is invalid',
  )
  const evidenceProducer = producer(input.producer)
  const rights = effectiveRights(input.rights, input.createdAt)
  const [contextStartMs, contextEndMs] = input.contextRangeMs
  const [sourceStartMs, sourceEndMs] = input.sourceSpeechSegment.rangeMs
  assertDomain(
    Number.isSafeInteger(input.transcriptDurationMs) &&
      input.transcriptDurationMs > 0 &&
      Number.isSafeInteger(contextStartMs) &&
      Number.isSafeInteger(contextEndMs) &&
      contextStartMs >= 0 &&
      contextStartMs <= sourceStartMs &&
      contextEndMs >= sourceEndMs &&
      contextEndMs <= input.transcriptDurationMs,
    'INVALID_ARGUMENT',
    'Evidence context range must contain the source speech inside the transcript',
  )
  assertDomain(
    Array.isArray(input.qualifiers) && input.qualifiers.length <= 32,
    'INVALID_ARGUMENT',
    'Evidence qualifiers must contain at most 32 values',
  )
  const qualifiers = Object.freeze(input.qualifiers.map((qualifier, index) =>
    observation(
      qualifier,
      evidenceProducer,
      input.createdAt,
      `qualifiers[${index}]`,
    )))
  const integrityReasons = Object.freeze([
    ...(rights.rightsStatus !== 'approved'
      ? [`RIGHTS_${rights.rightsStatus.toUpperCase()}`]
      : []),
    ...(requiresApprovedConsent(input.category) &&
      rights.consentStatus !== 'approved'
      ? [`CONSENT_${rights.consentStatus.toUpperCase()}`]
      : []),
    ...(input.category === 'demonstration' &&
      !['approved', 'not-required'].includes(rights.consentStatus)
      ? [`CONSENT_${rights.consentStatus.toUpperCase()}`]
      : []),
    ...(input.category === 'hearsay' ? ['HEARSAY_BLOCKED'] : []),
    ...(['financial-result', 'before-after'].includes(input.category) &&
      qualifiers.length === 0
      ? ['QUALIFIER_REQUIRED']
      : []),
  ])
  const requiresContext =
    input.requiresContext ||
    qualifiers.length > 0 ||
    ['financial-result', 'before-after', 'hearsay'].includes(input.category)
  const integrityStatus: EvidenceIntegrityStatus =
    integrityReasons.length > 0
      ? 'blocked'
      : requiresContext
        ? 'context-required'
        : 'valid'
  const content = Object.freeze({
    schemaVersion: 'evidence-segment/v1' as const,
    id: identity(input.id, 'id'),
    workspaceId: identity(input.workspaceId, 'workspaceId'),
    projectId: identity(input.projectId, 'projectId'),
    sourceSpeechSegmentId: input.sourceSpeechSegment.id,
    sourceSpeechSegmentHash: input.sourceSpeechSegment.segmentHash,
    sourceTranscriptId: input.sourceSpeechSegment.sourceTranscriptId,
    sourceTranscriptHash: input.sourceSpeechSegment.sourceTranscriptHash,
    sourceArtifactId: input.sourceSpeechSegment.sourceArtifactId,
    rightsSnapshotId: rights.id,
    rightsStatus: rights.rightsStatus,
    consentStatus: rights.consentStatus,
    category: input.category,
    speaker: input.sourceSpeechSegment.speaker,
    speakerId: input.sourceSpeechSegment.speakerId,
    claim: observation(
      input.claim,
      evidenceProducer,
      input.createdAt,
      'claim',
    ),
    ...(input.result
      ? {
          result: observation(
            input.result,
            evidenceProducer,
            input.createdAt,
            'result',
          ),
        }
      : {}),
    context: observation(
      input.context,
      evidenceProducer,
      input.createdAt,
      'context',
    ),
    qualifiers,
    subject: observation(
      input.subject,
      evidenceProducer,
      input.createdAt,
      'subject',
      240,
    ),
    attribution: observation(
      input.attribution,
      evidenceProducer,
      input.createdAt,
      'attribution',
      240,
    ),
    compatibleOfferIds: referenceList(
      input.compatibleOfferIds,
      'compatibleOfferIds',
    ),
    compatibleAudienceTags: tokenList(
      input.compatibleAudienceTags,
      'compatibleAudienceTags',
    ),
    compatibleObjections: tokenList(
      input.compatibleObjections,
      'compatibleObjections',
    ),
    credibilityScore: score(input.credibilityScore, 'credibilityScore'),
    specificityScore: score(input.specificityScore, 'specificityScore'),
    authenticityScore: score(input.authenticityScore, 'authenticityScore'),
    sourceRangeMs: input.sourceSpeechSegment.rangeMs,
    contextRangeMs: Object.freeze([
      contextStartMs,
      contextEndMs,
    ]) as readonly [number, number],
    handlesMs: Object.freeze({
      before: sourceStartMs - contextStartMs,
      after: contextEndMs - sourceEndMs,
    }),
    exactTranscript: input.sourceSpeechSegment.exactText,
    frameRefs: referenceList(input.frameRefs, 'frameRefs'),
    adjacentEvidenceIds: referenceList(
      input.adjacentEvidenceIds,
      'adjacentEvidenceIds',
    ),
    requiresContext,
    integrityStatus,
    integrityReasons,
    producer: evidenceProducer,
    integrityPolicyVersion: EVIDENCE_INTEGRITY_POLICY_VERSION,
    physicalMaterialized: false as const,
    createdBy: Object.freeze({
      type: 'api-client' as const,
      id: identity(input.actorId, 'actorId'),
    }),
    createdAt: input.createdAt,
  })
  return Object.freeze({
    ...content,
    evidenceHash: calculateCanonicalHash(content),
  })
}

export function authorizeEvidenceSegmentUse(input: {
  evidence: Readonly<CatalogedEvidenceSegment>
  intendedClaim?: string
  includedContext: boolean
  offerId?: string
  objection?: string
  currentRights: Readonly<EvidenceRightsSnapshot>
  now: string
}): Readonly<EvidenceReuseDecision> {
  const currentRights = effectiveRights(input.currentRights, input.now)
  const reasons = [
    ...input.evidence.integrityReasons,
    ...(input.evidence.requiresContext && !input.includedContext
      ? ['CONTEXT_REQUIRED']
      : []),
    ...(input.intendedClaim === undefined
      ? ['INTENDED_CLAIM_REQUIRED']
      : normalizeSpeechText(input.intendedClaim) !==
          input.evidence.claim.normalizedValue
        ? ['CLAIM_DRIFT']
        : []),
    ...(input.evidence.compatibleOfferIds.length > 0 &&
      (!input.offerId ||
        !input.evidence.compatibleOfferIds.includes(input.offerId))
      ? ['OFFER_INCOMPATIBLE']
      : []),
    ...(input.evidence.compatibleObjections.length > 0 &&
      (!input.objection ||
        !input.evidence.compatibleObjections.some(
          (value) =>
            normalizeSpeechText(value) ===
            normalizeSpeechText(input.objection ?? ''),
        ))
      ? ['OBJECTION_INCOMPATIBLE']
      : []),
    ...(currentRights.id !== input.evidence.rightsSnapshotId
      ? ['RIGHTS_SNAPSHOT_STALE']
      : []),
    ...(currentRights.rightsStatus !== 'approved'
      ? [`RIGHTS_${currentRights.rightsStatus.toUpperCase()}`]
      : []),
    ...(requiresApprovedConsent(input.evidence.category) &&
      currentRights.consentStatus !== 'approved'
      ? [`CONSENT_${currentRights.consentStatus.toUpperCase()}`]
      : []),
  ]
  return Object.freeze({
    allowed: reasons.length === 0,
    reasons: Object.freeze([...new Set(reasons)]),
    requiredContextRangeMs: input.evidence.contextRangeMs,
    requiredAdjacentEvidenceIds: input.evidence.adjacentEvidenceIds,
    requiredQualifierValues: Object.freeze(
      input.evidence.qualifiers.map((qualifier) => qualifier.value),
    ),
    rightsSnapshotId: currentRights.id,
  })
}
