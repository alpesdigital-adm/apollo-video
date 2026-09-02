import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type { SyntheticMasterAsset } from '../../domain/synthetic-master-asset.ts'

export interface PersistedSyntheticMasterAsset {
  master: Readonly<SyntheticMasterAsset>
  requestFingerprint: string
  idempotencyKey: string
}

export interface SyntheticMasterAssetRepository {
  findReplay(input: {
    workspaceId: string
    projectId: string
    actorClientId: string
    actorContextHash: string
    idempotencyKey: string
  }): Promise<Readonly<PersistedSyntheticMasterAsset> | null>

  /**
   * Seals a master transactionally. The provider job must still be approved
   * with the exact critic hash the promotion validated, and the presenter
   * snapshot must still carry the hash the bytes were generated from: either
   * moving between validation and commit is a VERSION_CONFLICT, never a
   * silently published master.
   */
  create(input: {
    master: Readonly<SyntheticMasterAsset>
    profileSnapshotHash: string
    criticResultHash: string
    requestFingerprint: string
    idempotencyKey: string
    authenticationAudit: Readonly<ApiAccessAuditContext>
  }): Promise<Readonly<{ value: Readonly<PersistedSyntheticMasterAsset>; replayed: boolean }>>

  read(input: {
    workspaceId: string
    masterId: string
  }): Promise<Readonly<PersistedSyntheticMasterAsset> | null>

  findByProviderJob(input: {
    workspaceId: string
    providerJobId: string
  }): Promise<Readonly<PersistedSyntheticMasterAsset> | null>

  /** Content-addressed lookup: the same performance is never sealed twice. */
  findByMasterHash(input: {
    workspaceId: string
    masterHash: string
  }): Promise<Readonly<PersistedSyntheticMasterAsset> | null>

  list(input: {
    workspaceId: string
    projectId?: string
    profileId?: string
    scriptHash?: string
    limit: number
  }): Promise<readonly Readonly<PersistedSyntheticMasterAsset>[]>
}
