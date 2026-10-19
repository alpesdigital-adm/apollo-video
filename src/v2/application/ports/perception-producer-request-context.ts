export interface SourceVersionProducerRequestContext {
  projectId: string
  projectVersionId: string
  projectVersionHash: string
  sourceArtifactId: string
  sourceSha256: string
  editPlanSnapshotId: string
  editPlanSnapshotHash: string
}

export interface SourceVersionProducerRequestContextRepository {
  read(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    sourceArtifactId: string
  }): Promise<Readonly<SourceVersionProducerRequestContext> | null>
}

export type PerceptionProducerRequestContext = SourceVersionProducerRequestContext
export interface PerceptionProducerRequestContextRepository extends SourceVersionProducerRequestContextRepository {}

/** Admission context of one V9 face window: the version's single unit-rate clip, covering the whole timeline. */
export interface FaceWindowRequestContext extends SourceVersionProducerRequestContext {
  /** Integer timeline frame rate of the edit plan (denominator 1). */
  timelineFps: number
  timelineDurationFrames: number
  /** First source frame of the clip; sampled frames are the multiples of the interval in source frames. */
  clipSourceInFrame: number
}

export interface FaceWindowRequestContextRepository {
  read(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    sourceArtifactId: string
  }): Promise<Readonly<FaceWindowRequestContext> | null>
}
