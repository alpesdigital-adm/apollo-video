import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { faceSampleIntervalFrames, faceWindowFrames } from '../../src/v2/domain/face-evidence-policy.ts'
import { createFaceProducerEnvelopeV3, FACE_SOURCE_ENVELOPE_MAX_SOURCE_FRAMES } from '../../src/v2/domain/face-producer-envelope-v3.ts'
import { faceSampleMatchesRawOutput } from '../../src/v2/domain/face-producer-envelope-v2.ts'
import { authenticateFaceEnvelope } from '../../src/v2/domain/face-producer-registry.ts'
import { acceptedProducer, sha } from './helpers/face-envelope-v2.mjs'
import { sourceSample, sourceSampleWithRaw, sourceUnknownSample, sourceWindowInput } from './helpers/face-source-envelope-v3.mjs'

/**
 * W65b: the face window envelope is keyed by the SOURCE. It carries no project, no version, no EditPlan and no time map: the same
 * bytes seen by the same detector are the same evidence whatever edit later uses them.
 */
const clone = (value) => JSON.parse(JSON.stringify(value))

test('a window of source frames seals without safety authority, without any edit, and is immutable', () => {
  const input = sourceWindowInput({ start: 0, end: 150 })
  const envelope = createFaceProducerEnvelopeV3(input)
  assert.equal(envelope.schemaVersion, 'face-producer-envelope/v3')
  assert.equal(envelope.authority, 'server-produced')
  assert.equal(envelope.coverage, 'sampled-only')
  assert.equal(envelope.faceSafety, 'unknown')
  assert.equal(envelope.identity, 'not-performed')
  assert.equal(envelope.producer.assessment.status, 'owner-accepted-scoped')
  assert.equal(envelope.detectorConfigHash, calculateCanonicalHash(input.detectorConfig))
  assert.equal(envelope.envelopeHash, calculateCanonicalHash(Object.fromEntries(Object.entries(envelope).filter(([key]) => key !== 'envelopeHash'))))
  assert.equal(envelope.samples.length, 30)
  assert.equal(envelope.gaps.length, 30)
  assert.deepEqual({ ...envelope.window }, { startSourceFrame: 0, endSourceFrame: 150 })
  for (const key of ['projectId', 'projectVersionId', 'editPlanSnapshotId', 'editPlanSnapshotHash', 'timeMap', 'timeMapHash', 'timelineDurationFrames', 'timelineFps']) {
    assert.equal(key in envelope, false, `no ${key}: the evidence does not belong to an edit`)
  }
  assert.equal('timelineFrame' in envelope.samples[0], false)
  assert.throws(() => { envelope.samples[0].boxes.push({}) }, TypeError)
  assert.notEqual(createFaceProducerEnvelopeV3(sourceWindowInput({ start: 150, end: 300 })).envelopeHash, envelope.envelopeHash)
  // sealing is deterministic
  assert.equal(createFaceProducerEnvelopeV3(sourceWindowInput({ start: 0, end: 150 })).envelopeHash, envelope.envelopeHash)
})

test('a window may start anywhere in the source and is bounded by the policy, not by a timeline', () => {
  // the source's own frames: a window deep inside a long source is fine
  const deep = createFaceProducerEnvelopeV3(sourceWindowInput({ start: 90_000, end: 90_150 }))
  assert.equal(deep.samples[0].sourceFrame, 90_000)
  assert.equal(createFaceProducerEnvelopeV3(sourceWindowInput({ start: 0, end: 300, interval: 5 })).samples.length, 60)
  // an unaligned start still samples only the multiples of the interval
  const unaligned = createFaceProducerEnvelopeV3(sourceWindowInput({ start: 7, end: 40 }))
  assert.deepEqual(unaligned.samples.map((sample) => sample.sourceFrame), [10, 15, 20, 25, 30, 35])
  assert.throws(() => createFaceProducerEnvelopeV3(sourceWindowInput({ start: 0, end: 301, samples: [] })), /window is invalid/)
  assert.throws(() => createFaceProducerEnvelopeV3(sourceWindowInput({ start: 0, end: 241, interval: 4, samples: [], overrides: { sourceFps: { num: 24, den: 1 }, sourceTimebase: { num: 1, den: 12288 } } })), /window is invalid/)
  assert.throws(() => createFaceProducerEnvelopeV3(sourceWindowInput({ start: 10, end: 10, samples: [] })), /window is invalid/)
  assert.throws(() => createFaceProducerEnvelopeV3(sourceWindowInput({ start: FACE_SOURCE_ENVELOPE_MAX_SOURCE_FRAMES, end: FACE_SOURCE_ENVELOPE_MAX_SOURCE_FRAMES + 10, samples: [] })), /window is invalid|context is invalid/)
  const tooMany = sourceWindowInput({ start: 0, end: 300, interval: 5 })
  tooMany.samples.push(sourceSample({ sourceFrame: 300 }))
  assert.throws(() => createFaceProducerEnvelopeV3(tooMany), /sample policy|exactly cover|window/)
})

