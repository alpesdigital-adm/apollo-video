import assert from 'node:assert/strict'
import test from 'node:test'

import { dilateFaceBox, evaluateFaceCaptionClearance } from '../../src/v2/domain/face-caption-clearance.ts'
import { collectFaceEvidenceStream } from '../../src/v2/domain/face-evidence-stream.ts'
import { FACE_EVIDENCE_POLICY_SHA256 } from '../../src/v2/domain/face-evidence-policy.ts'
import { acceptedProducer, expectation, sealedWindow } from './helpers/face-envelope-v2.mjs'

// Detector rows are [score, xmin, ymin, xmax, ymax]; the frame is 1280x720 (see the helper).
const BAND = [{ startFrame: 0, endFrame: 300, bounds: { x: 0.05, y: 0.75, width: 0.9, height: 0.2 } }]
const stream = (rowsAt, { start = 0, end = 300 } = {}) => collectFaceEvidenceStream([sealedWindow({ start, end, rowsAt })], expectation())
const clear = (built, cue = { startFrame: 100, endFrame: 130 }, area = BAND) => evaluateFaceCaptionClearance({ stream: built, cue, area })
const FAR_ABOVE = [0.9, 0.4, 0.1, 0.6, 0.4]
const INSIDE_BAND = [0.9, 0.4, 0.6, 0.6, 0.9]

test('without trusted evidence the answer is unknown, never free', () => {
  const empty = collectFaceEvidenceStream([], expectation())
  const result = clear(empty)
  assert.equal(result.state, 'unknown')
  assert.deepEqual(result.reasons, ['NO_SAMPLE_AFTER_CUE', 'NO_SAMPLE_BEFORE_CUE'])
  assert.equal(result.scope.faceSafety, 'unknown')
  assert.equal(result.coverage.samplesConsidered, 0)
})

test('a fully analysed cue with nothing near the area is free-certified, scoped to the detector and the sampled evidence', () => {
  const built = stream(() => [FAR_ABOVE])
  const result = clear(built)
  assert.equal(result.state, 'free-certified')
  assert.deepEqual(result.reasons, [])
  assert.equal(result.policySha256, FACE_EVIDENCE_POLICY_SHA256)
  assert.equal(result.streamHash, built.streamHash)
  assert.equal(result.coverage.maxObservedGapFrames, 5)
  assert.equal(result.coverage.maxAllowedGapFrames, 15)
  assert.equal(result.scope.detector, 'omz-face-detection-0204-v9')
  assert.match(result.scope.meaning, /not a statement that no face is present/)
  assert.equal(clear(built).clearanceHash, result.clearanceHash)
  assert.notEqual(clear(built, { startFrame: 100, endFrame: 131 }).clearanceHash, result.clearanceHash)
  assert.throws(() => { result.reasons.push('x') }, TypeError)
})

test('any trusted detection from 0.20 up that overlaps the area occupies it, whatever its size or confidence', () => {
  const big = clear(stream((frame) => (frame === 115 ? [INSIDE_BAND] : [FAR_ABOVE])))
  assert.equal(big.state, 'occupied')
  assert.equal(big.occupantCount, 1)
  assert.equal(big.occupants[0].timelineFrame, 115)
  const weak = clear(stream((frame) => (frame === 115 ? [[0.25, 0.4, 0.8, 0.45, 0.85]] : [FAR_ABOVE])))
  assert.equal(weak.state, 'occupied', 'a 0.25 detection counts; the clearance floor is 0.20')
  const tiny = clear(stream((frame) => (frame === 115 ? [[0.9, 0.5, 0.80, 0.51, 0.81]] : [FAR_ABOVE])))
  assert.equal(tiny.state, 'occupied', 'background-size faces count too: clearance does not use the foreground model')
})

