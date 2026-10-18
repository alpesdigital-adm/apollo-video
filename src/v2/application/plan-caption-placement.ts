import { createCaptionProjection, type CaptionProjection, type ProjectionClip } from '../domain/caption-canvas-projection.ts'
import type { FaceEvidenceForSource } from '../domain/caption-face-clearance.ts'
import { DomainError } from '../domain/errors.ts'
import { collectFaceSourceEvidenceStream } from '../domain/face-source-evidence-stream.ts'
import {
  planRequiredSourceWindows, projectTimelineSpansToSource, type RequiredSourceWindow,
} from '../domain/face-evidence-time-map.ts'
import { maxSampleGapFrames } from '../domain/face-evidence-policy.ts'
import type { NormalizedBounds, OutputAspectRatio } from '../domain/output-spec.ts'
import type { PerceptionTimeline } from '../domain/perception-timeline.ts'
import { createRenderPlacementPlan, type RenderPlacementPlan, type RenderPlacementRequestV1 } from '../domain/render-placement-plan.ts'
import type { RenderReframePlanV1 } from '../domain/render-reframe-plan.ts'
import { FINAL_CAPTION_ANCHOR_POLICY } from '../domain/final-caption-certification.ts'
import { DEFAULT_SUBTITLE_ANCHOR_POLICY } from '../domain/subtitle-anchor-plan.ts'
import type { SubtitlePresetId } from '../domain/subtitle-system.ts'
import type { FaceSourceWindowEvidenceReader } from './ports/face-source-window-evidence-reader.ts'

/**
 * Builds the placement plan of one render, proxy or final (W65; evidence keyed by the SOURCE since W65b).
 *
 * The plan is decided on the VARIANT'S canvas: the render's sources, clips, crops/reframe and composition give the single
 * source-to-canvas projection; the trusted face windows of each source (read here, by the source's own frames, and accepted only
 * by `collectFaceSourceEvidenceStream`) give the face evidence; the caption bands of the output preset are judged against both.
 *
 * Evidence is a function of the source's bytes, so it does not belong to any EditPlan: it is read per source, whatever the cut
 * (several clips, trims, reorders), and projected onto each cue through the clips of THIS render's EditPlan. What cannot be
 * established is unknown, never free:
 *
 * - a video source whose dimensions are not known makes the whole projection unavailable (every band unknown);
 * - a fractional timeline frame rate, a clip whose speed is not 1 (or whose source and timeline ranges differ in length) and the
 *   absence of a reader leave the bands over that picture unknown (the plan says which);
 * - a source with no stored window, or with windows that do not cover a cue's frames, leaves it unknown.
 *
 * It also lists the SOURCE windows that would let the cues be certified. Listing is all it does: requesting them is the
 * Director's job (W64), not the renderer's.
 */
export type CaptionPlacementRenderSource = Readonly<{
  artifactId: string
  sha256: string
  mediaType: 'video' | 'audio'
  /** Observed dimensions of the stored source (its manifest probe). */
  probe?: Readonly<{ width: number; height: number }>
}>

export type CaptionPlacementClip = Readonly<{
  id: string
  sourceArtifactId: string
  /** Where the clip plays in its source: the evidence is keyed by these frames. */
  sourceInFrame: number
  sourceOutFrame: number
  timelineInFrame: number
  timelineOutFrame: number
  rate: number
  crop?: Readonly<NormalizedBounds>
}>

export type CaptionPlacementInput = Readonly<{
  workspaceId: string
  /** The project being rendered: it reads the evidence (the source must be attached to it; its locale governs the rights). */
  projectId: string
  format: OutputAspectRatio
  canvas: Readonly<{ width: number; height: number }>
  /** The EditPlan being rendered (read for its frame rate and duration). */
  editPlan: Readonly<{ fps: number; durationFrames: number }>
  clips: readonly CaptionPlacementClip[]
  composition?: Readonly<{ foregroundScale: number; verticalPosition: number }>
  renderSources: readonly CaptionPlacementRenderSource[]
  reframePlan?: Readonly<RenderReframePlanV1>
  subtitleCues: readonly Readonly<{ id: string; startFrame: number; endFrame: number }>[]
  subtitlePresetId: SubtitlePresetId | null | undefined
  placementElements: readonly Readonly<RenderPlacementRequestV1>[]
  trustedOcr?: Readonly<{ envelopeId: string; envelopeHash: string; inputVersionId: string; timeMapHash: string; timeline: Readonly<PerceptionTimeline> }>
  /** The source the OCR timeline was measured on. */
  primarySourceArtifactId: string
  /**
   * What a cue that cannot be certified costs (W65b). `block` (the default): the cue is not drawn and the reason is a HARD issue,
   * so the render cannot be approved. `omit-and-list`: the cue is not drawn and the reason is a WARNING that lists it as a review
   * item, so the rest of the video can be approved and delivered without it (the final's rule).
   */
  uncertifiedCues?: 'block' | 'omit-and-list'
}>

