import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { createEditCommand, type CommandActor } from '../domain/edit-command.ts'
import { DomainError } from '../domain/errors.ts'
import { createProjectLutSelection, projectLutRef, type ProjectLutSelectionRequest } from '../domain/project-lut-selection.ts'
import { createProjectVersion } from '../domain/project-version.ts'
import { createPublicEvent } from '../domain/public-event.ts'
import type { ProjectLutSelectionRepository } from './ports/project-lut-selection-repository.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
function id(value: unknown, field: string) { const normalized = typeof value === 'string' ? value.trim() : ''; if (!ID.test(normalized)) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`); return normalized }

export function setProjectLutSelectionService(dependencies: {
  repository: ProjectLutSelectionRepository
  createId: (kind: 'command' | 'version' | 'selection') => string
  createEventId: () => string
  clock?: () => Date
}) {
  const clock = dependencies.clock ?? (() => new Date())
  return async (request: {
    workspaceId: string; projectId: string; baseVersionId: string; baseHash: string
    selection: ProjectLutSelectionRequest; intensity?: number; reason?: string
    actor: Readonly<CommandActor>; idempotencyKey: string
  }) => {
    const workspaceId = id(request.workspaceId, 'workspaceId'); const projectId = id(request.projectId, 'projectId')
    const baseVersionId = id(request.baseVersionId, 'baseVersionId'); const baseHash = request.baseHash?.trim()
    if (!/^[a-f0-9]{64}$/.test(baseHash)) throw new DomainError('INVALID_ARGUMENT', 'baseHash is invalid')
    if (!request.actor || !['user', 'director', 'system', 'api-client'].includes(request.actor.type)) throw new DomainError('INVALID_ARGUMENT', 'actor is invalid')
    id(request.actor.id, 'actor.id')
    const idempotencyKey = request.idempotencyKey?.trim()
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) throw new DomainError('INVALID_ARGUMENT', 'Idempotency-Key is invalid')
    if (!request.selection || !['workspace-default', 'lut-version', 'none'].includes(request.selection.mode)) throw new DomainError('INVALID_ARGUMENT', 'selection.mode is invalid')
    const requested: ProjectLutSelectionRequest = request.selection.mode === 'lut-version'
      ? Object.freeze({ mode: 'lut-version', lutId: id(request.selection.lutId, 'selection.lutId'), version: request.selection.version })
      : Object.freeze({ mode: request.selection.mode })
    if (requested.mode === 'lut-version' && (!Number.isSafeInteger(requested.version) || requested.version < 1)) throw new DomainError('INVALID_ARGUMENT', 'selection.version is invalid')
    if (request.intensity !== undefined && (!Number.isFinite(request.intensity) || request.intensity < 0 || request.intensity > 1)) throw new DomainError('INVALID_ARGUMENT', 'intensity is invalid')
    const requestFingerprint = calculateCanonicalHash({ schemaVersion: 'set-project-lut-selection-request/v1', workspaceId, projectId, baseVersionId, baseHash, requested, intensity: request.intensity ?? null, reason: request.reason?.trim() ?? null, actor: request.actor })
    const replay = await dependencies.repository.findIdempotent({ workspaceId, projectId, idempotencyKey })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with another project LUT selection')
      return replay.result
    }
    const context = await dependencies.repository.readContext({ workspaceId, projectId, requested })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Project LUT selection context was not found')
    if (context.currentVersion.id !== baseVersionId || context.currentVersion.baseHash !== baseHash) throw new DomainError('VERSION_CONFLICT', 'Project LUT selection base version is stale')
    const createdAt = clock().toISOString(); const commandId = id(dependencies.createId('command'), 'commandId'); const versionId = id(dependencies.createId('version'), 'versionId')
    const intensity = request.intensity ?? context.resolvedLutVersion?.intensity.default ?? 1
    const payload = Object.freeze({ ...requested, intensity }) as ProjectLutSelectionRequest & { intensity: number }
    const command = createEditCommand({ id: commandId, workspaceId, projectId, baseVersionId, baseHash, author: request.actor, type: 'set-project-lut-selection', scope: { project: true }, payload, ...(request.reason?.trim() ? { reason: request.reason.trim() } : {}), idempotencyKey, createdAt })
    const resolved = context.resolvedLutVersion ? Object.freeze({ mode: 'lut-version' as const, lut: projectLutRef(context.resolvedLutVersion) }) : Object.freeze({ mode: 'none' as const })
    const selection = createProjectLutSelection({
      id: id(dependencies.createId('selection'), 'selectionId'), workspaceId, projectId, baseVersionId, resultVersionId: versionId, commandId,
      requested, resolved, ...(requested.mode === 'workspace-default' ? { workspaceDefaultRevision: context.workspaceDefaultRevision ?? 0 } : {}), intensity, createdAt,
    })
    const version = createProjectVersion({
      id: versionId, workspaceId, projectId, sequence: context.currentVersion.sequence + 1, parentVersionId: context.currentVersion.id,
      snapshotRefs: context.currentVersion.snapshotRefs,
      baseHash: calculateCanonicalHash({ schemaVersion: 'project-version-lut-selection/v1', previousBaseHash: context.currentVersion.baseHash, commandId, selectionHash: selection.selectionHash }),
      createdBy: request.actor.id, commandId, createdAt,
    })
    const event = createPublicEvent({
      id: dependencies.createEventId(), type: 'project.version.created', version: '1.0.0', workspaceId, occurredAt: createdAt, sequence: version.sequence,
      actor: request.actor.type === 'api-client' ? { clientId: request.actor.id, ...(request.actor.delegatedUserId ? { userId: request.actor.delegatedUserId } : {}) } : { userId: request.actor.id },
      resource: { type: 'project-version', id: version.id }, data: { projectId, sequence: version.sequence, parentVersionId: version.parentVersionId, baseHash: version.baseHash, commandId, commandType: command.type, selectionHash: selection.selectionHash, createdAt },
    })
    return dependencies.repository.commitOrReplay({ command, version, selection, requestFingerprint, event })
  }
}

export function readProjectLutSelectionService(dependencies: { repository: ProjectLutSelectionRepository }) {
  return async (input: { workspaceId: string; projectId: string }) => dependencies.repository.readCurrent({ workspaceId: id(input.workspaceId, 'workspaceId'), projectId: id(input.projectId, 'projectId') })
}
