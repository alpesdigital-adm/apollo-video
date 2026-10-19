import { assertDomain } from './errors.ts'
import type { NormalizedBounds } from './output-spec.ts'
import {
  createRenderReframePlan,
  type RenderReframePlanV1, type RenderReframeRangeV1,
} from './render-reframe-plan.ts'
import {
  REFRAME_EPSILON, reframeFocusedObservations, reframeSubjectsVisible, reframeViewportIsWholeFrame, maximumReframeCrop,
  type ReframeObservationSetV2, type ReframePlanV2,
} from './reframe-plan.ts'
import { REFRAME_POLICY } from './reframe-policy.ts'

/**
 * From the segments of a policy-sealed reframe plan to the keyframed ranges the renderer receives (W66r), one range per clip.
 *
 * - A keyframe sits at the start of every tracked segment, and the renderer interpolates linearly between them. Because the plan's
 *   velocity was measured between exactly these starts, the rendered speed IS the plan's speed.
 * - A stretch the plan could not track (unknown evidence, no subject, subjects that do not fit) gets no keyframe of its own: the
 *   trajectory is bridged from the last tracked crop to the next one, never faster than the plan allowed.
 * - A manual span is held exactly. The path steps (one frame) into it and out of it; the step is the editor's decision and is not
 *   smoothed. Keyframes just before and after the span keep the automatic path from sliding into it.
 * - A clip with nothing tracked and nothing manual is a `fallback` range: no keyframe, the whole frame is shown.
 * - The path is checked frame by frame against the observations it was decided from. A frame whose interpolated crop hides a
 *   subject is reported (`TRACKING_LIMIT_EXCEEDED`), not assumed fine.
 */
export type VariantReframeTimelineClip = Readonly<{ id: string; timelineInFrame: number; timelineOutFrame: number; rate: number }>
export type VariantReframeManualSpan = Readonly<{ id: string; startFrame: number; endFrame: number }>
export type ReframeTrajectoryViolation = Readonly<{
  clipId: string
  startFrame: number
  endFrame: number
  reasonCode: 'INTERPOLATED_PATH_HIDES_SUBJECT' | 'KEYFRAME_BUDGET_EXCEEDED'
}>

type Point = { frame: number; crop: Readonly<NormalizedBounds>; pinned: boolean }

const centerOf = (crop: Readonly<NormalizedBounds>) => ({ x: crop.x + crop.width / 2, y: crop.y + crop.height / 2 })

function rangeOf(clip: VariantReframeTimelineClip, points: readonly Point[], spans: readonly VariantReframeManualSpan[]): Omit<RenderReframeRangeV1, 'source'> & { source: 'plan' } {
  return {
    clipId: clip.id, startFrame: clip.timelineInFrame, endFrame: clip.timelineOutFrame, interpolation: 'linear', source: 'plan',
    keyframes: points.map((point) => ({ frame: point.frame, crop: point.crop })),
    ...(spans.length ? { manualSpans: spans } : {}),
  }
}

/** Removes every interior point the straight line between its neighbours already passes through. Pinned points stay. */
function dropCollinear(points: readonly Point[]): Point[] {
  // A path that never moves is one keyframe, whatever the number of segments it was decided over.
  const first = points[0]
  if (first && points.every((point) => !point.pinned && point.crop.x === first.crop.x && point.crop.y === first.crop.y)) return [first]
  const kept: Point[] = []
  for (const point of points) {
    kept.push(point)
    while (kept.length >= 3) {
      const [a, b, c] = [kept.at(-3)!, kept.at(-2)!, kept.at(-1)!]
      if (b.pinned) break
      const ratio = (b.frame - a.frame) / (c.frame - a.frame)
      const onLine = Math.abs(b.crop.x - (a.crop.x + (c.crop.x - a.crop.x) * ratio)) <= 1e-12 &&
        Math.abs(b.crop.y - (a.crop.y + (c.crop.y - a.crop.y) * ratio)) <= 1e-12
      if (!onLine) break
      kept.splice(kept.length - 2, 1)
    }
  }
  return kept
}

