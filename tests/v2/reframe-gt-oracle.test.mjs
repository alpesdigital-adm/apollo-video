import assert from 'node:assert/strict'
import test from 'node:test'

import { collectFaceSourceEvidenceStream } from '../../src/v2/domain/face-source-evidence-stream.ts'
import { REFRAME_POLICY } from '../../src/v2/domain/reframe-policy.ts'
import { createRenderReframePlan } from '../../src/v2/domain/render-reframe-plan.ts'
import { sealedSourceWindow, sourceExpectation } from './helpers/face-source-envelope-v3.mjs'
import {
  analyzeFrame, coverExpectation, drawSourceFrame, FPS, H, judgeScene, makeBaseFrame, MARKER_CENTERS, matchFiducials, oracleWindow, SCENES,
  sceneDurationFrames, sourceFrameOf, standInDetectorRows, TOLERANCE, W,
} from './helpers/reframe-gt-oracle.mjs'
import { buildRecord, clipFacts, SPECS } from './helpers/reframe-trajectory-fixtures.mjs'

/**
 * The GT machinery of the rendered-frame proof is arithmetic, and arithmetic is checked here without a render: a SOFTWARE renderer lays a
 * drawn source frame on a canvas in one of two layouts, and the measurement code, which is told nothing about the layout, must report what
 * it sees. The two layouts are the specification (a reframed range FILLS the canvas) and the layout the composition produced before W66r
 * fixed it (the crop as a strip in a 16:9 band over a blurred backdrop): the oracle must pass the first and fail the second.
 */
const CANVAS = Object.freeze({ width: 540, height: 960 })

/** The specification: the crop window fills the canvas (cover fit, centred). */
function renderFilled(source, window, canvas) {
  const cover = coverExpectation(window, canvas)
  const out = Buffer.alloc(canvas.width * canvas.height * 3)
  for (let oy = 0; oy < canvas.height; oy += 1) {
    const sy = Math.min(H - 1, Math.max(0, Math.floor((oy + 0.5 - cover.offsetY) / cover.scale)))
    for (let ox = 0; ox < canvas.width; ox += 1) {
      const sx = Math.min(W - 1, Math.max(0, Math.floor(cover.visibleLeft + (ox + 0.5) / cover.scale)))
      const from = (sy * W + sx) * 3, to = (oy * canvas.width + ox) * 3
      out[to] = source[from]; out[to + 1] = source[from + 1]; out[to + 2] = source[from + 2]
    }
  }
  return out
}

/**
 * The layout the composition produced for every clip before the fix: the crop fitted into the 16:9 staging frame (black pad), the stage
 * fitted into the canvas, and a backdrop that is NOT black and carries decoys (a red block, white columns) like the blurred copy FFmpeg lays
 * behind it. Also today's layout of an UNREFRAMED clip (the whole source frame in the band).
 */
function renderBanded(source, window, canvas) {
  const toStaging = Math.min(W / window.width, H / H)
  const stagePadX = (W - window.width * toStaging) / 2
  const toCanvas = Math.min(canvas.width / W, canvas.height / H)
  const foregroundWidth = W * toCanvas, foregroundHeight = H * toCanvas
  const originX = (canvas.width - foregroundWidth) / 2, originY = (canvas.height - foregroundHeight) / 2
  const scale = toStaging * toCanvas, padX = originX + stagePadX * toCanvas
  const out = Buffer.alloc(canvas.width * canvas.height * 3)
  out.fill(Buffer.from([90, 90, 90]))
  // The backdrop is a BLURRED copy of the picture: smooth, so no hard edge and no near-white stripe. Its decoys are a soft red blob (as red as the
  // blurred subject gets, ~(190, 36, 36) at its centre) and a soft brighter column.
  for (let y = 0; y < 200; y += 1) {
    for (let x = 0; x < 360; x += 1) {
      const weight = Math.max(0, 1 - Math.hypot(x - 120, y - 90) / 90)
      if (weight <= 0) continue
      const at = (y * canvas.width + x) * 3
      out[at] = Math.round(90 + 100 * weight); out[at + 1] = Math.round(90 - 54 * weight); out[at + 2] = Math.round(90 - 54 * weight)
    }
  }
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 270; x < 330; x += 1) {
      const level = Math.round(90 + 40 * Math.max(0, 1 - Math.abs(x - 300) / 30))
      const at = (y * canvas.width + x) * 3
      if (out[at] === 90 && out[at + 1] === 90) { out[at] = level; out[at + 1] = level; out[at + 2] = level }
    }
  }
  const bandTop = Math.round(originY), bandBottom = Math.round(originY + foregroundHeight)
  for (let y = bandTop; y < bandBottom; y += 1) out.fill(0, y * canvas.width * 3, (y + 1) * canvas.width * 3)
  const left = Math.round(padX), right = Math.round(padX + window.width * scale), top = Math.round(originY), bottom = Math.round(originY + H * scale)
  for (let oy = top; oy < bottom; oy += 1) {
    const sy = Math.min(H - 1, Math.floor((oy - originY) / scale))
    for (let ox = left; ox < right; ox += 1) {
      const sx = Math.min(W - 1, Math.max(0, Math.floor(window.x0 + (ox - padX) / scale)))
      const from = (sy * W + sx) * 3, to = (oy * canvas.width + ox) * 3
      out[to] = source[from]; out[to + 1] = source[from + 1]; out[to + 2] = source[from + 2]
    }
  }
  return out
}

