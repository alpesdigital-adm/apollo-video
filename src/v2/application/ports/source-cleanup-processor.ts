import type {
  SourceCleanupAction,
  SourceSeparationOffer,
} from '../../domain/source-cleanup.ts'
import type {
  SourceSeparationProvider,
} from './source-separation-provider.ts'

export interface SourceCleanupProcessingResult {
  outputPath: string
  sha256: string
  byteSize: number
  probe: {
    width: number
    height: number
    duration: number
    fps: number
    codec: string
    container: string
  }
  visual: {
    passed: boolean
    contaminationRemoved: boolean
    outputPlayable: boolean
    durationAligned: boolean
    framingPreserved: boolean
    residualQuality: number
    reasonCodes: readonly string[]
  }
  audio?: {
    passed: boolean
    providerBindingVerified: boolean
    isolatedSpeechPresent: boolean
    durationAligned: boolean
    reasonCodes: readonly string[]
  }
  separation?: {
    providerRequestId: string
    isolatedAudioSha256: string
    isolatedAudioByteSize: number
    offer: Readonly<SourceSeparationOffer>
  }
}

export interface SourceCleanupProcessor {
  process(input: {
    operationId: string
    sourcePath: string
    sourceSha256: string
    sourceDurationMs: number
    action: Exclude<SourceCleanupAction, { strategy: 'reject' }>
    signal?: AbortSignal
  }): Promise<Readonly<SourceCleanupProcessingResult>>
  cleanup(operationId: string): Promise<void>
}

export type SourceCleanupSeparationProvider = SourceSeparationProvider