/** Ramer-Douglas-Peucker on the time-parametrized path: keeps a point only when the path without it moves by more than `tolerance`. */
function simplify(points: readonly Point[], tolerance: number): Point[] {
  if (points.length <= 2) return [...points]
  const keep = new Array<boolean>(points.length).fill(false)
  keep[0] = true; keep[points.length - 1] = true
  points.forEach((point, index) => { if (point.pinned) keep[index] = true })
  const stack: Array<[number, number]> = [[0, points.length - 1]]
  while (stack.length) {
    const [from, to] = stack.pop()!
    let worst = -1, distance = tolerance
    for (let index = from + 1; index < to; index += 1) {
      const a = points[from]!, b = points[to]!, p = points[index]!
      const ratio = (p.frame - a.frame) / (b.frame - a.frame)
      const error = Math.max(Math.abs(p.crop.x - (a.crop.x + (b.crop.x - a.crop.x) * ratio)), Math.abs(p.crop.y - (a.crop.y + (b.crop.y - a.crop.y) * ratio)))
      if (error > distance || (p.pinned && worst === -1)) { worst = index; distance = Math.max(error, tolerance) }
    }
    if (worst === -1) continue
    keep[worst] = true
    stack.push([from, worst], [worst, to])
  }
  return points.filter((_point, index) => keep[index])
}

/** Frames where the interpolated crop hides a subject the observations say must be visible, grouped into half-open ranges. */
function hiddenSubjectRanges(range: Omit<RenderReframeRangeV1, 'source'> & { source: 'plan' }, observations: ReframeObservationSetV2, margin: number,
  skip: (frame: number) => boolean): readonly Readonly<{ startFrame: number; endFrame: number }>[] {
  const hidden: Array<{ startFrame: number; endFrame: number }> = []
  const own = observations.observations.filter((item) => item.endFrame > range.startFrame && item.startFrame < range.endFrame)
    .toSorted((left, right) => left.startFrame - right.startFrame)
  let nextObservation = 0
  let active: typeof own = []
  let keyframeIndex = 0
  const keyframes = range.keyframes
  for (let frame = range.startFrame; frame < range.endFrame; frame += 1) {
    while (nextObservation < own.length && own[nextObservation]!.startFrame <= frame) active = [...active, own[nextObservation++]!]
    if (active.some((item) => item.endFrame <= frame)) active = active.filter((item) => item.endFrame > frame)
    if (skip(frame) || active.length === 0) continue
    // The same arithmetic as `interpolateReframeCrop`, walked once instead of searched per frame.
    while (keyframeIndex + 1 < keyframes.length && keyframes[keyframeIndex + 1]!.frame <= frame) keyframeIndex += 1
    const previous = keyframes[keyframeIndex]!, next = keyframes[keyframeIndex + 1]
    const crop: Readonly<NormalizedBounds> = !next ? previous.crop : (() => {
      const ratio = (frame - previous.frame) / (next.frame - previous.frame)
      return { x: previous.crop.x + (next.crop.x - previous.crop.x) * ratio, y: previous.crop.y + (next.crop.y - previous.crop.y) * ratio, width: previous.crop.width, height: previous.crop.height }
    })()
    if (reframeSubjectsVisible(crop, reframeFocusedObservations(active), margin)) continue
    const last = hidden.at(-1)
    if (last && last.endFrame === frame) last.endFrame = frame + 1
    else hidden.push({ startFrame: frame, endFrame: frame + 1 })
  }
  return hidden
}

