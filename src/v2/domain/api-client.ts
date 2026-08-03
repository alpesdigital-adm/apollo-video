import { assertDomain } from './errors.ts'

export const API_CLIENT_STATUSES = ['active', 'suspended', 'revoked'] as const
export const API_ENVIRONMENTS = ['sandbox', 'production'] as const
export const API_CLIENT_TYPES = [
  'service-account',
  'oauth-application',
  'personal-development',
] as const

export type ApiClientStatus = (typeof API_CLIENT_STATUSES)[number]
export type ApiEnvironment = (typeof API_ENVIRONMENTS)[number]
export type ApiClientType = (typeof API_CLIENT_TYPES)[number]

export interface ApiClient {
  schemaVersion: 2
  id: string
  workspaceId: string
  name: string
  type: ApiClientType
  status: ApiClientStatus
  scopeGrants: readonly string[]
  allowedEnvironments: readonly ApiEnvironment[]
  createdBy: string
  createdAt: string
  lastUsedAt?: string
}

export type ServiceAccount = ApiClient & Readonly<{ type: 'service-account' }>

export interface ApiCredentialRef {
  readonly clientId: string
  readonly credentialId: string
}

export type ApiClientInput = Omit<ApiClient, 'schemaVersion'>

export function createApiClient(input: ApiClientInput): Readonly<ApiClient> {
  const name = input.name.trim().replace(/\s+/g, ' ')
  const scopeGrants = [...new Set(input.scopeGrants.map((scope) => scope.trim()))].sort()
  const allowedEnvironments = [...new Set(input.allowedEnvironments)].sort()

  assertDomain(
    /^[A-Za-z0-9_-]{3,80}$/.test(input.id),
    'INVALID_API_CLIENT',
    'ApiClient id must contain 3-80 safe characters',
  )
  assertDomain(
    input.workspaceId.trim().length > 0,
    'INVALID_API_CLIENT',
    'ApiClient workspaceId is required',
  )
  assertDomain(
    name.length >= 2 && name.length <= 120,
    'INVALID_API_CLIENT',
    'ApiClient name must contain 2-120 characters',
  )
  assertDomain(
    API_CLIENT_TYPES.includes(input.type),
    'INVALID_API_CLIENT',
    'Unsupported ApiClient type',
  )
  assertDomain(
    API_CLIENT_STATUSES.includes(input.status),
    'INVALID_API_CLIENT',
    'Unsupported ApiClient status',
  )
  assertDomain(
    allowedEnvironments.length > 0 &&
      allowedEnvironments.length === input.allowedEnvironments.length &&
      allowedEnvironments.every((environment) => API_ENVIRONMENTS.includes(environment)),
    'INVALID_API_CLIENT',
    'ApiClient allowedEnvironments must be unique supported values',
  )
  assertDomain(
    scopeGrants.length === input.scopeGrants.length &&
      scopeGrants.every((scope) => /^[a-z-]+:[a-z-]+$/.test(scope)),
    'INVALID_API_CLIENT',
    'ApiClient scopeGrants must be unique resource:action values',
  )
  assertDomain(
    /^[A-Za-z0-9:_-]{3,128}$/.test(input.createdBy),
    'INVALID_API_CLIENT',
    'ApiClient createdBy must identify its creator',
  )
  assertDomain(
    !Number.isNaN(Date.parse(input.createdAt)),
    'INVALID_API_CLIENT',
    'ApiClient createdAt must be an ISO-compatible date',
  )

  return Object.freeze({
    ...input,
    schemaVersion: 2 as const,
    name,
    scopeGrants: Object.freeze(scopeGrants),
    allowedEnvironments: Object.freeze(allowedEnvironments),
  })
}

export function createServiceAccount(input: Omit<ApiClientInput, 'type'>): ServiceAccount {
  return createApiClient({ ...input, type: 'service-account' }) as ServiceAccount
}

export function apiCredentialRef(clientId: string, credentialId: string): ApiCredentialRef {
  assertDomain(
    /^[A-Za-z0-9_-]{3,80}$/.test(clientId) && /^[A-Za-z0-9_-]{3,80}$/.test(credentialId),
    'INVALID_API_CLIENT',
    'ApiCredentialRef identifiers are invalid',
  )
  return Object.freeze({ clientId, credentialId })
}
