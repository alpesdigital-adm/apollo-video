import { calculateVersionHash, stableSerialize } from './version-hash.ts'
import type {
  ManualEditRepository,
  ManualEditResult,
} from './ports/manual-edit-repository.ts'
import {
  createEditCommand,
} from '../domain/edit-command.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  materializeManualEditPlan,
  materializeManualRestorePlan,
  timelineViewModelFromEditPlan,
  validateManualGesture,
  type ManualGesture,
  type ManualVersionAction,
  type PersistedManualEditPayload,
} from '../domain/manual-editing.ts'
import { createProjectSnapshot } from '../domain/project-snapshot.ts'
import { createProjectVersion } from '../domain/project-version.ts'
import { createPublicEvent } from '../domain/public-event.ts'
import { createManualCommandImpact } from '../domain/command-impact.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'

function identity(value: string, field: string): string {
  const normalized = value.trim()
  assertDomain(
    /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(normalized),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return normalized
}

export function readManualTimelineService(dependencies: {
  repository: ManualEditRepository
}) {
  return async function read(input: {
    workspaceId: string
    projectId: string
    selectedClipId?: string
  }) {
    const workspaceId = identity(input.workspaceId, 'workspaceId')
    const projectId = identity(input.projectId, 'projectId')
    const context = await dependencies.repository.readContext({ workspaceId, projectId })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Project timeline was not found')
    return Object.freeze({
      timeline: timelineViewModelFromEditPlan({
        editPlan: context.editPlan,
        versionId: context.version.id,
        revision: context.version.sequence,
        ...(input.selectedClipId ? { selectedClipId: input.selectedClipId } : {}),
      }),
      baseHash: context.version.baseHash,
      editPlanHash: context.editPlanHash,
      history: context.history,
    })
  }
}

export function readArtifactInvalidationsService(dependencies: {
  repository: ManualEditRepository
}) {
  return async function read(input: {
    workspaceId: string
    projectId: string
    resultVersionId?: string
  }) {
    const workspaceId = identity(input.workspaceId, 'workspaceId')
    const projectId = identity(input.projectId, 'projectId')
    const resultVersionId = input.resultVersionId
      ? identity(input.resultVersionId, 'resultVersionId')
      : undefined
    const result = await dependencies.repository.readArtifactInvalidations({
      workspaceId,
      projectId,
      ...(resultVersionId ? { resultVersionId } : {}),
    })
    if (!result) {
      throw new DomainError(
        'PROJECT_NOT_FOUND',
        'Project version artifact invalidations were not found',
      )
    }
    return result
  }
}

export function applyManualEditService(dependencies: {
  repository: ManualEditRepository
  clock: () => Date
  createId: (kind: 'edit-command' | 'project-version' | 'project-snapshot') => string
  createEventId: () => string
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    baseVersionId: string
    baseHash: string
    expectedRevision: number
    action: ManualVersionAction
    variantId: string
    targetId: string
    operation?: ManualGesture
    targetVersionId?: string
    reason?: string
    actor: Readonly<AuthenticatedExternalActor>
    idempotencyKey: string
  }): Promise<ManualEditResult> {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const baseVersionId = identity(request.baseVersionId, 'baseVersionId')
    const variantId = identity(request.variantId, 'variantId')
    const targetId = identity(request.targetId, 'targetId')
    const idempotencyKey = request.idempotencyKey.trim()
    assertDomain(
      /^[a-f0-9]{64}$/.test(request.baseHash),
      'INVALID_ARGUMENT',
      'baseHash must be a SHA-256 digest',
    )
    assertDomain(
      Number.isInteger(request.expectedRevision) && request.expectedRevision >= 1,
      'INVALID_ARGUMENT',
      'expectedRevision is invalid',
    )
    assertDomain(
      ['apply', 'undo', 'redo', 'restore'].includes(request.action),
      'INVALID_ARGUMENT',
      'Manual edit action is invalid',
    )
    assertDomain(
      idempotencyKey.length >= 8 && idempotencyKey.length <= 128,
      'INVALID_ARGUMENT',
      'Idempotency-Key is invalid',
    )
    requireScope(request.actor, 'projects:write')
    const authenticationAudit = materializeActorAuditContext(request.actor)
    assertDomain(authenticationAudit.workspaceId === workspaceId, 'AUTH_INVALID', 'Manual edit actor does not belong to the workspace')
    const operation = request.operation ? validateManualGesture(request.operation) : undefined
    if (request.action === 'apply') {
      assertDomain(Boolean(operation), 'INVALID_ARGUMENT', 'Apply requires one manual operation')
      assertDomain(
        !request.targetVersionId && operation!.clipId === targetId,
        'INVALID_ARGUMENT',
        'Manual operation must match its declared target',
      )
    } else {
      assertDomain(
        !operation && Boolean(request.targetVersionId),
        'INVALID_ARGUMENT',
        'Undo and redo require targetVersionId and do not accept operation',
      )
    }
    const targetVersionId = request.targetVersionId
      ? identity(request.targetVersionId, 'targetVersionId')
      : undefined
    const requestFingerprint = calculateVersionHash({
      type: 'manual-edit',
      workspaceId,
      projectId,
      baseVersionId,
      baseHash: request.baseHash,
      expectedRevision: request.expectedRevision,
      action: request.action,
      variantId,
      targetId,
      operation: operation ?? null,
      targetVersionId: targetVersionId ?? null,
      reason: request.reason?.trim() || null,
      actorContextHash: authenticationAudit.contextHash,
    })
    const existing = await dependencies.repository.findIdempotentResult({
      workspaceId,
      projectId,
      idempotencyKey,
      actorContextHash: authenticationAudit.contextHash,
    })
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Idempotency key was used with a different manual edit',
        )
      }
      return Object.freeze({ ...existing.result, replayed: true })
    }
    const context = await dependencies.repository.readContext({
      workspaceId,
      projectId,
      ...(targetVersionId ? { targetVersionId } : {}),
    })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Project or restore target was not found')
    assertDomain(
      context.renderVariantIds.includes(variantId),
      'INVALID_ARGUMENT',
      'Manual edit variant is not configured for this project',
    )
    if (
      context.version.id !== baseVersionId ||
      context.version.baseHash !== request.baseHash ||
      context.version.sequence !== request.expectedRevision
    ) {
      throw new DomainError('VERSION_CONFLICT', 'Manual edit base version is stale', {
        currentVersionId: context.version.id,
        currentBaseHash: context.version.baseHash,
        currentRevision: context.version.sequence,
      })
    }
    if (request.action === 'undo') {
      assertDomain(
        context.version.parentVersionId === targetVersionId,
        'INVALID_ARGUMENT',
        'Undo must restore the direct parent of the current version',
      )
    }
    if (request.action === 'redo') {
      assertDomain(
        targetVersionId !== context.version.id,
        'INVALID_ARGUMENT',
        'Redo target must differ from the current version',
      )
    }
    if (request.action === 'restore') {
      assertDomain(
        targetVersionId !== context.version.id,
        'INVALID_ARGUMENT',
        'Restore target must differ from the current version',
      )
    }
    const createdAt = dependencies.clock().toISOString()
    const commandId = dependencies.createId('edit-command')
    const versionId = dependencies.createId('project-version')
    const snapshotId = dependencies.createId('project-snapshot')
    const editPlan = request.action === 'apply'
      ? materializeManualEditPlan({
          editPlan: context.editPlan,
          operation: operation!,
          newVersionId: versionId,
          createdAt,
          availableAssetIds: context.availableAssetIds,
          variantId,
        })
      : materializeManualRestorePlan({
          targetEditPlan: context.targetVersion!.editPlan,
          action: request.action,
          targetVersionId: targetVersionId!,
          newVersionId: versionId,
          createdAt,
          variantId,
        })
    const editPlanJson = stableSerialize(editPlan)
    const editPlanHash = calculateVersionHash(editPlan)
    const impact = createManualCommandImpact({
      commandId,
      baseVersionId,
      resultVersionId: versionId,
      variantId,
      targetId,
      action: request.action,
      ...(operation ? { operation } : {}),
      beforeEditPlan: context.editPlan,
      afterEditPlan: editPlan,
      outputReferences: context.outputReferences,
    })
    const payload: Readonly<PersistedManualEditPayload> = Object.freeze({
      schemaVersion: 2,
      action: request.action,
      expectedRevision: request.expectedRevision,
      variantId,
      targetId,
      ...(operation ? { operation } : {}),
      ...(targetVersionId ? { restoresVersionId: targetVersionId } : {}),
      impact,
    })
    const command = createEditCommand<PersistedManualEditPayload>({
      id: commandId,
      workspaceId,
      projectId,
      baseVersionId,
      baseHash: request.baseHash,
      author: {
        type: 'api-client', id: authenticationAudit.clientId,
        ...(authenticationAudit.delegatedUserId
          ? { delegatedUserId: authenticationAudit.delegatedUserId }
          : {}),
      },
      type: 'manual-edit',
      scope: {
        clipIds: [targetId],
        outputSpecIds: [variantId],
      },
      payload,
      ...(request.reason?.trim() ? { reason: request.reason.trim() } : {}),
      idempotencyKey,
      createdAt,
    })
    const snapshot = createProjectSnapshot({
      id: snapshotId,
      workspaceId,
      projectId,
      kind: 'edit-plan',
      contentSchemaVersion: 2,
      contentJson: editPlanJson,
      contentHash: editPlanHash,
      createdAt,
    })
    const version = createProjectVersion({
      id: versionId,
      workspaceId,
      projectId,
      sequence: context.version.sequence + 1,
      parentVersionId: context.version.id,
      snapshotRefs: { ...context.version.snapshotRefs, editPlan: snapshotId },
      baseHash: calculateVersionHash({
        projectId,
        sequence: context.version.sequence + 1,
        parentVersionId: context.version.id,
        previousBaseHash: context.version.baseHash,
        commandId,
        editPlanHash,
        action: request.action,
        targetVersionId: targetVersionId ?? null,
      }),
      createdBy: authenticationAudit.clientId,
      commandId,
      createdAt,
    })
    const comparison = Object.freeze({
      beforeVersionId: context.version.id,
      afterVersionId: version.id,
      beforeEditPlanHash: context.editPlanHash,
      afterEditPlanHash: editPlanHash,
      action: request.action,
      targetId,
    })
    const event = createPublicEvent({
      id: dependencies.createEventId(),
      type: 'project.version.created',
      version: '1.0.0',
      workspaceId,
      occurredAt: createdAt,
      sequence: version.sequence,
      actor: {
        clientId: authenticationAudit.clientId,
        ...(authenticationAudit.delegatedUserId
          ? { userId: authenticationAudit.delegatedUserId }
          : {}),
      },
      resource: { type: 'project-version', id: version.id },
      data: {
        projectId,
        sequence: version.sequence,
        parentVersionId: version.parentVersionId,
        baseHash: version.baseHash,
        commandId,
        commandType: command.type,
        manualAction: request.action,
        targetId,
        commandImpactHash: impact.impactHash,
        invalidatedArtifactCount: impact.affectedArtifacts.length,
        minimalRenderCount: impact.minimalRenders.length,
        restoresVersionId: targetVersionId ?? null,
        snapshotRefs: version.snapshotRefs,
        createdAt,
      },
    })
    return dependencies.repository.commitOrReplay({
      command,
      authenticationAudit,
      requestFingerprint,
      snapshot,
      version,
      event,
      comparison,
      impact,
    })
  }
}
