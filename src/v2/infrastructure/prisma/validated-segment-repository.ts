import {
  Prisma,
  type PrismaClient,
  type V2AssetRightsSnapshot,
  type V2ValidatedSegment,
} from '../../../../generated/prisma-v2/index.js'

import type {
  PersistedValidatedSegment,
  ValidatedSegmentCreationContext,
  ValidatedSegmentCurrentRights,
  ValidatedSegmentRepository,
  ValidatedSegmentReuseContext,
  ValidatedSegmentSearchQuery,
  ValidatedSegmentSearchResult,
} from '../../application/ports/validated-segment-repository.ts'
import {
  calculateCanonicalHash,
  stableSerialize,
} from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  assertMediaArtifactManifest,
  type MediaArtifactManifest,
} from '../../domain/media-artifact.ts'
import { normalizeSpeechText } from '../../domain/speech-segment-catalog.ts'
import {
  VALIDATED_SEGMENT_CLAIM_POLICY,
  VALIDATED_SEGMENT_POLICY_VERSION,
  type ProtectedValidationEnvelope,
  type ValidationPerformanceEvidence,
  type ValidationScope,
  type ValidationSource,
} from '../../domain/validated-segment.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

type SearchRow = V2ValidatedSegment & {
  sourceArtifact: {
    currentRightsSnapshot: V2AssetRightsSnapshot | null
  }
}

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

