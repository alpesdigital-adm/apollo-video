import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  decodeFace0204Output, face0204OutputSha256, FACE0204_OUTPUT_BYTES, FACE0204_OUTPUT_POLICY_ID, FACE0204_OUTPUT_POLICY_SHA256,
} from '../../src/v2/domain/face-detector-output.ts'

// Vectors produced by running the OWNER-ACCEPTED V9 provider (w62-evaluate-openvino0204-v9.py) on synthetic tensors.
const fixture = JSON.parse(readFileSync(new URL('../fixtures/face0204-v9-provider-vectors.json', import.meta.url), 'utf8'))
const raw = (entry) => new Uint8Array(Buffer.from(entry.rawBase64, 'base64'))
const detections = (result) => result.detections.map((d) => ({ slotIndex: d.slotIndex, confidence: d.confidence,
  rawXYXY: [...d.rawXYXY], boxXYXY: [...d.boxXYXY], clipped: d.clipped, boundaryChanges: [...d.boundaryChanges] }))

test('the pinned provider identity matches the V9 provider that produced the vectors', () => {
  assert.equal(fixture.policySha256, FACE0204_OUTPUT_POLICY_SHA256)
  assert.equal(fixture.providerSha256, 'a469034c1fda0c1821e9fea6d8d13afdd4322a9eff4383de97c2078db3b8cabc')
  assert.equal(FACE0204_OUTPUT_POLICY_ID, 'w62-v9-visible-intersection-continuous/v1')
  assert.equal(fixture.scoreFloor, 0.5)
})

test('at the V9 floor the decoder equals the V9 provider on every vector, including its failures and slots', () => {
  assert.ok(fixture.cases.length >= 25)
  for (const entry of fixture.cases) {
    const bytes = raw(entry)
    assert.equal(bytes.byteLength, FACE0204_OUTPUT_BYTES)
    assert.equal(face0204OutputSha256(bytes), entry.rawSha256, entry.name)
    const result = decodeFace0204Output(bytes, 0.5)
    if (entry.v9.status === 'failed') {
      assert.deepEqual({ status: result.status, reason: result.reason, slot: result.slot },
        { status: 'failed', reason: entry.v9.reason, slot: entry.v9.slot }, entry.name)
    } else {
      assert.equal(result.status, 'decoded', entry.name)
      assert.deepEqual(detections(result), entry.v9.detections, entry.name)
    }
  }
})

test('the collection floor keeps the V9 subset: filtering the 0.20 list at 0.50 reproduces V9 exactly', () => {
  for (const entry of fixture.cases.filter((item) => item.v9.status === 'decoded')) {
    const collected = decodeFace0204Output(raw(entry), 0.2)
    if (collected.status === 'failed') {
      // A low-score row below 0.50 that V9 never looked at is invalid: the stricter floor fails the frame, never repairs it.
      assert.match(entry.name, /^low-score-/, entry.name)
      continue
    }
    assert.deepEqual(detections({ detections: collected.detections.filter((d) => d.confidence >= 0.5) }), entry.v9.detections, entry.name)
    assert.ok(collected.detections.length >= entry.v9.detections.length)
  }
  const full = fixture.cases.find((item) => item.name === 'two-hundred-slots-full')
  assert.ok(decodeFace0204Output(raw(full), 0.2).detections.length > decodeFace0204Output(raw(full), 0.5).detections.length)
})

test('an invalid row between 0.20 and 0.50 fails the frame at the collection floor but not at the V9 floor', () => {
  for (const name of ['low-score-invalid-box-ignored-by-v9', 'low-score-nan-box-ignored-by-v9']) {
    const entry = fixture.cases.find((item) => item.name === name)
    assert.equal(decodeFace0204Output(raw(entry), 0.5).status, 'decoded', name)
    const strict = decodeFace0204Output(raw(entry), 0.2)
    assert.equal(strict.status, 'failed', name)
    assert.equal(strict.slot, 0)
  }
})

test('clipping is numeric and exact: touching an edge is not clipping, leaving it is', () => {
  const byName = (name) => decodeFace0204Output(raw(fixture.cases.find((item) => item.name === name)), 0.5).detections[0]
  assert.equal(byName('exact-edges-not-clipped').clipped, false)
  assert.deepEqual([...byName('exact-edges-not-clipped').boundaryChanges], [])
  assert.deepEqual([...byName('clipped-left-top').boundaryChanges], ['left', 'top'])
  assert.deepEqual([...byName('clipped-right-bottom').boundaryChanges], ['right', 'bottom'])
  assert.equal(byName('clipped-left-top').boxXYXY[0], 0)
  assert.ok(byName('clipped-left-top').rawXYXY[0] < 0)
})

test('a wrong-size, non-bytes or out-of-range-floor input fails closed instead of reading garbage', () => {
  assert.equal(decodeFace0204Output(new Uint8Array(5599), 0.5).reason, 'DETECTOR_OUTPUT_SIZE_INVALID')
  assert.equal(decodeFace0204Output(new Uint8Array(5601), 0.5).status, 'failed')
  assert.equal(decodeFace0204Output([], 0.5).status, 'failed')
  assert.equal(decodeFace0204Output(new Uint8Array(5600), Number.NaN).status, 'failed')
  assert.equal(decodeFace0204Output(new Uint8Array(5600), 1.5).status, 'failed')
  // An all-zero tensor is not padding: image_id 0, label 0, score 0 below the floor is a valid empty frame...
  assert.deepEqual(decodeFace0204Output(new Uint8Array(5600), 0.5).detections, [])
  // ...but at floor 0 the zero-area box is invalid, so the frame fails.
  assert.equal(decodeFace0204Output(new Uint8Array(5600), 0).reason, 'DETECTOR_FACE_BOX_REVERSED_OR_ZERO_AREA')
})

test('decoded detections are immutable', () => {
  const result = decodeFace0204Output(raw(fixture.cases.find((item) => item.name === 'one-clean-box')), 0.5)
  assert.throws(() => { result.detections[0].boxXYXY[0] = 0 }, TypeError)
  assert.throws(() => { result.detections.push({}) }, TypeError)
})
