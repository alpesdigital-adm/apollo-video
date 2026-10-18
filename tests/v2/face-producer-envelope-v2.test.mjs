import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createFaceProducerEnvelopeV2, faceSampleMatchesRawOutput } from '../../src/v2/domain/face-producer-envelope-v2.ts'
import {
  FACE_EVIDENCE_POLICY, FACE_EVIDENCE_POLICY_SHA256, FACE_V9_OWNER_ACCEPTANCE_DOCUMENT, FACE_V9_OWNER_ACCEPTANCE_SHA256,
  faceSampleIntervalFrames, faceWindowFrames, maxSampleGapFrames,
} from '../../src/v2/domain/face-evidence-policy.ts'
import { ACCEPTED_FACE_PRODUCERS, authenticateFaceEnvelope, authenticateFaceProducer, faceWorkerPlatformAccepted } from '../../src/v2/domain/face-producer-registry.ts'
import { acceptedProducer, envelopeInput, observedSample, sha, unknownSample } from './helpers/face-envelope-v2.mjs'

const clone = (value) => JSON.parse(JSON.stringify(value))

test('the pinned policy hash and the owner acceptance document are content-addressed', () => {
  assert.equal(FACE_EVIDENCE_POLICY_SHA256, calculateCanonicalHash(FACE_EVIDENCE_POLICY))
  assert.match(FACE_EVIDENCE_POLICY_SHA256, /^[a-f0-9]{64}$/)
  const bytes = readFileSync(new URL(`../../${FACE_V9_OWNER_ACCEPTANCE_DOCUMENT}`, import.meta.url))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), FACE_V9_OWNER_ACCEPTANCE_SHA256)
  assert.equal(FACE_EVIDENCE_POLICY.claims.qualification, false)
  assert.equal(FACE_EVIDENCE_POLICY.claims.faceSafety, 'unknown')
  assert.equal(FACE_EVIDENCE_POLICY.developmentEvidence.scope, 'post-hoc-adaptive-development-not-qualification')
  assert.throws(() => { FACE_EVIDENCE_POLICY.clearance.scoreMin = 0.9 }, TypeError)
  // Operating point decided by the coordinator and the analysis.
  assert.equal(FACE_EVIDENCE_POLICY.evidence.scoreMin, 0.5)
  assert.equal(FACE_EVIDENCE_POLICY.clearance.scoreMin, 0.2)
  assert.equal(FACE_EVIDENCE_POLICY.evidence.foregroundMinHeightFraction, 0.1)
  assert.equal(FACE_EVIDENCE_POLICY.evidence.persistence.enter, 0.5)
  assert.deepEqual(FACE_EVIDENCE_POLICY.clearance.dilation, { largerSideFraction: 0.35, minFrameFraction: 0.015 })
  assert.equal(FACE_EVIDENCE_POLICY.clearance.maxSampleGapMs, 500)
})

test('sampling follows the policy: 6 Hz, windows of at most 300 frames and 60 samples, gaps within 0.5 s', () => {
  assert.equal(faceSampleIntervalFrames({ num: 30, den: 1 }), 5)
  assert.equal(faceSampleIntervalFrames({ num: 60, den: 1 }), 10)
  assert.equal(faceSampleIntervalFrames({ num: 24, den: 1 }), 4)
  assert.equal(faceSampleIntervalFrames({ num: 30000, den: 1001 }), 5)
  assert.equal(faceSampleIntervalFrames({ num: 1, den: 1 }), 1)
  assert.equal(faceWindowFrames(5), 300)
  assert.equal(faceWindowFrames(4), 240)
  assert.equal(faceWindowFrames(10), 300)
  assert.equal(maxSampleGapFrames({ num: 30, den: 1 }), 15)
  assert.equal(maxSampleGapFrames({ num: 60, den: 1 }), 30)
  assert.equal(maxSampleGapFrames({ num: 30000, den: 1001 }), 14)
  for (const num of [24, 25, 30, 48, 50, 60, 100, 120]) {
    const fps = { num, den: 1 }, interval = faceSampleIntervalFrames(fps)
    assert.ok(interval <= maxSampleGapFrames(fps), `${num} fps stride fits the gap`)
    assert.ok(faceWindowFrames(interval) / interval <= 60)
  }
})

