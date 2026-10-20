import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import type { NormalizedBounds } from './output-spec.ts'
import { REFRAME_COMPOSITION_ID, type RenderReframeRangeV1 } from './render-reframe-plan.ts'

/**
 * The single source <-> canvas projection of a render (W65).
 *
 * Everything the product knows about the picture (faces, OCR, inserts) is expressed in the normalized space of a
 * SOURCE frame. Everything a caption band, a CTA or a logo occupies is expressed in the normalized space of the
 * variant's CANVAS. Comparing the two without a projection is wrong in every format whose canvas is not the source
 * frame (9:16 from a 16:9 master puts the whole presenter in a horizontal strip of the canvas), so this module is the
 * only place where the two spaces meet. It mirrors, number for number, what `buildEditorialCompositionPrefix`
 * tells FFmpeg to do:
 *
 *   1. per clip: crop (a static `clip.crop`, or the reframe trajectory evaluated per frame, even-aligned in pixels);
 *   2. scale into the STAGING frame (`force_original_aspect_ratio=decrease`) and centre it (`pad`); the staging frame is
 *      the largest video source, which is why every video source of the render must be known;
 *   3. the joined video is fitted into the canvas (`decrease`), multiplied by `foregroundScale`, and overlaid
 *      horizontally centred at `verticalPosition` (the `foreground` of the filtergraph).
 *
 * Steps 1-3 are axis-aligned and uniform in scale, so the whole chain is a similarity: `canvasPx = S * sourcePx + offset`.
 * The blurred copy of the picture that fills the rest of the canvas is NOT face-bearing and has no projection.
 *
 * Soundness rule: wherever the chain cannot be reproduced exactly (FFmpeg rounds scaled sizes and overlay offsets to
 * integers; a pan is even-aligned), the answer is widened, never narrowed. A band is inflated by `CANVAS_TOLERANCE_PX`
 * before it is mapped back to the source, a mapped area by `SOURCE_TOLERANCE_PX`, and a moving area is replaced by the
 * hull of its position at both ends of a linear segment. That can over-block a caption; it can never under-report a face
 * under it. The pixel tests prove the tolerance against real FFmpeg output.
 */
export const CAPTION_PROJECTION_SCHEMA = 'caption-canvas-projection/v1' as const
export const CANVAS_TOLERANCE_PX = 3
export const SOURCE_TOLERANCE_PX = 2

export type ProjectionSource = Readonly<{ artifactId: string; width: number; height: number }>
export type ProjectionClip = Readonly<{
  id: string
  sourceArtifactId: string
  timelineInFrame: number
  timelineOutFrame: number
  /**
   * Where the clip plays in its SOURCE (W65b). Face evidence is keyed by the source's own frames, so the projection must know, per
   * clip, which source frame sits under each timeline frame. Only `rate === 1` with equal-length ranges is a pure frame offset
   * (`sourceFrame = timelineFrame + sourceInFrame - timelineInFrame`); anything else cannot be proven and is judged `unknown`.
   */
  sourceInFrame: number
  sourceOutFrame: number
  rate: number
  /** Static normalized crop of the source (`clip.crop`). */
  crop?: Readonly<NormalizedBounds>
  /** The reframe trajectory of the clip. It wins over `crop`, exactly as in the filtergraph. */
  reframe?: Readonly<RenderReframeRangeV1>
}>
export type ProjectionLayoutInput = Readonly<{
  canvas: Readonly<{ width: number; height: number }>
  composition?: Readonly<{ foregroundScale: number; verticalPosition: number }> | null
}>

export type CaptionProjection = Readonly<{
  schemaVersion: typeof CAPTION_PROJECTION_SCHEMA
  canvas: Readonly<{ width: number; height: number }>
  composition: Readonly<{ foregroundScale: number; verticalPosition: number }>
  /** The frame every clip is normalized to before the join: the largest video source, first one on a tie. */
  staging: Readonly<{ width: number; height: number }>
  sources: readonly Readonly<ProjectionSource>[]
  clips: readonly Readonly<ProjectionClip>[]
  projectionHash: string
}>

type Box = Readonly<{ l: number; t: number; r: number; b: number }>

