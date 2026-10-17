import type { VisualTemporalAnalysis } from '../../domain/temporal-producer-envelope.ts'

export type { SourceClock, TemporalRange, TemporalGap, VisualTemporalAnalysis } from '../../domain/temporal-producer-envelope.ts'

export interface VisualTemporalAnalyzer {
  analyze(input: { sourcePath: string; expectedSourceSha256: string; signal?: AbortSignal }):
    Promise<VisualTemporalAnalysis>
}
