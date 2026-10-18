import assert from 'node:assert/strict'
import test from 'node:test'

import { canvasBandSourceAreas, createCaptionProjection } from '../../src/v2/domain/caption-canvas-projection.ts'
import { combineClearanceStates, evaluateBandFaceClearance, unprojectableBandClearance } from '../../src/v2/domain/caption-face-clearance.ts'
import { collectFaceEvidenceStream } from '../../src/v2/domain/face-evidence-stream.ts'
import { expectation, sealedWindow } from './helpers/face-envelope-v2.mjs'

/**
 * W65: the three-state face clearance of a caption BAND of the variant canvas. The detections live in the source frame
 * (1280x720 here); the band lives on the canvas; the single projection maps one onto the other.
 */
const SOURCE = Object.freeze({ artifactId: 'source-1', width: 1280, height: 720 })
const PORTRAIT = Object.freeze({ width: 540, height: 960 })
const LANDSCAPE = Object.freeze({ width: 960, height: 540 })
const model = (canvas, clips = [{ id: 'clip-1', sourceArtifactId: 'source-1', timelineInFrame: 0, timelineOutFrame: 300 }], sources = [SOURCE]) =>
  createCaptionProjection({ layout: { canvas }, sources, clips })
const stream = (rowsAt, window) => collectFaceEvidenceStream([sealedWindow({ start: 0, end: 300, rowsAt, ...window })], expectation())
const FAR = [0.9, 0.02, 0.02, 0.06, 0.08]
const BAND = Object.freeze({ x: 0.07, y: 0.42, width: 0.86, height: 0.16 })
const CUE = Object.freeze({ startFrame: 100, endFrame: 130 })

/** A detector row (score, xmin, ymin, xmax, ymax) centred in the source area the band maps to on this projection. */
function rowInsideBand(projection, band) {
  const [segment] = canvasBandSourceAreas(projection, band, CUE)
  assert.equal(segment.kind, 'source')
  const centreX = segment.area.x + segment.area.width / 2, centreY = segment.area.y + segment.area.height / 2
  return [0.9, centreX - 0.02, centreY - 0.03, centreX + 0.02, centreY + 0.03]
}
const evaluate = (projection, evidence, band = BAND, window = CUE) => evaluateBandFaceClearance({ projection, evidence, band, window })

test('combining spans: any occupied wins, then any unknown, and nothing at all is unknown', () => {
  assert.equal(combineClearanceStates(['free-certified', 'free-certified']), 'free-certified')
  assert.equal(combineClearanceStates(['free-certified', 'unknown']), 'unknown')
  assert.equal(combineClearanceStates(['unknown', 'occupied', 'free-certified']), 'occupied')
  assert.equal(combineClearanceStates([]), 'unknown')
})

test('a band over the blurred copy of a 9:16 canvas is certified by geometry alone: no source pixel is under it', () => {
  const result = evaluate(model(PORTRAIT), [], { x: 0.07, y: 0.74, width: 0.86, height: 0.16 })
  assert.equal(result.state, 'free-certified')
  assert.deepEqual(result.evaluations.map((entry) => [entry.kind, entry.state, entry.clearanceHash, entry.startFrame, entry.endFrame]),
    [['geometry-outside-foreground', 'free-certified', null, 100, 130]])
  assert.deepEqual([...result.reasons], ['GEOMETRY_NO_FOREGROUND_OVERLAP'])
})

test('a band over the picture needs the evidence of that picture: none is unknown, a clean stream certifies, a face occupies', () => {
  const projection = model(PORTRAIT)
  const noEvidence = evaluate(projection, [])
  assert.equal(noEvidence.state, 'unknown')
  assert.deepEqual(noEvidence.evaluations.map((entry) => [entry.kind, entry.reasons]), [['no-face-evidence', ['NO_FACE_EVIDENCE_FOR_SOURCE']]])
  const clean = evaluate(projection, [{ sourceArtifactId: 'source-1', stream: stream(() => [FAR]) }])
  assert.equal(clean.state, 'free-certified')
  assert.equal(clean.evaluations[0].kind, 'face-clearance')
  assert.match(clean.evaluations[0].clearanceHash, /^[a-f0-9]{64}$/)
  const row = rowInsideBand(projection, BAND)
  const occupied = evaluate(projection, [{ sourceArtifactId: 'source-1', stream: stream((frame) => (frame === 115 ? [row] : [FAR])) }])
  assert.equal(occupied.state, 'occupied')
  assert.deepEqual([...occupied.reasons], ['DETECTION_OVERLAPS_AREA'])
})