test('the dilation margin is 35% of the larger side with a 1.5% floor, and touching counts as overlap', () => {
  const frame = { width: 1280, height: 720 }
  const face = [0.40, 0.30, 0.55, 0.66]
  const dilated = dilateFaceBox(face, frame)
  const larger = Math.max(0.15 * 1280, 0.36 * 720)
  assert.ok(Math.abs(dilated[3] - (0.66 + 0.35 * larger / 720)) < 1e-12)
  assert.ok(Math.abs(dilated[2] - (0.55 + 0.35 * larger / 1280)) < 1e-12)
  // The face bottom is 0.09 above the band, yet the 35% margin reaches it.
  assert.equal(clear(stream((frame_) => (frame_ === 115 ? [[0.9, ...face]] : [FAR_ABOVE]))).state, 'occupied')
  assert.equal(clear(stream((frame_) => (frame_ === 115 ? [[0.9, 0.40, 0.20, 0.55, 0.52]] : [FAR_ABOVE]))).state, 'free-certified')
  // A tiny face gets the floor of 1.5% of the frame on each axis.
  const tiny = [0.5, 0.735, 0.51, 0.745]
  const tinyDilated = dilateFaceBox(tiny, frame)
  assert.ok(Math.abs(tinyDilated[3] - (0.745 + 0.015)) < 1e-12)
  assert.ok(Math.abs(tinyDilated[2] - (0.51 + 0.015)) < 1e-12)
  assert.equal(clear(stream((f) => (f === 115 ? [[0.9, ...tiny]] : [FAR_ABOVE]))).state, 'occupied')
  // Touching exactly counts as overlap (closed rectangles).
  const touching = [{ startFrame: 0, endFrame: 300, bounds: { x: 0.05, y: dilated[3], width: 0.9, height: 0.2 } }]
  assert.equal(clear(stream((f) => (f === 115 ? [[0.9, ...face]] : [FAR_ABOVE])), undefined, touching).state, 'occupied')
  const justBelow = [{ startFrame: 0, endFrame: 300, bounds: { x: 0.05, y: dilated[3] + 1e-6, width: 0.9, height: 0.2 } }]
  assert.equal(clear(stream((f) => (f === 115 ? [[0.9, ...face]] : [FAR_ABOVE])), undefined, justBelow).state, 'free-certified')
  assert.deepEqual(dilateFaceBox([0, 0, 1, 1], frame), [0, 0, 1, 1], 'the dilated box stays inside the frame')
})

test('a sample that could not be analysed inside the span makes it unknown; far away it changes nothing', () => {
  const inside = clear(stream((frame) => (frame === 115 ? 'unknown' : [FAR_ABOVE])))
  assert.equal(inside.state, 'unknown')
  assert.deepEqual(inside.reasons, ['SAMPLE_UNKNOWN'])
  assert.deepEqual(inside.coverage.unknownSampleFrames, [115])
  // The bracketing samples (last at or before the start, first at or after the end) count too.
  assert.equal(clear(stream((frame) => (frame === 100 ? 'unknown' : [FAR_ABOVE]))).state, 'unknown')
  assert.equal(clear(stream((frame) => (frame === 130 ? 'unknown' : [FAR_ABOVE]))).state, 'unknown', 'frame 129 lies between samples 125 and 130, so both count')
  assert.equal(clear(stream((frame) => (frame === 135 ? 'unknown' : [FAR_ABOVE]))).state, 'free-certified')
  assert.equal(clear(stream((frame) => (frame === 20 ? 'unknown' : [FAR_ABOVE]))).state, 'free-certified')
})

test('sample gaps beyond 0.5 s, and missing samples before or after the cue, are unknown', () => {
  const sparse = (skip) => stream((frame) => (skip.includes(frame) ? 'unknown' : [FAR_ABOVE]))
  assert.equal(clear(sparse([])).state, 'free-certified')
  // Samples are every 5 frames; a cue at the window end lacks the sample after it.
  assert.equal(clear(stream(() => [FAR_ABOVE], { start: 0, end: 140 }), { startFrame: 130, endFrame: 150 }).state, 'unknown')
  assert.deepEqual(clear(stream(() => [FAR_ABOVE], { start: 0, end: 140 }), { startFrame: 130, endFrame: 150 }).reasons, ['NO_SAMPLE_AFTER_CUE'])
  assert.deepEqual(clear(stream(() => [FAR_ABOVE], { start: 50, end: 300 }), { startFrame: 10, endFrame: 40 }).reasons, ['NO_SAMPLE_BEFORE_CUE'])
  // A missing window in the middle leaves a gap in the merged stream.
  const left = sealedWindow({ start: 0, end: 100 }), right = sealedWindow({ start: 200, end: 300 })
  const gapped = collectFaceEvidenceStream([left, right], expectation())
  const across = evaluateFaceCaptionClearance({ stream: gapped, cue: { startFrame: 90, endFrame: 210 }, area: BAND })
  assert.equal(across.state, 'unknown')
  assert.ok(across.reasons.includes('SAMPLE_GAP_EXCEEDS_LIMIT'))
  assert.ok(across.coverage.maxObservedGapFrames > 15)
  // Adjacent windows are one stream: a cue across their boundary is certified.
  const adjacent = collectFaceEvidenceStream([sealedWindow({ start: 0, end: 150, rowsAt: () => [FAR_ABOVE] }),
    sealedWindow({ start: 150, end: 300, rowsAt: () => [FAR_ABOVE] })], expectation())
  assert.equal(evaluateFaceCaptionClearance({ stream: adjacent, cue: { startFrame: 140, endFrame: 160 }, area: BAND }).state, 'free-certified')
  const missingSecond = collectFaceEvidenceStream([sealedWindow({ start: 0, end: 150, rowsAt: () => [FAR_ABOVE] })], expectation())
  assert.equal(evaluateFaceCaptionClearance({ stream: missingSecond, cue: { startFrame: 140, endFrame: 160 }, area: BAND }).state, 'unknown')
})

