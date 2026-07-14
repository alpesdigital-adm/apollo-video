import type { AssetRightsSnapshot } from '../../domain/asset-rights.ts'

export interface AssetRightsRecord {
  artifactId: string
  snapshot: AssetRightsSnapshot | null
}

export interface SetAssetRightsResult {
  artifactId: string
  snapshot: AssetRightsSnapshot
  replayed: boolean
}

export interface AssetRightsRepository {
  findCurrent(workspaceId: string, artifactId: string): Promise<AssetRightsRecord | null>
  findCurrentForArtifacts(
    workspaceId: string,
    artifactIds: readonly string[],
  ): Promise<ReadonlyMap<string, AssetRightsSnapshot | null>>
  setCurrent(snapshot: AssetRightsSnapshot): Promise<SetAssetRightsResult>
}
