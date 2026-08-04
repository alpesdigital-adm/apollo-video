import type {
  ReviewPatchBatch,
  ReviewPatchBatchMode,
  ReviewPatchBatchRepository,
} from './ports/review-patch-batch-repository.ts'
import { calculateVersionHash, stableSerialize } from './version-hash.ts'
import { createEditCommand } from '../domain/edit-command.ts'
import { DomainError, assertDomain } from '../domain/errors.ts'
import { createProjectSnapshot } from '../domain/project-snapshot.ts'
import { createProjectVersion } from '../domain/project-version.ts'
import { createPublicEvent } from '../domain/public-event.ts'
import { createReviewPatchCommandImpact, type CommandImpactV1 } from '../domain/command-impact.ts'
import {
  compileBatchReview,
  materializePatchEditPlan,
  type PatchImpact,
  type PatchSet,
} from '../domain/review-system.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'

interface AppliedReviewPatchBatchPayloadV2 {
  schemaVersion: 2
  batchId: string
  mode: ReviewPatchBatchMode
  annotationIds: readonly string[]
  proposalIds: readonly string[]
  patch: Readonly<PatchSet>
  impact: Readonly<CommandImpactV1>
}

function validateIdentity(value: string, field: string): string {
  const normalized = value.trim()
  assertDomain(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(normalized), 'INVALID_ARGUMENT', `${field} is invalid`)
  return normalized
}

function validateIdempotencyKey(value: string): string {
  const normalized = value.trim()
  assertDomain(normalized.length >= 8 && normalized.length <= 128, 'INVALID_ARGUMENT', 'Idempotency-Key is invalid')
  return normalized
}

function validateProposalIds(values: readonly string[]): readonly string[] {
  assertDomain(values.length >= 2 && values.length <= 100, 'INVALID_ARGUMENT', 'Batch review requires between 2 and 100 proposals')
  const normalized = values.map((value) => validateIdentity(value, 'proposalId'))
  assertDomain(new Set(normalized).size === normalized.length, 'INVALID_ARGUMENT', 'Batch review proposals cannot contain duplicates')
  return Object.freeze(normalized)
}

function compileImpact(
  patch: Readonly<PatchSet>,
  entries: readonly Readonly<{ proposal: { annotationId: string; impact: PatchImpact | null } }>[],
): Readonly<PatchImpact> {
  const included = new Set(patch.annotationIds)
  const impacts = entries
    .filter((entry) => included.has(entry.proposal.annotationId))
    .flatMap((entry) => entry.proposal.impact ? [entry.proposal.impact] : [])
  return Object.freeze({
    operationCount: patch.operations.length,
    cost: patch.estimatedCost,
    invalidatedRanges: Object.freeze(patch.invalidatedRanges.map((range) => Object.freeze([...range] as [number, number]))),
    changedTargets: Object.freeze([...new Set(patch.operations.map((operation) => operation.targetId))].toSorted()),
    expectedScoreDelta: impacts.reduce((total, impact) => total + impact.expectedScoreDelta, 0),
    invalidatedArtifacts: Object.freeze([...new Set(impacts.flatMap((impact) => impact.invalidatedArtifacts))].toSorted()),
  })
}

