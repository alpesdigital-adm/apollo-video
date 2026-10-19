import assert from 'node:assert/strict'
import test from 'node:test'

import { runNextFaceSourceWindowOperationService } from '../../src/v2/application/run-face-source-window-worker.ts'
import { FACE_EVIDENCE_POLICY_SHA256 } from '../../src/v2/domain/face-evidence-policy.ts'
import { acceptedProducer, detectorConfig, observedSample, sha, unknownSample } from './helpers/face-envelope-v2.mjs'

/**
 * W65b: the worker observes a window of the SOURCE's own frames. There is no time map and no timeline: the analyzer is asked for
 * exactly the claimed source frames and the envelope it seals is about that source and nothing else.
 */
const now = () => new Date('2026-10-18T12:00:00.000Z')

function fixture({ window = { startSourceFrame: 100, endSourceFrame: 250 }, interval = 5, mutateClaim, analyzeError } = {}) {
  const calls = { phases: [], published: [], failed: [], cleaned: [], analyzed: [] }
  const claim = {
    operationId: 'operation-1', workspaceId: 'workspace-1', projectId: 'project-1', projectVersionId: 'version-1',
    sourceArtifactId: 'source-1', sourceSha256: sha('b'), sourceByteSize: 100, artifactKey: 'source-key',
    sourceFps: 30, window, sampleIntervalFrames: interval, attempt: 1,
  }
  mutateClaim?.(claim)
  const repository = {
    claimNext: async () => claim, heartbeat: async () => true,
    advancePhase: async ({ phase }) => { calls.phases.push(phase); return true },
    currentFenceHash: async () => sha('a'),
    publish: async (input) => { calls.published.push(input) },
    failAttempt: async (input) => { calls.failed.push(input); return true },
  }
  const materializer = {
    materialize: async () => ({ path: 'C:/private/source.mp4', sha256: sha('b'), byteSize: 100 }),
    cleanup: async (operationId) => { calls.cleaned.push(operationId) },
  }
  const analyzer = {
    analyze: async (request) => {
      calls.analyzed.push(request)
      if (analyzeError) throw analyzeError
      const first = Math.ceil(request.sourceInFrame / request.sampleIntervalFrames) * request.sampleIntervalFrames
      const built = []
      for (let frame = first; frame < request.sourceOutFrame; frame += request.sampleIntervalFrames) {
        built.push(frame === 130 ? unknownSample({ timelineFrame: frame, sourceFrame: frame }) : observedSample({ timelineFrame: frame, sourceFrame: frame, rows: [[0.9, 0.2, 0.2, 0.4, 0.6]] }).sample)
      }
      return {
        sourceFps: { num: 30, den: 1 }, sourceTimebase: { num: 1, den: 15360 }, sourcePtsStart: 0, sourceClock: 'constant-frame-rate',
        sourcePtsRounding: 'nearest', sourceWidth: 1280, sourceHeight: 720, sourceOrientation: 'rotation-0-exif-neutral',
        detectorConfig: { ...detectorConfig }, producer: acceptedProducer(),
        samples: built.map(({ timelineFrame: _unused, ...sample }) => sample),
        rawOutputs: built.map((sample) => (sample.rawOutput ? new Uint8Array(5600) : null)),
      }
    },
  }
  return { calls, claim, repository, materializer, analyzer }
}
const run = (f) => runNextFaceSourceWindowOperationService({ ...f, clock: now })('lease-owner')

test('a source window is analysed once and published as a sealed v3 envelope about the source, with its raw detector outputs', async () => {
  const f = fixture()
  const result = await run(f)
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(f.calls.phases, ['analyzing', 'verifying', 'persisting'])
  assert.deepEqual(f.calls.cleaned, ['operation-1'])
  assert.equal(f.calls.analyzed.length, 1)
  const request = f.calls.analyzed[0]
  assert.deepEqual([request.sourceInFrame, request.sourceOutFrame, request.sampleIntervalFrames, request.maxSamples], [100, 250, 5, 60])
  assert.deepEqual({ ...request.timelineFps }, { num: 30, den: 1 }, 'the analyzer checks the source against the fps the claim expects')
  const { envelope, rawOutputs } = f.calls.published[0]
  assert.equal(envelope.schemaVersion, 'face-producer-envelope/v3')
  assert.equal(envelope.faceSafety, 'unknown')
  assert.equal(envelope.policySha256, FACE_EVIDENCE_POLICY_SHA256)
  assert.deepEqual({ ...envelope.window }, { startSourceFrame: 100, endSourceFrame: 250 })
  assert.deepEqual([envelope.workspaceId, envelope.sourceArtifactId, envelope.sourceSha256], ['workspace-1', 'source-1', sha('b')])
  for (const key of ['projectId', 'projectVersionId', 'timeMap', 'editPlanSnapshotId', 'timelineFps']) assert.equal(key in envelope, false, key)
  assert.equal(envelope.samples.length, 30)
  assert.deepEqual(envelope.samples.slice(0, 2).map((sample) => sample.sourceFrame), [100, 105])
  assert.equal(envelope.samples.find((sample) => sample.sourceFrame === 130).status, 'unknown')
  assert.equal(rawOutputs.length, 30)
  assert.equal(rawOutputs[6], null, 'the unknown sample has no raw output')
  assert.equal(rawOutputs[0].byteLength, 5600)
  // Every frame of the window that is not sampled is an explicit gap, so coverage is never implied.
  assert.equal(envelope.gaps.length, 30)
  assert.ok(envelope.gaps.every((gap) => gap.reasonCode === 'NOT_SAMPLED' && gap.endSourceFrame - gap.startSourceFrame === 4))
})

