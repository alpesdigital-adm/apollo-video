import type { EditorialCutEditPlan } from '../apply-editorial-cut-command.ts'

export interface ProjectProxyRenderSource {
  projectId: string
  projectVersionId: string
  editPlanSnapshotId: string
  editPlanHash: string
  editPlan: Readonly<EditorialCutEditPlan>
  format: string
  sourceArtifactId: string
  sourceManifestId: string
  sourceArtifactKey: string
  sourceSha256: string
  originalFileName: string
}

export interface ProjectProxyRenderRepository {
  readCurrentSource(input: { workspaceId: string; projectId: string }): Promise<Readonly<ProjectProxyRenderSource> | null>
  readImmutableSource(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    editPlanSnapshotId: string
    sourceArtifactId: string
    sourceManifestId: string
  }): Promise<Readonly<ProjectProxyRenderSource> | null>
  attachCompletedOutput(input: {
    workspaceId: string
    operationId: string
    projectId: string
    projectVersionId: string
    outputArtifactId: string
    outputManifestId: string
    originalFileName: string
    createdAt: string
  }): Promise<void>
}
