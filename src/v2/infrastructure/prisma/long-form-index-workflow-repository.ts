import {
  Prisma,
  type PrismaClient,
  type V2LongFormIndexStageCheckpoint,
  type V2LongFormIndexWorkflow,
} from '../../../../generated/prisma-v2/index.js'

import type {
  LongFormIndexWorkflowRepository,
  LongFormIndexWorkflowSourceContext,
  PersistedLongFormIndexWorkflow,
} from '../../application/ports/long-form-index-workflow-repository.ts'
import {
  calculateCanonicalHash,
  stableSerialize,
} from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  hydrateLongFormIndexWorkflow,
  type LongFormIndexStageCheckpoint,
  type LongFormIndexWorkflow,
} from '../../domain/long-form-index-workflow.ts'
import {
  assertMediaArtifactManifest,
  type MediaArtifactManifest,
} from '../../domain/media-artifact.ts'
import { createMediaTranscript } from '../../domain/media-transcript.ts'
import type { MediaTranscript } from '../../domain/media-transcript.ts'
import {
  assertPublicOperation,
  type PublicOperation,
} from '../../domain/public-operation.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { PrismaPublicOperationRepository } from './public-operation-repository.ts'

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

function stringArray(value: string, field: string): string[] {
  const parsed = parseJson(value, field)
  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => typeof item !== 'string')
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ${field} is invalid`,
    )
  }
  return parsed
}

function optionalStringArray(
  value: string | null,
  field: string,
): string[] | undefined {
  return value === null ? undefined : stringArray(value, field)
}

function parseManifest(
  manifestJson: string,
  expectedHash: string,
): MediaArtifactManifest {
  const value = parseJson(manifestJson, 'long-form source manifest')
  assertMediaArtifactManifest(value as MediaArtifactManifest)
  const manifest = value as MediaArtifactManifest
  if (
    manifest.manifestHash !== expectedHash ||
    stableSerialize(manifest) !== manifestJson
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored long-form source manifest failed integrity validation',
    )
  }
  return manifest
}

function hydrateTranscript(row: {
  transcriptJson: string
  transcriptHash: string
}) {
  const value = parseJson(
    row.transcriptJson,
    'long-form source transcript',
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
      'Stored long-form source transcript failed integrity validation',
    )
  }
  return transcript
}

function assertTranscriptRights(
  rights: Readonly<{
    status: string
    allowedUsesJson: string
    prohibitedUsesJson: string
    allowedWorkspaceIdsJson: string
    allowedLocalesJson: string | null
    expiresAt: Date | null
    consentStatus: string
    consentAllowedUsesJson: string
    consentAllowedLocalesJson: string | null
    consentExpiresAt: Date | null
  }> | null | undefined,
  workspaceId: string,
  language: string,
  now: Date,
): void {
  const allowedUses = rights
    ? stringArray(rights.allowedUsesJson, 'rights allowed uses')
    : []
  const prohibitedUses = rights
    ? stringArray(
        rights.prohibitedUsesJson,
        'rights prohibited uses',
      )
    : []
  const allowedWorkspaces = rights
    ? stringArray(
        rights.allowedWorkspaceIdsJson,
        'rights allowed workspaces',
      )
    : []
  const allowedLocales = rights
    ? optionalStringArray(
        rights.allowedLocalesJson,
        'rights allowed locales',
      )
    : undefined
  const consentAllowedUses = rights
    ? stringArray(
        rights.consentAllowedUsesJson,
        'consent allowed uses',
      )
    : []
  const consentAllowedLocales = rights
    ? optionalStringArray(
        rights.consentAllowedLocalesJson,
        'consent allowed locales',
      )
    : undefined
  if (
    !rights ||
    rights.status !== 'approved' ||
    !allowedUses.includes('transcription') ||
    prohibitedUses.includes('transcription') ||
    !allowedWorkspaces.includes(workspaceId) ||
    (allowedLocales !== undefined &&
      !allowedLocales.includes(language)) ||
    (rights.expiresAt && rights.expiresAt <= now) ||
    (
      rights.consentStatus !== 'not-required' &&
      (
        rights.consentStatus !== 'approved' ||
        !consentAllowedUses.includes('transcription') ||
        (consentAllowedLocales !== undefined &&
          !consentAllowedLocales.includes(language))
      )
    ) ||
    (rights.consentExpiresAt &&
      rights.consentExpiresAt <= now)
  ) {
    throw new DomainError(
      'ASSET_RIGHTS_BLOCKED',
      'Long-form source rights do not allow transcription',
    )
  }
}

function durationMs(manifest: MediaArtifactManifest): number {
  const value = manifest.probe?.duration
  const duration = Number.isFinite(value)
    ? Math.round(Number(value) * 1_000)
    : 0
  if (
    !Number.isSafeInteger(duration) ||
    duration < 1_000 ||
    duration > 43_200_000
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'Long-form source manifest requires a supported duration',
    )
  }
  return duration
}

function probeOutputHash(manifest: MediaArtifactManifest): string {
  if (!manifest.probe) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'Long-form source manifest requires probe metadata',
    )
  }
  return calculateCanonicalHash({
    schemaVersion: 'long-form-probe-output/v1',
    artifactSha256: manifest.artifact.sha256,
    probe: manifest.probe,
  })
}

function iso(value: Date | null): string | undefined {
  return value?.toISOString()
}

function hydrateWorkflow(
  row: WorkflowWithStages,
): Readonly<LongFormIndexWorkflow> {
  const parsed = parseJson(
    row.workflowJson,
    `long-form workflow ${row.id}`,
  )
  const workflow = hydrateLongFormIndexWorkflow(parsed)
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
      `Stored long-form workflow ${row.id} failed integrity validation`,
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
        `Stored long-form stage ${stage.stage} failed integrity validation`,
      )
    }
  }
  return workflow
}

function workflowData(input: {
  workflow: Readonly<LongFormIndexWorkflow>
  operationId: string
  requestFingerprint: string
  idempotencyKey: string
}) {
  const { workflow } = input
  return {
    id: workflow.id,
    workspaceId: workflow.workspaceId,
    projectId: workflow.projectId,
    operationId: input.operationId,
    sourceArtifactId: workflow.sourceArtifactId,
    sourceArtifactSha256: workflow.sourceArtifactSha256,
    sourceManifestId: workflow.sourceManifestId,
    sourceManifestHash: workflow.sourceManifestHash,
    sourceTranscriptId: workflow.sourceTranscriptId,
    sourceTranscriptHash: workflow.sourceTranscriptHash,
    durationMs: workflow.durationMs,
    schemaVersion: workflow.schemaVersion,
    policyVersion: workflow.policyVersion,
    status: workflow.status,
    budgetCurrency: workflow.budget.currency,
    maximumCostMinorUnits:
      workflow.budget.maximumCostMinorUnits,
    maximumElapsedMs: workflow.budget.maximumElapsedMs,
    maximumConcurrency: workflow.budget.maximumConcurrency,
    completedStageCount: workflow.summary.completedStageCount,
    searchableStageCount: workflow.summary.searchableStageCount,
    resultCount: workflow.summary.resultCount,
    costMinorUnits: workflow.summary.costMinorUnits,
    elapsedMs: workflow.summary.elapsedMs,
    nextStage: workflow.summary.nextStage ?? null,
    duplicateSegments: workflow.summary.duplicateSegments,
    resumable: workflow.summary.resumable,
    workflowJson: stableSerialize(workflow),
    runHash: workflow.runHash,
    requestFingerprint: input.requestFingerprint,
    idempotencyKey: input.idempotencyKey,
    createdByClientId: workflow.createdByClientId,
    createdAt: new Date(workflow.createdAt),
    updatedAt: new Date(workflow.updatedAt),
  }
}

function checkpointId(
  workflowId: string,
  stage: Readonly<LongFormIndexStageCheckpoint>,
): string {
  return `long-form-stage-${calculateCanonicalHash({
    workflowId,
    stage: stage.stage,
  }).slice(0, 48)}`
}

function stageData(
  workflow: Readonly<LongFormIndexWorkflow>,
  stage: Readonly<LongFormIndexStageCheckpoint>,
) {
  return {
    id: checkpointId(workflow.id, stage),
    workspaceId: workflow.workspaceId,
    projectId: workflow.projectId,
    workflowId: workflow.id,
    stage: stage.stage,
    sequence: stage.sequence,
    prerequisitesJson: stableSerialize(stage.prerequisites),
    execution: stage.execution,
    status: stage.status,
    versionJson: stableSerialize(stage.version),
    budgetJson: stableSerialize(stage.budget),
    concurrency: stage.concurrency,
    inputHash: stage.inputHash,
    idempotencyKey: stage.idempotencyKey,
    attempt: stage.attempt,
    outputHash: stage.outputHash,
    outputEntityType: stage.outputReference?.type,
    outputEntityId: stage.outputReference?.id,
    resultCount: stage.resultCount,
    searchable: stage.searchable,
    costMinorUnits: stage.costMinorUnits,
    elapsedMs: stage.elapsedMs,
    startedAt: stage.startedAt
      ? new Date(stage.startedAt)
      : undefined,
    completedAt: stage.completedAt
      ? new Date(stage.completedAt)
      : undefined,
    errorCode: stage.error?.code,
    errorMessage: stage.error?.message,
    errorRetryable: stage.error?.retryable,
    stageJson: stableSerialize(stage),
    stageHash: stage.stageHash,
  }
}

function workflowBinding(
  workflow: Readonly<LongFormIndexWorkflow>,
) {
  return {
    schemaVersion: workflow.schemaVersion,
    policyVersion: workflow.policyVersion,
    id: workflow.id,
    workspaceId: workflow.workspaceId,
    projectId: workflow.projectId,
    sourceArtifactId: workflow.sourceArtifactId,
    sourceArtifactSha256: workflow.sourceArtifactSha256,
    sourceManifestId: workflow.sourceManifestId,
    sourceManifestHash: workflow.sourceManifestHash,
    sourceTranscriptId: workflow.sourceTranscriptId,
    sourceTranscriptHash: workflow.sourceTranscriptHash,
    durationMs: workflow.durationMs,
    budget: workflow.budget,
    createdByClientId: workflow.createdByClientId,
    createdAt: workflow.createdAt,
    stageDefinitions: workflow.stages.map((stage) => ({
      stage: stage.stage,
      sequence: stage.sequence,
      prerequisites: stage.prerequisites,
      execution: stage.execution,
      version: stage.version,
      budget: stage.budget,
      concurrency: stage.concurrency,
    })),
  }
}

function workflowMutableData(
  workflow: Readonly<LongFormIndexWorkflow>,
) {
  return {
    status: workflow.status,
    completedStageCount: workflow.summary.completedStageCount,
    searchableStageCount: workflow.summary.searchableStageCount,
    resultCount: workflow.summary.resultCount,
    costMinorUnits: workflow.summary.costMinorUnits,
    elapsedMs: workflow.summary.elapsedMs,
    nextStage: workflow.summary.nextStage ?? null,
    duplicateSegments: workflow.summary.duplicateSegments,
    resumable: workflow.summary.resumable,
    workflowJson: stableSerialize(workflow),
    runHash: workflow.runHash,
    updatedAt: new Date(workflow.updatedAt),
  }
}

function stageMutableData(
  stage: Readonly<LongFormIndexStageCheckpoint>,
) {
  return {
    status: stage.status,
    inputHash: stage.inputHash,
    idempotencyKey: stage.idempotencyKey,
    attempt: stage.attempt,
    outputHash: stage.outputHash ?? null,
    outputEntityType: stage.outputReference?.type ?? null,
    outputEntityId: stage.outputReference?.id ?? null,
    resultCount: stage.resultCount,
    searchable: stage.searchable,
    costMinorUnits: stage.costMinorUnits,
    elapsedMs: stage.elapsedMs,
    startedAt: stage.startedAt
      ? new Date(stage.startedAt)
      : null,
    completedAt: stage.completedAt
      ? new Date(stage.completedAt)
      : null,
    errorCode: stage.error?.code ?? null,
    errorMessage: stage.error?.message ?? null,
    errorRetryable: stage.error?.retryable ?? null,
    stageJson: stableSerialize(stage),
    stageHash: stage.stageHash,
  }
}

function operationData(operation: Readonly<PublicOperation>, input: {
  requestFingerprint: string
  idempotencyKey: string
  traceId?: string
}) {
  assertPublicOperation(operation)
  return {
    id: operation.id,
    workspaceId: operation.workspaceId,
    projectId: operation.projectId,
    clientId: operation.clientId,
    type: operation.type,
    status: operation.status,
    phase: operation.phase,
    targetType: operation.target.type,
    targetId: operation.target.id,
    progressCompleted: operation.progress?.completed,
    progressTotal: operation.progress?.total,
    progressUnit: operation.progress?.unit,
    cancelable: operation.cancelable,
    retryable: operation.retryable,
    attempt: operation.attempt,
    maxAttempts: operation.maxAttempts,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint: input.requestFingerprint,
    traceId: input.traceId,
    createdAt: new Date(operation.createdAt),
    updatedAt: new Date(operation.updatedAt),
  }
}

async function readRow(
  client: PrismaClient | Prisma.TransactionClient,
  input: {
    workspaceId: string
    projectId: string
    workflowId: string
  },
): Promise<WorkflowWithStages | null> {
  return client.v2LongFormIndexWorkflow.findFirst({
    where: {
      id: input.workflowId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
    },
    include: { stages: { orderBy: { sequence: 'asc' } } },
  })
}

async function readSourceContext(
  client: PrismaClient | Prisma.TransactionClient,
  input: {
    workspaceId: string
    projectId: string
    sourceArtifactId: string
    sourceManifestId: string
    sourceTranscriptId?: string
  },
): Promise<Readonly<LongFormIndexWorkflowSourceContext> | null> {
  const artifact = await client.v2MediaArtifact.findFirst({
    where: {
      id: input.sourceArtifactId,
      workspaceId: input.workspaceId,
      mediaType: 'video',
      status: 'available',
      projectAssets: {
        some: {
          projectId: input.projectId,
          workspaceId: input.workspaceId,
        },
      },
    },
    include: {
      manifests: {
        where: { id: input.sourceManifestId },
        take: 1,
      },
      currentRightsSnapshot: true,
      transcriptSources: input.sourceTranscriptId
        ? {
            where: {
              id: input.sourceTranscriptId,
              projectId: input.projectId,
              sourceManifestId: input.sourceManifestId,
            },
            take: 1,
          }
        : false,
    },
  })
  const manifestRow = artifact?.manifests[0]
  const rights = artifact?.currentRightsSnapshot
  if (!artifact || !manifestRow || !rights) return null
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
      'Long-form manifest does not identify its stored video artifact',
    )
  }
  const transcriptRow = input.sourceTranscriptId
    ? artifact.transcriptSources[0]
    : undefined
  if (input.sourceTranscriptId && !transcriptRow) return null
  const transcript = transcriptRow
    ? hydrateTranscript(transcriptRow)
    : undefined
  return Object.freeze({
    sourceArtifactId: artifact.id,
    sourceArtifactSha256: artifact.sha256,
    sourceManifestId: manifestRow.id,
    sourceManifestHash: manifestRow.manifestHash,
    durationMs: durationMs(manifest),
    probeOutputHash: probeOutputHash(manifest),
    rightsSnapshotId: rights.id,
    rightsStatus: rights.status,
    consentStatus: rights.consentStatus,
    ...(rights.expiresAt
      ? { rightsExpiresAt: rights.expiresAt.toISOString() }
      : {}),
    ...(rights.consentExpiresAt
      ? {
          consentExpiresAt:
            rights.consentExpiresAt.toISOString(),
        }
      : {}),
    ...(transcriptRow && transcript
      ? {
          sourceTranscript: Object.freeze({
            id: transcriptRow.id,
            transcriptHash: transcript.transcriptHash,
            resultCount: Math.max(
              transcript.segments.length,
              transcript.words.length,
              1,
            ),
          }),
        }
      : {}),
  })
}

export class PrismaLongFormIndexWorkflowRepository
implements LongFormIndexWorkflowRepository {
  private readonly operations: PrismaPublicOperationRepository

  constructor(
    private readonly prisma: PrismaClient = getV2PostgresClient(),
  ) {
    this.operations = new PrismaPublicOperationRepository(prisma)
  }

  readSourceContext(input: {
    workspaceId: string
    projectId: string
    sourceArtifactId: string
    sourceManifestId: string
    sourceTranscriptId?: string
  }) {
    return readSourceContext(this.prisma, input)
  }

  async findReplay(input: {
    workspaceId: string
    projectId: string
    createdByClientId: string
    idempotencyKey: string
  }) {
    const row = await this.prisma.v2LongFormIndexWorkflow.findUnique({
      where: {
        workspaceId_projectId_createdByClientId_idempotencyKey:
          input,
      },
      include: { stages: { orderBy: { sequence: 'asc' } } },
    })
    return row ? this.present(row) : null
  }

  private async present(
    row: WorkflowWithStages,
  ): Promise<Readonly<PersistedLongFormIndexWorkflow>> {
    const operation = await this.operations.findById(
      row.workspaceId,
      row.operationId,
    )
    if (
      !operation ||
      operation.context.kind !== 'long-form-index' ||
      operation.context.workflowId !== row.id
    ) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `Long-form workflow ${row.id} operation is invalid`,
      )
    }
    return Object.freeze({
      workflow: hydrateWorkflow(row),
      operation: operation.operation,
      requestFingerprint: row.requestFingerprint,
      idempotencyKey: row.idempotencyKey,
    })
  }

  async create(
    input: {
      workflow: Readonly<LongFormIndexWorkflow>
      operation: Readonly<PublicOperation>
      requestFingerprint: string
      idempotencyKey: string
      expectedRightsSnapshotId: string
    },
    attempt = 1,
  ): ReturnType<LongFormIndexWorkflowRepository['create']> {
    if (
      input.operation.type !== 'long-form-index' ||
      input.operation.status !== 'queued' ||
      input.operation.target.type !== 'media-artifact' ||
      input.workflow.workspaceId !== input.operation.workspaceId ||
      input.workflow.projectId !== input.operation.projectId ||
      input.workflow.createdByClientId !==
        input.operation.clientId ||
      input.workflow.sourceArtifactId !==
        input.operation.target.id ||
      input.workflow.sourceManifestId !==
        input.operation.target.manifestId
    ) {
      throw new DomainError(
        'INVALID_PUBLIC_OPERATION',
        'Long-form workflow operation binding is invalid',
      )
    }
    try {
      await this.prisma.$transaction(async (transaction) => {
        const replay =
          await transaction.v2LongFormIndexWorkflow.findUnique({
            where: {
              workspaceId_projectId_createdByClientId_idempotencyKey:
                {
                  workspaceId: input.workflow.workspaceId,
                  projectId: input.workflow.projectId,
                  createdByClientId:
                    input.workflow.createdByClientId,
                  idempotencyKey: input.idempotencyKey,
                },
            },
            select: { requestFingerprint: true },
          })
        if (replay) {
          if (
            replay.requestFingerprint !== input.requestFingerprint
          ) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different long-form workflow request',
            )
          }
          return
        }
        const context = await readSourceContext(transaction, {
          workspaceId: input.workflow.workspaceId,
          projectId: input.workflow.projectId,
          sourceArtifactId: input.workflow.sourceArtifactId,
          sourceManifestId: input.workflow.sourceManifestId,
          ...(input.workflow.sourceTranscriptId
            ? {
                sourceTranscriptId:
                  input.workflow.sourceTranscriptId,
              }
            : {}),
        })
        const actor = await transaction.v2ApiClient.findFirst({
          where: {
            id: input.workflow.createdByClientId,
            workspaceId: input.workflow.workspaceId,
            status: 'active',
          },
          select: { id: true },
        })
        if (
          !context ||
          !actor ||
          context.sourceArtifactSha256 !==
            input.workflow.sourceArtifactSha256 ||
          context.sourceManifestHash !==
            input.workflow.sourceManifestHash ||
          context.rightsSnapshotId !==
            input.expectedRightsSnapshotId ||
          (input.workflow.sourceTranscriptId &&
            (
              context.sourceTranscript?.id !==
                input.workflow.sourceTranscriptId ||
              context.sourceTranscript.transcriptHash !==
                input.workflow.sourceTranscriptHash
            ))
        ) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Long-form source, rights, transcript or actor changed before commit',
          )
        }
        await transaction.v2PublicOperation.create({
          data: operationData(input.operation, input),
        })
        await transaction.v2LongFormIndexWorkflow.create({
          data: workflowData({
            workflow: input.workflow,
            operationId: input.operation.id,
            requestFingerprint: input.requestFingerprint,
            idempotencyKey: input.idempotencyKey,
          }),
        })
        await transaction.v2LongFormIndexStageCheckpoint.createMany({
          data: input.workflow.stages.map((stage) =>
            stageData(input.workflow, stage)),
        })
      }, {
        isolationLevel:
          Prisma.TransactionIsolationLevel.Serializable,
      })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && attempt < 3) {
        return this.create(input, attempt + 1)
      }
      if (
        isPrismaCode(error, 'P2002') ||
        isPrismaCode(error, 'P2034')
      ) {
        const replay = await this.findReplay({
          workspaceId: input.workflow.workspaceId,
          projectId: input.workflow.projectId,
          createdByClientId: input.workflow.createdByClientId,
          idempotencyKey: input.idempotencyKey,
        })
        if (replay) {
          if (
            replay.requestFingerprint !== input.requestFingerprint
          ) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different long-form workflow request',
            )
          }
          return Object.freeze({ record: replay, replayed: true })
        }
        if (isPrismaCode(error, 'P2034') && attempt < 3) {
          return this.create(input, attempt + 1)
        }
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Long-form workflow creation conflicted with another transaction',
        )
      }
      throw error
    }
    const record = await this.read({
      workspaceId: input.workflow.workspaceId,
      projectId: input.workflow.projectId,
      workflowId: input.workflow.id,
    })
    if (!record) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Long-form workflow was not readable after commit',
      )
    }
    return Object.freeze({ record, replayed: false })
  }

  async read(input: {
    workspaceId: string
    projectId: string
    workflowId: string
  }) {
    const row = await readRow(this.prisma, input)
    return row ? this.present(row) : null
  }

  async list(input: {
    workspaceId: string
    projectId: string
    status?: LongFormIndexWorkflow['status']
    sourceArtifactId?: string
    limit: number
    cursor?: string
  }) {
    const cursor = input.cursor
      ? await this.prisma.v2LongFormIndexWorkflow.findFirst({
          where: {
            id: input.cursor,
            workspaceId: input.workspaceId,
            projectId: input.projectId,
          },
          select: { id: true, createdAt: true },
        })
      : null
    if (input.cursor && !cursor) {
      throw new DomainError(
        'INVALID_CURSOR',
        'Long-form workflow cursor is invalid',
      )
    }
    const rows =
      await this.prisma.v2LongFormIndexWorkflow.findMany({
        where: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          ...(input.status ? { status: input.status } : {}),
          ...(input.sourceArtifactId
            ? { sourceArtifactId: input.sourceArtifactId }
            : {}),
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  {
                    createdAt: cursor.createdAt,
                    id: { lt: cursor.id },
                  },
                ],
              }
            : {}),
        },
        include: {
          stages: { orderBy: { sequence: 'asc' } },
        },
        orderBy: [
          { createdAt: 'desc' },
          { id: 'desc' },
        ],
        take: input.limit + 1,
      })
    const hasMore = rows.length > input.limit
    const pageRows = hasMore
      ? rows.slice(0, input.limit)
      : rows
    const records = await Promise.all(
      pageRows.map((row) => this.present(row)),
    )
    return Object.freeze({
      workflows: Object.freeze(records),
      ...(hasMore
        ? { nextCursor: pageRows.at(-1)!.id }
        : {}),
    })
  }

  async readTranscriptStageContext(input: {
    workspaceId: string
    projectId: string
    workflowId: string
  }) {
    const row = await readRow(this.prisma, input)
    if (!row) return null
    const workflow = hydrateWorkflow(row)
    const stage = workflow.stages.find(
      (candidate) => candidate.stage === 'transcript',
    )
    if (
      !stage ||
      !['running', 'succeeded'].includes(stage.status)
    ) {
      return null
    }
    const [artifact, manifest, project] = await Promise.all([
      this.prisma.v2MediaArtifact.findFirst({
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
        include: { currentRightsSnapshot: true },
      }),
      this.prisma.v2MediaArtifactManifest.findFirst({
        where: {
          id: workflow.sourceManifestId,
          workspaceId: workflow.workspaceId,
          artifactId: workflow.sourceArtifactId,
          manifestHash: workflow.sourceManifestHash,
        },
        select: { id: true },
      }),
      this.prisma.v2Project.findFirst({
        where: {
          id: workflow.projectId,
          workspaceId: workflow.workspaceId,
        },
        select: { locale: true },
      }),
    ])
    if (!artifact || !manifest || !project) return null
    const language = project.locale ?? 'pt-BR'
    assertTranscriptRights(
      artifact.currentRightsSnapshot,
      workflow.workspaceId,
      language,
      new Date(),
    )
    return Object.freeze({
      operationId: row.operationId,
      createdByClientId: workflow.createdByClientId,
      sourceArtifactId: workflow.sourceArtifactId,
      sourceArtifactKey: artifact.artifactKey,
      sourceArtifactByteSize: artifact.byteSize,
      sourceArtifactSha256: workflow.sourceArtifactSha256,
      sourceManifestId: workflow.sourceManifestId,
      sourceManifestHash: workflow.sourceManifestHash,
      durationMs: workflow.durationMs,
      language,
      stageStatus:
        stage.status === 'succeeded' ? 'succeeded' : 'running',
      stageInputHash: stage.inputHash,
      stageIdempotencyKey: stage.idempotencyKey,
    })
  }

  async findTranscriptStageReplay(input: {
    workspaceId: string
    projectId: string
    sourceArtifactId: string
    sourceManifestId: string
    provider: string
    model: string
    providerVersion: string
  }) {
    const row = await this.prisma.v2MediaTranscript.findFirst({
      where: input,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        transcriptHash: true,
        transcriptJson: true,
      },
    })
    return row
      ? Object.freeze({
          id: row.id,
          transcript: hydrateTranscript(row),
        })
      : null
  }

  async persistTranscriptWithLease(input: {
    workspaceId: string
    projectId: string
    workflowId: string
    operationId: string
    expectedStageInputHash: string
    expectedStageIdempotencyKey: string
    leaseOwner: string
    operationAttempt: number
    transcriptId: string
    transcript: Readonly<MediaTranscript>
    providerVersion: string
    sourceArtifactId: string
    sourceArtifactSha256: string
    sourceManifestId: string
    sourceManifestHash: string
    now: string
  }, attempt = 1): Promise<Readonly<{
    id: string
    transcript: Readonly<MediaTranscript>
    replayed: boolean
  }> | null> {
    const transcript = createMediaTranscript(input.transcript)
    const now = new Date(input.now)
    if (
      Number.isNaN(now.getTime()) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/.test(
        input.transcriptId,
      ) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(
        input.providerVersion,
      )
    ) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Transcript persistence input is invalid',
      )
    }
    try {
      const outcome = await this.prisma.$transaction(
        async (transaction) => {
          const replay =
            await transaction.v2MediaTranscript.findFirst({
              where: {
                workspaceId: input.workspaceId,
                projectId: input.projectId,
                sourceArtifactId: input.sourceArtifactId,
                sourceManifestId: input.sourceManifestId,
                provider: transcript.provider,
                model: transcript.model,
                providerVersion: input.providerVersion,
                transcriptHash: transcript.transcriptHash,
              },
              select: {
                id: true,
                transcriptHash: true,
                transcriptJson: true,
              },
            })
          const [stored, lease, artifact, manifest, project] =
            await Promise.all([
              readRow(transaction, input),
              transaction.v2PublicOperation.findFirst({
                where: {
                  id: input.operationId,
                  workspaceId: input.workspaceId,
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
                  id: input.sourceArtifactId,
                  workspaceId: input.workspaceId,
                  sha256: input.sourceArtifactSha256,
                  mediaType: 'video',
                  status: 'available',
                  projectAssets: {
                    some: {
                      projectId: input.projectId,
                      workspaceId: input.workspaceId,
                    },
                  },
                },
                include: { currentRightsSnapshot: true },
              }),
              transaction.v2MediaArtifactManifest.findFirst({
                where: {
                  id: input.sourceManifestId,
                  workspaceId: input.workspaceId,
                  artifactId: input.sourceArtifactId,
                  manifestHash: input.sourceManifestHash,
                },
                select: { id: true },
              }),
              transaction.v2Project.findFirst({
                where: {
                  id: input.projectId,
                  workspaceId: input.workspaceId,
                },
                select: { locale: true },
              }),
            ])
          if (
            !stored ||
            !lease ||
            !artifact ||
            !manifest ||
            !project ||
            stored.operationId !== input.operationId
          ) {
            return null
          }
          const workflow = hydrateWorkflow(stored)
          const stage = workflow.stages.find(
            (candidate) => candidate.stage === 'transcript',
          )
          if (
            workflow.sourceArtifactId !== input.sourceArtifactId ||
            workflow.sourceArtifactSha256 !==
              input.sourceArtifactSha256 ||
            workflow.sourceManifestId !== input.sourceManifestId ||
            workflow.sourceManifestHash !==
              input.sourceManifestHash ||
            stage?.status !== 'running' ||
            stage.inputHash !== input.expectedStageInputHash ||
            stage.idempotencyKey !==
              input.expectedStageIdempotencyKey
          ) {
            return null
          }
          assertTranscriptRights(
            artifact.currentRightsSnapshot,
            input.workspaceId,
            project.locale ?? 'pt-BR',
            now,
          )
          if (replay) {
            const hydrated = hydrateTranscript(replay)
            return Object.freeze({
              id: replay.id,
              transcript: hydrated,
              replayed: true,
            })
          }
          await transaction.v2MediaTranscript.create({
            data: {
              id: input.transcriptId,
              workspaceId: input.workspaceId,
              projectId: input.projectId,
              sourceArtifactId: input.sourceArtifactId,
              sourceManifestId: input.sourceManifestId,
              schemaVersion: transcript.schemaVersion,
              language: transcript.language,
              provider: transcript.provider,
              model: transcript.model,
              providerVersion: input.providerVersion,
              transcriptHash: transcript.transcriptHash,
              transcriptJson: stableSerialize(transcript),
              createdAt: now,
            },
          })
          return Object.freeze({
            id: input.transcriptId,
            transcript,
            replayed: false,
          })
        },
        {
          isolationLevel:
            Prisma.TransactionIsolationLevel.Serializable,
        },
      )
      return outcome
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && attempt < 3) {
        return this.persistTranscriptWithLease(input, attempt + 1)
      }
      if (isPrismaCode(error, 'P2002')) {
        const replay = await this.findTranscriptStageReplay({
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          sourceArtifactId: input.sourceArtifactId,
          sourceManifestId: input.sourceManifestId,
          provider: transcript.provider,
          model: transcript.model,
          providerVersion: input.providerVersion,
        })
        if (
          replay?.transcript.transcriptHash ===
          transcript.transcriptHash
        ) {
          return Object.freeze({ ...replay, replayed: true })
        }
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Transcript identity collided with different content',
        )
      }
      if (isPrismaCode(error, 'P2034')) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Transcript persistence conflicted repeatedly',
        )
      }
      throw error
    }
  }

  async replaceWithLease(input: {
    workspaceId: string
    projectId: string
    workflowId: string
    operationId: string
    expectedRunHash: string
    nextWorkflow: Readonly<LongFormIndexWorkflow>
    leaseOwner: string
    operationAttempt: number
    now: string
  }, attempt = 1): Promise<Readonly<LongFormIndexWorkflow> | null> {
    const next = hydrateLongFormIndexWorkflow(input.nextWorkflow)
    const now = new Date(input.now)
    if (
      Number.isNaN(now.getTime()) ||
      next.id !== input.workflowId ||
      next.workspaceId !== input.workspaceId ||
      next.projectId !== input.projectId
    ) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Long-form leased transition input is invalid',
      )
    }
    try {
      const replaced = await this.prisma.$transaction(
        async (transaction) => {
          const [stored, lease] = await Promise.all([
            readRow(transaction, input),
            transaction.v2PublicOperation.findFirst({
              where: {
                id: input.operationId,
                workspaceId: input.workspaceId,
                type: 'long-form-index',
                status: 'running',
                leaseOwner: input.leaseOwner,
                attempt: input.operationAttempt,
                leaseExpiresAt: { gt: now },
              },
              select: { id: true },
            }),
          ])
          if (!stored || !lease ||
            stored.operationId !== input.operationId) {
            return false
          }
          const current = hydrateWorkflow(stored)
          if (current.runHash !== input.expectedRunHash) {
            return false
          }
          if (
            stableSerialize(workflowBinding(current)) !==
              stableSerialize(workflowBinding(next)) ||
            Date.parse(next.updatedAt) <
              Date.parse(current.updatedAt)
          ) {
            throw new DomainError(
              'PERSISTENCE_CONFLICT',
              'Long-form transition changed immutable workflow identity',
            )
          }
          const updated =
            await transaction.v2LongFormIndexWorkflow.updateMany({
              where: {
                id: input.workflowId,
                workspaceId: input.workspaceId,
                projectId: input.projectId,
                runHash: input.expectedRunHash,
                operationId: input.operationId,
              },
              data: workflowMutableData(next),
            })
          if (updated.count !== 1) return false
          for (const [index, stage] of next.stages.entries()) {
            const previous = current.stages[index]!
            if (previous.stageHash === stage.stageHash) continue
            const changed =
              await transaction.v2LongFormIndexStageCheckpoint
                .updateMany({
                  where: {
                    workflowId: input.workflowId,
                    stage: stage.stage,
                    stageHash: previous.stageHash,
                  },
                  data: stageMutableData(stage),
                })
            if (changed.count !== 1) {
              throw new DomainError(
                'PERSISTENCE_CONFLICT',
                `Long-form stage ${stage.stage} changed concurrently`,
              )
            }
          }
          return true
        },
        {
          isolationLevel:
            Prisma.TransactionIsolationLevel.Serializable,
        },
      )
      if (!replaced) return null
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && attempt < 3) {
        return this.replaceWithLease(input, attempt + 1)
      }
      if (isPrismaCode(error, 'P2034')) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Long-form stage transition conflicted repeatedly',
        )
      }
      throw error
    }
    const row = await readRow(this.prisma, input)
    return row ? hydrateWorkflow(row) : null
  }
}
