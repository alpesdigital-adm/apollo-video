import type {
  SourceSeparationOffer,
} from '../../domain/source-cleanup.ts'

export interface SourceSeparationResult {
  isolatedAudioPath: string
  isolatedAudioSha256: string
  isolatedAudioByteSize: number
  providerRequestId: string
  offer: Readonly<SourceSeparationOffer>
}

export interface SourceSeparationProvider {
  offer(sourceDurationMs: number): Readonly<SourceSeparationOffer>
  isolate(input: {
    operationId: string
    sourcePath: string
    sourceSha256: string
    sourceDurationMs: number
    expectedOffer: Readonly<SourceSeparationOffer>
    signal?: AbortSignal
  }): Promise<Readonly<SourceSeparationResult>>
}
