import { assertDomain } from './errors.ts'
import type { NormalizedBounds } from './output-spec.ts'
import type { RenderPlacementPlan } from './render-placement-plan.ts'

/**
 * The verdict on where the captions of a delivered MP4 really are (W65), taken from measured pixels and compared with the
 * placement plan that was supposed to produce them. It does not look at the detector that produced the face clearance, and it
 * does not read the renderer's own element map: it consumes footprints measured on the delivered frames, so a wrong
 * projection, a wrong anchor or a renderer defect shows up as a disagreement here.
 *
 * Three codes:
 *  - `CAPTION_PLACEMENT_MISMATCH` (hard): the pixels disagree with the plan - a drawn cue left no caption, a caption is outside
 *    the band the plan decided (or its safe area), it covers a drawn placement it was not allowed to cover, or something is
 *    drawn where the plan draws nothing (a withheld cue, or a frame outside every cue);
 *  - `SUBTITLE_FACE_OVERLAP_IN_PIXELS` (hard): a face veto detector - NOT the producer of the clearance - found a face under the
 *    measured caption;
 *  - `FACE_PIXEL_CHECK_UNAVAILABLE` (warning): the pixel checks could not be completed (no veto detector is wired, or the
 *    measurement itself failed). It never upgrades an unknown, and a plan that is still `unknown` stays `unknown`.
 */
export const CAPTION_PIXEL_CODES = Object.freeze([
  'CAPTION_PLACEMENT_MISMATCH', 'SUBTITLE_FACE_OVERLAP_IN_PIXELS', 'FACE_PIXEL_CHECK_UNAVAILABLE',
] as const)
export type CaptionPixelCode = (typeof CAPTION_PIXEL_CODES)[number]

/** What was measured on one delivered frame. `footprint` is the box around every changed pixel, normalized; `null` when none. */
export type CaptionFootprintSample = Readonly<{
  frame: number
  footprint: Readonly<NormalizedBounds> | null
  changedPixels: number
  /** Faces a veto detector found on the caption-free control frame, normalized to the canvas. Absent when it did not run. */
  faceBoxes?: readonly Readonly<NormalizedBounds>[]
}>

export type CaptionPixelIssueV1 = Readonly<{
  code: CaptionPixelCode
  severity: 'hard' | 'warning'
  cueId: string | null
  evidenceRange: Readonly<{ startFrame: number; endFrame: number }>
  elementIds: readonly string[]
  evidenceIds: readonly string[]
  message: string
}>

/** Slack, in canvas pixels, for anti-aliasing, the outline and the opaque box around the glyphs. */
export const CAPTION_BAND_TOLERANCE_PX = 6

const overlapsClosed = (left: Readonly<NormalizedBounds>, right: Readonly<NormalizedBounds>) =>
  left.x <= right.x + right.width && left.x + left.width >= right.x && left.y <= right.y + right.height && left.y + left.height >= right.y

