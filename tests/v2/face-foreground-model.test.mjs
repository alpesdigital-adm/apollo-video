import assert from 'node:assert/strict'
import test from 'node:test'

import { collectFaceEvidenceStream } from '../../src/v2/domain/face-evidence-stream.ts'
import { deriveFaceForegroundModel } from '../../src/v2/domain/face-foreground-model.ts'
import { FACE_EVIDENCE_POLICY_SHA256 } from '../../src/v2/domain/face-evidence-policy.ts'
import { acceptedProducer, expectation, sealedWindow } from './helpers/face-envelope-v2.mjs'

// Rows are [score, xmin, ymin, xmax, ymax]. HEAD: height 0.60 (foreground). MEDIUM: 0.20. TINY: 0.04 (background).
const HEAD = [0.95, 0.35, 0.15, 0.65, 0.75]
const MEDIUM = [0.9, 0.70, 0.30, 0.85, 0.50]
const TINY = [0.9, 0.05, 0.40, 0.09, 0.44]
const scaled = (row, factor) => {
  const cx = (row[1] + row[3]) / 2, cy = (row[2] + row[4]) / 2, w = (row[3] - row[1]) * Math.sqrt(factor), h = (row[4] - row[2]) * Math.sqrt(factor)
  return [row[0], cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2]
}
const model = (rowsAt, { end = 300 } = {}) => deriveFaceForegroundModel(collectFaceEvidenceStream(
  [sealedWindow({ start: 0, end, rowsAt })], expectation()))
const states = (result, frame) => result.positions.find((position) => position.timelineFrame === frame)

test('a persistent large face is present, foreground and the speaker candidate for the whole window', () => {
  const result = model(() => [HEAD])
  assert.equal(result.positions.length, 60)
  assert.equal(result.tracks.length, 1)
  assert.equal(result.basis, 'largest-persistent-foreground-face')
  assert.ok(result.positions.every((position) => !position.insufficient && position.speakerTrackId === 'track-1'))
  const middle = states(result, 150)
  assert.equal(middle.tracks[0].persistence, 1)
  assert.equal(middle.tracks[0].present, true)
  assert.equal(middle.tracks[0].foreground, true)
  assert.deepEqual(result.speakerSegments, [{ trackId: 'track-1', startFrame: 0, endFrame: 296 }])
  assert.equal(result.policySha256, FACE_EVIDENCE_POLICY_SHA256)
})

test('a detection seen in a single sample is not a persistent face and elects no speaker', () => {
  const result = model((frame) => (frame === 100 ? [HEAD] : []))
  assert.equal(result.tracks.length, 1)
  assert.ok(result.positions.every((position) => position.speakerTrackId === null))
  assert.ok(result.positions.every((position) => position.tracks.every((track) => !track.present)))
  const near = states(result, 100)
  assert.equal(near.tracks[0].detectedSamples, 1)
  assert.ok(near.tracks[0].persistence < 0.5)
})

test('a small background face is present but not foreground, and never the speaker', () => {
  const result = model(() => [HEAD, TINY])
  const middle = states(result, 150)
  assert.equal(middle.tracks.length, 2)
  const tiny = middle.tracks.find((track) => track.medianHeight < 0.1)
  assert.equal(tiny.present, true)
  assert.equal(tiny.foreground, false)
  assert.equal(middle.speakerTrackId, middle.tracks.find((track) => track.foreground).trackId)
  assert.ok(result.positions.every((position) => position.speakerTrackId === 'track-1'))
})

test('persistence has hysteresis: it enters at 50%, survives down to 35% and leaves below it', () => {
  // Full for 150 frames, then detected in 2 of every 5 samples (isolated misses, ~40%), then in 1 of every 3 (~33%).
  const rowsAt = (frame) => {
    const index = frame / 5
    if (frame < 150) return [HEAD]
    if (frame < 240) return index % 5 === 0 || index % 5 === 2 ? [HEAD] : []
    return index % 3 === 0 ? [HEAD] : []
  }
  const result = model(rowsAt)
  const state = (frame) => states(result, frame).tracks.find((track) => track.trackId === 'track-1')
  assert.equal(state(100).present, true)
  for (const frame of [185, 200, 215, 230]) {
    assert.ok(state(frame).persistence >= 0.35 && state(frame).persistence < 0.5, `${frame}: ${state(frame).persistence}`)
    assert.equal(state(frame).present, true, `stays present at ${frame}: below the enter share but above the exit share`)
  }
  assert.equal(state(285)?.present ?? false, false, 'leaves once persistence falls under the exit share')
  // A steady share under the enter threshold (one sample in three, ~33%) never enters from a cold start, edges included.
  const cold = model((frame) => ((frame / 5) % 3 === 0 ? [HEAD] : []))
  assert.ok(cold.positions.every((position) => position.tracks.every((track) => !track.present)))
})

