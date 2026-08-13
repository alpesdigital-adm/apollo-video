import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type { MontageSelection } from '../../domain/montage-candidate.ts'

export interface MontageAlternativeRun {
  schemaVersion: 'montage-alternative-run/v1'
  id: string
  workspaceId: string
  projectId: string
  policyVersion: string
  storyPlanRef: Readonly<{ id: string; hash: string }>
  selection: Readonly<MontageSelection>
  createdByClientId: string
  createdAt: string
  runHash: string
}

export interface PersistedMontageAlternativeRun extends MontageAlternativeRun {
  requestFingerprint: string
  idempotencyKey: string
}

export interface MontageAlternativeRepository {
  readStoryPlanReference(input: { workspaceId: string; projectId: string; storyPlanId: string }): Promise<Readonly<{ id: string; hash: string }> | null>
  findReplay(input: { workspaceId: string; projectId: string; actorClientId: string; idempotencyKey: string; actorContextHash: string }): Promise<Readonly<PersistedMontageAlternativeRun> | null>
  create(input: { run: Readonly<MontageAlternativeRun>; requestFingerprint: string; idempotencyKey: string; authenticationAudit: Readonly<ApiAccessAuditContext> }): Promise<Readonly<{ run: Readonly<PersistedMontageAlternativeRun>; replayed: boolean }>>
  read(input: { workspaceId: string; projectId: string; runId: string }): Promise<Readonly<PersistedMontageAlternativeRun> | null>
}
