import {
  Prisma,
  type PrismaClient,
  type V2LongFormIndexStageCheckpoint,
  type V2LongFormIndexWorkflow,
  type V2SpeakerDiarizationRun,
  type V2SpeakerDiarizationSegment,
} from '../../../../generated/prisma-v2/index.js'

import type {
  SpeakerDiarizationRepository,
  SpeakerDiarizationSourceContext,
} from '../../application/ports/speaker-diarization-repository.ts'
import {
  calculateCanonicalHash,
  stableSerialize,
} from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  hydrateLongFormIndexWorkflow,
} from '../../domain/long-form-index-workflow.ts'
import {
  hydrateSpeakerDiarizationRun,
  type SpeakerDiarizationRun,
} from '../../domain/speaker-diarization.ts'
import { createMediaTranscript } from '../../domain/media-transcript.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

type RunWithSegments = V2SpeakerDiarizationRun & {
  segments: V2SpeakerDiarizationSegment[]
}

type WorkflowWithStages = V2LongFormIndexWorkflow & {
  stages: V2LongFormIndexStageCheckpoint[]
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

function iso(value: Date | null): string | undefined {
  return value?.toISOString()
}

function stringArray(value: string, field: string): readonly string[] {
  const parsed = parseJson(value, field)
  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => typeof item !== 'string')
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ${field} is not a string array`,
    )
  }
  return parsed
}

function optionalStringArray(
  value: string | null,
  field: string,
): readonly string[] | undefined {
  return value === null ? undefined : stringArray(value, field)
}

function assertWorkflowProjection(
  row: WorkflowWithStages,
  workflow: ReturnType<typeof hydrateLongFormIndexWorkflow>,
): void {
  const ordered = row.stages.toSorted(
    (left, right) => left.sequence - right.sequence,
  )
  if (
    stableSerialize(workflow) !== row.workflowJson ||
    workflow.id !== row.id ||
    workflow.workspaceId !== row.workspaceId ||
    workflow.projectId !== row.projectId ||
    workflow.sourceArtifactId !== row.sourceArtifactId ||
    workflow.sourceArtifactSha256 !== row.sourceArtifactSha256 ||
    workflow.sourceManifestId !== row.sourceManifestId ||
    workflow.sourceManifestHash !== row.sourceManifestHash ||
    (workflow.sourceTranscriptId ?? null) !==
      row.sourceTranscriptId ||
    (workflow.sourceTranscriptHash ?? null) !==
      row.sourceTranscriptHash ||
    workflow.durationMs !== row.durationMs ||
    workflow.schemaVersion !== row.schemaVersion ||
    workflow.policyVersion !== row.policyVersion ||
    workflow.status !== row.status ||
    workflow.budget.currency !== row.budgetCurrency ||
    workflow.budget.maximumCostMinorUnits !==
      row.maximumCostMinorUnits ||
    workflow.budget.maximumElapsedMs !== row.maximumElapsedMs ||
    workflow.budget.maximumConcurrency !==
      row.maximumConcurrency ||
    workflow.summary.completedStageCount !==
      row.completedStageCount ||
    workflow.summary.searchableStageCount !==
      row.searchableStageCount ||
    workflow.summary.resultCount !== row.resultCount ||
    workflow.summary.costMinorUnits !== row.costMinorUnits ||
    workflow.summary.elapsedMs !== row.elapsedMs ||
    (workflow.summary.nextStage ?? null) !== row.nextStage ||
    workflow.summary.duplicateSegments !== row.duplicateSegments ||
    workflow.summary.resumable !== row.resumable ||
    workflow.runHash !== row.runHash ||
    workflow.createdByClientId !== row.createdByClientId ||
    workflow.createdAt !== row.createdAt.toISOString() ||
    workflow.updatedAt !== row.updatedAt.toISOString() ||
    workflow.stages.length !== ordered.length
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored diarization workflow source failed projection validation',
    )
  }
  for (const [index, stage] of workflow.stages.entries()) {
    const stored = ordered[index]
    if (
      !stored ||
      stored.workspaceId !== workflow.workspaceId ||
      stored.projectId !== workflow.projectId ||
      stored.workflowId !== workflow.id ||
      stored.stage !== stage.stage ||
      stored.sequence !== stage.sequence ||
      stored.prerequisitesJson !==
        stableSerialize(stage.prerequisites) ||
      stored.execution !== stage.execution ||
      stored.status !== stage.status ||
      stored.versionJson !== stableSerialize(stage.version) ||
      stored.budgetJson !== stableSerialize(stage.budget) ||
      stored.concurrency !== stage.concurrency ||
      stored.inputHash !== stage.inputHash ||
      stored.idempotencyKey !== stage.idempotencyKey ||
      stored.attempt !== stage.attempt ||
      stored.outputHash !== (stage.outputHash ?? null) ||
      stored.outputEntityType !==
        (stage.outputReference?.type ?? null) ||
      stored.outputEntityId !==
        (stage.outputReference?.id ?? null) ||
      stored.resultCount !== stage.resultCount ||
      stored.searchable !== stage.searchable ||
      stored.costMinorUnits !== stage.costMinorUnits ||
      stored.elapsedMs !== stage.elapsedMs ||
      iso(stored.startedAt) !== stage.startedAt ||
      iso(stored.completedAt) !== stage.completedAt ||
      stored.errorCode !== (stage.error?.code ?? null) ||
      stored.errorMessage !== (stage.error?.message ?? null) ||
      stored.errorRetryable !== (stage.error?.retryable ?? null) ||
      stored.stageJson !== stableSerialize(stage) ||
      stored.stageHash !== stage.stageHash
    ) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `Stored diarization stage ${stage.stage} failed projection validation`,
      )
    }
  }
}

function hydrateTranscript(row: {
  transcriptJson: string
  transcriptHash: string
}) {
  const value = parseJson(
    row.transcriptJson,
    'diarization source transcript',
  ) as Record<string, unknown>
  const transcript = createMediaTranscript({
    language: value.language,
    text: value.text,
    words: value.words,
    segments: value.segments,
    provider: value.provider,
    model: value.model,
  } as never)
  if (
    value.transcriptHash !== row.transcriptHash ||
    transcript.transcriptHash !== row.transcriptHash ||
    stableSerialize(transcript) !== row.transcriptJson
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored diarization source transcript failed integrity validation',
    )
  }
  return transcript
}

function hydrateRun(
  row: RunWithSegments,
): Readonly<SpeakerDiarizationRun> {
  const run = hydrateSpeakerDiarizationRun(
    parseJson(row.runJson, `speaker diarization ${row.id}`),
  )
  const segments = [...row.segments].sort(
    (left, right) => left.ordinal - right.ordinal,
  )
  if (
    stableSerialize(run) !== row.runJson ||
    run.id !== row.id ||
    run.workspaceId !== row.workspaceId ||
    run.projectId !== row.projectId ||
    run.workflowId !== row.workflowId ||
    run.sourceArtifactId !== row.sourceArtifactId ||
    run.sourceArtifactSha256 !== row.sourceArtifactSha256 ||
    run.sourceManifestId !== row.sourceManifestId ||
    run.sourceManifestHash !== row.sourceManifestHash ||
    run.sourceTranscriptId !== row.sourceTranscriptId ||
    run.sourceTranscriptHash !== row.sourceTranscriptHash ||
    run.durationMs !== row.durationMs ||
    stableSerialize(run.providerInput) !== row.providerInputJson ||
    calculateCanonicalHash(run.providerInput) !==
      row.providerInputHash ||
    run.schemaVersion !== row.schemaVersion ||
    run.policyVersion !== row.policyVersion ||
    run.provider.id !== row.providerId ||
    run.provider.model !== row.providerModel ||
    run.provider.version !== row.providerVersion ||
    run.speakerCount !== row.speakerCount ||
    run.segmentCount !== row.segmentCount ||
    run.usageSeconds !== row.usageSeconds ||
    run.costMinorUnits !== row.costMinorUnits ||
    run.elapsedMs !== row.elapsedMs ||
    run.identityResolved !== row.identityResolved ||
    run.physicalMaterialized !== row.physicalMaterialized ||
    run.requestFingerprint !== row.requestFingerprint ||
    run.idempotencyKey !== row.idempotencyKey ||
    run.createdByClientId !== row.createdByClientId ||
    run.createdAt !== row.createdAt.toISOString() ||
    run.runHash !== row.runHash ||
    run.segments.length !== segments.length
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored speaker diarization ${row.id} failed projection validation`,
    )
  }
  for (const [index, segment] of run.segments.entries()) {
    const stored = segments[index]
    if (
      !stored ||
      stored.id !== segment.id ||
      stored.workspaceId !== run.workspaceId ||
      stored.projectId !== run.projectId ||
      stored.runId !== run.id ||
      stored.ordinal !== segment.ordinal ||
      stored.providerSegmentId !== segment.providerSegmentId ||
      stored.providerLabel !== segment.providerLabel ||
      stored.speakerKey !== segment.speakerKey ||
      stored.startMs !== segment.startMs ||
      stored.endMs !== segment.endMs ||
      stored.text !== segment.text ||
      stored.textHash !== segment.textHash ||
      stored.segmentJson !== stableSerialize(segment) ||
      stored.segmentHash !== segment.segmentHash
    ) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `Stored speaker diarization segment ${index} failed validation`,
      )
    }
  }
  return run
}

