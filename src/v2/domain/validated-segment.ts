import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import { normalizeSpeechText } from './speech-segment-catalog.ts'

export const VALIDATED_SEGMENT_POLICY_VERSION =
  'validated-segment/v1' as const
export const VALIDATED_SEGMENT_CLAIM_POLICY =
  'historical-association/v1' as const

export const VALIDATION_UNITS = [
  'hook',
  'segment',
  'whole-video',
] as const
export type ValidationUnit = (typeof VALIDATION_UNITS)[number]

export const VALIDATION_EVIDENCE_SCOPES = [
  'copy',
  'spoken-take',
  'opening-edit',
] as const
export type ValidationEvidenceScope =
  (typeof VALIDATION_EVIDENCE_SCOPES)[number]

export const VALIDATED_PROTECTED_ASPECTS = [
  'copy',
  'take',
  'timing',
  'opening',
] as const
export type ValidatedProtectedAspect =
  (typeof VALIDATED_PROTECTED_ASPECTS)[number]

export interface ValidationScope {
  unit: ValidationUnit
  evidenceScope: ValidationEvidenceScope
}

export interface ValidationSource {
  platform: string
  publicationRef: string
  accountRef?: string
  url?: string
  observedAt: string
}

export interface ValidationPerformanceEvidence {
  metric: string
  value: number
  unit: 'ratio' | 'percent' | 'seconds' | 'count' | 'currency' | 'score'
  sampleSize: number
  period: Readonly<{ start: string; end: string }>
  comparison?: Readonly<{
    label: string
    value: number
    unit: 'ratio' | 'percent' | 'seconds' | 'count' | 'currency' | 'score'
  }>
}

export interface ValidatedSegmentSourceContext {
  sourceArtifactId: string
  sourceArtifactSha256: string
  sourceManifestId: string
  sourceManifestHash: string
  durationMs: number
  rightsSnapshotId: string
  rightsStatus: string
  consentStatus: string
  sourceSpeechSegment?: Readonly<{
    id: string
    hash: string
    exactText: string
    speakerId: string
    rangeMs: readonly [number, number]
  }>
}

export interface ProtectedValidationEnvelope {
  schemaVersion: 'protected-validation-envelope/v1'
  sourceArtifactId: string
  sourceArtifactSha256: string
  sourceRangeMs: readonly [number, number]
  sourceSpeechSegmentId?: string
  sourceSpeechSegmentHash?: string
  exactCopy?: string
  speakerId?: string
  protectedAspects: readonly ValidatedProtectedAspect[]
  copyProtected: boolean
  takeProtected: boolean
  timingProtected: boolean
  openingProtected: boolean
  envelopeHash: string
}

export interface CatalogedValidatedSegment {
  schemaVersion: 'validated-segment/v1'
  id: string
  workspaceId: string
  projectId: string
  sourceArtifactId: string
  sourceArtifactSha256: string
  sourceManifestId: string
  sourceManifestHash: string
  sourceSpeechSegmentId?: string
  sourceSpeechSegmentHash?: string
  scope: Readonly<ValidationScope>
  wholeVideoValidated: boolean
  source: Readonly<ValidationSource>
  performance: Readonly<ValidationPerformanceEvidence>
  protectedEnvelope: Readonly<ProtectedValidationEnvelope>
  rightsSnapshotId: string
  rightsStatus: string
  consentStatus: string
  validatedAt: string
  expiresAt?: string
  claimPolicyVersion: typeof VALIDATED_SEGMENT_CLAIM_POLICY
  causalClaimAllowed: false
  policyVersion: typeof VALIDATED_SEGMENT_POLICY_VERSION
  physicalMaterialized: false
  createdBy: Readonly<{ type: 'api-client'; id: string }>
  createdAt: string
  validatedSegmentHash: string
}

