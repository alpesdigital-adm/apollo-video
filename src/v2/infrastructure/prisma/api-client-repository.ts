import {
  Prisma,
  type PrismaClient,
  type V2ApiClient,
  type V2ApiCredential,
  type V2IdempotencyRecord,
} from '../../../../generated/prisma-v2/index.js'

import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import {
  createApiClient,
  type ApiClient,
  type ApiClientStatus,
  type ApiEnvironment,
} from '../../domain/api-client.ts'
import {
  createApiCredential,
  type ApiCredential,
  type ApiCredentialStatus,
} from '../../domain/api-credential.ts'
import type {
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
    environment: row.environment as ApiEnvironment,
    scopes: JSON.parse(row.scopesJson) as string[],
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
      include: { workspace: { select: { status: true } } },
    })
    if (!row || row.status !== 'active' || row.workspace.status !== 'active') return null
    return hydrateClient(row)
  }

  async findCredentialById(
    clientId: string,
    credentialId: string,
  ): Promise<StoredApiClientCredential | null> {
    const row = await this.client.v2ApiCredential.findUnique({
      where: { id_clientId: { id: credentialId, clientId } },
      include: {
        client: { include: { workspace: { select: { status: true } } } },
      },
    })
    if (!row || row.client.workspace.status !== 'active') return null

    return {
      client: createApiClient({
        id: row.client.id,
        workspaceId: row.client.workspaceId,
        name: row.client.name,
        status: row.client.status as ApiClientStatus,
        environment: row.client.environment as ApiEnvironment,
        scopes: JSON.parse(row.client.scopesJson) as string[],
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
          environment: stored.client.environment,
          scopesJson: JSON.stringify(stored.client.scopes),
          // Retained during expand-contract for compatibility with the first migration.
          secretSalt: stored.secretSalt,
          secretHash: stored.secretHash,
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
        environment: result.client.environment as ApiEnvironment,
        scopes: JSON.parse(result.client.scopesJson) as string[],
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
    const result = this.client.$transaction(async (transaction) => {
      const key = {
        workspaceId_clientId_key: {
          workspaceId: bundle.idempotency.workspaceId,
          clientId: bundle.idempotency.actorClientId,
          key: bundle.idempotency.key,
        },
      }
      const existing = await transaction.v2IdempotencyRecord.findUnique({ where: key })
      if (existing && existing.expiresAt > new Date()) {
        assertIdempotencyFingerprint(existing, bundle.idempotency.requestFingerprint)
        const stored = parseAdministrationResponse(existing, 'api-client.create')
        const [clientRow, credentialRow] = await Promise.all([
          transaction.v2ApiClient.findUnique({ where: { id: stored.clientId } }),
          transaction.v2ApiCredential.findUnique({
            where: {
              id_clientId: { id: stored.credentialId, clientId: stored.clientId },
            },
          }),
        ])
        if (!clientRow || !credentialRow || clientRow.workspaceId !== bundle.client.workspaceId) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'Idempotency result is missing')
        }
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
          expiresAt: new Date(bundle.idempotency.expiresAt),
        },
      })
      const clientRow = await transaction.v2ApiClient.create({
        data: {
          id: bundle.client.id,
          workspaceId: bundle.client.workspaceId,
          name: bundle.client.name,
          status: bundle.client.status,
          environment: bundle.client.environment,
          scopesJson: JSON.stringify(bundle.client.scopes),
          secretSalt: bundle.secret.secretSalt,
          secretHash: bundle.secret.secretHash,
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
    const result = this.client.$transaction(async (transaction) => {
      const key = {
        workspaceId_clientId_key: {
          workspaceId: bundle.idempotency.workspaceId,
          clientId: bundle.idempotency.actorClientId,
          key: bundle.idempotency.key,
        },
      }
      const existing = await transaction.v2IdempotencyRecord.findUnique({ where: key })
      if (existing && existing.expiresAt > new Date()) {
        assertIdempotencyFingerprint(existing, bundle.idempotency.requestFingerprint)
        const stored = parseAdministrationResponse(existing, 'api-credential.rotate')
        const [clientRow, credentialRow] = await Promise.all([
          transaction.v2ApiClient.findUnique({ where: { id: stored.clientId } }),
          transaction.v2ApiCredential.findUnique({
            where: {
              id_clientId: { id: stored.credentialId, clientId: stored.clientId },
            },
          }),
        ])
        if (!clientRow || !credentialRow || clientRow.workspaceId !== bundle.workspaceId) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'Idempotency result is missing')
        }
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
    workspaceId: string
    clientId: string
    credentialId: string
    revokedAt: string
  }, concurrentWriteAttempt = 1): Promise<ApiCredential> {
    try {
      await this.client.v2ApiCredential.updateMany({
        where: {
          id: input.credentialId,
          clientId: input.clientId,
          workspaceId: input.workspaceId,
          status: 'active',
        },
        data: { status: 'revoked', revokedAt: new Date(input.revokedAt) },
      })
      const persisted = await this.client.v2ApiCredential.findFirst({
        where: {
          id: input.credentialId,
          clientId: input.clientId,
          workspaceId: input.workspaceId,
        },
      })
      if (!persisted) {
        throw new DomainError('API_CREDENTIAL_NOT_FOUND', 'API credential was not found')
      }
      if (persisted.status === 'revoked') return hydrateCredential(persisted)
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'API credential revocation collided with another write',
      )
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2034'
      ) {
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
