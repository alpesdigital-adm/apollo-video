import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import {
  boxOf, clipToCanvas, countPackedMaskInRect, iou, measureInk, measureSubject, packMask, pixelRectOf, projectSourceBox, rawLumaChangedPixels,
  registrationFacts, visibleFractionOf,
} from '../../src/v2/domain/mp4-pixel-geometry.ts'
import {
  createMp4QualityReport, evaluateMp4Sample, localizeMp4Issues, MP4_PIXEL_CRITIC_POLICY, MP4_PIXEL_CRITIC_POLICY_SHA256, mp4ReportMismatches,
  planMp4SampleFrames, safeAreaOvershootPixels, unsampledRanges, verifyMp4QualityReport,
} from '../../src/v2/domain/mp4-pixel-quality.ts'
import {
  decodeRetail0004Output, decodeV9Output, PIXEL_ORACLE_MODELS, pixelOracleModelPins, unionOracleReadings,
} from '../../src/v2/domain/pixel-face-oracle.ts'

const CANVAS = Object.freeze({ width: 540, height: 960 })
const SAFE = Object.freeze({ top: 0.08, right: 0.06, bottom: 0.06, left: 0.06 })
const sha = (character) => character.repeat(64)
const NO_INK = Object.freeze({ pixels: 0, bbox: null, touchesCanvasEdge: false })
const ink = (x0, y0, x1, y1, pixels = 5000, edge = false) => Object.freeze({ pixels, bbox: { x0, y0, x1, y1 }, touchesCanvasEdge: edge })
const PASSING_SUBJECT = Object.freeze({ state: 'measured', visibleFraction: 1, outputConfirmed: true, projected: { x0: 0.3, y0: 0.3, x1: 0.5, y1: 0.5 } })
const region = (overrides = {}) => ({ origin: 'oracle-0204-v9', box: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 }, captionInkPixels: 0, ctaInkPixels: 0, ...overrides })

function facts(frame, overrides = {}) {
  return {
    sampleId: `sample-${frame}`, frameIndex: frame, ptsTicks: frame * 512, frameSha256: sha('a'),
    caption: NO_INK, cta: NO_INK, inkDensity: 0, oracle: { state: 'observed', outputFaceCount: 1, sourceFaceCount: 1 }, registration: null,
    protectedRegions: [region()], subject: PASSING_SUBJECT, ...overrides,
  }
}
const evaluate = (f) => evaluateMp4Sample({ facts: f, canvas: CANVAS, safeArea: SAFE })

// ---- the oracle decoders ----------------------------------------------------------------------------------------------------
function tensor(rows) {
  const array = new Float32Array(200 * 7)
  for (let slot = 0; slot < 200; slot += 1) array.set(rows[slot] ?? [-1, 0, 0, 0, 0, 0, 0], slot * 7)
  return new Uint8Array(array.buffer)
}

test('retail-0004 decoder: label 1 at the 0.50 operating point; visible intersection; one invalid selected slot makes the frame unknown', () => {
  const reading = decodeRetail0004Output(tensor([[0, 1, 0.9, 0.1, 0.2, 0.4, 0.6], [0, 1, 0.49, 0.5, 0.5, 0.9, 0.9], [0, 1, 0.8, -0.1, 0.1, 0.3, 0.5]]))
  assert.equal(reading.status, 'observed')
  assert.equal(reading.boxes.length, 2, 'the 0.49 slot is below the floor')
  for (const [key, expected] of Object.entries({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 })) assert.ok(Math.abs(reading.boxes[0].box[key] - expected) < 1e-6, key)
  assert.equal(reading.boxes[1].clipped, true, 'the box that leaves the frame is replaced by its visible intersection')
  assert.equal(reading.boxes[1].box.x, 0)
  for (const [name, rows, reason] of [
    ['wrong label', [[0, 0, 0.9, 0.1, 0.1, 0.4, 0.4]], 'DETECTOR_LABEL_INVALID'],
    ['wrong image id', [[1, 1, 0.9, 0.1, 0.1, 0.4, 0.4]], 'DETECTOR_IMAGE_ID_INVALID'],
    ['reversed box', [[0, 1, 0.9, 0.5, 0.1, 0.4, 0.4]], 'DETECTOR_FACE_BOX_REVERSED_OR_ZERO_AREA'],
    ['box outside the frame', [[0, 1, 0.9, 1.2, 0.1, 1.5, 0.4]], 'DETECTOR_FACE_BOX_EMPTY_INTERSECTION'],
    ['score out of range', [[0, 1, 1.5, 0.1, 0.1, 0.4, 0.4]], 'DETECTOR_SCORE_INVALID'],
  ]) {
    const bad = decodeRetail0004Output(tensor(rows))
    assert.equal(bad.status, 'unknown', name)
    assert.equal(bad.reason, reason, name)
    assert.deepEqual(bad.boxes, [], `${name}: never an empty detection list that reads as "no face"`)
  }
  assert.equal(decodeRetail0004Output(new Uint8Array(10)).status, 'unknown')
  // below the floor a slot is ignored, whatever its label (the V7 evaluator validates selected slots only)
  assert.equal(decodeRetail0004Output(tensor([[0, 0, 0.3, 0.1, 0.1, 0.4, 0.4], [0, 1, 0.9, 0.2, 0.2, 0.3, 0.3]])).boxes.length, 1)
  // a padding slot (image id -1) in the middle does not end the walk
  assert.equal(decodeRetail0004Output(tensor([[-1, 0, 0, 0, 0, 0, 0], [0, 1, 0.7, 0.2, 0.2, 0.3, 0.3]])).boxes.length, 1)
})

