import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import { readOutputFormatPreset } from './output-format-registry.ts'
import { OUTPUT_ASPECT_RATIOS, type NormalizedBounds, type OutputAspectRatio } from './output-spec.ts'

/**
 * How a reframed range is laid on the canvas (W66r): the crop window is scaled by the COVER factor and centred, so the picture the plan chose
 * FILLS the variant canvas. There is no staging band and no blurred backdrop for a reframed range; a clip that is not reframed keeps the
 * composition it always had. The renderer, the caption projection and the render element map all read this one rule, and a render made from
 * a persisted plan carries its name in its input hash, so changing the rule can never be mistaken for the same render.
 */
export const REFRAME_COMPOSITION_ID = 'reframe-fills-canvas/v1' as const

/**
 * Reframe geometry the renderer receives inside a materialized `RenderInput`.
 *
 * A range is a **half-open** `[startFrame, endFrame)` interval of one clip carrying at least one
 * keyframe. One keyframe is a static crop — exactly what the previous per-clip crop expressed, so
 * nothing regressed. Two or more keyframes describe a trajectory: the crop between them is a
 * deterministic linear interpolation (or a hold), evaluated per frame with integer frame indices,
 * so the same plan produces the same pixels on every machine.
 *
 * A trajectory pans; it never zooms. All keyframes of a range must share one crop size, because a
 * crop whose size changes mid-clip cannot be encoded as a single deterministic stream. A plan that
 * asks for one fails closed instead of being silently approximated.
 */
export interface RenderReframeKeyframeV1 {
  frame: number
  crop: Readonly<NormalizedBounds>
}

/** A stretch of a range that the editor framed by hand (W66r): its crop is held exactly and the automatic trajectory resumes after it. */
export interface RenderReframeManualSpanV1 {
  id: string
  startFrame: number
  endFrame: number
}

export interface RenderReframeRangeV1 {
  clipId: string
  startFrame: number
  endFrame: number
  interpolation: 'linear' | 'hold'
  /**
   * `plan`: the automatic trajectory. `manual`: the whole range is one editor crop. `fallback` (W66r): nothing in this clip could be
   * tracked, so it plays uncropped (the whole frame, letterboxed into the canvas) and carries NO keyframe.
   */
  source: 'plan' | 'manual' | 'fallback'
  keyframes: readonly Readonly<RenderReframeKeyframeV1>[]
  /** Editor-framed stretches inside an automatic range. Absent when there are none. */
  manualSpans?: readonly Readonly<RenderReframeManualSpanV1>[]
}

export interface RenderReframePlanV1 {
  schemaVersion: 'render-reframe-plan/v1'
  format: OutputAspectRatio
  outputSpecId: string
  outputPresetHash: string
  variantId: string
  fps: number
  durationFrames: number
  source: Readonly<{ width: number; height: number }>
  ranges: readonly Readonly<RenderReframeRangeV1>[]
  reframePlanHash: string
}

export interface RenderReframeOverrideV1 {
  id: string
  variantId: string
  startFrame: number
  endFrame: number
  crop: Readonly<NormalizedBounds>
}

const SHA256 = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const EPSILON = 1e-7
const ASPECT_TOLERANCE = 0.002
const MAX_KEYFRAMES = 600

function assertCrop(crop: Readonly<NormalizedBounds>, field: string): Readonly<NormalizedBounds> {
  assertDomain(
    [crop.x, crop.y, crop.width, crop.height].every((value) => typeof value === 'number' && Number.isFinite(value)) &&
    crop.x >= -EPSILON && crop.y >= -EPSILON && crop.width > 0 && crop.height > 0 &&
    crop.x + crop.width <= 1 + EPSILON && crop.y + crop.height <= 1 + EPSILON,
    'INVALID_RENDER_INPUT', `${field} is not inside the source frame`, { crop },
  )
  return Object.freeze({ ...crop })
}

