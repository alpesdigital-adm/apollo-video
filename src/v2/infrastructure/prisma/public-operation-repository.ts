import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type {
  ClaimedPublicOperationRecord,
  PublicOperationLeaseCommand,
  PublicOperationListQuery,
  PublicOperationPersistenceResult,
  PublicOperationRecord,
  PublicOperationRepository,
  PublicOperationContext,
} from '../../application/ports/public-operation-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  advancePublicOperationPhase,
  assertPublicOperation,
  cancelPublicOperation,
  isTerminalPublicOperation,
  rehydratePublicOperation,
  retryPublicOperation,
  retryOrFailPublicOperation,
  requiresArtifactRenderCheckpoint,
  startPublicOperationAttempt,
  succeedPublicOperation,
  type PublicOperation,
  type PublicOperationError,
  type PublicOperationResult,
  type PublicOperationRunningPhase,
} from '../../domain/public-operation.ts'

type StoredOperation = Prisma.V2PublicOperationGetPayload<{
  include: {
    artifactRender: {
      include: {
        manifest: { select: { artifactId: true } }
        artifact: { select: { sha256: true; byteSize: true; container: true } }
        authorization: {
          select: {
            artifactId: true
            manifestId: true
            inputHash: true
            clientId: true
            status: true
          }
        }
      }
    }
    mediaIngest: true
  }
}>

const OPERATION_INCLUDE = {
  artifactRender: {
    include: {
      manifest: { select: { artifactId: true } },
      artifact: { select: { sha256: true, byteSize: true, container: true } },
      authorization: {
        select: {
          artifactId: true,
          manifestId: true,
          inputHash: true,
          clientId: true,
          status: true,
        },
      },
    },
  },
  mediaIngest: true,
} as const

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const OUTPUT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,510}\.mp4$/

function checkpointFields(detail: StoredOperation['artifactRender']) {
  if (!detail) return []
  return [
    detail.outputKey,
    detail.outputSha256,
    detail.outputByteSize,
    detail.outputWidth,
    detail.outputHeight,
    detail.outputFps,
    detail.outputDurationInFrames,
    detail.outputCodec,
    detail.outputContainer,
    detail.outputAttempt,
    detail.outputCommittedAt,
    detail.outputRecordedAt,
  ]
}

function hasCompleteCheckpoint(detail: NonNullable<StoredOperation['artifactRender']>): boolean {
  return checkpointFields(detail).every((value) => value !== null)
}

function parseCommandDate(value: string, field: string): Date {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new DomainError('INVALID_PUBLIC_OPERATION', `${field} must be a valid date`)
  }
  return date
}

function isUniqueConstraintError(error: unknown): error is { code: 'P2002' } {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

function isSerializationConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2034'
}

function parseResult(value: string | null): PublicOperationResult | undefined {
  if (value === null) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.keys(parsed).some((key) => key !== 'resource') ||
      !('resource' in parsed) ||
      typeof parsed.resource !== 'object' ||
      parsed.resource === null ||
      Array.isArray(parsed.resource)
    ) {
      throw new Error('invalid result')
    }
    const resource = parsed.resource as Record<string, unknown>
    if (
      Object.keys(resource).some((key) => !['type', 'id', 'manifestId'].includes(key)) ||
      resource.type !== 'media-artifact' ||
      typeof resource.id !== 'string' ||
      typeof resource.manifestId !== 'string'
    ) {
      throw new Error('invalid result resource')
    }
    return {
      resource: {
        type: 'media-artifact',
        id: resource.id,
        manifestId: resource.manifestId,
      },
    }
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored PublicOperation result is invalid')
  }
}

