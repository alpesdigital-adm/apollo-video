import type {
  AssetBrief,
  AssetCandidate,
  AssetCandidateRightsEvidence,
  AssetSelectionDecision,
} from '../../domain/asset-selection.ts'
import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'

export interface PersistedAssetSelection {
  schemaVersion: 'asset-selection/v1'
  id: string
  workspaceId: string
  projectId: string
  projectVersionId: string
  projectVersionHash: string
  brief: Readonly<AssetBrief>
  briefHash: string
  candidates: readonly Readonly<AssetCandidate>[]
  candidatesHash: string
  rightsEvidence: readonly Readonly<AssetCandidateRightsEvidence>[]
  result: Readonly<AssetSelectionDecision>
  selectionHash: string
  idempotencyKey: string
  requestFingerprint: string
  createdBy: Readonly<{ type: 'api-client'; id: string }>
  createdAt: string
}

export interface AssetSelectionProjectContext {
  workspaceId: string
  projectId: string
  projectVersionId: string
  projectVersionHash: string
  locale: string
}

export interface AssetSelectionRepository {
  readProjectContext(input: {
    workspaceId: string
    projectId: string
  }): Promise<Readonly<AssetSelectionProjectContext> | null>
  findIdempotent(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
    actorContextHash: string
  }): Promise<Readonly<PersistedAssetSelection> | null>
  persist(selection: Readonly<PersistedAssetSelection>, authenticationAudit: Readonly<ApiAccessAuditContext>): Promise<Readonly<{
    selection: Readonly<PersistedAssetSelection>
    replayed: boolean
  }>>
  list(input: {
    workspaceId: string
    projectId: string
    projectVersionId?: string
    limit: number
  }): Promise<readonly Readonly<PersistedAssetSelection>[]>
}
