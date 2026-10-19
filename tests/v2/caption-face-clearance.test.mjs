import assert from 'node:assert/strict'
import test from 'node:test'

import { canvasBandSourceAreas, createCaptionProjection } from '../../src/v2/domain/caption-canvas-projection.ts'
import { combineClearanceStates, evaluateBandFaceClearance, unprojectableBandClearance } from '../../src/v2/domain/caption-face-clearance.ts'
import { collectFaceSourceEvidenceStream } from '../../src/v2/domain/face-source-evidence-stream.ts'
import { sealedSourceWindow, sourceExpectation } from './helpers/face-source-envelope-v3.mjs'

/**
 * W65/W65b: the three-state face clearance of a caption BAND of the variant canvas. The detections live in the source frame
 * (1280x720 here) and in the SOURCE's own frames; the band lives on the canvas and the cue on the timeline; the single projection,
 * clip by clip, maps one onto the other.
 */
const SOURCE = Object.freeze({ artifactId: 'source-1', width: 1280, height: 720 })
const PORTRAIT = Object.freeze({ width: 540, height: 960 })
const LANDSCAPE = Object.freeze({ width: 960, height: 540 })
/** A clip plays its source from the same frame it starts on the timeline, at speed 1, unless a test says otherwise. */
const clip = (overrides = {}) => {
  const base = { id: 'clip-1', sourceArtifactId: 'source-1', timelineInFrame: 0, timelineOutFrame: 300, ...overrides }
  return { sourceInFrame: base.timelineInFrame, sourceOutFrame: base.timelineOutFrame, rate: 1, ...base }
}
const model = (canvas, clips = [clip()], sources = [SOURCE]) => createCaptionProjection({ layout: { canvas }, sources, clips })
const stream = (rowsAt, window, expected) => collectFaceSourceEvidenceStream([sealedSourceWindow({ start: 0, end: 300, rowsAt, ...window })], sourceExpectation(expected))
const FAR = [0.9, 0.02, 0.02, 0.06, 0.08]
const BAND = Object.freeze({ x: 0.07, y: 0.42, width: 0.86, height: 0.16 })
const CUE = Object.freeze({ startFrame: 100, endFrame: 130 })

/** A detector row (score, xmin, ymin, xmax, ymax) centred in the source area the band maps to on this projection. */
function rowInsideBand(projection, band, window = CUE) {
  const [segment] = canvasBandSourceAreas(projection, band, window)
  assert.equal(segment.kind, 'source')
  const centreX = segment.area.x + segment.area.width / 2, centreY = segment.area.y + segment.area.height / 2
  return [0.9, centreX - 0.02, centreY - 0.03, centreX + 0.02, centreY + 0.03]
}
const evaluate = (projection, evidence, band = BAND, window = CUE) => evaluateBandFaceClearance({ projection, evidence, band, window })
const evidenceOf = (built, sourceArtifactId = 'source-1') => [{ sourceArtifactId, stream: built }]

test('combining spans: any occupied wins, then any unknown, and nothing at all is unknown', () => {
  assert.equal(combineClearanceStates(['free-certified', 'free-certified']), 'free-certified')
  assert.equal(combineClearanceStates(['free-certified', 'unknown']), 'unknown')
  assert.equal(combineClearanceStates(['unknown', 'occupied', 'free-certified']), 'occupied')
  assert.equal(combineClearanceStates([]), 'unknown')
})

test('a band over the blurred copy of a 9:16 canvas is certified by geometry alone: no source pixel is under it', () => {
  const result = evaluate(model(PORTRAIT), [], { x: 0.07, y: 0.74, width: 0.86, height: 0.16 })
  assert.equal(result.state, 'free-certified')
  assert.deepEqual(result.evaluations.map((entry) => [entry.kind, entry.state, entry.clearanceHash, entry.startFrame, entry.endFrame, entry.sourceRange]),
    [['geometry-outside-foreground', 'free-certified', null, 100, 130, null]])
  assert.deepEqual([...result.reasons], ['GEOMETRY_NO_FOREGROUND_OVERLAP'])
})