const hull = (a: Box, b: Box): Box => ({ l: Math.min(a.l, b.l), t: Math.min(a.t, b.t), r: Math.max(a.r, b.r), b: Math.max(a.b, b.b) })
function meet(a: Box, b: Box): Box | null {
  const l = Math.max(a.l, b.l), t = Math.max(a.t, b.t), r = Math.min(a.r, b.r), bottom = Math.min(a.b, b.b)
  return r > l && bottom > t ? { l, t, r, b: bottom } : null
}
const inflate = (box: Box, by: number): Box => ({ l: box.l - by, t: box.t - by, r: box.r + by, b: box.b + by })
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function rounded4(value: number): number { return Number(value.toFixed(4)) }

export function createCaptionProjection(input: Readonly<{
  layout: ProjectionLayoutInput
  /** Every VIDEO source of the render, in render-source order (the staging frame is chosen among them). */
  sources: readonly Readonly<ProjectionSource>[]
  clips: readonly Readonly<ProjectionClip>[]
}>): Readonly<CaptionProjection> {
  const { canvas } = input.layout
  assertDomain(
    Number.isSafeInteger(canvas.width) && Number.isSafeInteger(canvas.height) && canvas.width >= 2 && canvas.height >= 2,
    'INVALID_RENDER_INPUT', 'Caption projection canvas is invalid',
  )
  const requestedScale = input.layout.composition?.foregroundScale ?? 1
  const requestedPosition = input.layout.composition?.verticalPosition ?? 0.5
  assertDomain(
    Number.isFinite(requestedScale) && requestedScale > 0 && requestedScale <= 4 &&
    Number.isFinite(requestedPosition) && requestedPosition >= 0 && requestedPosition <= 1,
    'INVALID_RENDER_INPUT', 'Caption projection composition is invalid',
  )
  // The filtergraph prints both numbers with four decimals, so four decimals is what FFmpeg computes with.
  const composition = Object.freeze({ foregroundScale: rounded4(requestedScale), verticalPosition: rounded4(requestedPosition) })
  assertDomain(input.sources.length >= 1, 'INVALID_RENDER_INPUT', 'Caption projection needs at least one video source')
  const seen = new Set<string>()
  for (const source of input.sources) {
    assertDomain(
      ID.test(source.artifactId) && !seen.has(source.artifactId) &&
      Number.isSafeInteger(source.width) && Number.isSafeInteger(source.height) && source.width >= 2 && source.height >= 2,
      'INVALID_RENDER_INPUT', 'Caption projection source is invalid', { artifactId: source.artifactId },
    )
    seen.add(source.artifactId)
  }
  let staging = input.sources[0]!
  for (const source of input.sources) if (source.width * source.height > staging.width * staging.height) staging = source
  const byId = new Map(input.sources.map((source) => [source.artifactId, source]))
  const clips = input.clips.toSorted((left, right) => left.timelineInFrame - right.timelineInFrame)
  let cursor = 0
  for (const clip of clips) {
    assertDomain(
      ID.test(clip.id) && byId.has(clip.sourceArtifactId) &&
      Number.isSafeInteger(clip.timelineInFrame) && Number.isSafeInteger(clip.timelineOutFrame) &&
      clip.timelineInFrame >= cursor && clip.timelineOutFrame > clip.timelineInFrame,
      'INVALID_RENDER_INPUT', 'Caption projection clip is invalid or overlaps the previous one', { clipId: clip.id },
    )
    assertDomain(
      Number.isSafeInteger(clip.sourceInFrame) && Number.isSafeInteger(clip.sourceOutFrame) && clip.sourceInFrame >= 0 &&
      clip.sourceOutFrame > clip.sourceInFrame && typeof clip.rate === 'number' && Number.isFinite(clip.rate) && clip.rate > 0,
      'INVALID_RENDER_INPUT', 'Caption projection clip does not say where it plays in its source', { clipId: clip.id },
    )
    cursor = clip.timelineOutFrame
    if (clip.crop) {
      const { x, y, width, height } = clip.crop
      assertDomain(
        [x, y, width, height].every(Number.isFinite) && x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= 1 && y + height <= 1,
        'INVALID_RENDER_INPUT', 'Caption projection clip crop is invalid', { clipId: clip.id },
      )
    }
    if (clip.reframe) {
      assertDomain(
        clip.reframe.clipId === clip.id && clip.reframe.startFrame === clip.timelineInFrame &&
        clip.reframe.endFrame === clip.timelineOutFrame && clip.reframe.keyframes.length >= 1,
        'INVALID_RENDER_INPUT', 'Caption projection reframe range does not cover its clip exactly', { clipId: clip.id },
      )
    }
  }
  const body = Object.freeze({
    schemaVersion: CAPTION_PROJECTION_SCHEMA,
    canvas: Object.freeze({ width: canvas.width, height: canvas.height }),
    composition,
    staging: Object.freeze({ width: staging.width, height: staging.height }),
    sources: Object.freeze(input.sources.map((source) => Object.freeze({ artifactId: source.artifactId, width: source.width, height: source.height }))
      .toSorted((left, right) => left.artifactId.localeCompare(right.artifactId))),
    clips: Object.freeze(clips.map((clip) => Object.freeze({
      id: clip.id, sourceArtifactId: clip.sourceArtifactId,
      timelineInFrame: clip.timelineInFrame, timelineOutFrame: clip.timelineOutFrame,
      sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame, rate: clip.rate,
      ...(clip.crop ? { crop: Object.freeze({ ...clip.crop }) } : {}),
      ...(clip.reframe ? { reframe: clip.reframe } : {}),
    }))),
  })
  const identity = Object.freeze({
    ...body,
    // A reframed clip is laid on the canvas by the cover rule (see `reframeSimilarity`), not by steps 2-3: that is part of what a projection is,
    // so it is part of its identity, and only when a clip is reframed (a projection with none keeps its identity).
    ...(clips.some((clip) => clip.reframe) ? { reframeComposition: REFRAME_COMPOSITION_ID } : {}),
    clips: body.clips.map((clip) => ({
      id: clip.id, sourceArtifactId: clip.sourceArtifactId,
      timelineInFrame: clip.timelineInFrame, timelineOutFrame: clip.timelineOutFrame,
      sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame, rate: clip.rate,
      crop: clip.crop ?? null, reframeRangeHash: clip.reframe ? calculateCanonicalHash(clip.reframe) : null,
    })),
  })
  return Object.freeze({ ...body, projectionHash: calculateCanonicalHash(identity) })
}

