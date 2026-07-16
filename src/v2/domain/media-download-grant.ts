import { assertDomain } from './errors.ts'

export interface MediaDownloadGrant {
  id: string
  workspaceId: string
  clientId: string
  artifactId: string
  tokenHash: string
  idempotencyKey: string
  requestFingerprint: string
  status: 'active' | 'revoked'
  expiresAt: string
  createdAt: string
  revokedAt?: string
}

export function createMediaDownloadGrant(input: MediaDownloadGrant): Readonly<MediaDownloadGrant> {
  assertDomain(/^[0-9a-f-]{36}$/.test(input.id), 'INVALID_ARGUMENT', 'download grant id must be a UUID')
  assertDomain(input.workspaceId.length > 0 && input.clientId.length > 0, 'INVALID_ARGUMENT', 'download grant actor is required')
  assertDomain(input.artifactId.length >= 3 && input.artifactId.length <= 128, 'INVALID_ARGUMENT', 'artifactId is invalid')
  assertDomain(/^[a-f0-9]{64}$/.test(input.tokenHash), 'INVALID_ARGUMENT', 'download grant token hash is invalid')
  assertDomain(input.idempotencyKey.length >= 8 && input.idempotencyKey.length <= 128, 'INVALID_ARGUMENT', 'download grant idempotency key is invalid')
  assertDomain(/^[a-f0-9]{64}$/.test(input.requestFingerprint), 'INVALID_ARGUMENT', 'download grant request fingerprint is invalid')
  const createdAt = new Date(input.createdAt)
  const expiresAt = new Date(input.expiresAt)
  assertDomain(!Number.isNaN(createdAt.getTime()) && expiresAt > createdAt, 'INVALID_ARGUMENT', 'download grant expiry is invalid')
  assertDomain(expiresAt.getTime() - createdAt.getTime() <= 15 * 60_000, 'INVALID_ARGUMENT', 'download grant exceeds maximum TTL')
  if (input.revokedAt) assertDomain(!Number.isNaN(Date.parse(input.revokedAt)), 'INVALID_ARGUMENT', 'revokedAt is invalid')
  return Object.freeze({ ...input, createdAt: createdAt.toISOString(), expiresAt: expiresAt.toISOString() })
}
