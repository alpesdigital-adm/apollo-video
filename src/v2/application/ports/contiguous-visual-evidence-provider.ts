export interface ContiguousVisualEvidenceWindow {
  momentId: string
  rangeMs: readonly [number, number]
}

export interface ContiguousVisualEvidenceMeasurement {
  momentId: string
  rangeMs: readonly [number, number]
  durationMs: number
  sampledFrameCount: number
  averageLuma: number
  averageSaturation: number
  averageTemporalDifference: number
  temporalOutlierRatio: number
  repeatedPixelRatio: number
  broadcastRangeViolationRatio: number
  blackDurationMs: number
  blackRatio: number
  freezeDurationMs: number
  freezeRatio: number
  sceneChangeCount: number
}

export interface ContiguousVisualEvidenceProvider {
  measure(input: {
    sourceArtifactKey: string
    sourceArtifactSha256: string
    sourceArtifactByteSize: string
    sourceDurationMs: number
    windows: readonly Readonly<ContiguousVisualEvidenceWindow>[]
    signal: AbortSignal
  }): Promise<
    readonly Readonly<ContiguousVisualEvidenceMeasurement>[]
  >
}