function assertCropAspect(crop: Readonly<NormalizedBounds>, format: OutputAspectRatio, source: Readonly<{ width: number; height: number }>, field: string): void {
  const expected = Number(format.split(':')[0]) / Number(format.split(':')[1])
  const actual = crop.width * source.width / (crop.height * source.height)
  assertDomain(Math.abs(actual - expected) <= ASPECT_TOLERANCE, 'INVALID_RENDER_INPUT', `${field} does not match the output aspect ratio`, { actual, expected })
}

/**
 * Deterministic crop at `frame`. Linear ranges interpolate between the two surrounding keyframes
 * with exact integer frame arithmetic; `hold` ranges keep the last keyframe reached.
 */
export function interpolateReframeCrop(range: Readonly<RenderReframeRangeV1>, frame: number): Readonly<NormalizedBounds> {
  assertDomain(
    Number.isSafeInteger(frame) && frame >= range.startFrame && frame < range.endFrame,
    'INVALID_RENDER_INPUT', 'Reframe frame is outside its range', { frame, range: { startFrame: range.startFrame, endFrame: range.endFrame } },
  )
  assertDomain(range.keyframes.length >= 1, 'INVALID_RENDER_INPUT', 'A fallback reframe range has no crop to interpolate')
  let previous = range.keyframes[0]!
  let next: Readonly<RenderReframeKeyframeV1> | undefined
  for (const keyframe of range.keyframes) {
    if (keyframe.frame <= frame) previous = keyframe
    else { next = keyframe; break }
  }
  if (range.interpolation === 'hold' || !next) return Object.freeze({ ...previous.crop })
  const span = next.frame - previous.frame
  const ratio = (frame - previous.frame) / span
  const lerp = (from: number, to: number) => from + (to - from) * ratio
  return Object.freeze({
    x: lerp(previous.crop.x, next.crop.x), y: lerp(previous.crop.y, next.crop.y),
    width: previous.crop.width, height: previous.crop.height,
  })
}

export function createRenderReframePlan(input: Readonly<{
  format: OutputAspectRatio
  variantId: string
  fps: number
  durationFrames: number
  source: Readonly<{ width: number; height: number }>
  ranges: readonly Readonly<Omit<RenderReframeRangeV1, 'source'> & { source?: 'plan' | 'fallback' }>[]
  overrides?: readonly Readonly<RenderReframeOverrideV1>[]
}>): Readonly<RenderReframePlanV1> {
  assertDomain(OUTPUT_ASPECT_RATIOS.includes(input.format), 'INVALID_RENDER_INPUT', 'Reframe plan format is not registered')
  const preset = readOutputFormatPreset(input.format)
  // A manual override only rewrites the range it names, and only in the variant it names. It can
  // never leak into a sibling variant that happens to share the same frame window.
  const overrides = (input.overrides ?? []).map((override) => {
    assertDomain(ID.test(override.id), 'INVALID_RENDER_INPUT', 'Reframe override id is invalid')
    assertDomain(override.variantId === input.variantId, 'INVALID_RENDER_INPUT', 'Reframe override belongs to another output variant', { requested: input.variantId, received: override.variantId })
    assertDomain(
      Number.isSafeInteger(override.startFrame) && Number.isSafeInteger(override.endFrame) && override.endFrame > override.startFrame,
      'INVALID_RENDER_INPUT', 'Reframe override range is invalid',
    )
    return Object.freeze({ ...override, crop: assertCrop(override.crop, `override ${override.id} crop`) })
  })
  const ranges = input.ranges.map((range) => {
    const override = overrides.find((candidate) => candidate.startFrame === range.startFrame && candidate.endFrame === range.endFrame)
    if (!override) {
      const { source: _source, manualSpans, ...rest } = range
      return Object.freeze({
        ...rest, source: (range.source ?? 'plan') as 'plan' | 'fallback',
        keyframes: Object.freeze(range.keyframes.map((keyframe) => Object.freeze({ frame: keyframe.frame, crop: assertCrop(keyframe.crop, `keyframe ${keyframe.frame} crop`) }))),
        ...(manualSpans && manualSpans.length ? { manualSpans: Object.freeze(manualSpans.map((span) => Object.freeze({ ...span }))) } : {}),
      })
    }
    return Object.freeze({
      clipId: range.clipId, startFrame: range.startFrame, endFrame: range.endFrame,
      interpolation: 'hold' as const, source: 'manual' as const,
      keyframes: Object.freeze([Object.freeze({ frame: range.startFrame, crop: override.crop })]),
    })
  })
  for (const override of overrides) {
    assertDomain(
      ranges.some((range) => range.source === 'manual' && range.startFrame === override.startFrame && range.endFrame === override.endFrame),
      'INVALID_RENDER_INPUT', 'Reframe override does not name an existing range', { override: override.id },
    )
  }
  const body = Object.freeze({
    schemaVersion: 'render-reframe-plan/v1' as const,
    format: input.format, outputSpecId: preset.spec.id, outputPresetHash: preset.presetHash,
    variantId: input.variantId, fps: input.fps, durationFrames: input.durationFrames,
    source: Object.freeze({ ...input.source }),
    ranges: Object.freeze(ranges.toSorted((left, right) => left.startFrame - right.startFrame)),
  })
  const plan = Object.freeze({ ...body, reframePlanHash: calculateCanonicalHash(body) })
  validateRenderReframePlan(plan)
  return plan
}