test('a window deep in the source is observed at its own frames: nothing is offset or rebased', async () => {
  const f = fixture({ window: { startSourceFrame: 90_000, endSourceFrame: 90_060 } })
  await run(f)
  assert.deepEqual([f.calls.analyzed[0].sourceInFrame, f.calls.analyzed[0].sourceOutFrame], [90_000, 90_060])
  assert.deepEqual(f.calls.published[0].envelope.samples.slice(0, 2).map((sample) => sample.sourceFrame), [90_000, 90_005])
})

test('a full 300-frame window of 60 samples is accepted; larger or unaligned windows are refused before any decode', async () => {
  const full = fixture({ window: { startSourceFrame: 0, endSourceFrame: 300 } })
  assert.equal((await run(full)).status, 'succeeded')
  assert.equal(full.calls.published[0].envelope.samples.length, 60)
  for (const mutate of [
    (claim) => { claim.window = { startSourceFrame: 0, endSourceFrame: 301 } },
    (claim) => { claim.window = { startSourceFrame: 10, endSourceFrame: 10 } },
    (claim) => { claim.window = { startSourceFrame: 0, endSourceFrame: 1000 } },
    (claim) => { claim.sampleIntervalFrames = 0 },
    (claim) => { claim.sourceFps = 29.97 },
    (claim) => { claim.window = { startSourceFrame: 1, endSourceFrame: 4 }; claim.sampleIntervalFrames = 5 },
  ]) {
    const f = fixture({ mutateClaim: mutate, window: { startSourceFrame: 0, endSourceFrame: 150 } })
    const result = await run(f)
    assert.equal(result.status, 'attempt-failed')
    assert.equal(f.calls.analyzed.length, 0)
    assert.equal(f.calls.published.length, 0)
    assert.equal(f.calls.failed[0].errorCode, 'INVALID_ARGUMENT')
    assert.equal(f.calls.failed[0].retryable, false)
  }
})

test('an analyzer failure is settled on the attempt, retryable unless the failure is permanent, and nothing is published', async () => {
  const transient = fixture({ analyzeError: new Error('decoder crashed') })
  assert.equal((await run(transient)).status, 'attempt-failed')
  assert.equal(transient.calls.failed[0].retryable, true)
  assert.equal(transient.calls.published.length, 0)
  assert.deepEqual(transient.calls.cleaned, ['operation-1'])
  const { DomainError } = await import('../../src/v2/domain/errors.ts')
  const permanent = fixture({ analyzeError: new DomainError('RENDER_OUTPUT_INVALID', 'Face frame PTS does not match') })
  await run(permanent)
  assert.equal(permanent.calls.failed[0].retryable, false)
  assert.equal(permanent.calls.published.length, 0)
})

test('losing the lease before any phase, or before publication, aborts without publishing', async () => {
  const f = fixture()
  f.repository.advancePhase = async ({ phase }) => { f.calls.phases.push(phase); return phase !== 'persisting' }
  const result = await run(f)
  assert.equal(result.status, 'attempt-failed')
  assert.deepEqual(f.calls.phases, ['analyzing', 'verifying', 'persisting'])
  assert.equal(f.calls.published.length, 0)
  const early = fixture()
  early.repository.advancePhase = async () => false
  await run(early)
  assert.equal(early.calls.analyzed.length, 0)
  const idle = fixture()
  idle.repository.claimNext = async () => null
  assert.equal(await run(idle), null)
})

test('an already-aborted shutdown signal claims nothing', async () => {
  const f = fixture()
  const controller = new AbortController(); controller.abort()
  let claimed = false
  f.repository.claimNext = async () => { claimed = true; return f.claim }
  assert.equal(await runNextFaceSourceWindowOperationService({ ...f, clock: now })('lease-owner', controller.signal), null)
  assert.equal(claimed, false)
})
