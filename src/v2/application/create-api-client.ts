import type { ApiEnvironment } from '../domain/api-client.ts'
import { createApiClient } from '../domain/api-client.ts'
import { createApiCredential } from '../domain/api-credential.ts'
import type { ApiClientRepository } from './ports/api-client-repository.ts'
import type { ApiCredentialCrypto } from './ports/api-credential-crypto.ts'

export interface CreateApiClientRequest {
  id: string
  credentialId?: string
  workspaceId: string
  name: string
  environment: ApiEnvironment
  scopes: string[]
}

export interface CreateApiClientDependencies {
  repository: ApiClientRepository
  credentialCrypto: ApiCredentialCrypto
  clock: () => Date
}

export function createApiClientService(dependencies: CreateApiClientDependencies) {
  return async function execute(request: CreateApiClientRequest) {
    const createdAt = dependencies.clock().toISOString()
    const client = createApiClient({
      id: request.id,
      workspaceId: request.workspaceId,
      name: request.name,
      environment: request.environment,
      scopes: request.scopes,
      status: 'active',
      createdAt,
    })
    const credential = createApiCredential({
      id: request.credentialId ?? client.id,
      workspaceId: client.workspaceId,
      clientId: client.id,
      status: 'active',
      createdAt,
    })
    const issued = dependencies.credentialCrypto.issue(client.id, credential.id)
    const persisted = await dependencies.repository.createCredential({
      client,
      credential,
      secretSalt: issued.secretSalt,
      secretHash: issued.secretHash,
    })

    return Object.freeze({ ...persisted, token: issued.token })
  }
}