const base = makeBaseFrame()
const frameBuffer = Buffer.alloc(W * H * 3)

test('W66r GT the fiducials name themselves: the pattern of a few stripes says which they are, and an alignment that is not clear is refused', () => {
  assert.ok(MARKER_CENTERS.at(-1) + 4 <= W)
  assert.ok(MARKER_CENTERS.slice(1).every((center, index) => center - MARKER_CENTERS[index] >= 30), 'stripes stay apart at the smallest scale')
  // four stripes seen at an unknown scale and offset are matched to the stripes they are
  const seen = MARKER_CENTERS.slice(7, 12).map((center) => 1.337 * center - 211.5)
  const matched = matchFiducials(seen)
  assert.equal(matched.firstMarker, 7)
  assert.ok(Math.abs(matched.scale - 1.337) < 1e-6 && Math.abs(matched.offset + 211.5) < 1e-6 && matched.residualRms < 1e-6)
  // three are not enough, and a run that is not the stripes of this source is not matched
  assert.equal(matchFiducials(seen.slice(0, 3)), null)
  assert.equal(matchFiducials([10, 50, 90, 130, 170]), null, 'evenly spaced stripes name nothing')
  // a stripe at the wrong place spoils the alignment instead of being absorbed
  const spoiled = [...seen]
  spoiled[2] += 9
  assert.equal(matchFiducials(spoiled), null)
})

test('W66r GT the measurement reports a filled canvas as filled: coverage, scale, window and the subject in OUTPUT coordinates', () => {
  const scene = SCENES['one-person']
  drawSourceFrame(frameBuffer, base, scene.subjectsAtSource(40))
  const window = { x0: 100, width: 404 }
  const analysis = analyzeFrame(renderFilled(frameBuffer, window, CANVAS), CANVAS.width, CANVAS.height)
  assert.ok(analysis.coverage.width >= TOLERANCE.coverage && analysis.coverage.height >= TOLERANCE.coverage, JSON.stringify(analysis.coverage))
  assert.deepEqual(analysis.footprint, { x0: 0, x1: CANVAS.width - 1, y0: 0, y1: CANVAS.height - 1 })
  const cover = coverExpectation(window, CANVAS)
  assert.ok(Math.abs(analysis.fit.scale - cover.scale) / cover.scale < 0.01, JSON.stringify(analysis.fit))
  assert.ok(analysis.fit.markers >= 5 && analysis.fit.residualRms < 0.7, JSON.stringify(analysis.fit))
  assert.ok(Math.abs(analysis.window.left - 100) <= 2 && Math.abs(analysis.window.right - 504) <= 2, JSON.stringify(analysis.window))
  const box = scene.subjectsAtSource(40)[0].box
  const seen = analysis.subjects.A
  assert.ok(Math.abs(seen.x0 - box[0] * W) <= 3.5 && Math.abs(seen.x1 - box[2] * W) <= 3.5 && Math.abs(seen.y0 - box[1] * H) <= 3.5 && Math.abs(seen.y1 - box[3] * H) <= 3.5, JSON.stringify(seen))
  // the subject on the canvas is where the specification puts it
  const expected = { x0: cover.scale * (box[0] * W - cover.visibleLeft), y0: cover.scale * box[1] * H + cover.offsetY }
  assert.ok(Math.abs(seen.canvas.x0 - expected.x0) <= 2 && Math.abs(seen.canvas.y0 - expected.y0) <= 2, JSON.stringify([seen.canvas, expected]))
  assert.equal(analysis.subjects.B, null)
  assert.equal(analyzeFrame(Buffer.alloc(CANVAS.width * CANVAS.height * 3), CANVAS.width, CANVAS.height).footprint, null, 'an empty frame is not a measurement')
})

