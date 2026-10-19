import assert from 'node:assert/strict'
import test from 'node:test'

import { collectFaceSourceEvidenceStream } from '../../src/v2/domain/face-source-evidence-stream.ts'
import { REFRAME_POLICY } from '../../src/v2/domain/reframe-policy.ts'
import { createRenderReframePlan } from '../../src/v2/domain/render-reframe-plan.ts'
import { sealedSourceWindow, sourceExpectation } from './helpers/face-source-envelope-v3.mjs'
import {
  analyzeFrame, drawSourceFrame, foregroundMapping, FPS, H, judgeScene, makeBaseFrame, oracleWindow, SCENES, sceneDurationFrames, sourceFrameOf,
  standInDetectorRows, W,
} from './helpers/reframe-gt-oracle.mjs'
import { buildRecord, clipFacts, SPECS } from './helpers/reframe-trajectory-fixtures.mjs'

/**
 * The GT machinery of the rendered-frame proof is arithmetic, and arithmetic is checked here without a render: a SOFTWARE renderer maps a drawn
 * source frame through a known window, and the measurement code must recover that window and the subjects from the pixels alone.
 */
const CANVAS = Object.freeze({ width: 540, height: 960 })

/**
 * Nearest-neighbour software render of the composition: the crop window fitted into the 16:9 staging frame (black pad), the stage fitted into
 * the canvas, and a backdrop that is NOT black and carries decoys (a red block, white columns) like the blurred copy FFmpeg lays behind it.
 */
function softwareRender(source, window, canvas) {
  const mapping = foregroundMapping(window, canvas)
  const out = Buffer.alloc(canvas.width * canvas.height * 3)
  out.fill(Buffer.from([90, 90, 90]))
  for (let y = 40; y < 140; y += 1) out.fill(Buffer.from([230, 30, 30]), (y * canvas.width + 40) * 3, (y * canvas.width + 200) * 3)
  for (let y = 0; y < canvas.height; y += 1) out.fill(255, (y * canvas.width + 300) * 3, (y * canvas.width + 306) * 3)
  const bandTop = Math.round(mapping.band.top), bandBottom = Math.round(mapping.band.bottom)
  for (let y = bandTop; y < bandBottom; y += 1) out.fill(0, y * canvas.width * 3, (y + 1) * canvas.width * 3)
  const left = Math.round(mapping.padX), right = Math.round(mapping.padX + window.width * mapping.scale)
  const top = Math.round(mapping.padY), bottom = Math.round(mapping.padY + H * mapping.scale)
  for (let oy = top; oy < bottom; oy += 1) {
    const sy = Math.min(H - 1, Math.floor((oy - mapping.padY) / mapping.scale))
    for (let ox = left; ox < right; ox += 1) {
      const sx = Math.min(W - 1, Math.max(0, Math.floor(window.x0 + (ox - mapping.padX) / mapping.scale)))
      const from = (sy * W + sx) * 3, to = (oy * canvas.width + ox) * 3
      out[to] = source[from]; out[to + 1] = source[from + 1]; out[to + 2] = source[from + 2]
    }
  }
  return out
}

const base = makeBaseFrame()
const frameBuffer = Buffer.alloc(W * H * 3)

