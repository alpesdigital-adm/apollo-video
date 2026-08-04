import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import {
  createCatalogedEvidenceSegment,
  EVIDENCE_CATEGORIES,
  type EvidenceCategory,
  type EvidenceObservationInput,
  type EvidenceProducer,
} from '../domain/evidence-segment.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import { normalizeSpeechText } from '../domain/speech-segment-catalog.ts'
import type {
  EvidenceSegmentRepository,
  EvidenceSegmentSearchQuery,
  PersistedEvidenceSegment,
} from './ports/evidence-segment-repository.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'

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

function expectedHash(value: unknown): string {
  assertDomain(
    typeof value === 'string' && SHA_256.test(value.trim().toLowerCase()),
    'INVALID_ARGUMENT',
    'expectedSpeechSegmentHash must be SHA-256',
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

function optionalText(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) return undefined
  assertDomain(
    typeof value === 'string' &&
      value.trim().length > 0 &&
      value.trim().length <= 2_000,
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function validNow(value: Date): string {
  assertDomain(
    !Number.isNaN(value.getTime()),
    'INVALID_ARGUMENT',
    'Evidence clock is invalid',
  )
  return value.toISOString()
}

export function catalogEvidenceSegmentService(dependencies: {
  repository: EvidenceSegmentRepository
  clock: () => Date
  createId: () => string
}) {
  return async function catalog(request: {
    workspaceId: string
    projectId: string
    sourceSpeechSegmentId: string
    expectedSpeechSegmentHash: string
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
    actor: Readonly<AuthenticatedExternalActor>
    idempotencyKey: string
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const sourceSpeechSegmentId = identity(
      request.sourceSpeechSegmentId,
      'sourceSpeechSegmentId',
    )
    const sourceSpeechSegmentHash = expectedHash(
      request.expectedSpeechSegmentHash,
    )
    assertDomain(
      EVIDENCE_CATEGORIES.includes(request.category),
      'INVALID_ARGUMENT',
      'category is invalid',
    )
    requireScope(request.actor, 'projects:write')
    const authenticationAudit = materializeActorAuditContext(request.actor)
    assertDomain(
      authenticationAudit.workspaceId === workspaceId,
      'AUTH_INVALID',
      'Evidence catalog actor does not belong to the workspace',
    )
    const actorId = authenticationAudit.clientId
    const key = idempotencyKey(request.idempotencyKey)
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'catalog-evidence-segment-request/v1',
      workspaceId,
      projectId,
      sourceSpeechSegmentId,
      expectedSpeechSegmentHash: sourceSpeechSegmentHash,
      category: request.category,
      claim: request.claim,
      result: request.result ?? null,
      context: request.context,
      qualifiers: request.qualifiers,
      subject: request.subject,
      attribution: request.attribution,
      compatibleOfferIds: request.compatibleOfferIds,
      compatibleAudienceTags: request.compatibleAudienceTags,
      compatibleObjections: request.compatibleObjections,
      credibilityScore: request.credibilityScore,
      specificityScore: request.specificityScore,
      authenticityScore: request.authenticityScore,
      contextRangeMs: request.contextRangeMs,
      frameRefs: request.frameRefs,
      adjacentEvidenceIds: request.adjacentEvidenceIds,
      requiresContext: request.requiresContext,
      producer: request.producer,
      actorContextHash: authenticationAudit.contextHash,
    })
    const replay = await dependencies.repository.findIdempotent({
      workspaceId,
      projectId,
      idempotencyKey: key,
      actorContextHash: authenticationAudit.contextHash,
    })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Idempotency key was used with a different evidence catalog request',
        )
      }
      return Object.freeze({ evidence: replay, replayed: true })
    }
    const context = await dependencies.repository.readCreationContext({
      workspaceId,
      projectId,
      sourceSpeechSegmentId,
    })
    if (!context) {
      throw new DomainError(
        'PROJECT_NOT_FOUND',
        'Active project speech segment was not found',
      )
    }
    if (
      context.sourceSpeechSegment.segmentHash !== sourceSpeechSegmentHash
    ) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Speech segment changed before evidence cataloging',
        {
          currentSpeechSegmentHash:
            context.sourceSpeechSegment.segmentHash,
        },
      )
    }
    const createdAt = validNow(dependencies.clock())
    const evidence = createCatalogedEvidenceSegment({
      id: identity(dependencies.createId(), 'evidenceSegmentId'),
      workspaceId,
      projectId,
      sourceSpeechSegment: context.sourceSpeechSegment,
      transcriptDurationMs: context.transcriptDurationMs,
      rights: context.rights,
      category: request.category,
      claim: request.claim,
      ...(request.result ? { result: request.result } : {}),
      context: request.context,
      qualifiers: request.qualifiers,
      subject: request.subject,
      attribution: request.attribution,
      compatibleOfferIds: request.compatibleOfferIds,
      compatibleAudienceTags: request.compatibleAudienceTags,
      compatibleObjections: request.compatibleObjections,
      credibilityScore: request.credibilityScore,
      specificityScore: request.specificityScore,
      authenticityScore: request.authenticityScore,
      contextRangeMs: request.contextRangeMs,
      frameRefs: request.frameRefs,
      adjacentEvidenceIds: request.adjacentEvidenceIds,
      requiresContext: request.requiresContext,
      producer: request.producer,
      actorId,
      createdAt,
    })
    const persisted = Object.freeze({
      ...evidence,
      requestFingerprint,
      idempotencyKey: key,
      authenticationAudit,
    }) satisfies Readonly<PersistedEvidenceSegment>
    return dependencies.repository.persist(persisted)
  }
}