// ---------------------------------------------------------------------------------------------------------------------
// Crop window of one clip at one frame, in source pixels - the arithmetic of `normalizedCropFilter` and
// `buildReframeCropFilter`, reproduced here so a pure test can compare it with the filter text and a pixel test with
// the frames FFmpeg produced.
// ---------------------------------------------------------------------------------------------------------------------

const evenFloor = (value: number, maximum: number): number => Math.max(0, Math.min(maximum, Math.floor(value / 2) * 2))

function cropWindow(clip: Readonly<ProjectionClip>, source: Readonly<ProjectionSource>, frame: number): Box {
  const availableWidth = source.width - source.width % 2
  const availableHeight = source.height - source.height % 2
  if (clip.reframe) {
    const range = clip.reframe
    const first = range.keyframes[0]!
    const width = Math.min(availableWidth, Math.floor(first.crop.width * source.width / 2) * 2)
    const height = Math.min(availableHeight, Math.floor(first.crop.height * source.height / 2) * 2)
    const maxX = availableWidth - width, maxY = availableHeight - height
    if (range.keyframes.length === 1) {
      const x = evenFloor(first.crop.x * source.width, maxX), y = evenFloor(first.crop.y * source.height, maxY)
      return { l: x, t: y, r: x + width, b: y + height }
    }
    const n = frame - range.startFrame
    const axis = (key: 'x' | 'y', scale: number, limit: number): number => {
      const points = range.keyframes.map((keyframe) => ({ frame: keyframe.frame - range.startFrame, value: Math.max(0, Math.min(limit, keyframe.crop[key] * scale)) }))
      let value = points.at(-1)!.value
      for (let index = 0; index < points.length - 1; index += 1) {
        const from = points[index]!, to = points[index + 1]!
        if (n < to.frame) {
          value = range.interpolation === 'hold' ? from.value : from.value + (to.value - from.value) / (to.frame - from.frame) * (n - from.frame)
          break
        }
      }
      return 2 * Math.floor(Math.min(Math.max(value, 0), limit) / 2)
    }
    const x = axis('x', source.width, maxX), y = axis('y', source.height, maxY)
    return { l: x, t: y, r: x + width, b: y + height }
  }
  if (clip.crop) {
    const x = Math.floor(clip.crop.x * source.width / 2) * 2
    const y = Math.floor(clip.crop.y * source.height / 2) * 2
    const right = Math.min(availableWidth, Math.ceil((clip.crop.x + clip.crop.width) * source.width / 2) * 2)
    const bottom = Math.min(availableHeight, Math.ceil((clip.crop.y + clip.crop.height) * source.height / 2) * 2)
    return { l: x, t: y, r: right, b: bottom }
  }
  return { l: 0, t: 0, r: source.width, b: source.height }
}