function runData(run: Readonly<SpeakerDiarizationRun>) {
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    workflowId: run.workflowId,
    sourceArtifactId: run.sourceArtifactId,
    sourceArtifactSha256: run.sourceArtifactSha256,
    sourceManifestId: run.sourceManifestId,
    sourceManifestHash: run.sourceManifestHash,
    sourceTranscriptId: run.sourceTranscriptId,
    sourceTranscriptHash: run.sourceTranscriptHash,
    durationMs: run.durationMs,
    providerInputJson: stableSerialize(run.providerInput),
    providerInputHash: calculateCanonicalHash(run.providerInput),
    schemaVersion: run.schemaVersion,
    policyVersion: run.policyVersion,
    providerId: run.provider.id,
    providerModel: run.provider.model,
    providerVersion: run.provider.version,
    speakerCount: run.speakerCount,
    segmentCount: run.segmentCount,
    usageSeconds: run.usageSeconds,
    costMinorUnits: run.costMinorUnits,
    elapsedMs: run.elapsedMs,
    identityResolved: run.identityResolved,
    physicalMaterialized: run.physicalMaterialized,
    requestFingerprint: run.requestFingerprint,
    idempotencyKey: run.idempotencyKey,
    createdByClientId: run.createdByClientId,
    createdAt: new Date(run.createdAt),
    runJson: stableSerialize(run),
    runHash: run.runHash,
  }
}

