import type { PersistedProxyReview } from '../application/ports/proxy-review-repository.ts'

/**
 * The public shape of a proxy review (`project-proxy-review-response/v4`). `carriedFrom` is present only when the review's render was carried from
 * an earlier Version: it says so, and names the review, the decision that re-bound the approval and the content address that proved the inputs equal,
 * so an inherited approval is never mistaken for a human acknowledgement made on this Version.
 */
export function presentProxyReview(review: Readonly<PersistedProxyReview>) {
  return {
    id: review.id,
    projectId: review.projectId,
    projectVersionId: review.projectVersionId,
    operationId: review.operationId,
    proxyArtifactId: review.proxyArtifactId,
    proxyManifestId: review.proxyManifestId,
    inputHash: review.inputHash,
    outputSpecId: review.outputSpecId,
    rangeCacheKey: review.rangeCacheKey,
    spec: review.spec,
    status: review.status,
    technicalIssues: review.technicalIssues,
    criticIssues: review.criticIssues,
    ...(review.formatQuality ? { formatQuality: review.formatQuality } : {}),
    warningsAcknowledged: review.warningsAcknowledged,
    finalAllowed: review.finalAllowed,
    uploadReceivedAt: review.uploadReceivedAt,
    renderCompletedAt: review.renderCompletedAt,
    timeToFirstProxyMs: review.timeToFirstProxyMs,
    reviewHash: review.reviewHash,
    revision: review.revision,
    ...(review.acknowledgedBy ? { acknowledgedBy: review.acknowledgedBy } : {}),
    ...(review.carriedFrom ? {
      carriedFrom: {
        versionId: review.carriedFrom.versionId,
        reviewId: review.carriedFrom.reviewId,
        reviewHash: review.carriedFrom.reviewHash,
        decisionId: review.carriedFrom.decisionId,
        renderContentHash: review.carriedFrom.renderContentHash,
      },
    } : {}),
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
  }
}