type Similarity = Readonly<{ scale: number; offsetX: number; offsetY: number; crop: Box; source: Readonly<ProjectionSource> }>

function similarityAt(model: Readonly<CaptionProjection>, clip: Readonly<ProjectionClip>, frame: number): Similarity {
  const source = model.sources.find((candidate) => candidate.artifactId === clip.sourceArtifactId)!
  const crop = cropWindow(clip, source, frame)
  const cropWidth = crop.r - crop.l, cropHeight = crop.b - crop.t
  const { staging, canvas } = model
  if (clip.reframe) {
    // A reframed clip FILLS the canvas: the crop is scaled by the cover factor (`scale=...:force_original_aspect_ratio=increase`) and centred
    // (`crop=W:H`). There is no staging frame, no foreground band and no backdrop for it.
    const scale = Math.max(canvas.width / cropWidth, canvas.height / cropHeight)
    return {
      scale, source, crop,
      offsetX: -(cropWidth * scale - canvas.width) / 2 - scale * crop.l,
      offsetY: -(cropHeight * scale - canvas.height) / 2 - scale * crop.t,
    }
  }
  const { foregroundScale, verticalPosition } = model.composition
  // 2. crop -> staging frame (fit, centred)
  const toStaging = Math.min(staging.width / cropWidth, staging.height / cropHeight)
  const padX = (staging.width - cropWidth * toStaging) / 2, padY = (staging.height - cropHeight * toStaging) / 2
  // 3. staging -> canvas foreground (fit, then foregroundScale, centred horizontally, vertical position clamped)
  const toCanvas = Math.min(canvas.width / staging.width, canvas.height / staging.height) * foregroundScale
  const foregroundWidth = staging.width * toCanvas, foregroundHeight = staging.height * toCanvas
  const originX = (canvas.width - foregroundWidth) / 2
  const originY = Math.max(0, Math.min(canvas.height - foregroundHeight, canvas.height * verticalPosition - foregroundHeight / 2))
  const scale = toStaging * toCanvas
  return {
    scale, source, crop,
    offsetX: originX + padX * toCanvas - scale * crop.l,
    offsetY: originY + padY * toCanvas - scale * crop.t,
  }
}

const sourceToCanvas = (similarity: Similarity, box: Box): Box => ({
  l: similarity.scale * box.l + similarity.offsetX, t: similarity.scale * box.t + similarity.offsetY,
  r: similarity.scale * box.r + similarity.offsetX, b: similarity.scale * box.b + similarity.offsetY,
})
const canvasToSource = (similarity: Similarity, box: Box): Box => ({
  l: (box.l - similarity.offsetX) / similarity.scale, t: (box.t - similarity.offsetY) / similarity.scale,
  r: (box.r - similarity.offsetX) / similarity.scale, b: (box.b - similarity.offsetY) / similarity.scale,
})