test('untrusted evidence near the cue makes the answer unknown even when trusted samples look free or occupied', () => {
  const linux = acceptedProducer('win32')
  linux.runtime.platform = 'linux'
  const trusted = sealedWindow({ start: 0, end: 150, rowsAt: () => [FAR_ABOVE] })
  const foreign = sealedWindow({ start: 100, end: 250, rowsAt: () => [FAR_ABOVE], producer: linux, id: 'face-envelope-linux' })
  const mixed = collectFaceEvidenceStream([trusted, foreign], expectation())
  const near = evaluateFaceCaptionClearance({ stream: mixed, cue: { startFrame: 110, endFrame: 130 }, area: BAND })
  assert.equal(near.state, 'unknown')
  assert.deepEqual(near.reasons, ['UNTRUSTED_EVIDENCE_NEAR_CUE'])
  assert.equal(near.untrustedEnvelopeHashes.length, 1)
  const overlapAndUntrusted = collectFaceEvidenceStream([sealedWindow({ start: 0, end: 150, rowsAt: () => [INSIDE_BAND] }), foreign], expectation())
  assert.equal(evaluateFaceCaptionClearance({ stream: overlapAndUntrusted, cue: { startFrame: 110, endFrame: 130 }, area: BAND }).state, 'unknown',
    'untrusted evidence wins over an overlap: the overlap cannot be relied on either')
  // Far from the untrusted window the trusted evidence still decides.
  assert.equal(evaluateFaceCaptionClearance({ stream: mixed, cue: { startFrame: 20, endFrame: 40 }, area: BAND }).state, 'free-certified')
})

test('an overlap among trusted samples is occupied even when other samples are missing', () => {
  const result = clear(stream((frame) => (frame === 105 ? 'unknown' : frame === 115 ? [INSIDE_BAND] : [FAR_ABOVE])))
  assert.equal(result.state, 'occupied')
  assert.ok(result.reasons.includes('DETECTION_OVERLAPS_AREA'))
  assert.ok(result.reasons.includes('SAMPLE_UNKNOWN'))
})

test('the area must be defined for the whole span; a moving area is checked where it is', () => {
  const partial = [{ startFrame: 0, endFrame: 115, bounds: BAND[0].bounds }]
  const result = clear(stream(() => [FAR_ABOVE]), undefined, partial)
  assert.equal(result.state, 'unknown')
  assert.deepEqual(result.reasons, ['AREA_NOT_DEFINED_FOR_SPAN'])
  const left = { x: 0.0, y: 0.75, width: 0.3, height: 0.2 }, right = { x: 0.7, y: 0.75, width: 0.3, height: 0.2 }
  const moving = [{ startFrame: 0, endFrame: 130, bounds: left }, { startFrame: 130, endFrame: 300, bounds: right }]
  const faceOnRight = [0.9, 0.75, 0.6, 0.9, 0.9]
  // Seen on the right only in samples whose vouched frames end before the area moves there: free.
  assert.equal(clear(stream((frame) => (frame <= 120 ? [faceOnRight] : [FAR_ABOVE])), { startFrame: 100, endFrame: 160 }, moving).state, 'free-certified')
  // Seen on the right in a sample that vouches for frames after the move: occupied.
  assert.equal(clear(stream((frame) => (frame === 135 ? [faceOnRight] : [FAR_ABOVE])), { startFrame: 100, endFrame: 160 }, moving).state, 'occupied')
  assert.throws(() => clear(stream(() => []), { startFrame: 10, endFrame: 10 }), /cue range is invalid/)
  assert.throws(() => clear(stream(() => []), { startFrame: 10, endFrame: 301 }), /cue range is invalid/)
  assert.throws(() => clear(stream(() => []), undefined, [{ startFrame: 0, endFrame: 10, bounds: { x: 0.5, y: 0.5, width: 0.6, height: 0.1 } }]), /area range is invalid/)
})

