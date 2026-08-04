import {
  createApiAccessAuditContext,
  type ApiAccessAuditContext,
} from '../../domain/api-access-control.ts'
import { DomainError } from '../../domain/errors.ts'

export interface StoredBatchActorAudit {
  workspaceId: string
  actorCredentialId: string | null
  actorEnvironment: string | null
  actorAuthenticationKind: string | null
  actorContextHash: string | null
  delegatedUserId: string | null
  delegatedIdentityId: string | null
  workspaceRole: string | null
}

function canonicalAudit(
  row: Readonly<StoredBatchActorAudit>,
  actorClientId: string,
): Readonly<ApiAccessAuditContext> {
  if (
    !row.actorCredentialId ||
    !row.actorEnvironment ||
    !row.actorAuthenticationKind ||
    !row.actorContextHash
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored batch mutation predates credential-bound audit',
    )
  }
  try {
    const audit = createApiAccessAuditContext({
      clientId: actorClientId,
      credentialId: row.actorCredentialId,
      workspaceId: row.workspaceId,
      environment: row.actorEnvironment as ApiAccessAuditContext['environment'],
      authenticationKind:
        row.actorAuthenticationKind as ApiAccessAuditContext['authenticationKind'],
      ...(row.delegatedUserId
        ? { delegatedUserId: row.delegatedUserId }
        : {}),
      ...(row.delegatedIdentityId
        ? { delegatedIdentityId: row.delegatedIdentityId }
        : {}),
      ...(row.workspaceRole
        ? { workspaceRole: row.workspaceRole as ApiAccessAuditContext['workspaceRole'] }
        : {}),
    })
    if (audit.contextHash !== row.actorContextHash) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Stored batch mutation audit hash is inconsistent',
      )
    }
    return audit
  } catch (error) {
    if (error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT') {
      throw error
    }
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored batch mutation audit context is invalid',
    )
  }
}

export function hydrateBatchActorAudit(
  row: Readonly<StoredBatchActorAudit>,
  actorClientId: string,
): Readonly<ApiAccessAuditContext> {
  return canonicalAudit(row, actorClientId)
}

export function batchActorAuditData(
  audit: Readonly<ApiAccessAuditContext>,
  workspaceId: string,
  actorClientId: string,
) {
  const canonical = canonicalAudit({
    workspaceId: audit.workspaceId,
    actorCredentialId: audit.credentialId,
    actorEnvironment: audit.environment,
    actorAuthenticationKind: audit.authenticationKind,
    actorContextHash: audit.contextHash,
    delegatedUserId: audit.delegatedUserId ?? null,
    delegatedIdentityId: audit.delegatedIdentityId ?? null,
    workspaceRole: audit.workspaceRole ?? null,
  }, audit.clientId)
  if (
    canonical.workspaceId !== workspaceId ||
    canonical.clientId !== actorClientId
  ) {
    throw new DomainError(
      'AUTH_INVALID',
      'Batch mutation audit does not match its workspace and actor',
    )
  }
  return {
    actorCredentialId: canonical.credentialId,
    actorEnvironment: canonical.environment,
    actorAuthenticationKind: canonical.authenticationKind,
    actorContextHash: canonical.contextHash,
    ...(canonical.delegatedUserId
      ? { delegatedUserId: canonical.delegatedUserId }
      : {}),
    ...(canonical.delegatedIdentityId
      ? { delegatedIdentityId: canonical.delegatedIdentityId }
      : {}),
    ...(canonical.workspaceRole
      ? { workspaceRole: canonical.workspaceRole }
      : {}),
  }
}
