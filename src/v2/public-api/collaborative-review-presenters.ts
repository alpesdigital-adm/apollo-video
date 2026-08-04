import type {
  ReviewPatchBatch,
} from '../application/ports/review-patch-batch-repository.ts'
import type {
  ReviewPatchProposal,
} from '../application/ports/review-patch-repository.ts'

export function presentReviewPatchProposal(
  proposal: Readonly<ReviewPatchProposal>,
) {
  const { authenticationAudit: _authenticationAudit, ...publicProposal } =
    proposal
  return publicProposal
}

export function presentReviewPatchBatch(
  batch: Readonly<ReviewPatchBatch>,
) {
  const { authenticationAudit: _authenticationAudit, ...publicBatch } = batch
  return publicBatch
}
