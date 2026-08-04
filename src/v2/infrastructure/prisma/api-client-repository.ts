import {
  Prisma,
  type PrismaClient,
  type V2ApiAdministrationCommand,
  type V2ApiClient,
  type V2ApiCredential,
  type V2IdempotencyRecord,
} from '../../../../generated/prisma-v2/index.js'

import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import {
  createApiClient,
  type ApiClient,
  type ApiClientType,
  type ApiClientStatus,
  type ApiEnvironment,
} from '../../domain/api-client.ts'
import {
  createApiCredential,
  type ApiCredential,
  type ApiCredentialStatus,
} from '../../domain/api-credential.ts'
import type {
  ApiClientAuthenticationAccess,
  ApiClientRepository,
  CreatedApiClientCredential,
  StoredApiClientCredential,
} from '../../application/ports/api-client-repository.ts'
import type {
  ApiClientAdministrationRepository,
  ApiCredentialMutationResult,
  CreateApiClientBundle,
  RotateApiCredentialBundle,
} from '../../application/ports/api-client-administration-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  createApiAdministrationCommand,
  type ApiAdministrationCommand,
} from '../../domain/api-administration-command.ts'
import { createApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type { WorkspaceMemberRole } from '../../domain/workspace-member.ts'

interface StoredAdministrationResponse {
  operation: 'api-client.create' | 'api-credential.rotate'
  clientId: string
  credentialId: string
}

function isConcurrentWriteConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'P2002' || error.code === 'P2034')
  )
}

function hydrateClient(row: V2ApiClient): ApiClient {
  return createApiClient({
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    status: row.status as ApiClientStatus,
    type: row.type as ApiClientType,
    allowedEnvironments: JSON.parse(row.allowedEnvironmentsJson) as ApiEnvironment[],
    scopeGrants: JSON.parse(row.scopeGrantsJson) as string[],
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString(),
  })
}

function hydrateCredential(row: V2ApiCredential) {
  return createApiCredential({
    id: row.id,
    workspaceId: row.workspaceId,
    clientId: row.clientId,
    status: row.status as ApiCredentialStatus,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString(),
    revokedAt: row.revokedAt?.toISOString(),
  })
}

function parseAdministrationResponse(
  record: V2IdempotencyRecord,
  expectedOperation: StoredAdministrationResponse['operation'],
): StoredAdministrationResponse {
  if (record.status !== 'completed' || !record.responseJson) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Idempotent API administration is still processing or incomplete',
      { idempotencyRecordId: record.id, status: record.status },
    )
  }
  const response = JSON.parse(record.responseJson) as Partial<StoredAdministrationResponse>
  if (
    response.operation !== expectedOperation ||
    !response.clientId ||
    !response.credentialId
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored idempotency response is invalid', {
      idempotencyRecordId: record.id,
    })
  }
  return response as StoredAdministrationResponse
}

function assertIdempotencyFingerprint(
  record: V2IdempotencyRecord,
  requestFingerprint: string,
): void {
  if (record.requestFingerprint !== requestFingerprint) {
    throw new DomainError(
      'IDEMPOTENCY_PAYLOAD_MISMATCH',
      'Idempotency key was already used with a different request',
      { idempotencyRecordId: record.id },
    )
  }
}

function hydrateAdministrationCommand(row: V2ApiAdministrationCommand): Readonly<ApiAdministrationCommand> {
  try {
    return createApiAdministrationCommand({
      id: row.id,
      workspaceId: row.workspaceId,
      action: row.action as ApiAdministrationCommand['action'],
      targetClientId: row.targetClientId,
      targetCredentialId: row.targetCredentialId,
      audit: createApiAccessAuditContext({
        clientId: row.actorClientId,
        credentialId: row.actorCredentialId,
        workspaceId: row.workspaceId,
        environment: row.actorEnvironment as ApiEnvironment,
        authenticationKind: row.actorAuthenticationKind as 'bearer' | 'ui-session',
        ...(row.delegatedUserId ? { delegatedUserId: row.delegatedUserId } : {}),
        ...(row.delegatedIdentityId ? { delegatedIdentityId: row.delegatedIdentityId } : {}),
        ...(row.workspaceRole ? { workspaceRole: row.workspaceRole as WorkspaceMemberRole } : {}),
      }),
      ...(row.idempotencyKey ? { idempotencyKey: row.idempotencyKey } : {}),
      requestFingerprint: row.requestFingerprint,
      occurredAt: row.occurredAt.toISOString(),
    })
  } catch {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored API administration audit command is invalid',
      { commandId: row.id },
    )
  }
}

