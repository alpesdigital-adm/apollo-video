import { calculateVersionHash, stableSerialize } from './version-hash.ts'
import type { ReviewPatchProposal, ReviewPatchRepository } from './ports/review-patch-repository.ts'
import { createEditCommand, type CommandActor } from '../domain/edit-command.ts'
import { DomainError, assertDomain } from '../domain/errors.ts'
import { createProjectSnapshot } from '../domain/project-snapshot.ts'
import { createProjectVersion } from '../domain/project-version.ts'
import { createPublicEvent } from '../domain/public-event.ts'
import {
  PATCH_OPERATION_KINDS,
  interpretReviewAnnotation,
  materializePatchEditPlan,
  proposePatchFromAnnotation,
  type PatchOperation,
  type PatchOperationKind,
  type PatchSet,
} from '../domain/review-system.ts'

const INTERPRETER_VERSION = 'review-patch-interpreter/1.0.0'
const DEFAULT_POLICY_VERSION = 'review-patch-policy/1.0.0'
const OPERATION_COST_CENTS: Readonly<Record<PatchOperationKind, number>> = Object.freeze({
  trim: 0,
  'replace-asset': 25,
  'update-text': 0,
  'update-layout': 0,
  'update-subtitle': 0,
  move: 0,
})

function validateIdentity(value: string, field: string): string {
  const normalized = value.trim()
  assertDomain(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(normalized), 'INVALID_ARGUMENT', `${field} is invalid`)
  return normalized
}

function policyRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function protectedTargetIds(editPlan: Readonly<Record<string, unknown>>): readonly string[] {
  const values = Array.isArray(editPlan.protectedElements) ? editPlan.protectedElements : []
  return Object.freeze([...new Set(values.flatMap((value) => {
    const item = policyRecord(value)
    const target = policyRecord(item.target)
    return [item.id, item.targetId, target.id].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0)
  }))])
}

function resolvePolicy(policies: Readonly<Record<string, unknown>>) {
  const configured = policyRecord(policies.reviewPatchPolicy)
  const rawAllowed = Array.isArray(configured.allowedOperations) ? configured.allowedOperations : PATCH_OPERATION_KINDS
  const allowedOperations = rawAllowed.filter((value): value is PatchOperationKind => typeof value === 'string' && PATCH_OPERATION_KINDS.includes(value as PatchOperationKind))
  const maxCostCents = Number.isSafeInteger(configured.maxCostCents) && Number(configured.maxCostCents) >= 0 ? Number(configured.maxCostCents) : 100
  const spentCostCents = Number.isSafeInteger(configured.spentCostCents) && Number(configured.spentCostCents) >= 0 ? Number(configured.spentCostCents) : 0
  return Object.freeze({
    version: typeof configured.version === 'string' ? configured.version : DEFAULT_POLICY_VERSION,
    allowedOperations: Object.freeze(allowedOperations),
    budgetRemaining: Math.max(0, maxCostCents - spentCostCents),
  })
}

function proposalFingerprint(input: { workspaceId: string; projectId: string; annotationId: string; selectedChoiceId?: string; contextHash: string }) {
  return calculateVersionHash({
    type: 'review-patch-proposal',
    interpreterVersion: INTERPRETER_VERSION,
    ...input,
  })
}

