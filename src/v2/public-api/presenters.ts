import type { PublicCapability } from './capability-registry.ts'
import type { ApiClient } from '../domain/api-client.ts'
import type { ApiCredential } from '../domain/api-credential.ts'

export const PUBLIC_API_VERSION = 'v1' as const

export interface PublicSuccess<T> {
  data: T
  meta: {
    apiVersion: typeof PUBLIC_API_VERSION
  }
}
export function presentSuccess<T>(data: T): PublicSuccess<T> {
  return {
    data,
    meta: { apiVersion: PUBLIC_API_VERSION },
  }
}

export function presentCapability(capability: PublicCapability) {
  return {
    id: capability.id,
    version: capability.version,
    title: capability.title,
    description: capability.description,
    operationKind: capability.operationKind,
    requiredScopes: [...capability.requiredScopes],
    inputSchemaRef: capability.inputSchemaRef,
    outputSchemaRef: capability.outputSchemaRef,
    endpoint: capability.endpoint,
    toolName: capability.toolName,
    supportsDryRun: capability.supportsDryRun,
    costClass: capability.costClass,
    confirmation: capability.confirmation,
  }
}

export function presentApiClient(client: ApiClient) {
  return {
    id: client.id,
    workspaceId: client.workspaceId,
    name: client.name,
    status: client.status,
    environment: client.environment,
    scopes: [...client.scopes],
    createdAt: client.createdAt,
    lastUsedAt: client.lastUsedAt,
  }
}

export function presentApiCredential(credential: ApiCredential) {
  return {
    id: credential.id,
    clientId: credential.clientId,
    status: credential.status,
    createdAt: credential.createdAt,
    expiresAt: credential.expiresAt,
    lastUsedAt: credential.lastUsedAt,
    revokedAt: credential.revokedAt,
  }
}
