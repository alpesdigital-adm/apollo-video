import type { ApiClient } from '../../domain/api-client.ts'
import type { ApiAdministrationCommand } from '../../domain/api-administration-command.ts'
import type { ApiCredential } from '../../domain/api-credential.ts'

export interface ApiAdministrationIdempotency {
  id: string
  workspaceId: string
  actorClientId: string
  key: string
  requestFingerprint: string
  createdAt: string
  expiresAt: string
}

export interface ApiClientCredentialSecret {
  secretSalt: string
  secretHash: string
}

export interface CreateApiClientBundle {
  command: ApiAdministrationCommand
  client: ApiClient
  credential: ApiCredential
  secret: ApiClientCredentialSecret
  idempotency: ApiAdministrationIdempotency
}

export interface RotateApiCredentialBundle {
  command: ApiAdministrationCommand
  workspaceId: string
  targetClientId: string
  credential: ApiCredential
  secret: ApiClientCredentialSecret
  overlapUntil: string
  idempotency: ApiAdministrationIdempotency
}

export interface ApiCredentialMutationResult {
  client: ApiClient
  credential: ApiCredential
  replayed: boolean
}

export interface ApiClientAdministrationRepository {
  listByWorkspace(workspaceId: string, limit: number): Promise<readonly ApiClient[]>
  createOrReplay(bundle: CreateApiClientBundle): Promise<ApiCredentialMutationResult>
  rotateOrReplay(bundle: RotateApiCredentialBundle): Promise<ApiCredentialMutationResult>
  revokeCredential(input: {
    command: ApiAdministrationCommand
    workspaceId: string
    clientId: string
    credentialId: string
    revokedAt: string
  }): Promise<ApiCredential>
}
