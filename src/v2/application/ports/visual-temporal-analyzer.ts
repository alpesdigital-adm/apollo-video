export type SourceClock = Readonly<{ num: number; den: number }>
export type TemporalRange = Readonly<{ startSourcePts: number; endSourcePts: number }>
export type TemporalGap = Readonly<TemporalRange & { reasonCode: 'UNRELIABLE_FRAME_DIFFERENCE' }>

export type VisualTemporalAnalysis = Readonly<{
  algorithmVersion: 'visual-temporal-grid/v1'
  sourceSha256: string
  sourceFps: SourceClock
  sourceTimebase: SourceClock
  sourceClock: 'constant-frame-rate'
  sourceWidth: number
  sourceHeight: number
  observedFrameCount: number
  /** Only adjacent-frame intervals [first observed PTS, last observed PTS]. */
  assessedDomain: TemporalRange
  analysisGrid: Readonly<{ width: 160; height: 90 }>
  runtime: Readonly<{ ffmpegSha256: string; ffprobeSha256: string }>
  shot: Readonly<{
    observations: readonly Readonly<TemporalRange & {
      previousFrame: number; currentFrame: number
      previousGridSha256: string; currentGridSha256: string
      changeScore: number
    }>[]
    coverage: readonly TemporalRange[]
    gaps: readonly TemporalGap[]
  }>
  motion: Readonly<{
    observations: readonly Readonly<TemporalRange & {
      previousFrame: number; currentFrame: number
      vectorPxPerSecond: Readonly<{ x: number; y: number }>
      residualMeanAbsoluteLuma: number
      ambiguity: number
    }>[]
    coverage: readonly TemporalRange[]
    gaps: readonly TemporalGap[]
  }>
}>

export interface VisualTemporalAnalyzer {
  analyze(input: { sourcePath: string; expectedSourceSha256: string; signal?: AbortSignal }):
    Promise<VisualTemporalAnalysis>
}
