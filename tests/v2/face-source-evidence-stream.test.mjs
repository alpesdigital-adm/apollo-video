import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateFaceCaptionClearance } from '../../src/v2/domain/face-caption-clearance.ts'
import { collectFaceSourceEvidenceStream, sourceStreamForClearance } from '../../src/v2/domain/face-source-evidence-stream.ts'
import { acceptedProducer, sha } from './helpers/face-envelope-v2.mjs'
import { sealedSourceWindow, sourceExpectation } from './helpers/face-source-envelope-v3.mjs'

/**
 * W65b: the trusted, merged face evidence of one SOURCE, in SOURCE frames. It knows nothing about an edit: no project, no version,
 * no time map. The same envelopes build the same stream whichever EditPlan later reads them.
 */
const FACE = [[0.95, 0.35, 0.15, 0.65, 0.75]]
const clone = (value) => JSON.parse(JSON.stringify(value))

test('adjacent windows merge in source order and the stream hash ignores the order they were supplied in', () => {
  const first = sealedSourceWindow({ start: 0, end: 150, rowsAt: () => FACE })
  const second = sealedSourceWindow({ start: 150, end: 300, rowsAt: () => FACE })
  const stream = collectFaceSourceEvidenceStream([second, first], sourceExpectation())
  assert.equal(stream.schemaVersion, 'face-source-evidence-stream/v1')
  assert.equal(stream.samples.length, 60)
  assert.deepEqual(stream.samples.map((sample) => sample.sourceFrame), Array.from({ length: 60 }, (_unused, index) => index * 5))
  assert.deepEqual(stream.trustedWindows.map((window) => [window.startSourceFrame, window.endSourceFrame]), [[0, 150], [150, 300]])
  assert.deepEqual(stream.untrusted, [])
  assert.equal(stream.streamHash, collectFaceSourceEvidenceStream([first, second], sourceExpectation()).streamHash)
  assert.notEqual(stream.streamHash, collectFaceSourceEvidenceStream([first], sourceExpectation()).streamHash)
  assert.ok(stream.samples.every((sample) => sample.detections.length === 1 && sample.rawOutputSha256 !== null))
  assert.throws(() => { stream.samples[0].detections.push({}) }, TypeError)
})

test('the stream is the same for every edit that reads it: nothing about a project or a version is in it', () => {
  const window = sealedSourceWindow({ start: 0, end: 150, rowsAt: () => FACE })
  const stream = collectFaceSourceEvidenceStream([window], sourceExpectation())
  for (const key of ['projectId', 'projectVersionId', 'timeMapHash', 'timelineDurationFrames', 'timelineFps']) {
    assert.equal(key in stream, false, key)
  }
  assert.equal(stream.sourceArtifactId, 'source-1')
  assert.equal(stream.sourceSha256, sha('b'))
  assert.deepEqual({ ...stream.sourceFps }, { num: 30, den: 1 })
  // the same sealed window read for the same source twice is the same evidence
  assert.equal(collectFaceSourceEvidenceStream([window], sourceExpectation()).streamHash, stream.streamHash)
})

test('overlapping windows that agree are merged once; windows that contradict each other are both untrusted', () => {
  const left = sealedSourceWindow({ start: 0, end: 100, rowsAt: () => FACE })
  const agreeing = sealedSourceWindow({ start: 50, end: 150, rowsAt: () => FACE, id: 'face-source-envelope-agree' })
  const merged = collectFaceSourceEvidenceStream([left, agreeing], sourceExpectation())
  assert.equal(merged.samples.length, 30)
  assert.deepEqual(merged.untrusted, [])
  const contradicting = sealedSourceWindow({ start: 50, end: 150, rowsAt: () => [], id: 'face-source-envelope-conflict' })
  const conflict = collectFaceSourceEvidenceStream([left, contradicting], sourceExpectation())
  assert.equal(conflict.samples.length, 0)
  assert.equal(conflict.untrusted.length, 2)
  assert.ok(conflict.untrusted.every((entry) => entry.reasons.includes('EVIDENCE_CONFLICT')))
  assert.deepEqual(conflict.untrusted.map((entry) => [entry.startSourceFrame, entry.endSourceFrame]).sort((a, b) => a[0] - b[0]), [[0, 100], [50, 150]])
})