function administrationCommandData(command: ApiAdministrationCommand) {
  return {
    id: command.id,
    workspaceId: command.workspaceId,
    action: command.action,
    targetClientId: command.targetClientId,
    targetCredentialId: command.targetCredentialId,
    actorClientId: command.audit.clientId,
    actorCredentialId: command.audit.credentialId,
    actorEnvironment: command.audit.environment,
    actorAuthenticationKind: command.audit.authenticationKind,
    actorContextHash: command.audit.contextHash,
    delegatedUserId: command.audit.delegatedUserId,
    delegatedIdentityId: command.audit.delegatedIdentityId,
    workspaceRole: command.audit.workspaceRole,
    idempotencyKey: command.idempotencyKey,
    requestFingerprint: command.requestFingerprint,
    occurredAt: new Date(command.occurredAt),
  }
}

function assertAdministrationReplay(
  row: V2ApiAdministrationCommand | null,
  requested: ApiAdministrationCommand,
): void {
  if (!row) throw new DomainError('PERSISTENCE_CONFLICT', 'Idempotent API administration audit is missing')
  const stored = hydrateAdministrationCommand(row)
  if (
    stored.action !== requested.action ||
    stored.audit.contextHash !== requested.audit.contextHash ||
    stored.idempotencyKey !== requested.idempotencyKey ||
    stored.requestFingerprint !== requested.requestFingerprint
  ) {
    throw new DomainError(
      'IDEMPOTENCY_PAYLOAD_MISMATCH',
      'Idempotency key was already used by a different administrative actor or request',
    )
  }
}

function assertAdministrationCommandTarget(
  command: ApiAdministrationCommand,
  expected: {
    action: ApiAdministrationCommand['action']
    workspaceId: string
    clientId: string
    credentialId: string
    requestFingerprint?: string
    idempotencyKey?: string
  },
): void {
  if (
    command.action !== expected.action || command.workspaceId !== expected.workspaceId ||
    command.targetClientId !== expected.clientId ||
    command.targetCredentialId !== expected.credentialId ||
    (expected.requestFingerprint !== undefined && command.requestFingerprint !== expected.requestFingerprint) ||
    command.idempotencyKey !== expected.idempotencyKey
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'API administration command does not match its mutation')
  }
}