function hydrateRecord(row: StoredOperation): PublicOperationRecord {
  const renderDetail = row.artifactRender
  const ingestDetail = row.mediaIngest
  const isRender = row.type === 'artifact-render'
  const isIngest = row.type === 'media-ingest'
  if (row.targetType !== 'media-artifact' || (isRender === isIngest)) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored PublicOperation context is invalid',
      { operationId: row.id },
    )
  }
  if (isRender && (
    !renderDetail || ingestDetail || row.targetId !== renderDetail.artifactId ||
    row.workspaceId !== renderDetail.workspaceId ||
    renderDetail.manifest.artifactId !== renderDetail.artifactId ||
    renderDetail.authorization.artifactId !== renderDetail.artifactId ||
    renderDetail.authorization.manifestId !== renderDetail.manifestId ||
    renderDetail.authorization.inputHash !== renderDetail.inputHash ||
    renderDetail.authorization.clientId !== row.clientId ||
    renderDetail.authorization.status !== 'authorized' ||
    !SHA256_PATTERN.test(renderDetail.inputHash)
  )) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored render operation context is invalid', { operationId: row.id })
  }
  if (isIngest && (
    !ingestDetail || renderDetail || row.targetId !== ingestDetail.sourceArtifactId ||
    row.workspaceId !== ingestDetail.workspaceId ||
    !ID_PATTERN.test(ingestDetail.projectId) || !ID_PATTERN.test(ingestDetail.sourceManifestId) ||
    ingestDetail.originalFileName.trim().length < 1
  )) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored ingest operation context is invalid', { operationId: row.id })
  }
  const outputFields = checkpointFields(renderDetail)
  const hasAnyCheckpoint = outputFields.some((value) => value !== null)
  if (
    hasAnyCheckpoint &&
    (!renderDetail || !hasCompleteCheckpoint(renderDetail) ||
      !OUTPUT_KEY_PATTERN.test(renderDetail.outputKey as string) ||
      (renderDetail.outputKey as string).length > 512 ||
      (renderDetail.outputKey as string).includes('//') ||
      !SHA256_PATTERN.test(renderDetail.outputSha256 as string) ||
      (renderDetail.outputByteSize as bigint) <= BigInt(0) ||
      (renderDetail.outputWidth as number) <= 0 ||
      (renderDetail.outputHeight as number) <= 0 ||
      (renderDetail.outputFps as number) <= 0 ||
      (renderDetail.outputDurationInFrames as number) <= 0 ||
      renderDetail.outputCodec !== 'h264' ||
      renderDetail.outputContainer !== 'mp4' ||
      (renderDetail.outputAttempt as number) <= 0 ||
      (renderDetail.outputRecordedAt as Date).getTime() <
        (renderDetail.outputCommittedAt as Date).getTime() ||
      renderDetail.outputSha256 !== renderDetail.artifact.sha256 ||
      renderDetail.outputByteSize !== renderDetail.artifact.byteSize ||
      renderDetail.outputContainer !== renderDetail.artifact.container)
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored render checkpoint is invalid')
  }
  const hasCompleteLease =
    row.leaseOwner !== null && row.leaseExpiresAt !== null && row.heartbeatAt !== null
  if (
    (row.status === 'running' &&
      (!hasCompleteLease ||
        !ID_PATTERN.test(row.leaseOwner as string) ||
        (row.leaseExpiresAt as Date).getTime() <= (row.heartbeatAt as Date).getTime())) ||
    (row.status !== 'running' &&
      (row.leaseOwner !== null || row.leaseExpiresAt !== null || row.heartbeatAt !== null))
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored PublicOperation lease is invalid')
  }
  const progressFields = [row.progressCompleted, row.progressTotal, row.progressUnit]
  const hasProgress = progressFields.some((value) => value !== null)
  if (hasProgress && row.progressCompleted === null) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored PublicOperation progress is invalid')
  }
  const hasAnyError =
    row.errorCode !== null || row.errorMessage !== null || row.errorRetryable !== null
  if (
    hasAnyError &&
    (row.errorCode === null || row.errorMessage === null || row.errorRetryable === null)
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored PublicOperation error is invalid')
  }
  if (
    (row.status === 'retrying' &&
      (row.nextAttemptAt === null ||
        row.nextAttemptAt.getTime() <= row.updatedAt.getTime() ||
        row.deadLetteredAt !== null)) ||
    (row.status === 'failed' &&
      (row.nextAttemptAt !== null ||
        (row.deadLetteredAt !== null &&
          (row.completedAt === null ||
            row.deadLetteredAt.getTime() !== row.completedAt.getTime())))) ||
    (!['retrying', 'failed'].includes(row.status) &&
      (row.nextAttemptAt !== null || row.deadLetteredAt !== null))
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored PublicOperation retry schedule is invalid')
  }

  try {
    const operation = rehydratePublicOperation({
      schemaVersion: 'public-operation/v1',
      id: row.id,
      workspaceId: row.workspaceId,
      clientId: row.clientId,
      type: row.type as PublicOperation['type'],
      status: row.status as PublicOperation['status'],
      phase: row.phase as PublicOperation['phase'],
      ...(hasProgress
        ? {
            progress: {
              completed: row.progressCompleted as number,
              ...(row.progressTotal !== null ? { total: row.progressTotal } : {}),
              ...(row.progressUnit !== null ? { unit: row.progressUnit } : {}),
            },
          }
        : {}),
      cancelable: row.cancelable,
      retryable: row.retryable,
      target: {
        type: 'media-artifact',
        id: isRender ? renderDetail!.artifactId : ingestDetail!.sourceArtifactId,
        manifestId: isRender ? renderDetail!.manifestId : ingestDetail!.sourceManifestId,
      },
      ...(row.resultJson !== null ? { result: parseResult(row.resultJson) } : {}),
      ...(hasAnyError
        ? {
            error: {
              code: row.errorCode as string,
              message: row.errorMessage as string,
              retryable: row.errorRetryable as boolean,
            },
          }
        : {}),
      attempt: row.attempt,
      maxAttempts: row.maxAttempts,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      ...(row.startedAt ? { startedAt: row.startedAt.toISOString() } : {}),
      ...(row.completedAt ? { completedAt: row.completedAt.toISOString() } : {}),
      ...(row.nextAttemptAt ? { nextAttemptAt: row.nextAttemptAt.toISOString() } : {}),
      ...(row.deadLetteredAt ? { deadLetteredAt: row.deadLetteredAt.toISOString() } : {}),
    })
    return Object.freeze({
      operation,
      context: Object.freeze(isRender ? {
        kind: 'artifact-render' as const,
        authorizationId: renderDetail!.authorizationId,
        inputHash: renderDetail!.inputHash,
      } : {
        kind: 'media-ingest' as const,
        uploadId: ingestDetail!.uploadId,
        projectId: ingestDetail!.projectId,
        originalFileName: ingestDetail!.originalFileName,
        sourceArtifactId: ingestDetail!.sourceArtifactId,
        sourceManifestId: ingestDetail!.sourceManifestId,
      }),
    })
  } catch (error) {
    if (error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT') throw error
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored PublicOperation failed integrity validation',
      { operationId: row.id },
    )
  }
}