export function searchEvidenceSegmentsService(dependencies: {
  repository: EvidenceSegmentRepository
  clock: () => Date
}) {
  return async function search(request: {
    workspaceId: string
    projectId: string
    text?: string
    category?: EvidenceCategory
    subject?: string
    attribution?: string
    sourceSpeechSegmentId?: string
    offerId?: string
    objection?: string
    intendedClaim?: string
    includedContext?: boolean
    limit?: number
  }) {
    const limit = request.limit ?? 20
    assertDomain(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
      'INVALID_ARGUMENT',
      'limit must be an integer between 1 and 100',
    )
    if (request.category !== undefined) {
      assertDomain(
        EVIDENCE_CATEGORIES.includes(request.category),
        'INVALID_ARGUMENT',
        'category is invalid',
      )
    }
    const query: EvidenceSegmentSearchQuery = {
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      projectId: identity(request.projectId, 'projectId'),
      limit,
      includedContext: request.includedContext === true,
      now: validNow(dependencies.clock()),
      ...(optionalText(request.text, 'q')
        ? { text: normalizeSpeechText(optionalText(request.text, 'q')!) }
        : {}),
      ...(request.category ? { category: request.category } : {}),
      ...(optionalText(request.subject, 'subject')
        ? {
            subject: normalizeSpeechText(
              optionalText(request.subject, 'subject')!,
            ),
          }
        : {}),
      ...(optionalText(request.attribution, 'attribution')
        ? {
            attribution: normalizeSpeechText(
              optionalText(request.attribution, 'attribution')!,
            ),
          }
        : {}),
      ...(request.sourceSpeechSegmentId
        ? {
            sourceSpeechSegmentId: identity(
              request.sourceSpeechSegmentId,
              'sourceSpeechSegmentId',
            ),
          }
        : {}),
      ...(request.offerId
        ? { offerId: identity(request.offerId, 'offerId') }
        : {}),
      ...(optionalText(request.objection, 'objection')
        ? { objection: optionalText(request.objection, 'objection') }
        : {}),
      ...(optionalText(request.intendedClaim, 'intendedClaim')
        ? {
            intendedClaim: optionalText(
              request.intendedClaim,
              'intendedClaim',
            ),
          }
        : {}),
    }
    return dependencies.repository.search(query)
  }
}
