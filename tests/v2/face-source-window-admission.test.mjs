import assert from 'node:assert/strict'
import test from 'node:test'

import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { enqueueFaceSourceWindowRunService } from '../../src/v2/application/enqueue-face-source-window-run.ts'
import { parseFaceSourceWindowRunRequest } from '../../src/v2/public-api/perception-producer-contract.ts'

/**
 * W65b: a window of the SOURCE's own frames is queued from a project, but it is about the source: the request names no version and no
 * time range of the timeline, and the cadence follows the source's frame rate.
 */
function actor(overrides = {}) {
  const auditContext = createExternalAuditContext({ clientId: 'client-1', credentialId: 'credential-1', workspaceId: 'workspace-1', environment: 'production' })
  return { ...auditContext, scopes: new Set(['projects:write']), authenticationKind: 'bearer', clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false, clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext, ...overrides }
}
const context = (overrides = {}) => ({ projectId: 'project-1', projectVersionId: 'version-1', projectVersionHash: 'a'.repeat(64),
  sourceArtifactId: 'source-1', sourceSha256: 'b'.repeat(64), editPlanSnapshotId: 'edit-plan-1', editPlanSnapshotHash: 'c'.repeat(64),
  sourceFps: 30, sourceDurationFrames: 900, ...overrides })

function harness({ ctx = context(), replay = null } = {}) {
  const calls = { reads: [], created: [], replays: [] }
  const service = enqueueFaceSourceWindowRunService({
    context: { read: async (input) => { calls.reads.push(input); return ctx } },
    operations: {
      findReplay: async (input) => { calls.replays.push(input); return replay },
      createOrReplay: async (input) => { calls.created.push(input); return { operation: input.operation, replayed: false } },
    },
    createOperationId: () => 'operation-face-source-window-1',
    clock: () => new Date('2026-10-18T12:00:00.000Z'),
  })
  const request = (overrides = {}) => ({ workspaceId: 'workspace-1', projectId: 'project-1', sourceArtifactId: 'source-1',
    window: { startSourceFrame: 100, endSourceFrame: 250 }, actor: actor(), idempotencyKey: 'idem-1', traceId: 'trace-1', ...overrides })
  return { calls, service, request }
}

test('a window of source frames is queued under the V9 source profile with a server-owned cadence', async () => {
  const { calls, service, request } = harness()
  const result = await service(request())
  assert.equal(result.replayed, false)
  const created = calls.created[0]
  assert.equal(created.operation.type, 'perception-face-run')
  assert.deepEqual(created.operation.target, { type: 'project-version', id: 'version-1' }, 'the version is only where the request was made from')
  assert.equal(created.context.kind, 'perception-face-run')
  assert.equal(created.context.detectorProfile, 'openvino-face0204-v9-source')
  assert.deepEqual(created.context.sourceWindow, { startSourceFrame: 100, endSourceFrame: 250 })
  assert.equal('window' in created.context, false, 'no timeline window')
  assert.equal(created.context.sampleIntervalFrames, 5, '6 Hz at 30 fps')
  assert.equal(created.context.requestHash, created.requestFingerprint)
  assert.equal(created.traceId, 'trace-1')
  assert.deepEqual(calls.reads[0], { workspaceId: 'workspace-1', projectId: 'project-1', sourceArtifactId: 'source-1' })
})

test('the cadence follows the SOURCE frame rate and bounds the window by the 60-sample cap', async () => {
  for (const [fps, interval] of [[24, 4], [25, 5], [30, 5], [50, 9], [60, 10], [120, 20]]) {
    const { calls, service, request } = harness({ ctx: context({ sourceFps: fps }) })
    await service(request({ window: { startSourceFrame: 0, endSourceFrame: 100 } }))
    assert.equal(calls.created[0].context.sampleIntervalFrames, interval, `${fps} fps`)
  }
  const slow = harness({ ctx: context({ sourceFps: 6 }) })
  await slow.service(slow.request({ window: { startSourceFrame: 0, endSourceFrame: 60 } }))
  assert.equal(slow.calls.created[0].context.sampleIntervalFrames, 1)
  await assert.rejects(slow.service(slow.request({ window: { startSourceFrame: 0, endSourceFrame: 61 }, idempotencyKey: 'idem-2' })), { code: 'INVALID_ARGUMENT' })
})

