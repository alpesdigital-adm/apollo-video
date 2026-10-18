import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { createCaptionProjection, type CaptionProjection, type ProjectionClip } from '../domain/caption-canvas-projection.ts'
import type { FaceEvidenceForSource } from '../domain/caption-face-clearance.ts'
import { DomainError } from '../domain/errors.ts'
import { collectFaceEvidenceStream, type FaceEvidenceExpectation } from '../domain/face-evidence-stream.ts'
import { faceWindowTimeMap, planRequiredFaceWindows, type RequiredFaceWindow } from '../domain/face-evidence-time-map.ts'
import { maxSampleGapFrames } from '../domain/face-evidence-policy.ts'
import type { NormalizedBounds, OutputAspectRatio } from '../domain/output-spec.ts'
import type { PerceptionTimeline } from '../domain/perception-timeline.ts'
import { createRenderPlacementPlan, type RenderPlacementPlan, type RenderPlacementRequestV1 } from '../domain/render-placement-plan.ts'
import type { RenderReframePlanV1 } from '../domain/render-reframe-plan.ts'
import { DEFAULT_SUBTITLE_ANCHOR_POLICY } from '../domain/subtitle-anchor-plan.ts'
import type { SubtitlePresetId } from '../domain/subtitle-system.ts'
import type { FaceWindowEvidenceReader } from './ports/face-window-evidence-reader.ts'

/**
 * Builds the placement plan of one render, proxy or final (W65).
 *
 * The plan is decided on the VARIANT'S canvas: the render's sources, clips, crops/reframe and composition give the single
 * source-to-canvas projection; the trusted face windows of each source (read here, scoped to the workspace, project and
 * ProjectVersion, and accepted only by `collectFaceEvidenceStream`) give the face evidence; the caption bands of the
 * output preset are judged against both. What cannot be established is unknown, never free:
 *
 * - a video source whose dimensions are not known makes the whole projection unavailable (every band unknown);
 * - a timeline that is not exactly one real-time clip of a source, a fractional frame rate, a renderable snapshot, or the
 *   absence of a reader leave that source without a stream (its bands over the picture are unknown).
 *
 * It also lists the face windows that would let the cues be certified. Listing is all it does: requesting them is the
 * Director's job (W64), not the renderer's.
 */
export type CaptionPlacementRenderSource = Readonly<{
  artifactId: string
  sha256: string
  mediaType: 'video' | 'audio'
  /** Observed dimensions of the stored source (its manifest probe). */
  probe?: Readonly<{ width: number; height: number }>
}>

export type CaptionPlacementInput = Readonly<{
  workspaceId: string
  projectId: string
  projectVersionId: string
  format: OutputAspectRatio
  canvas: Readonly<{ width: number; height: number }>
  /** The EditPlan being rendered (read for its frame rate, duration and clip map). */
  editPlan: Readonly<{ fps: number; durationFrames: number }>
  clips: readonly Readonly<{ id: string; sourceArtifactId: string; timelineInFrame: number; timelineOutFrame: number; crop?: Readonly<NormalizedBounds> }>[]
  composition?: Readonly<{ foregroundScale: number; verticalPosition: number }>
  renderSources: readonly CaptionPlacementRenderSource[]
  reframePlan?: Readonly<RenderReframePlanV1>
  subtitleCues: readonly Readonly<{ id: string; startFrame: number; endFrame: number }>[]
  subtitlePresetId: SubtitlePresetId | null | undefined
  placementElements: readonly Readonly<RenderPlacementRequestV1>[]
  trustedOcr?: Readonly<{ envelopeId: string; envelopeHash: string; inputVersionId: string; timeMapHash: string; timeline: Readonly<PerceptionTimeline> }>
  /** The source the OCR timeline was measured on. */
  primarySourceArtifactId: string
  /** False for renderable snapshots: their plan is not the Version's EditPlan, so the Version's windows do not describe it. */
  faceEvidenceAllowed: boolean
}>

