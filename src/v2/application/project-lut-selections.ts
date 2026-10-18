import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { createEditCommand, type CommandActor } from '../domain/edit-command.ts'
import { DomainError } from '../domain/errors.ts'
import { createProjectLutSelection, projectLutRef, type ProjectLutSelectionRequest } from '../domain/project-lut-selection.ts'
import { reidentifiedEditPlanSnapshot, transitionProjectOutputState } from '../domain/project-output-state-transition.ts'
import { createPublicEvent } from '../domain/public-event.ts'
import { createProjectLutSelectionImpact } from '../domain/project-lut-selection-impact.ts'
import type { ApiAccessAuditContext } from '../domain/api-access-control.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'
import type { ProjectLutSelectionRepository } from './ports/project-lut-selection-repository.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
function id(value: unknown, field: string) { const normalized = typeof value === 'string' ? value.trim() : ''; if (!ID.test(normalized)) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`); return normalized }

type ProjectLutSelectionActor = AuthenticatedExternalActor | Readonly<CommandActor>

function commandActor(
  input: ProjectLutSelectionActor,
  workspaceId: string,
): Readonly<{
  author: Readonly<CommandActor>
  authenticationAudit?: Readonly<ApiAccessAuditContext>
}> {
  if (input && 'auditContext' in input) {
    requireScope(input, 'projects:write')
    const authenticationAudit = materializeActorAuditContext(input)
    if (authenticationAudit.workspaceId !== workspaceId) {
      throw new DomainError('AUTH_INVALID', 'Project LUT actor does not match the workspace')
    }
    const author: Readonly<CommandActor> = Object.freeze({
      type: 'api-client',
      id: authenticationAudit.clientId,
      ...(authenticationAudit.delegatedUserId
        ? { delegatedUserId: authenticationAudit.delegatedUserId }
        : {}),
    })
    return Object.freeze({ author, authenticationAudit })
  }
  if (!input || !['director', 'system'].includes(input.type)) {
    throw new DomainError('AUTH_INVALID', 'Project LUT command actor is not trusted')
  }
  const author: Readonly<CommandActor> = Object.freeze({
    type: input.type,
    id: id(input.id, 'actor.id'),
    ...(input.delegatedUserId ? { delegatedUserId: id(input.delegatedUserId, 'actor.delegatedUserId') } : {}),
  })
  return Object.freeze({ author })
}

export function setProjectLutSelectionService(dependencies: {
  repository: ProjectLutSelectionRepository
  createId: (kind: 'command' | 'version' | 'selection' | 'snapshot' | 'state' | 'materialization') => string
  createEventId: () => string
  clock?: () => Date
}) {
  const clock = dependencies.clock ?? (() => new Date())
  return async (request: {
    workspaceId: string; projectId: string; baseVersionId: string; baseHash: string
    selection: ProjectLutSelectionRequest; intensity?: number; reason?: string
    actor: ProjectLutSelectionActor; idempotencyKey: string
  }) => {
    const workspaceId = id(request.workspaceId, 'workspaceId'); const projectId = id(request.projectId, 'projectId')
    const baseVersionId = id(request.baseVersionId, 'baseVersionId'); const baseHash = request.baseHash?.trim()
    if (!/^[a-f0-9]{64}$/.test(baseHash)) throw new DomainError('INVALID_ARGUMENT', 'baseHash is invalid')
    const actor = commandActor(request.actor, workspaceId)
    const idempotencyKey = request.idempotencyKey?.trim()
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) throw new DomainError('INVALID_ARGUMENT', 'Idempotency-Key is invalid')
    if (!request.selection || !['workspace-default', 'lut-version', 'none'].includes(request.selection.mode)) throw new DomainError('INVALID_ARGUMENT', 'selection.mode is invalid')
    const requested: ProjectLutSelectionRequest = request.selection.mode === 'lut-version'
      ? Object.freeze({ mode: 'lut-version', lutId: id(request.selection.lutId, 'selection.lutId'), version: request.selection.version })
      : Object.freeze({ mode: request.selection.mode })
    if (requested.mode === 'lut-version' && (!Number.isSafeInteger(requested.version) || requested.version < 1)) throw new DomainError('INVALID_ARGUMENT', 'selection.version is invalid')
    if (request.intensity !== undefined && (!Number.isFinite(request.intensity) || request.intensity < 0 || request.intensity > 1)) throw new DomainError('INVALID_ARGUMENT', 'intensity is invalid')
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'set-project-lut-selection-request/v2',
      workspaceId, projectId, baseVersionId, baseHash, requested,
      intensity: request.intensity ?? null,
      reason: request.reason?.trim() ?? null,
      actorIdentity: actor.authenticationAudit
        ? { kind: 'external', contextHash: actor.authenticationAudit.contextHash }
        : { kind: 'internal', actor: actor.author },
    })
    const replay = await dependencies.repository.findIdempotent({ workspaceId, projectId, idempotencyKey })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with another project LUT selection')
      return replay.result
    }
    const context = await dependencies.repository.readContext({ workspaceId, projectId, requested })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Project LUT selection context was not found')
    const parent = context.parent; const currentVersion = parent.version
    if (currentVersion.id !== baseVersionId || currentVersion.baseHash !== baseHash) throw new DomainError('VERSION_CONFLICT', 'Project LUT selection base version is stale')
    const createdAt = clock().toISOString(); const commandId = id(dependencies.createId('command'), 'commandId'); const versionId = id(dependencies.createId('version'), 'versionId'); const snapshotId = id(dependencies.createId('snapshot'), 'snapshotId'); const stateId = id(dependencies.createId('state'), 'stateId')
    const intensity = request.intensity ?? context.resolvedLutVersion?.intensity.default ?? 1
    const resolved = context.resolvedLutVersion ? Object.freeze({ mode: 'lut-version' as const, lut: projectLutRef(context.resolvedLutVersion) }) : Object.freeze({ mode: 'none' as const })
    const selection = createProjectLutSelection({
      id: id(dependencies.createId('selection'), 'selectionId'), workspaceId, projectId, baseVersionId, resultVersionId: versionId, commandId,
      requested, resolved, ...(requested.mode === 'workspace-default' ? { workspaceDefaultRevision: context.workspaceDefaultRevision ?? 0 } : {}), intensity, createdAt,
    })
    const impact = createProjectLutSelectionImpact({
      commandId, baseVersionId, resultVersionId: versionId,
      selectionId: selection.id, selectionHash: selection.selectionHash,
      resolvedMode: selection.resolved.mode,
      ...(selection.resolved.mode === 'lut-version' ? {
        resolvedLutVersionId: selection.resolved.lut.versionId,
        resolvedLutRecordHash: selection.resolved.lut.recordHash,
      } : {}),
      intensity, durationFrames: context.currentDurationFrames,
      variantIds: context.variantIds, outputReferences: context.outputReferences,
    })
    const payload = Object.freeze({ schemaVersion: 2 as const, ...requested, intensity, impact })
    const command = createEditCommand({ id: commandId, workspaceId, projectId, baseVersionId, baseHash, author: actor.author, type: 'set-project-lut-selection', scope: { project: true }, payload, ...(request.reason?.trim() ? { reason: request.reason.trim() } : {}), idempotencyKey, createdAt })
    // The LUT lives in its own domain row; the EditPlan is the parent's under the new Version's identity.
    const bundle = transitionProjectOutputState({
      parent, command, audit: actor.authenticationAudit ?? null, requestFingerprint,
      allocation: { workspaceId, projectId, resultVersionId: versionId, stateId, parentVersionId: currentVersion.id, sequence: currentVersion.sequence + 1, createdBy: actor.author.id, createdAt },
      editPlanSnapshot: reidentifiedEditPlanSnapshot(parent, { snapshotId, versionId, createdAt }),
      createMaterializationId: () => id(dependencies.createId('materialization'), 'materializationId'),
    })
    const version = bundle.version
    const event = createPublicEvent({
      id: dependencies.createEventId(), type: 'project.version.created', version: '1.0.0', workspaceId, occurredAt: createdAt, sequence: version.sequence,
      actor: actor.author.type === 'api-client' ? { clientId: actor.author.id, ...(actor.author.delegatedUserId ? { userId: actor.author.delegatedUserId } : {}) } : { userId: actor.author.id },
      resource: { type: 'project-version', id: version.id }, data: { projectId, sequence: version.sequence, parentVersionId: version.parentVersionId, baseHash: version.baseHash, commandId, commandType: command.type, selectionHash: selection.selectionHash, commandImpactHash: impact.impactHash, artifactInvalidationCount: impact.affectedArtifacts.length, createdAt },
    })
    return dependencies.repository.commitOrReplay({ bundle, selection, event })
  }
}

export function readProjectLutSelectionService(dependencies: { repository: ProjectLutSelectionRepository }) {
  return async (input: { workspaceId: string; projectId: string }) => dependencies.repository.readCurrent({ workspaceId: id(input.workspaceId, 'workspaceId'), projectId: id(input.projectId, 'projectId') })
}
