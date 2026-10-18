import type { SourceVersionProducerRequestContext } from './perception-producer-request-context.ts'

/**
 * Admission context of one V9 SOURCE window (W65b): the project the window is requested from (its current Version and EditPlan are only
 * audit context), the source it plays, and the source's own clock. Nothing here says anything about the timeline.
 */
export interface FaceSourceWindowRequestContext extends SourceVersionProducerRequestContext {
  /** Integer frame rate of the source (its manifest probe); the sampling cadence follows it. */
  sourceFps: number
  /** The source's frame count from its probe: a window ends at or before it. */
  sourceDurationFrames: number
}

export interface FaceSourceWindowRequestContextRepository {
  read(input: {
    workspaceId: string
    projectId: string
    sourceArtifactId: string
  }): Promise<Readonly<FaceSourceWindowRequestContext> | null>
}
