export interface ContiguousAudioEvidenceWindow {
  momentId: string
  rangeMs: readonly [number, number]
}

export interface ContiguousAudioEvidenceMeasurement {
  momentId: string
  rangeMs: readonly [number, number]
  durationMs: number
  integratedLufs: number
  truePeakDbfs: number
  meanVolumeDb: number
  maximumVolumeDb: number
  silenceDurationMs: number
  silenceRatio: number
  audibleSignal: boolean
  clippingRisk: boolean
}

export interface ContiguousAudioEvidenceProvider {
  measure(input: {
    sourceArtifactKey: string
    sourceArtifactSha256: string
    sourceArtifactByteSize: string
    sourceDurationMs: number
    windows: readonly Readonly<ContiguousAudioEvidenceWindow>[]
    signal: AbortSignal
  }): Promise<
    readonly Readonly<ContiguousAudioEvidenceMeasurement>[]
  >
}
