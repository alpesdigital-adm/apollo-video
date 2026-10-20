import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canvasBandSourceAreas, CANVAS_TOLERANCE_PX, clipForegroundOnCanvas, createCaptionProjection, SOURCE_TOLERANCE_PX,
  sourceRectCanvasSegments,
} from '../../src/v2/domain/caption-canvas-projection.ts'
import { createRenderReframePlan } from '../../src/v2/domain/render-reframe-plan.ts'
import { buildReframeCropFilter } from '../../src/v2/infrastructure/media/ffmpeg-editorial-composition-graph.ts'

/**
 * W65: the one projection between the SOURCE frame (where faces/OCR live) and the variant CANVAS (where bands live).
 * Pure checks; the pixel proofs run the same arithmetic against real FFmpeg output.
 */
const SOURCE = Object.freeze({ artifactId: 'source-1', width: 1280, height: 720 })
const PORTRAIT = Object.freeze({ width: 540, height: 960 })
const LANDSCAPE = Object.freeze({ width: 960, height: 540 })
// The clip plays its source from the same frame it starts on the timeline, at speed 1, unless a test says otherwise (W65b).
const clip = (overrides = {}) => {
  const base = { id: 'clip-1', sourceArtifactId: 'source-1', timelineInFrame: 0, timelineOutFrame: 300, ...overrides }
  return { sourceInFrame: base.timelineInFrame, sourceOutFrame: base.timelineOutFrame, rate: 1, ...base }
}
const projection = (canvas, clips = [clip()], extra = {}) => createCaptionProjection({ layout: { canvas, ...extra }, sources: [SOURCE], clips })
const near = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`)

test('the staging frame is the largest video source, first one on a tie, and the projection is content-addressed', () => {
  const small = { artifactId: 'source-2', width: 640, height: 360 }
  const sameArea = { artifactId: 'source-3', width: 720, height: 1280 }
  const clips = [clip(), clip({ id: 'clip-2', sourceArtifactId: 'source-2', timelineInFrame: 300, timelineOutFrame: 400 })]
  const both = createCaptionProjection({ layout: { canvas: PORTRAIT }, sources: [small, SOURCE], clips })
  assert.deepEqual({ ...both.staging }, { width: 1280, height: 720 })
  const tied = createCaptionProjection({ layout: { canvas: PORTRAIT }, sources: [SOURCE, sameArea], clips: [clip()] })
  assert.deepEqual({ ...tied.staging }, { width: 1280, height: 720 }, 'on equal area the first source in render order wins, as in the renderer')
  assert.match(both.projectionHash, /^[a-f0-9]{64}$/)
  assert.equal(projection(PORTRAIT).projectionHash, projection(PORTRAIT).projectionHash)
  assert.notEqual(projection(PORTRAIT).projectionHash, projection(LANDSCAPE).projectionHash, 'another canvas is another projection')
  assert.notEqual(projection(PORTRAIT).projectionHash,
    projection(PORTRAIT, [clip()], { composition: { foregroundScale: 0.9, verticalPosition: 0.5 } }).projectionHash)
  assert.throws(() => createCaptionProjection({ layout: { canvas: PORTRAIT }, sources: [SOURCE], clips: [clip({ sourceArtifactId: 'missing' })] }), /invalid/i)
  // W65b: where the clip plays in its SOURCE is part of the projection's identity, and a clip that does not say is refused
  assert.notEqual(projection(PORTRAIT).projectionHash, projection(PORTRAIT, [clip({ sourceInFrame: 40, sourceOutFrame: 340 })]).projectionHash)
  assert.notEqual(projection(PORTRAIT).projectionHash, projection(PORTRAIT, [clip({ rate: 2 })]).projectionHash)
  for (const broken of [{ sourceInFrame: undefined }, { sourceOutFrame: undefined }, { rate: undefined }, { sourceInFrame: -1 },
    { sourceOutFrame: 0, sourceInFrame: 0 }, { rate: 0 }, { rate: Number.NaN }, { sourceInFrame: 1.5 }]) {
    assert.throws(() => createCaptionProjection({ layout: { canvas: PORTRAIT }, sources: [SOURCE], clips: [clip(broken)] }), /does not say where it plays/i, JSON.stringify(broken))
  }
  assert.throws(() => createCaptionProjection({ layout: { canvas: PORTRAIT }, sources: [SOURCE],
    clips: [clip(), clip({ id: 'clip-2', timelineInFrame: 100, timelineOutFrame: 200 })] }), /overlaps/i)
})

test('a 16:9 picture on a 9:16 canvas is a horizontal strip, centred; on a 16:9 canvas it fills the frame', () => {
  const strip = clipForegroundOnCanvas(projection(PORTRAIT), 'clip-1', 10)
  near(strip.x, 0, 1e-9, 'x'); near(strip.width, 1, 1e-9, 'width')
  // 1280x720 fitted to 540 wide is 303.75 tall, centred in 960: y 328.125 .. 631.875
  near(strip.y * PORTRAIT.height, 328.125, 1e-6, 'top'); near(strip.height * PORTRAIT.height, 303.75, 1e-6, 'height')
  const full = clipForegroundOnCanvas(projection(LANDSCAPE), 'clip-1', 10)
  assert.deepEqual({ x: full.x, y: full.y, width: full.width, height: full.height }, { x: 0, y: 0, width: 1, height: 1 })
  // foregroundScale and verticalPosition follow the filtergraph (four decimals, vertical clamp)
  const shrunk = clipForegroundOnCanvas(projection(LANDSCAPE, [clip()], { composition: { foregroundScale: 0.5, verticalPosition: 0 } }), 'clip-1', 10)
  near(shrunk.width, 0.5, 1e-9, 'scaled width'); near(shrunk.y, 0, 1e-9, 'clamped to the top'); near(shrunk.x, 0.25, 1e-9, 'centred')
})

test('a band over the blurred copy touches no source pixel; a band over the picture maps back to the matching source rows', () => {
  const model = projection(PORTRAIT)
  const bottom = canvasBandSourceAreas(model, { x: 0.07, y: 0.74, width: 0.86, height: 0.16 }, { startFrame: 0, endFrame: 60 })
  assert.deepEqual(bottom.map((segment) => [segment.kind, segment.startFrame, segment.endFrame, segment.area]), [['outside-foreground', 0, 60, null]])
  const center = canvasBandSourceAreas(model, { x: 0.07, y: 0.42, width: 0.86, height: 0.16 }, { startFrame: 0, endFrame: 60 })
  assert.equal(center.length, 1); assert.equal(center[0].kind, 'source'); assert.equal(center[0].sourceArtifactId, 'source-1')
  // canvas y 0.42..0.58 of 960 = 403.2..556.8 -> source rows (y - 328.125) / 303.75 of the picture, widened by the tolerances
  const margin = (CANVAS_TOLERANCE_PX / 0.421875 + SOURCE_TOLERANCE_PX) / 720
  near(center[0].area.y, (403.2 - 328.125) / 303.75 - margin, 1e-6, 'area top')
  near(center[0].area.y + center[0].area.height, (556.8 - 328.125) / 303.75 + margin, 1e-6, 'area bottom')
  near(center[0].area.x, 0.07 - (CANVAS_TOLERANCE_PX / 0.421875 + SOURCE_TOLERANCE_PX) / 1280, 1e-6, 'area left')
  // on the landscape canvas the same band is over the picture at the same normalized place
  const landscape = canvasBandSourceAreas(projection(LANDSCAPE), { x: 0.07, y: 0.74, width: 0.86, height: 0.16 }, { startFrame: 0, endFrame: 60 })
  assert.equal(landscape[0].kind, 'source')
  near(landscape[0].area.y, 0.74 - (CANVAS_TOLERANCE_PX / 0.75 + SOURCE_TOLERANCE_PX) / 720, 1e-6, 'landscape top')
})

test('segments tile the window; a span without a clip is uncovered, never silently free', () => {
  const model = projection(LANDSCAPE, [clip({ timelineInFrame: 20, timelineOutFrame: 80 })])
  const segments = canvasBandSourceAreas(model, { x: 0.1, y: 0.1, width: 0.5, height: 0.2 }, { startFrame: 0, endFrame: 100 })
  assert.deepEqual(segments.map((segment) => [segment.kind, segment.startFrame, segment.endFrame]),
    [['uncovered', 0, 20], ['source', 20, 80], ['uncovered', 80, 100]])
  assert.equal(canvasBandSourceAreas(model, { x: 0.1, y: 0.1, width: 0.5, height: 0.2 }, { startFrame: 85, endFrame: 95 })[0].kind, 'uncovered')
})

test('a source rectangle lands on the canvas and its own canvas footprint maps back over it', () => {
  const model = projection(PORTRAIT)
  const face = { x: 0.40, y: 0.30, width: 0.12, height: 0.25 }
  const [onCanvas] = sourceRectCanvasSegments(model, face, 'source-1', { startFrame: 0, endFrame: 30 })
  // picture strip: y = 328.125 + v * 303.75, x = u * 540
  near(onCanvas.bounds.x * 540, 0.40 * 540 - CANVAS_TOLERANCE_PX - SOURCE_TOLERANCE_PX * 0.421875, 1e-6, 'left')
  near(onCanvas.bounds.y * 960, 328.125 + 0.30 * 303.75 - CANVAS_TOLERANCE_PX - SOURCE_TOLERANCE_PX * 0.421875, 1e-6, 'top')
  const [back] = canvasBandSourceAreas(model, onCanvas.bounds, { startFrame: 0, endFrame: 30 })
  assert.equal(back.kind, 'source')
  assert.ok(back.area.x <= face.x && back.area.y <= face.y && back.area.x + back.area.width >= face.x + face.width &&
    back.area.y + back.area.height >= face.y + face.height, 'the round trip never shrinks: it contains the original face')
  assert.deepEqual(sourceRectCanvasSegments(model, face, 'another-source', { startFrame: 0, endFrame: 30 }), [])
})

test('a static crop uses the even-aligned pixel window of the crop filter', () => {
  const crop = { x: 0.3, y: 0.1, width: 0.4, height: 0.8 }
  const model = projection(LANDSCAPE, [clip({ crop })])
  // crop = x 384, y 72, w 512, h 576 (even-aligned): the visible picture is a 512x576 window, 4:4.5, fitted to 1280x720 staging
  const foreground = clipForegroundOnCanvas(model, 'clip-1', 0)
  const staged = 512 * Math.min(1280 / 512, 720 / 576)
  near(foreground.width * 960, staged * (960 / 1280), 1e-6, 'visible window width on the canvas')
  const outside = canvasBandSourceAreas(model, { x: 0, y: 0, width: 0.1, height: 0.1 }, { startFrame: 0, endFrame: 10 })
  assert.equal(outside[0].kind, 'outside-foreground', 'the pad bars at the left of the staged crop show no source pixel')
})

/** Evaluates the FFmpeg expression subset `buildReframeCropFilter` emits (if/lt/min/max/floor, + - * /). */
function evaluateFilterAxis(expression, n) {
  const program = expression.replace(/\bif\(/g, 'iff(')
  return new Function('n', 'iff', 'lt', 'min', 'max', 'floor', `return (${program})`)(
    n, (condition, a, b) => (condition ? a : b), (a, b) => (a < b ? 1 : 0), Math.min, Math.max, Math.floor)
}

test('the reframe crop window reproduces, frame by frame, the expression the filtergraph hands to FFmpeg', () => {
  const plan = createRenderReframePlan({
    format: '9:16', variantId: '9:16', fps: 30, durationFrames: 300, source: { width: 1280, height: 720 },
    ranges: [{
      clipId: 'clip-1', startFrame: 0, endFrame: 300, interpolation: 'linear',
      keyframes: [
        { frame: 0, crop: { x: 0.1, y: 0, width: 0.31640625, height: 1 } },
        { frame: 100, crop: { x: 0.5, y: 0, width: 0.31640625, height: 1 } },
        { frame: 220, crop: { x: 0.22, y: 0, width: 0.31640625, height: 1 } },
      ],
    }],
  })
  const range = plan.ranges[0]
  const filter = buildReframeCropFilter({ range, source: { width: 1280, height: 720 } })
  const parsed = /^crop=(\d+):(\d+):'(.+)':'(.+)',$/.exec(filter)
  assert.ok(parsed, filter)
  const model = projection(PORTRAIT, [clip({ reframe: range })])
  // The picture of the clip on the canvas follows the crop: the window's left edge in source px is what the filter computes.
  // W66r: a reframed clip FILLS the canvas (cover fit), so what changed here is where the crop lands, not which window it is. Before the
  // fix the picture was a 170x304 strip centred in a 16:9 band; the assertions that pinned that strip (the visible width of the staged crop,
  // and the source band at the crop's left edge sitting at the strip's left edge) now pin the fill: the picture is the whole canvas, and
  // the source band at the crop's left edge sits at the canvas's left edge.
  for (const frame of [0, 1, 37, 99, 100, 101, 160, 219, 220, 299]) {
    const expectedX = evaluateFilterAxis(parsed[3], frame)
    const picture = clipForegroundOnCanvas(model, 'clip-1', frame)
    near(picture.width * PORTRAIT.width, PORTRAIT.width, 1e-6, `the picture fills the canvas width at ${frame}`)
    near(picture.height * PORTRAIT.height, PORTRAIT.height, 1e-6, `the picture fills the canvas height at ${frame}`)
    // the left edge of the crop window is the left edge of the canvas (the 404x720 crop has the canvas's aspect to within a pixel)
    const probe = { x: expectedX / 1280, y: 0.4, width: 4 / 1280, height: 0.1 }
    const [segment] = sourceRectCanvasSegments(model, probe, 'source-1', { startFrame: frame, endFrame: frame + 1 })
    near(segment.bounds.x * PORTRAIT.width, 0, CANVAS_TOLERANCE_PX + 3 * SOURCE_TOLERANCE_PX, `left edge at ${frame}`)
  }
})

test('W66r a reframed clip is laid on the canvas by the cover rule; a clip that is not reframed keeps the staging band, in the same projection', () => {
  const plan = createRenderReframePlan({
    format: '9:16', variantId: '9:16', fps: 30, durationFrames: 200, source: { width: 1280, height: 720 },
    ranges: [
      { clipId: 'clip-1', startFrame: 0, endFrame: 100, interpolation: 'linear', keyframes: [{ frame: 0, crop: { x: 0.2, y: 0, width: 0.31640625, height: 1 } }] },
      { clipId: 'clip-2', startFrame: 100, endFrame: 200, interpolation: 'linear', keyframes: [{ frame: 100, crop: { x: 0.2, y: 0, width: 0.31640625, height: 1 } }] },
    ],
  })
  const mixed = projection(PORTRAIT, [clip({ timelineOutFrame: 100, reframe: plan.ranges[0] }), clip({ id: 'clip-2', timelineInFrame: 100, timelineOutFrame: 200 })])
  const reframed = clipForegroundOnCanvas(mixed, 'clip-1', 10)
  assert.deepEqual({ x: reframed.x, y: reframed.y, width: reframed.width, height: reframed.height }, { x: 0, y: 0, width: 1, height: 1 })
  // the second clip is the same source, not reframed: today's band, untouched by the first
  const banded = clipForegroundOnCanvas(mixed, 'clip-2', 110)
  near(banded.width, 1, 1e-9, 'band width'); near(banded.y * PORTRAIT.height, 328.125, 1e-6, 'band top'); near(banded.height * PORTRAIT.height, 303.75, 1e-6, 'band height')
  // a point of the source lands where the cover rule puts it: 404x720 -> 540x962.4 (width-limited), centred
  const scale = Math.max(540 / 404, 960 / 720)
  const [segment] = sourceRectCanvasSegments(mixed, { x: 0.35, y: 0.2, width: 0.02, height: 0.1 }, 'source-1', { startFrame: 10, endFrame: 11 })
  near(segment.bounds.x * 540, scale * (0.35 * 1280 - 256), CANVAS_TOLERANCE_PX + 3 * SOURCE_TOLERANCE_PX, 'x on the canvas')
  near(segment.bounds.y * 960, scale * (0.2 * 720) - (scale * 720 - 960) / 2, CANVAS_TOLERANCE_PX + 3 * SOURCE_TOLERANCE_PX, 'y on the canvas')
  // the geometry is part of the identity of a projection that has a reframed clip, and of no other
  const plain = projection(PORTRAIT, [clip({ timelineOutFrame: 100 }), clip({ id: 'clip-2', timelineInFrame: 100, timelineOutFrame: 200 })])
  assert.notEqual(plain.projectionHash, mixed.projectionHash)
  assert.equal(projection(PORTRAIT).projectionHash, projection(PORTRAIT, [clip()]).projectionHash)
})

test('a panning trajectory is bounded by the hull of its end positions: the area never misses a frame in between', () => {
  const plan = createRenderReframePlan({
    format: '9:16', variantId: '9:16', fps: 30, durationFrames: 120, source: { width: 1280, height: 720 },
    ranges: [{
      clipId: 'clip-1', startFrame: 0, endFrame: 120, interpolation: 'linear',
      keyframes: [{ frame: 0, crop: { x: 0.05, y: 0, width: 0.31640625, height: 1 } }, { frame: 60, crop: { x: 0.6, y: 0, width: 0.31640625, height: 1 } }],
    }],
  })
  const model = createCaptionProjection({ layout: { canvas: PORTRAIT }, sources: [SOURCE], clips: [clip({ timelineOutFrame: 120, reframe: plan.ranges[0] })] })
  const band = { x: 0.1, y: 0.45, width: 0.8, height: 0.1 }
  const segments = canvasBandSourceAreas(model, band, { startFrame: 0, endFrame: 120 })
  // keyframe 60 splits the range; both spans are judged on their own
  assert.deepEqual(segments.map((segment) => [segment.startFrame, segment.endFrame]), [[0, 60], [60, 120]])
  const moving = segments[0]
  assert.equal(moving.kind, 'source')
  for (const frame of [0, 7, 30, 59]) {
    const [piece] = canvasBandSourceAreas(model, band, { startFrame: frame, endFrame: frame + 1 })
    assert.equal(piece.kind, 'source')
    assert.ok(moving.area.x <= piece.area.x + 1e-9 && moving.area.x + moving.area.width >= piece.area.x + piece.area.width - 1e-9,
      `the hull covers the single-frame area at ${frame}`)
  }
})
