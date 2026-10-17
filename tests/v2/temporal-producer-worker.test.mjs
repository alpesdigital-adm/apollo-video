import assert from 'node:assert/strict'
import test from 'node:test'

import { runNextTemporalProducerOperationService } from '../../src/v2/application/run-temporal-producer-worker.ts'
import { parseTemporalProducerRunRequest } from '../../src/v2/public-api/perception-producer-contract.ts'

test('temporal public request accepts only source and version identities', () => {
  const request = { projectVersionId: 'project-version-1', sourceArtifactId: 'source-artifact-1' }
  assert.deepEqual(parseTemporalProducerRunRequest(request), request)
  for (const extra of [{ score: 0.9 }, { trusted: true }, { producer: 'verified' },
    { faceSafety: 'verified' }, { rate: 1 }]) {
    assert.throws(() => parseTemporalProducerRunRequest({ ...request, ...extra }), /fields are invalid/i)
  }
})

const sha = (digit) => digit.repeat(64)
function analysis() {
  return { algorithmVersion: 'visual-temporal-grid/v1', sourceSha256: sha('2'),
    sourceFps: { num: 30, den: 1 }, sourceTimebase: { num: 1, den: 1000 },
    sourceClock: 'constant-frame-rate', sourceWidth: 640, sourceHeight: 360,
    observedFrameCount: 2, assessedDomain: { startSourcePts: 0, endSourcePts: 33 },
    analysisGrid: { width: 160, height: 90 },
    runtime: { ffmpegSha256: sha('4'), ffprobeSha256: sha('5') },
    shot: { observations: [{ startSourcePts: 0, endSourcePts: 33,
      previousFrame: 0, currentFrame: 1,
      previousGridSha256: sha('a'), currentGridSha256: sha('b'), changeScore: 0.01 }],
    coverage: [{ startSourcePts: 0, endSourcePts: 33 }], gaps: [] },
    motion: { observations: [{ startSourcePts: 0, endSourcePts: 33,
      previousFrame: 0, currentFrame: 1, vectorPxPerSecond: { x: 0, y: 0 },
      residualMeanAbsoluteLuma: 0.01, ambiguity: 0.2 }],
    coverage: [{ startSourcePts: 0, endSourcePts: 33 }], gaps: [] },
  }
}
function fixture({ rate = 1, abortOnPersist = false, abortOnAnalyze = false } = {}) {
  const calls = { materialized: 0, analyzed: 0, published: [], failed: [], cleaned: 0, phases: [] }
  const controller = new AbortController()
  const claim = { operationId: 'temporal-operation-1', workspaceId: 'workspace-1',
    projectId: 'project-1', projectVersionId: 'version-1',
    sourceArtifactId: 'source-1', sourceSha256: sha('2'), sourceByteSize: 100,
    artifactKey: 'workspace-1/source.mp4', editPlanSnapshotId: 'edit-1',
    editPlanSnapshotHash: sha('3'), timelineDurationFrames: 2,
    timelineFps: { num: 30, den: 1 },
    timeMap: [{ clipId: 'clip-1', sourceInFrame: 0, sourceOutFrame: 2,
      timelineInFrame: 0, timelineOutFrame: 2, rate }], attempt: 1 }
  const repository = {
    async claimNext() { return claim },
    async heartbeat() { return true },
    async advancePhase({ phase }) {
      calls.phases.push(phase)
      if (phase === 'persisting' && abortOnPersist) controller.abort()
      return true
    },
    async currentFenceHash() { return sha('1') },
    async publish({ envelope }) { calls.published.push(envelope) },
    async failAttempt(input) { calls.failed.push(input); return true },
  }
  return { calls, controller, repository,
    materializer: { async materialize() { calls.materialized += 1; return { path: 'controlled-source.mp4' } },
      async cleanup() { calls.cleaned += 1 } },
    analyzer: { async analyze() { calls.analyzed += 1; if (abortOnAnalyze) controller.abort(); return analysis() } } }
}

test('temporal worker publishes only a raw sealed envelope and cleans materialized source', async () => {
  const world = fixture()
  const worker = runNextTemporalProducerOperationService(world)
  const result = await worker('lease-owner-1', world.controller.signal)
  assert.equal(result.status, 'succeeded')
  assert.equal(world.calls.published.length, 1)
  assert.equal(world.calls.published[0].faceSafety, 'unknown')
  assert.equal(world.calls.published[0].interpretation, 'raw-measurements-only')
  assert.deepEqual(world.calls.phases, ['analyzing', 'verifying', 'persisting'])
  assert.equal(world.calls.cleaned, 1)
  assert.equal(world.calls.failed.length, 0)
})

test('temporal worker rejects unsupported rate without publishing and settles its attempt', async () => {
  const world = fixture({ rate: 2 })
  const worker = runNextTemporalProducerOperationService(world)
  const result = await worker('lease-owner-2', world.controller.signal)
  assert.equal(result.status, 'attempt-failed')
  assert.equal(world.calls.analyzed, 0)
  assert.equal(world.calls.materialized, 0)
  assert.equal(world.calls.published.length, 0)
  assert.equal(world.calls.failed[0].errorCode, 'INVALID_ARGUMENT')
  assert.equal(world.calls.failed[0].retryable, false)
  assert.equal(world.calls.cleaned, 1)
})

test('temporal worker aborts after measurement and before fenced publication', async () => {
  const world = fixture({ abortOnAnalyze: true })
  const worker = runNextTemporalProducerOperationService(world)
  const result = await worker('lease-owner-3', world.controller.signal)
  assert.equal(result.status, 'attempt-failed')
  assert.equal(world.calls.published.length, 0)
  assert.equal(world.calls.failed[0].errorCode, 'PERSISTENCE_CONFLICT')
  assert.deepEqual(world.calls.phases, ['analyzing'])
  assert.equal(world.calls.cleaned, 1)
})

test('temporal worker rejects invalid lease and deadline before claiming', () => {
  const world = fixture()
  for (const leaseMs of [NaN, Infinity, -1, 1_999, 300_001]) {
    assert.throws(() => runNextTemporalProducerOperationService({ ...world, leaseMs }), /lease/i)
  }
  for (const deadlineMs of [NaN, Infinity, -1, 120_001]) {
    assert.throws(() => runNextTemporalProducerOperationService({ ...world, deadlineMs }), /deadline/i)
  }
})