test('the same face does not occupy a band elsewhere on the canvas: the projection, not the raw source coordinates, decides', () => {
  const projection = model(PORTRAIT)
  const row = rowInsideBand(projection, BAND)
  const evidence = [{ sourceArtifactId: 'source-1', stream: stream((frame) => (frame === 115 ? [row] : [FAR])) }]
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
  const gap = collectFaceEvidenceStream([sealedWindow({ start: 0, end: 105, rowsAt: () => [FAR] }), sealedWindow({ start: 200, end: 300, id: 'face-envelope-200', rowsAt: () => [FAR] })], expectation())
  assert.equal(evaluate(projection, [{ sourceArtifactId: 'source-1', stream: gap }]).state, 'unknown')
  const failedFrame = evaluate(projection, [{ sourceArtifactId: 'source-1', stream: stream((frame) => (frame === 115 ? 'unknown' : [FAR])) }])
  assert.equal(failedFrame.state, 'unknown'); assert.ok(failedFrame.reasons.includes('SAMPLE_UNKNOWN'))
  const foreign = collectFaceEvidenceStream([sealedWindow({ start: 0, end: 300, rowsAt: () => [FAR] })], { ...expectation(), sourceSha256: 'f'.repeat(64) })
  const refused = evaluate(projection, [{ sourceArtifactId: 'source-1', stream: foreign }])
  assert.equal(refused.state, 'unknown'); assert.ok(refused.reasons.includes('UNTRUSTED_EVIDENCE_NEAR_CUE'))
})

test('spans are judged per clip: another source without evidence, or a hole in the timeline, makes the band unknown', () => {
  const other = { artifactId: 'source-2', width: 640, height: 360 }
  const clips = [
    { id: 'clip-1', sourceArtifactId: 'source-1', timelineInFrame: 0, timelineOutFrame: 110 },
    { id: 'clip-2', sourceArtifactId: 'source-2', timelineInFrame: 110, timelineOutFrame: 200 },
  ]
  const projection = model(LANDSCAPE, clips, [SOURCE, other])
  const evidence = [{ sourceArtifactId: 'source-1', stream: stream(() => [FAR]) }]
  const spanning = evaluate(projection, evidence)
  assert.equal(spanning.state, 'unknown')
  assert.deepEqual(spanning.evaluations.map((entry) => [entry.kind, entry.sourceArtifactId, entry.startFrame, entry.endFrame, entry.state]), [
    ['face-clearance', 'source-1', 100, 110, 'free-certified'],
    ['no-face-evidence', 'source-2', 110, 130, 'unknown'],
  ])
  // a cue entirely inside the evidenced clip is certified on that clip's evidence alone
  assert.equal(evaluate(projection, evidence, BAND, { startFrame: 20, endFrame: 60 }).state, 'free-certified')
  const hole = model(LANDSCAPE, [{ id: 'clip-1', sourceArtifactId: 'source-1', timelineInFrame: 0, timelineOutFrame: 110 }])
  const uncovered = evaluate(hole, evidence)
  assert.equal(uncovered.state, 'unknown')
  assert.deepEqual(uncovered.evaluations.map((entry) => entry.kind), ['face-clearance', 'timeline-not-covered'])
  // a face in the evidenced clip occupies even when another span is unknown: occupied wins
  const row = rowInsideBand(projection, BAND)
  const occupied = evaluate(projection, [{ sourceArtifactId: 'source-1', stream: stream((frame) => (frame === 105 ? [row] : [FAR])) }])
  assert.equal(occupied.state, 'occupied')
})

test('an unprojectable band is unknown and says why; duplicate sources are refused', () => {
  const result = unprojectableBandClearance(CUE, 'SOURCE_DIMENSIONS_UNKNOWN')
  assert.equal(result.state, 'unknown')
  assert.deepEqual(result.evaluations.map((entry) => [entry.kind, entry.startFrame, entry.endFrame, entry.reasons]), [['projection-unavailable', 100, 130, ['SOURCE_DIMENSIONS_UNKNOWN']]])
  const one = { sourceArtifactId: 'source-1', stream: stream(() => [FAR]) }
  assert.throws(() => evaluate(model(LANDSCAPE), [one, one]), /unique per source/)
})