function segmentData(
  run: Readonly<SpeakerDiarizationRun>,
  segment: Readonly<SpeakerDiarizationRun['segments'][number]>,
) {
  return {
    id: segment.id,
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    runId: run.id,
    ordinal: segment.ordinal,
    providerSegmentId: segment.providerSegmentId,
    providerLabel: segment.providerLabel,
    speakerKey: segment.speakerKey,
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: segment.text,
    textHash: segment.textHash,
    segmentJson: stableSerialize(segment),
    segmentHash: segment.segmentHash,
  }
}

async function readSourceContext(
  client: PrismaClient | Prisma.TransactionClient,
  input: {
    workspaceId: string
    projectId: string
    workflowId: string
  },
): Promise<Readonly<SpeakerDiarizationSourceContext> | null> {
  const row = await client.v2LongFormIndexWorkflow.findFirst({
    where: {
      id: input.workflowId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
    },
    include: {
      stages: { orderBy: { sequence: 'asc' } },
    },
  })
  if (!row) return null
  const workflow = hydrateLongFormIndexWorkflow(
    parseJson(row.workflowJson, `long-form workflow ${row.id}`),
  )
  assertWorkflowProjection(row, workflow)
  const transcriptStage = workflow.stages.find(
    (stage) => stage.stage === 'transcript',
  )
  const diarizationStage = workflow.stages.find(
    (stage) => stage.stage === 'diarization',
  )
  if (
    transcriptStage?.status !== 'succeeded' ||
    transcriptStage.outputReference?.type !== 'media-transcript' ||
    !transcriptStage.outputHash ||
    !diarizationStage ||
    !['running', 'succeeded'].includes(diarizationStage.status)
  ) {
    return null
  }
  const [transcriptRow, sourceArtifact, sourceManifest] =
    await Promise.all([
    client.v2MediaTranscript.findFirst({
      where: {
        id: transcriptStage.outputReference.id,
        workspaceId: workflow.workspaceId,
        projectId: workflow.projectId,
        sourceArtifactId: workflow.sourceArtifactId,
        sourceManifestId: workflow.sourceManifestId,
        transcriptHash: transcriptStage.outputHash,
      },
      select: {
        id: true,
        transcriptHash: true,
        transcriptJson: true,
      },
    }),
    client.v2MediaArtifact.findFirst({
      where: {
        id: workflow.sourceArtifactId,
        workspaceId: workflow.workspaceId,
        sha256: workflow.sourceArtifactSha256,
        mediaType: 'video',
        status: 'available',
        projectAssets: {
          some: {
            projectId: workflow.projectId,
            workspaceId: workflow.workspaceId,
          },
        },
      },
      select: {
        id: true,
        artifactKey: true,
        byteSize: true,
      },
    }),
    client.v2MediaArtifactManifest.findFirst({
      where: {
        id: workflow.sourceManifestId,
        workspaceId: workflow.workspaceId,
        artifactId: workflow.sourceArtifactId,
        manifestHash: workflow.sourceManifestHash,
      },
      select: { id: true },
    }),
  ])
  if (!transcriptRow || !sourceArtifact || !sourceManifest) {
    return null
  }
  const transcript = hydrateTranscript(transcriptRow)
  return Object.freeze({
    operationId: row.operationId,
    createdByClientId: workflow.createdByClientId,
    sourceArtifactId: workflow.sourceArtifactId,
    sourceArtifactKey: sourceArtifact.artifactKey,
    sourceArtifactByteSize: sourceArtifact.byteSize,
    sourceArtifactSha256: workflow.sourceArtifactSha256,
    sourceManifestId: workflow.sourceManifestId,
    sourceManifestHash: workflow.sourceManifestHash,
    sourceTranscriptId: transcriptRow.id,
    sourceTranscriptHash: transcriptRow.transcriptHash,
    language: transcript.language,
    durationMs: workflow.durationMs,
    stageStatus: diarizationStage.status === 'succeeded'
      ? 'succeeded'
      : 'running',
    stageInputHash: diarizationStage.inputHash,
    stageIdempotencyKey: diarizationStage.idempotencyKey,
  })
}

