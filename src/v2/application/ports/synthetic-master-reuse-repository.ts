import type { ProviderJob } from '../../domain/provider-job.ts'
import type { SyntheticCacheDecision } from '../../domain/synthetic-cache-decision.ts'
import type { SyntheticAvatarCacheSubject } from '../../domain/synthetic-cache-identity.ts'
import type { SyntheticMasterAsset, SyntheticMasterArtifactRef } from '../../domain/synthetic-master-asset.ts'
import type { SyntheticMasterConsumption } from '../../domain/synthetic-master-consumption.ts'

export interface CanonicalSyntheticMasterReuseSource {
  master: Readonly<SyntheticMasterAsset>
  sourceJob: Readonly<ProviderJob>
  providerOriginal: Readonly<SyntheticMasterArtifactRef>
  finalAudio: Readonly<SyntheticMasterArtifactRef>
  alignment: Readonly<SyntheticMasterArtifactRef>
  cacheSubject: Readonly<SyntheticAvatarCacheSubject>
  productionAlignmentHash: string
  currentAuthorityValid: boolean
}

export interface PreparedCanonicalMasterReuse {
  decision: Readonly<SyntheticCacheDecision>
  consumption: Readonly<SyntheticMasterConsumption>
}

export interface SyntheticMasterReuseRepository {
  /**
   * Resolves one source by the canonical first job/artifact pair. The unique
   * provider-job identity selects the master; row order and timestamps never do.
   */
  resolveCanonicalSource(input: {
    workspaceId: string
    sourceProviderJobId: string
    sourceArtifactId: string
    sourceArtifactSha256: string
    use: string
    market: string
    locale: string
    at: Date
  }): Promise<Readonly<CanonicalSyntheticMasterReuseSource> | null>

  readByRun(input: {
    workspaceId: string
    consumerProjectId: string
    productionRunId: string
  }): Promise<Readonly<SyntheticMasterConsumption> | null>

  listBySourceProjectVersion(input: {
    workspaceId: string
    sourceProjectId: string
    sourceProjectVersionId: string
    limit: number
  }): Promise<readonly Readonly<SyntheticMasterConsumption>[]>
}
