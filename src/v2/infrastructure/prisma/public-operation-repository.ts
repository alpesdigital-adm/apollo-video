import type { Prisma, PrismaClient } from '@prisma/client'

import type {
  ArtifactRenderOperationContext,
  PublicOperationPersistenceResult,
  PublicOperationRecord,
  PublicOperationRepository,
} from '../../application/ports/public-operation-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  assertPublicOperation,
  rehydratePublicOperation,
  type PublicOperation,
  type PublicOperationResult,
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
}
