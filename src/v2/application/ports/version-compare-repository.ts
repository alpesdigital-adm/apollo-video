import type { EditCommand } from '../../domain/edit-command.ts'
import type {
  VersionCompareMode,
} from '../../domain/manual-editing.ts'
import type { PublicEvent } from '../../domain/public-event.ts'

export interface PersistedVersionCompareDecision {
  schemaVersion: 1
  action: 'accept' | 'reopen'
  expectedRevision: number
  beforeVersionId: string
  afterVersionId: string
  mode: VersionCompareMode
  comparison: Readonly<Record<string, unknown>>
}

export interface VersionCompareDecisionResult {
  command: Readonly<EditCommand<PersistedVersionCompareDecision>>
  projectStatus: 'reviewing-proxy' | 'revising'
  comparison: Readonly<Record<string, unknown>>
  replayed: boolean
}

export interface VersionCompareDecisionCommit {
  command: Readonly<EditCommand<PersistedVersionCompareDecision>>
  requestFingerprint: string
  projectStatus: VersionCompareDecisionResult['projectStatus']
  event: Readonly<PublicEvent>
}

export interface VersionCompareRepository {
  findIdempotentDecision(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
  }): Promise<Readonly<{
    requestFingerprint: string
    result: VersionCompareDecisionResult
  }> | null>
  commitDecision(bundle: VersionCompareDecisionCommit): Promise<VersionCompareDecisionResult>
}
