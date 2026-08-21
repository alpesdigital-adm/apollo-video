import {
  Prisma,
  type PrismaClient,
  type V2EvidenceSegment,
} from '../../../../generated/prisma-v2/index.js'

import type {
  EvidenceSegmentRepository,
  EvidenceSegmentCurrentContext,
  EvidenceSegmentSearchQuery,
  EvidenceSegmentSearchResult,
  PersistedEvidenceSegment,
} from '../../application/ports/evidence-segment-repository.ts'
import {
  externalActorAuditData,
  hydrateExternalActorAudit,
} from './external-actor-audit.ts'
import {
  authorizeEvidenceSegmentUse,
  EVIDENCE_INTEGRITY_POLICY_VERSION,
  type CatalogedEvidenceSegment,
  type EvidenceCategory,
  type EvidenceIntegrityStatus,
  type EvidenceObservation,
  type EvidenceProducer,
  type EvidenceRightsSnapshot,
} from '../../domain/evidence-segment.ts'
import type {
  AssetConsentStatus,
  AssetRightsStatus,
} from '../../domain/asset-rights.ts'
import {
  calculateCanonicalHash,
  stableSerialize,
} from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  normalizeSpeechText,
  type SpeechCatalogObservation,
} from '../../domain/speech-segment-catalog.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import {
  hydrateStoredMediaTranscript,
  hydrateStoredSpeechSegment,
} from './speech-segment-catalog-repository.ts'

function isPrismaCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  )
}

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ${field} is invalid JSON`,
    )
  }
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ${field} is invalid`,
    )
  }
  return value as Record<string, unknown>
}

function array(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ${field} is invalid`,
    )
  }
  return value
}

function observation(
  value: string,
  field: string,
): Readonly<EvidenceObservation> {
  return Object.freeze(
    object(parseJson(value, field), field) as unknown as EvidenceObservation,
  )
}

function evidenceObservations(
  value: string,
  field: string,
): readonly Readonly<EvidenceObservation>[] {
  return Object.freeze(array(parseJson(value, field), field).map((item) =>
    Object.freeze(object(item, field) as unknown as EvidenceObservation)))
}

function strings(value: string, field: string): readonly string[] {
  const items = array(parseJson(value, field), field)
  if (!items.every((item) => typeof item === 'string')) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ${field} is invalid`,
    )
  }
  return Object.freeze(items as string[])
}

function rightsSnapshot(row: {
  id: string
  status: string
  consentStatus: string
  expiresAt: Date | null
  consentExpiresAt: Date | null
}): Readonly<EvidenceRightsSnapshot> {
  return Object.freeze({
    id: row.id,
    rightsStatus: row.status as AssetRightsStatus,
    consentStatus: row.consentStatus as AssetConsentStatus,
    ...(row.expiresAt
      ? { rightsExpiresAt: row.expiresAt.toISOString() }
      : {}),
    ...(row.consentExpiresAt
      ? { consentExpiresAt: row.consentExpiresAt.toISOString() }
      : {}),
  })
}