test('W66r GT the measurement reports what it sees without knowing the layout: the old banded layout is a strip, not a filled canvas, and its backdrop decoys are not subjects', () => {
  const scene = SCENES['one-person']
  drawSourceFrame(frameBuffer, base, scene.subjectsAtSource(40))
  const analysis = analyzeFrame(renderBanded(frameBuffer, { x0: 100, width: 404 }, CANVAS), CANVAS.width, CANVAS.height)
  // 404 of 1280 source columns, shown at 0.42 on a 540x960 canvas: ~170 px wide in a 304 px band
  assert.ok(analysis.coverage.width > 0.28 && analysis.coverage.width < 0.35, JSON.stringify(analysis.coverage))
  assert.ok(analysis.coverage.height > 0.29 && analysis.coverage.height < 0.35, JSON.stringify(analysis.coverage))
  assert.ok(analysis.coverage.width < TOLERANCE.coverage && analysis.coverage.height < TOLERANCE.coverage)
  assert.equal(analysis.subjects.B, null)
  assert.ok(analysis.subjects.A, 'the subject is in the strip')
  assert.ok(Math.abs(analysis.window.left - 100) <= 4 && Math.abs(analysis.window.right - 504) <= 4, JSON.stringify(analysis.window))
  // today's layout of an UNREFRAMED clip: the whole source frame in the band
  const whole = analyzeFrame(renderBanded(frameBuffer, { x0: 0, width: W }, CANVAS), CANVAS.width, CANVAS.height)
  assert.ok(whole.coverage.width >= TOLERANCE.coverage && whole.coverage.height < 0.4, JSON.stringify(whole.coverage))
  assert.ok(Math.abs(whole.window.left) <= 3 && Math.abs(whole.window.right - W) <= 3, JSON.stringify(whole.window))
})

test('W66r GT the stand-in detector rows are the generator boxes: faces only, nothing for a screen', () => {
  assert.deepEqual(standInDetectorRows(SCENES['two-people-far-apart'], 0).map((row) => row.slice(1)), [[0.05, 0.2, 0.15000000000000002, 0.5], [0.85, 0.2, 0.95, 0.5]])
  assert.deepEqual(standInDetectorRows(SCENES['screen-only'], 10), [])
  assert.equal(sourceFrameOf(SCENES['cut-between-clips'], 80), 105)
  assert.equal(sceneDurationFrames(SCENES['cut-between-clips']), 150)
  assert.throws(() => sourceFrameOf(SCENES['cut-between-clips'], 150))
})

function planFor(name, spec = SPECS.vertical) {
  const scene = SCENES[name]
  const envelope = sealedSourceWindow({
    id: `gt-stand-in-${name}`, start: 0, end: scene.sourceFrames,
    rowsAt: (frame) => standInDetectorRows(scene, frame),
  })
  const stream = collectFaceSourceEvidenceStream([envelope], sourceExpectation({ sourceDurationFrames: scene.sourceFrames }))
  return buildRecord({
    spec, stream, durationFrames: sceneDurationFrames(scene),
    clips: scene.clips.map((clip) => clipFacts({ ...clip })),
  })
}

/** Lays every timeline frame of a scene on a canvas through `layoutOf(window, range source)` and measures the pixels. */
function measure(scene, renderPlan, layoutOf, windowAt = (t) => oracleWindow(renderPlan, t), canvas = CANVAS) {
  const analyses = []
  for (let t = 0; t < sceneDurationFrames(scene); t += 1) {
    drawSourceFrame(frameBuffer, base, scene.subjectsAtSource(sourceFrameOf(scene, t)))
    const window = windowAt(t)
    analyses.push(analyzeFrame(layoutOf(window.rangeSource)(frameBuffer, window, canvas), canvas.width, canvas.height))
  }
  return analyses
}
/** What a correct render lays out: a reframed range fills the canvas, an unreframed one shows the whole frame in its band (today's behaviour). */
const specification = (rangeSource) => (rangeSource === 'fallback' ? renderBanded : renderFilled)
const oldComposition = () => renderBanded
const judge = (scene, analyses, record, canvas = CANVAS, renderPlan = record.renderPlan) =>
  judgeScene({ scene, analyses, renderPlan, issues: record.issues, policy: REFRAME_POLICY, canvas })

