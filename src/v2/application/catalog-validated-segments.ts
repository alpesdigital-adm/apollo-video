import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import { normalizeSpeechText } from '../domain/speech-segment-catalog.ts'
import {
  catalogValidatedSegment,
  evaluateValidatedSegmentReuse,
  VALIDATED_PROTECTED_ASPECTS,
  VALIDATED_SEGMENT_POLICY_VERSION,
  VALIDATION_EVIDENCE_SCOPES,
  VALIDATION_UNITS,
  type ValidationPerformanceEvidence,
  type ValidationScope,
  type ValidationSource,
  type ValidatedProtectedAspect,
} from '../domain/validated-segment.ts'
import type {
  PersistedValidatedSegment,
  ValidatedSegmentRepository,
  ValidatedSegmentSearchQuery,
} from './ports/validated-segment-repository.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const SHA_256 = /^[a-f0-9]{64}$/
const IDEMPOTENCY = /^[\x21-\x7E]{8,128}$/

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

function idempotencyKey(value: unknown): string {
  assertDomain(
    typeof value === 'string' && IDEMPOTENCY.test(value.trim()),
    'INVALID_ARGUMENT',
    'Idempotency-Key must contain 8 to 128 visible ASCII characters',
  )
  return value.trim()
}

function canonicalNow(value: Date, field: string): string {
  assertDomain(
    value instanceof Date && !Number.isNaN(value.getTime()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.toISOString()
}

function optionalSearchText(
  value: unknown,
  field: string,
  maximum = 500,
): string | undefined {
  if (value === undefined) return undefined
  assertDomain(
    typeof value === 'string' &&
      value.trim().length > 0 &&
      value.trim().length <= maximum,
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  const normalized = normalizeSpeechText(value.trim())
  assertDomain(
    normalized.length > 0,
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return normalized
}

function boundedInteger(
  value: unknown,
  field: string,
  fallback: number,
  maximum: number,
): number {
  const selected = value ?? fallback
  assertDomain(
    Number.isSafeInteger(selected) &&
      Number(selected) >= 1 &&
      Number(selected) <= maximum,
    'INVALID_ARGUMENT',
    `${field} must be an integer between 1 and ${maximum}`,
  )
  return Number(selected)
}

export function catalogValidatedSegmentService(dependencies: {
  repository: ValidatedSegmentRepository
  clock: () => Date
  createId: () => string
}) {
  return async function catalog(request: {
    workspaceId: string
    projectId: string
    sourceArtifactId: string
    expectedArtifactSha256: string
    sourceManifestId: string
    expectedManifestHash: string
    sourceSpeechSegmentId?: string
    expectedSpeechSegmentHash?: string
    policyVersion: string
    scope: ValidationScope
    source: ValidationSource
    performance: ValidationPerformanceEvidence
    validatedAt: string
    expiresAt?: string
    actor: Readonly<{ type: 'api-client'; id: string }>
    idempotencyKey: string
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const sourceArtifactId = identity(
      request.sourceArtifactId,
      'sourceArtifactId',
    )
    const expectedArtifactSha256 = hash(
      request.expectedArtifactSha256,
      'expectedArtifactSha256',
    )
    const sourceManifestId = identity(
      request.sourceManifestId,
      'sourceManifestId',
    )
    const expectedManifestHash = hash(
      request.expectedManifestHash,
      'expectedManifestHash',
    )
    assertDomain(
      request.policyVersion === VALIDATED_SEGMENT_POLICY_VERSION,
      'INVALID_ARGUMENT',
      `policyVersion must be ${VALIDATED_SEGMENT_POLICY_VERSION}`,
    )
    const hasSegmentId = request.sourceSpeechSegmentId !== undefined
    const hasSegmentHash = request.expectedSpeechSegmentHash !== undefined
    assertDomain(
      hasSegmentId === hasSegmentHash,
      'INVALID_ARGUMENT',
      'sourceSpeechSegmentId and expectedSpeechSegmentHash must be provided together',
    )
    const sourceSpeechSegmentId = hasSegmentId
      ? identity(
          request.sourceSpeechSegmentId,
          'sourceSpeechSegmentId',
        )
      : undefined
    const expectedSpeechSegmentHash = hasSegmentHash
      ? hash(
          request.expectedSpeechSegmentHash,
          'expectedSpeechSegmentHash',
        )
      : undefined
    assertDomain(
      request.actor?.type === 'api-client',
      'AUTH_INVALID',
      'ValidatedSegment requires an authenticated API client',
    )
    const actorId = identity(request.actor.id, 'actor.id')
    const key = idempotencyKey(request.idempotencyKey)
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'catalog-validated-segment-request/v1',
      workspaceId,
      projectId,
      sourceArtifactId,
      expectedArtifactSha256,
      sourceManifestId,
      expectedManifestHash,
      ...(sourceSpeechSegmentId
        ? {
            sourceSpeechSegmentId,
            expectedSpeechSegmentHash,
          }
        : {}),
      policyVersion: VALIDATED_SEGMENT_POLICY_VERSION,
      scope: request.scope,
      source: request.source,
      performance: request.performance,
      validatedAt: request.validatedAt,
      ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
      actor: { type: 'api-client', id: actorId },
    })
    const replay = await dependencies.repository.findIdempotent({
      workspaceId,
      projectId,
      idempotencyKey: key,
    })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Idempotency key was used with a different validation request',
        )
      }
      return Object.freeze({ segment: replay, replayed: true })
    }
    const context = await dependencies.repository.readCreationContext({
      workspaceId,
      projectId,
      sourceArtifactId,
      sourceManifestId,
      ...(sourceSpeechSegmentId ? { sourceSpeechSegmentId } : {}),
    })
    if (!context) {
      throw new DomainError(
        'PROJECT_NOT_FOUND',
        'Validation source artifact, manifest or SpeechSegment was not found',
      )
    }
    if (
      context.sourceArtifactSha256 !== expectedArtifactSha256 ||
      context.sourceManifestHash !== expectedManifestHash ||
      (expectedSpeechSegmentHash !== undefined &&
        context.sourceSpeechSegment?.hash !== expectedSpeechSegmentHash)
    ) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Validation source changed before cataloging',
        {
          currentArtifactSha256: context.sourceArtifactSha256,
          currentManifestHash: context.sourceManifestHash,
          ...(context.sourceSpeechSegment
            ? {
                currentSpeechSegmentHash:
                  context.sourceSpeechSegment.hash,
              }
            : {}),
        },
      )
    }
    const createdAt = canonicalNow(
      dependencies.clock(),
      'validated segment clock',
    )
    const domain = catalogValidatedSegment({
      id: identity(dependencies.createId(), 'validatedSegmentId'),
      workspaceId,
      projectId,
      source: context,
      scope: request.scope,
      validationSource: request.source,
      performance: request.performance,
      validatedAt: request.validatedAt,
      ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
      actor: { type: 'api-client', id: actorId },
      createdAt,
    })
    const segment: Readonly<PersistedValidatedSegment> = Object.freeze({
      ...domain,
      requestFingerprint,
      idempotencyKey: key,
    })
    return dependencies.repository.persist(segment)
  }
}