export type CaptionPlacementResult = Readonly<{
  placementPlan: Readonly<RenderPlacementPlan>
  projection: Readonly<CaptionProjection> | null
  /** Windows of each SOURCE (its own frames) that would let the cues be certified, for each source the cues can be mapped onto. */
  requiredFaceWindows: readonly Readonly<{ sourceArtifactId: string; windows: readonly RequiredSourceWindow[] }>[]
}>

const FACE_WINDOW_LIST_LIMIT = 200

function buildProjection(input: CaptionPlacementInput): Readonly<{ projection: Readonly<CaptionProjection> | null; reason?: string }> {
  const videos = input.renderSources.filter((source) => source.mediaType === 'video')
  if (videos.length === 0 || videos.some((source) => !source.probe)) return { projection: null, reason: 'SOURCE_DIMENSIONS_UNKNOWN' }
  const ranges = new Map((input.reframePlan?.ranges ?? []).map((range) => [range.clipId, range]))
  try {
    const clips: ProjectionClip[] = input.clips.map((clip) => ({
      id: clip.id, sourceArtifactId: clip.sourceArtifactId, timelineInFrame: clip.timelineInFrame, timelineOutFrame: clip.timelineOutFrame,
      sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame, rate: clip.rate,
      ...(clip.crop ? { crop: clip.crop } : {}),
      ...(ranges.has(clip.id) ? { reframe: ranges.get(clip.id)! } : {}),
    }))
    return {
      projection: createCaptionProjection({
        layout: { canvas: input.canvas, composition: input.composition ?? null },
        sources: videos.map((source) => ({ artifactId: source.artifactId, width: source.probe!.width, height: source.probe!.height })),
        clips,
      }),
    }
  } catch (error) {
    // An invalid geometry is the renderer's to refuse with its own typed error; for the plan it is simply not measurable.
    if (error instanceof DomainError) return { projection: null, reason: 'PROJECTION_INVALID' }
    throw error
  }
}

