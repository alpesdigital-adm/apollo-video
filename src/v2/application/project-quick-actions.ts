import { randomUUID } from 'node:crypto'

import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'
import type {
  ProjectAdministrationRepository,
  ProjectAdministrationResult,
} from './ports/project-administration-repository.ts'
import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import { canTransitionProjectStatus, createProject } from '../domain/project.ts'
import {
  calculateProjectAdministrationResultHash,
  createProjectAdministrationCommand,
  createProjectAdministrationState,
  type ProjectAdministrationAction,
} from '../domain/project-administration-command.ts'
import { createPublicEvent } from '../domain/public-event.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const IDEMPOTENCY_KEY = /^[\x21-\x7E]{8,128}$/

export function projectQuickActionsService(dependencies: {
  repository: ProjectAdministrationRepository
  clock?: () => Date
  createCommandId?: () => string
  createEventId?: () => string
}) {
  const clock = dependencies.clock ?? (() => new Date())
  const createCommandId = dependencies.createCommandId ??
    (() => `project-administration-${randomUUID()}`)
  const createEventId = dependencies.createEventId ?? randomUUID
  return async function execute(input: {
    actor: AuthenticatedExternalActor
    projectId: string
    action: ProjectAdministrationAction
    baseRevision: number
    idempotencyKey: string
    name?: string
    confirmed?: boolean
  }): Promise<Readonly<ProjectAdministrationResult>> {
    requireScope(input.actor, 'projects:write')
    const workspaceId = input.actor.workspaceId
    const projectId = input.projectId.trim()
    const idempotencyKey = input.idempotencyKey.trim()
    assertDomain(
      ID.test(projectId) && IDEMPOTENCY_KEY.test(idempotencyKey) &&
        Number.isSafeInteger(input.baseRevision) && input.baseRevision >= 1 &&
        ['rename', 'archive', 'restore'].includes(input.action),
      'INVALID_ARGUMENT',
      'project administration request is invalid',
    )
    if (input.action === 'archive') {
      assertDomain(
        input.confirmed === true,
        'TOOL_CONFIRMATION_REQUIRED',
        'project archive requires explicit confirmation',
      )
    } else {
      assertDomain(
        input.confirmed !== true,
        'INVALID_ARGUMENT',
        'confirmation is only accepted for project archive',
      )
    }
    assertDomain(
      input.action === 'rename'
        ? typeof input.name === 'string'
        : input.name === undefined,
      'INVALID_ARGUMENT',
      'project administration name is invalid',
    )
    const audit = materializeActorAuditContext(input.actor)
    const requestedName = input.name?.trim().replace(/\s+/g, ' ')
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'project-administration-request/v1',
      actorContextHash: audit.contextHash,
      workspaceId,
      projectId,
      action: input.action,
      baseRevision: input.baseRevision,
      name: requestedName ?? null,
      confirmed: input.confirmed === true,
    })
    const replay = await dependencies.repository.findReplay({
      workspaceId,
      actorContextHash: audit.contextHash,
      idempotencyKey,
      requestFingerprint,
    })
    if (replay) return replay
    const current = await dependencies.repository.read({ workspaceId, projectId })
    if (!current) {
      throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found')
    }
    if (current.state.revision !== input.baseRevision) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Project administration state changed before this command',
        {
          expectedRevision: input.baseRevision,
          currentRevision: current.state.revision,
        },
      )
    }
    assertDomain(
      input.action === 'archive'
        ? canTransitionProjectStatus(current.state.status, 'archived') &&
          current.state.status !== 'archived'
        : input.action === 'restore'
          ? current.state.status === 'archived' &&
            current.state.archivedFromStatus !== undefined
          : requestedName !== current.state.name,
      'INVALID_PROJECT',
      'project administration action does not change the current state',
    )
    const restoredStatus = input.action === 'restore'
      ? current.state.archivedFromStatus
      : undefined
    const after = createProjectAdministrationState({
      name: requestedName ?? current.state.name,
      status: input.action === 'archive'
        ? 'archived'
        : input.action === 'restore'
          ? restoredStatus as Exclude<typeof current.state.status, 'archived'>
          : current.state.status,
      ...(input.action === 'archive'
        ? {
            archivedFromStatus: current.state.status as Exclude<
              typeof current.state.status,
              'archived'
            >,
          }
        : input.action === 'rename' && current.state.archivedFromStatus
          ? { archivedFromStatus: current.state.archivedFromStatus }
          : {}),
      revision: current.state.revision + 1,
    })
    const occurredAt = clock().toISOString()
    const resultHash = calculateProjectAdministrationResultHash({
      projectId,
      state: after,
    })
    const command = createProjectAdministrationCommand({
      id: createCommandId(),
      workspaceId,
      projectId,
      action: input.action,
      before: current.state,
      after,
      confirmation: input.action === 'archive' ? 'explicit' : 'not-required',
      audit,
      idempotencyKey,
      requestFingerprint,
      resultHash,
      occurredAt,
    })
    const project = createProject({
      ...current.project,
      name: after.name,
      status: after.status,
    })
    const event = createPublicEvent({
      id: createEventId(),
      type: input.action === 'rename'
        ? 'project.name.changed'
        : 'project.status.changed',
      version: '1.0.0',
      workspaceId,
      occurredAt,
      sequence: after.revision,
      actor: {
        clientId: audit.clientId,
        ...(audit.delegatedUserId ? { userId: audit.delegatedUserId } : {}),
      },
      resource: { type: 'project', id: projectId },
      data: {
        action: input.action,
        baseRevision: current.state.revision,
        resultRevision: after.revision,
        ...(input.action === 'rename'
          ? {}
          : { previousStatus: current.state.status, status: after.status }),
      },
    })
    return dependencies.repository.apply({ project, command, audit, event })
  }
}