function hydrate(
  row: V2EvidenceSegment,
): Readonly<PersistedEvidenceSegment> {
  const speaker = Object.freeze(
    object(
      parseJson(row.speakerJson, 'evidence speaker'),
      'evidence speaker',
    ) as unknown as SpeechCatalogObservation,
  )
  const claim = observation(row.claimJson, 'evidence claim')
  const result = row.resultJson
    ? observation(row.resultJson, 'evidence result')
    : undefined
  const context = observation(row.contextJson, 'evidence context')
  const qualifiers = evidenceObservations(
    row.qualifiersJson,
    'evidence qualifiers',
  )
  const subject = observation(row.subjectJson, 'evidence subject')
  const attribution = observation(
    row.attributionJson,
    'evidence attribution',
  )
  const compatibleOfferIds = strings(
    row.compatibleOfferIdsJson,
    'evidence compatible offers',
  )
  const compatibleAudienceTags = strings(
    row.compatibleAudienceTagsJson,
    'evidence compatible audiences',
  )
  const compatibleObjections = strings(
    row.compatibleObjectionsJson,
    'evidence compatible objections',
  )
  const frameRefs = strings(row.frameRefsJson, 'evidence frame refs')
  const adjacentEvidenceIds = strings(
    row.adjacentEvidenceIdsJson,
    'evidence adjacent ids',
  )
  const integrityReasons = strings(
    row.integrityReasonsJson,
    'evidence integrity reasons',
  )
  const producer = Object.freeze(
    object(
      parseJson(row.producerJson, 'evidence producer'),
      'evidence producer',
    ) as unknown as EvidenceProducer,
  )
  const content = Object.freeze({
    schemaVersion: 'evidence-segment/v1' as const,
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    sourceSpeechSegmentId: row.sourceSpeechSegmentId,
    sourceSpeechSegmentHash: row.sourceSpeechSegmentHash,
    sourceTranscriptId: row.sourceTranscriptId,
    sourceTranscriptHash: row.sourceTranscriptHash,
    sourceArtifactId: row.sourceArtifactId,
    rightsSnapshotId: row.rightsSnapshotId,
    rightsStatus: row.rightsStatus as AssetRightsStatus,
    consentStatus: row.consentStatus as AssetConsentStatus,
    category: row.category as EvidenceCategory,
    speaker,
    speakerId: row.speakerId,
    claim,
    ...(result ? { result } : {}),
    context,
    qualifiers,
    subject,
    attribution,
    compatibleOfferIds,
    compatibleAudienceTags,
    compatibleObjections,
    credibilityScore: row.credibilityScore,
    specificityScore: row.specificityScore,
    authenticityScore: row.authenticityScore,
    sourceRangeMs: Object.freeze([
      row.sourceStartMs,
      row.sourceEndMs,
    ]) as readonly [number, number],
    contextRangeMs: Object.freeze([
      row.contextStartMs,
      row.contextEndMs,
    ]) as readonly [number, number],
    handlesMs: Object.freeze({
      before: row.handleBeforeMs,
      after: row.handleAfterMs,
    }),
    exactTranscript: row.exactTranscript,
    frameRefs,
    adjacentEvidenceIds,
    requiresContext: row.requiresContext,
    integrityStatus: row.integrityStatus as EvidenceIntegrityStatus,
    integrityReasons,
    producer,
    integrityPolicyVersion: EVIDENCE_INTEGRITY_POLICY_VERSION,
    physicalMaterialized: false as const,
    createdBy: Object.freeze({
      type: 'api-client' as const,
      id: row.createdById,
    }),
    createdAt: row.createdAt.toISOString(),
  })
  const normalizedQualifiers = qualifiers
    .map((item) => item.normalizedValue)
    .join('\n')
  const normalizedObjections = compatibleObjections
    .map(normalizeSpeechText)
    .join('\n')
  if (
    row.createdByType !== 'api-client' ||
    row.integrityPolicyVersion !== EVIDENCE_INTEGRITY_POLICY_VERSION ||
    row.physicalMaterialized ||
    speaker.value !== row.speakerId ||
    claim.normalizedValue !== row.claimNormalized ||
    (result?.normalizedValue ?? null) !== row.resultNormalized ||
    context.normalizedValue !== row.contextNormalized ||
    normalizedQualifiers !== row.qualifiersNormalized ||
    subject.normalizedValue !== row.subjectNormalized ||
    attribution.normalizedValue !== row.attributionNormalized ||
    normalizedObjections !== row.objectionsNormalized ||
    row.handleBeforeMs !== row.sourceStartMs - row.contextStartMs ||
    row.handleAfterMs !== row.contextEndMs - row.sourceEndMs ||
    stableSerialize(speaker) !== row.speakerJson ||
    stableSerialize(claim) !== row.claimJson ||
    (result ? stableSerialize(result) : null) !== row.resultJson ||
    stableSerialize(context) !== row.contextJson ||
    stableSerialize(qualifiers) !== row.qualifiersJson ||
    stableSerialize(subject) !== row.subjectJson ||
    stableSerialize(attribution) !== row.attributionJson ||
    stableSerialize(compatibleOfferIds) !== row.compatibleOfferIdsJson ||
    stableSerialize(compatibleAudienceTags) !==
      row.compatibleAudienceTagsJson ||
    stableSerialize(compatibleObjections) !==
      row.compatibleObjectionsJson ||
    stableSerialize(frameRefs) !== row.frameRefsJson ||
    stableSerialize(adjacentEvidenceIds) !== row.adjacentEvidenceIdsJson ||
    stableSerialize(integrityReasons) !== row.integrityReasonsJson ||
    stableSerialize(producer) !== row.producerJson ||
    calculateCanonicalHash(content) !== row.evidenceHash
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored evidence segment ${row.id} failed integrity validation`,
    )
  }
  return Object.freeze({
    ...content,
    evidenceHash: row.evidenceHash,
    requestFingerprint: row.requestFingerprint,
    idempotencyKey: row.idempotencyKey,
    authenticationAudit: hydrateExternalActorAudit(row, row.createdById),
  })
}

function persistenceData(
  evidence: Readonly<PersistedEvidenceSegment>,
) {
  return {
    id: evidence.id,
    workspaceId: evidence.workspaceId,
    projectId: evidence.projectId,
    sourceSpeechSegmentId: evidence.sourceSpeechSegmentId,
    sourceSpeechSegmentHash: evidence.sourceSpeechSegmentHash,
    sourceTranscriptId: evidence.sourceTranscriptId,
    sourceTranscriptHash: evidence.sourceTranscriptHash,
    sourceArtifactId: evidence.sourceArtifactId,
    rightsSnapshotId: evidence.rightsSnapshotId,
    rightsStatus: evidence.rightsStatus,
    consentStatus: evidence.consentStatus,
    category: evidence.category,
    speakerJson: stableSerialize(evidence.speaker),
    speakerId: evidence.speakerId,
    claimJson: stableSerialize(evidence.claim),
    claimNormalized: evidence.claim.normalizedValue,
    resultJson: evidence.result
      ? stableSerialize(evidence.result)
      : undefined,
    resultNormalized: evidence.result?.normalizedValue,
    contextJson: stableSerialize(evidence.context),
    contextNormalized: evidence.context.normalizedValue,
    qualifiersJson: stableSerialize(evidence.qualifiers),
    qualifiersNormalized: evidence.qualifiers
      .map((item) => item.normalizedValue)
      .join('\n'),
    subjectJson: stableSerialize(evidence.subject),
    subjectNormalized: evidence.subject.normalizedValue,
    attributionJson: stableSerialize(evidence.attribution),
    attributionNormalized: evidence.attribution.normalizedValue,
    compatibleOfferIdsJson: stableSerialize(evidence.compatibleOfferIds),
    compatibleAudienceTagsJson: stableSerialize(
      evidence.compatibleAudienceTags,
    ),
    compatibleObjectionsJson: stableSerialize(
      evidence.compatibleObjections,
    ),
    objectionsNormalized: evidence.compatibleObjections
      .map(normalizeSpeechText)
      .join('\n'),
    credibilityScore: evidence.credibilityScore,
    specificityScore: evidence.specificityScore,
    authenticityScore: evidence.authenticityScore,
    sourceStartMs: evidence.sourceRangeMs[0],
    sourceEndMs: evidence.sourceRangeMs[1],
    contextStartMs: evidence.contextRangeMs[0],
    contextEndMs: evidence.contextRangeMs[1],
    handleBeforeMs: evidence.handlesMs.before,
    handleAfterMs: evidence.handlesMs.after,
    exactTranscript: evidence.exactTranscript,
    frameRefsJson: stableSerialize(evidence.frameRefs),
    adjacentEvidenceIdsJson: stableSerialize(evidence.adjacentEvidenceIds),
    requiresContext: evidence.requiresContext,
    integrityStatus: evidence.integrityStatus,
    integrityReasonsJson: stableSerialize(evidence.integrityReasons),
    producerJson: stableSerialize(evidence.producer),
    integrityPolicyVersion: evidence.integrityPolicyVersion,
    physicalMaterialized: evidence.physicalMaterialized,
    requestFingerprint: evidence.requestFingerprint,
    idempotencyKey: evidence.idempotencyKey,
    createdByType: evidence.createdBy.type,
    createdById: evidence.createdBy.id,
    createdAt: new Date(evidence.createdAt),
    evidenceHash: evidence.evidenceHash,
    ...externalActorAuditData(
      evidence.authenticationAudit,
      evidence.workspaceId,
      evidence.createdBy.id,
    ),
  }
}

export class PrismaEvidenceSegmentRepository
implements EvidenceSegmentRepository {
  constructor(
    private readonly client: PrismaClient = getV2PostgresClient(),
  ) {}

  async readCreationContext(input: {
    workspaceId: string
    projectId: string
    sourceSpeechSegmentId: string
  }) {
    const row = await this.client.v2SpeechSegment.findFirst({
      where: {
        id: input.sourceSpeechSegmentId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        catalogRun: { active: true },
      },
      include: {
        sourceTranscript: true,
        sourceArtifact: {
          include: { currentRightsSnapshot: true },
        },
      },
    })
    if (!row?.sourceArtifact.currentRightsSnapshot) return null
    const transcript = hydrateStoredMediaTranscript(row.sourceTranscript)
    const transcriptDurationMs = Math.round(Math.max(
      ...transcript.words.map((word) => word.end * 1_000),
      ...transcript.segments.map((segment) => segment.end * 1_000),
    ))
    return Object.freeze({
      sourceSpeechSegment: hydrateStoredSpeechSegment(row),
      transcriptDurationMs,
      rights: rightsSnapshot(row.sourceArtifact.currentRightsSnapshot),
    })
  }

  async findIdempotent(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
    actorContextHash: string
  }) {
    const row = await this.client.v2EvidenceSegment.findUnique({
      where: {
        workspaceId_projectId_idempotencyKey: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    })
    if (!row) return null
    const evidence = hydrate(row)
    if (
      evidence.authenticationAudit.contextHash !== input.actorContextHash
    ) {
      throw new DomainError(
        'IDEMPOTENCY_PAYLOAD_MISMATCH',
        'Evidence catalog replay belongs to another authentication context',
      )
    }
    return evidence
  }

  async readCurrent(input: {
    workspaceId: string
    projectId: string
    evidenceId: string
  }): Promise<Readonly<EvidenceSegmentCurrentContext> | null> {
    const row = await this.client.v2EvidenceSegment.findFirst({
      where: {
        id: input.evidenceId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
      },
      include: {
        sourceArtifact: {
          include: { currentRightsSnapshot: true },
        },
      },
    })
    if (!row) return null
    const currentRights = row.sourceArtifact.currentRightsSnapshot
    if (
      !['video', 'image', 'audio', 'document'].includes(
        row.sourceArtifact.mediaType,
      )
    ) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `Evidence ${row.id} has an unsupported source media type`,
      )
    }
    return Object.freeze({
      evidence: hydrate(row),
      sourceMediaType: row.sourceArtifact.mediaType as
        EvidenceSegmentCurrentContext['sourceMediaType'],
      ...(currentRights
        ? { currentRights: rightsSnapshot(currentRights) }
        : {}),
    })
  }

  async persist(
    evidence: Readonly<PersistedEvidenceSegment>,
    attempt = 1,
  ): ReturnType<EvidenceSegmentRepository['persist']> {
    try {
      return await this.client.$transaction(async (transaction) => {
        const existing = await transaction.v2EvidenceSegment.findUnique({
          where: {
            workspaceId_projectId_idempotencyKey: {
              workspaceId: evidence.workspaceId,
              projectId: evidence.projectId,
              idempotencyKey: evidence.idempotencyKey,
            },
          },
        })
        if (existing) {
          if (existing.requestFingerprint !== evidence.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different evidence catalog request',
            )
          }
          if (
            hydrateExternalActorAudit(existing, existing.createdById)
              .contextHash !== evidence.authenticationAudit.contextHash
          ) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Evidence catalog replay belongs to another authentication context',
            )
          }
          return Object.freeze({
            evidence: hydrate(existing),
            replayed: true,
          })
        }
        const [source, artifact, actor] = await Promise.all([
          transaction.v2SpeechSegment.findFirst({
            where: {
              id: evidence.sourceSpeechSegmentId,
              workspaceId: evidence.workspaceId,
              projectId: evidence.projectId,
              catalogRun: { active: true },
            },
          }),
          transaction.v2MediaArtifact.findFirst({
            where: {
              id: evidence.sourceArtifactId,
              workspaceId: evidence.workspaceId,
              status: 'available',
              currentRightsSnapshotId: evidence.rightsSnapshotId,
            },
            include: { currentRightsSnapshot: true },
          }),
          transaction.v2ApiClient.findFirst({
            where: {
              id: evidence.createdBy.id,
              workspaceId: evidence.workspaceId,
              status: 'active',
            },
            select: { id: true },
          }),
        ])
        if (!source || !artifact?.currentRightsSnapshot || !actor) {
          throw new DomainError(
            'PERSISTENCE_CONFLICT',
            'Evidence commit context is no longer available',
          )
        }
        const currentRights = rightsSnapshot(
          artifact.currentRightsSnapshot,
        )
        if (
          source.segmentHash !== evidence.sourceSpeechSegmentHash ||
          source.sourceTranscriptId !== evidence.sourceTranscriptId ||
          source.sourceTranscriptHash !== evidence.sourceTranscriptHash ||
          source.sourceArtifactId !== evidence.sourceArtifactId ||
          source.exactText !== evidence.exactTranscript ||
          source.startMs !== evidence.sourceRangeMs[0] ||
          source.endMs !== evidence.sourceRangeMs[1] ||
          currentRights.rightsStatus !== evidence.rightsStatus ||
          currentRights.consentStatus !== evidence.consentStatus
        ) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Evidence source or rights changed before commit',
          )
        }
        const row = await transaction.v2EvidenceSegment.create({
          data: persistenceData(evidence),
        })
        return Object.freeze({
          evidence: hydrate(row),
          replayed: false,
        })
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && attempt < 3) {
        return this.persist(evidence, attempt + 1)
      }
      if (isPrismaCode(error, 'P2034')) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Evidence catalog conflicted with another transaction',
        )
      }
      if (isPrismaCode(error, 'P2002')) {
        const replay = await this.findIdempotent({
          workspaceId: evidence.workspaceId,
          projectId: evidence.projectId,
          idempotencyKey: evidence.idempotencyKey,
          actorContextHash: evidence.authenticationAudit.contextHash,
        })
        if (replay) {
          if (replay.requestFingerprint !== evidence.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different evidence catalog request',
            )
          }
          return Object.freeze({ evidence: replay, replayed: true })
        }
      }
      throw error
    }
  }

  async search(
    query: Readonly<EvidenceSegmentSearchQuery>,
  ): Promise<readonly Readonly<EvidenceSegmentSearchResult>[]> {
    const project = await this.client.v2Project.findFirst({
      where: {
        id: query.projectId,
        workspaceId: query.workspaceId,
      },
      select: { id: true },
    })
    if (!project) {
      throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found')
    }
    const rows = await this.client.v2EvidenceSegment.findMany({
      where: {
        workspaceId: query.workspaceId,
        projectId: query.projectId,
        ...(query.text
          ? {
              OR: [
                { claimNormalized: { contains: query.text } },
                { resultNormalized: { contains: query.text } },
                { contextNormalized: { contains: query.text } },
                { qualifiersNormalized: { contains: query.text } },
              ],
            }
          : {}),
        ...(query.category ? { category: query.category } : {}),
        ...(query.subject
          ? { subjectNormalized: { contains: query.subject } }
          : {}),
        ...(query.attribution
          ? { attributionNormalized: { contains: query.attribution } }
          : {}),
        ...(query.sourceSpeechSegmentId
          ? { sourceSpeechSegmentId: query.sourceSpeechSegmentId }
          : {}),
        ...(query.offerId
          ? {
              compatibleOfferIdsJson: {
                contains: JSON.stringify(query.offerId),
              },
            }
          : {}),
        ...(query.objection
          ? {
              objectionsNormalized: {
                contains: normalizeSpeechText(query.objection),
              },
            }
          : {}),
      },
      include: {
        sourceArtifact: {
          include: { currentRightsSnapshot: true },
        },
      },
      orderBy: [
        { credibilityScore: 'desc' },
        { specificityScore: 'desc' },
        { authenticityScore: 'desc' },
        { createdAt: 'desc' },
        { id: 'asc' },
      ],
      take: query.limit,
    })
    const matchedBy = Object.freeze([
      ...(query.text ? ['text' as const] : []),
      ...(query.category ? ['category' as const] : []),
      ...(query.subject ? ['subject' as const] : []),
      ...(query.attribution ? ['attribution' as const] : []),
      ...(query.sourceSpeechSegmentId
        ? ['source-speech-segment' as const]
        : []),
      ...(query.offerId ? ['offer' as const] : []),
      ...(query.objection ? ['objection' as const] : []),
    ])
    return Object.freeze(rows.map((row) => {
      const evidence = hydrate(row)
      const current = row.sourceArtifact.currentRightsSnapshot
      const currentRights = current
        ? rightsSnapshot(current)
        : Object.freeze({
            id: 'rights-missing',
            rightsStatus: 'unknown' as const,
            consentStatus: 'unknown' as const,
          })
      return Object.freeze({
        evidence,
        matchedBy,
        reuseDecision: authorizeEvidenceSegmentUse({
          evidence,
          intendedClaim: query.intendedClaim,
          includedContext: query.includedContext,
          offerId: query.offerId,
          objection: query.objection,
          currentRights,
          now: query.now,
        }),
      })
    }))
  }
}
