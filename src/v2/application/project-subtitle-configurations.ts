import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { createEditCommand, type CommandActor } from '../domain/edit-command.ts'
import { DomainError } from '../domain/errors.ts'
import {
  createProjectSubtitleConfiguration,
  createProjectSubtitleConfigurationImpact,
  resolveProjectSubtitleRevertTarget,
  type ProjectSubtitleConfigurationAction,
} from '../domain/project-subtitle-configuration.ts'
import { createProjectVersion } from '../domain/project-version.ts'
import { resolveSubtitleConfig, validateSubtitleConfig, type SubtitleModeRequest } from '../domain/subtitle-system.ts'
import { materializeActorAuditContext, requireScope, type AuthenticatedExternalActor } from './authenticate-api-client.ts'
import type { ProjectSubtitleConfigurationRepository } from './ports/project-subtitle-configuration-repository.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const id = (value: unknown, field: string) => { const parsed = typeof value === 'string' ? value.trim() : ''; if (!ID.test(parsed)) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`); return parsed }

export function setProjectSubtitleConfigurationService(dependencies: {
  repository: ProjectSubtitleConfigurationRepository
  createId: (kind: 'command' | 'version' | 'configuration') => string
  clock?: () => Date
}) {
  return async (request: {
    workspaceId: string; projectId: string; baseVersionId: string; baseHash: string; variantId: string
    action?: ProjectSubtitleConfigurationAction
    requested?: SubtitleModeRequest
    actor: AuthenticatedExternalActor; idempotencyKey: string; reason?: string
  }) => {
    const workspaceId = id(request.workspaceId, 'workspaceId'); const projectId = id(request.projectId, 'projectId')
    const baseVersionId = id(request.baseVersionId, 'baseVersionId'); const variantId = id(request.variantId, 'variantId')
    if (!/^[a-f0-9]{64}$/.test(request.baseHash)) throw new DomainError('INVALID_ARGUMENT', 'baseHash is invalid')
    const action: ProjectSubtitleConfigurationAction = request.action ?? 'set'
    if (action !== 'set' && action !== 'revert') throw new DomainError('INVALID_ARGUMENT', 'action is invalid')
    if (action === 'set' && !request.requested) throw new DomainError('INVALID_ARGUMENT', 'A set action requires a subtitle mode')
    if (action === 'revert' && request.requested) throw new DomainError('INVALID_ARGUMENT', 'A revert action cannot carry a subtitle mode')
    requireScope(request.actor, 'projects:write'); const audit = materializeActorAuditContext(request.actor)
    if (audit.workspaceId !== workspaceId) throw new DomainError('AUTH_INVALID', 'Subtitle configuration actor does not match workspace')
    const idempotencyKey = request.idempotencyKey?.trim(); if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) throw new DomainError('INVALID_ARGUMENT', 'Idempotency-Key is invalid')
    const requestFingerprint = calculateCanonicalHash({ schemaVersion: 'set-project-subtitle-configuration-request/v1', workspaceId, projectId, baseVersionId, baseHash: request.baseHash, variantId, action, requested: request.requested ?? null, reason: request.reason?.trim() ?? null, actorContextHash: audit.contextHash })
    const replay = await dependencies.repository.findIdempotent({ workspaceId, projectId, idempotencyKey })
    if (replay) { if (replay.requestFingerprint !== requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with another subtitle configuration'); return replay.result }
    const context = await dependencies.repository.readContext({ workspaceId, projectId, variantId, ...(request.requested ? { requested: request.requested } : {}) })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Subtitle configuration context was not found')
    if (context.currentVersion.id !== baseVersionId || context.currentVersion.baseHash !== request.baseHash) throw new DomainError('VERSION_CONFLICT', 'Subtitle configuration base version is stale')
    if (action === 'revert' && !context.currentConfiguration) throw new DomainError('INVALID_ARGUMENT', 'There is no subtitle configuration to revert on this variant')
    const requested = action === 'revert'
      ? resolveProjectSubtitleRevertTarget({ current: context.currentConfiguration, previous: context.previousConfiguration })
      : request.requested!
    if (requested.mode === 'workspace-default' && !context.workspaceDefault) throw new DomainError('INVALID_ARGUMENT', 'Workspace subtitle default is not configured')
    const resolved = resolveSubtitleConfig({ requested, variantId, transcript: context.transcript, directorPreset: context.directorPresetId, workspacePreset: context.workspaceDefault?.presetId, workspaceDefaultRevision: context.workspaceDefault?.revision })
    validateSubtitleConfig(resolved, context.transcript)
    const createdAt = (dependencies.clock ?? (() => new Date()))().toISOString(); const commandId = id(dependencies.createId('command'), 'commandId'); const versionId = id(dependencies.createId('version'), 'versionId')
    const configuration = createProjectSubtitleConfiguration({ id: id(dependencies.createId('configuration'), 'configurationId'), workspaceId, projectId, baseVersionId, resultVersionId: versionId, commandId, variantId, action, previousConfigurationId: context.currentConfiguration?.id ?? null, requested: resolved.requested, resolved: resolved.resolved, origin: resolved.origin, transcriptHash: resolved.transcriptHash, ...(resolved.workspaceDefaultRevision !== undefined ? { workspaceDefaultRevision: resolved.workspaceDefaultRevision } : {}), createdAt })
    const impact = createProjectSubtitleConfigurationImpact({ commandId, baseVersionId, resultVersionId: versionId, variantId, configurationId: configuration.id, configurationHash: configuration.configurationHash, action, requestedMode: configuration.requested.mode, origin: configuration.origin, resolvedPresetId: configuration.resolved.enabled ? configuration.resolved.presetId : null, resolvedPresetHash: configuration.resolved.enabled ? configuration.resolved.presetHash : null, transcriptHash: configuration.transcriptHash, durationFrames: context.durationFrames, affectedArtifacts: context.outputReferences })
    const author: Readonly<CommandActor> = Object.freeze({ type: 'api-client', id: audit.clientId, ...(audit.delegatedUserId ? { delegatedUserId: audit.delegatedUserId } : {}) })
    const command = createEditCommand({ id: commandId, workspaceId, projectId, baseVersionId, baseHash: request.baseHash, author, type: 'set-project-subtitle-mode', scope: { outputSpecIds: [variantId] }, payload: Object.freeze({ schemaVersion: 1 as const, variantId, action, requested: resolved.requested, impact }), ...(request.reason?.trim() ? { reason: request.reason.trim() } : {}), idempotencyKey, createdAt })
    const version = createProjectVersion({ id: versionId, workspaceId, projectId, sequence: context.currentVersion.sequence + 1, parentVersionId: baseVersionId, snapshotRefs: context.currentVersion.snapshotRefs, baseHash: calculateCanonicalHash({ schemaVersion: 'project-version-subtitle-configuration/v1', previousBaseHash: request.baseHash, commandId, configurationHash: configuration.configurationHash, impactHash: impact.impactHash }), createdBy: audit.clientId, commandId, createdAt })
    return dependencies.repository.commitOrReplay({ requestFingerprint, authenticationAudit: audit, command, version, configuration, impact })
  }
}

export function readProjectSubtitleConfigurationService(dependencies: { repository: ProjectSubtitleConfigurationRepository }) {
  return (input: { workspaceId: string; projectId: string; variantId: string }) => dependencies.repository.readCurrent({ workspaceId: id(input.workspaceId, 'workspaceId'), projectId: id(input.projectId, 'projectId'), variantId: id(input.variantId, 'variantId') })
}
