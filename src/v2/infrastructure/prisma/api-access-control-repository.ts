import { randomUUID } from 'node:crypto'

import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type {
  ApiAccessCommandResult,
  ApiAccessControlRepository,
} from '../../application/ports/api-access-control-repository.ts'
import {
  assertApiAccessAuditBinding,
  createApiAccessAuditContext,
  createApiAccessControl,
  type ApiAccessAuthenticationKind,
  type ApiAccessAuditContext,
  type ApiAccessCommand,
  type ApiAccessControl,
  type ApiAccessStatus,
} from '../../domain/api-access-control.ts'
import type { ApiEnvironment } from '../../domain/api-client.ts'
import { DomainError } from '../../domain/errors.ts'
import type { PublicOperation, PublicOperationStatus } from '../../domain/public-operation.ts'
import { createPublicEvent } from '../../domain/public-event.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { persistPublicEvents } from './public-event-outbox.ts'
import { persistManyOperationStatusEvents } from './public-operation-repository.ts'
import type { WorkspaceMemberRole } from '../../domain/workspace-member.ts'

type StoredCommand = {
  id: string
  workspaceId: string
  targetType: string
  targetId: string
  action: string
  baseRevision: string
  resultRevision: string
  previousStatus: string
  resultStatus: string
  previousKillSwitchEngaged: boolean
  resultKillSwitchEngaged: boolean
  reason: string
  actorClientId: string
  actorCredentialId: string
  actorEnvironment: string
  actorAuthenticationKind: string
  actorContextHash: string
  delegatedUserId: string | null
  delegatedIdentityId: string | null
  workspaceRole: string | null
  idempotencyKey: string
  requestFingerprint: string
  canceledOperationCount: number
  changedAt: Date
}

function hydrateCommand(row: StoredCommand): Readonly<ApiAccessCommand> {
  return Object.freeze({
    schemaVersion: 1,
    id: row.id,
    workspaceId: row.workspaceId,
    targetType: row.targetType as ApiAccessCommand['targetType'],
    targetId: row.targetId,
    action: row.action as ApiAccessCommand['action'],
    baseRevision: row.baseRevision,
    resultRevision: row.resultRevision,
    previousStatus: row.previousStatus as ApiAccessStatus,
    resultStatus: row.resultStatus as ApiAccessStatus,
    previousKillSwitchEngaged: row.previousKillSwitchEngaged,
    resultKillSwitchEngaged: row.resultKillSwitchEngaged,
    reason: row.reason,
    actorClientId: row.actorClientId,
    ...(row.delegatedUserId ? { delegatedUserId: row.delegatedUserId } : {}),
    idempotencyKey: row.idempotencyKey,
    requestFingerprint: row.requestFingerprint,
    changedAt: row.changedAt.toISOString(),
  })
}

function hydrateStoredAudit(row: StoredCommand): Readonly<ApiAccessAuditContext> {
  try {
    const audit = createApiAccessAuditContext({
      clientId: row.actorClientId,
      credentialId: row.actorCredentialId,
      workspaceId: row.workspaceId,
      environment: row.actorEnvironment as ApiEnvironment,
      authenticationKind: row.actorAuthenticationKind as ApiAccessAuthenticationKind,
      ...(row.delegatedUserId ? { delegatedUserId: row.delegatedUserId } : {}),
      ...(row.delegatedIdentityId ? { delegatedIdentityId: row.delegatedIdentityId } : {}),
      ...(row.workspaceRole ? { workspaceRole: row.workspaceRole as WorkspaceMemberRole } : {}),
    })
    if (audit.contextHash !== row.actorContextHash) throw new Error('context hash mismatch')
    return audit
  } catch {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored API access audit context is invalid',
      { commandId: row.id },
    )
  }
}

function accessFromCommand(row: StoredCommand): Readonly<ApiAccessControl> {
  return createApiAccessControl({
    workspaceId: row.workspaceId,
    targetType: row.targetType as ApiAccessCommand['targetType'],
    targetId: row.targetId,
    status: row.resultStatus as ApiAccessStatus,
    killSwitchEngaged: row.resultKillSwitchEngaged,
    revision: row.resultRevision,
  })
}

function replayResult(row: StoredCommand): Readonly<ApiAccessCommandResult> {
  return Object.freeze({
    access: accessFromCommand(row),
    command: hydrateCommand(row),
    canceledOperationCount: row.canceledOperationCount,
    replayed: true,
  })
}

function isConcurrentWrite(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error.code === 'P2002' || error.code === 'P2034')
}