test('W66r GT a render that follows the specification keeps the subject inside the crop with its margin on every frame, across a cut, and fills the canvas', () => {
  for (const name of ['moving-subject', 'cut-between-clips']) {
    const scene = SCENES[name]
    const record = planFor(name)
    assert.equal(record.disposition, 'ready', name)
    const verdict = judge(scene, measure(scene, record.renderPlan, specification), record)
    assert.equal(verdict.frames, sceneDurationFrames(scene))
    assert.equal(verdict.unflaggedFailingFrames, 0, `${name} ${JSON.stringify(verdict.firstUnflaggedFailure)} ${JSON.stringify(verdict.reasonCounts)}`)
    assert.ok(verdict.allSubjectsVisibleEveryFrame)
    assert.equal(verdict.reframedFrames, verdict.frames)
    assert.ok(verdict.minCoverage.width >= TOLERANCE.coverage && verdict.minCoverage.height >= TOLERANCE.coverage, JSON.stringify(verdict.minCoverage))
    assert.ok(verdict.maxWindowError <= 3 && verdict.maxSubjectPositionError <= 6 && verdict.maxSubjectOutputError <= TOLERANCE.outputPosition, `${verdict.maxWindowError} ${verdict.maxSubjectPositionError} ${verdict.maxSubjectOutputError}`)
    assert.ok(verdict.minMarginSlackPx >= -3)
    assert.ok(verdict.dynamics.maxSpeed <= REFRAME_POLICY.tracking.maxVelocityPerSecond + 0.01, `${verdict.dynamics.maxSpeed}`)
    assert.ok(verdict.dynamics.maxAcceleration <= REFRAME_POLICY.tracking.maxAccelerationPerSecondSquared + 0.04, `${verdict.dynamics.maxAcceleration}`)
    if (name === 'cut-between-clips') {
      // the window JUMPS at the cut: it is not interpolated across it, and the subject is in both
      const before = oracleWindow(record.renderPlan, 74), after = oracleWindow(record.renderPlan, 75)
      assert.ok(after.x0 - before.x0 > 400, `${before.x0} -> ${after.x0}`)
      assert.equal(record.renderPlan.ranges.length, 2)
    }
  }
})

test('W66r GT the oracle is not adapted to a layout: the composition as it was before the fix FAILS it on every reframed frame, for the right reasons', () => {
  const scene = SCENES['moving-subject']
  const record = planFor('moving-subject')
  const verdict = judge(scene, measure(scene, record.renderPlan, oldComposition), record)
  // the crop IS shown and the subject IS inside it: the picture is just a strip, and the oracle says that
  assert.equal(verdict.unflaggedFailingFrames, 150, JSON.stringify(verdict.reasonCounts))
  assert.equal(verdict.reasonCounts['foreground-does-not-fill-canvas'], 150)
  assert.equal(verdict.reasonCounts['scale-differs-from-cover'], 150)
  assert.ok(verdict.reasonCounts['subject-A-output-position'] > 100, JSON.stringify(verdict.reasonCounts))
  assert.ok(verdict.minCoverage.width < 0.4 && verdict.minCoverage.height < 0.4, JSON.stringify(verdict.minCoverage))
  assert.equal(verdict.allSubjectsVisibleEveryFrame, true, 'the strip still shows the subject: only the fill fails')
  // structural reasons are never excused by an issue of the plan
  const excused = judgeScene({ scene, analyses: measure(scene, record.renderPlan, oldComposition), renderPlan: record.renderPlan,
    issues: [{ startFrame: 0, endFrame: 150 }], policy: REFRAME_POLICY, canvas: CANVAS })
  assert.equal(excused.unflaggedFailingFrames, 150)
})