export function proposeReviewPatchBatchService(dependencies: {
  repository: ReviewPatchBatchRepository
  clock: () => Date
  createId: (kind: 'review-patch-batch' | 'review-patch-batch-item' | 'patch') => string
}) {
  return async function propose(request: {
    workspaceId: string
    projectId: string
    proposalIds: readonly string[]
    mode?: ReviewPatchBatchMode
    actor: Readonly<AuthenticatedExternalActor>
    idempotencyKey: string
  }): Promise<Readonly<{ batch: ReviewPatchBatch; replayed: boolean }>> {
    const workspaceId = validateIdentity(request.workspaceId, 'workspaceId')
    const projectId = validateIdentity(request.projectId, 'projectId')
    requireScope(request.actor, 'projects:write')
    const authenticationAudit = materializeActorAuditContext(request.actor)
    assertDomain(
      authenticationAudit.workspaceId === workspaceId,
      'AUTH_INVALID',
      'Review patch batch actor belongs to another workspace',
    )
    const proposalIds = validateProposalIds(request.proposalIds)
    const mode = request.mode ?? 'all-or-nothing'
    assertDomain(mode === 'all-or-nothing' || mode === 'partial-retry', 'INVALID_ARGUMENT', 'Batch review mode is invalid')
    const idempotencyKey = validateIdempotencyKey(request.idempotencyKey)
    const context = await dependencies.repository.readProposalSet({ workspaceId, projectId, proposalIds })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'One or more review patch proposals were not found')
    assertDomain(context.entries.length === proposalIds.length, 'PROJECT_NOT_FOUND', 'One or more review patch proposals were not found')
    for (const entry of context.entries) {
      assertDomain(entry.annotation.status === 'open', 'VERSION_CONFLICT', 'Batch review contains an annotation that is no longer open', { annotationId: entry.annotation.id })
      assertDomain(entry.annotation.projectVersionId === context.currentVersion.id, 'VERSION_CONFLICT', 'Batch review contains a stale annotation', { annotationId: entry.annotation.id, currentVersionId: context.currentVersion.id })
      assertDomain(entry.proposal.status === 'ready' && Boolean(entry.proposal.patch) && Boolean(entry.proposal.impact), 'PRECONDITION_REQUIRED', 'Batch review accepts only ready patch proposals', { proposalId: entry.proposal.id })
      assertDomain(entry.proposal.baseVersionId === context.currentVersion.id, 'VERSION_CONFLICT', 'Batch review proposals must share the current base version', { proposalId: entry.proposal.id })
      assertDomain(entry.proposal.annotationId === entry.annotation.id, 'PERSISTENCE_CONFLICT', 'Batch proposal annotation link is invalid')
      assertDomain(entry.proposal.patch!.operations.length === 1, 'PRECONDITION_REQUIRED', 'Each batch proposal must resolve to exactly one typed operation', { proposalId: entry.proposal.id })
    }
    const orderedEntries = [...context.entries].toSorted((left, right) => proposalIds.indexOf(left.proposal.id) - proposalIds.indexOf(right.proposal.id))
    const requestFingerprint = calculateVersionHash({
      type: 'review-patch-batch',
      workspaceId,
      projectId,
      mode,
      proposals: orderedEntries.map((entry) => ({
        id: entry.proposal.id,
        annotationId: entry.annotation.id,
        baseVersionId: entry.proposal.baseVersionId,
        patch: entry.proposal.patch,
        impact: entry.proposal.impact,
        updatedAt: entry.proposal.updatedAt,
      })),
      currentVersionId: context.currentVersion.id,
      editPlanHash: context.editPlanHash,
      actorContextHash: authenticationAudit.contextHash,
    })
    const existing = await dependencies.repository.findBatchIdempotent({
      workspaceId,
      projectId,
      idempotencyKey,
      actorContextHash: authenticationAudit.contextHash,
    })
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with a different batch review request')
      return Object.freeze({ batch: existing.batch, replayed: true })
    }
    const compiled = compileBatchReview({
      annotations: orderedEntries.map((entry) => entry.annotation),
      proposals: orderedEntries.map((entry) => ({
        annotationId: entry.annotation.id,
        operation: entry.proposal.patch!.operations[0]!,
        estimatedCost: entry.proposal.patch!.estimatedCost,
      })),
      baseVersionId: context.currentVersion.id,
      mode,
    })
    const createdAt = dependencies.clock().toISOString()
    const patch = compiled.patch
      ? Object.freeze({ ...compiled.patch, id: dependencies.createId('patch') })
      : null
    const impact = patch ? compileImpact(patch, orderedEntries) : null
    const batch: ReviewPatchBatch = Object.freeze({
      id: dependencies.createId('review-patch-batch'),
      workspaceId,
      projectId,
      baseVersionId: context.currentVersion.id,
      mode,
      status: compiled.status,
      patch,
      impact,
      conflicts: compiled.conflicts,
      items: Object.freeze(compiled.results.map((result) => {
        const entry = orderedEntries.find((candidate) => candidate.annotation.id === result.annotationId)!
        return Object.freeze({
          id: dependencies.createId('review-patch-batch-item'),
          annotationId: result.annotationId,
          proposalId: entry.proposal.id,
          status: result.status,
          operation: entry.proposal.patch!.operations[0]!,
          conflictIds: result.conflictIds,
          ...(result.status === 'rolled-back' ? { reasonCode: 'ATOMIC_CONFLICT' } : result.status === 'retryable' ? { reasonCode: 'TARGET_CONFLICT' } : {}),
          createdAt,
          updatedAt: createdAt,
        })
      })),
      createdAt,
      updatedAt: createdAt,
      authenticationAudit,
    })
    return Object.freeze({
      batch: await dependencies.repository.createBatch({ batch, idempotencyKey, requestFingerprint }),
      replayed: false,
    })
  }
}

