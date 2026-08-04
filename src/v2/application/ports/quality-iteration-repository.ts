import type {
  QualityIssue,
  ProxyRangeMetric,
  QualityTerminalReason,
} from '../closed-quality-loop.ts'
import type { PersistedAssetSelection } from './asset-selection-repository.ts'
import type { PersistedProxyReview } from './proxy-review-repository.ts'
import type { AssetRightsSnapshot } from '../../domain/asset-rights.ts'
import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'

export interface QualityRubricEvidence {
  criterionId: string
  score: number
  evidence: readonly string[]
}

export interface QualityAssetPlacementEvidence {
  selectionId: string
  selectionHash: string
  rangeMs: readonly [number, number]
  selectedArtifactId: string
  selectedSource: 'library' | 'stock' | 'generated'
  relevance: number
  continuity: number
  quality: number
  novelty: number
  rightsApproved: boolean
  rightsReasonCodes: readonly string[]
  rightsSnapshotId?: string
  rightsSnapshotHash?: string
}

export interface QualityProxyEvidence {
  id: string
  reviewHash: string
  revision: number
  status: 'blocked' | 'warning-ack-required' | 'ready-for-final'
  finalAllowed: boolean
  spec: Readonly<{
    width: number
    height: number
    codec: 'h264'
    container: 'mp4'
    quality: 'review'
    reusableRanges: true
  }>
  technicalIssues: readonly QualityIssue[]
  criticIssues: readonly QualityIssue[]
}

export interface PersistedQualityIteration {
  schemaVersion: 'quality-iteration/v1'
  id: string
  workspaceId: string
  projectId: string
  projectVersionId: string
  projectVersionHash: string
  iteration: number
  previousIterationId?: string
  proxyEvidence: Readonly<QualityProxyEvidence>
  assetPlacements: readonly Readonly<QualityAssetPlacementEvidence>[]
  rubric: Readonly<{
    id: string
    version: number
    objective: string
    threshold: number
    evidence: readonly Readonly<QualityRubricEvidence>[]
  }>
  rangeMetrics: readonly Readonly<ProxyRangeMetric>[]
  dataset: Readonly<{
    id: string
    version: number
    baselineScore: number
    fingerprint: string
  }>
  score: number
  regression: number
  regressed: boolean
  validation: Readonly<{
    valid: boolean
    finalBlocked: boolean
    hardIssueCount: number
    warningIssueCount: number
    hardByCategory: Readonly<Record<string, number>>
  }>
  issues: readonly Readonly<QualityIssue>[]
  patches: readonly Readonly<{
    type: 'replace_asset' | 'adjust'
    targetId: string
    issueCode: string
    rangeMs?: readonly [number, number]
  }>[]
  minimalRerenderRangesMs: readonly (readonly [number, number])[]
  fullRerenderRequired: boolean
  budget: Readonly<{
    limitUnits: number
    consumedUnits: number
    remainingUnits: number
    iterationCostUnits: number
  }>
  decision: Readonly<{
    continue: boolean
    terminalReason: QualityTerminalReason | null
  }>
  reportFingerprint: string
  recordHash: string
  idempotencyKey: string
  requestFingerprint: string
  createdBy: Readonly<{ type: 'api-client'; id: string }>
  createdAt: string
}

export interface QualityIterationContext {
  workspaceId: string
  projectId: string
  projectVersionId: string
  projectVersionHash: string
  objective: string
  format: string
  locale: string
  proxyReview: Readonly<PersistedProxyReview>
  assetSelections: readonly Readonly<PersistedAssetSelection>[]
  currentRightsByArtifact: ReadonlyMap<string, Readonly<AssetRightsSnapshot> | null>
  previousIteration: Readonly<PersistedQualityIteration> | null
}

export interface QualityIterationRepository {
  findIdempotent(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
    actorContextHash: string
  }): Promise<Readonly<PersistedQualityIteration> | null>
  readContext(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    proxyReviewId: string
    assetSelectionIds: readonly string[]
  }): Promise<Readonly<QualityIterationContext> | null>
  persist(
    iteration: Readonly<PersistedQualityIteration>,
    authenticationAudit: Readonly<ApiAccessAuditContext>,
  ): Promise<Readonly<{
    iteration: Readonly<PersistedQualityIteration>
    replayed: boolean
  }>>
  list(input: {
    workspaceId: string
    projectId: string
    projectVersionId?: string
    limit: number
  }): Promise<readonly Readonly<PersistedQualityIteration>[]>
}
