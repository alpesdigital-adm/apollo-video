import type { ApiClient } from '../../domain/api-client.ts'

export interface StoredApiClientCredential {
  client: ApiClient
  secretSalt: string
  secretHash: string
}

export interface ApiClientRepository {
  findCredentialById(clientId: string): Promise<StoredApiClientCredential | null>
  createCredential(credential: StoredApiClientCredential): Promise<ApiClient>
  touchLastUsed(clientId: string, usedAt: string): Promise<void>
}