export function readReviewPatchBatchService(dependencies: { repository: ReviewPatchBatchRepository }) {
  return async function read(input: { workspaceId: string; projectId: string; batchId: string }) {
    const batch = await dependencies.repository.readBatch({
      workspaceId: validateIdentity(input.workspaceId, 'workspaceId'),
      projectId: validateIdentity(input.projectId, 'projectId'),
      batchId: validateIdentity(input.batchId, 'batchId'),
    })
    if (!batch) throw new DomainError('PROJECT_NOT_FOUND', 'Review patch batch was not found')
    return batch
  }
}

export function applyReviewPatchBatchService(dependencies: {
  repository: ReviewPatchBatchRepository
  clock: () => Date
  createId: (kind: 'edit-command' | 'project-version' | 'project-snapshot') => string
  createEventId: () => string
}) {
  return async function apply(request: {
    workspaceId: string
    projectId: string
    batchId: string
    confirmed: true
    actor: Readonly<AuthenticatedExternalActor>
    idempotencyKey: string
  }) {
    const workspaceId = validateIdentity(request.workspaceId, 'workspaceId')
    const projectId = validateIdentity(request.projectId, 'projectId')
    const batchId = validateIdentity(request.batchId, 'batchId')
    assertDomain(request.confirmed === true, 'PRECONDITION_REQUIRED', 'Batch patch impact must be explicitly confirmed')
    const idempotencyKey = validateIdempotencyKey(request.idempotencyKey)
    requireScope(request.actor, 'projects:write')
    const authenticationAudit = materializeActorAuditContext(request.actor)
    assertDomain(authenticationAudit.workspaceId === workspaceId, 'AUTH_INVALID', 'Batch review actor does not belong to the workspace')
    const context = await dependencies.repository.readApplyContext({ workspaceId, projectId, batchId })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Review patch batch was not found')
    const applyRequestFingerprint = calculateVersionHash({ batchId, confirmed: true, actorContextHash: authenticationAudit.contextHash })
    if (context.batch.status === 'applied') {
      const replay = await dependencies.repository.readAppliedResult({ workspaceId, projectId, batchId, applyIdempotencyKey: idempotencyKey, applyRequestFingerprint, actorContextHash: authenticationAudit.contextHash })
      if (!replay) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Batch review was already applied by another request')
      return replay
    }
    assertDomain(
      (context.batch.status === 'ready' || (context.batch.status === 'partial' && context.batch.mode === 'partial-retry')) &&
        Boolean(context.batch.patch) && Boolean(context.batch.impact),
      'PRECONDITION_REQUIRED',
      'Only a ready batch or an explicitly partial-retry batch can be applied',
    )
    assertDomain(context.currentVersion.id === context.batch.baseVersionId, 'VERSION_CONFLICT', 'Batch review base version is stale', { currentVersionId: context.currentVersion.id })
    const createdAt = dependencies.clock().toISOString()
    const commandId = dependencies.createId('edit-command')
    const versionId = dependencies.createId('project-version')
    const snapshotId = dependencies.createId('project-snapshot')
    const patch = context.batch.patch!
    const editPlan = materializePatchEditPlan({
      editPlan: context.editPlan,
      patch,
      newVersionId: versionId,
      createdAt,
      availableAssetIds: context.availableAssetIds,
    })
    const editPlanJson = stableSerialize(editPlan)
    const editPlanHash = calculateVersionHash(editPlan)
    assertDomain(
      stableSerialize(patch.invalidatedRanges) === stableSerialize(context.batch.impact!.invalidatedRanges),
      'PERSISTENCE_CONFLICT',
      'Batch review patch impact ranges are inconsistent',
    )
    const impact = createReviewPatchCommandImpact({
      commandType: 'apply-review-patch-batch',
      commandId,
      baseVersionId: context.currentVersion.id,
      resultVersionId: versionId,
      variantIds: context.renderVariantIds,
      operations: patch.operations,
      invalidatedRangesMs: context.batch.impact!.invalidatedRanges,
      beforeEditPlan: context.editPlan,
      afterEditPlan: editPlan,
      outputReferences: context.outputReferences,
    })
    const payload: Readonly<AppliedReviewPatchBatchPayloadV2> = Object.freeze({
      schemaVersion: 2 as const,
      batchId,
      mode: context.batch.mode,
      annotationIds: patch.annotationIds,
      proposalIds: context.batch.items.filter((item) => patch.annotationIds.includes(item.annotationId)).map((item) => item.proposalId),
      patch,
      impact,
    })
    const command = createEditCommand<AppliedReviewPatchBatchPayloadV2>({
      id: commandId,
      workspaceId,
      projectId,
      baseVersionId: context.currentVersion.id,
      baseHash: context.currentVersion.baseHash,
      author: {
        type: 'api-client', id: authenticationAudit.clientId,
        ...(authenticationAudit.delegatedUserId
          ? { delegatedUserId: authenticationAudit.delegatedUserId }
          : {}),
      },
      type: 'apply-review-patch-batch',
      scope: { project: true },
      payload,
      reason: `Aplicação confirmada do lote de revisão ${batchId}`,
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
      sequence: context.currentVersion.sequence + 1,
      parentVersionId: context.currentVersion.id,
      snapshotRefs: { ...context.currentVersion.snapshotRefs, editPlan: snapshotId },
      baseHash: calculateVersionHash({
        projectId,
        sequence: context.currentVersion.sequence + 1,
        parentVersionId: context.currentVersion.id,
        previousBaseHash: context.currentVersion.baseHash,
        commandId,
        batchId,
        editPlanHash,
      }),
      createdBy: authenticationAudit.clientId,
      commandId,
      createdAt,
    })
    const comparison = Object.freeze({
      beforeVersionId: context.currentVersion.id,
      afterVersionId: versionId,
      beforeEditPlanHash: context.editPlanHash,
      afterEditPlanHash: editPlanHash,
      changedTargets: Object.freeze([...context.batch.impact!.changedTargets]),
      invalidatedRanges: Object.freeze(context.batch.impact!.invalidatedRanges.map((range) => Object.freeze([...range] as [number, number]))),
    })
    const event = createPublicEvent({
      id: dependencies.createEventId(),
      type: 'project.version.created',
      version: '1.0.0',
      workspaceId,
      occurredAt: createdAt,
      sequence: version.sequence,
      actor: { clientId: authenticationAudit.clientId, ...(authenticationAudit.delegatedUserId ? { userId: authenticationAudit.delegatedUserId } : {}) },
      resource: { type: 'project-version', id: version.id },
      data: {
        projectId,
        sequence: version.sequence,
        parentVersionId: version.parentVersionId,
        baseHash: version.baseHash,
        commandId,
        commandType: command.type,
        patchBatchId: batchId,
        commandImpactHash: impact.impactHash,
        artifactInvalidationCount: impact.affectedArtifacts.length,
        snapshotRefs: version.snapshotRefs,
        createdAt,
      },
    })
    return dependencies.repository.commitOrReplay({
      batchId,
      applyIdempotencyKey: idempotencyKey,
      applyRequestFingerprint,
      command,
      authenticationAudit,
      snapshot,
      version,
      event,
      comparison,
      impact,
    })
  }
}
