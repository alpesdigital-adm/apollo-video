import type { ApiClient } from '../../domain/api-client.ts'
import type { ApiCredential } from '../../domain/api-credential.ts'

export interface StoredApiClientCredential {
  client: ApiClient
  credential: ApiCredential
  secretSalt: string
  secretHash: string
}

export interface CreatedApiClientCredential {
  client: ApiClient
  credential: ApiCredential
}

export interface ApiClientRepository {
  findActiveClientById(clientId: string): Promise<ApiClient | null>
  findCredentialById(
    clientId: string,
    credentialId: string,
  ): Promise<StoredApiClientCredential | null>
  createCredential(credential: StoredApiClientCredential): Promise<CreatedApiClientCredential>
  touchLastUsed(clientId: string, credentialId: string, usedAt: string): Promise<void>
}
