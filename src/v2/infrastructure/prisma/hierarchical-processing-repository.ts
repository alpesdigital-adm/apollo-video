import {
  Prisma,
  type PrismaClient,
  type V2HierarchicalProcessingChunk,
  type V2HierarchicalProcessingRun,
  type V2HierarchicalTierExecution,
} from '../../../../generated/prisma-v2/index.js'

import {
  calculateHierarchicalProcessingRunHash,
} from '../../application/hierarchical-processing.ts'
import type {
  HierarchicalProcessingRepository,
  HierarchicalProcessingSourceContext,
  HierarchicalTierExecution,
  PersistedHierarchicalProcessingRun,
} from '../../application/ports/hierarchical-processing-repository.ts'
import {
  calculateCanonicalHash,
  stableSerialize,
} from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  normalizeHierarchicalTierVersions,
  type HierarchicalAggregation,
  type HierarchicalChunk,
  type HierarchicalEvidenceSpan,
  type HierarchicalLanguageCandidate,
  type HierarchicalProcessingPlan,
  type HierarchicalVisionObservation,
  type ProcessingTier,
} from '../../domain/hierarchical-processing.ts'
import {
  assertMediaArtifactManifest,
  type MediaArtifactManifest,
} from '../../domain/media-artifact.ts'
import { createMediaTranscript } from '../../domain/media-transcript.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

type RunRow = V2HierarchicalProcessingRun & {
  chunks: V2HierarchicalProcessingChunk[]
  tierExecutions: V2HierarchicalTierExecution[]
}

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
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

function record(
  value: unknown,
  field: string,
): Record<string, unknown> {
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

function stringArray(
  value: string,
  field: string,
): readonly string[] {
  const values = array(parseJson(value, field), field)
  if (!values.every((item) => typeof item === 'string')) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ${field} must contain strings`,
    )
  }
  return Object.freeze(values as string[])
}

function canonicalJson<T>(
  value: string,
  field: string,
): Readonly<T> {
  const parsed = parseJson(value, field)
  if (stableSerialize(parsed) !== value) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ${field} is not canonical`,
    )
  }
  return Object.freeze(parsed as T)
}