function record(value: unknown, field: string): Record<string, unknown> {
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

function deepFreezeJson<T>(value: T): Readonly<T> {
  if (typeof value !== 'object' || value === null) {
    return value
  }
  for (const child of Object.values(value)) {
    deepFreezeJson(child)
  }
  return Object.freeze(value)
}

function source(value: string): Readonly<ValidationSource> {
  return deepFreezeJson(
    record(
      parseJson(value, 'validation source'),
      'validation source',
    ) as unknown as ValidationSource,
  )
}

function performance(
  value: string,
): Readonly<ValidationPerformanceEvidence> {
  return deepFreezeJson(
    record(
      parseJson(value, 'validation performance'),
      'validation performance',
    ) as unknown as ValidationPerformanceEvidence,
  )
}

function envelope(
  value: string,
): Readonly<ProtectedValidationEnvelope> {
  return deepFreezeJson(
    record(
      parseJson(value, 'protected validation envelope'),
      'protected validation envelope',
    ) as unknown as ProtectedValidationEnvelope,
  )
}

function scope(row: V2ValidatedSegment): Readonly<ValidationScope> {
  return Object.freeze({
    unit: row.scopeUnit as ValidationScope['unit'],
    evidenceScope:
      row.evidenceScope as ValidationScope['evidenceScope'],
  })
}

function normalizedItems(values: readonly string[]): string {
  return `\n${values.map(normalizeSpeechText).join('\n')}\n`
}

function searchText(input: {
  source: Readonly<ValidationSource>
  performance: Readonly<ValidationPerformanceEvidence>
  envelope: Readonly<ProtectedValidationEnvelope>
}): string {
  return [
    input.source.platform,
    input.source.publicationRef,
    input.source.accountRef,
    input.performance.metric,
    input.performance.comparison?.label,
    input.envelope.exactCopy,
    input.envelope.speakerId,
  ]
    .filter((value): value is string => Boolean(value))
    .map(normalizeSpeechText)
    .join('\n')
}

function currentRights(
  row: V2AssetRightsSnapshot,
): Readonly<ValidatedSegmentCurrentRights> {
  return Object.freeze({
    id: row.id,
    status: row.status,
    consentStatus: row.consentStatus,
    ...(row.expiresAt ? { expiresAt: row.expiresAt.toISOString() } : {}),
    ...(row.consentExpiresAt
      ? { consentExpiresAt: row.consentExpiresAt.toISOString() }
      : {}),
  })
}

function effectiveRights(
  rights: Readonly<ValidatedSegmentCurrentRights> | null,
  now: string,
): Readonly<{
  status: string
  consentStatus: string
}> {
  if (!rights) {
    return Object.freeze({
      status: 'unknown',
      consentStatus: 'unknown',
    })
  }
  const instant = Date.parse(now)
  return Object.freeze({
    status:
      rights.expiresAt && Date.parse(rights.expiresAt) <= instant
        ? 'expired'
        : rights.status,
    consentStatus:
      rights.consentExpiresAt &&
      Date.parse(rights.consentExpiresAt) <= instant
        ? 'expired'
        : rights.consentStatus,
  })
}

function hydrate(
  row: V2ValidatedSegment,
): Readonly<PersistedValidatedSegment> {
  const storedSource = source(row.sourceJson)
  const storedPerformance = performance(row.performanceJson)
  const protectedEnvelope = envelope(row.protectedEnvelopeJson)
  const storedScope = scope(row)
  const content = Object.freeze({
    schemaVersion: 'validated-segment/v1' as const,
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    sourceArtifactId: row.sourceArtifactId,
    sourceArtifactSha256: row.sourceArtifactSha256,
    sourceManifestId: row.sourceManifestId,
    sourceManifestHash: row.sourceManifestHash,
    ...(row.sourceSpeechSegmentId && row.sourceSpeechSegmentHash
      ? {
          sourceSpeechSegmentId: row.sourceSpeechSegmentId,
          sourceSpeechSegmentHash: row.sourceSpeechSegmentHash,
        }
      : {}),
    scope: storedScope,
    wholeVideoValidated: row.wholeVideoValidated,
    source: storedSource,
    performance: storedPerformance,
    protectedEnvelope,
    rightsSnapshotId: row.rightsSnapshotId,
    rightsStatus: row.rightsStatus,
    consentStatus: row.consentStatus,
    validatedAt: row.validatedAt.toISOString(),
    ...(row.expiresAt
      ? { expiresAt: row.expiresAt.toISOString() }
      : {}),
    claimPolicyVersion: VALIDATED_SEGMENT_CLAIM_POLICY,
    causalClaimAllowed: false as const,
    policyVersion: VALIDATED_SEGMENT_POLICY_VERSION,
    physicalMaterialized: false as const,
    createdBy: Object.freeze({
      type: 'api-client' as const,
      id: row.createdById,
    }),
    createdAt: row.createdAt.toISOString(),
  })
  const {
    envelopeHash: _envelopeHash,
    ...envelopeContent
  } = protectedEnvelope
  if (
    row.createdByType !== 'api-client' ||
    row.claimPolicyVersion !== VALIDATED_SEGMENT_CLAIM_POLICY ||
    row.causalClaimAllowed ||
    row.policyVersion !== VALIDATED_SEGMENT_POLICY_VERSION ||
    row.physicalMaterialized ||
    row.wholeVideoValidated !== (row.scopeUnit === 'whole-video') ||
    stableSerialize(storedSource) !== row.sourceJson ||
    stableSerialize(storedPerformance) !== row.performanceJson ||
    stableSerialize(protectedEnvelope) !== row.protectedEnvelopeJson ||
    normalizeSpeechText(storedSource.platform) !==
      row.platformNormalized ||
    normalizeSpeechText(storedSource.publicationRef) !==
      row.publicationRefNormalized ||
    normalizeSpeechText(storedPerformance.metric) !==
      row.metricNormalized ||
    normalizedItems(protectedEnvelope.protectedAspects) !==
      row.protectedAspectsText ||
    searchText({
      source: storedSource,
      performance: storedPerformance,
      envelope: protectedEnvelope,
    }) !== row.searchTextNormalized ||
    calculateCanonicalHash(envelopeContent) !==
      protectedEnvelope.envelopeHash ||
    calculateCanonicalHash(content) !== row.validatedSegmentHash
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ValidatedSegment ${row.id} failed integrity validation`,
    )
  }
  return Object.freeze({
    ...content,
    validatedSegmentHash: row.validatedSegmentHash,
    requestFingerprint: row.requestFingerprint,
    idempotencyKey: row.idempotencyKey,
  })
}

function rowData(segment: Readonly<PersistedValidatedSegment>) {
  return {
    id: segment.id,
    workspaceId: segment.workspaceId,
    projectId: segment.projectId,
    sourceArtifactId: segment.sourceArtifactId,
    sourceArtifactSha256: segment.sourceArtifactSha256,
    sourceManifestId: segment.sourceManifestId,
    sourceManifestHash: segment.sourceManifestHash,
    sourceSpeechSegmentId: segment.sourceSpeechSegmentId,
    sourceSpeechSegmentHash: segment.sourceSpeechSegmentHash,
    scopeUnit: segment.scope.unit,
    evidenceScope: segment.scope.evidenceScope,
    wholeVideoValidated: segment.wholeVideoValidated,
    sourceJson: stableSerialize(segment.source),
    platformNormalized: normalizeSpeechText(segment.source.platform),
    publicationRefNormalized: normalizeSpeechText(
      segment.source.publicationRef,
    ),
    performanceJson: stableSerialize(segment.performance),
    metricNormalized: normalizeSpeechText(segment.performance.metric),
    protectedEnvelopeJson: stableSerialize(
      segment.protectedEnvelope,
    ),
    protectedAspectsText: normalizedItems(
      segment.protectedEnvelope.protectedAspects,
    ),
    searchTextNormalized: searchText({
      source: segment.source,
      performance: segment.performance,
      envelope: segment.protectedEnvelope,
    }),
    rightsSnapshotId: segment.rightsSnapshotId,
    rightsStatus: segment.rightsStatus,
    consentStatus: segment.consentStatus,
    validatedAt: new Date(segment.validatedAt),
    expiresAt: segment.expiresAt
      ? new Date(segment.expiresAt)
      : undefined,
    claimPolicyVersion: segment.claimPolicyVersion,
    causalClaimAllowed: segment.causalClaimAllowed,
    policyVersion: segment.policyVersion,
    physicalMaterialized: segment.physicalMaterialized,
    requestFingerprint: segment.requestFingerprint,
    idempotencyKey: segment.idempotencyKey,
    createdByType: segment.createdBy.type,
    createdById: segment.createdBy.id,
    createdAt: new Date(segment.createdAt),
    validatedSegmentHash: segment.validatedSegmentHash,
  }
}

function parseManifest(
  manifestJson: string,
  expectedHash: string,
): MediaArtifactManifest {
  let manifest: MediaArtifactManifest
  try {
    manifest = JSON.parse(manifestJson) as MediaArtifactManifest
  } catch {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored validation manifest is invalid JSON',
    )
  }
  assertMediaArtifactManifest(manifest)
  if (
    manifest.manifestHash !== expectedHash ||
    stableSerialize(manifest) !== manifestJson
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored validation manifest failed integrity validation',
    )
  }
  return manifest
}

function durationMs(manifest: MediaArtifactManifest): number {
  const duration = manifest.probe?.duration
  const milliseconds = Number.isFinite(duration)
    ? Math.round(Number(duration) * 1_000)
    : 0
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'Validation source manifest requires a positive duration',
    )
  }
  return milliseconds
}

export class PrismaValidatedSegmentRepository
implements ValidatedSegmentRepository {
  constructor(
    private readonly client: PrismaClient = getV2PostgresClient(),
  ) {}

  async readCreationContext(input: {
    workspaceId: string
    projectId: string
    sourceArtifactId: string
    sourceManifestId: string
    sourceSpeechSegmentId?: string
  }): Promise<Readonly<ValidatedSegmentCreationContext> | null> {
    const [artifact, speechSegment] = await Promise.all([
      this.client.v2MediaArtifact.findFirst({
        where: {
          id: input.sourceArtifactId,
          workspaceId: input.workspaceId,
          status: 'available',
          mediaType: 'video',
          projectAssets: {
            some: {
              workspaceId: input.workspaceId,
              projectId: input.projectId,
            },
          },
        },
        include: {
          manifests: {
            where: { id: input.sourceManifestId },
            take: 1,
          },
          currentRightsSnapshot: true,
        },
      }),
      input.sourceSpeechSegmentId
        ? this.client.v2SpeechSegment.findFirst({
            where: {
              id: input.sourceSpeechSegmentId,
              workspaceId: input.workspaceId,
              projectId: input.projectId,
              sourceArtifactId: input.sourceArtifactId,
              physicalMaterialized: false,
              catalogRun: { active: true },
            },
          })
        : Promise.resolve(null),
    ])
    const manifestRow = artifact?.manifests[0]
    if (
      !artifact ||
      !manifestRow ||
      !artifact.currentRightsSnapshot ||
      (input.sourceSpeechSegmentId && !speechSegment)
    ) {
      return null
    }
    const manifest = parseManifest(
      manifestRow.manifestJson,
      manifestRow.manifestHash,
    )
    if (
      manifest.artifact.sha256 !== artifact.sha256 ||
      manifest.artifact.mediaType !== 'video'
    ) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Validation manifest does not identify its video artifact',
      )
    }
    const rights = currentRights(artifact.currentRightsSnapshot)
    return Object.freeze({
      sourceArtifactId: artifact.id,
      sourceArtifactSha256: artifact.sha256,
      sourceManifestId: manifestRow.id,
      sourceManifestHash: manifestRow.manifestHash,
      durationMs: durationMs(manifest),
      rightsSnapshotId: rights.id,
      rightsStatus: rights.status,
      consentStatus: rights.consentStatus,
      currentRights: rights,
      ...(speechSegment
        ? {
            sourceSpeechSegment: Object.freeze({
              id: speechSegment.id,
              hash: speechSegment.segmentHash,
              exactText: speechSegment.exactText,
              speakerId: speechSegment.speakerId,
              rangeMs: Object.freeze([
                speechSegment.startMs,
                speechSegment.endMs,
              ]) as readonly [number, number],
            }),
          }
        : {}),
    })
  }

  async findIdempotent(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
  }) {
    const row = await this.client.v2ValidatedSegment.findUnique({
      where: {
        workspaceId_projectId_idempotencyKey: input,
      },
    })
    return row ? hydrate(row) : null
  }

  async persist(
    segment: Readonly<PersistedValidatedSegment>,
    attempt = 1,
  ): ReturnType<ValidatedSegmentRepository['persist']> {
    try {
      return await this.client.$transaction(async (transaction) => {
        const existing =
          await transaction.v2ValidatedSegment.findUnique({
            where: {
              workspaceId_projectId_idempotencyKey: {
                workspaceId: segment.workspaceId,
                projectId: segment.projectId,
                idempotencyKey: segment.idempotencyKey,
              },
            },
          })
        if (existing) {
          if (
            existing.requestFingerprint !==
            segment.requestFingerprint
          ) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different validation request',
            )
          }
          return Object.freeze({
            segment: hydrate(existing),
            replayed: true,
          })
        }
        const [artifact, actor, speechSegment] = await Promise.all([
          transaction.v2MediaArtifact.findFirst({
            where: {
              id: segment.sourceArtifactId,
              workspaceId: segment.workspaceId,
              status: 'available',
              mediaType: 'video',
              sha256: segment.sourceArtifactSha256,
              currentRightsSnapshotId: segment.rightsSnapshotId,
              projectAssets: {
                some: {
                  workspaceId: segment.workspaceId,
                  projectId: segment.projectId,
                },
              },
            },
            include: {
              manifests: {
                where: { id: segment.sourceManifestId },
                take: 1,
              },
              currentRightsSnapshot: true,
            },
          }),
          transaction.v2ApiClient.findFirst({
            where: {
              id: segment.createdBy.id,
              workspaceId: segment.workspaceId,
              status: 'active',
            },
            select: { id: true },
          }),
          segment.sourceSpeechSegmentId
            ? transaction.v2SpeechSegment.findFirst({
                where: {
                  id: segment.sourceSpeechSegmentId,
                  workspaceId: segment.workspaceId,
                  projectId: segment.projectId,
                  sourceArtifactId: segment.sourceArtifactId,
                  segmentHash: segment.sourceSpeechSegmentHash,
                  physicalMaterialized: false,
                  catalogRun: { active: true },
                },
                select: { id: true },
              })
            : Promise.resolve(null),
        ])
        const manifestRow = artifact?.manifests[0]
        if (
          !artifact ||
          !manifestRow ||
          !artifact.currentRightsSnapshot ||
          !actor ||
          (segment.sourceSpeechSegmentId && !speechSegment)
        ) {
          throw new DomainError(
            'PERSISTENCE_CONFLICT',
            'Validation commit context is no longer available',
          )
        }
        const manifest = parseManifest(
          manifestRow.manifestJson,
          manifestRow.manifestHash,
        )
        if (
          manifestRow.manifestHash !== segment.sourceManifestHash ||
          manifest.artifact.sha256 !== segment.sourceArtifactSha256 ||
          artifact.currentRightsSnapshot.status !==
            segment.rightsStatus ||
          artifact.currentRightsSnapshot.consentStatus !==
            segment.consentStatus
        ) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Validation source or rights changed before commit',
          )
        }
        const created = await transaction.v2ValidatedSegment.create({
          data: rowData(segment),
        })
        return Object.freeze({
          segment: hydrate(created),
          replayed: false,
        })
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && attempt < 3) {
        return this.persist(segment, attempt + 1)
      }
      if (isPrismaCode(error, 'P2002')) {
        const replay = await this.findIdempotent({
          workspaceId: segment.workspaceId,
          projectId: segment.projectId,
          idempotencyKey: segment.idempotencyKey,
        })
        if (replay) {
          if (replay.requestFingerprint !== segment.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different validation request',
            )
          }
          return Object.freeze({ segment: replay, replayed: true })
        }
      }
      if (isPrismaCode(error, 'P2034') || isPrismaCode(error, 'P2002')) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'ValidatedSegment cataloging conflicted with another transaction',
        )
      }
      throw error
    }
  }

  async search(
    query: Readonly<ValidatedSegmentSearchQuery>,
  ): Promise<readonly Readonly<ValidatedSegmentSearchResult>[]> {
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
    const rows = await this.client.v2ValidatedSegment.findMany({
      where: {
        workspaceId: query.workspaceId,
        projectId: query.projectId,
        ...(query.text
          ? { searchTextNormalized: { contains: query.text } }
          : {}),
        ...(query.sourceArtifactId
          ? { sourceArtifactId: query.sourceArtifactId }
          : {}),
        ...(query.platform
          ? { platformNormalized: query.platform }
          : {}),
        ...(query.unit ? { scopeUnit: query.unit } : {}),
        ...(query.evidenceScope
          ? { evidenceScope: query.evidenceScope }
          : {}),
        ...(query.metric
          ? { metricNormalized: query.metric }
          : {}),
        ...(query.activeAt
          ? {
              validatedAt: { lte: new Date(query.activeAt) },
              OR: [
                { expiresAt: null },
                { expiresAt: { gt: new Date(query.activeAt) } },
              ],
            }
          : {}),
      },
      include: {
        sourceArtifact: {
          select: { currentRightsSnapshot: true },
        },
      },
      orderBy: [
        { validatedAt: 'desc' },
        { createdAt: 'desc' },
        { id: 'asc' },
      ],
      take: query.limit,
    })
    const matchedBy = Object.freeze([
      ...(query.text ? ['text' as const] : []),
      ...(query.sourceArtifactId ? ['source-artifact' as const] : []),
      ...(query.platform ? ['platform' as const] : []),
      ...(query.unit ? ['unit' as const] : []),
      ...(query.evidenceScope ? ['evidence-scope' as const] : []),
      ...(query.metric ? ['metric' as const] : []),
      ...(query.activeAt ? ['active-at' as const] : []),
    ])
    const now = query.now
    return Object.freeze((rows as SearchRow[]).map((row) => {
      const segment = hydrate(row)
      const rights = row.sourceArtifact.currentRightsSnapshot
        ? currentRights(row.sourceArtifact.currentRightsSnapshot)
        : null
      const effective = effectiveRights(rights, now)
      const blockedReasons = Object.freeze([
        ...(segment.expiresAt &&
        Date.parse(segment.expiresAt) <= Date.parse(now)
          ? ['VALIDATION_EXPIRED']
          : []),
        ...(!rights ? ['RIGHTS_MISSING'] : []),
        ...(rights && rights.id !== segment.rightsSnapshotId
          ? ['RIGHTS_SNAPSHOT_STALE']
          : []),
        ...(effective.status !== 'approved'
          ? [`RIGHTS_${effective.status.toUpperCase()}`]
          : []),
        ...(!['approved', 'not-required'].includes(
          effective.consentStatus,
        )
          ? [`CONSENT_${effective.consentStatus.toUpperCase()}`]
          : []),
      ])
      return Object.freeze({
        segment,
        currentRights: rights,
        matchedBy,
        eligibleForReuse: blockedReasons.length === 0,
        blockedReasons,
      })
    }))
  }

  async readReuseContext(input: {
    workspaceId: string
    projectId: string
    validatedSegmentId: string
  }): Promise<Readonly<ValidatedSegmentReuseContext> | null> {
    const row = await this.client.v2ValidatedSegment.findFirst({
      where: {
        id: input.validatedSegmentId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
      },
      include: {
        sourceArtifact: {
          select: { currentRightsSnapshot: true },
        },
      },
    })
    if (!row) return null
    return Object.freeze({
      segment: hydrate(row),
      currentRights: row.sourceArtifact.currentRightsSnapshot
        ? currentRights(row.sourceArtifact.currentRightsSnapshot)
        : null,
    })
  }
}
