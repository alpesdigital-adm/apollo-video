import assert from 'node:assert/strict'
import test from 'node:test'

import { collectFaceEvidenceStream } from '../../src/v2/domain/face-evidence-stream.ts'
import { acceptedProducer, expectation, sealedWindow, sha } from './helpers/face-envelope-v2.mjs'

const FACE = [[0.95, 0.35, 0.15, 0.65, 0.75]]
const clone = (value) => JSON.parse(JSON.stringify(value))

test('adjacent windows merge in timeline order and the stream hash ignores the order they were supplied in', () => {
  const first = sealedWindow({ start: 0, end: 150, rowsAt: () => FACE })
  const second = sealedWindow({ start: 150, end: 300, rowsAt: () => FACE })
  const stream = collectFaceEvidenceStream([second, first], expectation())
  assert.equal(stream.samples.length, 60)
  assert.deepEqual(stream.samples.map((sample) => sample.timelineFrame), Array.from({ length: 60 }, (_unused, index) => index * 5))
  assert.deepEqual(stream.trustedWindows.map((window) => [window.startFrame, window.endFrame]), [[0, 150], [150, 300]])
  assert.deepEqual(stream.untrusted, [])
  assert.equal(stream.streamHash, collectFaceEvidenceStream([first, second], expectation()).streamHash)
  assert.notEqual(stream.streamHash, collectFaceEvidenceStream([first], expectation()).streamHash)
  assert.ok(stream.samples.every((sample) => sample.detections.length === 1 && sample.rawOutputSha256 !== null))
  assert.throws(() => { stream.samples[0].detections.push({}) }, TypeError)
})

test('overlapping windows that agree are merged once; windows that contradict each other are both untrusted', () => {
  const left = sealedWindow({ start: 0, end: 100, rowsAt: () => FACE })
  const agreeing = sealedWindow({ start: 50, end: 150, rowsAt: () => FACE, id: 'face-envelope-agree' })
  const merged = collectFaceEvidenceStream([left, agreeing], expectation())
  assert.equal(merged.samples.length, 30)
  assert.deepEqual(merged.untrusted, [])
  const contradicting = sealedWindow({ start: 50, end: 150, rowsAt: () => [], id: 'face-envelope-conflict' })
  const conflict = collectFaceEvidenceStream([left, contradicting], expectation())
  assert.equal(conflict.samples.length, 0)
  assert.equal(conflict.untrusted.length, 2)
  assert.ok(conflict.untrusted.every((entry) => entry.reasons.includes('EVIDENCE_CONFLICT')))
  assert.deepEqual(conflict.untrusted.map((entry) => [entry.startFrame, entry.endFrame]).sort((a, b) => a[0] - b[0]), [[0, 100], [50, 150]])
})

test('evidence for another source, version, timeline or policy is not used and its range is reported', () => {
  const window = sealedWindow({ start: 0, end: 150, rowsAt: () => FACE })
  const wrongSource = collectFaceEvidenceStream([window], { ...expectation(), sourceSha256: sha('0') })
  assert.deepEqual(wrongSource.untrusted[0].reasons, ['SOURCE_MISMATCH'])
  assert.deepEqual([wrongSource.untrusted[0].startFrame, wrongSource.untrusted[0].endFrame], [0, 150])
  assert.equal(wrongSource.samples.length, 0)
  assert.deepEqual(collectFaceEvidenceStream([window], { ...expectation(), projectVersionId: 'version-2' }).untrusted[0].reasons, ['SCOPE_MISMATCH'])
  assert.deepEqual(collectFaceEvidenceStream([window], { ...expectation(), timeMapHash: sha('0') }).untrusted[0].reasons, ['TIMELINE_MISMATCH'])
  assert.deepEqual(collectFaceEvidenceStream([window], { ...expectation(), timelineFps: { num: 25, den: 1 } }).untrusted[0].reasons, ['TIMELINE_MISMATCH'])
})

test('a producer that was not accepted on that platform, or a forged seal, is never trusted', () => {
  const linux = acceptedProducer('win32')
  linux.runtime.platform = 'linux'
  const stream = collectFaceEvidenceStream([sealedWindow({ start: 0, end: 150, rowsAt: () => FACE, producer: linux })], expectation())
  assert.equal(stream.samples.length, 0)
  assert.deepEqual(stream.untrusted[0].reasons, ['PRODUCER_RUNTIME_PLATFORM_NOT_PARITIED'])
  const forged = clone(sealedWindow({ start: 0, end: 150, rowsAt: () => [] }))
  forged.samples[0].boxes = clone(sealedWindow({ start: 0, end: 5, rowsAt: () => FACE }).samples[0].boxes)
  const forgedStream = collectFaceEvidenceStream([forged], expectation())
  assert.deepEqual(forgedStream.untrusted[0].reasons, ['ENVELOPE_SEAL_INVALID'])
  assert.equal(forgedStream.samples.length, 0)
})

test('unknown samples stay in the stream as unknown, never as empty', () => {
  const stream = collectFaceEvidenceStream([sealedWindow({ start: 0, end: 20, rowsAt: (frame) => (frame === 5 ? 'unknown' : FACE) })], expectation())
  assert.deepEqual(stream.samples.map((sample) => sample.status), ['observed', 'unknown', 'observed', 'observed'])
  assert.deepEqual(stream.samples[1].detections, [])
  assert.equal(stream.samples[1].rawOutputSha256, null)
})
