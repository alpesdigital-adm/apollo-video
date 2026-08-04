import { assertDomain } from './errors.ts'

export const API_CLIENT_STATUSES = ['active', 'suspended', 'revoked'] as const
export const API_ENVIRONMENTS = ['sandbox', 'production'] as const
export const API_CLIENT_TYPES = [
  'service-account',
  'oauth-application',
  'personal-development',
] as const

export const API_SCOPE_MATRIX = Object.freeze({
  artifacts: Object.freeze(['read', 'render', 'rights', 'write'] as const),
  clients: Object.freeze(['admin'] as const),
  media: Object.freeze(['write'] as const),
  operations: Object.freeze(['cancel', 'read', 'retry'] as const),
  projects: Object.freeze(['approve', 'read', 'write'] as const),
  webhooks: Object.freeze(['admin'] as const),
} as const)

export type ApiScopeResource = keyof typeof API_SCOPE_MATRIX
export type ApiScope = {
  [Resource in ApiScopeResource]: `${Resource}:${(typeof API_SCOPE_MATRIX)[Resource][number]}`
}[ApiScopeResource]

export const API_SCOPES = Object.freeze(
  (Object.entries(API_SCOPE_MATRIX) as readonly [ApiScopeResource, readonly string[]][])
    .flatMap(([resource, actions]) => actions.map((action) => `${resource}:${action}` as ApiScope)),
)

const API_SCOPE_SET: ReadonlySet<string> = new Set(API_SCOPES)

export function isApiScope(value: unknown): value is ApiScope {
  return typeof value === 'string' && API_SCOPE_SET.has(value)
}

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
  scopeGrants: readonly ApiScope[]
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

export type ApiClientInput = Omit<ApiClient, 'schemaVersion' | 'scopeGrants'> & Readonly<{
  scopeGrants: readonly string[]
}>

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
      scopeGrants.every(isApiScope),
    'INVALID_API_CLIENT',
    'ApiClient scopeGrants must be unique values from the server authorization matrix',
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
    scopeGrants: Object.freeze(scopeGrants as ApiScope[]),
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