/**
 * Fail-closed gate the worker runs **before** the renderer starts: contiguous half-open coverage,
 * at least one keyframe per range, strictly increasing keyframe frames, a constant crop size per
 * range, an aspect ratio matching the output, and a recomputed content address.
 */
export function validateRenderReframePlan(plan: Readonly<RenderReframePlanV1>): void {
  assertDomain(plan.schemaVersion === 'render-reframe-plan/v1', 'INVALID_RENDER_INPUT', 'Reframe plan schema version is unsupported')
  assertDomain(OUTPUT_ASPECT_RATIOS.includes(plan.format), 'INVALID_RENDER_INPUT', 'Reframe plan format is not registered')
  const preset = readOutputFormatPreset(plan.format)
  assertDomain(plan.outputSpecId === preset.spec.id && plan.outputPresetHash === preset.presetHash, 'INVALID_RENDER_INPUT', 'Reframe plan output identity drifted from the registry')
  assertDomain(ID.test(plan.variantId), 'INVALID_RENDER_INPUT', 'Reframe plan variant id is invalid')
  assertDomain(Number.isFinite(plan.fps) && plan.fps > 0 && plan.fps <= 240, 'INVALID_RENDER_INPUT', 'Reframe plan fps is invalid')
  assertDomain(Number.isSafeInteger(plan.durationFrames) && plan.durationFrames >= 1, 'INVALID_RENDER_INPUT', 'Reframe plan duration is invalid')
  assertDomain(
    Number.isSafeInteger(plan.source.width) && Number.isSafeInteger(plan.source.height) &&
    plan.source.width >= 2 && plan.source.height >= 2,
    'INVALID_RENDER_INPUT', 'Reframe plan source dimensions are invalid',
  )
  assertDomain(plan.ranges.length >= 1 && plan.ranges.length <= 20_000, 'INVALID_RENDER_INPUT', 'Reframe plan ranges are invalid')
  let cursor = 0
  for (const range of plan.ranges) {
    assertDomain(ID.test(range.clipId), 'INVALID_RENDER_INPUT', 'Reframe range clip id is invalid')
    assertDomain(range.startFrame === cursor && range.endFrame > range.startFrame && range.endFrame <= plan.durationFrames, 'INVALID_RENDER_INPUT', 'Reframe plan ranges must tile the timeline without gaps or overlap', { clipId: range.clipId, startFrame: range.startFrame, expected: cursor })
    assertDomain(range.interpolation === 'linear' || range.interpolation === 'hold', 'INVALID_RENDER_INPUT', 'Reframe interpolation is unsupported')
    assertDomain(range.source === 'plan' || range.source === 'manual' || range.source === 'fallback', 'INVALID_RENDER_INPUT', 'Reframe range source is unsupported')
    if (range.source === 'fallback') {
      // An untracked clip is shown whole: a crop here would be a claim the plan could not make.
      assertDomain(range.keyframes.length === 0 && range.manualSpans === undefined, 'INVALID_RENDER_INPUT', 'A fallback reframe range carries no keyframe', { clipId: range.clipId })
      cursor = range.endFrame
      continue
    }
    assertDomain(range.keyframes.length >= 1 && range.keyframes.length <= MAX_KEYFRAMES, 'INVALID_RENDER_INPUT', 'Reframe range requires 1 to 600 keyframes', { clipId: range.clipId })
    const first = range.keyframes[0]!
    assertDomain(first.frame === range.startFrame, 'INVALID_RENDER_INPUT', 'Reframe range must open with a keyframe on its first frame', { clipId: range.clipId })
    let previousFrame = -1
    for (const keyframe of range.keyframes) {
      assertDomain(Number.isSafeInteger(keyframe.frame) && keyframe.frame > previousFrame && keyframe.frame >= range.startFrame && keyframe.frame < range.endFrame, 'INVALID_RENDER_INPUT', 'Reframe keyframes must be strictly increasing inside the half-open range', { clipId: range.clipId, frame: keyframe.frame })
      previousFrame = keyframe.frame
      assertCrop(keyframe.crop, `reframe keyframe ${keyframe.frame} crop`)
      assertCropAspect(keyframe.crop, plan.format, plan.source, `reframe keyframe ${keyframe.frame} crop`)
      assertDomain(
        Math.abs(keyframe.crop.width - first.crop.width) <= EPSILON && Math.abs(keyframe.crop.height - first.crop.height) <= EPSILON,
        'INVALID_RENDER_INPUT', 'A reframe trajectory pans with a constant crop size; a zoom cannot be rendered deterministically', { clipId: range.clipId, frame: keyframe.frame },
      )
    }
    for (const [position, span] of (range.manualSpans ?? []).entries()) {
      assertDomain(
        ID.test(span.id) && Number.isSafeInteger(span.startFrame) && Number.isSafeInteger(span.endFrame) &&
        span.startFrame >= range.startFrame && span.endFrame > span.startFrame && span.endFrame <= range.endFrame &&
        (position === 0 || span.startFrame >= range.manualSpans![position - 1]!.endFrame),
        'INVALID_RENDER_INPUT', 'Reframe manual span is invalid, outside its range or overlapping', { clipId: range.clipId, span: span.id },
      )
      // The editor's crop is held exactly: the trajectory evaluated on every keyframe inside the span and on both of its ends is one crop.
      const held = interpolateReframeCrop(range, span.startFrame)
      const probes = [span.endFrame - 1, ...range.keyframes.map((keyframe) => keyframe.frame).filter((frame) => frame > span.startFrame && frame < span.endFrame)]
      for (const frame of probes) {
        const crop = interpolateReframeCrop(range, frame)
        assertDomain(
          Math.abs(crop.x - held.x) <= EPSILON && Math.abs(crop.y - held.y) <= EPSILON,
          'INVALID_RENDER_INPUT', 'A manual span must hold one crop', { clipId: range.clipId, span: span.id, frame },
        )
      }
    }
    cursor = range.endFrame
  }
  assertDomain(cursor === plan.durationFrames, 'INVALID_RENDER_INPUT', 'Reframe plan does not cover the whole timeline', { cursor, durationFrames: plan.durationFrames })
  const { reframePlanHash, ...body } = plan
  assertDomain(SHA256.test(reframePlanHash) && reframePlanHash === calculateCanonicalHash(body), 'INVALID_RENDER_INPUT', 'Reframe plan hash is inconsistent')
}

/** The range that owns `frame`, or `undefined` when the plan does not cover it. */
export function reframeRangeAtFrame(plan: Readonly<RenderReframePlanV1>, frame: number): Readonly<RenderReframeRangeV1> | undefined {
  return plan.ranges.find((range) => range.startFrame <= frame && range.endFrame > frame)
}