export interface ValidatedSegmentReuseDecision {
  schemaVersion: 'validated-segment-reuse-decision/v1'
  validatedSegmentId: string
  targetRecipe: Readonly<{
    id: string
    role: 'hook' | 'body' | 'cta' | 'proof' | 'whole-video'
    objective: string
    format: string
    locale: string
  }>
  requestedChanges: readonly ValidatedProtectedAspect[]
  claim: 'historical-association' | 'causality'
  compatible: boolean
  reasons: readonly string[]
  protectedAspects: readonly ValidatedProtectedAspect[]
  wholeVideoValidated: boolean
  causalClaimAllowed: false
  performanceInterpretation: 'historical-association'
  evaluatedAt: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const TOKEN = /^[a-z0-9][a-z0-9._/-]{0,127}$/
const FORMAT = /^(?:9:16|16:9|4:5|1:1|21:9)$/
const LOCALE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/
const SHA_256 = /^[a-f0-9]{64}$/

function identity(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && ID.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function hash(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' &&
      SHA_256.test(value.trim().toLowerCase()),
    'INVALID_ARGUMENT',
    `${field} must be SHA-256`,
  )
  return value.trim().toLowerCase()
}

function text(
  value: unknown,
  field: string,
  maximum = 500,
): string {
  assertDomain(
    typeof value === 'string' &&
      value.trim().length > 0 &&
      value.trim().length <= maximum &&
      normalizeSpeechText(value.trim()).length > 0,
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function token(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && TOKEN.test(value.trim().toLowerCase()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim().toLowerCase()
}

function instant(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' &&
      !Number.isNaN(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    'INVALID_ARGUMENT',
    `${field} must be a canonical UTC instant`,
  )
  return value
}

function finiteNonNegative(value: unknown, field: string): number {
  assertDomain(
    typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0,
    'INVALID_ARGUMENT',
    `${field} must be a finite non-negative number`,
  )
  return value
}

function optionalUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const normalized = text(value, 'source.url', 2_000)
  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    assertDomain(false, 'INVALID_ARGUMENT', 'source.url must be HTTPS')
  }
  assertDomain(
    parsed!.protocol === 'https:' &&
      !parsed!.username &&
      !parsed!.password,
    'INVALID_ARGUMENT',
    'source.url must be HTTPS without credentials',
  )
  return parsed!.toString()
}

function validationSource(
  input: ValidationSource,
): Readonly<ValidationSource> {
  assertDomain(
    typeof input === 'object' && input !== null,
    'INVALID_ARGUMENT',
    'source is required',
  )
  return Object.freeze({
    platform: token(input.platform, 'source.platform'),
    publicationRef: text(
      input.publicationRef,
      'source.publicationRef',
      240,
    ),
    ...(input.accountRef !== undefined
      ? {
          accountRef: text(
            input.accountRef,
            'source.accountRef',
            240,
          ),
        }
      : {}),
    ...(input.url !== undefined ? { url: optionalUrl(input.url) } : {}),
    observedAt: instant(input.observedAt, 'source.observedAt'),
  })
}

function metricUnit(
  value: unknown,
  field: string,
): ValidationPerformanceEvidence['unit'] {
  assertDomain(
    [
      'ratio',
      'percent',
      'seconds',
      'count',
      'currency',
      'score',
    ].includes(String(value)),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value as ValidationPerformanceEvidence['unit']
}

function metricValue(
  value: unknown,
  unit: ValidationPerformanceEvidence['unit'],
  field: string,
): number {
  const normalized = finiteNonNegative(value, field)
  if (unit === 'ratio') {
    assertDomain(
      normalized <= 1,
      'INVALID_ARGUMENT',
      `${field} ratio must be between 0 and 1`,
    )
  }
  if (unit === 'percent' || unit === 'score') {
    assertDomain(
      normalized <= 100,
      'INVALID_ARGUMENT',
      `${field} ${unit} must be between 0 and 100`,
    )
  }
  return normalized
}

function performanceEvidence(
  input: ValidationPerformanceEvidence,
): Readonly<ValidationPerformanceEvidence> {
  assertDomain(
    typeof input === 'object' && input !== null,
    'INVALID_ARGUMENT',
    'performance is required',
  )
  const unit = metricUnit(input.unit, 'performance.unit')
  const value = metricValue(
    input.value,
    unit,
    'performance.value',
  )
  const sampleSize = input.sampleSize
  assertDomain(
    Number.isSafeInteger(sampleSize) &&
      sampleSize >= 1 &&
      sampleSize <= 10_000_000_000,
    'INVALID_ARGUMENT',
    'performance.sampleSize is invalid',
  )
  const start = instant(input.period?.start, 'performance.period.start')
  const end = instant(input.period?.end, 'performance.period.end')
  assertDomain(
    Date.parse(end) > Date.parse(start),
    'INVALID_ARGUMENT',
    'performance period must be positive',
  )
  const comparisonUnit = input.comparison
    ? metricUnit(
        input.comparison.unit,
        'performance.comparison.unit',
      )
    : undefined
  return Object.freeze({
    metric: token(input.metric, 'performance.metric'),
    value,
    unit,
    sampleSize,
    period: Object.freeze({ start, end }),
    ...(input.comparison
      ? {
          comparison: Object.freeze({
            label: text(
              input.comparison.label,
              'performance.comparison.label',
              240,
            ),
            value: metricValue(
              input.comparison.value,
              comparisonUnit!,
              'performance.comparison.value',
            ),
            unit: comparisonUnit!,
          }),
        }
      : {}),
  })
}

function scope(input: ValidationScope): Readonly<ValidationScope> {
  assertDomain(
    typeof input === 'object' &&
      input !== null &&
      VALIDATION_UNITS.includes(input.unit) &&
      VALIDATION_EVIDENCE_SCOPES.includes(input.evidenceScope),
    'INVALID_ARGUMENT',
    'scope is invalid',
  )
  return Object.freeze({
    unit: input.unit,
    evidenceScope: input.evidenceScope,
  })
}

function protectedAspects(
  evidenceScope: ValidationEvidenceScope,
): readonly ValidatedProtectedAspect[] {
  if (evidenceScope === 'copy') return Object.freeze(['copy'])
  if (evidenceScope === 'spoken-take') {
    return Object.freeze(['copy', 'take'])
  }
  return Object.freeze(['copy', 'take', 'timing', 'opening'])
}

function createProtectedEnvelope(input: {
  source: Readonly<ValidatedSegmentSourceContext>
  scope: Readonly<ValidationScope>
}): Readonly<ProtectedValidationEnvelope> {
  const segment = input.source.sourceSpeechSegment
  if (input.scope.unit === 'whole-video') {
    assertDomain(
      segment === undefined,
      'INVALID_ARGUMENT',
      'whole-video validation cannot identify one SpeechSegment',
    )
  } else {
    assertDomain(
      segment !== undefined,
      'INVALID_ARGUMENT',
      `${input.scope.unit} validation requires an exact SpeechSegment`,
    )
  }
  const range = segment?.rangeMs ??
    Object.freeze([0, input.source.durationMs] as const)
  const aspects = protectedAspects(input.scope.evidenceScope)
  const content = Object.freeze({
    schemaVersion: 'protected-validation-envelope/v1' as const,
    sourceArtifactId: identity(
      input.source.sourceArtifactId,
      'sourceArtifactId',
    ),
    sourceArtifactSha256: hash(
      input.source.sourceArtifactSha256,
      'sourceArtifactSha256',
    ),
    sourceRangeMs: Object.freeze([range[0], range[1]]) as readonly [
      number,
      number,
    ],
    ...(segment
      ? {
          sourceSpeechSegmentId: identity(
            segment.id,
            'sourceSpeechSegment.id',
          ),
          sourceSpeechSegmentHash: hash(
            segment.hash,
            'sourceSpeechSegment.hash',
          ),
          exactCopy: text(
            segment.exactText,
            'sourceSpeechSegment.exactText',
            20_000,
          ),
          speakerId: identity(
            segment.speakerId,
            'sourceSpeechSegment.speakerId',
          ),
        }
      : {}),
    protectedAspects: aspects,
    copyProtected: aspects.includes('copy'),
    takeProtected: aspects.includes('take'),
    timingProtected: aspects.includes('timing'),
    openingProtected: aspects.includes('opening'),
  })
  return Object.freeze({
    ...content,
    envelopeHash: calculateCanonicalHash(content),
  })
}

export function catalogValidatedSegment(input: {
  id: string
  workspaceId: string
  projectId: string
  source: ValidatedSegmentSourceContext
  scope: ValidationScope
  validationSource: ValidationSource
  performance: ValidationPerformanceEvidence
  validatedAt: string
  expiresAt?: string
  actor: Readonly<{ type: 'api-client'; id: string }>
  createdAt: string
}): Readonly<CatalogedValidatedSegment> {
  const createdAt = instant(input.createdAt, 'createdAt')
  const validatedAt = instant(input.validatedAt, 'validatedAt')
  const validation = validationSource(input.validationSource)
  const performance = performanceEvidence(input.performance)
  assertDomain(
    Date.parse(validation.observedAt) <= Date.parse(validatedAt) &&
      Date.parse(performance.period.end) <= Date.parse(validatedAt) &&
      Date.parse(validatedAt) <= Date.parse(createdAt),
    'INVALID_ARGUMENT',
    'validation chronology is invalid',
  )
  const expiresAt = input.expiresAt
    ? instant(input.expiresAt, 'expiresAt')
    : undefined
  assertDomain(
    !expiresAt || Date.parse(expiresAt) > Date.parse(validatedAt),
    'INVALID_ARGUMENT',
    'expiresAt must be after validatedAt',
  )
  assertDomain(
    input.actor?.type === 'api-client',
    'AUTH_INVALID',
    'ValidatedSegment requires an authenticated API client',
  )
  assertDomain(
    Number.isSafeInteger(input.source.durationMs) &&
      input.source.durationMs > 0,
    'INVALID_ARGUMENT',
    'source duration must be a positive integer',
  )
  const normalizedScope = scope(input.scope)
  const protectedEnvelope = createProtectedEnvelope({
    source: input.source,
    scope: normalizedScope,
  })
  assertDomain(
    protectedEnvelope.sourceRangeMs[0] >= 0 &&
      protectedEnvelope.sourceRangeMs[1] >
        protectedEnvelope.sourceRangeMs[0] &&
      protectedEnvelope.sourceRangeMs[1] <= input.source.durationMs,
    'INVALID_ARGUMENT',
    'validation source range is outside the master',
  )
  const content = Object.freeze({
    schemaVersion: 'validated-segment/v1' as const,
    id: identity(input.id, 'validatedSegmentId'),
    workspaceId: identity(input.workspaceId, 'workspaceId'),
    projectId: identity(input.projectId, 'projectId'),
    sourceArtifactId: identity(
      input.source.sourceArtifactId,
      'sourceArtifactId',
    ),
    sourceArtifactSha256: hash(
      input.source.sourceArtifactSha256,
      'sourceArtifactSha256',
    ),
    sourceManifestId: identity(
      input.source.sourceManifestId,
      'sourceManifestId',
    ),
    sourceManifestHash: hash(
      input.source.sourceManifestHash,
      'sourceManifestHash',
    ),
    ...(input.source.sourceSpeechSegment
      ? {
          sourceSpeechSegmentId:
            protectedEnvelope.sourceSpeechSegmentId,
          sourceSpeechSegmentHash:
            protectedEnvelope.sourceSpeechSegmentHash,
        }
      : {}),
    scope: normalizedScope,
    wholeVideoValidated: normalizedScope.unit === 'whole-video',
    source: validation,
    performance,
    protectedEnvelope,
    rightsSnapshotId: identity(
      input.source.rightsSnapshotId,
      'rightsSnapshotId',
    ),
    rightsStatus: text(
      input.source.rightsStatus,
      'rightsStatus',
      32,
    ),
    consentStatus: text(
      input.source.consentStatus,
      'consentStatus',
      32,
    ),
    validatedAt,
    ...(expiresAt ? { expiresAt } : {}),
    claimPolicyVersion: VALIDATED_SEGMENT_CLAIM_POLICY,
    causalClaimAllowed: false as const,
    policyVersion: VALIDATED_SEGMENT_POLICY_VERSION,
    physicalMaterialized: false as const,
    createdBy: Object.freeze({
      type: 'api-client' as const,
      id: identity(input.actor.id, 'actor.id'),
    }),
    createdAt,
  })
  return Object.freeze({
    ...content,
    validatedSegmentHash: calculateCanonicalHash(content),
  })
}

function effectiveStatus(
  status: string,
  expiresAt: string | undefined,
  now: string,
): string {
  return expiresAt && Date.parse(expiresAt) <= Date.parse(now)
    ? 'expired'
    : status
}

export function evaluateValidatedSegmentReuse(input: {
  segment: Readonly<CatalogedValidatedSegment>
  currentRights: Readonly<{
    id: string
    status: string
    consentStatus: string
    expiresAt?: string
    consentExpiresAt?: string
  }> | null
  targetRecipe: {
    id: string
    role: 'hook' | 'body' | 'cta' | 'proof' | 'whole-video'
    objective: string
    format: string
    locale: string
  }
  requestedChanges: readonly ValidatedProtectedAspect[]
  claim: 'historical-association' | 'causality'
  evaluatedAt: string
}): Readonly<ValidatedSegmentReuseDecision> {
  const evaluatedAt = instant(input.evaluatedAt, 'evaluatedAt')
  assertDomain(
    ['historical-association', 'causality'].includes(input.claim),
    'INVALID_ARGUMENT',
    'claim is invalid',
  )
  assertDomain(
    Array.isArray(input.requestedChanges) &&
      input.requestedChanges.every((change) =>
        VALIDATED_PROTECTED_ASPECTS.includes(change)) &&
      new Set(input.requestedChanges).size ===
        input.requestedChanges.length,
    'INVALID_ARGUMENT',
    'requestedChanges is invalid',
  )
  const targetRecipe = Object.freeze({
    id: identity(input.targetRecipe.id, 'targetRecipe.id'),
    role: input.targetRecipe.role,
    objective: token(
      input.targetRecipe.objective,
      'targetRecipe.objective',
    ),
    format: text(input.targetRecipe.format, 'targetRecipe.format', 16),
    locale: text(input.targetRecipe.locale, 'targetRecipe.locale', 35),
  })
  assertDomain(
    ['hook', 'body', 'cta', 'proof', 'whole-video'].includes(
      targetRecipe.role,
    ) &&
      FORMAT.test(targetRecipe.format) &&
      LOCALE.test(targetRecipe.locale),
    'INVALID_ARGUMENT',
    'targetRecipe is invalid',
  )
  const rights = input.currentRights
  const rightsStatus = rights
    ? effectiveStatus(
        rights.status,
        rights.expiresAt,
        evaluatedAt,
      )
    : 'unknown'
  const consentStatus = rights
    ? effectiveStatus(
        rights.consentStatus,
        rights.consentExpiresAt,
        evaluatedAt,
      )
    : 'unknown'
  const protectedChanges = input.requestedChanges.filter((change) =>
    input.segment.protectedEnvelope.protectedAspects.includes(change))
  const reasons = Object.freeze([
    ...(input.segment.expiresAt &&
    Date.parse(input.segment.expiresAt) <= Date.parse(evaluatedAt)
      ? ['VALIDATION_EXPIRED']
      : []),
    ...(!rights ? ['RIGHTS_MISSING'] : []),
    ...(rights && rights.id !== input.segment.rightsSnapshotId
      ? ['RIGHTS_SNAPSHOT_STALE']
      : []),
    ...(rightsStatus !== 'approved'
      ? [`RIGHTS_${rightsStatus.toUpperCase()}`]
      : []),
    ...(!['approved', 'not-required'].includes(consentStatus)
      ? [`CONSENT_${consentStatus.toUpperCase()}`]
      : []),
    ...(input.segment.scope.unit === 'hook' &&
    targetRecipe.role !== 'hook'
      ? ['VALIDATION_UNIT_HOOK_ONLY']
      : []),
    ...(input.segment.scope.unit === 'whole-video' &&
    targetRecipe.role !== 'whole-video'
      ? ['VALIDATION_UNIT_WHOLE_VIDEO_ONLY']
      : []),
    ...protectedChanges.map((change) =>
      `PROTECTED_${change.toUpperCase()}`),
    ...(input.claim === 'causality'
      ? ['CAUSALITY_NOT_SUPPORTED']
      : []),
  ])
  return Object.freeze({
    schemaVersion: 'validated-segment-reuse-decision/v1' as const,
    validatedSegmentId: input.segment.id,
    targetRecipe,
    requestedChanges: Object.freeze([...input.requestedChanges]),
    claim: input.claim,
    compatible: reasons.length === 0,
    reasons,
    protectedAspects:
      input.segment.protectedEnvelope.protectedAspects,
    wholeVideoValidated: input.segment.wholeVideoValidated,
    causalClaimAllowed: false as const,
    performanceInterpretation: 'historical-association' as const,
    evaluatedAt,
  })
}