test('evidence for another workspace, source, bytes or clock is not used and its range is reported', () => {
  const window = sealedSourceWindow({ start: 0, end: 150, rowsAt: () => FACE })
  const reasons = (expected) => collectFaceSourceEvidenceStream([window], sourceExpectation(expected)).untrusted[0]?.reasons
  assert.deepEqual(reasons({ sourceSha256: sha('0') }), ['SOURCE_MISMATCH'])
  assert.deepEqual(reasons({ sourceArtifactId: 'source-2' }), ['SOURCE_MISMATCH'])
  assert.deepEqual(reasons({ workspaceId: 'workspace-2' }), ['SCOPE_MISMATCH'])
  assert.deepEqual(reasons({ sourceFps: { num: 25, den: 1 } }), ['CLOCK_MISMATCH'])
  const wrong = collectFaceSourceEvidenceStream([window], sourceExpectation({ sourceSha256: sha('0') }))
  assert.deepEqual([wrong.untrusted[0].startSourceFrame, wrong.untrusted[0].endSourceFrame], [0, 150])
  assert.equal(wrong.samples.length, 0)
})

test('a producer that was not accepted on that platform, or a forged seal, is never trusted', () => {
  // Linux is accepted only on the bytes its receipt names: a drifted interpreter is a valid envelope the registry does not authenticate.
  const linux = acceptedProducer('linux')
  linux.pythonExecutableSha256 = 'f'.repeat(64)
  const stream = collectFaceSourceEvidenceStream([sealedSourceWindow({ start: 0, end: 150, rowsAt: () => FACE, producer: linux })], sourceExpectation())
  assert.equal(stream.samples.length, 0)
  assert.deepEqual(stream.untrusted[0].reasons, ['PRODUCER_PYTHON_EXECUTABLE_PIN_MISMATCH'])
  const forged = clone(sealedSourceWindow({ start: 0, end: 150, rowsAt: () => [] }))
  forged.samples[0].boxes = clone(sealedSourceWindow({ start: 0, end: 5, rowsAt: () => FACE }).samples[0].boxes)
  const forgedStream = collectFaceSourceEvidenceStream([forged], sourceExpectation())
  assert.deepEqual(forgedStream.untrusted[0].reasons, ['ENVELOPE_SEAL_INVALID'])
  assert.equal(forgedStream.samples.length, 0)
  // a v2 (timeline-keyed) envelope is not a source window
  const notV3 = clone(sealedSourceWindow({ start: 0, end: 150 })); notV3.schemaVersion = 'face-producer-envelope/v2'
  assert.deepEqual(collectFaceSourceEvidenceStream([notV3], sourceExpectation()).untrusted[0].reasons, ['ENVELOPE_SEAL_INVALID'])
})

test('unknown samples stay in the stream as unknown, never as empty', () => {
  const stream = collectFaceSourceEvidenceStream([sealedSourceWindow({ start: 0, end: 20, rowsAt: (frame) => (frame === 5 ? 'unknown' : FACE) })], sourceExpectation())
  assert.deepEqual(stream.samples.map((sample) => sample.status), ['observed', 'unknown', 'observed', 'observed'])
  assert.deepEqual(stream.samples[1].detections, [])
  assert.equal(stream.samples[1].rawOutputSha256, null)
})

test('the clearance decision runs on the source stream unchanged: the cue is a range of SOURCE frames', () => {
  const area = (frames) => [{ startFrame: frames[0], endFrame: frames[1], bounds: { x: 0.3, y: 0.7, width: 0.4, height: 0.25 } }]
  // a face in the bottom area at source frames 200-215 only; the rest of the source is empty
  const stream = collectFaceSourceEvidenceStream([
    sealedSourceWindow({ start: 0, end: 150 }),
    sealedSourceWindow({ start: 150, end: 300, rowsAt: (frame) => (frame >= 200 && frame < 215 ? [[0.9, 0.35, 0.72, 0.65, 0.95]] : []) }),
  ], sourceExpectation({ sourceDurationFrames: 300 }))
  const clearance = sourceStreamForClearance(stream)
  const cue = (a, b) => ({ startFrame: a, endFrame: b })
  assert.equal(evaluateFaceCaptionClearance({ stream: clearance, cue: cue(40, 80), area: area([40, 80]) }).state, 'free-certified')
  assert.equal(evaluateFaceCaptionClearance({ stream: clearance, cue: cue(200, 210), area: area([200, 210]) }).state, 'occupied')
  // the same range of frames of a DIFFERENT part of the source is a different answer: the question is asked in source time
  assert.equal(evaluateFaceCaptionClearance({ stream: clearance, cue: cue(100, 130), area: area([100, 130]) }).state, 'free-certified')
  // no evidence past the last window -> unknown
  assert.equal(evaluateFaceCaptionClearance({ stream: clearance, cue: cue(296, 300), area: area([296, 300]) }).state, 'unknown')
  assert.equal(clearance.timelineDurationFrames, 300)
  assert.match(clearance.streamHash, /^[a-f0-9]{64}$/)
})
