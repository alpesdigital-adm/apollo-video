import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type { CommandActor } from '../../domain/edit-command.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  externalActorAuditData,
  hydrateExternalActorAudit,
} from './external-actor-audit.ts'

export interface StoredEditCommandActorAudit {
  workspaceId: string
  actorType: string
  actorId: string
  delegatedUserId: string | null
  actorCredentialId: string | null
  actorEnvironment: string | null
  actorAuthenticationKind: string | null
  actorContextHash: string | null
  actorDelegatedIdentityId: string | null
  actorWorkspaceRole: string | null
}

export function hydrateEditCommandExternalActorAudit(
  row: Readonly<StoredEditCommandActorAudit>,
): Readonly<ApiAccessAuditContext> {
  if (row.actorType !== 'api-client') {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'External edit command has a non-external actor',
    )
  }
  return hydrateExternalActorAudit(
    {
      workspaceId: row.workspaceId,
      actorCredentialId: row.actorCredentialId,
      actorEnvironment: row.actorEnvironment,
      actorAuthenticationKind: row.actorAuthenticationKind,
      actorContextHash: row.actorContextHash,
      delegatedUserId: row.delegatedUserId,
      delegatedIdentityId: row.actorDelegatedIdentityId,
      workspaceRole: row.actorWorkspaceRole,
    },
    row.actorId,
  )
}

export function editCommandExternalActorAuditData(
  audit: Readonly<ApiAccessAuditContext>,
  workspaceId: string,
  actor: Readonly<CommandActor>,
) {
  if (
    actor.type !== 'api-client' ||
    actor.id !== audit.clientId ||
    actor.delegatedUserId !== audit.delegatedUserId
  ) {
    throw new DomainError(
      'AUTH_INVALID',
      'Edit command actor does not match its authentication audit',
    )
  }
  const stored = externalActorAuditData(audit, workspaceId, actor.id)
  return {
    actorCredentialId: stored.actorCredentialId,
    actorEnvironment: stored.actorEnvironment,
    actorAuthenticationKind: stored.actorAuthenticationKind,
    actorContextHash: stored.actorContextHash,
    actorDelegatedIdentityId: stored.delegatedIdentityId ?? null,
    actorWorkspaceRole: stored.workspaceRole ?? null,
  }
}