test('the cadence is the policy cadence of the source frame rate, never a free choice', () => {
  assert.equal(faceSampleIntervalFrames({ num: 30, den: 1 }), 5)
  assert.equal(faceWindowFrames(5), 300)
  const wrongInterval = sourceWindowInput({ start: 0, end: 150, interval: 6 })
  assert.throws(() => createFaceProducerEnvelopeV3(wrongInterval), /sample policy is invalid/)
  const sixtyFps = sourceWindowInput({ start: 0, end: 150, interval: 10, overrides: { sourceFps: { num: 60, den: 1 }, sourceTimebase: { num: 1, den: 30720 } } })
  assert.doesNotThrow(() => createFaceProducerEnvelopeV3(sixtyFps))
  const fractional = sourceWindowInput({ start: 0, end: 150, interval: 5, overrides: { sourceFps: { num: 30000, den: 1001 }, sourceTimebase: { num: 1, den: 30000 } } })
  assert.throws(() => createFaceProducerEnvelopeV3(fractional), /only an integer frame rate/)
})

test('the envelope refuses any seal outside the pinned policy, detector, owner scope, scope fields and window', () => {
  const mutate = (change, pattern) => {
    const input = clone(sourceWindowInput({ start: 0, end: 150 }))
    change(input)
    assert.throws(() => createFaceProducerEnvelopeV3(input), pattern)
  }
  mutate((i) => { i.policySha256 = sha('0') }, /pinned face evidence policy/)
  mutate((i) => { i.policyId = 'other' }, /pinned face evidence policy/)
  mutate((i) => { i.detectorConfig.inputWidth = 640 }, /detector config is invalid/)
  mutate((i) => { i.detectorConfig.collectionScoreFloor = 0.5 }, /detector config is invalid/)
  mutate((i) => { i.producer.assessment.status = 'approved' }, /cannot grant approval/)
  mutate((i) => { i.producer.assessment.ownerAcceptanceSha256 = sha('0') }, /cannot grant approval/)
  mutate((i) => { i.producer.assessment.independentConfirmation = 'performed' }, /cannot grant approval/)
  mutate((i) => { i.producer.outputPolicy.sha256 = sha('0') }, /provenance is incomplete/)
  mutate((i) => { i.faceSafety = 'verified' }, /unsupported or missing/)
  // the scope of an edit has no place in a source-keyed seal
  mutate((i) => { i.projectId = 'project-1' }, /unsupported or missing/)
  mutate((i) => { i.projectVersionId = 'version-1' }, /unsupported or missing/)
  mutate((i) => { i.timeMap = [] }, /unsupported or missing/)
  mutate((i) => { i.editPlanSnapshotHash = sha('c') }, /unsupported or missing/)
  mutate((i) => { i.timelineFps = { num: 30, den: 1 } }, /unsupported or missing/)
  mutate((i) => { delete i.sourceSha256 }, /unsupported or missing/)
  mutate((i) => { i.sourceSha256 = 'not-a-hash' }, /must be SHA-256/)
  mutate((i) => { i.sourceArtifactId = '' }, /sourceArtifactId is invalid/)
  mutate((i) => { i.window.startTimelineFrame = 0 }, /unsupported or missing/)
  mutate((i) => { i.sourceWidth = 0 }, /context is invalid/)
  mutate((i) => { i.sourceOrientation = 'rotation-90' }, /context is invalid/)
  mutate((i) => { i.sourceClock = 'variable-frame-rate' }, /context is invalid/)
  mutate((i) => { i.samplePolicy.maxSamples = 30 }, /sample policy is invalid/)
})