test('V9 decoder at the oracle operating point keeps the policy: label 0, floor 0.50, intersection with the frame', () => {
  const reading = decodeV9Output(tensor([[0, 0, 0.95, 0.2, 0.2, 0.5, 0.6], [0, 0, 0.3, 0.1, 0.1, 0.2, 0.2]]))
  assert.equal(reading.status, 'observed')
  assert.equal(reading.boxes.length, 1)
  assert.equal(decodeV9Output(tensor([[0, 1, 0.95, 0.2, 0.2, 0.5, 0.6]])).status, 'unknown', 'a retail-labelled slot is not a V9 slot')
})

test('the union keeps every box of every model, never merges, and an unreadable frame is unknown rather than empty', () => {
  const v9 = decodeV9Output(tensor([[0, 0, 0.9, 0.2, 0.2, 0.5, 0.6]]))
  const retail = decodeRetail0004Output(tensor([[0, 1, 0.9, 0.21, 0.22, 0.52, 0.61]]))
  const both = unionOracleReadings([v9, retail])
  assert.equal(both.status, 'observed')
  assert.deepEqual(both.faces.map((face) => face.models[0]), [PIXEL_ORACLE_MODELS.v9.id, PIXEL_ORACLE_MODELS.retail.id])
  const onlyRetail = unionOracleReadings([decodeV9Output(new Uint8Array(3)), retail])
  assert.equal(onlyRetail.status, 'observed')
  assert.equal(onlyRetail.faces.length, 1, 'a model that failed contributes no box')
  const none = unionOracleReadings([decodeV9Output(new Uint8Array(3)), decodeRetail0004Output(new Uint8Array(3))])
  assert.equal(none.status, 'unknown')
  const pins = pixelOracleModelPins()
  assert.deepEqual(pins.map((pin) => pin.licence), ['Apache-2.0', 'Apache-2.0'])
  assert.ok(pins.every((pin) => pin.scoreFloor === 0.5 && /^[a-f0-9]{64}$/.test(pin.xmlSha256) && /^[a-f0-9]{64}$/.test(pin.binSha256)))
})

// ---- ink and geometry -------------------------------------------------------------------------------------------------------
function frame(width, height, fill) {
  const data = new Uint8Array(width * height * 3)
  data.fill(fill)
  return data
}
function paint(data, width, x0, y0, x1, y1, value) {
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) data.fill(value, (y * width + x) * 3, (y * width + x) * 3 + 3)
}

