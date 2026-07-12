import { assertDomain } from './errors.ts'

export const API_CREDENTIAL_STATUSES = ['active', 'revoked'] as const

export type ApiCredentialStatus = (typeof API_CREDENTIAL_STATUSES)[number]

export interface ApiCredential {
  schemaVersion: 1
  id: string
  workspaceId: string
  clientId: string
  status: ApiCredentialStatus
  createdAt: string
  expiresAt?: string
  lastUsedAt?: string
  revokedAt?: string
}

export type ApiCredentialInput = Omit<ApiCredential, 'schemaVersion'>

export function createApiCredential(input: ApiCredentialInput): Readonly<ApiCredential> {
  assertDomain(
    /^[A-Za-z0-9_-]{3,80}$/.test(input.id),
    'INVALID_API_CLIENT',
    'ApiCredential id must contain 3-80 safe characters',
  )
  assertDomain(
    input.workspaceId.trim().length > 0 && input.clientId.trim().length > 0,
    'INVALID_API_CLIENT',
    'ApiCredential workspaceId and clientId are required',
  )
  assertDomain(
    API_CREDENTIAL_STATUSES.includes(input.status),
    'INVALID_API_CLIENT',
    'Unsupported ApiCredential status',
  )
  assertDomain(
    !Number.isNaN(Date.parse(input.createdAt)),
    'INVALID_API_CLIENT',
    'ApiCredential createdAt must be an ISO-compatible date',
  )
  if (input.expiresAt) {
    assertDomain(
      !Number.isNaN(Date.parse(input.expiresAt)) &&
        Date.parse(input.expiresAt) > Date.parse(input.createdAt),
      'INVALID_API_CLIENT',
      'ApiCredential expiresAt must be after createdAt',
    )
  }
  if (input.status === 'active') {
    assertDomain(!input.revokedAt, 'INVALID_API_CLIENT', 'Active credential cannot be revoked')
  } else {
    assertDomain(
      Boolean(input.revokedAt) && !Number.isNaN(Date.parse(input.revokedAt as string)),
      'INVALID_API_CLIENT',
      'Revoked credential requires revokedAt',
    )
  }

  return Object.freeze({ ...input, schemaVersion: 1 as const })
}

export function isApiCredentialUsable(credential: ApiCredential, now: Date): boolean {
  return (
    credential.status === 'active' &&
    (!credential.expiresAt || Date.parse(credential.expiresAt) > now.getTime())
  )
}
