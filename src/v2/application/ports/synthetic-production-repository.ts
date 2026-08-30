import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type { ProjectSnapshot } from '../../domain/project-snapshot.ts'
import type {
  SyntheticPresenterEditPlan,
  SyntheticPresenterProfileHead,
  SyntheticPresenterProfileSnapshot,
} from '../../domain/synthetic-production.ts'

export interface PersistedSyntheticPresenterProfile {
  snapshot: Readonly<SyntheticPresenterProfileSnapshot>
  /**
   * Versioned physical identity of the persisted snapshot row
   * (`${profileId}:v${version}`). This is the identity foreign keys to
   * `synthetic_presenter_profiles(id)` must reference; the logical
   * `snapshot.id` alone does not identify a persisted version.
   */
  profileSnapshotId: string
  requestFingerprint: string
  idempotencyKey: string
  createdAt: string
}

export interface PersistedSyntheticProductionRun {
  plan: Readonly<SyntheticPresenterEditPlan>
  editPlanSnapshotId: string
  status: 'compiled' | 'rendering' | 'completed' | 'failed' | 'canceled'
  requestFingerprint: string
  idempotencyKey: string
}

export interface SyntheticProductionRepository {
  findProfileReplay(input: {
    workspaceId: string
    actorClientId: string
    actorContextHash: string
    idempotencyKey: string
  }): Promise<Readonly<PersistedSyntheticPresenterProfile> | null>
  createProfile(input: {
    snapshot: Readonly<SyntheticPresenterProfileSnapshot>
    workspaceId: string
    requestFingerprint: string
    idempotencyKey: string
    authenticationAudit: Readonly<ApiAccessAuditContext>
    createdAt: string
  }): Promise<Readonly<{
    profile: Readonly<PersistedSyntheticPresenterProfile>
    replayed: boolean
  }>>
  readProfile(input: {
    workspaceId: string
    snapshotId: string
  }): Promise<Readonly<PersistedSyntheticPresenterProfile> | null>
  listProfileHeads(input: {
    workspaceId: string
  }): Promise<readonly Readonly<{
    head: Readonly<SyntheticPresenterProfileHead>
    current: Readonly<PersistedSyntheticPresenterProfile>
  }>[]>
  readProfileHead(input: {
    workspaceId: string
    profileId: string
  }): Promise<Readonly<{
    head: Readonly<SyntheticPresenterProfileHead>
    current: Readonly<PersistedSyntheticPresenterProfile>
  }> | null>
  listProfileVersions(input: {
    workspaceId: string
    profileId: string
  }): Promise<readonly Readonly<PersistedSyntheticPresenterProfile>[]>
  findRunReplay(input: {
    workspaceId: string
    projectId: string
    actorClientId: string
    actorContextHash: string
    idempotencyKey: string
  }): Promise<Readonly<PersistedSyntheticProductionRun> | null>
  createRun(input: {
    plan: Readonly<SyntheticPresenterEditPlan>
    editPlanSnapshot: Readonly<ProjectSnapshot>
    requestFingerprint: string
    idempotencyKey: string
    authenticationAudit: Readonly<ApiAccessAuditContext>
  }): Promise<Readonly<{
    run: Readonly<PersistedSyntheticProductionRun>
    replayed: boolean
  }>>
  readRun(input: {
    workspaceId: string
    projectId: string
    runId: string
  }): Promise<Readonly<PersistedSyntheticProductionRun> | null>
}
