import { assertDomain } from './errors.ts'
import {
  createApiAccessAuditContext,
  type ApiAccessAuditContext,
} from './api-access-control.ts'

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
  audit: Readonly<ApiAccessAuditContext>
  revocationAudit?: Readonly<ApiAccessAuditContext>
}

function assertAuditContext(
  audit: Readonly<ApiAccessAuditContext>,
  workspaceId: string,
  clientId: string,
): void {
  const canonical = createApiAccessAuditContext({
    clientId: audit.clientId,
    credentialId: audit.credentialId,
    workspaceId: audit.workspaceId,
    environment: audit.environment,
    authenticationKind: audit.authenticationKind,
    ...(audit.delegatedUserId ? { delegatedUserId: audit.delegatedUserId } : {}),
    ...(audit.delegatedIdentityId ? { delegatedIdentityId: audit.delegatedIdentityId } : {}),
    ...(audit.workspaceRole ? { workspaceRole: audit.workspaceRole } : {}),
  })
  assertDomain(
    canonical.contextHash === audit.contextHash &&
      audit.workspaceId === workspaceId && audit.clientId === clientId,
    'AUTH_INVALID',
    'Download grant audit identity is mismatched',
  )
}

export function createMediaDownloadGrant(input: MediaDownloadGrant): Readonly<MediaDownloadGrant> {
  assertDomain(/^[0-9a-f-]{36}$/.test(input.id), 'INVALID_ARGUMENT', 'download grant id must be a UUID')
  assertDomain(input.workspaceId.length > 0 && input.clientId.length > 0, 'INVALID_ARGUMENT', 'download grant actor is required')
  assertAuditContext(input.audit, input.workspaceId, input.clientId)
  assertDomain(input.artifactId.length >= 3 && input.artifactId.length <= 128, 'INVALID_ARGUMENT', 'artifactId is invalid')
  assertDomain(/^[a-f0-9]{64}$/.test(input.tokenHash), 'INVALID_ARGUMENT', 'download grant token hash is invalid')
  assertDomain(input.idempotencyKey.length >= 8 && input.idempotencyKey.length <= 128, 'INVALID_ARGUMENT', 'download grant idempotency key is invalid')
  assertDomain(/^[a-f0-9]{64}$/.test(input.requestFingerprint), 'INVALID_ARGUMENT', 'download grant request fingerprint is invalid')
  const createdAt = new Date(input.createdAt)
  const expiresAt = new Date(input.expiresAt)
  assertDomain(!Number.isNaN(createdAt.getTime()) && expiresAt > createdAt, 'INVALID_ARGUMENT', 'download grant expiry is invalid')
  assertDomain(expiresAt.getTime() - createdAt.getTime() <= 15 * 60_000, 'INVALID_ARGUMENT', 'download grant exceeds maximum TTL')
  const isRevoked = input.status === 'revoked'
  assertDomain(
    isRevoked === Boolean(input.revokedAt) && isRevoked === Boolean(input.revocationAudit),
    'INVALID_ARGUMENT',
    'download grant revocation evidence is inconsistent',
  )
  if (input.revokedAt) {
    assertDomain(!Number.isNaN(Date.parse(input.revokedAt)), 'INVALID_ARGUMENT', 'revokedAt is invalid')
    assertAuditContext(input.revocationAudit!, input.workspaceId, input.clientId)
  }
  return Object.freeze({ ...input, createdAt: createdAt.toISOString(), expiresAt: expiresAt.toISOString() })
}
