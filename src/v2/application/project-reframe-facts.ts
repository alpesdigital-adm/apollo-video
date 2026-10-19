import { DomainError } from '../domain/errors.ts'
import type { OutputConsumptionEntry } from '../domain/output-consumption.ts'
import { OUTPUT_ASPECT_RATIOS, type NormalizedInsets, type OutputAspectRatio } from '../domain/output-spec.ts'
import type { ReframeRoiSource } from '../domain/server-reframe-roi.ts'
import type { VariantReframeClip } from '../domain/variant-reframe-plan.ts'
import type { ProjectProxyRenderSource } from './ports/project-proxy-render-repository.ts'

/**
 * The facts a reframe plan is decided over, read from what a render reads (W66r): the sealed spec of the stable variant, the timeline of
 * the Version's EditPlan and the one video source it plays. The planner (on the head) and the render repository (on any Version, to attach
 * the persisted plan and to check it still describes this Version) share this one derivation, so they cannot disagree about a clip.
 */
const refusal = (reason: string, message: string) => new DomainError('PRECONDITION_REQUIRED', message, { reason })

export type ReframeSpecFacts = Readonly<{
  outputSpecRevisionId: string
  specHash: string
  aspectRatio: OutputAspectRatio
  safeArea: Readonly<NormalizedInsets>
  width: number
  height: number
  fps: number
}>

/** The sealed spec of one State entry. A copy's literal fork revision keeps its geometry as `effectiveSpec`. */
export function reframeSpecOf(entry: Readonly<Pick<OutputConsumptionEntry, 'outputSpecRevisionId' | 'specHash' | 'spec'>>): ReframeSpecFacts {
  const spec = entry.spec as unknown as { output?: unknown; effectiveSpec?: { output?: unknown } }
  const output = (spec.output ?? spec.effectiveSpec?.output) as Partial<ReframeSpecFacts & { safeArea: NormalizedInsets }> | undefined
  if (!output || !OUTPUT_ASPECT_RATIOS.includes(output.aspectRatio as OutputAspectRatio) || !output.safeArea ||
      !Number.isInteger(output.width) || !Number.isInteger(output.height) || !Number.isInteger(output.fps)) {
    throw refusal('output-not-consumable', 'The output spec carries no canvas to reframe for')
  }
  return Object.freeze({
    outputSpecRevisionId: entry.outputSpecRevisionId, specHash: entry.specHash, aspectRatio: output.aspectRatio as OutputAspectRatio,
    safeArea: Object.freeze({ ...output.safeArea }), width: output.width as number, height: output.height as number, fps: output.fps as number,
  })
}

export type ReframeTimelineFacts = Readonly<{
  timeline: Readonly<{ fps: number; durationFrames: number }>
  source: Readonly<ReframeRoiSource>
  clips: readonly VariantReframeClip[]
}>

export function reframeTimelineOf(source: Readonly<Pick<ProjectProxyRenderSource, 'editPlan' | 'renderSources'>>): ReframeTimelineFacts {
  const plan = source.editPlan
  if (!Number.isInteger(plan.fps) || plan.fps < 1 || plan.fps > 120 || !Number.isSafeInteger(plan.durationFrames) || plan.durationFrames < 1) {
    throw refusal('reframe-timeline-unsupported', 'Reframing needs an integer frame rate and a timeline that has frames')
  }
  const track = plan.videoTracks.find((candidate) => candidate.kind === 'base-video')
  const planned = track?.clips ?? []
  if (planned.length === 0) throw refusal('reframe-timeline-unsupported', 'The timeline plays no video clip')
  const sourceIds = [...new Set(planned.map((clip) => clip.sourceArtifactId))]
  if (sourceIds.length !== 1) throw refusal('reframe-single-source-required', 'Reframing currently requires the timeline to play one video source')
  const asset = source.renderSources.find((candidate) => candidate.artifactId === sourceIds[0] && candidate.mediaType === 'video')
  if (!asset?.probe) throw refusal('reframe-source-dimensions-unknown', 'The source video has no observed dimensions')
  const clips = planned.map((clip) => Object.freeze({
    clipId: clip.id, sourceArtifactId: clip.sourceArtifactId, sourceSha256: asset.sha256, sourceWidth: asset.probe!.width, sourceHeight: asset.probe!.height,
    sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame, timelineInFrame: clip.timelineInFrame, timelineOutFrame: clip.timelineOutFrame,
    rate: clip.rate, fps: plan.fps, hasStaticCrop: (clip as { crop?: unknown }).crop !== undefined && (clip as { crop?: unknown }).crop !== null,
  }))
  return Object.freeze({
    timeline: Object.freeze({ fps: plan.fps, durationFrames: plan.durationFrames }),
    source: Object.freeze({ artifactId: asset.artifactId, manifestId: asset.manifestId, sha256: asset.sha256, width: asset.probe.width, height: asset.probe.height }),
    clips: Object.freeze(clips),
  })
}
