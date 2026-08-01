import type { EditorialCutEditPlan } from '../apply-editorial-cut-command.ts'
import type { DirectedEditPlan } from '../../domain/director-run.ts'
import type { ProxyQualityIssue } from '../render-workflow.ts'

/**
 * Upper bound on how many disjoint stale ranges a single partial proxy render may
 * stitch. Above it the repository falls back to a full render and the renderer
 * fails closed, because each extra range costs one more encode plus two more
 * concat seams.
 */
export const MAX_PARTIAL_RENDER_RANGES = 8

export interface ProjectProxyRangeReuse {
  schemaVersion: 'project-proxy-range-reuse/v1'
  commandId: string
  impactHash: string
  baseVersionId: string
  ranges: readonly Readonly<{ startFrame: number; endFrame: number }>[]
  artifactId: string
  manifestId: string
  artifactKey: string
  sha256: string
  byteSize: number
}

export interface ProjectProxyUnchangedReuse {
  schemaVersion: 'project-proxy-unchanged-reuse/v1'
  commandId: string
  impactHash: string
  baseVersionId: string
  operationId: string
  artifactId: string
  manifestId: string
  artifactKey: string
  sha256: string
  byteSize: number
}

export interface ProjectRenderSourceAsset {
  artifactId: string
  manifestId: string
  artifactKey: string
  sha256: string
  byteSize: number
  mediaType: 'video' | 'audio'
  container: string
  role: 'source-master' | 'selected-insert'
}

export interface ProjectProxyRenderSource {
  projectId: string
  projectVersionId: string
  editPlanSnapshotId: string
  editPlanHash: string
  editPlan: Readonly<EditorialCutEditPlan | DirectedEditPlan>
  format: string
  sourceArtifactId: string
  sourceManifestId: string
  sourceArtifactKey: string
  sourceSha256: string
  renderSources: readonly Readonly<ProjectRenderSourceAsset>[]
  originalFileName: string
  uploadReceivedAt: string
  criticIssues: readonly Readonly<ProxyQualityIssue>[]
  rangeReuse?: Readonly<ProjectProxyRangeReuse>
  unchangedReuse?: Readonly<ProjectProxyUnchangedReuse>
  unchangedReuseRequired?: true
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
    variantId: string
    outputArtifactId: string
    outputManifestId: string
    originalFileName: string
    createdAt: string
  }): Promise<void>
}
