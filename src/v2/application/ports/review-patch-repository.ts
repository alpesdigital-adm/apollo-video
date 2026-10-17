import type { AdoptableObservationReader } from './adoptable-observation-reader.ts'
import type { EditCommand } from '../../domain/edit-command.ts'
import type { PatchGateResult, PatchImpact, PatchOperation, PatchSet, ReviewAnnotation } from '../../domain/review-system.ts'
import type { OperationalOutputParentV3, OperationalOutputVersionBundleV3 } from '../../domain/output-version-bundle.ts'
import type { ProjectVersionV2, ProjectVersionV3 } from '../../domain/project-version.ts'
import type { PublicEvent } from '../../domain/public-event.ts'
import type { CommandArtifactInvalidationV1, CommandImpactOutputReference, CommandImpactV1 } from '../../domain/command-impact.ts'
import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'

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
  authenticationAudit: Readonly<ApiAccessAuditContext>
}

export interface ReviewPatchProposalContext {
  annotation: Readonly<ReviewAnnotation>
  /** The sealed output bundle of the current head: the exact parent an applied patch's Version is born from. */
  parent: OperationalOutputParentV3
  currentVersion: Readonly<ProjectVersionV2 | ProjectVersionV3>
  editPlan: Readonly<Record<string, unknown>>
  editPlanHash: string
  policies: Readonly<Record<string, unknown>>
  availableAssetIds: readonly string[]
  renderVariantIds: readonly string[]
  outputReferences: readonly Readonly<CommandImpactOutputReference>[]
}

export interface ReviewPatchApplyContext extends ReviewPatchProposalContext {
  proposal: Readonly<ReviewPatchProposal>
}

export interface ReviewPatchCommit {
  proposalId: string
  applyIdempotencyKey: string
  applyRequestFingerprint: string
  /** Version, State, patched EditPlan, Command and credential audit, sealed together by the child-command transition. */
  bundle: Readonly<OperationalOutputVersionBundleV3>
  event: Readonly<PublicEvent>
  comparison: NonNullable<ReviewPatchProposal['comparison']>
  impact: Readonly<CommandImpactV1>
}

export interface ReviewPatchApplyResult {
  proposal: Readonly<ReviewPatchProposal>
  command: Readonly<EditCommand>
  version: Readonly<ProjectVersionV3>
  editPlan: Readonly<Record<string, unknown>>
  comparison: NonNullable<ReviewPatchProposal['comparison']>
  impact: Readonly<CommandImpactV1>
  invalidations: readonly Readonly<CommandArtifactInvalidationV1>[]
  replayed: boolean
}

export interface ReviewPatchRepository extends Partial<AdoptableObservationReader> {
  findProposalIdempotent(input: { workspaceId: string; projectId: string; idempotencyKey: string; actorContextHash: string }): Promise<Readonly<{ requestFingerprint: string; proposal: ReviewPatchProposal }> | null>
  readProposalContext(input: { workspaceId: string; projectId: string; annotationId: string }): Promise<Readonly<ReviewPatchProposalContext> | null>
  createProposal(input: { proposal: ReviewPatchProposal; idempotencyKey: string; requestFingerprint: string }): Promise<Readonly<ReviewPatchProposal>>
  readProposal(input: { workspaceId: string; projectId: string; proposalId: string }): Promise<Readonly<ReviewPatchProposal> | null>
  readApplyContext(input: { workspaceId: string; projectId: string; proposalId: string }): Promise<Readonly<ReviewPatchApplyContext> | null>
  readAppliedResult(input: { workspaceId: string; projectId: string; proposalId: string; applyIdempotencyKey: string; applyRequestFingerprint: string; actorContextHash: string }): Promise<Readonly<ReviewPatchApplyResult> | null>
  commitOrReplay(bundle: ReviewPatchCommit): Promise<Readonly<ReviewPatchApplyResult>>
  attachRenderOperation(input: { workspaceId: string; projectId: string; proposalId: string; renderOperationId: string }): Promise<Readonly<ReviewPatchProposal>>
}
