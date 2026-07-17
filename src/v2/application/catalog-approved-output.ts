import { createHash } from 'crypto'
import type { RightsStatus } from '../domain/media-library.ts'

export interface PromotedOutput {
  workspaceId: string; artifactId: string; manifestId: string; kind: 'final' | 'proxy' | 'deepfake-raw' | 'temporary'
  promotionStatus: 'approved' | 'rejected' | 'failed'; parentArtifactIds: readonly string[]; generation?: { provider: string; model: string }
  rights: { status: RightsStatus; consentStatus: string; snapshotId: string }
}
export interface CatalogedOutput {
  id: string; workspaceId: string; artifactId: string; manifestId: string; searchableKind: 'asset' | 'segment'
  rights: PromotedOutput['rights']; lineage: { relation: 'generated-from'; parents: readonly string[]; generation?: PromotedOutput['generation'] }
}
export interface OutputCatalogRepository { findByKey(key: string): Promise<CatalogedOutput | null>; save(key: string, item: CatalogedOutput): Promise<CatalogedOutput> }

function catalogKey(output: PromotedOutput): string { return `${output.workspaceId}:${output.artifactId}:${output.manifestId}` }
export function isCatalogEligible(output: PromotedOutput): boolean { return output.promotionStatus === 'approved' && output.kind !== 'temporary' }

export async function catalogApprovedOutput(output: PromotedOutput, repository: OutputCatalogRepository): Promise<Readonly<{ status: 'cataloged' | 'already-cataloged' | 'ignored'; item: CatalogedOutput | null }>> {
  if (!isCatalogEligible(output)) return Object.freeze({ status: 'ignored', item: null })
  const key = catalogKey(output)
  const existing = await repository.findByKey(key)
  if (existing) return Object.freeze({ status: 'already-cataloged', item: existing })
  const item: CatalogedOutput = Object.freeze({ id: `catalog_${createHash('sha256').update(key).digest('hex').slice(0, 20)}`, workspaceId: output.workspaceId, artifactId: output.artifactId, manifestId: output.manifestId, searchableKind: output.kind === 'deepfake-raw' ? 'segment' : 'asset', rights: Object.freeze({ ...output.rights }), lineage: Object.freeze({ relation: 'generated-from' as const, parents: Object.freeze([...output.parentArtifactIds]), ...(output.generation ? { generation: Object.freeze({ ...output.generation }) } : {}) }) })
  return Object.freeze({ status: 'cataloged', item: await repository.save(key, item) })
}
