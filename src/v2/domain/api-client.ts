import { assertDomain } from './errors.ts'

export const API_CLIENT_STATUSES = ['active', 'suspended', 'revoked'] as const
export const API_ENVIRONMENTS = ['sandbox', 'production'] as const

export type ApiClientStatus = (typeof API_CLIENT_STATUSES)[number]
export type ApiEnvironment = (typeof API_ENVIRONMENTS)[number]

export interface ApiClient {
  schemaVersion: 1
  id: string
  workspaceId: string
  name: string
  status: ApiClientStatus
  environment: ApiEnvironment
  scopes: readonly string[]
  createdAt: string
  lastUsedAt?: string
}

export type ApiClientInput = Omit<ApiClient, 'schemaVersion'>

export function createApiClient(input: ApiClientInput): Readonly<ApiClient> {
  const name = input.name.trim().replace(/\s+/g, ' ')
  const scopes = [...new Set(input.scopes.map((scope) => scope.trim()))].sort()

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
    API_CLIENT_STATUSES.includes(input.status),
    'INVALID_API_CLIENT',
    'Unsupported ApiClient status',
  )
  assertDomain(
    API_ENVIRONMENTS.includes(input.environment),
    'INVALID_API_CLIENT',
    'Unsupported ApiClient environment',
  )
  assertDomain(
    scopes.length === input.scopes.length && scopes.every((scope) => /^[a-z-]+:[a-z-]+$/.test(scope)),
    'INVALID_API_CLIENT',
    'ApiClient scopes must be unique resource:action values',
  )
  assertDomain(
    !Number.isNaN(Date.parse(input.createdAt)),
    'INVALID_API_CLIENT',
    'ApiClient createdAt must be an ISO-compatible date',
  )

  return Object.freeze({
    ...input,
    schemaVersion: 1 as const,
    name,
    scopes: Object.freeze(scopes),
  })
}
