export interface PerceptionProducerRequestContext {
  projectId: string
  projectVersionId: string
  projectVersionHash: string
  sourceArtifactId: string
  sourceSha256: string
  editPlanSnapshotId: string
  editPlanSnapshotHash: string
}

export interface PerceptionProducerRequestContextRepository {
  read(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    sourceArtifactId: string
  }): Promise<Readonly<PerceptionProducerRequestContext> | null>
}