test('the speaker changes only after a larger challenger holds its lead for the policy duration', () => {
  // A: steady 0.18 area on the left. B: on the right, grows gradually from tiny to twice A's area.
  const A = [0.95, 0.10, 0.15, 0.40, 0.75]
  const grow = (frame, from, to) => {
    const t = Math.min(1, Math.max(0, (frame - from) / (to - from)))
    const scale = 0.4 + 0.6 * t
    return [0.9, 0.95 - 0.40 * scale, 0.95 - 0.90 * scale, 0.95, 0.95]
  }
  const brief = model((frame) => (frame >= 150 && frame < 170 ? [A, [0.9, 0.55, 0.05, 0.95, 0.95]] : [A, [0.9, 0.80, 0.70, 0.95, 0.95]]))
  assert.ok(brief.positions.every((position) => position.speakerTrackId === 'track-1'), 'a brief large face never leads the window median')
  const sustained = model((frame) => [A, grow(frame, 100, 150)])
  const challengerId = sustained.tracks.find((track) => track.trackId !== 'track-1').trackId
  const lead = (position) => {
    const a = position.tracks.find((track) => track.trackId === 'track-1')
    const b = position.tracks.find((track) => track.trackId === challengerId)
    return Boolean(a && b && b.present && b.foreground && b.medianArea >= a.medianArea * 1.25)
  }
  const firstLead = sustained.positions.find(lead)
  const switched = sustained.positions.find((position) => position.speakerTrackId === challengerId)
  assert.ok(firstLead && switched, 'the challenger leads and the speaker switches')
  assert.equal(switched.timelineFrame - firstLead.timelineFrame, 30, 'one second (30 frames) after the lead began')
  assert.ok(sustained.positions.filter((position) => position.timelineFrame < firstLead.timelineFrame + 30)
    .every((position) => position.speakerTrackId === 'track-1'))
  assert.deepEqual(sustained.speakerSegments.map((segment) => segment.trackId), ['track-1', challengerId])
  const [first, second] = sustained.speakerSegments
  assert.equal(first.endFrame, second.startFrame)
})

test('too few analysed samples in the window is insufficient evidence, not an empty scene', () => {
  const result = deriveFaceForegroundModel(collectFaceEvidenceStream([sealedWindow({ start: 0, end: 60,
    rowsAt: (frame) => (frame < 20 ? [HEAD] : 'unknown') })], expectation()))
  const late = states(result, 55)
  assert.equal(late.insufficient, true)
  assert.equal(late.speakerTrackId, null)
  assert.deepEqual(late.tracks, [])
  assert.ok(late.unknownSamples >= 1)
  assert.equal(states(result, 0).insufficient, false)
})

test('a track survives a missed sample but not a gap longer than the policy allows', () => {
  const survives = model((frame) => (frame >= 60 && frame < 70 ? [] : [HEAD]), { end: 150 })
  assert.equal(survives.tracks.length, 1, 'two missed samples (a 15-frame, 500 ms gap between detections) keep the track')
  const breaks = model((frame) => (frame >= 60 && frame < 75 ? [] : [HEAD]), { end: 150 })
  assert.equal(breaks.tracks.length, 2, 'three missed samples (a 20-frame, 667 ms gap) start a new track')
  const moved = model((frame) => (frame < 75 ? [HEAD] : [[0.95, 0.0, 0.0, 0.2, 0.2]]), { end: 150 })
  assert.equal(moved.tracks.length, 2, 'a detection that does not overlap the track is another face')
})

test('the model is deterministic and ignores evidence that is not trusted', () => {
  const window = sealedWindow({ start: 0, end: 150, rowsAt: () => [HEAD] })
  const a = deriveFaceForegroundModel(collectFaceEvidenceStream([window], expectation()))
  const b = deriveFaceForegroundModel(collectFaceEvidenceStream([window], expectation()))
  assert.equal(a.modelHash, b.modelHash)
  assert.notEqual(a.modelHash, model(() => [HEAD, MEDIUM], { end: 150 }).modelHash)
  const linux = acceptedProducer('win32')
  linux.runtime.platform = 'linux'
  const untrusted = deriveFaceForegroundModel(collectFaceEvidenceStream([sealedWindow({ start: 0, end: 150, rowsAt: () => [HEAD], producer: linux })], expectation()))
  assert.equal(untrusted.tracks.length, 0)
  assert.deepEqual(untrusted.positions, [])
  assert.deepEqual(untrusted.speakerSegments, [])
  assert.throws(() => { a.positions[0].tracks.push({}) }, TypeError)
})
