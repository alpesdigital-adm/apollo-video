import assert from 'node:assert/strict'
import test from 'node:test'

import { createPerceptionProducerEnvelope } from '../../src/v2/domain/perception-producer-envelope.ts'

const sha = (letter) => letter.repeat(64)
function fixture() {
  return {
    id: 'producer-envelope-1', workspaceId: 'workspace-1', projectId: 'project-1',
    projectVersionId: 'version-1', operationId: 'operation-1', operationAttempt: 1,
    operationFenceHash: sha('a'), sourceArtifactId: 'source-1', sourceSha256: sha('b'),
    editPlanSnapshotId: 'edit-plan-1', editPlanSnapshotHash: sha('c'),
    timelineDurationFrames: 4,
    timeMap: [{ clipId: 'clip-1', sourceInFrame: 0, sourceOutFrame: 4,
      timelineInFrame: 0, timelineOutFrame: 4, rate: 1 }],
    sourceTimebase: { num: 1, den: 1_000_000 }, sourceFps: { num: 30, den: 1 },
    timelineFps: { num: 30, den: 1 }, sourcePtsStart: 0, sourcePtsRounding: 'nearest',
    sourceClock: 'constant-frame-rate', modality: 'ocr',
    producer: { name: 'tesseract', ffmpegSha256: sha('6'), ffprobeSha256: sha('7'),
      executableSha256: sha('d'), executableVersion: '5.5.1',
      traineddata: [{ language: 'por', sha256: sha('e'), licenseSha256: sha('f') }] },
    samplePolicy: { strategy: 'fixed-interval', intervalFrames: 3, maxSamples: 2 },
    samples: [
      { sourcePts: 0, sourcePtsEvidenceHash: sha('1'), sourceFrame: 0, timelineFrame: 0,
        imageSha256: sha('2'), ocr: [{ text: 'Texto', language: 'por', box: [0.1, 0.2, 0.3, 0.1], confidence: 0.9 }] },
      { sourcePts: 100000, sourcePtsEvidenceHash: sha('3'), sourceFrame: 3, timelineFrame: 3,
        imageSha256: sha('4'), ocr: [] },
    ],
    gaps: [{ startTimelineFrame: 1, endTimelineFrame: 3, reasonCode: 'NOT_SAMPLED' }],
    createdAt: '2026-10-08T00:00:00.000Z',
  }
}

test('producer envelope seals observed quantized PTS and only sampled-frame OCR, with unknown face safety', () => {
  const draft = fixture()
  const envelope = createPerceptionProducerEnvelope(draft)
  assert.equal(envelope.schemaVersion, 'perception-producer-envelope/v1')
  assert.equal(envelope.authority, 'server-produced')
  assert.equal(envelope.faceSafety, 'unknown')
  assert.match(envelope.envelopeHash, /^[a-f0-9]{64}$/)
  draft.samples[0].ocr[0].text = 'forged'
  assert.equal(envelope.samples[0].ocr[0].text, 'Texto')
  assert.throws(() => { envelope.samples[0].ocr[0].text = 'forged' }, TypeError)
})

test('producer envelope rejects fabricated authority, PTS, source map, and missing coverage gaps', () => {
  assert.throws(() => createPerceptionProducerEnvelope({ ...fixture(), faceSafety: 'verified' }), /unsupported/)
  const pts = fixture(); pts.samples[1].sourcePts = 100005
  assert.throws(() => createPerceptionProducerEnvelope(pts), /Sample or OCR/)
  const map = fixture(); map.timeMap[0].timelineOutFrame = 5
  assert.throws(() => createPerceptionProducerEnvelope(map), /map/)
  const gap = fixture(); gap.gaps = []
  assert.throws(() => createPerceptionProducerEnvelope(gap), /Coverage gaps/)
  const vfr = fixture(); vfr.sourceClock = 'variable-frame-rate'
  assert.throws(() => createPerceptionProducerEnvelope(vfr), /context/)
  const differentFps = fixture(); differentFps.timelineFps = { num: 24, den: 1 }
  assert.throws(() => createPerceptionProducerEnvelope(differentFps), /equal-fps/)
  const partial = fixture(); partial.timeMap[0].timelineOutFrame = 3
  partial.timeMap[0].sourceOutFrame = 3
  assert.throws(() => createPerceptionProducerEnvelope(partial), /complete timeline/)
  const reordered = fixture(); reordered.timeMap = [
    { clipId: 'clip-2', sourceInFrame: 2, sourceOutFrame: 4,
      timelineInFrame: 2, timelineOutFrame: 4, rate: 1 },
    { clipId: 'clip-1', sourceInFrame: 0, sourceOutFrame: 2,
      timelineInFrame: 0, timelineOutFrame: 2, rate: 1 },
  ]
  assert.throws(() => createPerceptionProducerEnvelope(reordered), /complete timeline/)
})