test('ink: a painted block above the luma threshold is ink, an isolated pixel and a faint block are not; extents are inclusive', () => {
  const width = 100, height = 80
  const control = frame(width, height, 100)
  const delivered = frame(width, height, 100)
  paint(delivered, width, 10, 20, 50, 30, 230)
  delivered.fill(230, (5 * width + 70) * 3, (5 * width + 70) * 3 + 3)
  const measured = measureInk(delivered, control, width, height)
  assert.equal(measured.facts.pixels, 400)
  assert.deepEqual(measured.facts.bbox, { x0: 10, y0: 20, x1: 49, y1: 29 })
  assert.equal(measured.facts.touchesCanvasEdge, false)
  assert.equal(countPackedMaskInRect(packMask(measured.mask), width, { x0: 0, y0: 0, x1: 30, y1: 25 }), 20 * 5)
  const faint = frame(width, height, 100)
  paint(faint, width, 10, 20, 50, 30, 100 + MP4_PIXEL_CRITIC_POLICY.ink.lumaThresholdLevels)
  assert.equal(measureInk(faint, control, width, height).facts.pixels, 0, 'a change of exactly the threshold is not ink')
  const edge = frame(width, height, 100)
  paint(edge, width, 0, 20, 30, 30, 230)
  assert.equal(measureInk(edge, control, width, height).facts.touchesCanvasEdge, true)
  const tiny = frame(width, height, 100)
  paint(tiny, width, 10, 10, 15, 15, 230)
  assert.equal(measureInk(tiny, control, width, height).facts.pixels, 0, 'fewer than the minimum surviving pixels: the overlay is absent')
  assert.equal(rawLumaChangedPixels(delivered, control, width, height, 40), 401)
})

test('safe area: inclusive bounds from the OutputSpec, overshoot in pixels', () => {
  const inside = { x0: 32, y0: 77, x1: 507, y1: 100 }
  assert.equal(safeAreaOvershootPixels(inside, CANVAS, SAFE), 0, 'ink exactly on the safe edge is inside (inclusive)')
  assert.equal(safeAreaOvershootPixels({ ...inside, x0: 31 }, CANVAS, SAFE) > 0, true)
  assert.equal(safeAreaOvershootPixels({ x0: 30, y0: 100, x1: 400, y1: 140 }, CANVAS, SAFE).toFixed(1), '1.9', 'a pixel is measured by its centre')
  assert.equal(safeAreaOvershootPixels({ x0: 0, y0: 100, x1: 539, y1: 140 }, CANVAS, SAFE).toFixed(1), '31.9', 'the overshoot is the largest of the four sides')
  assert.equal(safeAreaOvershootPixels({ x0: 40, y0: 0, x1: 400, y1: 20 }, CANVAS, SAFE).toFixed(1), '76.3')
})

test('verdicts: a clean frame passes; each defect has its own code; unknown is never pass', () => {
  const clean = evaluate(facts(10, { caption: ink(60, 800, 480, 840), inkDensity: 0.05 }))
  assert.deepEqual(Object.values(clean.checks).map((entry) => entry.verdict), ['pass', 'not-applicable', 'pass', 'pass', 'pass', 'pass'])
  const overFace = evaluate(facts(10, { caption: ink(60, 300, 480, 340), inkDensity: 0.05, protectedRegions: [region({ captionInkPixels: 120 })] }))
  assert.equal(overFace.checks.captionFaceOverlap.verdict, 'fail')
  assert.equal(overFace.checks.captionFaceOverlap.code, 'SUBTITLE_FACE_OVERLAP_IN_PIXELS')
  const ctaOverFace = evaluate(facts(10, { cta: ink(100, 90, 400, 140), inkDensity: 0.03, protectedRegions: [region({ ctaInkPixels: 10 })] }))
  assert.equal(ctaOverFace.checks.ctaFaceOverlap.code, 'CTA_FACE_OVERLAP_IN_PIXELS')
  const outside = evaluate(facts(10, { cta: ink(-0 + 0, 90, 539, 140, 9000, true), inkDensity: 0.07 }))
  assert.equal(outside.checks.safeArea.code, 'INK_OUTSIDE_SAFE_AREA_IN_PIXELS')
  assert.equal(outside.checks.canvasClipping.code, 'INK_CLIPPED_BY_CANVAS_IN_PIXELS')
  const boundary = evaluate(facts(10, { cta: ink(31, 90, 400, 140), inkDensity: 0.02 }))
  assert.equal(boundary.checks.safeArea.verdict, 'unknown', 'within the segmentation tolerance past the bound: unknown, not pass and not fail')
  const lost = evaluate(facts(10, { subject: { state: 'measured', visibleFraction: 0.05, outputConfirmed: false, projected: { x0: -0.9, y0: 0.3, x1: -0.7, y1: 0.5 } }, protectedRegions: [] }))
  assert.equal(lost.checks.subjectVisibility.code, 'SUBJECT_NOT_VISIBLE_IN_PIXELS')
  const clipped = evaluate(facts(10, { subject: { state: 'measured', visibleFraction: 0.35, outputConfirmed: false, projected: { x0: -0.1, y0: 0.3, x1: 0.1, y1: 0.5 } } }))
  assert.equal(clipped.checks.subjectVisibility.code, 'SUBJECT_CLIPPED_IN_PIXELS')
  const unconfirmed = evaluate(facts(10, { subject: { ...PASSING_SUBJECT, outputConfirmed: false } }))
  assert.equal(unconfirmed.checks.subjectVisibility.verdict, 'unknown')
  const dense = evaluate(facts(10, { caption: ink(60, 800, 480, 840, 200000), inkDensity: 0.4 }))
  assert.equal(dense.checks.density.code, 'INK_DENSITY_EXCESS_IN_PIXELS')
})