test('W66r GT the judge fails a render that does not follow the plan or does not keep the subject: it is not vacuous', () => {
  const name = 'moving-subject'
  const scene = SCENES[name]
  const record = planFor(name)
  // (1) the pixels show a static centre window while the RenderInput says the crop tracks the subject
  const centre = { x0: 438, width: 404, rangeSource: 'plan' }
  const stuck = judge(scene, measure(scene, record.renderPlan, () => renderFilled, () => centre), record)
  assert.ok(stuck.unflaggedFailingFrames > 60, `${stuck.unflaggedFailingFrames}`)
  assert.ok(stuck.reasonCounts['window-differs-from-render-input'] > 0)
  assert.ok(stuck.reasonCounts['subject-A-outside-crop-margin'] > 0 || stuck.reasonCounts['subject-A-not-visible'] > 0)
  // (2) a plan that is faithfully rendered but never moves loses the subject: the checker finds it from the pixels, not from the plan
  const staticPlan = createRenderReframePlan({
    format: '9:16', variantId: SPECS.vertical.variantId, fps: FPS, durationFrames: 150, source: { width: W, height: H },
    ranges: [{ clipId: 'clip-1', startFrame: 0, endFrame: 150, interpolation: 'linear', keyframes: [{ frame: 0, crop: { x: 0.34, y: 0, width: 0.31640625, height: 1 } }] }],
  })
  const lost = judge(scene, measure(scene, staticPlan, specification), { issues: [] }, CANVAS, staticPlan)
  assert.equal(lost.maxWindowError <= 3, true, 'it is the plan that was rendered')
  assert.ok(lost.unflaggedFailingFrames > 30, `${lost.unflaggedFailingFrames}`)
  // (3) a trajectory that jumps 0.4 of the frame in five frames is over the velocity limit when measured on the pixels. The pixel measure is
  // an average over 15 frames (a 2 px quantization step must not be read as motion), so it sees 0.4 per 0.5 s: at least twice the limit.
  const jumping = createRenderReframePlan({
    format: '9:16', variantId: SPECS.vertical.variantId, fps: FPS, durationFrames: 150, source: { width: W, height: H },
    ranges: [{ clipId: 'clip-1', startFrame: 0, endFrame: 150, interpolation: 'linear', keyframes: [
      { frame: 0, crop: { x: 0.02, y: 0, width: 0.31640625, height: 1 } }, { frame: 50, crop: { x: 0.02, y: 0, width: 0.31640625, height: 1 } },
      { frame: 55, crop: { x: 0.42, y: 0, width: 0.31640625, height: 1 } }, { frame: 149, crop: { x: 0.42, y: 0, width: 0.31640625, height: 1 } }] }],
  })
  const fast = judge(scene, measure(scene, jumping, specification), { issues: [] }, CANVAS, jumping)
  assert.ok(fast.dynamics.maxSpeed > REFRAME_POLICY.tracking.maxVelocityPerSecond * 2, `${fast.dynamics.maxSpeed}`)
})

test('W66r GT blocked and reviewable scenes: every frame the crop cannot keep is inside a localized issue, and the fallback shows every subject', () => {
  const two = planFor('two-people-far-apart')
  assert.deepEqual([two.disposition, two.issues.map((issue) => [issue.code, issue.startFrame, issue.endFrame])], ['blocked', [['SUBJECTS_DO_NOT_FIT', 0, 150]]])
  const twoScene = SCENES['two-people-far-apart']
  const twoVerdict = judge(twoScene, measure(twoScene, two.renderPlan, specification), two)
  assert.equal(twoVerdict.allSubjectsVisibleEveryFrame, true, 'both people are in the contained frame')
  assert.equal(twoVerdict.failingFrames, 0)
  assert.equal(twoVerdict.reframedFrames, 0, 'an unreframed range is not held to the fill')
  const screen = planFor('screen-only')
  assert.deepEqual([screen.disposition, screen.issues.map((issue) => issue.code)], ['review-required', ['NO_SUBJECT_OBSERVATION']])
  const screenScene = SCENES['screen-only']
  const screenVerdict = judge(screenScene, measure(screenScene, screen.renderPlan, specification), screen)
  assert.equal(screenVerdict.allSubjectsVisibleEveryFrame, true, 'the screen is whole on the canvas')
  const fast = planFor('subject-too-fast')
  assert.equal(fast.disposition, 'blocked')
  assert.ok(fast.issues.some((issue) => issue.code === 'TRACKING_LIMIT_EXCEEDED' && issue.severity === 'hard'))
  const fastScene = SCENES['subject-too-fast']
  const fastVerdict = judge(fastScene, measure(fastScene, fast.renderPlan, specification), fast)
  assert.equal(fastVerdict.unflaggedFailingFrames, 0, 'whatever the crop cannot keep is inside a reported issue')
  assert.ok(fastVerdict.failingFrames > 0, 'the crop really loses the subject here')
})

test('W66r GT the 16:9 variant of the same evidence is its own plan: the whole frame fills its canvas', () => {
  const vertical = planFor('one-person'), wide = planFor('one-person', SPECS.wide)
  assert.notEqual(vertical.renderPlan.reframePlanHash, wide.renderPlan.reframePlanHash)
  assert.deepEqual(oracleWindow(wide.renderPlan, 40), { x0: 0, width: W, rangeSource: 'plan' })
  assert.equal(oracleWindow(vertical.renderPlan, 40).width, 404)
  const canvas = { width: 960, height: 540 }
  const scene = SCENES['one-person']
  const verdict = judge(scene, measure(scene, wide.renderPlan, specification, undefined, canvas), wide, canvas)
  assert.equal(verdict.unflaggedFailingFrames, 0, JSON.stringify(verdict.reasonCounts))
  assert.ok(verdict.minCoverage.width >= TOLERANCE.coverage && verdict.minCoverage.height >= TOLERANCE.coverage)
})
