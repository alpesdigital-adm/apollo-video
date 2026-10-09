import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createFaceProducerEnvelope } from '../../src/v2/domain/face-producer-envelope.ts'

const sha = (digit) => digit.repeat(64)
function fixture() {
  return {
    id: 'face-envelope-1', workspaceId: 'workspace-1', projectId: 'project-1',
    projectVersionId: 'version-1', operationId: 'operation-1', operationAttempt: 1,
    operationFenceHash: sha('a'), sourceArtifactId: 'source-1', sourceSha256: sha('b'),
    editPlanSnapshotId: 'edit-plan-1', editPlanSnapshotHash: sha('c'),
    timelineDurationFrames: 4, timelineFps: { num: 30, den: 1 },
    sourceFps: { num: 30, den: 1 }, sourceTimebase: { num: 1, den: 1_000_000 },
    sourceClock: 'constant-frame-rate', sourcePtsStart: 0,
    sourcePtsRounding: 'nearest', sourceWidth: 1024, sourceHeight: 768,
    sourceOrientation: 'rotation-0-exif-neutral',
    timeMap: [{ clipId: 'clip-1', sourceInFrame: 10, sourceOutFrame: 14,
      timelineInFrame: 0, timelineOutFrame: 4, rate: 1 }],
    detectorConfig: { inputWidth: 640, inputHeight: 640, longestSide: 640,
      upscale: false, orientationPolicy: 'ignore-exif-after-source-validation',
      resizeInterpolation: 'area', canvasPlacement: 'top-left-zero-pad',
      scoreThreshold: 0.5, nmsThreshold: 0.3, topK: 5000,
      backend: 'opencv-dnn-cpu', threads: 2 },
    producer: { name: 'yunet-cpu', modelSha256: sha('d'), modelLicenseSha256: sha('e'),
      modelSourceCommit: 'f'.repeat(40), adapterSha256: sha('1'), bridgeSha256: sha('a'),
      executableSha256: sha('2'), opencvBinarySha256: sha('b'),
      opencvVersion: '4.13.0', opencvPackageVersion: '4.13.0.92',
      ffmpegSha256: sha('3'), ffprobeSha256: sha('4'),
      assessment: { status: 'failed-gate', preregistrationSha256: sha('5'),
        developmentReportSha256: sha('6'), calibrationReportSha256: sha('7') } },
    samplePolicy: { strategy: 'fixed-interval', intervalFrames: 3, maxSamples: 2 },
    samples: [
      { sourceFrame: 12, sourcePts: 400000, sourcePtsEvidenceHash: sha('8'),
        timelineFrame: 2, imageSha256: sha('9'), frameWidth: 1024, frameHeight: 768,
        status: 'observed', reasonCode: null,
        boxes: [{ boxXYXY: [0.1, 0.2, 0.4, 0.7], confidence: 0.83,
          clipped: false, classification: 'unverified-face-candidate' }] },
    ],
    gaps: [
      { startTimelineFrame: 0, endTimelineFrame: 2, reasonCode: 'NOT_SAMPLED' },
      { startTimelineFrame: 3, endTimelineFrame: 4, reasonCode: 'NOT_SAMPLED' },
    ],
    createdAt: '2026-10-08T00:00:00.000Z',
  }
}

test('face producer seals sampled candidate boxes and failed-gate provenance without safety authority', () => {
  const draft = fixture()
  const envelope = createFaceProducerEnvelope(draft)
  assert.equal(envelope.schemaVersion, 'face-producer-envelope/v1')
  assert.equal(envelope.authority, 'server-produced')
  assert.equal(envelope.coverage, 'sampled-only')
  assert.equal(envelope.faceSafety, 'unknown')
  assert.equal(envelope.identity, 'not-performed')
  assert.equal(envelope.producer.assessment.status, 'failed-gate')
  assert.equal(envelope.timeMapHash, calculateCanonicalHash(draft.timeMap))
  assert.equal(envelope.detectorConfigHash, calculateCanonicalHash(draft.detectorConfig))
  assert.equal(envelope.envelopeHash,
    calculateCanonicalHash(Object.fromEntries(Object.entries(envelope)
      .filter(([key]) => key !== 'envelopeHash'))))
  draft.samples[0].boxes[0].confidence = 0.01
  assert.equal(envelope.samples[0].boxes[0].confidence, 0.83)
  assert.throws(() => { envelope.samples[0].boxes[0].confidence = 0.01 }, TypeError)
})