test('no face evidence on an inked frame is unknown; a face that left the canvas leaves nothing visible to cover', () => {
  const noEvidence = evaluate(facts(10, { caption: ink(60, 800, 480, 840), inkDensity: 0.05, protectedRegions: [], oracle: { state: 'observed', outputFaceCount: 0, sourceFaceCount: 0 }, subject: { state: 'not-applicable', reason: 'NO_SOURCE_FACE' } }))
  assert.equal(noEvidence.checks.captionFaceOverlap.verdict, 'unknown')
  assert.equal(noEvidence.checks.captionFaceOverlap.reason, 'NO_FACE_EVIDENCE')
  const unreadable = evaluate(facts(10, { caption: ink(60, 800, 480, 840), inkDensity: 0.05, protectedRegions: [], oracle: { state: 'unknown', outputFaceCount: 0, sourceFaceCount: 0 }, subject: { state: 'unknown', reason: 'SOURCE_FACE_ORACLE_UNREADABLE' } }))
  assert.equal(unreadable.checks.captionFaceOverlap.reason, 'FACE_ORACLE_UNREADABLE')
  const cutAway = evaluate(facts(10, { caption: ink(60, 800, 480, 840), inkDensity: 0.05, protectedRegions: [], subject: { state: 'measured', visibleFraction: 0.02, outputConfirmed: false, projected: { x0: -2, y0: 0, x1: -1, y1: 1 } } }))
  assert.equal(cutAway.checks.captionFaceOverlap.verdict, 'pass')
  assert.equal(cutAway.checks.subjectVisibility.code, 'SUBJECT_NOT_VISIBLE_IN_PIXELS', 'the loss is still reported')
  const noInk = evaluate(facts(10))
  assert.equal(noInk.checks.captionFaceOverlap.verdict, 'not-applicable')
})

test('issues are localized to half-open ranges of consecutive sampled frames, and each finding is its own issue', () => {
  const verdicts = [10, 11, 12, 15, 16].map((frameIndex) => evaluate(facts(frameIndex, { caption: ink(60, 300, 480, 340), inkDensity: 0.05, protectedRegions: [region({ captionInkPixels: 50 })] })))
  const issues = localizeMp4Issues(verdicts)
  assert.deepEqual(issues.map((issue) => [issue.code, issue.evidenceRange.startFrame, issue.evidenceRange.endFrame, issue.severity]), [
    ['SUBTITLE_FACE_OVERLAP_IN_PIXELS', 10, 13, 'hard'], ['SUBTITLE_FACE_OVERLAP_IN_PIXELS', 15, 17, 'hard'],
  ])
  assert.deepEqual(issues[0].sampleIds, ['sample-10', 'sample-11', 'sample-12'])
  assert.equal(localizeMp4Issues(verdicts, 5).length, 1, 'a caller that samples with a stride may merge across the gap')
})

test('sampling: every frame of a short output; a stride plus cuts, first, last and ink-run edges of a long one; the gaps are named', () => {
  assert.equal(planMp4SampleFrames({ totalFrames: 90 }).length, 90)
  const long = planMp4SampleFrames({ totalFrames: 1000, cutFrames: [333], inkFrames: new Set([101, 102, 103, 104]) })
  for (const expected of [0, 999, 5, 330, 332, 333, 101, 104]) assert.ok(long.includes(expected), `frame ${expected}`)
  assert.ok(!long.includes(102) && !long.includes(103))
  assert.deepEqual(unsampledRanges(10, [0, 1, 5, 9]), [{ startFrame: 2, endFrame: 5 }, { startFrame: 6, endFrame: 9 }])
  assert.deepEqual(unsampledRanges(4, [0, 1, 2, 3]), [])
})