function hydrateClaim(row: StoredOperation): ClaimedPublicOperationRecord {
  const record = hydrateRecord(row)
  if (
    row.status !== 'running' ||
    row.leaseOwner === null ||
    row.leaseExpiresAt === null ||
    row.heartbeatAt === null
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Claimed PublicOperation lease is missing')
  }
  return Object.freeze({
    ...record,
    lease: Object.freeze({
      owner: row.leaseOwner,
      attempt: row.attempt,
      heartbeatAt: row.heartbeatAt.toISOString(),
      expiresAt: row.leaseExpiresAt.toISOString(),
    }),
  })
}

export class PrismaPublicOperationRepository implements PublicOperationRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient) {
    this.client = client
  }

  async cancel(input: {
    workspaceId: string
    operationId: string
    canceledAt: string
  }): Promise<PublicOperationRecord | null> {
    if (!ID_PATTERN.test(input.workspaceId) || !ID_PATTERN.test(input.operationId)) {
      throw new DomainError('INVALID_PUBLIC_OPERATION', 'Cancellation target is invalid')
    }
    const canceledAt = parseCommandDate(input.canceledAt, 'canceledAt')
    return this.client.$transaction(async (transaction) => {
      const stored = await transaction.v2PublicOperation.findFirst({
        where: { id: input.operationId, workspaceId: input.workspaceId },
        include: OPERATION_INCLUDE,
      })
      if (!stored) return null
      const current = hydrateRecord(stored)
      const canceled = cancelPublicOperation(current.operation, canceledAt.toISOString())
      if (canceled.status !== 'canceled' || stored.status === 'canceled') return current

      const updated = await transaction.v2PublicOperation.updateMany({
        where: {
          id: input.operationId,
          workspaceId: input.workspaceId,
          status: { in: ['queued', 'running', 'waiting', 'retrying'] },
          cancelable: true,
        },
        data: {
          status: canceled.status,
          phase: canceled.phase,
          cancelable: false,
          retryable: false,
          resultJson: null,
          errorCode: null,
          errorMessage: null,
          errorRetryable: null,
          completedAt: canceledAt,
          nextAttemptAt: null,
          deadLetteredAt: null,
          updatedAt: canceledAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
        },
      })
      const persisted = await transaction.v2PublicOperation.findFirst({
        where: { id: input.operationId, workspaceId: input.workspaceId },
        include: OPERATION_INCLUDE,
      })
      if (!persisted) return null
      const result = hydrateRecord(persisted)
      if (updated.count === 1 || result.operation.status === 'canceled') return result
      if (isTerminalPublicOperation(result.operation)) return result
      throw new DomainError('PERSISTENCE_CONFLICT', 'PublicOperation cancellation collided')
    })
  }

  async retry(input: {
    workspaceId: string
    operationId: string
    requestedAt: string
    nextAttemptAt: string
  }): Promise<PublicOperationRecord | null> {
    if (!ID_PATTERN.test(input.workspaceId) || !ID_PATTERN.test(input.operationId)) {
      throw new DomainError('INVALID_PUBLIC_OPERATION', 'Retry target is invalid')
    }
    const requestedAt = parseCommandDate(input.requestedAt, 'requestedAt')
    const nextAttemptAt = parseCommandDate(input.nextAttemptAt, 'nextAttemptAt')
    if (nextAttemptAt.getTime() <= requestedAt.getTime()) {
      throw new DomainError('INVALID_PUBLIC_OPERATION', 'Retry availability is invalid')
    }
    return this.client.$transaction(async (transaction) => {
      const stored = await transaction.v2PublicOperation.findFirst({
        where: { id: input.operationId, workspaceId: input.workspaceId },
        include: OPERATION_INCLUDE,
      })
      if (!stored) return null
      const current = hydrateRecord(stored)
      const retried = retryPublicOperation(
        current.operation,
        requestedAt.toISOString(),
        nextAttemptAt.toISOString(),
      )
      if (retried.status === stored.status) return current

      const updated = await transaction.v2PublicOperation.updateMany({
        where: {
          id: input.operationId,
          workspaceId: input.workspaceId,
          status: stored.status,
          updatedAt: stored.updatedAt,
        },
        data: {
          status: retried.status,
          phase: retried.phase,
          cancelable: retried.cancelable,
          retryable: retried.retryable,
          maxAttempts: retried.maxAttempts,
          resultJson: null,
          errorCode: null,
          errorMessage: null,
          errorRetryable: null,
          startedAt: retried.startedAt ? new Date(retried.startedAt) : null,
          completedAt: null,
          nextAttemptAt: retried.nextAttemptAt ? new Date(retried.nextAttemptAt) : null,
          deadLetteredAt: null,
          updatedAt: requestedAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
        },
      })
      const persisted = await transaction.v2PublicOperation.findFirst({
        where: { id: input.operationId, workspaceId: input.workspaceId },
        include: OPERATION_INCLUDE,
      })
      if (!persisted) return null
      const result = hydrateRecord(persisted)
      if (updated.count === 1 || !isTerminalPublicOperation(result.operation)) return result
      throw new DomainError('PERSISTENCE_CONFLICT', 'PublicOperation retry collided')
    })
  }

  private findStoredById(
    workspaceId: string,
    operationId: string,
  ): Promise<StoredOperation | null> {
    return this.client.v2PublicOperation.findFirst({
      where: { id: operationId, workspaceId },
      include: OPERATION_INCLUDE,
    })
  }

  async findById(
    workspaceId: string,
    operationId: string,
  ): Promise<PublicOperationRecord | null> {
    const stored = await this.findStoredById(workspaceId, operationId)
    return stored ? hydrateRecord(stored) : null
  }

  async list(input: PublicOperationListQuery): Promise<readonly PublicOperationRecord[]> {
    if (
      !ID_PATTERN.test(input.workspaceId) ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 101 ||
      (input.targetId !== undefined && !ID_PATTERN.test(input.targetId))
    ) {
      throw new DomainError('INVALID_PUBLIC_OPERATION', 'Operation list query is invalid')
    }
    const afterDate = input.after
      ? parseCommandDate(input.after.createdAt, 'after.createdAt')
      : undefined
    if (input.after && !ID_PATTERN.test(input.after.id)) {
      throw new DomainError('INVALID_PUBLIC_OPERATION', 'Operation cursor is invalid')
    }
    const where: Prisma.V2PublicOperationWhereInput = {
      workspaceId: input.workspaceId,
      ...(input.status ? { status: input.status } : {}),
      ...(input.type ? { type: input.type } : {}),
      ...(input.targetId ? { targetId: input.targetId } : {}),
      ...(input.deadLettered === true
        ? { deadLetteredAt: { not: null } }
        : input.deadLettered === false
          ? { deadLetteredAt: null }
          : {}),
      ...(input.after && afterDate
        ? {
            OR: [
              { createdAt: { lt: afterDate } },
              { createdAt: afterDate, id: { lt: input.after.id } },
            ],
          }
        : {}),
    }
    const rows = await this.client.v2PublicOperation.findMany({
      where,
      include: OPERATION_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit,
    })
    return rows.map(hydrateRecord)
  }

  private findStoredReplay(
    workspaceId: string,
    clientId: string,
    idempotencyKey: string,
  ): Promise<StoredOperation | null> {
    return this.client.v2PublicOperation.findUnique({
      where: {
        workspaceId_clientId_idempotencyKey: {
          workspaceId,
          clientId,
          idempotencyKey,
        },
      },
      include: OPERATION_INCLUDE,
    })
  }

  async findReplay(input: {
    workspaceId: string
    clientId: string
    idempotencyKey: string
    requestFingerprint: string
  }): Promise<PublicOperationPersistenceResult | null> {
    const stored = await this.findStoredReplay(
      input.workspaceId,
      input.clientId,
      input.idempotencyKey,
    )
    if (!stored) return null
    if (stored.requestFingerprint !== input.requestFingerprint) {
      throw new DomainError(
        'IDEMPOTENCY_PAYLOAD_MISMATCH',
        'Idempotency key was already used with a different request',
        { operationId: stored.id },
      )
    }
    return { ...hydrateRecord(stored), replayed: true }
  }

  async createOrReplay(input: {
    operation: PublicOperation
    context: PublicOperationContext
    idempotencyKey: string
    requestFingerprint: string
  }, serializationAttempt = 1): Promise<PublicOperationPersistenceResult> {
    assertPublicOperation(input.operation)
    const renderContext = input.operation.type === 'artifact-render' && 'authorizationId' in input.context
      ? input.context
      : undefined
    const ingestContext = input.operation.type === 'media-ingest' && 'uploadId' in input.context
      ? input.context
      : undefined
    if (
      input.operation.status !== 'queued' || !SHA256_PATTERN.test(input.requestFingerprint) ||
      (!renderContext && !ingestContext) ||
      (renderContext && (!SHA256_PATTERN.test(renderContext.inputHash) || !ID_PATTERN.test(renderContext.authorizationId))) ||
      (ingestContext && (
        !/^[0-9a-f-]{36}$/.test(ingestContext.uploadId) ||
        ![ingestContext.projectId, ingestContext.sourceArtifactId, ingestContext.sourceManifestId].every((value) => ID_PATTERN.test(value)) ||
        ingestContext.sourceArtifactId !== input.operation.target.id || ingestContext.sourceManifestId !== input.operation.target.manifestId ||
        ingestContext.originalFileName.trim().length < 1 || ingestContext.originalFileName.length > 240
      )) ||
      input.idempotencyKey.length < 1 ||
      input.idempotencyKey.length > 128
    ) {
      throw new DomainError('INVALID_PUBLIC_OPERATION', 'Queued operation persistence input is invalid')
    }
    try {
      return await this.client.$transaction(async (transaction) => {
        const existing = await transaction.v2PublicOperation.findUnique({
          where: {
            workspaceId_clientId_idempotencyKey: {
              workspaceId: input.operation.workspaceId,
              clientId: input.operation.clientId,
              idempotencyKey: input.idempotencyKey,
            },
          },
          include: OPERATION_INCLUDE,
        })
        if (existing) {
          if (existing.requestFingerprint !== input.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was already used with a different request',
              { operationId: existing.id },
            )
          }
          return { ...hydrateRecord(existing), replayed: true }
        }

        if (ingestContext) {
          const upload = await transaction.v2MediaUpload.findFirst({
            where: {
              id: ingestContext.uploadId,
              workspaceId: input.operation.workspaceId,
              clientId: input.operation.clientId,
              projectId: ingestContext.projectId,
              status: 'verified',
              rightsConfirmed: true,
            },
            select: { id: true, fileName: true },
          })
          if (!upload || upload.fileName !== ingestContext.originalFileName) {
            throw new DomainError('MEDIA_UPLOAD_TRANSITION_REJECTED', 'Verified upload cannot be attached to this ingest operation')
          }
        }

        await transaction.v2PublicOperation.create({
          data: {
            id: input.operation.id,
            workspaceId: input.operation.workspaceId,
            clientId: input.operation.clientId,
            type: input.operation.type,
            status: input.operation.status,
            phase: input.operation.phase,
            targetType: input.operation.target.type,
            targetId: input.operation.target.id,
            progressCompleted: input.operation.progress?.completed,
            progressTotal: input.operation.progress?.total,
            progressUnit: input.operation.progress?.unit,
            cancelable: input.operation.cancelable,
            retryable: input.operation.retryable,
            attempt: input.operation.attempt,
            maxAttempts: input.operation.maxAttempts,
            idempotencyKey: input.idempotencyKey,
            requestFingerprint: input.requestFingerprint,
            createdAt: new Date(input.operation.createdAt),
            updatedAt: new Date(input.operation.updatedAt),
          },
        })
        if (renderContext) {
          await transaction.v2ArtifactRenderOperation.create({
            data: {
              operationId: input.operation.id,
              workspaceId: input.operation.workspaceId,
              artifactId: input.operation.target.id,
              manifestId: input.operation.target.manifestId,
              authorizationId: renderContext.authorizationId,
              inputHash: renderContext.inputHash,
            },
          })
        } else {
          await transaction.v2MediaIngestOperation.create({
            data: {
              operationId: input.operation.id,
              workspaceId: input.operation.workspaceId,
              uploadId: ingestContext!.uploadId,
              projectId: ingestContext!.projectId,
              sourceArtifactId: ingestContext!.sourceArtifactId,
              sourceManifestId: ingestContext!.sourceManifestId,
              originalFileName: ingestContext!.originalFileName,
            },
          })
          await transaction.v2Project.updateMany({
            where: { id: ingestContext!.projectId, workspaceId: input.operation.workspaceId, status: { in: ['draft', 'failed'] } },
            data: { status: 'ingesting' },
          })
        }
        const created = await transaction.v2PublicOperation.findUnique({
          where: { id: input.operation.id },
          include: OPERATION_INCLUDE,
        })
        if (!created) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'PublicOperation was not persisted')
        }
        return { ...hydrateRecord(created), replayed: false }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (isSerializationConflict(error)) {
        if (serializationAttempt < 3) {
          return this.createOrReplay(input, serializationAttempt + 1)
        }
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'PublicOperation creation conflicted with another transaction',
        )
      }
      if (isUniqueConstraintError(error)) {
        const replay = await this.findReplay({
          workspaceId: input.operation.workspaceId,
          clientId: input.operation.clientId,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
        })
        if (replay) return replay
      }
      throw error
    }
  }

  async claimNext(input: {
    leaseOwner: string
    now: string
    leaseUntil: string
    workspaceId?: string
    type?: PublicOperation['type']
  }): Promise<ClaimedPublicOperationRecord | null> {
    if (!ID_PATTERN.test(input.leaseOwner)) {
      throw new DomainError('INVALID_PUBLIC_OPERATION', 'Worker lease owner is invalid')
    }
    const now = parseCommandDate(input.now, 'now')
    const leaseUntil = parseCommandDate(input.leaseUntil, 'leaseUntil')
    if (leaseUntil.getTime() <= now.getTime()) {
      throw new DomainError('INVALID_PUBLIC_OPERATION', 'Worker lease must expire after now')
    }

    return this.client.$transaction(async (transaction) => {
      const candidates = await transaction.v2PublicOperation.findMany({
        where: {
          ...(input.type ? { type: input.type } : {}),
          ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
          OR: [
            { status: 'queued', leaseOwner: null },
            {
              status: 'retrying',
              leaseOwner: null,
              nextAttemptAt: { lte: now },
            },
            { status: 'running', leaseExpiresAt: { lte: now } },
          ],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 32,
        include: OPERATION_INCLUDE,
      })
      for (const candidate of candidates) {
        const current = hydrateRecord(candidate).operation
        if (candidate.attempt >= candidate.maxAttempts) {
          if (candidate.status === 'running') {
            await transaction.v2PublicOperation.updateMany({
              where: {
                id: candidate.id,
                status: 'running',
                phase: candidate.phase,
                attempt: candidate.attempt,
                updatedAt: candidate.updatedAt,
                leaseOwner: candidate.leaseOwner,
                leaseExpiresAt: { lte: now },
              },
              data: {
                status: 'failed',
                phase: 'failed',
                cancelable: false,
                retryable: false,
                resultJson: null,
                errorCode: 'worker_lease_expired',
                errorMessage: 'Operation exhausted its available attempts',
                errorRetryable: false,
                completedAt: now,
                nextAttemptAt: null,
                deadLetteredAt: now,
                updatedAt: now,
                leaseOwner: null,
                leaseExpiresAt: null,
                heartbeatAt: null,
              },
            })
          }
          continue
        }
        const claimed = startPublicOperationAttempt(current, now.toISOString())
        const updated = await transaction.v2PublicOperation.updateMany({
          where: {
            id: candidate.id,
            status: candidate.status,
            phase: candidate.phase,
            attempt: candidate.attempt,
            updatedAt: candidate.updatedAt,
            ...(candidate.status === 'running'
              ? {
                  leaseOwner: candidate.leaseOwner,
                  leaseExpiresAt: { lte: now },
                }
              : { leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null }),
          },
          data: {
            status: claimed.status,
            phase: claimed.phase,
            progressCompleted: claimed.progress?.completed,
            progressTotal: claimed.progress?.total,
            progressUnit: claimed.progress?.unit,
            cancelable: claimed.cancelable,
            retryable: claimed.retryable,
            attempt: claimed.attempt,
            resultJson: null,
            errorCode: null,
            errorMessage: null,
            errorRetryable: null,
            startedAt: new Date(claimed.startedAt as string),
            completedAt: null,
            nextAttemptAt: null,
            deadLetteredAt: null,
            updatedAt: now,
            leaseOwner: input.leaseOwner,
            leaseExpiresAt: leaseUntil,
            heartbeatAt: now,
          },
        })
        if (updated.count !== 1) continue
        const stored = await transaction.v2PublicOperation.findUnique({
          where: { id: candidate.id },
          include: OPERATION_INCLUDE,
        })
        if (!stored) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'Claimed PublicOperation disappeared')
        }
        return hydrateClaim(stored)
      }
      return null
    })
  }

  async heartbeat(input: PublicOperationLeaseCommand & {
    leaseUntil: string
  }): Promise<boolean> {
    const now = parseCommandDate(input.now, 'now')
    const leaseUntil = parseCommandDate(input.leaseUntil, 'leaseUntil')
    if (!ID_PATTERN.test(input.leaseOwner) || leaseUntil.getTime() <= now.getTime()) {
      throw new DomainError('INVALID_PUBLIC_OPERATION', 'Heartbeat lease input is invalid')
    }
    const updated = await this.client.v2PublicOperation.updateMany({
      where: {
        id: input.operationId,
        status: 'running',
        leaseOwner: input.leaseOwner,
        attempt: input.attempt,
        leaseExpiresAt: { gt: now },
        heartbeatAt: { lte: now },
        updatedAt: { lte: now },
      },
      data: { heartbeatAt: now, leaseExpiresAt: leaseUntil, updatedAt: now },
    })
    return updated.count === 1
  }

  private async transitionRunning(
    input: PublicOperationLeaseCommand,
    transition: (operation: PublicOperation) => Readonly<PublicOperation>,
    requiresCheckpoint = false,
  ): Promise<PublicOperationRecord | null> {
    const now = parseCommandDate(input.now, 'now')
    if (!ID_PATTERN.test(input.leaseOwner)) {
      throw new DomainError('INVALID_PUBLIC_OPERATION', 'Worker lease owner is invalid')
    }
    return this.client.$transaction(async (transaction) => {
      const stored = await transaction.v2PublicOperation.findUnique({
        where: { id: input.operationId },
        include: OPERATION_INCLUDE,
      })
      if (!stored) return null
      const record = hydrateRecord(stored)
      if (
        stored.status !== 'running' ||
        stored.leaseOwner !== input.leaseOwner ||
        stored.attempt !== input.attempt ||
        stored.leaseExpiresAt === null ||
        stored.leaseExpiresAt.getTime() <= now.getTime()
      ) {
        return null
      }
      if (
        requiresCheckpoint &&
        requiresArtifactRenderCheckpoint(stored.type as PublicOperation['type']) &&
        (!stored.artifactRender || !hasCompleteCheckpoint(stored.artifactRender))
      ) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Render operation cannot succeed before its output checkpoint',
        )
      }
      const next = transition(record.operation)
      const updated = await transaction.v2PublicOperation.updateMany({
        where: {
          id: input.operationId,
          status: 'running',
          phase: stored.phase,
          updatedAt: stored.updatedAt,
          leaseOwner: input.leaseOwner,
          attempt: input.attempt,
          leaseExpiresAt: { gt: now },
        },
        data: {
          status: next.status,
          phase: next.phase,
          progressCompleted: next.progress?.completed,
          progressTotal: next.progress?.total,
          progressUnit: next.progress?.unit,
          cancelable: next.cancelable,
          retryable: next.retryable,
          resultJson: next.result ? JSON.stringify(next.result) : null,
          errorCode: next.error?.code ?? null,
          errorMessage: next.error?.message ?? null,
          errorRetryable: next.error?.retryable ?? null,
          completedAt: next.completedAt ? new Date(next.completedAt) : null,
          nextAttemptAt: next.nextAttemptAt ? new Date(next.nextAttemptAt) : null,
          deadLetteredAt: next.deadLetteredAt ? new Date(next.deadLetteredAt) : null,
          updatedAt: now,
          ...(next.status === 'running'
            ? {}
            : { leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null }),
        },
      })
      if (updated.count !== 1) return null
      const persisted = await transaction.v2PublicOperation.findUnique({
        where: { id: input.operationId },
        include: OPERATION_INCLUDE,
      })
      return persisted ? hydrateRecord(persisted) : null
    })
  }

  async advancePhase(input: PublicOperationLeaseCommand & {
    phase: PublicOperationRunningPhase
  }): Promise<boolean> {
    const record = await this.transitionRunning(input, (operation) =>
      advancePublicOperationPhase(operation, input.phase, input.now),
    )
    return record !== null
  }

  succeed(input: PublicOperationLeaseCommand): Promise<PublicOperationRecord | null> {
    return this.transitionRunning(
      input,
      (operation) => succeedPublicOperation(operation, input.now),
      true,
    )
  }

  failOrRetry(input: PublicOperationLeaseCommand & {
    error: PublicOperationError
    nextAttemptAt?: string
  }): Promise<PublicOperationRecord | null> {
    return this.transitionRunning(input, (operation) =>
      retryOrFailPublicOperation(operation, input.error, input.now, input.nextAttemptAt),
    )
  }
}