// ---- Property: free-certified holds exactly when an independent reading of the policy says so ---------------------
function lcg(seed) { let state = seed >>> 0; return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296 } }
function independentFree(built, cue, area) {
  const gap = 15 // floor(500 ms * 30 fps / 1000)
  const samples = built.samples
  const before = [...samples].reverse().find((sample) => sample.timelineFrame <= cue.startFrame)
  const after = samples.find((sample) => sample.timelineFrame >= cue.endFrame - 1)
  if (!before || !after) return false
  const range = samples.filter((sample) => sample.timelineFrame >= before.timelineFrame && sample.timelineFrame <= after.timelineFrame)
  if (range.some((sample) => sample.status !== 'observed')) return false
  if (range.some((sample, index) => index > 0 && sample.timelineFrame - range[index - 1].timelineFrame > gap)) return false
  return range.every((sample) => sample.detections.every((detection) => {
    if (detection.confidence < 0.2) return true
    const [x1, y1, x2, y2] = detection.boxXYXY
    const side = Math.max((x2 - x1) * sample.frameWidth, (y2 - y1) * sample.frameHeight)
    const mx = Math.max(0.35 * side, 0.015 * sample.frameWidth) / sample.frameWidth
    const my = Math.max(0.35 * side, 0.015 * sample.frameHeight) / sample.frameHeight
    const box = [Math.max(0, x1 - mx), Math.max(0, y1 - my), Math.min(1, x2 + mx), Math.min(1, y2 + my)]
    const a = area[0].bounds
    return box[2] < a.x || box[0] > a.x + a.width || box[3] < a.y || box[1] > a.y + a.height
  }))
}

test('property: free-certified is exactly the independent reading of the policy, and missing evidence never helps', () => {
  const random = lcg(20261018)
  let free = 0, occupied = 0, unknown = 0
  for (let round = 0; round < 60; round += 1) {
    const plan = new Map()
    for (let frame = 0; frame < 300; frame += 5) {
      const roll = random()
      if (roll < 0.05) plan.set(frame, 'unknown')
      else if (roll < 0.30) {
        const x = random() * 0.8, y = random() * 0.8, w = 0.02 + random() * 0.2, h = 0.02 + random() * 0.2
        plan.set(frame, [[0.2 + random() * 0.8, x, y, Math.min(0.99, x + w), Math.min(0.99, y + h)]])
      } else plan.set(frame, [])
    }
    const built = stream((frame) => plan.get(frame))
    for (let cueRound = 0; cueRound < 12; cueRound += 1) {
      const startFrame = Math.floor(random() * 250), endFrame = startFrame + 1 + Math.floor(random() * 40)
      const result = evaluateFaceCaptionClearance({ stream: built, cue: { startFrame, endFrame }, area: BAND })
      assert.equal(result.state === 'free-certified', independentFree(built, { startFrame, endFrame }, BAND), `round ${round} cue ${startFrame}-${endFrame}`)
      if (result.state === 'free-certified') free += 1
      else if (result.state === 'occupied') occupied += 1
      else unknown += 1
      // Turning any one sample into unknown can only move the answer away from free-certified.
      if (result.state !== 'free-certified') {
        const frame = [...plan.keys()][Math.floor(random() * plan.size)]
        const weaker = stream((f) => (f === frame ? 'unknown' : plan.get(f)))
        assert.notEqual(evaluateFaceCaptionClearance({ stream: weaker, cue: { startFrame, endFrame }, area: BAND }).state, 'free-certified')
      }
    }
  }
  assert.ok(free > 20 && occupied > 20 && unknown > 20, `distribution free=${free} occupied=${occupied} unknown=${unknown}`)
})