test('face envelope rejects fabricated approval, absent assessment evidence and forged fields', () => {
  assert.throws(() => createFaceProducerEnvelope({ ...fixture(), faceSafety: 'verified' }), /unsupported/)
  const approved = fixture()
  approved.producer.assessment.status = 'approved'
  assert.throws(() => createFaceProducerEnvelope(approved), /cannot grant approval/)
  const missingReport = fixture()
  missingReport.producer.assessment.calibrationReportSha256 = null
  assert.throws(() => createFaceProducerEnvelope(missingReport), /cannot grant approval/)
  const inferredIdentity = fixture()
  inferredIdentity.samples[0].boxes[0].identity = 'person-1'
  assert.throws(() => createFaceProducerEnvelope(inferredIdentity), /unsupported/)
  const missingOpenCv = fixture(); delete missingOpenCv.producer.opencvBinarySha256
  assert.throws(() => createFaceProducerEnvelope(missingOpenCv), /unsupported/)
  const missingConfig = fixture(); delete missingConfig.detectorConfig
  assert.throws(() => createFaceProducerEnvelope(missingConfig), /unsupported/)
})

test('face envelope rejects wrong PTS, source map, observation geometry and incomplete coverage', () => {
  const pts = fixture(); pts.samples[0].sourcePts += 5
  assert.throws(() => createFaceProducerEnvelope(pts), /source mapping/)
  const fps = fixture(); fps.timelineFps = { num: 24, den: 1 }
  assert.throws(() => createFaceProducerEnvelope(fps), /equal-fps/)
  const map = fixture(); map.samples[0].timelineFrame = 1
  assert.throws(() => createFaceProducerEnvelope(map), /source mapping/)
  const coverage = fixture(); coverage.gaps.pop()
  assert.throws(() => createFaceProducerEnvelope(coverage), /complement/)
  const overlap = fixture(); overlap.gaps[0].endTimelineFrame = 3
  assert.throws(() => createFaceProducerEnvelope(overlap), /complement/)
  const xywh = fixture(); xywh.samples[0].boxes[0].boxXYXY = [0.9, 0.2, 0.4, 0.7]
  assert.throws(() => createFaceProducerEnvelope(xywh), /box is invalid/)
  const unknown = fixture(); unknown.samples[0].status = 'unknown'
  unknown.samples[0].reasonCode = 'DECODE_FAILED'
  assert.throws(() => createFaceProducerEnvelope(unknown), /cannot contain boxes/)
  const geometry = fixture(); geometry.samples[0].frameWidth = 640
  assert.throws(() => createFaceProducerEnvelope(geometry), /source mapping/)
  const unsafePts = fixture(); unsafePts.samples[0].sourceFrame = Number.MAX_SAFE_INTEGER
  assert.throws(() => createFaceProducerEnvelope(unsafePts), /source mapping/)
})

test('unknown sampled frame remains unknown, with no inferred absence of faces', () => {
  const draft = fixture()
  draft.samples[0].status = 'unknown'
  draft.samples[0].reasonCode = 'DECODE_FAILED'
  draft.samples[0].boxes = []
  const envelope = createFaceProducerEnvelope(draft)
  assert.deepEqual(envelope.samples[0].boxes, [])
  assert.equal(envelope.samples[0].status, 'unknown')
  assert.equal(envelope.faceSafety, 'unknown')
})

test('640 and 960 detector configurations produce different sealed hashes', () => {
  const baseline = createFaceProducerEnvelope(fixture())
  const variant = fixture()
  variant.detectorConfig.inputWidth = 960
  variant.detectorConfig.inputHeight = 960
  variant.detectorConfig.longestSide = 960
  const larger = createFaceProducerEnvelope(variant)
  assert.notEqual(baseline.detectorConfigHash, larger.detectorConfigHash)
  assert.notEqual(baseline.envelopeHash, larger.envelopeHash)
})