/** Where the picture of a clip sits on the canvas at `frame`, normalized (the visible crop, clipped by the canvas). */
export function clipForegroundOnCanvas(model: Readonly<CaptionProjection>, clipId: string, frame: number): Readonly<NormalizedBounds> | null {
  const clip = model.clips.find((candidate) => candidate.id === clipId)
  assertDomain(clip !== undefined, 'INVALID_ARGUMENT', 'Unknown clip for the caption projection', { clipId })
  assertDomain(frame >= clip.timelineInFrame && frame < clip.timelineOutFrame, 'INVALID_ARGUMENT', 'Frame is outside the clip', { clipId, frame })
  const similarity = similarityAt(model, clip, frame)
  const visible = meet(sourceToCanvas(similarity, similarity.crop), { l: 0, t: 0, r: model.canvas.width, b: model.canvas.height })
  return visible ? normalizeBox(visible, model.canvas) : null
}

function normalizeBox(box: Box, canvas: Readonly<{ width: number; height: number }>): Readonly<NormalizedBounds> {
  const clamp = (value: number) => Math.max(0, Math.min(1, value))
  const x = clamp(box.l / canvas.width), y = clamp(box.t / canvas.height)
  return Object.freeze({ x, y, width: clamp(box.r / canvas.width) - x, height: clamp(box.b / canvas.height) - y })
}

/** A sampling plan of one clip over a window: the frames whose positions bound every frame in between. */
type Interval = Readonly<{ startFrame: number; endFrame: number; probes: readonly number[] }>

function intervalsOf(clip: Readonly<ProjectionClip>, windowStart: number, windowEnd: number): readonly Interval[] {
  const lo = Math.max(clip.timelineInFrame, windowStart), hi = Math.min(clip.timelineOutFrame, windowEnd)
  if (hi <= lo) return []
  const cuts = new Set<number>([lo, hi])
  if (clip.reframe && clip.reframe.keyframes.length > 1) {
    for (const keyframe of clip.reframe.keyframes) if (keyframe.frame > lo && keyframe.frame < hi) cuts.add(keyframe.frame)
  }
  const ordered = [...cuts].toSorted((left, right) => left - right)
  const intervals: Interval[] = []
  for (let index = 0; index + 1 < ordered.length; index += 1) {
    const a = ordered[index]!, b = ordered[index + 1]!
    // Between two breakpoints the crop moves linearly (or not at all), so its two end frames bound every frame between.
    intervals.push(Object.freeze({ startFrame: a, endFrame: b, probes: Object.freeze(b - 1 > a ? [a, b - 1] : [a]) }))
  }
  return intervals
}

export type BandSourceSegment = Readonly<{
  clipId: string | null
  sourceArtifactId: string | null
  startFrame: number
  endFrame: number
  kind: 'source' | 'outside-foreground' | 'uncovered'
  /** Normalized SOURCE-frame area under the band during the span (a sound over-approximation); `null` unless `source`. */
  area: Readonly<NormalizedBounds> | null
}>

/**
 * The part of each clip's SOURCE frame that lies under a canvas band over `[windowStart, windowEnd)`.
 *
 * `outside-foreground`: the band touches no pixel of the clip's picture during the span (it sits over the blurred copy
 * or over black staging bars), so no face of that source can be under it. `uncovered`: the span has no clip at all.
 * The segments tile the window, in order.
 */