export function buildVariantRenderReframePlan(input: Readonly<{
  plan: Readonly<ReframePlanV2>
  observationSet: Readonly<ReframeObservationSetV2>
  variantId: string
  clips: readonly VariantReframeTimelineClip[]
  source: Readonly<{ width: number; height: number }>
  fps: number
  durationFrames: number
  /** The overrides the plan was decided with, to name the manual spans. */
  overrides?: readonly Readonly<{ id: string; startFrame: number; endFrame: number }>[]
}>): Readonly<{ renderPlan: Readonly<RenderReframePlanV1>; violations: readonly ReframeTrajectoryViolation[] }> {
  const { plan, observationSet } = input
  assertDomain(plan.observationSetHash === observationSet.contentHash && plan.variant.variantId === input.variantId,
    'INVALID_RENDER_INPUT', 'The reframe plan does not describe this observation set and variant')
  const viewport = maximumReframeCrop(plan.format, observationSet.sourceWidth, observationSet.sourceHeight)
  const wholeFrame = reframeViewportIsWholeFrame(viewport)
  const ranges: Array<Omit<RenderReframeRangeV1, 'source'> & { source?: 'plan' | 'fallback' }> = []
  const violations: ReframeTrajectoryViolation[] = []
  for (const clip of input.clips) {
    const segments = plan.segments.filter((segment) => segment.startFrame >= clip.timelineInFrame && segment.endFrame <= clip.timelineOutFrame)
    assertDomain(segments.length > 0 && segments[0]!.startFrame === clip.timelineInFrame && segments.at(-1)!.endFrame === clip.timelineOutFrame,
      'INVALID_RENDER_INPUT', 'The reframe plan does not tile this clip', { clipId: clip.id })
    const points: Point[] = []
    const spans: VariantReframeManualSpan[] = []
    let lastCrop: Readonly<NormalizedBounds> | null = null
    let pendingStep = false
    const handledOverrides = new Set<string>()
    const push = (frame: number, crop: Readonly<NormalizedBounds>, pinned: boolean) => {
      const last = points.at(-1)
      if (last && last.frame === frame) { points[points.length - 1] = { frame, crop, pinned: last.pinned || pinned }; return }
      points.push({ frame, crop, pinned })
    }
    for (const segment of segments) {
      if (segment.source === 'manual' && segment.crop) {
        // The plan cuts a manual range at every observation boundary; the render holds it as ONE span, from the override's own range.
        const named = input.overrides?.find((override) => override.startFrame <= segment.startFrame && segment.endFrame <= override.endFrame)
        assertDomain(named !== undefined, 'INVALID_RENDER_INPUT', 'A manual reframe segment does not name its override', { clipId: clip.id })
        if (handledOverrides.has(named.id)) continue
        handledOverrides.add(named.id)
        assertDomain(named.startFrame >= clip.timelineInFrame && named.endFrame <= clip.timelineOutFrame, 'INVALID_RENDER_INPUT', 'A manual reframe span leaves its clip', { clipId: clip.id })
        if (points.length && points.at(-1)!.frame < named.startFrame - 1) push(named.startFrame - 1, lastCrop!, true)
        push(named.startFrame, segment.crop, true)
        if (named.endFrame - 1 > named.startFrame) push(named.endFrame - 1, segment.crop, true)
        spans.push(Object.freeze({ id: named.id, startFrame: named.startFrame, endFrame: named.endFrame }))
        lastCrop = segment.crop; pendingStep = true
      } else if (segment.mode === 'crop' && segment.crop) {
        if (pendingStep && points.length && points.at(-1)!.frame < segment.startFrame - 1) push(segment.startFrame - 1, lastCrop!, true)
        if (pendingStep) points.at(-1)!.pinned = true
        pendingStep = false
        push(segment.startFrame, segment.crop, false)
        lastCrop = segment.crop
      }
    }
    if (points.length === 0) {
      ranges.push({ clipId: clip.id, startFrame: clip.timelineInFrame, endFrame: clip.timelineOutFrame, interpolation: 'linear', source: 'fallback', keyframes: [] })
      continue
    }
    if (points[0]!.frame > clip.timelineInFrame) points.unshift({ frame: clip.timelineInFrame, crop: points[0]!.crop, pinned: false })
    // Only a frame the plan claims to track is held to the observations: a stretch it already reported (no subject, subjects that do not
    // fit, uncertain evidence) carries its own issue, and a manual span is the editor's decision.
    const tracking = segments.filter((segment) => segment.mode === 'crop' && segment.source !== 'manual')
    const inSpan = (frame: number) => spans.some((span) => frame >= span.startFrame && frame < span.endFrame) ||
      !tracking.some((segment) => frame >= segment.startFrame && frame < segment.endFrame)
    const exact = dropCollinear(points)
    const margin = plan.safetyMargin
    const verified = (candidate: readonly Point[]) => {
      const range = rangeOf(clip, candidate, spans)
      return { range, hidden: wholeFrame ? [] : hiddenSubjectRanges(range, observationSet, margin, inSpan) }
    }
    const baseline = verified(exact)
    let chosen = baseline
    if (exact.length > REFRAME_POLICY.render.maxKeyframesPerRange) {
      let tolerance: number = REFRAME_POLICY.render.keyframeSimplificationTolerance
      chosen = baseline
      let fitted = false
      for (; tolerance >= 1e-4; tolerance /= 2) {
        const reduced = simplify(exact, tolerance)
        if (reduced.length > REFRAME_POLICY.render.maxKeyframesPerRange) continue
        const attempt = verified(reduced)
        // A simplified path may not hide anything the exact one showed.
        if (attempt.hidden.length <= baseline.hidden.length) { chosen = attempt; fitted = true; break }
      }
      if (!fitted) {
        violations.push(Object.freeze({ clipId: clip.id, startFrame: clip.timelineInFrame, endFrame: clip.timelineOutFrame, reasonCode: 'KEYFRAME_BUDGET_EXCEEDED' as const }))
        ranges.push({ clipId: clip.id, startFrame: clip.timelineInFrame, endFrame: clip.timelineOutFrame, interpolation: 'linear', source: 'fallback', keyframes: [] })
        continue
      }
    }
    for (const hidden of chosen.hidden) {
      violations.push(Object.freeze({ clipId: clip.id, startFrame: hidden.startFrame, endFrame: hidden.endFrame, reasonCode: 'INTERPOLATED_PATH_HIDES_SUBJECT' as const }))
    }
    ranges.push({ ...chosen.range, source: 'plan' })
  }
  const renderPlan = createRenderReframePlan({
    format: plan.format, variantId: input.variantId, fps: input.fps, durationFrames: input.durationFrames, source: input.source, ranges,
  })
  return Object.freeze({ renderPlan, violations: Object.freeze(violations) })
}

