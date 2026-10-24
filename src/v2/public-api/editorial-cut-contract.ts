import type { EditorialCutEditPlan } from '../application/apply-editorial-cut-command.ts'
import type { EditorialCommandResult } from '../application/ports/editorial-command-repository.ts'
import { presentProjectVersionV2, presentPublicOperation } from './presenters.ts'

/**
 * What a spoken-content removal answers, with the proxy render it queued: the same value for the Command (`apollo.projects.commands.apply`,
 * `type: remove-spoken-content`) and for the confirmation of a cut the Apollo proposed (`apollo.projects.speech-removals.confirm`).
 */
export function presentEditorialCutApplied(
  result: Readonly<EditorialCommandResult>,
  proxy: Readonly<{ operation: Parameters<typeof presentPublicOperation>[0]; replayed: boolean }>,
) {
  // The sealed Command3 plan only promises validated fields; the response reads the compiled editorial plan fields.
  const editPlan = result.editPlan as unknown as Readonly<EditorialCutEditPlan>
  return {
    command: {
      id: result.command.id,
      type: result.command.type,
      baseVersionId: result.command.baseVersionId,
      resultVersionId: result.version.id,
      createdAt: result.command.createdAt,
    },
    version: presentProjectVersionV2({
      id: result.version.id,
      sequence: result.version.sequence,
      parentVersionId: result.version.parentVersionId,
      baseHash: result.version.baseHash,
      snapshotRefs: result.version.snapshotRefs,
      createdAt: result.version.createdAt,
    }, { current: true, previewAvailable: false }),
    editorial: {
      sourceTranscriptId: editPlan.retimedTranscript.sourceTranscriptId,
      sourceArtifactId: editPlan.sources[0]!.artifactId,
      // Only what the Command seals and validates is stated: range and the rules that matched it.
      exclusions: result.exclusions.map(({ sourceStartSeconds, sourceEndSeconds, ruleIds }) => ({
        sourceStartSeconds, sourceEndSeconds, ruleIds: [...ruleIds],
      })),
      retainedSourceRanges: result.retainedSourceRanges,
      outputDurationFrames: editPlan.durationFrames,
      fps: editPlan.fps,
      automaticZoom: editPlan.movementPolicy.automaticZoom,
      protectedOpeningFrames: editPlan.movementPolicy.protectedOpeningFrames,
      subtitleFaceProtection: editPlan.subtitlePolicy.faceProtection,
      impact: result.impact,
      invalidations: result.invalidations,
    },
    operation: presentPublicOperation(proxy.operation),
    replayed: result.replayed && proxy.replayed,
  }
}