export class PrismaApiClientRepository
  implements ApiClientRepository, ApiClientAdministrationRepository
{
  private readonly client: PrismaClient

  constructor(client: PrismaClient = getV2PostgresClient()) {
    this.client = client
  }

  async findActiveClientById(clientId: string): Promise<ApiClient | null> {
    const row = await this.client.v2ApiClient.findUnique({
      where: { id: clientId },
      include: { workspace: { select: { status: true, apiAccessStatus: true } } },
    })
    if (!row || row.status !== 'active' || row.workspace.status !== 'active') return null
    return hydrateClient(row)
  }

  async findActiveClientAccessById(clientId: string): Promise<ApiClientAuthenticationAccess | null> {
    const row = await this.client.v2ApiClient.findUnique({
      where: { id: clientId },
      include: { workspace: { select: { status: true, apiAccessStatus: true, apiKillSwitchEngaged: true } } },
    })
    if (!row || row.status !== 'active' || row.workspace.status !== 'active') return null
    return {
      client: hydrateClient(row),
      clientKillSwitchEngaged: row.apiKillSwitchEngaged,
      workspaceKillSwitchEngaged: row.workspace.apiKillSwitchEngaged,
      workspaceAccessStatus: row.workspace.apiAccessStatus as ApiClientAuthenticationAccess['workspaceAccessStatus'],
    }
  }

  async findCredentialById(
    clientId: string,
    credentialId: string,
  ): Promise<StoredApiClientCredential | null> {
    const row = await this.client.v2ApiCredential.findUnique({
      where: { id_clientId: { id: credentialId, clientId } },
      include: {
        client: { include: { workspace: { select: { status: true, apiAccessStatus: true, apiKillSwitchEngaged: true } } } },
      },
    })
    if (!row || row.client.workspace.status !== 'active' || row.client.workspace.apiAccessStatus !== 'active') return null

    return {
      client: createApiClient({
        id: row.client.id,
        workspaceId: row.client.workspaceId,
        name: row.client.name,
        status: row.client.status as ApiClientStatus,
        type: row.client.type as ApiClientType,
        allowedEnvironments: JSON.parse(row.client.allowedEnvironmentsJson) as ApiEnvironment[],
        scopeGrants: JSON.parse(row.client.scopeGrantsJson) as string[],
        createdBy: row.client.createdBy,
        createdAt: row.client.createdAt.toISOString(),
        lastUsedAt: row.client.lastUsedAt?.toISOString(),
      }),
      credential: createApiCredential({
        id: row.id,
        workspaceId: row.workspaceId,
        clientId: row.clientId,
        status: row.status as ApiCredentialStatus,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt?.toISOString(),
        lastUsedAt: row.lastUsedAt?.toISOString(),
        revokedAt: row.revokedAt?.toISOString(),
      }),
      secretSalt: row.secretSalt,
      secretHash: row.secretHash,
      clientKillSwitchEngaged: row.client.apiKillSwitchEngaged,
      workspaceKillSwitchEngaged: row.client.workspace.apiKillSwitchEngaged,
      workspaceAccessStatus: row.client.workspace.apiAccessStatus as StoredApiClientCredential['workspaceAccessStatus'],
    }
  }

  async createCredential(
    stored: StoredApiClientCredential,
  ): Promise<CreatedApiClientCredential> {
    const result = await this.client.$transaction(async (transaction) => {
      const client = await transaction.v2ApiClient.create({
        data: {
          id: stored.client.id,
          workspaceId: stored.client.workspaceId,
          name: stored.client.name,
          status: stored.client.status,
          type: stored.client.type,
          allowedEnvironmentsJson: JSON.stringify(stored.client.allowedEnvironments),
          scopeGrantsJson: JSON.stringify(stored.client.scopeGrants),
          createdBy: stored.client.createdBy,
          createdAt: new Date(stored.client.createdAt),
        },
      })
      const credential = await transaction.v2ApiCredential.create({
        data: {
          id: stored.credential.id,
          workspaceId: stored.credential.workspaceId,
          clientId: stored.credential.clientId,
          status: stored.credential.status,
          secretSalt: stored.secretSalt,
          secretHash: stored.secretHash,
          expiresAt: stored.credential.expiresAt
            ? new Date(stored.credential.expiresAt)
            : undefined,
          createdAt: new Date(stored.credential.createdAt),
        },
      })
      return { client, credential }
    })

    return {
      client: createApiClient({
        id: result.client.id,
        workspaceId: result.client.workspaceId,
        name: result.client.name,
        status: result.client.status as ApiClientStatus,
        type: result.client.type as ApiClientType,
        allowedEnvironments: JSON.parse(result.client.allowedEnvironmentsJson) as ApiEnvironment[],
        scopeGrants: JSON.parse(result.client.scopeGrantsJson) as string[],
        createdBy: result.client.createdBy,
        createdAt: result.client.createdAt.toISOString(),
        lastUsedAt: result.client.lastUsedAt?.toISOString(),
      }),
      credential: createApiCredential({
        id: result.credential.id,
        workspaceId: result.credential.workspaceId,
        clientId: result.credential.clientId,
        status: result.credential.status as ApiCredentialStatus,
        createdAt: result.credential.createdAt.toISOString(),
        expiresAt: result.credential.expiresAt?.toISOString(),
      }),
    }
  }

  async touchLastUsed(clientId: string, credentialId: string, usedAt: string): Promise<void> {
    const lastUsedAt = new Date(usedAt)
    await this.client.$transaction([
      this.client.v2ApiClient.update({
        where: { id: clientId },
        data: { lastUsedAt },
      }),
      this.client.v2ApiCredential.update({
        where: { id_clientId: { id: credentialId, clientId } },
        data: { lastUsedAt },
      }),
    ])
  }

  async listByWorkspace(workspaceId: string, limit: number): Promise<readonly ApiClient[]> {
    const rows = await this.client.v2ApiClient.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    })
    return rows.map(hydrateClient)
  }

  async createOrReplay(
    bundle: CreateApiClientBundle,
    concurrentWriteAttempt = 1,
  ): Promise<ApiCredentialMutationResult> {
    assertAdministrationCommandTarget(bundle.command, {
      action: 'api-client.create', workspaceId: bundle.client.workspaceId,
      clientId: bundle.client.id, credentialId: bundle.credential.id,
      requestFingerprint: bundle.idempotency.requestFingerprint,
      idempotencyKey: bundle.idempotency.key,
    })
    const result = this.client.$transaction(async (transaction) => {
      const key = {
        workspaceId_clientId_key: {
          workspaceId: bundle.idempotency.workspaceId,
          clientId: bundle.idempotency.actorClientId,
          key: bundle.idempotency.key,
        },
      }
      const existing = await transaction.v2IdempotencyRecord.findUnique({ where: key })
      if (existing && existing.expiresAt > new Date(bundle.idempotency.createdAt)) {
        assertIdempotencyFingerprint(existing, bundle.idempotency.requestFingerprint)
        const stored = parseAdministrationResponse(existing, 'api-client.create')
        const [clientRow, credentialRow, commandRow] = await Promise.all([
          transaction.v2ApiClient.findUnique({ where: { id: stored.clientId } }),
          transaction.v2ApiCredential.findUnique({
            where: {
              id_clientId: { id: stored.credentialId, clientId: stored.clientId },
            },
          }),
          transaction.v2ApiAdministrationCommand.findUnique({
            where: { workspaceId_action_targetClientId_targetCredentialId: {
              workspaceId: bundle.idempotency.workspaceId,
              action: 'api-client.create',
              targetClientId: stored.clientId,
              targetCredentialId: stored.credentialId,
            } },
          }),
        ])
        if (!clientRow || !credentialRow || clientRow.workspaceId !== bundle.client.workspaceId) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'Idempotency result is missing')
        }
        assertAdministrationReplay(commandRow, bundle.command)
        return {
          client: hydrateClient(clientRow),
          credential: hydrateCredential(credentialRow),
          replayed: true,
        }
      }
      if (existing) {
        await transaction.v2IdempotencyRecord.delete({ where: { id: existing.id } })
      }

      const workspace = await transaction.v2Workspace.findUnique({
        where: { id: bundle.client.workspaceId },
        select: { status: true },
      })
      if (!workspace || workspace.status !== 'active') {
        throw new DomainError('WORKSPACE_NOT_FOUND', 'Active workspace was not found')
      }

      await transaction.v2IdempotencyRecord.create({
        data: {
          id: bundle.idempotency.id,
          workspaceId: bundle.idempotency.workspaceId,
          clientId: bundle.idempotency.actorClientId,
          key: bundle.idempotency.key,
          requestFingerprint: bundle.idempotency.requestFingerprint,
          status: 'processing',
          createdAt: new Date(bundle.idempotency.createdAt),
          expiresAt: new Date(bundle.idempotency.expiresAt),
        },
      })
      const clientRow = await transaction.v2ApiClient.create({
        data: {
          id: bundle.client.id,
          workspaceId: bundle.client.workspaceId,
          name: bundle.client.name,
          status: bundle.client.status,
          type: bundle.client.type,
          allowedEnvironmentsJson: JSON.stringify(bundle.client.allowedEnvironments),
          scopeGrantsJson: JSON.stringify(bundle.client.scopeGrants),
          createdBy: bundle.client.createdBy,
          createdAt: new Date(bundle.client.createdAt),
        },
      })
      const credentialRow = await transaction.v2ApiCredential.create({
        data: {
          id: bundle.credential.id,
          workspaceId: bundle.credential.workspaceId,
          clientId: bundle.credential.clientId,
          status: bundle.credential.status,
          secretSalt: bundle.secret.secretSalt,
          secretHash: bundle.secret.secretHash,
          createdAt: new Date(bundle.credential.createdAt),
        },
      })
      await transaction.v2ApiAdministrationCommand.create({
        data: administrationCommandData(bundle.command),
      })
      const response: StoredAdministrationResponse = {
        operation: 'api-client.create',
        clientId: clientRow.id,
        credentialId: credentialRow.id,
      }
      await transaction.v2IdempotencyRecord.update({
        where: { id: bundle.idempotency.id },
        data: {
          status: 'completed',
          responseStatus: 201,
          responseJson: JSON.stringify(response),
        },
      })

      return {
        client: hydrateClient(clientRow),
        credential: hydrateCredential(credentialRow),
        replayed: false,
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })

    return result.catch((error: unknown) => {
      if (!isConcurrentWriteConflict(error)) throw error
      if (concurrentWriteAttempt < 3) {
        return this.createOrReplay(bundle, concurrentWriteAttempt + 1)
      }
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'API client creation conflicted with another transaction',
      )
    })
  }

  async rotateOrReplay(
    bundle: RotateApiCredentialBundle,
    concurrentWriteAttempt = 1,
  ): Promise<ApiCredentialMutationResult> {
    assertAdministrationCommandTarget(bundle.command, {
      action: 'api-credential.rotate', workspaceId: bundle.workspaceId,
      clientId: bundle.targetClientId, credentialId: bundle.credential.id,
      requestFingerprint: bundle.idempotency.requestFingerprint,
      idempotencyKey: bundle.idempotency.key,
    })
    const result = this.client.$transaction(async (transaction) => {
      const key = {
        workspaceId_clientId_key: {
          workspaceId: bundle.idempotency.workspaceId,
          clientId: bundle.idempotency.actorClientId,
          key: bundle.idempotency.key,
        },
      }
      const existing = await transaction.v2IdempotencyRecord.findUnique({ where: key })
      if (existing && existing.expiresAt > new Date(bundle.idempotency.createdAt)) {
        assertIdempotencyFingerprint(existing, bundle.idempotency.requestFingerprint)
        const stored = parseAdministrationResponse(existing, 'api-credential.rotate')
        const [clientRow, credentialRow, commandRow] = await Promise.all([
          transaction.v2ApiClient.findUnique({ where: { id: stored.clientId } }),
          transaction.v2ApiCredential.findUnique({
            where: {
              id_clientId: { id: stored.credentialId, clientId: stored.clientId },
            },
          }),
          transaction.v2ApiAdministrationCommand.findUnique({
            where: { workspaceId_action_targetClientId_targetCredentialId: {
              workspaceId: bundle.idempotency.workspaceId,
              action: 'api-credential.rotate',
              targetClientId: stored.clientId,
              targetCredentialId: stored.credentialId,
            } },
          }),
        ])
        if (!clientRow || !credentialRow || clientRow.workspaceId !== bundle.workspaceId) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'Idempotency result is missing')
        }
        assertAdministrationReplay(commandRow, bundle.command)
        return {
          client: hydrateClient(clientRow),
          credential: hydrateCredential(credentialRow),
          replayed: true,
        }
      }
      if (existing) {
        await transaction.v2IdempotencyRecord.delete({ where: { id: existing.id } })
      }

      const clientRow = await transaction.v2ApiClient.findFirst({
        where: {
          id: bundle.targetClientId,
          workspaceId: bundle.workspaceId,
          status: 'active',
        },
      })
      if (!clientRow) {
        throw new DomainError('API_CLIENT_NOT_FOUND', 'Active API client was not found')
      }

      await transaction.v2IdempotencyRecord.create({
        data: {
          id: bundle.idempotency.id,
          workspaceId: bundle.idempotency.workspaceId,
          clientId: bundle.idempotency.actorClientId,
          key: bundle.idempotency.key,
          requestFingerprint: bundle.idempotency.requestFingerprint,
          status: 'processing',
          createdAt: new Date(bundle.idempotency.createdAt),
          expiresAt: new Date(bundle.idempotency.expiresAt),
        },
      })
      const overlapUntil = new Date(bundle.overlapUntil)
      await transaction.v2ApiCredential.updateMany({
        where: {
          clientId: bundle.targetClientId,
          status: 'active',
          OR: [{ expiresAt: null }, { expiresAt: { gt: overlapUntil } }],
        },
        data: { expiresAt: overlapUntil },
      })
      const credentialRow = await transaction.v2ApiCredential.create({
        data: {
          id: bundle.credential.id,
          workspaceId: bundle.credential.workspaceId,
          clientId: bundle.credential.clientId,
          status: bundle.credential.status,
          secretSalt: bundle.secret.secretSalt,
          secretHash: bundle.secret.secretHash,
          createdAt: new Date(bundle.credential.createdAt),
        },
      })
      await transaction.v2ApiAdministrationCommand.create({
        data: administrationCommandData(bundle.command),
      })
      const response: StoredAdministrationResponse = {
        operation: 'api-credential.rotate',
        clientId: clientRow.id,
        credentialId: credentialRow.id,
      }
      await transaction.v2IdempotencyRecord.update({
        where: { id: bundle.idempotency.id },
        data: {
          status: 'completed',
          responseStatus: 201,
          responseJson: JSON.stringify(response),
        },
      })

      return {
        client: hydrateClient(clientRow),
        credential: hydrateCredential(credentialRow),
        replayed: false,
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })

    return result.catch((error: unknown) => {
      if (!isConcurrentWriteConflict(error)) throw error
      if (concurrentWriteAttempt < 3) {
        return this.rotateOrReplay(bundle, concurrentWriteAttempt + 1)
      }
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'API credential rotation conflicted with another transaction',
      )
    })
  }

  async revokeCredential(input: {
    command: ApiAdministrationCommand
    workspaceId: string
    clientId: string
    credentialId: string
    revokedAt: string
  }, concurrentWriteAttempt = 1): Promise<ApiCredential> {
    assertAdministrationCommandTarget(input.command, {
      action: 'api-credential.revoke', workspaceId: input.workspaceId,
      clientId: input.clientId, credentialId: input.credentialId,
    })
    try {
      return await this.client.$transaction(async (transaction) => {
        const persisted = await transaction.v2ApiCredential.findFirst({
          where: {
            id: input.credentialId,
            clientId: input.clientId,
            workspaceId: input.workspaceId,
          },
        })
        if (!persisted) {
          throw new DomainError('API_CREDENTIAL_NOT_FOUND', 'API credential was not found')
        }
        const commandKey = { workspaceId_action_targetClientId_targetCredentialId: {
          workspaceId: input.workspaceId,
          action: 'api-credential.revoke',
          targetClientId: input.clientId,
          targetCredentialId: input.credentialId,
        } }
        const existingCommand = await transaction.v2ApiAdministrationCommand.findUnique({
          where: commandKey,
        })
        if (persisted.status === 'revoked') {
          if (!existingCommand) {
            throw new DomainError('PERSISTENCE_CONFLICT', 'Revoked API credential audit is missing')
          }
          hydrateAdministrationCommand(existingCommand)
          return hydrateCredential(persisted)
        }
        if (persisted.status !== 'active' || existingCommand) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'API credential revocation state is invalid')
        }
        const updated = await transaction.v2ApiCredential.updateMany({
          where: {
            id: input.credentialId,
            clientId: input.clientId,
            workspaceId: input.workspaceId,
            status: 'active',
          },
          data: { status: 'revoked', revokedAt: new Date(input.revokedAt) },
        })
        if (updated.count !== 1) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'API credential revocation collided with another write')
        }
        const command = await transaction.v2ApiAdministrationCommand.create({
          data: administrationCommandData(input.command),
        })
        hydrateAdministrationCommand(command)
        return hydrateCredential({
          ...persisted,
          status: 'revoked',
          revokedAt: new Date(input.revokedAt),
        })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (isConcurrentWriteConflict(error)) {
        if (concurrentWriteAttempt < 3) {
          return this.revokeCredential(input, concurrentWriteAttempt + 1)
        }
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'API credential revocation conflicted with another write',
        )
      }
      throw error
    }
  }
}