// ---- registration, projection, subject --------------------------------------------------------------------------------------
const goodRegistration = Object.freeze({ status: 'ok', reason: null, matches: 200, inliers: 150, matrix: [[1.2, 0, -50], [0, 1.2, -20]], medianResidualPixels: 0.8, scale: 1.2, rotationDegrees: 0 })

test('registration gates: each one fails closed and names itself', () => {
  assert.equal(registrationFacts(goodRegistration).usable, true)
  const gate = (overrides) => registrationFacts({ ...goodRegistration, ...overrides })
  assert.equal(gate({ inliers: 10 }).facts.reason, 'TOO_FEW_INLIERS')
  assert.equal(gate({ inliers: 150, matches: 1000 }).facts.reason, 'INLIER_RATIO_TOO_LOW')
  assert.equal(gate({ medianResidualPixels: 3 }).facts.reason, 'RESIDUAL_TOO_HIGH')
  assert.equal(gate({ scale: 9 }).facts.reason, 'SCALE_OUT_OF_RANGE')
  assert.equal(gate({ rotationDegrees: 10 }).facts.reason, 'ROTATION_OUT_OF_RANGE')
  assert.equal(gate({ status: 'failed', reason: 'TOO_FEW_KEYPOINTS' }).facts.reason, 'TOO_FEW_KEYPOINTS')
  assert.equal(gate({ medianResidualPixels: null }).usable, false)
})

test('a source box is projected through the measured transform, never through a crop the renderer was told', () => {
  const source = { width: 1000, height: 800 }, output = { width: 540, height: 960 }
  // source pixel (x, y) -> output pixel (1.2x - 600, 1.2y - 20): a zoom into the source
  const matrix = [[1.2, 0, -600], [0, 1.2, -20]]
  const projected = projectSourceBox(matrix, source, output, { x: 0.5, y: 0.25, width: 0.1, height: 0.2 })
  assert.deepEqual([projected.x0, projected.y0, projected.x1, projected.y1].map((value) => Number(value.toFixed(4))), [0, 0.2292, 0.2222, 0.4292])
  assert.equal(visibleFractionOf({ x0: -0.1, y0: 0.2, x1: 0.1, y1: 0.4 }), 0.5)
  assert.equal(visibleFractionOf({ x0: 1.1, y0: 0.2, x1: 1.3, y1: 0.4 }), 0)
  assert.deepEqual(clipToCanvas({ x0: -1, y0: 0.5, x1: 2, y1: 0.7 }), { x0: 0, y0: 0.5, x1: 1, y1: 0.7 })
  assert.equal(iou({ x0: 0, y0: 0, x1: 1, y1: 1 }, { x0: 0.5, y0: 0, x1: 1.5, y1: 1 }).toFixed(4), '0.3333')
  assert.deepEqual(pixelRectOf({ x: 0.3, y: 0.3, width: 0.2, height: 0.2 }, 540, 960, 0), { x0: 162, y0: 288, x1: 270, y1: 480 })
  assert.deepEqual(pixelRectOf({ x: 0, y: 0, width: 1, height: 1 }, 540, 960, 5), { x0: 0, y0: 0, x1: 540, y1: 960 })
  assert.deepEqual(Object.values(boxOf({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 })).map((value) => Number(value.toFixed(9))), [0.1, 0.2, 0.4, 0.6])
})

