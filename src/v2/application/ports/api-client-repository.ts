import type { ApiClient } from '../../domain/api-client.ts'
import type { ApiAccessStatus } from '../../domain/api-access-control.ts'
import type { ApiCredential } from '../../domain/api-credential.ts'

export interface StoredApiClientCredential {
  client: ApiClient
  credential: ApiCredential
  secretSalt: string
  secretHash: string
  clientKillSwitchEngaged: boolean
  workspaceKillSwitchEngaged: boolean
  workspaceAccessStatus: ApiAccessStatus
}

export interface ApiClientAuthenticationAccess {
  client: ApiClient
  clientKillSwitchEngaged: boolean
  workspaceKillSwitchEngaged: boolean
  workspaceAccessStatus: ApiAccessStatus
}

export interface CreatedApiClientCredential {
  client: ApiClient
  credential: ApiCredential
}

export interface ApiClientRepository {
  findActiveClientById(clientId: string): Promise<ApiClient | null>
  findActiveClientAccessById(clientId: string): Promise<ApiClientAuthenticationAccess | null>
  findCredentialById(
    clientId: string,
    credentialId: string,
  ): Promise<StoredApiClientCredential | null>
  createCredential(credential: StoredApiClientCredential): Promise<CreatedApiClientCredential>
  touchLastUsed(clientId: string, credentialId: string, usedAt: string): Promise<void>
}
