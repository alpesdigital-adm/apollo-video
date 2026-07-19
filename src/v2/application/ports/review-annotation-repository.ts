import type { ReviewAnnotation, ReviewAnnotationScope } from '../../domain/review-system.ts'

export interface ReviewSceneRecord {
  id: string
  label: string
  startFrame: number
  endFrame: number
}

export interface ReviewPreviewContext {
  projectVersionId: string
  proxyArtifactId: string
  proxyHash: string
  fps: number
  width: number
  height: number
  durationFrames: number
  stale: boolean
  scenes: readonly ReviewSceneRecord[]
}

export interface PersistedReviewAnnotation extends ReviewAnnotation {
  proxyArtifactId: string
  proxyHash: string
  scope: ReviewAnnotationScope
  author: { id: string; name: string; type: 'user' | 'api-client' }
}

export interface ReviewAnnotationRepository {
  readPreviewContext(input: {
    workspaceId: string
    projectId: string
  }): Promise<Readonly<ReviewPreviewContext> | null>
  list(input: {
    workspaceId: string
    projectId: string
    projectVersionId?: string
    limit: number
  }): Promise<readonly Readonly<PersistedReviewAnnotation>[]>
  findIdempotent(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
  }): Promise<Readonly<{ requestFingerprint: string; annotation: PersistedReviewAnnotation }> | null>
  create(input: {
    workspaceId: string
    projectId: string
    annotation: PersistedReviewAnnotation
    idempotencyKey: string
    requestFingerprint: string
  }): Promise<Readonly<PersistedReviewAnnotation>>
}