test('a window of sampled V9 detections seals without safety authority and is immutable', () => {
  const input = envelopeInput({ start: 0, end: 150 })
  const envelope = createFaceProducerEnvelopeV2(input)
  assert.equal(envelope.schemaVersion, 'face-producer-envelope/v2')
  assert.equal(envelope.authority, 'server-produced')
  assert.equal(envelope.coverage, 'sampled-only')
  assert.equal(envelope.faceSafety, 'unknown')
  assert.equal(envelope.identity, 'not-performed')
  assert.equal(envelope.producer.assessment.status, 'owner-accepted-scoped')
  assert.equal(envelope.producer.assessment.independentConfirmation, 'not-performed')
  assert.equal(envelope.timeMapHash, calculateCanonicalHash(input.timeMap))
  assert.equal(envelope.detectorConfigHash, calculateCanonicalHash(input.detectorConfig))
  assert.equal(envelope.envelopeHash, calculateCanonicalHash(Object.fromEntries(Object.entries(envelope)
    .filter(([key]) => key !== 'envelopeHash'))))
  assert.equal(envelope.samples.length, 30)
  assert.equal(envelope.gaps.length, 30)
  assert.throws(() => { envelope.samples[0].boxes.push({}) }, TypeError)
  assert.notEqual(createFaceProducerEnvelopeV2(envelopeInput({ start: 150, end: 300 })).envelopeHash, envelope.envelopeHash)
})

test('windows of up to 60 samples are accepted and a 61st is not', () => {
  const sixty = envelopeInput({ start: 0, end: 300, interval: 5, timelineDurationFrames: 600 })
  assert.equal(createFaceProducerEnvelopeV2(sixty).samples.length, 60)
  const tooMany = envelopeInput({ start: 0, end: 300, interval: 5, timelineDurationFrames: 600 })
  tooMany.samples.push(observedSample({ timelineFrame: 300 }).sample)
  assert.throws(() => createFaceProducerEnvelopeV2(tooMany), /sample policy|exactly cover/)
  // The window length is bounded by itself, whatever the samples: 300 frames, and 60 strides of the declared interval.
  assert.throws(() => createFaceProducerEnvelopeV2(envelopeInput({ start: 0, end: 301, interval: 5, timelineDurationFrames: 600, samples: [] })), /window is invalid/)
  assert.throws(() => createFaceProducerEnvelopeV2(envelopeInput({ start: 0, end: 241, interval: 4, timelineDurationFrames: 600, samples: [] })), /window is invalid/)
  assert.doesNotThrow(() => createFaceProducerEnvelopeV2(envelopeInput({ start: 0, end: 240, interval: 4, timelineDurationFrames: 600, samples: [] })))
})

test('the envelope refuses any seal outside the pinned policy, detector, owner scope and window', () => {
  const mutate = (change, pattern) => {
    const input = clone(envelopeInput({ start: 0, end: 150 }))
    change(input)
    assert.throws(() => createFaceProducerEnvelopeV2(input), pattern)
  }
  mutate((i) => { i.policySha256 = sha('0') }, /pinned face evidence policy/)
  mutate((i) => { i.policyId = 'other' }, /pinned face evidence policy/)
  mutate((i) => { i.detectorConfig.inputWidth = 640 }, /detector config is invalid/)
  mutate((i) => { i.detectorConfig.collectionScoreFloor = 0.5 }, /detector config is invalid/)
  mutate((i) => { i.detectorConfig.backend = 'opencv-dnn-cpu' }, /detector config is invalid/)
  mutate((i) => { i.producer.assessment.status = 'approved' }, /cannot grant approval/)
  mutate((i) => { i.producer.assessment.ownerAcceptanceSha256 = sha('0') }, /cannot grant approval/)
  mutate((i) => { i.producer.assessment.independentConfirmation = 'performed' }, /cannot grant approval/)
  mutate((i) => { i.producer.assessment.runtimeParity = { status: 'passed', receiptSha256: null } }, /cannot grant approval/)
  mutate((i) => { i.producer.assessment.runtimeParity = { status: 'pending', receiptSha256: sha('1') } }, /cannot grant approval/)
  mutate((i) => { i.producer.outputPolicy.sha256 = sha('0') }, /provenance is incomplete/)
  mutate((i) => { i.producer.model.sourceCommit = 'xyz' }, /provenance is incomplete/)
  mutate((i) => { delete i.producer.runtime.numpyVersion }, /unsupported or missing/)
  mutate((i) => { i.faceSafety = 'verified' }, /unsupported or missing/)
  mutate((i) => { i.samplePolicy.maxSamples = 30 }, /sample policy is invalid/)
  mutate((i) => { i.timeMap.push({ ...i.timeMap[0] }) }, /exactly one unit-rate clip/)
  mutate((i) => { i.timeMap[0].rate = 2 }, /unit-rate/)
  mutate((i) => { i.timeMap[0].timelineOutFrame = 299 }, /covering the timeline|unit-rate/)
  mutate((i) => { i.window.endTimelineFrame = 301 }, /window is invalid/)
})