test('a band over the picture needs the evidence of that picture: none is unknown, a clean stream certifies, a face occupies', () => {
  const projection = model(PORTRAIT)
  const noEvidence = evaluate(projection, [])
  assert.equal(noEvidence.state, 'unknown')
  assert.deepEqual(noEvidence.evaluations.map((entry) => [entry.kind, entry.reasons]), [['no-face-evidence', ['NO_FACE_EVIDENCE_FOR_SOURCE']]])
  const clean = evaluate(projection, evidenceOf(stream(() => [FAR])))
  assert.equal(clean.state, 'free-certified')
  assert.equal(clean.evaluations[0].kind, 'face-clearance')
  assert.match(clean.evaluations[0].clearanceHash, /^[a-f0-9]{64}$/)
  assert.deepEqual({ ...clean.evaluations[0].sourceRange }, { startFrame: 100, endFrame: 130 }, 'identity clip: the source frames are the timeline frames')
  const row = rowInsideBand(projection, BAND)
  const occupied = evaluate(projection, evidenceOf(stream((frame) => (frame === 115 ? [row] : [FAR]))))
  assert.equal(occupied.state, 'occupied')
  assert.deepEqual([...occupied.reasons], ['DETECTION_OVERLAPS_AREA'])
})

test('the same face does not occupy a band elsewhere on the canvas: the projection, not the raw source coordinates, decides', () => {
  const projection = model(PORTRAIT)
  const row = rowInsideBand(projection, BAND)
  const evidence = evidenceOf(stream((frame) => (frame === 115 ? [row] : [FAR])))
  // the same source-space rectangle in canvas terms lies on the strip (y ~ .34-.66); the bottom band (y ~ .74) is not under it
  assert.equal(evaluate(projection, evidence, { x: 0.07, y: 0.74, width: 0.86, height: 0.16 }).state, 'free-certified')
  // on the landscape canvas the picture fills the frame, so the very same detection that sits under the centre band ...
  const landscape = model(LANDSCAPE)
  assert.equal(evaluate(landscape, evidence).state, 'occupied')
  // ... and under a band far from it the landscape canvas is clear
  assert.equal(evaluate(landscape, evidence, { x: 0.07, y: 0.80, width: 0.86, height: 0.12 }).state, 'free-certified')
})

test('incomplete or untrusted evidence is unknown, even where a detection would have been far away', () => {
  const projection = model(LANDSCAPE)
  const gap = collectFaceSourceEvidenceStream([sealedSourceWindow({ start: 0, end: 105, rowsAt: () => [FAR] }),
    sealedSourceWindow({ start: 200, end: 300, id: 'face-source-envelope-200', rowsAt: () => [FAR] })], sourceExpectation())
  assert.equal(evaluate(projection, evidenceOf(gap)).state, 'unknown')
  const failedFrame = evaluate(projection, evidenceOf(stream((frame) => (frame === 115 ? 'unknown' : [FAR]))))
  assert.equal(failedFrame.state, 'unknown'); assert.ok(failedFrame.reasons.includes('SAMPLE_UNKNOWN'))
  const foreign = collectFaceSourceEvidenceStream([sealedSourceWindow({ start: 0, end: 300, rowsAt: () => [FAR] })], sourceExpectation({ sourceSha256: 'f'.repeat(64) }))
  const refused = evaluate(projection, evidenceOf(foreign))
  assert.equal(refused.state, 'unknown'); assert.ok(refused.reasons.includes('UNTRUSTED_EVIDENCE_NEAR_CUE'))
})

test('spans are judged per clip: another source without evidence, or a hole in the timeline, makes the band unknown', () => {
  const other = { artifactId: 'source-2', width: 640, height: 360 }
  const clips = [
    clip({ id: 'clip-1', sourceArtifactId: 'source-1', timelineInFrame: 0, timelineOutFrame: 110 }),
    clip({ id: 'clip-2', sourceArtifactId: 'source-2', timelineInFrame: 110, timelineOutFrame: 200 }),
  ]
  const projection = model(LANDSCAPE, clips, [SOURCE, other])
  const evidence = evidenceOf(stream(() => [FAR]))
  const spanning = evaluate(projection, evidence)
  assert.equal(spanning.state, 'unknown')
  assert.deepEqual(spanning.evaluations.map((entry) => [entry.kind, entry.sourceArtifactId, entry.startFrame, entry.endFrame, entry.state]), [
    ['face-clearance', 'source-1', 100, 110, 'free-certified'],
    ['no-face-evidence', 'source-2', 110, 130, 'unknown'],
  ])
  // a cue entirely inside the evidenced clip is certified on that clip's evidence alone
  assert.equal(evaluate(projection, evidence, BAND, { startFrame: 20, endFrame: 60 }).state, 'free-certified')
  const hole = model(LANDSCAPE, [clip({ id: 'clip-1', timelineInFrame: 0, timelineOutFrame: 110 })])
  const uncovered = evaluate(hole, evidence)
  assert.equal(uncovered.state, 'unknown')
  assert.deepEqual(uncovered.evaluations.map((entry) => entry.kind), ['face-clearance', 'timeline-not-covered'])
  // a face in the evidenced clip occupies even when another span is unknown: occupied wins
  const row = rowInsideBand(projection, BAND)
  const occupied = evaluate(projection, evidenceOf(stream((frame) => (frame === 105 ? [row] : [FAR]))))
  assert.equal(occupied.state, 'occupied')
})

