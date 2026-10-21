import type { ProxyReview } from '../render-workflow.ts'
import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'

/**
 * W70 readiness. Present on a review whose render was CARRIED from an earlier Version because nothing it is drawn from changed: the Version, the
 * review (and the hash it had when it was carried) and the content address that proved the inputs equal. `decisionId` is the
 * `carry-over-approval` decision that re-bound the approval the source review had, or null when the source review had none to re-bind (the
 * carry then approved nothing). It is an automatic carry, never a human acknowledgement made on this Version.
 */
export interface ProxyReviewCarriedFrom {
  versionId: string
  reviewId: string
  reviewHash: string
  decisionId: string | null
  renderContentHash: string
}

export interface PersistedProxyReview extends ProxyReview {
  id: string
  workspaceId: string
  projectId: string
  operationId: string
  revision: number
  acknowledgedBy?: Readonly<{
    type: 'api-client'
    id: string
    at: string
  }>
  carriedFrom?: Readonly<ProxyReviewCarriedFrom>
  createdAt: string
  updatedAt: string
}

export interface ProxyReviewDecision {
  id: string
  proxyReviewId: string
  action: 'acknowledge-warnings'
  actor: Readonly<{ type: 'api-client'; id: string }>
  baseReviewHash: string
  resultReviewHash: string
  createdAt: string
}

export interface ProxyReviewRepository {
  persistGenerated(input: {
    id: string
    workspaceId: string
    projectId: string
    operationId: string
    lease?: Readonly<{ owner: string; attempt: number; now: string }>
    review: Readonly<ProxyReview>
    createdAt: string
  }): Promise<Readonly<PersistedProxyReview>>
  /**
   * The newest review of one OUTPUT of a Version (the head when `projectVersionId` is absent). `variantId` is the stable State
   * variant; it may be omitted ONLY when the Version has exactly one output (a Version with several is refused with
   * `output-variant-required`, a stranger with `output-variant-unknown`): the review of another output is never returned.
   */
  findCurrent(input: {
    workspaceId: string
    projectId: string
    projectVersionId?: string
    variantId?: string
  }): Promise<Readonly<PersistedProxyReview> | null>
  acknowledgeWarnings(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    proxyReviewId: string
    baseReviewHash: string
    expectedRevision: number
    decisionId: string
    actor: Readonly<{ type: 'api-client'; id: string }>
    authenticationAudit: Readonly<ApiAccessAuditContext>
    idempotencyKey: string
    requestFingerprint: string
    createdAt: string
  }): Promise<Readonly<{
    review: Readonly<PersistedProxyReview>
    decision: Readonly<ProxyReviewDecision>
    replayed: boolean
  }>>
}
