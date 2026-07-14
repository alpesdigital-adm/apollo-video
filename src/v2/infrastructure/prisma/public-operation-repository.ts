import type { Prisma, PrismaClient } from '@prisma/client'

import type {
  ArtifactRenderOperationContext,
  ClaimedPublicOperationRecord,
  PublicOperationLeaseCommand,
  PublicOperationPersistenceResult,
  PublicOperationRecord,
  PublicOperationRepository,
} from '../../application/ports/public-operation-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  advancePublicOperationPhase,
  assertPublicOperation,
  rehydratePublicOperation,
  retryOrFailPublicOperation,
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
  }
}>

const OPERATION_INCLUDE = {
  artifactRender: {
    include: {
      manifest: { select: { artifactId: true } },
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
} as const

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

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
  const detail = row.artifactRender
  if (
    !detail ||
    row.type !== 'artifact-render' ||
    row.targetType !== 'media-artifact' ||
    row.targetId !== detail.artifactId ||
    row.workspaceId !== detail.workspaceId ||
    detail.manifest.artifactId !== detail.artifactId ||
    detail.authorization.artifactId !== detail.artifactId ||
    detail.authorization.manifestId !== detail.manifestId ||
    detail.authorization.inputHash !== detail.inputHash ||
    detail.authorization.clientId !== row.clientId ||
    detail.authorization.status !== 'authorized' ||
    !SHA256_PATTERN.test(detail.inputHash)
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored PublicOperation context is invalid',
      { operationId: row.id },
    )
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

  try {
    const operation = rehydratePublicOperation({
      schemaVersion: 'public-operation/v1',
      id: row.id,
      workspaceId: row.workspaceId,
      clientId: row.clientId,
      type: 'artifact-render',
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
        id: detail.artifactId,
        manifestId: detail.manifestId,
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
    })
    return Object.freeze({
      operation,
      context: Object.freeze({
        authorizationId: detail.authorizationId,
        inputHash: detail.inputHash,
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
    context: ArtifactRenderOperationContext
    idempotencyKey: string
    requestFingerprint: string
  }): Promise<PublicOperationPersistenceResult> {
    assertPublicOperation(input.operation)
    if (
      input.operation.status !== 'queued' ||
      !SHA256_PATTERN.test(input.requestFingerprint) ||
      !SHA256_PATTERN.test(input.context.inputHash) ||
      !ID_PATTERN.test(input.context.authorizationId) ||
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
        await transaction.v2ArtifactRenderOperation.create({
          data: {
            operationId: input.operation.id,
            workspaceId: input.operation.workspaceId,
            artifactId: input.operation.target.id,
            manifestId: input.operation.target.manifestId,
            authorizationId: input.context.authorizationId,
            inputHash: input.context.inputHash,
          },
        })
        const created = await transaction.v2PublicOperation.findUnique({
          where: { id: input.operation.id },
          include: OPERATION_INCLUDE,
        })
        if (!created) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'PublicOperation was not persisted')
        }
        return { ...hydrateRecord(created), replayed: false }
      })
    } catch (error) {
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
          type: 'artifact-render',
          ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
          OR: [
            { status: { in: ['queued', 'retrying'] }, leaseOwner: null },
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
                errorMessage: 'Render operation exhausted its available attempts',
                errorRetryable: false,
                completedAt: now,
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
    return this.transitionRunning(input, (operation) =>
      succeedPublicOperation(operation, input.now),
    )
  }

  failOrRetry(input: PublicOperationLeaseCommand & {
    error: PublicOperationError
  }): Promise<PublicOperationRecord | null> {
    return this.transitionRunning(input, (operation) =>
      retryOrFailPublicOperation(operation, input.error, input.now),
    )
  }
}