test('subject: unknown without a usable registration, not applicable without a source face, clipped when the projection leaves the canvas', () => {
  const output = { width: 540, height: 960 }
  const base = { sourceFrameAvailable: true, sourceOracle: 'observed', sourceFaces: [{ x: 0.5, y: 0.25, width: 0.1, height: 0.2 }], registration: { ...goodRegistration, matrix: [[1.2, 0, -100], [0, 1.2, -20]] }, sourceDimensions: { width: 1000, height: 800 }, outputDimensions: output, outputFaces: [] }
  assert.equal(measureSubject({ ...base, sourceFrameAvailable: false }).subject.reason, 'NO_SOURCE_FRAME')
  assert.equal(measureSubject({ ...base, sourceFaces: [] }).subject.reason, 'NO_SOURCE_FACE')
  assert.equal(measureSubject({ ...base, sourceOracle: 'unknown' }).subject.state, 'unknown')
  assert.equal(measureSubject({ ...base, registration: null }).subject.reason, 'REGISTRATION_NOT_ATTEMPTED')
  const refused = measureSubject({ ...base, registration: { ...goodRegistration, inliers: 3 } })
  assert.equal(refused.subject.reason, 'REGISTRATION_TOO_FEW_INLIERS')
  assert.deepEqual(refused.projectedSourceFaces, [], 'a registration that fails its gates protects nothing')
  const clipped = measureSubject(base)
  assert.equal(clipped.subject.state, 'measured')
  assert.ok(clipped.subject.visibleFraction < 0.5, `${clipped.subject.visibleFraction}`)
  const insideBase = { ...base, sourceFaces: [{ x: 0.1, y: 0.1, width: 0.1, height: 0.2 }], registration: { ...goodRegistration, matrix: [[1.2, 0, 10], [0, 1.2, 10]] } }
  const inside = measureSubject({ ...insideBase, outputFaces: [{ x: 0.24, y: 0.11, width: 0.22, height: 0.2 }] })
  assert.equal(inside.subject.visibleFraction, 1)
  assert.equal(inside.subject.outputConfirmed, true)
  assert.equal(measureSubject({ ...insideBase, outputFaces: [{ x: 0.8, y: 0.8, width: 0.1, height: 0.1 }] }).subject.outputConfirmed, false)
})

// ---- the sealed report -------------------------------------------------------------------------------------------------------
function reportInput(samples) {
  return {
    identity: { workspaceId: 'workspace-w67', projectId: 'project-w67', projectVersionId: 'version-w67', variantId: 'variant-9x16', outputSpecId: 'preset-9x16', format: '9:16', operationId: 'operation-w67', renderInputHash: sha('c') },
    artifact: { sha256: sha('d'), byteSize: 1234, container: 'mov,mp4,m4a,3gp,3g2,mj2', videoCodec: 'h264', pixelFormat: 'yuv420p', width: 540, height: 960, frameRate: { num: 30, den: 1 }, timeBase: { num: 1, den: 15360 }, frameCount: samples.length, durationTicks: samples.length * 512 },
    decode: { status: 'complete', framesExpected: samples.length, framesDecoded: samples.length, frameListSha256: sha('e'), stderrSha256: sha('f'), ffmpegBinarySha256: null },
    outputSpec: { width: 540, height: 960, safeArea: SAFE }, controls: [], noiseProbe: null,
    oracle: { protocol: 'apollo-pixel-oracle/v1', models: pixelOracleModelPins(), bridgeSha256: sha('1'), pythonSha256: sha('2'), runtime: {}, registration: MP4_PIXEL_CRITIC_POLICY.registration, perSample: [] },
    samples,
  }
}

test('a report seals its samples, policy and verdict; one hard issue blocks only this output; any edit breaks the seal', () => {
  const clean = createMp4QualityReport(reportInput([0, 1, 2].map((frameIndex) => facts(frameIndex, { caption: ink(60, 800, 480, 840), inkDensity: 0.05 }))))
  assert.equal(clean.verdict, 'passed')
  assert.equal(clean.exportAllowed, true)
  assert.equal(clean.policy.sha256, MP4_PIXEL_CRITIC_POLICY_SHA256)
  assert.equal(clean.sampling.strategy, 'all-frames')
  assert.equal(clean.checks.captionFaceOverlap.verdict, 'pass')
  assert.equal(clean.checks.ctaFaceOverlap.verdict, 'not-applicable')
  verifyMp4QualityReport(clean)
  const blocked = createMp4QualityReport({
    ...reportInput([0, 1, 2].map((frameIndex) => facts(frameIndex, { caption: ink(60, 300, 480, 340), inkDensity: 0.05, protectedRegions: [region({ captionInkPixels: 30 })] }))),
    identity: { ...reportInput([]).identity, variantId: 'variant-9x16' },
  })
  assert.equal(blocked.verdict, 'blocked')
  assert.equal(blocked.exportAllowed, false)
  verifyMp4QualityReport(blocked)
  // the other format's report stands on its own
  const wide = createMp4QualityReport({
    ...reportInput([0, 1, 2].map((frameIndex) => facts(frameIndex, { caption: ink(100, 440, 860, 500), inkDensity: 0.05 }))),
    identity: { ...reportInput([]).identity, variantId: 'variant-16x9', outputSpecId: 'preset-16x9', format: '16:9' },
    artifact: { ...reportInput([0, 1, 2]).artifact, width: 960, height: 540 }, outputSpec: { width: 960, height: 540, safeArea: { top: 0.055, right: 0.05, bottom: 0.06, left: 0.05 } },
  })
  assert.equal(wide.verdict, 'passed')
  assert.notEqual(wide.reportHash, blocked.reportHash)
  for (const mutate of [
    (value) => ({ ...value, verdict: 'passed' }),
    (value) => ({ ...value, exportAllowed: true }),
    (value) => ({ ...value, issues: [] }),
    (value) => ({ ...value, artifact: { ...value.artifact, sha256: sha('9') } }),
    (value) => ({ ...value, samples: value.samples.slice(1) }),
  ]) assert.throws(() => verifyMp4QualityReport(mutate(blocked)), /inconsistent|does not follow|disagrees/)
  // a resealed report that lies about its verdict is refused by the arithmetic, not only by the hash
  const { reportHash: _hash, ...body } = blocked
  const lying = { ...body, verdict: 'passed', exportAllowed: true }
  assert.throws(() => verifyMp4QualityReport({ ...lying, reportHash: calculateCanonicalHash(lying) }), /does not follow its issues/)
})