async function readRun(
  client: PrismaClient | Prisma.TransactionClient,
  input: {
    workspaceId: string
    projectId?: string
    runId?: string
    workflowId?: string
    idempotencyKey?: string
  },
): Promise<RunWithSegments | null> {
  return client.v2SpeakerDiarizationRun.findFirst({
    where: {
      workspaceId: input.workspaceId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.runId ? { id: input.runId } : {}),
      ...(input.workflowId ? { workflowId: input.workflowId } : {}),
      ...(input.idempotencyKey
        ? { idempotencyKey: input.idempotencyKey }
        : {}),
    },
    include: { segments: { orderBy: { ordinal: 'asc' } } },
  })
}

export class PrismaSpeakerDiarizationRepository
implements SpeakerDiarizationRepository {
  constructor(
    private readonly prisma: PrismaClient = getV2PostgresClient(),
  ) {}

  readSourceContext(input: {
    workspaceId: string
    projectId: string
    workflowId: string
  }) {
    return readSourceContext(this.prisma, input)
  }

  async findRun(input: {
    workspaceId: string
    projectId: string
    runId: string
  }) {
    const row = await readRun(this.prisma, input)
    return row ? hydrateRun(row) : null
  }

  async findReplay(input: {
    workspaceId: string
    workflowId: string
    idempotencyKey: string
  }) {
    const row = await readRun(this.prisma, input)
    return row ? hydrateRun(row) : null
  }

  async persistWithLease(input: {
    run: Readonly<SpeakerDiarizationRun>
    operationId: string
    leaseOwner: string
    operationAttempt: number
    expectedStageInputHash: string
    now: string
  }, attempt = 1): ReturnType<
    SpeakerDiarizationRepository['persistWithLease']
  > {
    const run = hydrateSpeakerDiarizationRun(input.run)
    const now = new Date(input.now)
    if (Number.isNaN(now.getTime())) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Diarization persistence instant is invalid',
      )
    }
    try {
      const outcome = await this.prisma.$transaction(
        async (transaction) => {
          const replay = await readRun(transaction, {
            workspaceId: run.workspaceId,
            workflowId: run.workflowId,
            idempotencyKey: run.idempotencyKey,
          })
          if (replay) {
            const hydrated = hydrateRun(replay)
            if (
              hydrated.requestFingerprint !== run.requestFingerprint
            ) {
              throw new DomainError(
                'IDEMPOTENCY_PAYLOAD_MISMATCH',
                'Diarization stage key has a different persisted result',
              )
            }
            return 'replayed' as const
          }
          const [context, lease, rights] = await Promise.all([
            readSourceContext(transaction, {
              workspaceId: run.workspaceId,
              projectId: run.projectId,
              workflowId: run.workflowId,
            }),
            transaction.v2PublicOperation.findFirst({
              where: {
                id: input.operationId,
                workspaceId: run.workspaceId,
                type: 'long-form-index',
                status: 'running',
                leaseOwner: input.leaseOwner,
                attempt: input.operationAttempt,
                leaseExpiresAt: { gt: now },
              },
              select: { id: true },
            }),
            transaction.v2MediaArtifact.findFirst({
              where: {
                id: run.sourceArtifactId,
                workspaceId: run.workspaceId,
              },
              include: { currentRightsSnapshot: true },
            }),
          ])
          const currentRights = rights?.currentRightsSnapshot
          if (
            !context ||
            !lease ||
            context.operationId !== input.operationId ||
            context.stageInputHash !== input.expectedStageInputHash ||
            context.stageIdempotencyKey !== run.idempotencyKey ||
            context.sourceArtifactId !== run.sourceArtifactId ||
            context.sourceArtifactSha256 !==
              run.sourceArtifactSha256 ||
            context.sourceManifestId !== run.sourceManifestId ||
            context.sourceManifestHash !== run.sourceManifestHash ||
            context.sourceTranscriptId !== run.sourceTranscriptId ||
            context.sourceTranscriptHash !==
              run.sourceTranscriptHash ||
            context.durationMs !== run.durationMs ||
            context.createdByClientId !== run.createdByClientId ||
            context.stageStatus !== 'running'
          ) {
            return 'lease-lost' as const
          }
          const rightsAllowedUses = currentRights
            ? stringArray(
                currentRights.allowedUsesJson,
                'rights allowed uses',
              )
            : []
          const rightsProhibitedUses = currentRights
            ? stringArray(
                currentRights.prohibitedUsesJson,
                'rights prohibited uses',
              )
            : []
          const rightsAllowedWorkspaces = currentRights
            ? stringArray(
                currentRights.allowedWorkspaceIdsJson,
                'rights allowed workspaces',
              )
            : []
          const rightsAllowedLocales = currentRights
            ? optionalStringArray(
                currentRights.allowedLocalesJson,
                'rights allowed locales',
              )
            : undefined
          const consentAllowedUses = currentRights
            ? stringArray(
                currentRights.consentAllowedUsesJson,
                'consent allowed uses',
              )
            : []
          const consentAllowedLocales = currentRights
            ? optionalStringArray(
                currentRights.consentAllowedLocalesJson,
                'consent allowed locales',
              )
            : undefined
          if (
            !currentRights ||
            currentRights.status !== 'approved' ||
            !rightsAllowedUses.includes('transcription') ||
            rightsProhibitedUses.includes('transcription') ||
            !rightsAllowedWorkspaces.includes(run.workspaceId) ||
            (rightsAllowedLocales !== undefined &&
              !rightsAllowedLocales.includes(context.language)) ||
            (currentRights.expiresAt &&
              currentRights.expiresAt <= now) ||
            (
              currentRights.consentStatus !== 'not-required' &&
              (
                currentRights.consentStatus !== 'approved' ||
                !consentAllowedUses.includes('transcription') ||
                (consentAllowedLocales !== undefined &&
                  !consentAllowedLocales.includes(context.language))
              )
            ) ||
            (currentRights.consentExpiresAt &&
              currentRights.consentExpiresAt <= now)
          ) {
            throw new DomainError(
              'ASSET_RIGHTS_BLOCKED',
              'Diarization source rights are not currently usable',
            )
          }
          await transaction.v2SpeakerDiarizationRun.create({
            data: runData(run),
          })
          await transaction.v2SpeakerDiarizationSegment.createMany({
            data: run.segments.map((segment) =>
              segmentData(run, segment)),
          })
          return 'created' as const
        },
        {
          isolationLevel:
            Prisma.TransactionIsolationLevel.Serializable,
        },
      )
      if (outcome === 'lease-lost') return null
      const row = await readRun(this.prisma, {
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        runId: run.id,
      }) ?? await readRun(this.prisma, {
        workspaceId: run.workspaceId,
        workflowId: run.workflowId,
        idempotencyKey: run.idempotencyKey,
      })
      if (!row) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Diarization run was not readable after persistence',
        )
      }
      return Object.freeze({
        run: hydrateRun(row),
        replayed: outcome === 'replayed',
      })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && attempt < 3) {
        return this.persistWithLease(input, attempt + 1)
      }
      if (
        isPrismaCode(error, 'P2002') ||
        isPrismaCode(error, 'P2034')
      ) {
        const replay = await this.findReplay({
          workspaceId: run.workspaceId,
          workflowId: run.workflowId,
          idempotencyKey: run.idempotencyKey,
        })
        if (
          replay &&
          replay.requestFingerprint === run.requestFingerprint
        ) {
          return Object.freeze({ run: replay, replayed: true })
        }
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Diarization persistence conflicted with another transaction',
        )
      }
      throw error
    }
  }
}