function hydrateChunk(
  row: V2HierarchicalProcessingChunk,
): Readonly<HierarchicalChunk> {
  const content = {
    id: row.id,
    artifactId: row.sourceArtifactId,
    sequence: row.sequence,
    coreRangeMs: Object.freeze([
      row.coreStartMs,
      row.coreEndMs,
    ]) as readonly [number, number],
    sourceRangeMs: Object.freeze([
      row.sourceStartMs,
      row.sourceEndMs,
    ]) as readonly [number, number],
    overlapBeforeMs: row.overlapBeforeMs,
    overlapAfterMs: row.overlapAfterMs,
    evidenceSpanIds: stringArray(
      row.evidenceSpanIdsJson,
      'hierarchical chunk evidence spans',
    ),
    wordCount: row.wordCount,
    segmentCount: row.segmentCount,
    speechMs: row.speechMs,
  }
  if (
    row.physicalMaterialized ||
    calculateCanonicalHash(content) !== row.chunkHash
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored hierarchical chunk ${row.id} failed integrity validation`,
    )
  }
  return Object.freeze({ ...content, chunkHash: row.chunkHash })
}

function hydrateTier(
  row: V2HierarchicalTierExecution,
): Readonly<HierarchicalTierExecution> {
  const prerequisites = stringArray(
    row.prerequisitesJson,
    'hierarchical tier prerequisites',
  )
  return Object.freeze({
    tier: row.tier as ProcessingTier,
    sequence: row.sequence,
    version: Object.freeze({
      provider: row.provider,
      model: row.model,
      version: row.version,
    }),
    prerequisites: prerequisites as readonly ProcessingTier[],
    status: row.status as 'processed' | 'reused',
    ...(row.reusedFromRunId
      ? { reusedFromRunId: row.reusedFromRunId }
      : {}),
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt.toISOString(),
    elapsedMs: row.elapsedMs,
    workingSetBytes: Number(row.workingSetBytes),
    costMinorUnits: row.costMinorUnits,
    outputHash: row.outputHash,
  })
}

function hydrateRun(
  row: RunRow,
): Readonly<PersistedHierarchicalProcessingRun> {
  const tierVersionsRaw = canonicalJson<Record<string, unknown>>(
    row.tierVersionsJson,
    'hierarchical tier versions',
  )
  const tierVersions = normalizeHierarchicalTierVersions(
    tierVersionsRaw,
  )
  const chunks = Object.freeze(
    [...row.chunks]
      .sort((left, right) => left.sequence - right.sequence)
      .map(hydrateChunk),
  )
  const evidenceSpans = canonicalJson<
    readonly Readonly<HierarchicalEvidenceSpan>[]
  >(row.evidenceSpansJson, 'hierarchical evidence spans')
  const visionObservations = canonicalJson<
    readonly Readonly<HierarchicalVisionObservation>[]
  >(row.visionObservationsJson, 'hierarchical vision observations')
  const languageCandidates = canonicalJson<
    readonly Readonly<HierarchicalLanguageCandidate>[]
  >(row.languageCandidatesJson, 'hierarchical language candidates')
  const aggregation = canonicalJson<HierarchicalAggregation>(
    row.aggregationJson,
    'hierarchical aggregation',
  )
  const plan = canonicalJson<HierarchicalProcessingPlan>(
    row.planJson,
    'hierarchical processing plan',
  )
  const budget = canonicalJson<
    PersistedHierarchicalProcessingRun['budget']
  >(row.budgetJson, 'hierarchical processing budget')
  const measurement = canonicalJson<
    PersistedHierarchicalProcessingRun['measurement']
  >(row.measurementJson, 'hierarchical processing measurement')
  const tierExecutions = Object.freeze(
    [...row.tierExecutions]
      .sort((left, right) => left.sequence - right.sequence)
      .map(hydrateTier),
  )
  if (
    chunks.length !== row.chunkCount ||
    evidenceSpans.length !== row.evidenceSpanCount ||
    aggregation.chapters.length !== row.chapterCount ||
    aggregation.moments.length !== row.momentCount ||
    tierExecutions.length !== 4
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored hierarchical run ${row.id} has inconsistent counts`,
    )
  }
  const content = Object.freeze({
    schemaVersion: 'hierarchical-processing-run/v1' as const,
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    sourceArtifactId: row.sourceArtifactId,
    sourceArtifactSha256: row.sourceArtifactSha256,
    sourceManifestId: row.sourceManifestId,
    sourceManifestHash: row.sourceManifestHash,
    sourceTranscriptId: row.sourceTranscriptId,
    sourceTranscriptHash: row.sourceTranscriptHash,
    durationMs: row.durationMs,
    rightsSnapshotId: row.rightsSnapshotId,
    rightsStatus: row.rightsStatus,
    consentStatus: row.consentStatus,
    processingPolicyVersion:
      'hierarchical-processing/v1' as const,
    chunkPolicyVersion: 'overlapping-time-chunks/v1' as const,
    chunkDurationMs: row.chunkDurationMs,
    overlapMs: row.overlapMs,
    tierVersions,
    ...(row.previousRunId && row.previousRunHash
      ? {
          previousRunId: row.previousRunId,
          previousRunHash: row.previousRunHash,
        }
      : {}),
    plan,
    chunks,
    evidenceSpans,
    visionObservations,
    languageCandidates,
    aggregation,
    tierExecutions,
    budget,
    measurement,
    physicalMaterialized: false as const,
    requestFingerprint: row.requestFingerprint,
    idempotencyKey: row.idempotencyKey,
    createdBy: Object.freeze({
      type: 'api-client' as const,
      id: row.createdById,
    }),
    createdAt: row.createdAt.toISOString(),
  })
  if (
    row.physicalMaterialized ||
    row.createdByType !== 'api-client' ||
    calculateHierarchicalProcessingRunHash(content) !== row.runHash
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored hierarchical run ${row.id} failed integrity validation`,
    )
  }
  return Object.freeze({
    ...content,
    runHash: row.runHash,
    active: row.active,
  })
}

function manifestContext(
  value: string,
  expectedHash: string,
  expectedArtifactSha256: string,
) {
  const parsed = parseJson(value, 'hierarchical source manifest')
  const manifest = parsed as MediaArtifactManifest
  assertMediaArtifactManifest(manifest)
  if (
    manifest.manifestHash !== expectedHash ||
    manifest.artifact.sha256 !== expectedArtifactSha256 ||
    !manifest.probe
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Hierarchical source manifest failed integrity validation',
    )
  }
  const durationMs = Math.round(manifest.probe.duration * 1_000)
  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs < 1 ||
    !Number.isSafeInteger(manifest.probe.width) ||
    !Number.isSafeInteger(manifest.probe.height) ||
    !Number.isFinite(manifest.probe.fps)
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Hierarchical source probe is incomplete',
    )
  }
  return Object.freeze({
    durationMs,
    probe: Object.freeze({
      width: manifest.probe.width,
      height: manifest.probe.height,
      fps: manifest.probe.fps,
    }),
  })
}

function transcriptContext(value: string, expectedHash: string) {
  const parsed = record(
    parseJson(value, 'hierarchical source transcript'),
    'hierarchical source transcript',
  )
  const transcript = createMediaTranscript({
    language: parsed.language,
    text: parsed.text,
    words: parsed.words,
    segments: parsed.segments,
    provider: parsed.provider,
    model: parsed.model,
  } as never)
  if (
    transcript.transcriptHash !== expectedHash ||
    parsed.transcriptHash !== expectedHash ||
    stableSerialize(transcript) !== value
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Hierarchical source transcript failed integrity validation',
    )
  }
  return Object.freeze(transcript.segments.map((segment) =>
    Object.freeze({
      id: segment.id,
      startMs: Math.round(segment.start * 1_000),
      endMs: Math.round(segment.end * 1_000),
      text: segment.text,
    })))
}

function runData(run: Readonly<PersistedHierarchicalProcessingRun>) {
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    sourceArtifactId: run.sourceArtifactId,
    sourceArtifactSha256: run.sourceArtifactSha256,
    sourceManifestId: run.sourceManifestId,
    sourceManifestHash: run.sourceManifestHash,
    sourceTranscriptId: run.sourceTranscriptId,
    sourceTranscriptHash: run.sourceTranscriptHash,
    durationMs: run.durationMs,
    rightsSnapshotId: run.rightsSnapshotId,
    rightsStatus: run.rightsStatus,
    consentStatus: run.consentStatus,
    processingPolicyVersion: run.processingPolicyVersion,
    chunkPolicyVersion: run.chunkPolicyVersion,
    chunkDurationMs: run.chunkDurationMs,
    overlapMs: run.overlapMs,
    tierVersionsJson: stableSerialize(run.tierVersions),
    previousRunId: run.previousRunId ?? null,
    previousRunHash: run.previousRunHash ?? null,
    planJson: stableSerialize(run.plan),
    evidenceSpansJson: stableSerialize(run.evidenceSpans),
    visionObservationsJson: stableSerialize(run.visionObservations),
    languageCandidatesJson: stableSerialize(run.languageCandidates),
    aggregationJson: stableSerialize(run.aggregation),
    budgetJson: stableSerialize(run.budget),
    measurementJson: stableSerialize(run.measurement),
    chunkCount: run.chunks.length,
    evidenceSpanCount: run.evidenceSpans.length,
    chapterCount: run.aggregation.chapters.length,
    momentCount: run.aggregation.moments.length,
    physicalMaterialized: run.physicalMaterialized,
    requestFingerprint: run.requestFingerprint,
    idempotencyKey: run.idempotencyKey,
    createdByType: run.createdBy.type,
    createdById: run.createdBy.id,
    createdAt: new Date(run.createdAt),
    runHash: run.runHash,
    active: run.active,
  }
}

function chunkData(
  run: Readonly<PersistedHierarchicalProcessingRun>,
  chunk: Readonly<HierarchicalChunk>,
) {
  return {
    id: chunk.id,
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    runId: run.id,
    sourceArtifactId: run.sourceArtifactId,
    sequence: chunk.sequence,
    coreStartMs: chunk.coreRangeMs[0],
    coreEndMs: chunk.coreRangeMs[1],
    sourceStartMs: chunk.sourceRangeMs[0],
    sourceEndMs: chunk.sourceRangeMs[1],
    overlapBeforeMs: chunk.overlapBeforeMs,
    overlapAfterMs: chunk.overlapAfterMs,
    evidenceSpanIdsJson: stableSerialize(chunk.evidenceSpanIds),
    wordCount: chunk.wordCount,
    segmentCount: chunk.segmentCount,
    speechMs: chunk.speechMs,
    physicalMaterialized: false,
    chunkHash: chunk.chunkHash,
    createdAt: new Date(run.createdAt),
  }
}

function tierData(
  run: Readonly<PersistedHierarchicalProcessingRun>,
  execution: Readonly<HierarchicalTierExecution>,
) {
  return {
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    runId: run.id,
    tier: execution.tier,
    sequence: execution.sequence,
    provider: execution.version.provider,
    model: execution.version.model,
    version: execution.version.version,
    prerequisitesJson: stableSerialize(execution.prerequisites),
    status: execution.status,
    reusedFromRunId: execution.reusedFromRunId ?? null,
    startedAt: new Date(execution.startedAt),
    completedAt: new Date(execution.completedAt),
    elapsedMs: execution.elapsedMs,
    workingSetBytes: BigInt(execution.workingSetBytes),
    costMinorUnits: execution.costMinorUnits,
    outputHash: execution.outputHash,
  }
}

const runInclude = {
  chunks: true,
  tierExecutions: true,
} as const

export class PrismaHierarchicalProcessingRepository
implements HierarchicalProcessingRepository {
  constructor(
    private readonly client: PrismaClient = getV2PostgresClient(),
  ) {}

  async readSourceContext(input: {
    workspaceId: string
    projectId: string
    sourceArtifactId: string
    sourceManifestId: string
    sourceTranscriptId: string
    previousRunId?: string
  }): Promise<Readonly<HierarchicalProcessingSourceContext> | null> {
    const [artifact, manifest, transcript, previousRun,
      catalogedVisualObservationCount] = await Promise.all([
      this.client.v2MediaArtifact.findFirst({
        where: {
          id: input.sourceArtifactId,
          workspaceId: input.workspaceId,
          status: 'available',
          mediaType: 'video',
          projectAssets: {
            some: {
              projectId: input.projectId,
              workspaceId: input.workspaceId,
            },
          },
        },
        include: { currentRightsSnapshot: true },
      }),
      this.client.v2MediaArtifactManifest.findFirst({
        where: {
          id: input.sourceManifestId,
          workspaceId: input.workspaceId,
          artifactId: input.sourceArtifactId,
        },
      }),
      this.client.v2MediaTranscript.findFirst({
        where: {
          id: input.sourceTranscriptId,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          sourceArtifactId: input.sourceArtifactId,
        },
      }),
      input.previousRunId
        ? this.findRun({
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            runId: input.previousRunId,
          })
        : Promise.resolve(null),
      this.client.v2SpeechSegment.count({
        where: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          sourceArtifactId: input.sourceArtifactId,
          physicalMaterialized: false,
          catalogRun: { active: true },
        },
      }),
    ])
    if (
      !artifact?.currentRightsSnapshot ||
      !manifest ||
      !transcript ||
      (input.previousRunId && !previousRun)
    ) {
      return null
    }
    const media = manifestContext(
      manifest.manifestJson,
      manifest.manifestHash,
      artifact.sha256,
    )
    return Object.freeze({
      sourceArtifactId: artifact.id,
      sourceArtifactSha256: artifact.sha256,
      sourceManifestId: manifest.id,
      sourceManifestHash: manifest.manifestHash,
      sourceTranscriptId: transcript.id,
      sourceTranscriptHash: transcript.transcriptHash,
      durationMs: media.durationMs,
      probe: media.probe,
      transcriptSegments: transcriptContext(
        transcript.transcriptJson,
        transcript.transcriptHash,
      ),
      catalogedVisualObservationCount,
      rights: Object.freeze({
        id: artifact.currentRightsSnapshot.id,
        status: artifact.currentRightsSnapshot.status,
        consentStatus:
          artifact.currentRightsSnapshot.consentStatus,
        ...(artifact.currentRightsSnapshot.expiresAt
          ? {
              expiresAt:
                artifact.currentRightsSnapshot.expiresAt.toISOString(),
            }
          : {}),
        ...(artifact.currentRightsSnapshot.consentExpiresAt
          ? {
              consentExpiresAt:
                artifact.currentRightsSnapshot.consentExpiresAt
                  .toISOString(),
            }
          : {}),
      }),
      ...(previousRun ? { previousRun } : {}),
    })
  }

  async findIdempotent(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
  }) {
    const row =
      await this.client.v2HierarchicalProcessingRun.findUnique({
        where: {
          workspaceId_projectId_idempotencyKey: input,
        },
        include: runInclude,
      })
    return row ? hydrateRun(row) : null
  }

  async findRun(input: {
    workspaceId: string
    projectId: string
    runId: string
  }) {
    const row =
      await this.client.v2HierarchicalProcessingRun.findFirst({
        where: {
          id: input.runId,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
        },
        include: runInclude,
      })
    return row ? hydrateRun(row) : null
  }

  async persist(
    run: Readonly<PersistedHierarchicalProcessingRun>,
  ): ReturnType<HierarchicalProcessingRepository['persist']> {
    const persisted = await this.persistInternal(run)
    if (!persisted) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Unfenced hierarchical persistence unexpectedly lost a lease',
      )
    }
    return persisted
  }

  async persistWithLongFormLease(
    input: Parameters<
      HierarchicalProcessingRepository[
        'persistWithLongFormLease'
      ]
    >[0],
  ): ReturnType<
    HierarchicalProcessingRepository[
      'persistWithLongFormLease'
    ]
  > {
    if (input.fence.stage !== 'chunks') {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Hierarchical output requires the chunks stage fence',
      )
    }
    if (
      input.fence.workspaceId !== input.run.workspaceId ||
      input.fence.projectId !== input.run.projectId
    ) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Hierarchical output fence belongs to another tenant or project',
      )
    }
    return this.persistInternal(input.run, input.fence)
  }

  private async persistInternal(
    run: Readonly<PersistedHierarchicalProcessingRun>,
    fence?: Parameters<
      HierarchicalProcessingRepository[
        'persistWithLongFormLease'
      ]
    >[0]['fence'],
    attempt = 1,
  ): ReturnType<
    HierarchicalProcessingRepository[
      'persistWithLongFormLease'
    ]
  > {
    const fenceNow = fence ? new Date(fence.now) : undefined
    if (fenceNow && Number.isNaN(fenceNow.getTime())) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Hierarchical persistence fence instant is invalid',
      )
    }
    try {
      return await this.client.$transaction(async (transaction) => {
        const existing =
          await transaction.v2HierarchicalProcessingRun.findUnique({
            where: {
              workspaceId_projectId_idempotencyKey: {
                workspaceId: run.workspaceId,
                projectId: run.projectId,
                idempotencyKey: run.idempotencyKey,
              },
            },
            include: runInclude,
          })
        if (existing) {
          if (existing.requestFingerprint !== run.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different hierarchical request',
            )
          }
          return Object.freeze({
            run: hydrateRun(existing),
            replayed: true,
          })
        }
        if (fence) {
          const [operation, stage] = await Promise.all([
            transaction.v2PublicOperation.findFirst({
              where: {
                id: fence.operationId,
                workspaceId: run.workspaceId,
                type: 'long-form-index',
                status: 'running',
                leaseOwner: fence.leaseOwner,
                attempt: fence.operationAttempt,
                leaseExpiresAt: { gt: fenceNow! },
              },
              select: { id: true },
            }),
            transaction.v2LongFormIndexStageCheckpoint.findFirst({
              where: {
                workflowId: fence.workflowId,
                workspaceId: run.workspaceId,
                projectId: run.projectId,
                stage: 'chunks',
                status: 'running',
                inputHash: fence.expectedStageInputHash,
                idempotencyKey:
                  fence.expectedStageIdempotencyKey,
                workflow: {
                  operationId: fence.operationId,
                  sourceArtifactId: run.sourceArtifactId,
                  sourceArtifactSha256:
                    run.sourceArtifactSha256,
                  sourceManifestId: run.sourceManifestId,
                  sourceManifestHash: run.sourceManifestHash,
                  stages: {
                    some: {
                      stage: 'transcript',
                      status: 'succeeded',
                      outputEntityType: 'media-transcript',
                      outputEntityId: run.sourceTranscriptId,
                      outputHash: run.sourceTranscriptHash,
                    },
                  },
                },
              },
              select: { id: true },
            }),
          ])
          if (
            !operation ||
            !stage ||
            run.idempotencyKey !==
              fence.expectedStageIdempotencyKey
          ) {
            return null
          }
        }
        const [artifact, manifest, transcript, actor, previous] =
          await Promise.all([
            transaction.v2MediaArtifact.findFirst({
              where: {
                id: run.sourceArtifactId,
                workspaceId: run.workspaceId,
                sha256: run.sourceArtifactSha256,
                status: 'available',
                currentRightsSnapshotId: run.rightsSnapshotId,
                projectAssets: {
                  some: {
                    projectId: run.projectId,
                    workspaceId: run.workspaceId,
                  },
                },
              },
              include: { currentRightsSnapshot: true },
            }),
            transaction.v2MediaArtifactManifest.findFirst({
              where: {
                id: run.sourceManifestId,
                workspaceId: run.workspaceId,
                artifactId: run.sourceArtifactId,
                manifestHash: run.sourceManifestHash,
              },
              select: { id: true },
            }),
            transaction.v2MediaTranscript.findFirst({
              where: {
                id: run.sourceTranscriptId,
                workspaceId: run.workspaceId,
                projectId: run.projectId,
                sourceArtifactId: run.sourceArtifactId,
                transcriptHash: run.sourceTranscriptHash,
              },
              select: { id: true },
            }),
            transaction.v2ApiClient.findFirst({
              where: {
                id: run.createdBy.id,
                workspaceId: run.workspaceId,
                status: 'active',
              },
              select: { id: true },
            }),
            run.previousRunId
              ? transaction.v2HierarchicalProcessingRun.findFirst({
                  where: {
                    id: run.previousRunId,
                    workspaceId: run.workspaceId,
                    projectId: run.projectId,
                    runHash: run.previousRunHash,
                  },
                  select: { id: true },
                })
              : Promise.resolve(null),
          ])
        if (
          !artifact?.currentRightsSnapshot ||
          !manifest ||
          !transcript ||
          !actor ||
          (run.previousRunId && !previous)
        ) {
          throw new DomainError(
            'PERSISTENCE_CONFLICT',
            'Hierarchical processing context is no longer available',
          )
        }
        if (
          fence &&
          (
            artifact.currentRightsSnapshot.status !== 'approved' ||
            !['approved', 'not-required'].includes(
              artifact.currentRightsSnapshot.consentStatus,
            ) ||
            (
              artifact.currentRightsSnapshot.expiresAt &&
              artifact.currentRightsSnapshot.expiresAt <= fenceNow!
            ) ||
            (
              artifact.currentRightsSnapshot.consentExpiresAt &&
              artifact.currentRightsSnapshot.consentExpiresAt <=
                fenceNow!
            )
          )
        ) {
          throw new DomainError(
            'ASSET_RIGHTS_BLOCKED',
            'Hierarchical source rights no longer allow long-form indexing',
          )
        }
        if (
          artifact.currentRightsSnapshot.status !== run.rightsStatus ||
          artifact.currentRightsSnapshot.consentStatus !==
            run.consentStatus
        ) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Hierarchical source rights changed before commit',
          )
        }
        await transaction.v2HierarchicalProcessingRun.updateMany({
          where: {
            workspaceId: run.workspaceId,
            projectId: run.projectId,
            sourceArtifactId: run.sourceArtifactId,
            sourceTranscriptId: run.sourceTranscriptId,
            active: true,
          },
          data: { active: false },
        })
        await transaction.v2HierarchicalProcessingRun.create({
          data: runData(run),
        })
        await transaction.v2HierarchicalProcessingChunk.createMany({
          data: run.chunks.map((chunk) => chunkData(run, chunk)),
        })
        await transaction.v2HierarchicalTierExecution.createMany({
          data: run.tierExecutions.map((execution) =>
            tierData(run, execution)),
        })
        const persisted =
          await transaction.v2HierarchicalProcessingRun.findUniqueOrThrow({
            where: { id: run.id },
            include: runInclude,
          })
        return Object.freeze({
          run: hydrateRun(persisted),
          replayed: false,
        })
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && attempt < 3) {
        return this.persistInternal(run, fence, attempt + 1)
      }
      if (isPrismaCode(error, 'P2002')) {
        const replay = await this.findIdempotent({
          workspaceId: run.workspaceId,
          projectId: run.projectId,
          idempotencyKey: run.idempotencyKey,
        })
        if (replay) {
          if (replay.requestFingerprint !== run.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different hierarchical request',
            )
          }
          return Object.freeze({ run: replay, replayed: true })
        }
      }
      if (isPrismaCode(error, 'P2034') || isPrismaCode(error, 'P2002')) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Hierarchical processing conflicted with another transaction',
        )
      }
      throw error
    }
  }
}
