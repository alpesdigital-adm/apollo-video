import type { V2ProjectCreationCommand } from '../../../../generated/prisma-v2/index.js'

import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import { createApiAccessAuditContext } from '../../domain/api-access-control.ts'
import {
  createProjectCreationCommand,
  type ProjectCreationAction,
  type ProjectCreationCommand,
} from '../../domain/project-creation-command.ts'
import { DomainError } from '../../domain/errors.ts'
import type { WorkspaceMemberRole } from '../../domain/workspace-member.ts'

export function projectCreationCommandData(command: ProjectCreationCommand) {
  return {
    id: command.id,
    workspaceId: command.workspaceId,
    action: command.action,
    projectId: command.projectId,
    versionId: command.versionId,
    sourceProjectId: command.sourceProjectId,
    sourceVersionId: command.sourceVersionId,
    actorClientId: command.audit.clientId,
    actorCredentialId: command.audit.credentialId,
    actorEnvironment: command.audit.environment,
    actorAuthenticationKind: command.audit.authenticationKind,
    actorContextHash: command.audit.contextHash,
    actorDelegatedUserId: command.audit.delegatedUserId,
    actorDelegatedIdentityId: command.audit.delegatedIdentityId,
    actorWorkspaceRole: command.audit.workspaceRole,
    requestFingerprint: command.requestFingerprint,
    commandHash: command.commandHash,
    createdAt: new Date(command.createdAt),
  }
}

function hydrate(row: V2ProjectCreationCommand): Readonly<ProjectCreationCommand> {
  try {
    const audit = createApiAccessAuditContext({
      clientId: row.actorClientId,
      credentialId: row.actorCredentialId,
      workspaceId: row.workspaceId,
      environment: row.actorEnvironment as 'sandbox' | 'production',
      authenticationKind: row.actorAuthenticationKind as 'bearer' | 'ui-session',
      ...(row.actorDelegatedUserId ? { delegatedUserId: row.actorDelegatedUserId } : {}),
      ...(row.actorDelegatedIdentityId
        ? { delegatedIdentityId: row.actorDelegatedIdentityId }
        : {}),
      ...(row.actorWorkspaceRole
        ? { workspaceRole: row.actorWorkspaceRole as WorkspaceMemberRole }
        : {}),
    })
    const command = createProjectCreationCommand({
      id: row.id,
      workspaceId: row.workspaceId,
      action: row.action as ProjectCreationAction,
      projectId: row.projectId,
      versionId: row.versionId,
      ...(row.sourceProjectId ? { sourceProjectId: row.sourceProjectId } : {}),
      ...(row.sourceVersionId ? { sourceVersionId: row.sourceVersionId } : {}),
      audit,
      requestFingerprint: row.requestFingerprint,
      createdAt: row.createdAt.toISOString(),
    })
    if (
      row.actorContextHash !== audit.contextHash ||
      row.commandHash !== command.commandHash
    ) {
      throw new Error('hash mismatch')
    }
    return command
  } catch {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored project creation command failed integrity validation',
    )
  }
}

export function assertProjectCreationCommand(
  row: V2ProjectCreationCommand | null,
  expected: {
    workspaceId: string
    action: ProjectCreationAction
    projectId: string
    versionId: string
    sourceProjectId?: string
    sourceVersionId?: string
    audit: Readonly<ApiAccessAuditContext>
    requestFingerprint: string
  },
): Readonly<ProjectCreationCommand> {
  if (!row) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Project creation result is missing its audit command',
    )
  }
  const command = hydrate(row)
  if (
    command.workspaceId !== expected.workspaceId ||
    command.action !== expected.action ||
    command.projectId !== expected.projectId ||
    command.versionId !== expected.versionId ||
    command.sourceProjectId !== expected.sourceProjectId ||
    command.sourceVersionId !== expected.sourceVersionId ||
    command.audit.contextHash !== expected.audit.contextHash ||
    command.requestFingerprint !== expected.requestFingerprint
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Project creation audit command does not match its result',
    )
  }
  return command
}
