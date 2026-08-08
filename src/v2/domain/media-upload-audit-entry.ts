import {
  createApiAccessAuditContext,
  type ApiAccessAuditContext,
} from './api-access-control.ts'
import { assertDomain } from './errors.ts'

export const MEDIA_UPLOAD_AUDIT_ACTIONS = [
  'begin',
  'session-issue',
  'part-record',
  'complete',
  'abort',
  'inspect',
] as const

export type MediaUploadAuditAction = (typeof MEDIA_UPLOAD_AUDIT_ACTIONS)[number]

export interface MediaUploadAuditEntry {
  readonly id: string
  readonly workspaceId: string
  readonly uploadId: string
  readonly action: MediaUploadAuditAction
  readonly partNumber?: number
  readonly audit: Readonly<ApiAccessAuditContext>
  readonly requestFingerprint: string
  readonly occurredAt: string
}

export function createMediaUploadAuditEntry(
  input: MediaUploadAuditEntry,
): Readonly<MediaUploadAuditEntry> {
  assertDomain(/^[0-9a-f-]{36}$/.test(input.id) && /^[0-9a-f-]{36}$/.test(input.uploadId), 'INVALID_ARGUMENT', 'Upload audit identity is invalid')
  assertDomain(input.workspaceId.length >= 3 && input.workspaceId.length <= 128, 'INVALID_ARGUMENT', 'Upload audit workspace is invalid')
  assertDomain(MEDIA_UPLOAD_AUDIT_ACTIONS.includes(input.action), 'INVALID_ARGUMENT', 'Upload audit action is invalid')
  assertDomain(
    (input.action === 'part-record') === (Number.isInteger(input.partNumber) && input.partNumber! >= 1 && input.partNumber! <= 10_000),
    'INVALID_ARGUMENT',
    'Upload audit part identity is inconsistent',
  )
  const canonicalAudit = createApiAccessAuditContext({
    clientId: input.audit.clientId,
    credentialId: input.audit.credentialId,
    workspaceId: input.audit.workspaceId,
    environment: input.audit.environment,
    authenticationKind: input.audit.authenticationKind,
    ...(input.audit.delegatedUserId ? { delegatedUserId: input.audit.delegatedUserId } : {}),
    ...(input.audit.delegatedIdentityId ? { delegatedIdentityId: input.audit.delegatedIdentityId } : {}),
    ...(input.audit.workspaceRole ? { workspaceRole: input.audit.workspaceRole } : {}),
  })
  assertDomain(
    canonicalAudit.contextHash === input.audit.contextHash &&
      input.audit.workspaceId === input.workspaceId,
    'AUTH_INVALID',
    'Upload audit actor is mismatched',
  )
  assertDomain(/^[a-f0-9]{64}$/.test(input.requestFingerprint), 'INVALID_ARGUMENT', 'Upload audit fingerprint is invalid')
  const occurredAt = new Date(input.occurredAt)
  assertDomain(!Number.isNaN(occurredAt.getTime()), 'INVALID_ARGUMENT', 'Upload audit timestamp is invalid')
  return Object.freeze({ ...input, occurredAt: occurredAt.toISOString() })
}