test('samples are checked against their window, alignment, PTS, geometry, boxes and raw output', () => {
  const mutate = (change, pattern) => {
    const input = clone(envelopeInput({ start: 0, end: 150 }))
    change(input)
    assert.throws(() => createFaceProducerEnvelopeV2(input), pattern)
  }
  mutate((i) => { i.samples[1].sourcePts += 5 }, /source mapping/)
  mutate((i) => { i.samples[1].frameWidth = 640 }, /source mapping/)
  mutate((i) => { i.samples[1].sourceFrame = 6; i.samples[1].timelineFrame = 6 }, /source mapping/)
  mutate((i) => { i.samples[0].timelineFrame = 1; i.samples[0].sourceFrame = 1 }, /source mapping/)
  mutate((i) => { i.samples[2].rawOutput = null }, /must bind its raw detector output/)
  mutate((i) => { i.samples[2].rawOutput.bytes = 5599 }, /raw output reference/)
  mutate((i) => { i.samples[2].reasonCode = 'BAD' }, /cannot carry an error/)
  mutate((i) => { i.gaps.pop() }, /exactly cover the window/)
  mutate((i) => { i.gaps[0].endTimelineFrame = 4 }, /exactly cover the window/)
  mutate((i) => { i.gaps[0].startTimelineFrame = 0; i.gaps[0].endTimelineFrame = 5 }, /exactly cover the window|gap is invalid/)
  const withBox = observedSample({ timelineFrame: 5, rows: [[0.9, 0.1, 0.1, 0.3, 0.4]] }).sample
  const base = () => clone(envelopeInput({ start: 0, end: 10, samples: [observedSample({ timelineFrame: 0 }).sample, withBox] }))
  assert.doesNotThrow(() => createFaceProducerEnvelopeV2(base()))
  const lowScore = base(); lowScore.samples[1].boxes[0].confidence = 0.19
  assert.throws(() => createFaceProducerEnvelopeV2(lowScore), /box is invalid/)
  const reversed = base(); reversed.samples[1].boxes[0].boxXYXY = [0.4, 0.1, 0.1, 0.4]
  assert.throws(() => createFaceProducerEnvelopeV2(reversed), /box is invalid/)
  const outside = base(); outside.samples[1].boxes[0].boxXYXY = [0.1, 0.1, 1.2, 0.4]
  assert.throws(() => createFaceProducerEnvelopeV2(outside), /box is invalid/)
  const identity = base(); identity.samples[1].boxes[0].identity = 'person-1'
  assert.throws(() => createFaceProducerEnvelopeV2(identity), /unsupported or missing/)
})

