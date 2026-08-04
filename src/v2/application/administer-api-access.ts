import { randomUUID } from 'node:crypto'

import { requireScope, type AuthenticatedExternalActor } from './authenticate-api-client.ts'
import type {
  ApiAccessCommandResult,
  ApiAccessControlRepository,
} from './ports/api-access-control-repository.ts'
import { calculateVersionHash } from './version-hash.ts'
import {
  API_ACCESS_ACTIONS,
  API_ACCESS_TARGET_TYPES,
  createApiAccessAuditContext,
  createApiAccessControl,
  transitionApiAccessControl,
  type ApiAccessAction,
  type ApiAccessCommand,
  type ApiAccessTargetType,
} from '../domain/api-access-control.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import type { WorkspaceMemberRole } from '../domain/workspace-member.ts'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

function assertAdministrator(actor: AuthenticatedExternalActor, workspaceId: string): void {
  if (actor.workspaceId !== workspaceId) {
    throw new DomainError('WORKSPACE_NOT_FOUND', 'Workspace was not found')
  }
  requireScope(actor, 'clients:admin')
}

function validateTarget(input: {
  workspaceId: string
  targetType: ApiAccessTargetType
  targetId: string
}): void {
  assertDomain(
    ID_PATTERN.test(input.workspaceId) &&
      ID_PATTERN.test(input.targetId) &&
      API_ACCESS_TARGET_TYPES.includes(input.targetType) &&
      (input.targetType !== 'workspace' || input.targetId === input.workspaceId),
    'INVALID_ARGUMENT',
    'API access target is invalid',
  )
}

export function readApiAccessControlService(dependencies: {
  repository: ApiAccessControlRepository
}) {
  return async function execute(request: {
    actor: AuthenticatedExternalActor
    workspaceId: string
    targetType: ApiAccessTargetType
    targetId: string
  }) {
    assertAdministrator(request.actor, request.workspaceId)
    validateTarget(request)
    const access = await dependencies.repository.find(request)
    if (!access) throw new DomainError('API_CLIENT_NOT_FOUND', 'API access target was not found')
    return access
  }
}

export function changeApiAccessControlService(dependencies: {
  repository: ApiAccessControlRepository
  clock?: () => Date
  createId?: () => string
}) {
  const clock = dependencies.clock ?? (() => new Date())
  const createId = dependencies.createId ?? (() => `api-access-command-${randomUUID()}`)
  return async function execute(request: {
    actor: AuthenticatedExternalActor
    workspaceId: string
    targetType: ApiAccessTargetType
    targetId: string
    action: ApiAccessAction
    baseRevision: string
    reason: string
    idempotencyKey: string
    confirmed: boolean
  }): Promise<Readonly<ApiAccessCommandResult>> {
    assertAdministrator(request.actor, request.workspaceId)
    validateTarget(request)
    assertDomain(API_ACCESS_ACTIONS.includes(request.action), 'INVALID_ARGUMENT', 'API access action is invalid')
    if (
      request.targetType === 'client' && request.targetId === request.actor.clientId &&
      (request.action === 'suspend' || request.action === 'revoke')
    ) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'The client authenticating this request cannot deactivate itself')
    }
    assertDomain(request.confirmed === true, 'TOOL_CONFIRMATION_REQUIRED', 'API access change requires explicit confirmation')
    const reason = request.reason.trim().replace(/\s+/g, ' ')
    const idempotencyKey = request.idempotencyKey.trim()
    assertDomain(reason.length >= 3 && reason.length <= 500, 'INVALID_ARGUMENT', 'API access reason must contain 3-500 characters')
    assertDomain(idempotencyKey.length >= 1 && idempotencyKey.length <= 128, 'INVALID_ARGUMENT', 'Idempotency-Key is invalid')
    assertDomain(/^[a-f0-9]{64}$/.test(request.baseRevision), 'INVALID_ARGUMENT', 'API access base revision is invalid')

    const audit = createApiAccessAuditContext({
      clientId: request.actor.auditContext.clientId,
      credentialId: request.actor.auditContext.credentialId,
      workspaceId: request.actor.auditContext.workspaceId,
      environment: request.actor.auditContext.environment,
      authenticationKind: request.actor.authenticationKind,
      ...(request.actor.auditContext.delegatedUserId
        ? { delegatedUserId: request.actor.auditContext.delegatedUserId }
        : {}),
      ...(request.actor.auditContext.delegatedIdentityId
        ? { delegatedIdentityId: request.actor.auditContext.delegatedIdentityId }
        : {}),
      ...(request.actor.auditContext.workspaceRole
        ? { workspaceRole: request.actor.auditContext.workspaceRole as WorkspaceMemberRole }
        : {}),
    })

    const requestFingerprint = calculateVersionHash({
      operation: 'api-access.change',
      actorContextHash: audit.contextHash,
      workspaceId: request.workspaceId,
      targetType: request.targetType,
      targetId: request.targetId,
      action: request.action,
      baseRevision: request.baseRevision,
      reason,
    })
    const replay = await dependencies.repository.findReplay({
      workspaceId: request.workspaceId,
      actorClientId: request.actor.clientId,
      actorContextHash: audit.contextHash,
      idempotencyKey,
      requestFingerprint,
    })
    if (replay) return replay

    const current = await dependencies.repository.find(request)
    if (!current) throw new DomainError('API_CLIENT_NOT_FOUND', 'API access target was not found')
    if (current.revision !== request.baseRevision) {
      throw new DomainError('VERSION_CONFLICT', 'API access state changed before this command', {
        expectedRevision: request.baseRevision,
        currentRevision: current.revision,
      })
    }
    const changedAt = clock().toISOString()
    assertDomain(!Number.isNaN(Date.parse(changedAt)), 'INVALID_ARGUMENT', 'API access command clock is invalid')
    const transition = transitionApiAccessControl(current, request.action)
    const resultRevision = calculateVersionHash({
      previousRevision: current.revision,
      requestFingerprint,
      actorClientId: request.actor.clientId,
      delegatedUserId: request.actor.delegatedUserId ?? null,
      actorContextHash: audit.contextHash,
      changedAt,
    })
    const command: ApiAccessCommand = Object.freeze({
      schemaVersion: 1,
      id: createId(),
      workspaceId: request.workspaceId,
      targetType: request.targetType,
      targetId: request.targetId,
      action: request.action,
      baseRevision: current.revision,
      resultRevision,
      ...transition,
      reason,
      actorClientId: request.actor.clientId,
      ...(request.actor.delegatedUserId ? { delegatedUserId: request.actor.delegatedUserId } : {}),
      idempotencyKey,
      requestFingerprint,
      changedAt,
    })
    const result = await dependencies.repository.apply(command, audit)
    createApiAccessControl({
      workspaceId: result.access.workspaceId,
      targetType: result.access.targetType,
      targetId: result.access.targetId,
      status: result.access.status,
      killSwitchEngaged: result.access.killSwitchEngaged,
      revision: result.access.revision,
    })
    return result
  }
}