/**
 * Speed and acceleration of a range's trajectory on its keyframe grid, from the keyframes alone (never from what a plan says about
 * itself). Speed is the centre displacement per second between two keyframes. Acceleration is the change of that speed between two
 * consecutive intervals, which the policy bounds by `acceleration * interval`. A step is not smoothed motion and is reported as such:
 * a one-frame interval that ends a manual span, begins one, or whose crop touches the frame edge on a slidable axis.
 */
export function measureReframeTrajectory(range: Readonly<RenderReframeRangeV1>, fps: number): Readonly<{
  maxSpeed: number
  maxAccelerationExcess: number
  steps: readonly number[]
}> {
  let maxSpeed = 0, maxExcess = 0
  const steps: number[] = []
  let previous: { speed: { x: number; y: number }; interval: number } | undefined
  const spans = range.manualSpans ?? []
  const keyframes = range.keyframes
  const touchesEdge = (crop: Readonly<NormalizedBounds>) =>
    (1 - crop.width > 1e-9 && (crop.x <= 1e-9 || crop.x + crop.width >= 1 - 1e-9)) || (1 - crop.height > 1e-9 && (crop.y <= 1e-9 || crop.y + crop.height >= 1 - 1e-9))
  for (let index = 1; index < keyframes.length; index += 1) {
    const from = keyframes[index - 1]!, to = keyframes[index]!
    const interval = (to.frame - from.frame) / fps
    // A one-frame interval that enters a manual span, or that leaves it for the first automatic keyframe after it, is the
    // editor's step, not smoothed motion.
    const step = to.frame - from.frame === 1 && spans.some((span) =>
      to.frame === span.startFrame || keyframes.find((keyframe) => keyframe.frame >= span.endFrame) === to)
    if (step) { steps.push(from.frame); previous = undefined; continue }
    const a = centerOf(from.crop), b = centerOf(to.crop)
    const speed = { x: (b.x - a.x) / interval, y: (b.y - a.y) / interval }
    maxSpeed = Math.max(maxSpeed, Math.hypot(speed.x, speed.y))
    if (previous && !touchesEdge(from.crop) && !touchesEdge(to.crop)) {
      const change = Math.hypot(speed.x - previous.speed.x, speed.y - previous.speed.y)
      maxExcess = Math.max(maxExcess, change - REFRAME_POLICY.tracking.maxAccelerationPerSecondSquared * interval)
    }
    previous = { speed, interval }
  }
  return Object.freeze({ maxSpeed, maxAccelerationExcess: maxExcess, steps: Object.freeze(steps) })
}

export const REFRAME_TRAJECTORY_EPSILON = REFRAME_EPSILON
