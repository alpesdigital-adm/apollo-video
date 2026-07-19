import type { ProjectProxyRenderSource } from './project-proxy-render-repository.ts'

export interface ApprovedProjectFinalExportSource extends ProjectProxyRenderSource {
  projectVersionHash: string
  locale: string
  directorRunId: string
  qualitySnapshotId: string
  qualitySnapshotHash: string
  qualityStatus: 'approved' | 'approved-with-warnings'
  qualityScore: number
}

export interface ProjectFinalExportRepository {
  findReusableOutput(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    inputHash: string
  }): Promise<Readonly<{ artifactId: string }> | null>
  readApprovedCurrentSource(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    projectVersionHash: string
  }): Promise<Readonly<ApprovedProjectFinalExportSource> | null>
  readImmutableApprovedSource(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    projectVersionHash: string
    editPlanSnapshotId: string
    directorRunId: string
    qualitySnapshotId: string
    qualitySnapshotHash: string
    sourceArtifactId: string
    sourceManifestId: string
  }): Promise<Readonly<ApprovedProjectFinalExportSource> | null>
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
  markExportFailed(input: {
    workspaceId: string
    operationId: string
    projectId: string
  }): Promise<void>
}