export function searchValidatedSegmentsService(dependencies: {
  repository: ValidatedSegmentRepository
  clock: () => Date
}) {
  return async function search(request: {
    workspaceId: string
    projectId: string
    text?: string
    sourceArtifactId?: string
    platform?: string
    unit?: string
    evidenceScope?: string
    metric?: string
    activeOnly?: boolean
    limit?: number
  }) {
    const unit = request.unit
    assertDomain(
      unit === undefined ||
        VALIDATION_UNITS.includes(
          unit as (typeof VALIDATION_UNITS)[number],
        ),
      'INVALID_ARGUMENT',
      'unit is invalid',
    )
    const evidenceScope = request.evidenceScope
    assertDomain(
      evidenceScope === undefined ||
        VALIDATION_EVIDENCE_SCOPES.includes(
          evidenceScope as (typeof VALIDATION_EVIDENCE_SCOPES)[number],
        ),
      'INVALID_ARGUMENT',
      'evidenceScope is invalid',
    )
    assertDomain(
      request.activeOnly === undefined ||
        typeof request.activeOnly === 'boolean',
      'INVALID_ARGUMENT',
      'activeOnly must be boolean',
    )
    const now = canonicalNow(
      dependencies.clock(),
      'validated segment search clock',
    )
    const query: ValidatedSegmentSearchQuery = {
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      projectId: identity(request.projectId, 'projectId'),
      now,
      limit: boundedInteger(request.limit, 'limit', 20, 100),
      ...(optionalSearchText(request.text, 'q', 2_000)
        ? { text: optionalSearchText(request.text, 'q', 2_000) }
        : {}),
      ...(request.sourceArtifactId
        ? {
            sourceArtifactId: identity(
              request.sourceArtifactId,
              'sourceArtifactId',
            ),
          }
        : {}),
      ...(optionalSearchText(request.platform, 'platform', 128)
        ? {
            platform: optionalSearchText(
              request.platform,
              'platform',
              128,
            ),
          }
        : {}),
      ...(unit ? { unit } : {}),
      ...(evidenceScope ? { evidenceScope } : {}),
      ...(optionalSearchText(request.metric, 'metric', 128)
        ? {
            metric: optionalSearchText(
              request.metric,
              'metric',
              128,
            ),
          }
        : {}),
      ...(request.activeOnly === true ? { activeAt: now } : {}),
    }
    return dependencies.repository.search(query)
  }
}

export function preflightValidatedSegmentReuseService(dependencies: {
  repository: ValidatedSegmentRepository
  clock: () => Date
}) {
  return async function preflight(request: {
    workspaceId: string
    projectId: string
    validatedSegmentId: string
    targetRecipe: {
      id: string
      role: 'hook' | 'body' | 'cta' | 'proof' | 'whole-video'
      objective: string
      format: string
      locale: string
    }
    requestedChanges: readonly ValidatedProtectedAspect[]
    claim: 'historical-association' | 'causality'
  }) {
    assertDomain(
      Array.isArray(request.requestedChanges) &&
        request.requestedChanges.every((change) =>
          VALIDATED_PROTECTED_ASPECTS.includes(change)),
      'INVALID_ARGUMENT',
      'requestedChanges is invalid',
    )
    const context = await dependencies.repository.readReuseContext({
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      projectId: identity(request.projectId, 'projectId'),
      validatedSegmentId: identity(
        request.validatedSegmentId,
        'validatedSegmentId',
      ),
    })
    if (!context) {
      throw new DomainError(
        'PROJECT_NOT_FOUND',
        'ValidatedSegment was not found',
      )
    }
    return evaluateValidatedSegmentReuse({
      segment: context.segment,
      currentRights: context.currentRights,
      targetRecipe: request.targetRecipe,
      requestedChanges: request.requestedChanges,
      claim: request.claim,
      evaluatedAt: canonicalNow(
        dependencies.clock(),
        'validated segment preflight clock',
      ),
    })
  }
}