test('a Director cut: a trimmed clip is judged in the source frames it plays, not in the timeline numbers', () => {
  // the clip starts at timeline 0 but plays the source from frame 150: timeline 100-130 shows source 250-280
  const trimmed = model(LANDSCAPE, [clip({ timelineInFrame: 0, timelineOutFrame: 150, sourceInFrame: 150, sourceOutFrame: 300 })])
  const row = rowInsideBand(trimmed, BAND)
  const faceAtSource = (from, to) => evidenceOf(stream((frame) => (frame >= from && frame < to ? [row] : [FAR])))
  // a face at SOURCE 250-280 occupies the cue at timeline 100-130 ...
  const occupied = evaluate(trimmed, faceAtSource(250, 280))
  assert.equal(occupied.state, 'occupied')
  assert.deepEqual({ ...occupied.evaluations[0].sourceRange }, { startFrame: 250, endFrame: 280 })
  // ... and the same numbers read as timeline frames (a face at 100-130) are NOT under it: that part of the source is not even played
  assert.equal(evaluate(trimmed, faceAtSource(100, 130)).state, 'free-certified')
})

test('a cut is a jump in the source: adjacent clips of the same source are two judgements, never one run', () => {
  const clips = [
    clip({ id: 'clip-1', timelineInFrame: 0, timelineOutFrame: 110, sourceInFrame: 150, sourceOutFrame: 260 }),
    clip({ id: 'clip-2', timelineInFrame: 110, timelineOutFrame: 200, sourceInFrame: 20, sourceOutFrame: 110 }),
  ]
  const projection = model(LANDSCAPE, clips)
  const result = evaluate(projection, evidenceOf(stream(() => [FAR])), BAND, { startFrame: 100, endFrame: 130 })
  assert.equal(result.state, 'free-certified')
  assert.deepEqual(result.evaluations.map((entry) => [entry.kind, entry.startFrame, entry.endFrame, entry.sourceRange.startFrame, entry.sourceRange.endFrame]), [
    ['face-clearance', 100, 110, 250, 260], ['face-clearance', 110, 130, 20, 40],
  ])
  // a face at source 20-40 (the second piece) occupies the band even though the first piece is clear
  const row = rowInsideBand(projection, BAND, { startFrame: 110, endFrame: 130 })
  const occupied = evaluate(projection, evidenceOf(stream((frame) => (frame >= 20 && frame < 40 ? [row] : [FAR]))), BAND, { startFrame: 100, endFrame: 130 })
  assert.equal(occupied.state, 'occupied')
  // evidence that stops at the cut leaves the piece after it unknown: the samples of the source just outside a clip do vouch for its edge,
  // but the source past the last window does not exist
  const windows = collectFaceSourceEvidenceStream([sealedSourceWindow({ start: 120, end: 300, rowsAt: () => [FAR] })], sourceExpectation())
  const partial = evaluate(projection, evidenceOf(windows), BAND, { startFrame: 100, endFrame: 130 })
  assert.equal(partial.state, 'unknown')
  assert.deepEqual(partial.evaluations.map((entry) => entry.state), ['free-certified', 'unknown'])
})

