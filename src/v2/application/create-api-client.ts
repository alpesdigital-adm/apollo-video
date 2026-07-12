import type { ApiEnvironment } from '../domain/api-client.ts'
import { createApiClient } from '../domain/api-client.ts'
import type { ApiClientRepository } from './ports/api-client-repository.ts'
import type { ApiCredentialCrypto } from './ports/api-credential-crypto.ts'

export interface CreateApiClientRequest {
  id: string
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
    const client = createApiClient({
      ...request,
      status: 'active',
      createdAt: dependencies.clock().toISOString(),
    })
    const issued = dependencies.credentialCrypto.issue(client.id)
    const persisted = await dependencies.repository.createCredential({
      client,
      secretSalt: issued.secretSalt,
      secretHash: issued.secretHash,
    })

    return Object.freeze({ client: persisted, token: issued.token })
  }
}
