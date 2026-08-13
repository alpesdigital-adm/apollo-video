import { createAssetRightsChangeIntent } from '../domain/asset-rights-change.ts'
import { assertAutomaticCatalogCandidate, createInheritedCatalogRights } from '../domain/automatic-catalog.ts'
import { DomainError } from '../domain/errors.ts'
import type { AssetRightsRepository } from './ports/asset-rights-repository.ts'
import type { AutomaticCatalogRepository } from './ports/automatic-catalog-repository.ts'

export function catalogApprovedOutputService(dependencies: {
  repository: AutomaticCatalogRepository
  rights: AssetRightsRepository
  clock?: () => Date
}) {
  const clock = dependencies.clock ?? (() => new Date())
  return async (target: { workspaceId: string; artifactId: string; manifestId: string }) => {
    const candidate = await dependencies.repository.inspect(target)
    if (!candidate) return Object.freeze({ status: 'ignored' as const, record: null })
    assertAutomaticCatalogCandidate(candidate)
    const sourceIds = [...new Set(candidate.lineage.map((edge) => edge.sourceArtifactId))]
    const sourceRights = await dependencies.rights.findCurrentForArtifacts(candidate.workspaceId, sourceIds)
    const snapshots = sourceIds.map((id) => sourceRights.get(id) ?? null)
    if (snapshots.some((snapshot) => snapshot === null)) throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Catalog output source rights evidence is incomplete')
    const current = await dependencies.rights.findCurrent(candidate.workspaceId, candidate.artifactId)
    if (!current) throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Catalog output artifact was not found')
    const createdAt = clock().toISOString()
    const inherited = createInheritedCatalogRights({
      candidate,
      sourceSnapshots: snapshots as NonNullable<(typeof snapshots)[number]>[],
      sequence: (current.snapshot?.sequence ?? 0) + 1,
      createdAt,
    })
    let rightsSnapshot = current.snapshot
    if (rightsSnapshot?.snapshotHash !== inherited.snapshotHash) {
      const change = createAssetRightsChangeIntent({
        workspaceId: candidate.workspaceId,
        artifactId: candidate.artifactId,
        snapshotHash: inherited.snapshotHash,
        baseRevision: current.revision,
        actor: { kind: 'internal', actorType: 'system', actorId: 'automatic-catalog' },
        changedAt: createdAt,
      })
      rightsSnapshot = (await dependencies.rights.setCurrent(inherited, current.revision, change)).snapshot
    }
    if (!rightsSnapshot || rightsSnapshot.snapshotHash !== inherited.snapshotHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Catalog output rights did not converge')
    const result = await dependencies.repository.persist({ candidate, rightsSnapshotId: rightsSnapshot.id, rightsSnapshotHash: rightsSnapshot.snapshotHash, createdAt })
    return Object.freeze({ status: result.replayed ? 'already-cataloged' as const : 'cataloged' as const, record: result.record })
  }
}

export function readAutomaticCatalogRecordService(dependencies: { repository: AutomaticCatalogRepository }) {
  return async (workspaceId: string, artifactId: string) => {
    const record = await dependencies.repository.find(workspaceId, artifactId)
    if (!record) throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Automatic catalog record was not found')
    return record
  }
}