export async function planCaptionPlacement(
  dependencies: Readonly<{ faceEvidence?: FaceSourceWindowEvidenceReader; clock: () => Date }>,
  input: CaptionPlacementInput,
): Promise<CaptionPlacementResult> {
  const { projection, reason } = input.subtitleCues.length ? buildProjection(input) : { projection: null as Readonly<CaptionProjection> | null }
  const evidence: FaceEvidenceForSource[] = []
  const requiredFaceWindows: { sourceArtifactId: string; windows: readonly RequiredSourceWindow[] }[] = []
  if (input.subtitleCues.length) {
    const integerFps = Number.isInteger(input.editPlan.fps) && input.editPlan.fps > 0
    const policy = DEFAULT_SUBTITLE_ANCHOR_POLICY
    // The span of timeline frames each cue's decision is measured over (the cue, extended by the stability window).
    const spans = input.subtitleCues.map((cue) => ({
      startFrame: cue.startFrame,
      endFrame: Math.min(input.editPlan.durationFrames, Math.max(cue.endFrame, cue.startFrame + policy.minFramesBetweenChanges)),
    }))
    for (const sourceArtifactId of [...new Set(input.clips.map((clip) => clip.sourceArtifactId))].toSorted()) {
      if (!integerFps) {
        // The source's frames are mapped onto the timeline by an integer frame offset, which needs the same integer frame rate.
        evidence.push({ sourceArtifactId, stream: null, unavailableReason: 'TIMELINE_FPS_NOT_INTEGER' })
        continue
      }
      const sourceClips = input.clips.filter((clip) => clip.sourceArtifactId === sourceArtifactId)
      const sourceSpans = projectTimelineSpansToSource(sourceClips, sourceArtifactId, spans)
      if (sourceSpans.length === 0) continue
      const fps = { num: input.editPlan.fps, den: 1 }
      const gap = maxSampleGapFrames(fps)
      // No cue asks about a source frame the clips do not play, so the last frame any clip plays bounds the evidence.
      const sourceDurationFrames = Math.max(...sourceClips.map((clip) => clip.sourceOutFrame))
      requiredFaceWindows.push({ sourceArtifactId, windows: planRequiredSourceWindows({ sourceDurationFrames, fps, spans: sourceSpans }) })
      const renderSource = input.renderSources.find((source) => source.artifactId === sourceArtifactId)
      const from = Math.max(0, Math.min(...sourceSpans.map((span) => span.startFrame)) - gap)
      const to = Math.min(sourceDurationFrames, Math.max(...sourceSpans.map((span) => span.endFrame)) + gap)
      if (!renderSource || !projection || !dependencies.faceEvidence || to <= from) continue
      const stored = await dependencies.faceEvidence.listSourceWindows({
        workspaceId: input.workspaceId, projectId: input.projectId, sourceArtifactId,
        fromSourceFrame: from, toSourceFrame: to, now: dependencies.clock(), limit: FACE_WINDOW_LIST_LIMIT,
      })
      if (stored.length === 0) continue
      evidence.push({
        sourceArtifactId,
        stream: collectFaceSourceEvidenceStream(stored.map((item) => item.envelope), {
          workspaceId: input.workspaceId, sourceArtifactId, sourceSha256: renderSource.sha256, sourceFps: fps, sourceDurationFrames,
        }),
      })
    }
  }
  const placementPlan = createRenderPlacementPlan({
    format: input.format,
    canvas: input.canvas,
    durationFrames: input.editPlan.durationFrames,
    // The subtitle band is reserved from the resolved preset, so a CTA is never solved into the rows the subtitles own.
    subtitlePresetId: input.subtitlePresetId ?? null,
    elements: input.placementElements,
    ...(input.subtitleCues.length ? {
      subtitleAnchor: {
        fps: input.editPlan.fps,
        cues: input.subtitleCues.map((cue) => ({ id: cue.id, startFrame: cue.startFrame, endFrame: cue.endFrame })),
        ...(input.uncertifiedCues === 'omit-and-list' ? { policy: FINAL_CAPTION_ANCHOR_POLICY } : {}),
        faceClearance: {
          projection,
          ...(reason ? { projectionUnavailableReason: reason } : {}),
          evidence,
          perceptionSourceArtifactId: input.primarySourceArtifactId,
        },
        ...(input.trustedOcr ? { ocrEvidence: {
          envelopeId: input.trustedOcr.envelopeId, envelopeHash: input.trustedOcr.envelopeHash,
          inputVersionId: input.trustedOcr.inputVersionId, timeMapHash: input.trustedOcr.timeMapHash,
        }, perceptionTimeline: input.trustedOcr.timeline } : {}),
      },
    } : {}),
  })
  return Object.freeze({ placementPlan, projection, requiredFaceWindows: Object.freeze(requiredFaceWindows.map((entry) => Object.freeze(entry))) })
}

/**
 * A reused range is the bytes of the BASE proxy, and a base proxy is only reusable when its element map attests that it
 * drew no caption at all (`proxy-reuse-safety`). A plan that draws a cue over a frame the reuse keeps therefore cannot be
 * honoured by the reused bytes: the render has to be done in full. `ranges` are the stale ranges that ARE re-rendered.
 */
export function plannedCaptionsOverKeptFrames(
  plan: Readonly<RenderPlacementPlan>,
  staleRanges: readonly Readonly<{ startFrame: number; endFrame: number }>[],
): boolean {
  const decisions = plan.subtitleAnchorPlan?.decisions ?? []
  return decisions.some((decision) => {
    if (decision.suppressed || decision.anchor === null) return false
    let cursor = decision.startFrame
    for (const range of staleRanges.toSorted((left, right) => left.startFrame - right.startFrame)) {
      if (range.endFrame <= cursor) continue
      if (range.startFrame > cursor) return true
      cursor = range.endFrame
      if (cursor >= decision.endFrame) return false
    }
    return cursor < decision.endFrame
  })
}
