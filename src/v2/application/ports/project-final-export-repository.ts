import type { ProjectProxyRenderSource } from './project-proxy-render-repository.ts'

export interface ApprovedProjectFinalExportSource extends ProjectProxyRenderSource {
  projectVersionHash: string
  locale: string
  directorRunId: string
  qualitySnapshotId: string
  qualitySnapshotHash: string
  qualityStatus: 'approved' | 'approved-with-warnings'
  qualityScore: number
  proxyReviewId: string
  proxyReviewHash: string
  proxyArtifactId: string
}

export interface ProjectFinalExportAttemptHistory {
  operationId: string
  projectId: string
  projectVersionId: string
  proxyReviewId: string
  outputSpec: Readonly<{
    aspectRatio: '9:16' | '16:9' | '4:5' | '1:1' | '21:9'
    width: number
    height: number
    fps: number
    codec: 'h264'
    audioCodec: 'aac'
    container: 'mp4'
    quality: 'final'
  }>
  attempts: readonly Readonly<{
    attempt: number
    status: 'failed' | 'promoted'
    validators: readonly Readonly<{
      code: string
      passed: boolean
      message: string
    }>[]
    output?: Readonly<{
      artifactId: string
      manifestId: string
      sha256: string
      byteSize: number
    }>
    error?: Readonly<{
      code: string
      message: string
    }>
    startedAt: string
    completedAt: string
  }>[]
}

export interface ProjectFinalExportRepository {
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
    proxyReviewId: string
    proxyReviewHash: string
    proxyArtifactId: string
    sourceArtifactId: string
    sourceManifestId: string
  }): Promise<Readonly<ApprovedProjectFinalExportSource> | null>
  convergeOutputIdentity(input: {
    workspaceId: string
    operationId: string
    reservedArtifactId: string
    reservedManifestId: string
    persistedArtifactId: string
    persistedManifestId: string
    leaseOwner: string
    attempt: number
    now: string
  }): Promise<void>
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
  recordAttempt(input: {
    workspaceId: string
    operationId: string
    leaseOwner: string
    attempt: number
    status: 'failed' | 'promoted'
    validators: readonly Readonly<{
      code: string
      passed: boolean
      message: string
    }>[]
    output?: Readonly<{
      artifactId: string
      manifestId: string
      sha256: string
      byteSize: number
    }>
    error?: Readonly<{
      code: string
      message: string
    }>
    startedAt: string
    completedAt: string
  }): Promise<void>
  readAttemptHistory(input: {
    workspaceId: string
    operationId: string
  }): Promise<Readonly<ProjectFinalExportAttemptHistory> | null>
}
