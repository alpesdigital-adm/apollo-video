import type { PrismaClient } from '@prisma/client'

import { prisma } from '../../../lib/db.ts'
import {
  createApiClient,
  type ApiClient,
  type ApiClientStatus,
  type ApiEnvironment,
} from '../../domain/api-client.ts'
import type {
  ApiClientRepository,
  StoredApiClientCredential,
} from '../../application/ports/api-client-repository.ts'

export class PrismaApiClientRepository implements ApiClientRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient = prisma) {
    this.client = client
  }

  async findCredentialById(clientId: string): Promise<StoredApiClientCredential | null> {
    const row = await this.client.v2ApiClient.findUnique({
      where: { id: clientId },
      include: { workspace: { select: { status: true } } },
    })
    if (!row || row.workspace.status !== 'active') return null

    return {
      client: createApiClient({
        id: row.id,
        workspaceId: row.workspaceId,
        name: row.name,
        status: row.status as ApiClientStatus,
        environment: row.environment as ApiEnvironment,
        scopes: JSON.parse(row.scopesJson) as string[],
        createdAt: row.createdAt.toISOString(),
        lastUsedAt: row.lastUsedAt?.toISOString(),
      }),
      secretSalt: row.secretSalt,
      secretHash: row.secretHash,
    }
  }

  async createCredential(credential: StoredApiClientCredential): Promise<ApiClient> {
    const row = await this.client.v2ApiClient.create({
      data: {
        id: credential.client.id,
        workspaceId: credential.client.workspaceId,
        name: credential.client.name,
        status: credential.client.status,
        environment: credential.client.environment,
        scopesJson: JSON.stringify(credential.client.scopes),
        secretSalt: credential.secretSalt,
        secretHash: credential.secretHash,
        createdAt: new Date(credential.client.createdAt),
      },
    })

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

  async touchLastUsed(clientId: string, usedAt: string): Promise<void> {
    await this.client.v2ApiClient.update({
      where: { id: clientId },
      data: { lastUsedAt: new Date(usedAt) },
    })
  }
}