export type CaptionPlacementResult = Readonly<{
  placementPlan: Readonly<RenderPlacementPlan>
  projection: Readonly<CaptionProjection> | null
  /** Face windows that would let the cues be certified, per source whose timeline admits windows at all. */
  requiredFaceWindows: readonly Readonly<{ sourceArtifactId: string; windows: readonly RequiredFaceWindow[] }>[]
}>

const FACE_WINDOW_LIST_LIMIT = 200

function buildProjection(input: CaptionPlacementInput): Readonly<{ projection: Readonly<CaptionProjection> | null; reason?: string }> {
  const videos = input.renderSources.filter((source) => source.mediaType === 'video')
  if (videos.length === 0 || videos.some((source) => !source.probe)) return { projection: null, reason: 'SOURCE_DIMENSIONS_UNKNOWN' }
  const ranges = new Map((input.reframePlan?.ranges ?? []).map((range) => [range.clipId, range]))
  try {
    const clips: ProjectionClip[] = input.clips.map((clip) => ({
      id: clip.id, sourceArtifactId: clip.sourceArtifactId, timelineInFrame: clip.timelineInFrame, timelineOutFrame: clip.timelineOutFrame,
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
  dependencies: Readonly<{ faceEvidence?: FaceWindowEvidenceReader; clock: () => Date }>,
  input: CaptionPlacementInput,
): Promise<CaptionPlacementResult> {
  const { projection, reason } = input.subtitleCues.length ? buildProjection(input) : { projection: null as Readonly<CaptionProjection> | null }
  const evidence: FaceEvidenceForSource[] = []
  const requiredFaceWindows: { sourceArtifactId: string; windows: readonly RequiredFaceWindow[] }[] = []
  const integerFps = Number.isInteger(input.editPlan.fps) && input.editPlan.fps > 0
  if (input.subtitleCues.length && integerFps) {
    const fps = { num: input.editPlan.fps, den: 1 }
    const gap = maxSampleGapFrames(fps)
    const policy = DEFAULT_SUBTITLE_ANCHOR_POLICY
    const spans = input.subtitleCues.map((cue) => ({
      startFrame: cue.startFrame,
      endFrame: Math.min(input.editPlan.durationFrames, Math.max(cue.endFrame, cue.startFrame + policy.minFramesBetweenChanges)),
    }))
    const from = Math.max(0, Math.min(...spans.map((span) => span.startFrame)) - gap)
    const to = Math.min(input.editPlan.durationFrames, Math.max(...spans.map((span) => span.endFrame)) + gap)
    for (const sourceArtifactId of [...new Set(input.clips.map((clip) => clip.sourceArtifactId))].toSorted()) {
      const timeMap = faceWindowTimeMap(input.editPlan, sourceArtifactId)
      if (!timeMap) continue
      requiredFaceWindows.push({ sourceArtifactId, windows: planRequiredFaceWindows({ durationFrames: input.editPlan.durationFrames, fps, spans }) })
      const renderSource = input.renderSources.find((source) => source.artifactId === sourceArtifactId)
      if (!renderSource || !projection || !input.faceEvidenceAllowed || !dependencies.faceEvidence || to <= from) continue
      const stored = await dependencies.faceEvidence.listWindows({
        workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: input.projectVersionId, sourceArtifactId,
        fromTimelineFrame: from, toTimelineFrame: to, now: dependencies.clock(), limit: FACE_WINDOW_LIST_LIMIT,
      })
      if (stored.length === 0) continue
      const expected: FaceEvidenceExpectation = Object.freeze({
        workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: input.projectVersionId, sourceArtifactId,
        sourceSha256: renderSource.sha256, timeMapHash: calculateCanonicalHash(timeMap),
        timelineDurationFrames: input.editPlan.durationFrames, timelineFps: fps,
      })
      evidence.push({ sourceArtifactId, stream: collectFaceEvidenceStream(stored.map((item) => item.envelope), expected) })
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
