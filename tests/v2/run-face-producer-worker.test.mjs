import assert from 'node:assert/strict'
import test from 'node:test'

import { runNextFaceProducerOperationService } from '../../src/v2/application/run-face-producer-worker.ts'

const sha = (digit) => digit.repeat(64)
const now = () => new Date('2026-10-08T12:00:00.000Z')

function fixture() {
  const calls = { phases: [], published: [], failed: [], cleaned: [], analyzed: 0 }
  const claim = {
    operationId: 'operation-1', workspaceId: 'workspace-1', projectId: 'project-1',
    projectVersionId: 'version-1', sourceArtifactId: 'source-1', sourceSha256: sha('a'),
    sourceByteSize: 100, artifactKey: 'source-key', editPlanSnapshotId: 'plan-1',
    editPlanSnapshotHash: sha('b'), timelineDurationFrames: 4,
    timelineFps: { num: 30, den: 1 }, sampleIntervalFrames: 3, attempt: 1,
    timeMap: [{ clipId: 'clip-1', sourceInFrame: 0, sourceOutFrame: 4,
      timelineInFrame: 0, timelineOutFrame: 4, rate: 1 }],
  }
  const producer = {
    name: 'yunet-cpu', modelSha256: sha('c'), modelLicenseSha256: sha('d'),
    modelSourceCommit: 'e'.repeat(40), adapterSha256: sha('1'), bridgeSha256: sha('2'),
    executableSha256: sha('3'), opencvBinarySha256: sha('4'), opencvVersion: '4.13.0',
    opencvPackageVersion: '4.13.0.92', ffmpegSha256: sha('5'), ffprobeSha256: sha('6'),
    assessment: { status: 'failed-gate', preregistrationSha256: sha('7'),
      developmentReportSha256: sha('8'), calibrationReportSha256: sha('9') },
  }
  const detectorConfig = { inputWidth: 640, inputHeight: 640, longestSide: 640,
    upscale: false, orientationPolicy: 'ignore-exif-after-source-validation',
    resizeInterpolation: 'area', canvasPlacement: 'top-left-zero-pad',
    scoreThreshold: 0.5, nmsThreshold: 0.3, topK: 5000,
    backend: 'opencv-dnn-cpu', threads: 2 }
  const sourceSample = (sourceFrame, sourcePts, status = 'observed') => ({
    sourceFrame, sourcePts, sourcePtsEvidenceHash: sha('f'), imageSha256: sha('0'),
    frameWidth: 640, frameHeight: 480, status,
    boxes: status === 'observed' ? [{ boxXYXY: [0.1, 0.2, 0.4, 0.5],
      confidence: 0.8, clipped: false, classification: 'unverified-face-candidate' }] : [],
    reasonCode: status === 'unknown' ? 'FRAME_DECODE_FAILED' : null,
  })
  const analysis = {
    sourceFps: { num: 30, den: 1 }, sourceTimebase: { num: 1, den: 90000 },
    sourcePtsStart: 0, sourceClock: 'constant-frame-rate', sourcePtsRounding: 'nearest',
    sourceWidth: 640, sourceHeight: 480, sourceOrientation: 'rotation-0-exif-neutral',
    detectorConfig, producer,
    samples: [sourceSample(0, 0), sourceSample(3, 9000, 'unknown')],
  }
  const repository = {
    claimNext: async () => claim,
    heartbeat: async () => true,
    advancePhase: async ({ phase }) => { calls.phases.push(phase); return true },
    currentFenceHash: async () => sha('a'),
    publish: async ({ envelope }) => { calls.published.push(envelope) },
    failAttempt: async (input) => { calls.failed.push(input); return true },
  }
  const materializer = {
    materialize: async () => ({ path: 'C:/private/source.mp4', sha256: sha('a'), byteSize: 100 }),
    cleanup: async (operationId) => { calls.cleaned.push(operationId) },
  }
  const analyzer = { analyze: async () => { calls.analyzed += 1; return analysis } }
  return { calls, claim, analysis, repository, materializer, analyzer }
}

test('face worker publishes sampled candidate boxes with source geometry and unknown gaps', async () => {
  const f = fixture()
  const run = runNextFaceProducerOperationService({ ...f, clock: now })
  const result = await run('lease-owner')
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(f.calls.phases, ['analyzing', 'verifying', 'persisting'])
  assert.deepEqual(f.calls.cleaned, ['operation-1'])
  assert.equal(f.calls.published.length, 1)
  const envelope = f.calls.published[0]
  assert.equal(envelope.faceSafety, 'unknown')
  assert.equal(envelope.coverage, 'sampled-only')
  assert.equal(envelope.producer.assessment.status, 'failed-gate')
  assert.equal(envelope.sourceWidth, 640)
  assert.equal(envelope.detectorConfig.inputWidth, 640)
  assert.deepEqual(envelope.samples.map((sample) => [sample.sourceFrame, sample.timelineFrame,
    sample.status]), [[0, 0, 'observed'], [3, 3, 'unknown']])
  assert.deepEqual(envelope.gaps.map((gap) => [gap.startTimelineFrame, gap.endTimelineFrame]),
    [[1, 3]])
  assert.equal(envelope.samples[1].boxes.length, 0)
})

test('face worker refuses an over-broad sample request before materializing', async () => {
  const f = fixture()
  f.claim.sampleIntervalFrames = 1
  f.claim.timelineDurationFrames = 100
  f.claim.timeMap[0].sourceOutFrame = 100
  let materialized = false
  f.materializer.materialize = async () => { materialized = true; throw new Error('unexpected') }
  const result = await runNextFaceProducerOperationService({ ...f, clock: now })('lease-owner')
  assert.equal(result.status, 'attempt-failed')
  assert.equal(materialized, false)
  assert.equal(f.calls.analyzed, 0)
  assert.equal(f.calls.published.length, 0)
  assert.equal(f.calls.failed[0].errorCode, 'INVALID_ARGUMENT')
  assert.equal(f.calls.failed[0].retryable, false)
  assert.deepEqual(f.calls.cleaned, ['operation-1'])
})

test('face worker aborts before publishing when its lease is lost', async () => {
  const f = fixture()
  f.repository.advancePhase = async ({ phase }) => {
    f.calls.phases.push(phase)
    return phase !== 'verifying'
  }
  const result = await runNextFaceProducerOperationService({ ...f, clock: now })('lease-owner')
  assert.equal(result.status, 'attempt-failed')
  assert.equal(f.calls.published.length, 0)
  assert.equal(f.calls.failed[0].errorCode, 'PERSISTENCE_CONFLICT')
  assert.equal(f.calls.failed[0].retryable, false)
  assert.deepEqual(f.calls.cleaned, ['operation-1'])
})

test('face worker rejects missing or extra frames instead of silently narrowing coverage', async () => {
  for (const samples of [[], [fixture().analysis.samples[0],
    { ...fixture().analysis.samples[1], sourceFrame: 2 }]]) {
    const f = fixture()
    f.analysis.samples = samples
    const result = await runNextFaceProducerOperationService({ ...f, clock: now })('lease-owner')
    assert.equal(result.status, 'attempt-failed')
    assert.equal(f.calls.failed[0].errorCode, 'INVALID_ARGUMENT')
    assert.equal(f.calls.published.length, 0)
    assert.deepEqual(f.calls.cleaned, ['operation-1'])
  }
})
