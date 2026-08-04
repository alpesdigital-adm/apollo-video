import type { CompareActionImpactV1 } from '../../domain/compare-action-impact.ts'
import type { EditCommand } from '../../domain/edit-command.ts'
import type {
  VersionCompareMode,
} from '../../domain/manual-editing.ts'
import type { PublicEvent } from '../../domain/public-event.ts'
import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'

/**
 * schemaVersion 2 carries the explicit zero impact of the decision. There is no
 * reader for schemaVersion 1: a stored payload without an impact fails closed as
 * PERSISTENCE_CONFLICT instead of being silently treated as impact-free.
 */
export interface PersistedVersionCompareDecision {
  schemaVersion: 2
  action: 'accept' | 'reopen'
  expectedRevision: number
  beforeVersionId: string
  afterVersionId: string
  mode: VersionCompareMode
  comparison: Readonly<Record<string, unknown>>
  impact: Readonly<CompareActionImpactV1>
}

export interface VersionCompareDecisionResult {
  command: Readonly<EditCommand<PersistedVersionCompareDecision>>
  projectStatus: 'reviewing-proxy' | 'revising'
  comparison: Readonly<Record<string, unknown>>
  impact: Readonly<CompareActionImpactV1>
  replayed: boolean
}

export interface VersionCompareDecisionCommit {
  command: Readonly<EditCommand<PersistedVersionCompareDecision>>
  authenticationAudit: Readonly<ApiAccessAuditContext>
  requestFingerprint: string
  projectStatus: VersionCompareDecisionResult['projectStatus']
  event: Readonly<PublicEvent>
}

export interface VersionCompareRepository {
  findIdempotentDecision(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
    actorContextHash: string
  }): Promise<Readonly<{
    requestFingerprint: string
    result: VersionCompareDecisionResult
  }> | null>
  commitDecision(bundle: VersionCompareDecisionCommit): Promise<VersionCompareDecisionResult>
}
