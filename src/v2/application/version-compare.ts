import { calculateVersionHash } from './version-hash.ts'
import type { ManualEditRepository } from './ports/manual-edit-repository.ts'
import type {
  PersistedVersionCompareDecision,
  VersionCompareRepository,
} from './ports/version-compare-repository.ts'
import { createCompareActionImpact } from '../domain/compare-action-impact.ts'
import {
  createEditCommand,
} from '../domain/edit-command.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  versionComparisonFromEditPlans,
  type VersionCompareMode,
} from '../domain/manual-editing.ts'
import { createPublicEvent } from '../domain/public-event.ts'
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

function compareMode(value: string): VersionCompareMode {
  assertDomain(
    ['toggle', 'split', 'overlay'].includes(value),
    'INVALID_ARGUMENT',
    'Version compare mode is invalid',
  )
  return value as VersionCompareMode
}

export function readVersionComparisonService(dependencies: {
  repository: ManualEditRepository
}) {
  return async function read(input: {
    workspaceId: string
    projectId: string
    beforeVersionId: string
    afterVersionId: string
    mode: VersionCompareMode
  }) {
    const workspaceId = identity(input.workspaceId, 'workspaceId')
    const projectId = identity(input.projectId, 'projectId')
    const beforeVersionId = identity(input.beforeVersionId, 'beforeVersionId')
    const afterVersionId = identity(input.afterVersionId, 'afterVersionId')
    const mode = compareMode(input.mode)
    assertDomain(
      beforeVersionId !== afterVersionId,
      'INVALID_ARGUMENT',
      'Version comparison requires two different versions',
    )
    const [beforeContext, afterContext] = await Promise.all([
      dependencies.repository.readContext({ workspaceId, projectId, targetVersionId: beforeVersionId }),
      dependencies.repository.readContext({ workspaceId, projectId, targetVersionId: afterVersionId }),
    ])
    if (!beforeContext?.targetVersion || !afterContext?.targetVersion) {
      throw new DomainError('PROJECT_NOT_FOUND', 'One or both comparison versions were not found')
    }
    if (
      beforeContext.version.id !== afterContext.version.id ||
      beforeContext.version.baseHash !== afterContext.version.baseHash
    ) {
      throw new DomainError('VERSION_CONFLICT', 'Project changed while comparison versions were loading')
    }
    const comparison = versionComparisonFromEditPlans({
      before: {
        id: beforeContext.targetVersion.version.id,
        editPlan: beforeContext.targetVersion.editPlan,
      },
      after: {
        id: afterContext.targetVersion.version.id,
        editPlan: afterContext.targetVersion.editPlan,
      },
      mode,
    })
    return Object.freeze({
      current: Object.freeze({
        versionId: beforeContext.version.id,
        baseHash: beforeContext.version.baseHash,
        revision: beforeContext.version.sequence,
      }),
      versions: Object.freeze({
        before: Object.freeze({
          id: beforeContext.targetVersion.version.id,
          sequence: beforeContext.targetVersion.version.sequence,
          editPlanHash: beforeContext.targetVersion.editPlanHash,
        }),
        after: Object.freeze({
          id: afterContext.targetVersion.version.id,
          sequence: afterContext.targetVersion.version.sequence,
          editPlanHash: afterContext.targetVersion.editPlanHash,
        }),
      }),
      comparison,
    })
  }
}

