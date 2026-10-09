import { DomainError, assertDomain } from '../domain/errors.ts'
import type { OutputAspectRatio } from '../domain/output-spec.ts'
import type { DirectorRunRepository } from './ports/director-run-repository.ts'

export function planProjectReframeService(dependencies: {
  projects: Pick<DirectorRunRepository, 'readContext'>
  clock?: () => Date
}) {
  return async function planProjectReframe(input: Readonly<{
    workspaceId: string
    projectId: string
    baseVersionId: string
    format: OutputAspectRatio
  }>) {
    const context = await dependencies.projects.readContext({ workspaceId: input.workspaceId, projectId: input.projectId })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Reframe project was not found')
    assertDomain(context.currentVersion.id === input.baseVersionId, 'VERSION_CONFLICT', 'Reframe base version is stale')
    const sourceIds = new Set(context.editPlan.videoTracks.flatMap((track) =>
      track.clips.map((clip) => clip.sourceArtifactId)))
    assertDomain(sourceIds.size === 1 && sourceIds.has(context.transcript.sourceArtifactId),
      'PRECONDITION_REQUIRED', 'Reframe request currently requires one transcript-bound source in the immutable EditPlan')
    const rights = context.sourceRights
    const now = (dependencies.clock ?? (() => new Date()))().getTime()
    const unexpired = (value?: string) => !value || Date.parse(value) > now
    assertDomain(rights.state === 'present' && rights.status === 'approved' &&
      ['approved', 'not-required'].includes(rights.consentStatus) &&
      unexpired(rights.expiresAt) && unexpired(rights.consentExpiresAt),
    'ASSET_RIGHTS_BLOCKED', 'Reframe source rights are not currently approved')
    // A content hash computed by the caller authenticates neither a detector nor its source.
    // Until a server-owned, version-bound ROI envelope is available, no automatic crop plan
    // can be emitted. Manual crops remain separate Commands and are never observation evidence.
    return Object.freeze({
      schemaVersion: 'reframe-plan-request-result/v2' as const,
      status: 'review-required' as const,
      plan: null,
      reasonCode: 'FACE_PERCEPTION_UNAVAILABLE' as const,
      baseVersionId: input.baseVersionId,
      format: input.format,
    })
  }
}
