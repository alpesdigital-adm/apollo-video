import type { EditCommand } from '../../domain/edit-command.ts'
import type { PatchGateResult, PatchImpact, PatchOperation, PatchSet, ReviewAnnotation } from '../../domain/review-system.ts'
import type { ProjectSnapshot } from '../../domain/project-snapshot.ts'
import type { ProjectVersion } from '../../domain/project-version.ts'
import type { PublicEvent } from '../../domain/public-event.ts'

export type ReviewPatchProposalStatus = 'ready' | 'ambiguous' | 'prohibited' | 'budget-blocked' | 'applied'

export interface ReviewPatchProposal {
  id: string
  workspaceId: string
  projectId: string
  annotationId: string
  baseVersionId: string
  status: ReviewPatchProposalStatus
  interpretationVersion: string
  choices: readonly Readonly<(PatchOperation & { choiceId?: string })>[]
  patch: Readonly<PatchSet> | null
  impact: Readonly<PatchImpact> | null
  gates: readonly Readonly<PatchGateResult>[]
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

export interface ReviewPatchProposalContext {
  annotation: Readonly<ReviewAnnotation>
  currentVersion: Readonly<ProjectVersion>
  editPlan: Readonly<Record<string, unknown>>
  editPlanHash: string
  policies: Readonly<Record<string, unknown>>
  availableAssetIds: readonly string[]
}

export interface ReviewPatchApplyContext extends ReviewPatchProposalContext {
  proposal: Readonly<ReviewPatchProposal>
}

export interface ReviewPatchCommit {
  proposalId: string
  applyIdempotencyKey: string
  applyRequestFingerprint: string
  command: Readonly<EditCommand>
  snapshot: Readonly<ProjectSnapshot>
  version: Readonly<ProjectVersion>
  event: Readonly<PublicEvent>
  comparison: NonNullable<ReviewPatchProposal['comparison']>
}

export interface ReviewPatchApplyResult {
  proposal: Readonly<ReviewPatchProposal>
  command: Readonly<EditCommand>
  version: Readonly<ProjectVersion>
  editPlan: Readonly<Record<string, unknown>>
  comparison: NonNullable<ReviewPatchProposal['comparison']>
  replayed: boolean
}

export interface ReviewPatchRepository {
  findProposalIdempotent(input: { workspaceId: string; projectId: string; idempotencyKey: string }): Promise<Readonly<{ requestFingerprint: string; proposal: ReviewPatchProposal }> | null>
  readProposalContext(input: { workspaceId: string; projectId: string; annotationId: string }): Promise<Readonly<ReviewPatchProposalContext> | null>
  createProposal(input: { proposal: ReviewPatchProposal; idempotencyKey: string; requestFingerprint: string }): Promise<Readonly<ReviewPatchProposal>>
  readProposal(input: { workspaceId: string; projectId: string; proposalId: string }): Promise<Readonly<ReviewPatchProposal> | null>
  readApplyContext(input: { workspaceId: string; projectId: string; proposalId: string }): Promise<Readonly<ReviewPatchApplyContext> | null>
  readAppliedResult(input: { workspaceId: string; projectId: string; proposalId: string; applyIdempotencyKey: string; applyRequestFingerprint: string }): Promise<Readonly<ReviewPatchApplyResult> | null>
  commitOrReplay(bundle: ReviewPatchCommit): Promise<Readonly<ReviewPatchApplyResult>>
  attachRenderOperation(input: { workspaceId: string; projectId: string; proposalId: string; renderOperationId: string }): Promise<Readonly<ReviewPatchProposal>>
}
