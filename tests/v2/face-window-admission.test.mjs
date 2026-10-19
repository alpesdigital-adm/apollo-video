import assert from 'node:assert/strict'
import test from 'node:test'

import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { enqueueFaceWindowRunService } from '../../src/v2/application/enqueue-face-window-run.ts'
import { parseFaceWindowRunRequest } from '../../src/v2/public-api/perception-producer-contract.ts'

function actor(overrides = {}) {
  const auditContext = createExternalAuditContext({ clientId: 'client-1', credentialId: 'credential-1', workspaceId: 'workspace-1', environment: 'production' })
  return { ...auditContext, scopes: new Set(['projects:write']), authenticationKind: 'bearer', clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false, clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext, ...overrides }
}
const context = (overrides = {}) => ({ projectId: 'project-1', projectVersionId: 'version-1', projectVersionHash: 'a'.repeat(64),
  sourceArtifactId: 'source-1', sourceSha256: 'b'.repeat(64), editPlanSnapshotId: 'edit-plan-1', editPlanSnapshotHash: 'c'.repeat(64),
  timelineFps: 30, timelineDurationFrames: 900, clipSourceInFrame: 0, ...overrides })

function harness({ ctx = context(), replay = null } = {}) {
  const calls = { reads: 0, created: [], replays: [] }
  const service = enqueueFaceWindowRunService({
    context: { read: async () => { calls.reads += 1; return ctx } },
    operations: {
      findReplay: async (input) => { calls.replays.push(input); return replay },
      createOrReplay: async (input) => { calls.created.push(input); return { operation: input.operation, replayed: false } },
    },
    createOperationId: () => 'operation-face-window-1',
    clock: () => new Date('2026-10-18T12:00:00.000Z'),
  })
  const request = (overrides = {}) => ({ workspaceId: 'workspace-1', projectId: 'project-1', projectVersionId: 'version-1',
    sourceArtifactId: 'source-1', window: { startTimelineFrame: 100, endTimelineFrame: 250 }, actor: actor(),
    idempotencyKey: 'idem-1', traceId: 'trace-1', ...overrides })
  return { calls, service, request }
}

test('a window is queued under the V9 profile with a server-owned cadence', async () => {
  const { calls, service, request } = harness()
  const result = await service(request())
  assert.equal(result.replayed, false)
  const created = calls.created[0]
  assert.equal(created.operation.type, 'perception-face-run')
  assert.deepEqual(created.operation.target, { type: 'project-version', id: 'version-1' })
  assert.equal(created.context.kind, 'perception-face-run')
  assert.equal(created.context.detectorProfile, 'openvino-face0204-v9')
  assert.deepEqual(created.context.window, { startTimelineFrame: 100, endTimelineFrame: 250 })
  assert.equal(created.context.sampleIntervalFrames, 5, '6 Hz at 30 fps')
  assert.equal(created.context.requestHash, created.requestFingerprint)
  assert.equal(created.traceId, 'trace-1')
})

test('the cadence follows the frame rate and bounds the window by the 60-sample cap', async () => {
  for (const [fps, interval] of [[24, 4], [25, 5], [30, 5], [50, 9], [60, 10], [120, 20]]) {
    const { calls, service, request } = harness({ ctx: context({ timelineFps: fps }) })
    await service(request({ window: { startTimelineFrame: 0, endTimelineFrame: 100 } }))
    assert.equal(calls.created[0].context.sampleIntervalFrames, interval, `${fps} fps`)
  }
  // at 6 fps the interval is one frame, so 60 samples cover only 60 frames
  const slow = harness({ ctx: context({ timelineFps: 6 }) })
  await slow.service(slow.request({ window: { startTimelineFrame: 0, endTimelineFrame: 60 } }))
  assert.equal(slow.calls.created[0].context.sampleIntervalFrames, 1)
  await assert.rejects(slow.service(slow.request({ window: { startTimelineFrame: 0, endTimelineFrame: 61 }, idempotencyKey: 'idem-2' })), { code: 'INVALID_ARGUMENT' })
})