export function proposeReviewPatchService(dependencies: {
  repository: ReviewPatchRepository
  clock: () => Date
  createId: (kind: 'review-patch-proposal' | 'patch') => string
}) {
  return async function propose(request: {
    workspaceId: string
    projectId: string
    annotationId: string
    selectedChoiceId?: string
    idempotencyKey: string
  }): Promise<Readonly<{ proposal: ReviewPatchProposal; replayed: boolean }>> {
    const workspaceId = validateIdentity(request.workspaceId, 'workspaceId')
    const projectId = validateIdentity(request.projectId, 'projectId')
    const annotationId = validateIdentity(request.annotationId, 'annotationId')
    const idempotencyKey = request.idempotencyKey.trim()
    assertDomain(idempotencyKey.length >= 8 && idempotencyKey.length <= 128, 'INVALID_ARGUMENT', 'Idempotency-Key is invalid')
    const context = await dependencies.repository.readProposalContext({ workspaceId, projectId, annotationId })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Review annotation or current project version was not found')
    if (context.annotation.status !== 'open') throw new DomainError('VERSION_CONFLICT', 'Review annotation is no longer open')
    if (context.annotation.projectVersionId !== context.currentVersion.id) {
      throw new DomainError('VERSION_CONFLICT', 'Review annotation targets a stale ProjectVersion', { currentVersionId: context.currentVersion.id })
    }
    const contextHash = calculateVersionHash({
      annotation: context.annotation,
      versionId: context.currentVersion.id,
      baseHash: context.currentVersion.baseHash,
      editPlanHash: context.editPlanHash,
      policies: context.policies,
      availableAssetIds: context.availableAssetIds,
    })
    const requestFingerprint = proposalFingerprint({ workspaceId, projectId, annotationId, ...(request.selectedChoiceId ? { selectedChoiceId: request.selectedChoiceId } : {}), contextHash })
    const existing = await dependencies.repository.findProposalIdempotent({ workspaceId, projectId, idempotencyKey })
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with a different patch proposal request')
      return Object.freeze({ proposal: existing.proposal, replayed: true })
    }
    const interpretations = interpretReviewAnnotation(context.annotation)
    const selected = request.selectedChoiceId
      ? interpretations.filter((candidate) => candidate.choiceId === request.selectedChoiceId)
      : interpretations
    if (request.selectedChoiceId && selected.length !== 1) throw new DomainError('INVALID_ARGUMENT', 'Selected patch interpretation does not belong to this annotation')
    const policy = resolvePolicy(context.policies)
    const estimatedCost = selected.reduce((total, operation) => total + OPERATION_COST_CENTS[operation.op], 0)
    const result = proposePatchFromAnnotation({
      annotation: context.annotation,
      baseVersionId: context.currentVersion.id,
      interpretations: selected,
      protectedTargetIds: protectedTargetIds(context.editPlan),
      policyAllowedOps: policy.allowedOperations,
      budgetRemaining: policy.budgetRemaining,
      estimatedCost,
    })
    const createdAt = dependencies.clock().toISOString()
    const proposalId = dependencies.createId('review-patch-proposal')
    const patch = result.patch ? Object.freeze({ ...result.patch, id: dependencies.createId('patch') }) : null
    const proposal: ReviewPatchProposal = Object.freeze({
      id: proposalId,
      workspaceId,
      projectId,
      annotationId,
      baseVersionId: context.currentVersion.id,
      status: result.status,
      interpretationVersion: `${INTERPRETER_VERSION}+${policy.version}`,
      choices: Object.freeze(result.choices.map((item) => Object.freeze({ ...item }))),
      patch,
      impact: result.status === 'ready' ? result.impact : null,
      gates: result.gates,
      createdAt,
      updatedAt: createdAt,
    })
    return Object.freeze({
      proposal: await dependencies.repository.createProposal({ proposal, idempotencyKey, requestFingerprint }),
      replayed: false,
    })
  }
}

export function readReviewPatchService(dependencies: { repository: ReviewPatchRepository }) {
  return async function read(input: { workspaceId: string; projectId: string; proposalId: string }) {
    const proposal = await dependencies.repository.readProposal({
      workspaceId: validateIdentity(input.workspaceId, 'workspaceId'),
      projectId: validateIdentity(input.projectId, 'projectId'),
      proposalId: validateIdentity(input.proposalId, 'proposalId'),
    })
    if (!proposal) throw new DomainError('PROJECT_NOT_FOUND', 'Review patch proposal was not found')
    return proposal
  }
}