test('W66r GT the measurement recovers the visible window and the subject of a pixel frame without being told them', () => {
  const scene = SCENES['one-person']
  drawSourceFrame(frameBuffer, base, scene.subjectsAtSource(40))
  const window = { x0: 100, width: 404 }
  const rendered = softwareRender(frameBuffer, window, CANVAS)
  const hint = { window, mapping: foregroundMapping(window, CANVAS) }
  const analysis = analyzeFrame(rendered, CANVAS.width, CANVAS.height, hint)
  assert.ok(Math.abs(analysis.window.left - 100) <= 1.5 && Math.abs(analysis.window.right - 504) <= 1.5, JSON.stringify(analysis.window))
  assert.ok(analysis.fit.markers >= 5 && analysis.fit.residualRms < 0.7, JSON.stringify(analysis.fit))
  // the footprint the composition fixes (a strip inside the 16:9 band of the vertical canvas) agrees with the window the fit gives
  assert.ok(Math.abs(analysis.footprint.left - analysis.window.left) <= 3.5 && Math.abs(analysis.footprint.right - analysis.window.right) <= 3.5, JSON.stringify([analysis.footprint, analysis.window]))
  const box = scene.subjectsAtSource(40)[0].box
  const seen = analysis.subjects.A
  assert.ok(Math.abs(seen.x0 - box[0] * W) <= 3.5 && Math.abs(seen.x1 - box[2] * W) <= 3.5 && Math.abs(seen.y0 - box[1] * H) <= 3.5 && Math.abs(seen.y1 - box[3] * H) <= 3.5, JSON.stringify(seen))
  assert.equal(analysis.subjects.B, null, 'the decoys of the backdrop are not subjects')
  // The hint only says which fiducial is which: a prediction that is 15 px wrong yields the same measurement, not the prediction.
  const skewed = analyzeFrame(rendered, CANVAS.width, CANVAS.height, { window: { x0: 115, width: 404 }, mapping: hint.mapping })
  assert.ok(Math.abs(skewed.window.left - analysis.window.left) < 1e-6 && Math.abs(skewed.window.left - 115) > 10)
  // A whole frame on the portrait canvas (the fallback) fills the 16:9 band and shows every fiducial.
  const whole = { x0: 0, width: W }
  const contained = analyzeFrame(softwareRender(frameBuffer, whole, CANVAS), CANVAS.width, CANVAS.height, { window: whole, mapping: foregroundMapping(whole, CANVAS) })
  assert.ok(Math.abs(contained.window.left) <= 2 && Math.abs(contained.window.right - W) <= 2, JSON.stringify(contained.window))
  assert.equal(contained.fit.markers, 26)
  // A frame with nothing in it is not a measurement.
  assert.equal(analyzeFrame(Buffer.alloc(CANVAS.width * CANVAS.height * 3), CANVAS.width, CANVAS.height, hint).window, null)
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

/** Renders every timeline frame of a scene through `windowAt` and measures the pixels. */
function measure(scene, windowAt, canvas = CANVAS) {
  const analyses = []
  for (let t = 0; t < sceneDurationFrames(scene); t += 1) {
    drawSourceFrame(frameBuffer, base, scene.subjectsAtSource(sourceFrameOf(scene, t)))
    const window = windowAt(t)
    analyses.push(analyzeFrame(softwareRender(frameBuffer, window, canvas), canvas.width, canvas.height, { window: oracleHint(window), mapping: foregroundMapping(window, canvas) }))
  }
  return analyses
}
const oracleHint = (window) => ({ x0: window.x0, width: window.width })

test('W66r GT a software render of the planned windows keeps the subject inside the crop with its margin on every frame, across a cut', () => {
  for (const name of ['moving-subject', 'cut-between-clips']) {
    const scene = SCENES[name]
    const record = planFor(name)
    assert.equal(record.disposition, 'ready', name)
    const analyses = measure(scene, (t) => oracleWindow(record.renderPlan, t))
    const verdict = judgeScene({ scene, analyses, renderPlan: record.renderPlan, issues: record.issues, policy: REFRAME_POLICY, canvas: CANVAS })
    assert.equal(verdict.frames, sceneDurationFrames(scene))
    assert.equal(verdict.unflaggedFailingFrames, 0, `${name} ${JSON.stringify(verdict.firstUnflaggedFailure)} ${JSON.stringify(verdict.reasonCounts)}`)
    assert.ok(verdict.allSubjectsVisibleEveryFrame)
    assert.ok(verdict.maxWindowError <= 3 && verdict.maxSubjectPositionError <= 6, `${verdict.maxWindowError} ${verdict.maxSubjectPositionError}`)
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

test('W66r GT the judge fails a render that does not follow the plan or does not keep the subject: it is not vacuous', () => {
  const name = 'moving-subject'
  const scene = SCENES[name]
  const record = planFor(name)
  // (1) the pixels show a static centre window while the RenderInput says the crop tracks the subject
  const centre = { x0: 438, width: 404 }
  const stuck = judgeScene({ scene, analyses: measure(scene, () => centre), renderPlan: record.renderPlan, issues: record.issues, policy: REFRAME_POLICY, canvas: CANVAS })
  assert.ok(stuck.unflaggedFailingFrames > 60, `${stuck.unflaggedFailingFrames}`)
  assert.ok(stuck.reasonCounts['window-differs-from-render-input'] > 0)
  assert.ok(stuck.reasonCounts['subject-A-outside-crop-margin'] > 0 || stuck.reasonCounts['subject-A-not-visible'] > 0)
  // (2) a plan that is faithfully rendered but never moves loses the subject: the checker finds it from the pixels, not from the plan
  const staticPlan = createRenderReframePlan({
    format: '9:16', variantId: SPECS.vertical.variantId, fps: FPS, durationFrames: 150, source: { width: W, height: H },
    ranges: [{ clipId: 'clip-1', startFrame: 0, endFrame: 150, interpolation: 'linear', keyframes: [{ frame: 0, crop: { x: 0.34, y: 0, width: 0.31640625, height: 1 } }] }],
  })
  const lost = judgeScene({ scene, analyses: measure(scene, (t) => oracleWindow(staticPlan, t)), renderPlan: staticPlan, issues: [], policy: REFRAME_POLICY, canvas: CANVAS })
  assert.equal(lost.maxWindowError <= 3, true, 'it is the plan that was rendered')
  assert.ok(lost.unflaggedFailingFrames > 30, `${lost.unflaggedFailingFrames}`)
  // (3) a trajectory that jumps 0.4 of the frame in five frames is over the velocity limit when measured on the pixels. The pixel measure is an
  // average over 15 frames (a 2 px quantization step must not be read as motion), so it sees 0.4 per 0.5 s: at least twice the limit.
  const jumping = createRenderReframePlan({
    format: '9:16', variantId: SPECS.vertical.variantId, fps: FPS, durationFrames: 150, source: { width: W, height: H },
    ranges: [{ clipId: 'clip-1', startFrame: 0, endFrame: 150, interpolation: 'linear', keyframes: [
      { frame: 0, crop: { x: 0.02, y: 0, width: 0.31640625, height: 1 } }, { frame: 50, crop: { x: 0.02, y: 0, width: 0.31640625, height: 1 } },
      { frame: 55, crop: { x: 0.42, y: 0, width: 0.31640625, height: 1 } }, { frame: 149, crop: { x: 0.42, y: 0, width: 0.31640625, height: 1 } }] }],
  })
  const fast = judgeScene({ scene, analyses: measure(scene, (t) => oracleWindow(jumping, t)), renderPlan: jumping, issues: [], policy: REFRAME_POLICY, canvas: CANVAS })
  assert.ok(fast.dynamics.maxSpeed > REFRAME_POLICY.tracking.maxVelocityPerSecond * 2, `${fast.dynamics.maxSpeed}`)
})

test('W66r GT blocked and reviewable scenes: every frame the crop cannot keep is inside a localized issue, and the fallback shows every subject', () => {
  const two = planFor('two-people-far-apart')
  assert.deepEqual([two.disposition, two.issues.map((issue) => [issue.code, issue.startFrame, issue.endFrame])], ['blocked', [['SUBJECTS_DO_NOT_FIT', 0, 150]]])
  const twoScene = SCENES['two-people-far-apart']
  const twoVerdict = judgeScene({ scene: twoScene, analyses: measure(twoScene, (t) => oracleWindow(two.renderPlan, t)), renderPlan: two.renderPlan, issues: two.issues, policy: REFRAME_POLICY, canvas: CANVAS })
  assert.equal(twoVerdict.allSubjectsVisibleEveryFrame, true, 'both people are in the contained frame')
  assert.equal(twoVerdict.failingFrames, 0)
  const screen = planFor('screen-only')
  assert.deepEqual([screen.disposition, screen.issues.map((issue) => issue.code)], ['review-required', ['NO_SUBJECT_OBSERVATION']])
  const screenScene = SCENES['screen-only']
  const screenVerdict = judgeScene({ scene: screenScene, analyses: measure(screenScene, (t) => oracleWindow(screen.renderPlan, t)), renderPlan: screen.renderPlan, issues: screen.issues, policy: REFRAME_POLICY, canvas: CANVAS })
  assert.equal(screenVerdict.allSubjectsVisibleEveryFrame, true, 'the screen is whole on the canvas')
  const fast = planFor('subject-too-fast')
  assert.equal(fast.disposition, 'blocked')
  assert.ok(fast.issues.some((issue) => issue.code === 'TRACKING_LIMIT_EXCEEDED' && issue.severity === 'hard'))
  const fastScene = SCENES['subject-too-fast']
  const fastVerdict = judgeScene({ scene: fastScene, analyses: measure(fastScene, (t) => oracleWindow(fast.renderPlan, t)), renderPlan: fast.renderPlan, issues: fast.issues, policy: REFRAME_POLICY, canvas: CANVAS })
  assert.equal(fastVerdict.unflaggedFailingFrames, 0, 'whatever the crop cannot keep is inside a reported issue')
  // the same frames judged WITHOUT the issues would fail: the report is what makes them acceptable
  const unreported = judgeScene({ scene: fastScene, analyses: measure(fastScene, (t) => oracleWindow(fast.renderPlan, t)), renderPlan: fast.renderPlan, issues: [], policy: REFRAME_POLICY, canvas: CANVAS })
  assert.ok(unreported.unflaggedFailingFrames > 0 || fastVerdict.failingFrames === 0)
})

test('W66r GT the 16:9 variant of the same evidence is its own plan: the whole frame, not the vertical crop', () => {
  const vertical = planFor('one-person'), wide = planFor('one-person', SPECS.wide)
  assert.notEqual(vertical.renderPlan.reframePlanHash, wide.renderPlan.reframePlanHash)
  assert.deepEqual(oracleWindow(wide.renderPlan, 40), { x0: 0, width: W, rangeSource: 'plan' })
  assert.equal(oracleWindow(vertical.renderPlan, 40).width, 404)
})
