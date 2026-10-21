import type { AuthenticatedExternalActor } from '../authenticate-api-client.ts'

/**
 * W70 prep. What it takes to carry the render, the review and the approval of ONE output from an earlier Version to the current one when
 * nothing that output is drawn from changed.
 *
 * The repository never decides that nothing changed: the service hands it the content address of the pre-render identity of the output at the
 * Version being carried TO (`renderContentHash`), and it carries only from a render whose own stored content address is exactly that. A render
 * written before the address existed has none and is never a source.
 */
export interface ProxyCarryOverRequest {
  workspaceId: string
  projectId: string
  /** The head Version the render is carried to; the carry is refused when it is not the head any more. */
  toProjectVersionId: string
  /** The stable State variant of the output. */
  variantId: string
  /** The Version-independent content address of this output's pre-render identity at `toProjectVersionId`. */
  renderContentHash: string
  /**
   * W70 readiness (R2). What the address cannot see, read for `toProjectVersionId` now: the digest of the face windows the caption placement
   * of this output reads (with the pending ones), and of the Director's quality issues its review would be built over. A source render whose
   * stored digests are not exactly these is not carried (`face-evidence-moved`, `critic-issues-moved`), and one without them is never a source.
   */
  faceEvidenceDigest: string
  criticIssuesDigest: string
  /** The pre-render input hash a fresh render of `toProjectVersionId` would carry (the operation the carry writes is this one). */
  inputHash: string
  editPlanSnapshotId: string
  sourceArtifactId: string
  sourceManifestId: string
  originalFileName: string
  /** What the range cache key of a review of this Version for this output is made of (it names the Version, so it is recomputed, not copied). */
  rangeCache: Readonly<{ sourceSha256: string; editPlanHash: string; format: string }>
  actor: AuthenticatedExternalActor
  /** The Command that created `toProjectVersionId`, when known: recorded on the carried operation. */
  commandId?: string
  traceId?: string
  now: string
  ids: Readonly<{ operation: string; review: string; decision: string; map: string }>
}

export type ProxyCarryOverResult =
  | Readonly<{
    status: 'carried'
    operationId: string
    reviewId: string
    fromProjectVersionId: string
    fromOperationId: string
    fromReviewId: string
    fromReviewHash: string
    reviewHash: string
    /** The approval the source review had (a human acknowledgement of its warnings) was re-bound to the new review by a decision of its own. */
    approvalCarried: boolean
    outputArtifactId: string
  }>
  | Readonly<{ status: 'present'; operationId: string }>
  | Readonly<{ status: 'not-eligible'; reason: ProxyCarryOverRefusal }>

export const PROXY_CARRY_OVER_REFUSALS = Object.freeze([
  'head-moved', 'no-source-render', 'source-not-ancestor', 'source-incomplete', 'command-impact-missing', 'face-evidence-moved', 'critic-issues-moved',
] as const)
export type ProxyCarryOverRefusal = (typeof PROXY_CARRY_OVER_REFUSALS)[number]

export interface ProxyCarryOverRepository {
  carry(request: Readonly<ProxyCarryOverRequest>): Promise<ProxyCarryOverResult>
}