export function applyReviewPatchService(dependencies: {
  repository: ReviewPatchRepository
  clock: () => Date
  createId: (kind: 'edit-command' | 'project-version' | 'project-snapshot') => string
  createEventId: () => string
}) {
  return async function apply(request: {
    workspaceId: string
    projectId: string
    proposalId: string
    confirmed: true
    actor: Readonly<CommandActor>
    idempotencyKey: string
  }) {
    const workspaceId = validateIdentity(request.workspaceId, 'workspaceId')
    const projectId = validateIdentity(request.projectId, 'projectId')
    const proposalId = validateIdentity(request.proposalId, 'proposalId')
    assertDomain(request.confirmed === true, 'PRECONDITION_REQUIRED', 'Patch impact must be explicitly confirmed')
    const idempotencyKey = request.idempotencyKey.trim()
    assertDomain(idempotencyKey.length >= 8 && idempotencyKey.length <= 128, 'INVALID_ARGUMENT', 'Idempotency-Key is invalid')
    const context = await dependencies.repository.readApplyContext({ workspaceId, projectId, proposalId })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Review patch proposal was not found')
    const applyRequestFingerprint = calculateVersionHash({ proposalId, confirmed: true, actor: request.actor })
    if (context.proposal.status === 'applied') {
      const replay = await dependencies.repository.readAppliedResult({ workspaceId, projectId, proposalId, applyIdempotencyKey: idempotencyKey, applyRequestFingerprint })
      if (!replay) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Patch proposal was already applied by another request')
      return replay
    }
    assertDomain(context.proposal.status === 'ready' && Boolean(context.proposal.patch) && Boolean(context.proposal.impact), 'PRECONDITION_REQUIRED', 'Only a ready patch proposal can be applied')
    if (context.currentVersion.id !== context.proposal.baseVersionId) throw new DomainError('VERSION_CONFLICT', 'Patch proposal base version is stale', { currentVersionId: context.currentVersion.id })
    const createdAt = dependencies.clock().toISOString()
    const commandId = dependencies.createId('edit-command')
    const versionId = dependencies.createId('project-version')
    const snapshotId = dependencies.createId('project-snapshot')
    const editPlan = materializePatchEditPlan({
      editPlan: context.editPlan,
      patch: context.proposal.patch!,
      newVersionId: versionId,
      createdAt,
      availableAssetIds: context.availableAssetIds,
    })
    const editPlanJson = stableSerialize(editPlan)
    const editPlanHash = calculateVersionHash(editPlan)
    const patch = context.proposal.patch as PatchSet
    const payload = Object.freeze({ schemaVersion: 1 as const, proposalId, annotationIds: patch.annotationIds, patch })
    const command = createEditCommand({
      id: commandId,
      workspaceId,
      projectId,
      baseVersionId: context.currentVersion.id,
      baseHash: context.currentVersion.baseHash,
      author: request.actor,
      type: 'apply-review-patch',
      scope: { project: true },
      payload,
      reason: `Aplicação confirmada da annotation ${context.proposal.annotationId}`,
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
        proposalId,
        editPlanHash,
      }),
      createdBy: request.actor.id,
      commandId,
      createdAt,
    })
    const comparison = Object.freeze({
      beforeVersionId: context.currentVersion.id,
      afterVersionId: versionId,
      beforeEditPlanHash: context.editPlanHash,
      afterEditPlanHash: editPlanHash,
      changedTargets: Object.freeze([...context.proposal.impact!.changedTargets]),
      invalidatedRanges: Object.freeze(context.proposal.impact!.invalidatedRanges.map((range) => Object.freeze([...range] as [number, number]))),
    })
    const event = createPublicEvent({
      id: dependencies.createEventId(),
      type: 'project.version.created',
      version: '1.0.0',
      workspaceId,
      occurredAt: createdAt,
      sequence: version.sequence,
      actor: request.actor.type === 'api-client' ? { clientId: request.actor.id, ...(request.actor.delegatedUserId ? { userId: request.actor.delegatedUserId } : {}) } : { userId: request.actor.id },
      resource: { type: 'project-version', id: version.id },
      data: { projectId, sequence: version.sequence, parentVersionId: version.parentVersionId, baseHash: version.baseHash, commandId, commandType: command.type, patchProposalId: proposalId, snapshotRefs: version.snapshotRefs, createdAt },
    })
    return dependencies.repository.commitOrReplay({
      proposalId,
      applyIdempotencyKey: idempotencyKey,
      applyRequestFingerprint,
      command,
      snapshot,
      version,
      event,
      comparison,
    })
  }
}