test('samples of the source just OUTSIDE a clip vouch for its edges: the source is continuous and immutable', () => {
  // the clip plays source 100-200 only; the windows cover 85-215, so the samples at 100 and 195 have a neighbour outside the clip
  const clipped = model(LANDSCAPE, [clip({ timelineInFrame: 0, timelineOutFrame: 100, sourceInFrame: 100, sourceOutFrame: 200 })])
  const outside = collectFaceSourceEvidenceStream([sealedSourceWindow({ start: 85, end: 215, rowsAt: () => [FAR] })], sourceExpectation())
  assert.equal(evaluate(clipped, evidenceOf(outside), BAND, { startFrame: 0, endFrame: 100 }).state, 'free-certified')
  // a window that stops at the clip's own range has no sample at or after the clip's last frame (199): the edge cue is not bracketed
  const tight = collectFaceSourceEvidenceStream([sealedSourceWindow({ start: 100, end: 200, rowsAt: () => [FAR] })], sourceExpectation())
  const edge = evaluate(clipped, evidenceOf(tight), BAND, { startFrame: 0, endFrame: 100 })
  assert.equal(edge.state, 'unknown')
  assert.ok(edge.reasons.includes('NO_SAMPLE_AFTER_CUE'))
  const inset = collectFaceSourceEvidenceStream([sealedSourceWindow({ start: 105, end: 195, rowsAt: () => [FAR] })], sourceExpectation())
  assert.equal(evaluate(clipped, evidenceOf(inset), BAND, { startFrame: 0, endFrame: 100 }).state, 'unknown')
})

test('what cannot be proven about a clip is unknown, and geometry still certifies where no picture is under the band', () => {
  const evidence = evidenceOf(stream(() => [FAR]))
  const fast = model(LANDSCAPE, [clip({ timelineInFrame: 0, timelineOutFrame: 150, sourceInFrame: 0, sourceOutFrame: 300, rate: 2 })])
  const rate = evaluate(fast, evidence)
  assert.equal(rate.state, 'unknown')
  assert.deepEqual(rate.evaluations.map((entry) => [entry.kind, entry.reasons]), [['clip-map-unprovable', ['CLIP_RATE_NOT_UNIT']]])
  // a map whose source and timeline ranges differ in length is not a pure offset either
  const stretched = model(LANDSCAPE, [clip({ timelineInFrame: 0, timelineOutFrame: 150, sourceInFrame: 0, sourceOutFrame: 120 })])
  assert.deepEqual(evaluate(stretched, evidence).evaluations.map((entry) => [entry.kind, entry.reasons]), [['clip-map-unprovable', ['CLIP_MAP_INCONSISTENT']]])
  // the reason is the same whether or not evidence exists: the frames cannot be pinned to frames of the source
  assert.deepEqual(evaluate(fast, []).evaluations.map((entry) => entry.kind), ['clip-map-unprovable'])
  // ... and a band that touches no picture is certified by geometry whatever the speed of the clip under it
  const geometry = evaluate(model(PORTRAIT, [clip({ rate: 2, sourceOutFrame: 600 })]), [], { x: 0.07, y: 0.74, width: 0.86, height: 0.16 })
  assert.equal(geometry.state, 'free-certified')
  assert.equal(geometry.evaluations[0].kind, 'geometry-outside-foreground')
})

test('a span the source evidence does not reach, or evidence declared unavailable, is unknown and says why', () => {
  const projection = model(LANDSCAPE, [clip({ timelineInFrame: 0, timelineOutFrame: 150, sourceInFrame: 200, sourceOutFrame: 350 })])
  // the stream is bounded at 300 source frames: the clip plays past it
  const beyond = evaluate(projection, evidenceOf(stream(() => [FAR])), BAND, { startFrame: 120, endFrame: 150 })
  assert.equal(beyond.state, 'unknown')
  assert.deepEqual(beyond.evaluations.map((entry) => [entry.kind, entry.reasons, entry.sourceRange.startFrame, entry.sourceRange.endFrame]),
    [['face-clearance', ['SPAN_OUTSIDE_EVIDENCE_TIMELINE'], 320, 350]])
  const unavailable = evaluate(model(LANDSCAPE), [{ sourceArtifactId: 'source-1', stream: null, unavailableReason: 'TIMELINE_FPS_NOT_INTEGER' }])
  assert.equal(unavailable.state, 'unknown')
  assert.deepEqual(unavailable.evaluations.map((entry) => [entry.kind, entry.reasons]), [['no-face-evidence', ['TIMELINE_FPS_NOT_INTEGER']]])
})

test('an unprojectable band is unknown and says why; duplicate sources are refused', () => {
  const result = unprojectableBandClearance(CUE, 'SOURCE_DIMENSIONS_UNKNOWN')
  assert.equal(result.state, 'unknown')
  assert.deepEqual(result.evaluations.map((entry) => [entry.kind, entry.startFrame, entry.endFrame, entry.reasons]), [['projection-unavailable', 100, 130, ['SOURCE_DIMENSIONS_UNKNOWN']]])
  const one = { sourceArtifactId: 'source-1', stream: stream(() => [FAR]) }
  assert.throws(() => evaluate(model(LANDSCAPE), [one, one]), /unique per source/)
})