test('windows that cannot be observed are refused before anything is queued', async () => {
  const cases = [
    { window: { startSourceFrame: 0, endSourceFrame: 301 } },
    { window: { startSourceFrame: 10, endSourceFrame: 10 } },
    { window: { startSourceFrame: -1, endSourceFrame: 10 } },
    { window: { startSourceFrame: 0.5, endSourceFrame: 10 } },
    { window: { startSourceFrame: 850, endSourceFrame: 901 } },   // past the end of the source (900 frames)
    { window: { startSourceFrame: 1, endSourceFrame: 5 } },       // holds no multiple of the 5-frame stride
  ]
  for (const overrides of cases) {
    const { calls, service, request } = harness()
    await assert.rejects(service(request(overrides)), { code: 'INVALID_ARGUMENT' }, JSON.stringify(overrides))
    assert.equal(calls.created.length, 0)
  }
  // a window deep in a long source is fine: the frames are the source's own
  const deep = harness({ ctx: context({ sourceDurationFrames: 100_000 }) })
  await deep.service(deep.request({ window: { startSourceFrame: 90_000, endSourceFrame: 90_150 } }))
  assert.equal(deep.calls.created.length, 1)
})

test('identity, scope, idempotency and admission are enforced; a source the project does not play is refused', async () => {
  const { calls, service, request } = harness()
  await assert.rejects(service(request({ actor: actor({ scopes: new Set(['projects:read']) }) })), { code: 'AUTH_SCOPE_REQUIRED' })
  await assert.rejects(service(request({ workspaceId: 'workspace-other' })), { code: 'AUTH_INVALID' })
  await assert.rejects(service(request({ sourceArtifactId: 'x' })), { code: 'AUTH_INVALID' })
  await assert.rejects(service(request({ idempotencyKey: '  ' })), { code: 'INVALID_ARGUMENT' })
  assert.equal(calls.reads.length, 0)
  const refused = harness({ ctx: null })
  await assert.rejects(refused.service(refused.request()), { code: 'PRECONDITION_REQUIRED' })
})

test('a replay returns the stored operation without reading the context; the fingerprint binds the window, the source and the policy - not a version', async () => {
  const stored = { operation: { id: 'operation-stored' }, replayed: true }
  const replaying = harness({ replay: stored })
  assert.equal(await replaying.service(replaying.request()), stored)
  assert.equal(replaying.calls.reads.length, 0)

  const fingerprints = new Set()
  for (const window of [{ startSourceFrame: 100, endSourceFrame: 250 }, { startSourceFrame: 100, endSourceFrame: 251 }, { startSourceFrame: 105, endSourceFrame: 250 }]) {
    const run = harness()
    await run.service(run.request({ window }))
    fingerprints.add(run.calls.created[0].requestFingerprint)
  }
  assert.equal(fingerprints.size, 3)
  // the same request made while another version is current is the same request (the evidence does not depend on it)
  const first = harness(), second = harness({ ctx: context({ projectVersionId: 'version-2', projectVersionHash: 'd'.repeat(64) }) })
  await first.service(first.request()); await second.service(second.request())
  assert.equal(first.calls.created[0].requestFingerprint, second.calls.created[0].requestFingerprint)
  assert.notEqual(first.calls.created[0].requestFingerprint,
    (await (async () => { const other = harness(); await other.service(other.request({ sourceArtifactId: 'source-2' })); return other.calls.created[0] })()).requestFingerprint)
})

test('the request parser accepts only the source and a bounded window of its own frames', () => {
  const valid = { sourceArtifactId: 'source-1', window: { startSourceFrame: 0, endSourceFrame: 300 } }
  assert.deepEqual(parseFaceSourceWindowRunRequest(valid), valid)
  for (const bad of [
    null, [], 'x', {},
    { ...valid, projectVersionId: 'version-1' },
    { ...valid, sampleIntervalFrames: 5 },
    { ...valid, detectorProfile: 'openvino-face0204-v9-source' },
    { ...valid, window: undefined },
    { ...valid, window: { startSourceFrame: 0 } },
    { ...valid, window: { startSourceFrame: 0, endSourceFrame: 301 } },
    { ...valid, window: { startSourceFrame: 5, endSourceFrame: 5 } },
    { ...valid, window: { startSourceFrame: 0, endSourceFrame: 10.5 } },
    { ...valid, window: { startSourceFrame: -1, endSourceFrame: 10 } },
    { ...valid, window: { startSourceFrame: 0, endSourceFrame: 10, extra: 1 } },
    { ...valid, window: { startFrame: 0, endFrame: 10 } },
    { ...valid, window: { startTimelineFrame: 0, endTimelineFrame: 10 } },
    { ...valid, sourceArtifactId: '' },
    { ...valid, sourceArtifactId: 'a b' },
  ]) assert.throws(() => parseFaceSourceWindowRunRequest(bad), { code: 'INVALID_ARGUMENT' })
})