test('samples are checked against their window, alignment, PTS, geometry, boxes and raw output - in source frames', () => {
  const mutate = (change, pattern) => {
    const input = clone(sourceWindowInput({ start: 0, end: 150 }))
    change(input)
    assert.throws(() => createFaceProducerEnvelopeV3(input), pattern)
  }
  mutate((i) => { i.samples[1].sourcePts += 5 }, /source mapping/)
  mutate((i) => { i.samples[1].frameWidth = 640 }, /source mapping/)
  mutate((i) => { i.samples[1].sourceFrame = 6 }, /source mapping/)
  mutate((i) => { i.samples[0].sourceFrame = 1 }, /source mapping/)
  mutate((i) => { i.samples[2].sourceFrame = i.samples[1].sourceFrame }, /source mapping/)
  mutate((i) => { i.samples[0].timelineFrame = 0 }, /unsupported or missing/)
  mutate((i) => { i.samples[2].rawOutput = null }, /must bind its raw detector output/)
  mutate((i) => { i.samples[2].rawOutput.bytes = 5599 }, /raw output reference/)
  mutate((i) => { i.samples[2].reasonCode = 'BAD' }, /cannot carry an error/)
  mutate((i) => { i.gaps.pop() }, /exactly cover the window/)
  mutate((i) => { i.gaps[0].endSourceFrame = 4 }, /exactly cover the window/)
  mutate((i) => { i.gaps[0].endTimelineFrame = 5 }, /unsupported or missing/)
  mutate((i) => { i.samples.push(sourceSample({ sourceFrame: 150 })) }, /source mapping|exactly cover/)
  const withBox = sourceSample({ sourceFrame: 5, rows: [[0.9, 0.1, 0.1, 0.3, 0.4]] })
  const base = () => clone(sourceWindowInput({ start: 0, end: 10, samples: [sourceSample({ sourceFrame: 0 }), withBox] }))
  assert.doesNotThrow(() => createFaceProducerEnvelopeV3(base()))
  const lowScore = base(); lowScore.samples[1].boxes[0].confidence = 0.19
  assert.throws(() => createFaceProducerEnvelopeV3(lowScore), /box is invalid/)
  const reversed = base(); reversed.samples[1].boxes[0].boxXYXY = [0.4, 0.1, 0.1, 0.4]
  assert.throws(() => createFaceProducerEnvelopeV3(reversed), /box is invalid/)
  const identity = base(); identity.samples[1].boxes[0].identity = 'person-1'
  assert.throws(() => createFaceProducerEnvelopeV3(identity), /unsupported or missing/)
})

test('an unknown sample keeps no boxes and never turns into an absence of faces', () => {
  const input = sourceWindowInput({ start: 0, end: 10, samples: [sourceSample({ sourceFrame: 0 }), sourceUnknownSample({ sourceFrame: 5 })] })
  const envelope = createFaceProducerEnvelopeV3(input)
  assert.equal(envelope.samples[1].status, 'unknown')
  assert.deepEqual(envelope.samples[1].boxes, [])
  const forged = clone(input)
  forged.samples[1].boxes = [sourceSample({ sourceFrame: 5, rows: [[0.9, 0.1, 0.1, 0.3, 0.4]] }).boxes[0]]
  assert.throws(() => createFaceProducerEnvelopeV3(forged), /cannot contain boxes/)
})

test('stored boxes are reproducible from the retained raw output, and the producer authenticates exactly as before', () => {
  const rows = [[0.91, 0.1, 0.2, 0.4, 0.7], [0.35, 0.5, 0.5, 0.9, 0.9]]
  const { sample, raw } = sourceSampleWithRaw({ sourceFrame: 40, rows })
  assert.equal(faceSampleMatchesRawOutput(sample, raw), true, 'the raw-output check does not depend on any timeline field')
  const forged = clone(sample); forged.boxes[0].boxXYXY = [0.1, 0.2, 0.4, 0.71]
  assert.equal(faceSampleMatchesRawOutput(forged, raw), false)
  const envelope = createFaceProducerEnvelopeV3(sourceWindowInput({ start: 0, end: 150 }))
  assert.equal(authenticateFaceEnvelope(envelope).authenticated, true)
  const linux = acceptedProducer('linux'); linux.pythonExecutableSha256 = 'f'.repeat(64)
  assert.deepEqual(authenticateFaceEnvelope(createFaceProducerEnvelopeV3(sourceWindowInput({ start: 0, end: 150, producer: linux }))).reasons, ['PYTHON_EXECUTABLE_PIN_MISMATCH'])
})