export function canvasBandSourceAreas(model: Readonly<CaptionProjection>, band: Readonly<NormalizedBounds>, window: Readonly<{ startFrame: number; endFrame: number }>): readonly BandSourceSegment[] {
  assertDomain(Number.isSafeInteger(window.startFrame) && Number.isSafeInteger(window.endFrame) && window.startFrame >= 0 && window.endFrame > window.startFrame,
    'INVALID_ARGUMENT', 'Caption projection window is invalid')
  const bandPx = inflate({ l: band.x * model.canvas.width, t: band.y * model.canvas.height, r: (band.x + band.width) * model.canvas.width, b: (band.y + band.height) * model.canvas.height }, CANVAS_TOLERANCE_PX)
  const segments: BandSourceSegment[] = []
  let cursor = window.startFrame
  for (const clip of model.clips) {
    const intervals = intervalsOf(clip, window.startFrame, window.endFrame)
    if (!intervals.length) continue
    if (intervals[0]!.startFrame > cursor) {
      segments.push(Object.freeze({ clipId: null, sourceArtifactId: null, startFrame: cursor, endFrame: intervals[0]!.startFrame, kind: 'uncovered' as const, area: null }))
    }
    for (const interval of intervals) {
      let sourceHull: Box | null = null, cropHull: Box | null = null
      for (const frame of interval.probes) {
        const similarity = similarityAt(model, clip, frame)
        const here = canvasToSource(similarity, bandPx)
        sourceHull = sourceHull ? hull(sourceHull, here) : here
        cropHull = cropHull ? hull(cropHull, similarity.crop) : similarity.crop
      }
      const source = model.sources.find((candidate) => candidate.artifactId === clip.sourceArtifactId)!
      const common = meet(sourceHull!, cropHull!)
      if (!common) {
        segments.push(Object.freeze({ clipId: clip.id, sourceArtifactId: clip.sourceArtifactId, startFrame: interval.startFrame, endFrame: interval.endFrame, kind: 'outside-foreground' as const, area: null }))
      } else {
        const widened = meet(inflate(common, SOURCE_TOLERANCE_PX), { l: 0, t: 0, r: source.width, b: source.height })!
        segments.push(Object.freeze({
          clipId: clip.id, sourceArtifactId: clip.sourceArtifactId, startFrame: interval.startFrame, endFrame: interval.endFrame, kind: 'source' as const,
          area: normalizeBox(widened, source),
        }))
      }
      cursor = interval.endFrame
    }
  }
  if (cursor < window.endFrame) {
    segments.push(Object.freeze({ clipId: null, sourceArtifactId: null, startFrame: cursor, endFrame: window.endFrame, kind: 'uncovered' as const, area: null }))
  }
  return Object.freeze(segments)
}

export type SourceRectCanvasSegment = Readonly<{
  clipId: string
  startFrame: number
  endFrame: number
  bounds: Readonly<NormalizedBounds>
}>

/**
 * Where a SOURCE-frame rectangle (an OCR box, an inserted image) lands on the canvas over `[window)`, one entry per
 * span in which it is visible, as a normalized canvas rectangle widened by the tolerance. Parts of the rectangle that
 * the crop removes, and spans without clips, produce nothing.
 */
export function sourceRectCanvasSegments(model: Readonly<CaptionProjection>, rect: Readonly<NormalizedBounds>, sourceArtifactId: string | null, window: Readonly<{ startFrame: number; endFrame: number }>): readonly SourceRectCanvasSegment[] {
  const out: SourceRectCanvasSegment[] = []
  for (const clip of model.clips) {
    if (sourceArtifactId !== null && clip.sourceArtifactId !== sourceArtifactId) continue
    const source = model.sources.find((candidate) => candidate.artifactId === clip.sourceArtifactId)!
    const rectPx: Box = inflate({ l: rect.x * source.width, t: rect.y * source.height, r: (rect.x + rect.width) * source.width, b: (rect.y + rect.height) * source.height }, SOURCE_TOLERANCE_PX)
    for (const interval of intervalsOf(clip, window.startFrame, window.endFrame)) {
      let cropHull: Box | null = null
      for (const frame of interval.probes) {
        const crop = similarityAt(model, clip, frame).crop
        cropHull = cropHull ? hull(cropHull, crop) : crop
      }
      const visible = meet(rectPx, cropHull!)
      if (!visible) continue
      let onCanvas: Box | null = null
      for (const frame of interval.probes) {
        const here = sourceToCanvas(similarityAt(model, clip, frame), visible)
        onCanvas = onCanvas ? hull(onCanvas, here) : here
      }
      const clipped = meet(inflate(onCanvas!, CANVAS_TOLERANCE_PX), { l: 0, t: 0, r: model.canvas.width, b: model.canvas.height })
      if (!clipped) continue
      out.push(Object.freeze({ clipId: clip.id, startFrame: interval.startFrame, endFrame: interval.endFrame, bounds: normalizeBox(clipped, model.canvas) }))
    }
  }
  return Object.freeze(out)
}
