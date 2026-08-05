import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type { MediaTranscriber } from './media-ingest.ts'
import type { SpeakerDiarizationProvider } from './speaker-diarization-provider.ts'

export interface ProviderRuntimeIdentity {
  provider: string
  model: string
  version: string
}

export interface ProviderRuntimeRouter {
  resolveTranscription(
    audit: Readonly<ApiAccessAuditContext>,
  ): Readonly<{
    identity: Readonly<ProviderRuntimeIdentity>
    pricingMinorUnitsPerHour: number
    create(): MediaTranscriber
  }>
  resolveDiarization(
    audit: Readonly<ApiAccessAuditContext>,
  ): Readonly<{
    identity: Readonly<ProviderRuntimeIdentity>
    pricingMinorUnitsPerHour: number
    create(): SpeakerDiarizationProvider
  }>
}