test('a report is bound to its file, its variant and its operation', () => {
  const report = createMp4QualityReport(reportInput([0].map((frameIndex) => facts(frameIndex))))
  const expected = { artifactSha256: report.artifact.sha256, artifactByteSize: report.artifact.byteSize, identity: report.identity }
  assert.deepEqual(mp4ReportMismatches(report, expected), [])
  assert.deepEqual(mp4ReportMismatches(report, { ...expected, artifactSha256: sha('0') }), ['ARTIFACT_SHA256'])
  assert.deepEqual(mp4ReportMismatches(report, { ...expected, artifactByteSize: 1 }), ['ARTIFACT_SIZE'])
  assert.deepEqual(mp4ReportMismatches(report, { ...expected, identity: { ...expected.identity, variantId: 'variant-16x9' } }), ['IDENTITY_VARIANTID'])
  assert.deepEqual(mp4ReportMismatches(report, { ...expected, identity: { ...expected.identity, workspaceId: 'workspace-other', operationId: 'operation-other' } }).toSorted(), ['IDENTITY_OPERATIONID', 'IDENTITY_WORKSPACEID'])
})

test('an incomplete decode blocks, partial coverage warns, and a report with no sample is not a pass', () => {
  const failed = createMp4QualityReport({ ...reportInput([facts(0), facts(1)]), decode: { ...reportInput([]).decode, status: 'failed', framesExpected: 2, framesDecoded: 1 } })
  assert.equal(failed.verdict, 'blocked')
  assert.ok(failed.issues.some((issue) => issue.code === 'MP4_DECODE_FAILED' && issue.severity === 'hard'))
  const input = reportInput([facts(0), facts(4)])
  const partial = createMp4QualityReport({ ...input, artifact: { ...input.artifact, frameCount: 5 }, decode: { ...input.decode, framesExpected: 5, framesDecoded: 5 } })
  assert.equal(partial.verdict, 'warning')
  assert.equal(partial.sampling.strategy, 'stride-with-edges')
  assert.deepEqual(partial.sampling.gaps, [{ startFrame: 1, endFrame: 4 }])
  const empty = createMp4QualityReport(reportInput([]))
  assert.equal(empty.verdict, 'warning')
  assert.ok(empty.issues.some((issue) => issue.code === 'MP4_PIXEL_EVIDENCE_UNKNOWN'))
  const unknown = createMp4QualityReport(reportInput([facts(0, { caption: ink(60, 800, 480, 840), inkDensity: 0.05, protectedRegions: [], oracle: { state: 'unknown', outputFaceCount: 0, sourceFaceCount: 0 }, subject: { state: 'unknown', reason: 'X' } })]))
  assert.equal(unknown.verdict, 'warning')
  assert.ok(unknown.unknowns.length > 0, 'an unknown is listed, never silently passed')
  assert.throws(() => createMp4QualityReport({ ...reportInput([facts(0)]), artifact: { ...reportInput([facts(0)]).artifact, width: 100 } }), /canvas differs/)
})