test('an unknown sample keeps no boxes and never turns into an absence of faces', () => {
  const input = envelopeInput({ start: 0, end: 10, samples: [observedSample({ timelineFrame: 0 }).sample,
    unknownSample({ timelineFrame: 5 })] })
  const envelope = createFaceProducerEnvelopeV2(input)
  assert.equal(envelope.samples[1].status, 'unknown')
  assert.deepEqual(envelope.samples[1].boxes, [])
  assert.equal(envelope.faceSafety, 'unknown')
  const forged = clone(input); forged.samples[1].boxes = [observedSample({ timelineFrame: 5, rows: [[0.9, 0.1, 0.1, 0.3, 0.4]] }).sample.boxes[0]]
  assert.throws(() => createFaceProducerEnvelopeV2(forged), /cannot contain boxes/)
})

test('stored boxes must be reproducible from the retained raw detector output', () => {
  const rows = [[0.91, 0.1, 0.2, 0.4, 0.7], [0.35, 0.5, 0.5, 0.9, 0.9], [0.75, -0.05, 0.0, 0.3, 0.4]]
  const { sample, raw } = observedSample({ timelineFrame: 0, rows })
  assert.equal(sample.boxes.length, 3)
  assert.equal(sample.boxes[2].clipped, true)
  assert.equal(faceSampleMatchesRawOutput(sample, raw), true)
  const forged = clone(sample); forged.boxes[0].boxXYXY = [0.1, 0.2, 0.4, 0.71]
  assert.equal(faceSampleMatchesRawOutput(forged, raw), false)
  const dropped = clone(sample); dropped.boxes.pop()
  assert.equal(faceSampleMatchesRawOutput(dropped, raw), false)
  assert.equal(faceSampleMatchesRawOutput(sample, new Uint8Array(5599)), false)
  assert.equal(faceSampleMatchesRawOutput(unknownSample({ timelineFrame: 0 }), raw), false)
})

test('only the accepted producer on an accepted, parity-proven platform is authenticated', () => {
  assert.equal(authenticateFaceProducer(acceptedProducer('win32')).authenticated, true)
  assert.equal(ACCEPTED_FACE_PRODUCERS.length, 1)
  assert.equal(faceWorkerPlatformAccepted('win32'), true)
  // Linux has no parity receipt yet: envelopes still read as data but never authenticate, and the worker may not start.
  assert.equal(faceWorkerPlatformAccepted('linux'), false)
  const linux = acceptedProducer('win32')
  linux.runtime.platform = 'linux'
  assert.deepEqual(authenticateFaceProducer(linux).reasons, ['RUNTIME_PLATFORM_NOT_PARITIED'])
  const mutate = (change) => { const producer = clone(acceptedProducer('win32')); change(producer); return authenticateFaceProducer(producer) }
  assert.deepEqual(mutate((p) => { p.runtime.openvinoVersion = '2026.5.0' }).reasons, ['RUNTIME_VERSION_MISMATCH'])
  assert.deepEqual(mutate((p) => { p.runtime.numpyVersion = '2.6.0' }).reasons, ['RUNTIME_VERSION_MISMATCH'])
  assert.deepEqual(mutate((p) => { p.assessment.runtimeParity = { status: 'pending', receiptSha256: null } }).reasons, ['RUNTIME_PARITY_MISMATCH'])
  assert.deepEqual(mutate((p) => { p.assessment.runtimeParity.receiptSha256 = sha('9') }).reasons, ['RUNTIME_PARITY_MISMATCH'])
  assert.ok(mutate((p) => { p.model.binSha256 = sha('9') }).reasons.includes('MODEL_BINSHA256_MISMATCH'))
  assert.ok(mutate((p) => { p.model.licenseSha256 = sha('9') }).reasons.includes('MODEL_LICENSESHA256_MISMATCH'))
  assert.ok(mutate((p) => { p.outputPolicy.sha256 = sha('9') }).reasons.includes('OUTPUT_POLICY_MISMATCH'))
  assert.ok(mutate((p) => { p.assessment.v9ReceiptSha256 = sha('9') }).reasons.includes('ASSESSMENT_MISMATCH'))
  assert.deepEqual(mutate((p) => { p.model.xmlSha256 = sha('9') }).reasons, ['PRODUCER_NOT_ACCEPTED'])
  assert.equal(authenticateFaceEnvelope(createFaceProducerEnvelopeV2(envelopeInput())).authenticated, true)
})
