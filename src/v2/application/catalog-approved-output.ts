import { createAssetRightsChangeIntent } from '../domain/asset-rights-change.ts'
import { assertAutomaticCatalogCandidate, assertCatalogOutputRightsWithinSources, createInheritedCatalogRights } from '../domain/automatic-catalog.ts'
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
    if (!candidate) return Object.freeze({ status: 'ignored' as const, reason: 'not-approved' as const, record: null })
    assertAutomaticCatalogCandidate(candidate)
    const sourceIds = [...new Set(candidate.lineage.map((edge) => edge.sourceArtifactId))]
    const sourceRights = await dependencies.rights.findCurrentForArtifacts(candidate.workspaceId, sourceIds)
    const snapshots = sourceIds.map((id) => sourceRights.get(id) ?? null)
    // Catalog eligibility is optional for an otherwise valid render. Missing or
    // restricted source rights must leave no searchable row, without failing
    // the render operation after its output has already been promoted.
    if (snapshots.some((snapshot) => snapshot === null)) return Object.freeze({ status: 'ignored' as const, reason: 'source-rights-missing' as const, record: null })
    const current = await dependencies.rights.findCurrent(candidate.workspaceId, candidate.artifactId)
    if (!current) throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Catalog output artifact was not found')
    if (candidate.outputKind !== 'deepfake-raw' && current.snapshot && (current.snapshot.createdBy.type !== 'system' || current.snapshot.createdBy.id !== 'automatic-catalog')) {
      return Object.freeze({ status: 'ignored' as const, reason: 'output-rights-managed' as const, record: null })
    }
    const createdAt = clock().toISOString()
    let inherited
    try {
      inherited = createInheritedCatalogRights({
        candidate,
        sourceSnapshots: snapshots as NonNullable<(typeof snapshots)[number]>[],
        sequence: (current.snapshot?.sequence ?? 0) + 1,
        createdAt,
      })
    } catch (error) {
      if (error instanceof DomainError && error.code === 'ASSET_RIGHTS_BLOCKED') return Object.freeze({ status: 'ignored' as const, reason: 'source-rights-blocked' as const, record: null })
      throw error
    }
    let rightsSnapshot = current.snapshot
    if (candidate.outputKind === 'deepfake-raw') {
      if (!rightsSnapshot) return Object.freeze({ status: 'ignored' as const, reason: 'output-rights-managed' as const, record: null })
      try { assertCatalogOutputRightsWithinSources(rightsSnapshot, inherited, createdAt) }
      catch (error) {
        if (error instanceof DomainError && error.code === 'ASSET_RIGHTS_BLOCKED') return Object.freeze({ status: 'ignored' as const, reason: 'source-rights-blocked' as const, record: null })
        throw error
      }
    } else if (rightsSnapshot?.snapshotHash !== inherited.snapshotHash) {
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
    if (!rightsSnapshot || (candidate.outputKind !== 'deepfake-raw' && rightsSnapshot.snapshotHash !== inherited.snapshotHash)) throw new DomainError('PERSISTENCE_CONFLICT', 'Catalog output rights did not converge')
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