export class PrismaApiAccessControlRepository implements ApiAccessControlRepository {
  private readonly client: PrismaClient
  private readonly createEventId: () => string

  constructor(
    client: PrismaClient = getV2PostgresClient(),
    createEventId: () => string = randomUUID,
  ) {
    this.client = client
    this.createEventId = createEventId
  }

  async find(input: {
    workspaceId: string
    targetType: 'client' | 'workspace'
    targetId: string
  }): Promise<Readonly<ApiAccessControl> | null> {
    if (input.targetType === 'workspace') {
      const row = await this.client.v2Workspace.findUnique({ where: { id: input.workspaceId } })
      return row ? createApiAccessControl({
        workspaceId: row.id,
        targetType: 'workspace',
        targetId: row.id,
        status: row.apiAccessStatus as ApiAccessStatus,
        killSwitchEngaged: row.apiKillSwitchEngaged,
        revision: row.apiAccessRevision,
      }) : null
    }
    const row = await this.client.v2ApiClient.findFirst({
      where: { id: input.targetId, workspaceId: input.workspaceId },
    })
    return row ? createApiAccessControl({
      workspaceId: row.workspaceId,
      targetType: 'client',
      targetId: row.id,
      status: row.status as ApiAccessStatus,
      killSwitchEngaged: row.apiKillSwitchEngaged,
      revision: row.apiAccessRevision,
    }) : null
  }

  async findReplay(input: {
    workspaceId: string
    actorClientId: string
    actorContextHash: string
    idempotencyKey: string
    requestFingerprint: string
  }): Promise<Readonly<ApiAccessCommandResult> | null> {
    const row = await this.client.v2ApiAccessCommand.findUnique({
      where: { workspaceId_actorClientId_idempotencyKey: {
        workspaceId: input.workspaceId,
        actorClientId: input.actorClientId,
        idempotencyKey: input.idempotencyKey,
      } },
    })
    if (!row) return null
    hydrateStoredAudit(row)
    if (
      row.actorContextHash !== input.actorContextHash ||
      row.requestFingerprint !== input.requestFingerprint
    ) {
      throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was already used with a different request')
    }
    return replayResult(row)
  }