test('windows that cannot be observed are refused before anything is queued', async () => {
  const cases = [
    { window: { startTimelineFrame: 0, endTimelineFrame: 301 } },
    { window: { startTimelineFrame: 10, endTimelineFrame: 10 } },
    { window: { startTimelineFrame: -1, endTimelineFrame: 10 } },
    { window: { startTimelineFrame: 0.5, endTimelineFrame: 10 } },
    { window: { startTimelineFrame: 850, endTimelineFrame: 901 } },
  ]
  for (const overrides of cases) {
    const { calls, service, request } = harness()
    await assert.rejects(service(request(overrides)), { code: 'INVALID_ARGUMENT' })
    assert.equal(calls.created.length, 0)
  }
  // [1, 3) holds no multiple of 5, and neither does [1, 5) once the clip starts at source frame 0
  const noSample = harness()
  await assert.rejects(noSample.service(noSample.request({ window: { startTimelineFrame: 1, endTimelineFrame: 5 } })), { code: 'INVALID_ARGUMENT' })
  // the sampled frames are source frames: a clip that starts at source frame 2 samples timeline frame 3
  const shifted = harness({ ctx: context({ clipSourceInFrame: 2 }) })
  await shifted.service(shifted.request({ window: { startTimelineFrame: 3, endTimelineFrame: 4 } }))
  assert.equal(shifted.calls.created.length, 1)
  await assert.rejects(shifted.service(shifted.request({ window: { startTimelineFrame: 4, endTimelineFrame: 7 }, idempotencyKey: 'idem-3' })), { code: 'INVALID_ARGUMENT' }, 'timeline frames 4..6 are source frames 6..8')
})

test('identity, scope, idempotency and admission are enforced', async () => {
  const { calls, service, request } = harness()
  await assert.rejects(service(request({ actor: actor({ scopes: new Set(['projects:read']) }) })), { code: 'AUTH_SCOPE_REQUIRED' })
  await assert.rejects(service(request({ workspaceId: 'workspace-other' })), { code: 'AUTH_INVALID' })
  await assert.rejects(service(request({ sourceArtifactId: 'x' })), { code: 'AUTH_INVALID' })
  await assert.rejects(service(request({ idempotencyKey: '  ' })), { code: 'INVALID_ARGUMENT' })
  assert.equal(calls.reads, 0)
  const refused = harness({ ctx: null })
  await assert.rejects(refused.service(refused.request()), { code: 'PRECONDITION_REQUIRED' })
})

test('a replay returns the stored operation without reading the context, and the fingerprint binds the window and the policy', async () => {
  const stored = { operation: { id: 'operation-stored' }, replayed: true }
  const replaying = harness({ replay: stored })
  assert.equal(await replaying.service(replaying.request()), stored)
  assert.equal(replaying.calls.reads, 0)

  const fingerprints = new Set()
  for (const window of [{ startTimelineFrame: 100, endTimelineFrame: 250 }, { startTimelineFrame: 100, endTimelineFrame: 251 }, { startTimelineFrame: 105, endTimelineFrame: 250 }]) {
    const run = harness()
    await run.service(run.request({ window }))
    fingerprints.add(run.calls.created[0].requestFingerprint)
  }
  assert.equal(fingerprints.size, 3)
  const again = harness(), same = harness()
  await again.service(again.request()); await same.service(same.request())
  assert.equal(again.calls.created[0].requestFingerprint, same.calls.created[0].requestFingerprint)
})

test('the request parser accepts only identity and a bounded window', () => {
  const valid = { projectVersionId: 'version-1', sourceArtifactId: 'source-1', window: { startTimelineFrame: 0, endTimelineFrame: 300 } }
  assert.deepEqual(parseFaceWindowRunRequest(valid), valid)
  for (const bad of [
    null, [], 'x', {},
    { ...valid, sampleIntervalFrames: 5 },
    { ...valid, detectorProfile: 'openvino-face0204-v9' },
    { ...valid, window: undefined },
    { ...valid, window: { startTimelineFrame: 0 } },
    { ...valid, window: { startTimelineFrame: 0, endTimelineFrame: 301 } },
    { ...valid, window: { startTimelineFrame: 5, endTimelineFrame: 5 } },
    { ...valid, window: { startTimelineFrame: 0, endTimelineFrame: 10.5 } },
    { ...valid, window: { startTimelineFrame: -1, endTimelineFrame: 10 } },
    { ...valid, window: { startTimelineFrame: 0, endTimelineFrame: 10, extra: 1 } },
    { ...valid, projectVersionId: '' },
    { ...valid, sourceArtifactId: 'a b' },
  ]) assert.throws(() => parseFaceWindowRunRequest(bad), { code: 'INVALID_ARGUMENT' })
})