export function decideVersionComparisonService(dependencies: {
  comparisonRepository: VersionCompareRepository
  manualEditRepository: ManualEditRepository
  clock: () => Date
  createCommandId: () => string
  createEventId: () => string
}) {
  const readComparison = readVersionComparisonService({
    repository: dependencies.manualEditRepository,
  })
  return async function decide(request: {
    workspaceId: string
    projectId: string
    beforeVersionId: string
    afterVersionId: string
    mode: VersionCompareMode
    action: 'accept' | 'reopen'
    baseVersionId: string
    baseHash: string
    expectedRevision: number
    actor: Readonly<AuthenticatedExternalActor>
    idempotencyKey: string
    reason?: string
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const baseVersionId = identity(request.baseVersionId, 'baseVersionId')
    const action = request.action
    assertDomain(['accept', 'reopen'].includes(action), 'INVALID_ARGUMENT', 'Compare action is invalid')
    assertDomain(/^[a-f0-9]{64}$/.test(request.baseHash), 'INVALID_ARGUMENT', 'baseHash must be a SHA-256 digest')
    assertDomain(
      Number.isInteger(request.expectedRevision) && request.expectedRevision >= 1,
      'INVALID_ARGUMENT',
      'expectedRevision is invalid',
    )
    const idempotencyKey = request.idempotencyKey.trim()
    assertDomain(
      idempotencyKey.length >= 8 && idempotencyKey.length <= 128,
      'INVALID_ARGUMENT',
      'Idempotency-Key is invalid',
    )
    requireScope(request.actor, 'projects:write')
    const authenticationAudit = materializeActorAuditContext(request.actor)
    assertDomain(authenticationAudit.workspaceId === workspaceId, 'AUTH_INVALID', 'Version comparison actor does not belong to the workspace')
    const comparisonState = await readComparison({
      workspaceId,
      projectId,
      beforeVersionId: request.beforeVersionId,
      afterVersionId: request.afterVersionId,
      mode: request.mode,
    })
    if (
      comparisonState.current.versionId !== baseVersionId ||
      comparisonState.current.baseHash !== request.baseHash ||
      comparisonState.current.revision !== request.expectedRevision
    ) {
      throw new DomainError('VERSION_CONFLICT', 'Version comparison base is stale', {
        currentVersionId: comparisonState.current.versionId,
        currentBaseHash: comparisonState.current.baseHash,
        currentRevision: comparisonState.current.revision,
      })
    }
    assertDomain(
      comparisonState.versions.after.id === comparisonState.current.versionId,
      'PRECONDITION_REQUIRED',
      'Accept and reopen require the after side to be the current version',
    )
    const comparison = comparisonState.comparison as unknown as Readonly<Record<string, unknown>>
    const requestFingerprint = calculateVersionHash({
      type: 'compare-action',
      workspaceId,
      projectId,
      action,
      baseVersionId,
      baseHash: request.baseHash,
      expectedRevision: request.expectedRevision,
      beforeVersionId: comparisonState.versions.before.id,
      afterVersionId: comparisonState.versions.after.id,
      mode: comparisonState.comparison.mode,
      comparison,
      actorContextHash: authenticationAudit.contextHash,
      reason: request.reason?.trim() || null,
    })
    const existing = await dependencies.comparisonRepository.findIdempotentDecision({
      workspaceId,
      projectId,
      idempotencyKey,
      actorContextHash: authenticationAudit.contextHash,
    })
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Idempotency key was used with a different version comparison decision',
        )
      }
      return Object.freeze({ ...existing.result, replayed: true })
    }
    const createdAt = dependencies.clock().toISOString()
    const commandId = dependencies.createCommandId()
    // Accept and reopen move only the review state: no EditPlan, no bytes and no
    // new ProjectVersion, so the result version is the base version itself.
    const impact = createCompareActionImpact({
      commandId,
      baseVersionId,
      resultVersionId: baseVersionId,
      action,
    })
    const payload: Readonly<PersistedVersionCompareDecision> = Object.freeze({
      schemaVersion: 2,
      action,
      expectedRevision: request.expectedRevision,
      beforeVersionId: comparisonState.versions.before.id,
      afterVersionId: comparisonState.versions.after.id,
      mode: comparisonState.comparison.mode,
      comparison,
      impact,
    })
    const command = createEditCommand<PersistedVersionCompareDecision>({
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
      type: 'compare-action',
      scope: { project: true },
      payload,
      ...(request.reason?.trim() ? { reason: request.reason.trim() } : {}),
      idempotencyKey,
      createdAt,
    })
    const projectStatus = action === 'accept' ? 'reviewing-proxy' : 'revising'
    const event = createPublicEvent({
      id: dependencies.createEventId(),
      type: 'project.status.changed',
      version: '1.0.0',
      workspaceId,
      occurredAt: createdAt,
      sequence: request.expectedRevision,
      actor: {
        clientId: authenticationAudit.clientId,
        ...(authenticationAudit.delegatedUserId
          ? { userId: authenticationAudit.delegatedUserId }
          : {}),
      },
      resource: { type: 'project', id: projectId },
      data: {
        projectId,
        status: projectStatus,
        compareAction: action,
        beforeVersionId: payload.beforeVersionId,
        afterVersionId: payload.afterVersionId,
        mode: payload.mode,
        versionsPreserved: true,
        commandImpactHash: impact.impactHash,
        artifactInvalidationCount: impact.affectedArtifacts.length,
      },
    })
    return dependencies.comparisonRepository.commitDecision({
      command,
      authenticationAudit,
      requestFingerprint,
      projectStatus,
      event,
    })
  }
}