  async apply(
    command: Readonly<ApiAccessCommand>,
    audit: Readonly<ApiAccessAuditContext>,
    attempt = 1,
  ): Promise<Readonly<ApiAccessCommandResult>> {
    assertApiAccessAuditBinding(command, audit)
    try {
      return await this.client.$transaction(async (transaction) => {
        const replay = await transaction.v2ApiAccessCommand.findUnique({
          where: { workspaceId_actorClientId_idempotencyKey: {
            workspaceId: command.workspaceId,
            actorClientId: command.actorClientId,
            idempotencyKey: command.idempotencyKey,
          } },
        })
        if (replay) {
          hydrateStoredAudit(replay)
          if (
            replay.actorContextHash !== audit.contextHash ||
            replay.requestFingerprint !== command.requestFingerprint
          ) {
            throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was already used with a different request')
          }
          return replayResult(replay)
        }

        const current = command.targetType === 'workspace'
          ? await transaction.v2Workspace.findUnique({ where: { id: command.workspaceId } })
          : await transaction.v2ApiClient.findFirst({ where: { id: command.targetId, workspaceId: command.workspaceId } })
        if (!current) throw new DomainError('API_CLIENT_NOT_FOUND', 'API access target was not found')
        const currentStatus = command.targetType === 'workspace'
          ? (current as typeof current & { apiAccessStatus: string }).apiAccessStatus
          : current.status
        if (
          current.apiAccessRevision !== command.baseRevision ||
          currentStatus !== command.previousStatus ||
          current.apiKillSwitchEngaged !== command.previousKillSwitchEngaged
        ) {
          throw new DomainError('VERSION_CONFLICT', 'API access state changed before commit')
        }

        const updated = command.targetType === 'workspace'
          ? await transaction.v2Workspace.updateMany({
              where: { id: command.workspaceId, apiAccessRevision: command.baseRevision },
              data: {
                apiAccessStatus: command.resultStatus,
                apiKillSwitchEngaged: command.resultKillSwitchEngaged,
                apiAccessRevision: command.resultRevision,
              },
            })
          : await transaction.v2ApiClient.updateMany({
              where: { id: command.targetId, workspaceId: command.workspaceId, apiAccessRevision: command.baseRevision },
              data: {
                status: command.resultStatus,
                apiKillSwitchEngaged: command.resultKillSwitchEngaged,
                apiAccessRevision: command.resultRevision,
              },
            })
        if (updated.count !== 1) throw new DomainError('VERSION_CONFLICT', 'API access state changed before commit')

        let canceledOperationCount = 0
        if (
          command.action === 'suspend' ||
          command.action === 'revoke' ||
          command.action === 'engage-kill-switch'
        ) {
          const cancelableOperations = await transaction.v2PublicOperation.findMany({
            where: {
              workspaceId: command.workspaceId,
              ...(command.targetType === 'client' ? { clientId: command.targetId } : {}),
              status: { in: ['queued', 'running', 'waiting', 'retrying'] },
              cancelable: true,
            },
            select: {
              id: true,
              workspaceId: true,
              projectId: true,
              clientId: true,
              type: true,
              status: true,
              attempt: true,
            },
          })
          const canceled = await transaction.v2PublicOperation.updateMany({
            where: {
              workspaceId: command.workspaceId,
              ...(command.targetType === 'client' ? { clientId: command.targetId } : {}),
              status: { in: ['queued', 'running', 'waiting', 'retrying'] },
              cancelable: true,
            },
            data: {
              status: 'canceled',
              phase: 'canceled',
              cancelable: false,
              retryable: false,
              resultJson: null,
              errorCode: null,
              errorMessage: null,
              errorRetryable: null,
              completedAt: new Date(command.changedAt),
              nextAttemptAt: null,
              deadLetteredAt: null,
              updatedAt: new Date(command.changedAt),
              leaseOwner: null,
              leaseExpiresAt: null,
              heartbeatAt: null,
            },
          })
          if (canceled.count !== cancelableOperations.length) {
            throw new DomainError('PERSISTENCE_CONFLICT', 'Cancelable operations changed before access containment committed')
          }
          await persistManyOperationStatusEvents(
            transaction,
            cancelableOperations.map((operation) => ({
              previousStatus: operation.status as PublicOperationStatus,
              operation: {
                id: operation.id,
                workspaceId: operation.workspaceId,
                ...(operation.projectId ? { projectId: operation.projectId } : {}),
                clientId: operation.clientId,
                type: operation.type as PublicOperation['type'],
                status: 'canceled' as const,
                phase: 'canceled' as const,
                attempt: operation.attempt,
                updatedAt: command.changedAt,
              },
            })),
            this.createEventId,
          )
          canceledOperationCount = canceled.count
        }

        if (
          command.targetType === 'client' &&
          command.action === 'suspend' &&
          command.previousStatus !== command.resultStatus
        ) {
          await persistPublicEvents(transaction, [createPublicEvent({
            id: this.createEventId(),
            type: 'client.suspended',
            version: '1.0.0',
            workspaceId: command.workspaceId,
            occurredAt: command.changedAt,
            actor: {
              clientId: command.actorClientId,
              ...(command.delegatedUserId ? { userId: command.delegatedUserId } : {}),
            },
            resource: { type: 'api-client', id: command.targetId },
            data: {
              commandId: command.id,
              previousStatus: command.previousStatus,
              status: command.resultStatus,
              canceledOperationCount,
            },
          })])
        }

        const stored = await transaction.v2ApiAccessCommand.create({
          data: {
            id: command.id,
            workspaceId: command.workspaceId,
            targetType: command.targetType,
            targetId: command.targetId,
            action: command.action,
            baseRevision: command.baseRevision,
            resultRevision: command.resultRevision,
            previousStatus: command.previousStatus,
            resultStatus: command.resultStatus,
            previousKillSwitchEngaged: command.previousKillSwitchEngaged,
            resultKillSwitchEngaged: command.resultKillSwitchEngaged,
            reason: command.reason,
            actorClientId: command.actorClientId,
            actorCredentialId: audit.credentialId,
            actorEnvironment: audit.environment,
            actorAuthenticationKind: audit.authenticationKind,
            actorContextHash: audit.contextHash,
            delegatedUserId: command.delegatedUserId,
            delegatedIdentityId: audit.delegatedIdentityId,
            workspaceRole: audit.workspaceRole,
            idempotencyKey: command.idempotencyKey,
            requestFingerprint: command.requestFingerprint,
            canceledOperationCount,
            changedAt: new Date(command.changedAt),
          },
        })
        hydrateStoredAudit(stored)
        return Object.freeze({
          access: accessFromCommand(stored),
          command: hydrateCommand(stored),
          canceledOperationCount,
          replayed: false,
        })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (isConcurrentWrite(error) && attempt < 3) return this.apply(command, audit, attempt + 1)
      if (isConcurrentWrite(error)) throw new DomainError('PERSISTENCE_CONFLICT', 'API access command conflicted with another write')
      throw error
    }
  }
}