export function evaluateCaptionPixels(input: Readonly<{
  plan: Readonly<RenderPlacementPlan>
  /** One entry per measured frame; at least the frames the critic decided to look at. */
  samples: readonly Readonly<CaptionFootprintSample>[]
  /** `ran`: every placed cue was checked by a face veto detector. `unavailable`: none was. */
  faceVeto: 'ran' | 'unavailable'
  /** A measurement that could not be completed is reported, not guessed. */
  measurementFailed?: boolean
}>): readonly CaptionPixelIssueV1[] {
  const { plan } = input
  const anchor = plan.subtitleAnchorPlan
  assertDomain(anchor !== null, 'INVALID_ARGUMENT', 'Caption pixels need a plan with a subtitle anchor plan')
  const { width, height } = plan.canvas
  const tolerance = { x: CAPTION_BAND_TOLERANCE_PX / width, y: CAPTION_BAND_TOLERANCE_PX / height }
  const issues: CaptionPixelIssueV1[] = []
  const placed = anchor.decisions.filter((decision) => decision.anchor !== null && decision.bounds !== null)
  const add = (issue: CaptionPixelIssueV1) => issues.push(Object.freeze(issue))
  if (input.measurementFailed) {
    for (const decision of placed) {
      add({
        code: 'FACE_PIXEL_CHECK_UNAVAILABLE', severity: 'warning', cueId: decision.cueId,
        evidenceRange: { startFrame: decision.startFrame, endFrame: decision.endFrame },
        elementIds: [`subtitle:${decision.cueId}`], evidenceIds: [`subtitle-anchor-plan:${anchor.anchorPlanHash}`],
        message: `The caption pixels of cue ${decision.cueId} could not be measured; placement and face checks did not run.`,
      })
    }
    return Object.freeze(issues)
  }
  const drawnPlacements = plan.placements.filter((placement) => placement.assetArtifactId !== null)
  for (const sample of input.samples) {
    const governing = anchor.decisions.find((decision) => decision.startFrame <= sample.frame && decision.endFrame > sample.frame) ?? null
    const frameRange = { startFrame: sample.frame, endFrame: sample.frame + 1 }
    if (!governing || governing.anchor === null || governing.bounds === null) {
      // The plan draws nothing here: a withheld cue, or a frame outside every cue.
      if (sample.footprint !== null) {
        add({
          code: 'CAPTION_PLACEMENT_MISMATCH', severity: 'hard', cueId: governing?.cueId ?? null, evidenceRange: frameRange,
          elementIds: governing ? [`subtitle:${governing.cueId}`] : [], evidenceIds: [`subtitle-anchor-plan:${anchor.anchorPlanHash}`],
          message: governing
            ? `Pixels were drawn at frame ${sample.frame} although the plan withholds cue ${governing.cueId}.`
            : `Pixels were drawn at frame ${sample.frame} where the plan has no cue.`,
        })
      }
      continue
    }
    if (sample.footprint === null) {
      add({
        code: 'CAPTION_PLACEMENT_MISMATCH', severity: 'hard', cueId: governing.cueId, evidenceRange: frameRange,
        elementIds: [`subtitle:${governing.cueId}`], evidenceIds: [`subtitle-anchor-plan:${anchor.anchorPlanHash}`],
        message: `Cue ${governing.cueId} is placed on the ${governing.anchor} band but left no caption pixels at frame ${sample.frame}.`,
      })
      continue
    }
    const band = governing.bounds
    const inside = sample.footprint.x >= band.x - tolerance.x && sample.footprint.y >= band.y - tolerance.y &&
      sample.footprint.x + sample.footprint.width <= band.x + band.width + tolerance.x &&
      sample.footprint.y + sample.footprint.height <= band.y + band.height + tolerance.y
    if (!inside) {
      add({
        code: 'CAPTION_PLACEMENT_MISMATCH', severity: 'hard', cueId: governing.cueId, evidenceRange: frameRange,
        elementIds: [`subtitle:${governing.cueId}`], evidenceIds: [`subtitle-anchor-plan:${anchor.anchorPlanHash}`],
        message: `The caption of cue ${governing.cueId} at frame ${sample.frame} is outside the ${governing.anchor} band the plan decided.`,
      })
    }
    // A placement the solver reserved and the encode draws (logo, image insert) is not covered, unless the plan itself recorded
    // the compromise (SUBTITLE_ANCHOR_FALLBACK).
    const compromised = governing.issues.some((issue) => issue.code === 'SUBTITLE_ANCHOR_FALLBACK')
    if (!compromised) {
      for (const placement of drawnPlacements) {
        if (placement.timeRange.startFrame <= sample.frame && placement.timeRange.endFrame > sample.frame && overlapsClosed(sample.footprint, placement.bounds)) {
          add({
            code: 'CAPTION_PLACEMENT_MISMATCH', severity: 'hard', cueId: governing.cueId, evidenceRange: frameRange,
            elementIds: [`subtitle:${governing.cueId}`, placement.elementId], evidenceIds: [`subtitle-anchor-plan:${anchor.anchorPlanHash}`],
            message: `The caption of cue ${governing.cueId} at frame ${sample.frame} covers the drawn placement ${placement.elementId}.`,
          })
        }
      }
    }
    for (const face of sample.faceBoxes ?? []) {
      if (overlapsClosed(sample.footprint, face)) {
        add({
          code: 'SUBTITLE_FACE_OVERLAP_IN_PIXELS', severity: 'hard', cueId: governing.cueId, evidenceRange: frameRange,
          elementIds: [`subtitle:${governing.cueId}`], evidenceIds: [`subtitle-anchor-plan:${anchor.anchorPlanHash}`],
          message: `A face found on the caption-free frame ${sample.frame} lies under the caption of cue ${governing.cueId}.`,
        })
      }
    }
  }
  if (input.faceVeto === 'unavailable') {
    for (const decision of placed) {
      add({
        code: 'FACE_PIXEL_CHECK_UNAVAILABLE', severity: 'warning', cueId: decision.cueId,
        evidenceRange: { startFrame: decision.startFrame, endFrame: decision.endFrame },
        elementIds: [`subtitle:${decision.cueId}`], evidenceIds: [`subtitle-anchor-plan:${anchor.anchorPlanHash}`],
        message: `No independent face check ran on the pixels of cue ${decision.cueId}; the band is certified by the sampled detector evidence only.`,
      })
    }
  }
  return Object.freeze(issues.toSorted((left, right) =>
    left.evidenceRange.startFrame - right.evidenceRange.startFrame || left.code.localeCompare(right.code) ||
    (left.cueId ?? '').localeCompare(right.cueId ?? '') || left.elementIds.join(':').localeCompare(right.elementIds.join(':'))))
}

/** Frames worth measuring for a plan: first, middle and last frame of every drawn cue, the middle of every withheld one, and one frame of each gap. */
export function captionSampleFrames(plan: Readonly<RenderPlacementPlan>, limit = 48): readonly number[] {
  const anchor = plan.subtitleAnchorPlan
  if (!anchor) return Object.freeze([])
  const frames = new Set<number>()
  let cursor = 0
  for (const decision of anchor.decisions.toSorted((left, right) => left.startFrame - right.startFrame)) {
    if (decision.startFrame > cursor) frames.add(Math.min(plan.durationFrames - 1, cursor + Math.floor((decision.startFrame - cursor) / 2)))
    cursor = Math.max(cursor, decision.endFrame)
    const middle = decision.startFrame + Math.floor((decision.endFrame - decision.startFrame) / 2)
    if (decision.anchor !== null) { frames.add(decision.startFrame); frames.add(middle); frames.add(decision.endFrame - 1) } else frames.add(middle)
  }
  if (cursor < plan.durationFrames) frames.add(cursor + Math.floor((plan.durationFrames - cursor) / 2))
  const ordered = [...frames].filter((frame) => frame >= 0 && frame < plan.durationFrames).toSorted((left, right) => left - right)
  if (ordered.length <= limit) return Object.freeze(ordered)
  const stride = ordered.length / limit
  return Object.freeze(Array.from({ length: limit }, (_unused, index) => ordered[Math.floor(index * stride)]!))
}
