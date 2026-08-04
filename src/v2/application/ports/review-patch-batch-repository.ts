import type { EditCommand } from '../../domain/edit-command.ts'
import type { PatchImpact, PatchOperation, PatchSet, ReviewAnnotation } from '../../domain/review-system.ts'
import type { ProjectSnapshot } from '../../domain/project-snapshot.ts'
import type { ProjectVersion } from '../../domain/project-version.ts'
import type { PublicEvent } from '../../domain/public-event.ts'
import type { ReviewPatchProposal } from './review-patch-repository.ts'
import type { CommandArtifactInvalidationV1, CommandImpactOutputReference, CommandImpactV1 } from '../../domain/command-impact.ts'
import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'

export type ReviewPatchBatchMode = 'all-or-nothing' | 'partial-retry'
export type ReviewPatchBatchStatus = 'ready' | 'conflict' | 'partial' | 'applied'
export type ReviewPatchBatchItemStatus = 'included' | 'rolled-back' | 'retryable' | 'applied'

export interface ReviewPatchBatchItem {
  id: string
  annotationId: string
  proposalId: string
  status: ReviewPatchBatchItemStatus
  operation: Readonly<PatchOperation> | null
  conflictIds: readonly string[]
  reasonCode?: string
  createdAt: string
  updatedAt: string
}

export interface ReviewPatchBatch {
  id: string
  workspaceId: string
  projectId: string
  baseVersionId: string
  mode: ReviewPatchBatchMode
  status: ReviewPatchBatchStatus
  patch: Readonly<PatchSet> | null
  impact: Readonly<PatchImpact> | null
  conflicts: readonly string[]
  items: readonly Readonly<ReviewPatchBatchItem>[]
  resultCommandId?: string
  resultVersionId?: string
  renderOperationId?: string
  render?: Readonly<{ operationId: string; status: string; phase: string; error?: Readonly<{ code: string; message: string }> }>
  comparison?: Readonly<{
    beforeVersionId: string
    afterVersionId: string
    beforeEditPlanHash: string
    afterEditPlanHash: string
    changedTargets: readonly string[]
    invalidatedRanges: readonly (readonly [number, number])[]
  }>
  createdAt: string
  updatedAt: string
}

export interface ReviewPatchBatchProposalContext {
  currentVersion: Readonly<ProjectVersion>
  editPlan: Readonly<Record<string, unknown>>
  editPlanHash: string
  availableAssetIds: readonly string[]
  renderVariantIds: readonly string[]
  outputReferences: readonly Readonly<CommandImpactOutputReference>[]
  entries: readonly Readonly<{ annotation: Readonly<ReviewAnnotation>; proposal: Readonly<ReviewPatchProposal> }>[]
}

export interface ReviewPatchBatchApplyContext extends ReviewPatchBatchProposalContext {
  batch: Readonly<ReviewPatchBatch>
}

export interface ReviewPatchBatchCommit {
  batchId: string
  applyIdempotencyKey: string
  applyRequestFingerprint: string
  command: Readonly<EditCommand>
  authenticationAudit: Readonly<ApiAccessAuditContext>
  snapshot: Readonly<ProjectSnapshot>
  version: Readonly<ProjectVersion>
  event: Readonly<PublicEvent>
  comparison: NonNullable<ReviewPatchBatch['comparison']>
  impact: Readonly<CommandImpactV1>
}

export interface ReviewPatchBatchApplyResult {
  batch: Readonly<ReviewPatchBatch>
  command: Readonly<EditCommand>
  version: Readonly<ProjectVersion>
  editPlan: Readonly<Record<string, unknown>>
  comparison: NonNullable<ReviewPatchBatch['comparison']>
  impact: Readonly<CommandImpactV1>
  invalidations: readonly Readonly<CommandArtifactInvalidationV1>[]
  replayed: boolean
}

export interface ReviewPatchBatchRepository {
  findBatchIdempotent(input: { workspaceId: string; projectId: string; idempotencyKey: string }): Promise<Readonly<{ requestFingerprint: string; batch: ReviewPatchBatch }> | null>
  readProposalSet(input: { workspaceId: string; projectId: string; proposalIds: readonly string[] }): Promise<Readonly<ReviewPatchBatchProposalContext> | null>
  createBatch(input: { batch: ReviewPatchBatch; idempotencyKey: string; requestFingerprint: string }): Promise<Readonly<ReviewPatchBatch>>
  readBatch(input: { workspaceId: string; projectId: string; batchId: string }): Promise<Readonly<ReviewPatchBatch> | null>
  readApplyContext(input: { workspaceId: string; projectId: string; batchId: string }): Promise<Readonly<ReviewPatchBatchApplyContext> | null>
  readAppliedResult(input: { workspaceId: string; projectId: string; batchId: string; applyIdempotencyKey: string; applyRequestFingerprint: string; actorContextHash: string }): Promise<Readonly<ReviewPatchBatchApplyResult> | null>
  commitOrReplay(bundle: ReviewPatchBatchCommit): Promise<Readonly<ReviewPatchBatchApplyResult>>
  attachRenderOperation(input: { workspaceId: string; projectId: string; batchId: string; renderOperationId: string }): Promise<Readonly<ReviewPatchBatch>>
}
