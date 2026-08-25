import type { AsyncMediaProviderAdapter } from './async-media-provider.ts'
import type { ProviderJob, ProviderJobResultArtifact } from '../../domain/provider-job.ts'

export interface ProviderAdapterRegistry {
  get(input: { adapterId: string; adapterVersion: string }): AsyncMediaProviderAdapter<Readonly<Record<string, unknown>>, unknown> | null
}

export interface ProviderSubmissionInputMaterializer {
  materialize(input: {
    job: Readonly<ProviderJob>
  }): Promise<Readonly<Record<string, unknown>>>
}

export interface ProviderResultIngestor {
  ingest(input: {
    job: Readonly<ProviderJob>
    providerResult: unknown
  }): Promise<Readonly<ProviderJobResultArtifact>>
}

export interface ProviderResultCritic {
  evaluate(input: {
    job: Readonly<ProviderJob>
    artifact: Readonly<ProviderJobResultArtifact>
  }): Promise<Readonly<{ approved: boolean; resultHash: string }>>
}
