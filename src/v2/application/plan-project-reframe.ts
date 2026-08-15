import { createReframePlan, parseReframeObservationSet } from '../domain/reframe-plan.ts'
import { DomainError, assertDomain } from '../domain/errors.ts'
import type { OutputAspectRatio } from '../domain/output-spec.ts'
import type { DirectorRunRepository } from './ports/director-run-repository.ts'

export function planProjectReframeService(dependencies: {
  projects: Pick<DirectorRunRepository, 'readContext'>
}) {
  return async function planProjectReframe(input: Readonly<{
    workspaceId: string
    projectId: string
    baseVersionId: string
    format: OutputAspectRatio
    observationSet: unknown
    overrides?: readonly unknown[]
    maxVelocityPerSecond?: number
    maxAccelerationPerSecondSquared?: number
    safetyMargin?: number
  }>) {
    const observations = parseReframeObservationSet(input.observationSet)
    const context = await dependencies.projects.readContext({ workspaceId: input.workspaceId, projectId: input.projectId })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Reframe project was not found')
    assertDomain(context.currentVersion.id === input.baseVersionId, 'VERSION_CONFLICT', 'Reframe base version is stale')
    const sourceArtifactIds = new Set(context.editPlan.videoTracks.flatMap((track) => track.clips.map((clip) => clip.sourceArtifactId)))
    assertDomain(sourceArtifactIds.has(observations.sourceArtifactId), 'INVALID_RENDER_INPUT', 'Observation source artifact is not used by the immutable base version')
    return createReframePlan({
      format: input.format, observationSet: observations, overrides: input.overrides,
      maxVelocityPerSecond: input.maxVelocityPerSecond,
      maxAccelerationPerSecondSquared: input.maxAccelerationPerSecondSquared,
      safetyMargin: input.safetyMargin,
    })
  }
}
