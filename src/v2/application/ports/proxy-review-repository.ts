import type { ProxyReview } from '../render-workflow.ts'
import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'

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
    review: Readonly<ProxyReview>
    createdAt: string
  }): Promise<Readonly<PersistedProxyReview>>
  findCurrent(input: {
    workspaceId: string
    projectId: string
    projectVersionId?: string
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
