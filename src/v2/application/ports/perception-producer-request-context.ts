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
