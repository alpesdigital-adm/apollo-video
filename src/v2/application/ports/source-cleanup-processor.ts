import type {
  SourceCleanupAction,
} from '../../domain/source-cleanup.ts'

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
}

export interface SourceCleanupProcessor {
  process(input: {
    operationId: string
    sourcePath: string
    sourceDurationMs: number
    action: Exclude<SourceCleanupAction, { strategy: 'reject' }>
    signal?: AbortSignal
  }): Promise<Readonly<SourceCleanupProcessingResult>>
  cleanup(operationId: string): Promise<void>
}
