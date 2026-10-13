import assert from 'node:assert/strict'
import { EventEmitter, errorMonitor } from 'node:events'
import test from 'node:test'
import {
  boundedOwnedBrowserCleanup,
  closeOwnedBrowserResources,
  observeOwnedBrowserLifecycle,
  ownedBrowserCleanupAccepted,
  linuxBrowserIdentityTerminal,
  assertLinuxBrowserBirth,
} from './helpers/library-browser-proof.mjs'
import { assertDashboardLinuxCftBindings } from './helpers/dashboard-runtime-journey.mjs'

function controlledClock() {
  let now = 0, callback, armed = false, disarmed = false
  return {
    now: () => now,
    arm: (fn, milliseconds) => { assert.equal(milliseconds, 5000); callback = fn; armed = true; return 1 },
    disarm: (token) => { assert.equal(token, 1); disarmed = true },
    resources: () => [],
    advance: (value) => { now = value },
    expire: () => callback(),
    facts: () => ({ armed, disarmed }),
  }
}

test('owned browser resource cleanup closes context, client and graceful server in order without hardkill', async () => {
  const order = [], steps = [], warnings = [], clock = controlledClock()
  const serverPromise = Promise.resolve()
  const resources = {
    context: { close: () => { order.push('context'); return Promise.resolve() } },
    browser: { close: () => { order.push('client'); return Promise.resolve() } },
    server: {
      close: () => { order.push('server-close'); return serverPromise },
      kill: () => { assert.fail('Hardkill cannot be the normal cleanup action') },
    },
  }
  const result = await closeOwnedBrowserResources(resources,
    (name, action) => boundedOwnedBrowserCleanup(name, action, steps, clock), warnings)
  assert.deepEqual(order, ['context', 'client', 'server-close'])
  assert.equal(result.serverCleanup, serverPromise)
  assert.deepEqual(warnings, [])
  assert.deepEqual(steps.map(({ name, status, actionStatus }) => [name, status, actionStatus]),
    [['context', 'completed', 'fulfilled'], ['browser', 'completed', 'fulfilled'], ['browser-server', 'completed', 'fulfilled']])
})

test('owned browser cleanup arms first and rejects a synchronous return at the original deadline', async () => {
  const clock = controlledClock(), steps = []
  await assert.rejects(boundedOwnedBrowserCleanup('browser-server', () => {
    assert.equal(clock.facts().armed, true)
    clock.advance(5000)
    return Promise.resolve()
  }, steps, clock), /browser-server cleanup timeout/)
  assert.equal(steps[0].status, 'failed')
  assert.equal(steps[0].actionStatus, 'fulfilled')
  assert.equal(steps[0].deadlineExceeded, true)
  assert.equal(clock.facts().disarmed, true)
})

test('owned browser cleanup owns a pending action and late close cannot erase its timeout failure', async () => {
  const clock = controlledClock(), steps = []
  let finish
  const pending = new Promise((resolve) => { finish = resolve })
  const completion = boundedOwnedBrowserCleanup('browser-server', () => pending, steps, clock)
  clock.advance(5000); clock.expire()
  await assert.rejects(completion, /browser-server cleanup timeout/)
  assert.equal(steps[0].actionStatus, 'pending')
  clock.advance(5001); finish(); await Promise.resolve()
  assert.equal(steps[0].actionStatus, 'fulfilled')
  assert.equal(steps[0].status, 'failed')
  assert.equal(steps[0].error, 'browser-server cleanup timeout')
  assert.equal(clock.facts().disarmed, true)
})

test('owned browser cleanup preserves the original rejection while attempting later resources', async () => {
  const primary = new Error('controlled context failure'), clock = controlledClock(), steps = []
  await assert.rejects(boundedOwnedBrowserCleanup('context', () => { throw primary }, steps, clock),
    (error) => error === primary)
  const attempted = [], warnings = []
  await closeOwnedBrowserResources({ context: { close: () => { throw primary } },
    browser: { close: () => { attempted.push('browser'); return Promise.resolve() } },
    server: { close: () => { attempted.push('server'); return Promise.resolve() } } },
  (name, action) => boundedOwnedBrowserCleanup(name, action, [], controlledClock()), warnings)
  assert.deepEqual(attempted, ['browser', 'server'])
  assert.deepEqual(warnings, [primary.message])
})

test('owned browser lifecycle records real emitter events, shared stdio indices and removes only its own listeners', () => {
  const child = new EventEmitter(), server = new EventEmitter(), stream = new EventEmitter()
  child.stdio = [null, stream, stream]
  stream.destroyed = false; stream.closed = false; stream.readableEnded = false
  let externalCalls = 0
  const external = () => { externalCalls++ }
  child.on('close', external)
  const observer = observeOwnedBrowserLifecycle(server, child)
  assert.equal(observeOwnedBrowserLifecycle(server, child), observer)
  child.emit('exit', 0, null); stream.emit('end'); stream.emit('close'); child.emit('close', 0, null); server.emit('close', 0, null)
  observer.dispose()
  const receipt = observer.snapshot()
  assert.equal(receipt.capturePhase, 'after-launchServer-process')
  assert.equal(receipt.processCloseObserved, true); assert.equal(receipt.serverCloseObserved, true)
  assert.deepEqual(receipt.events.map(({ kind }) => kind), ['process-exit', 'stdio-end', 'stdio-close', 'process-close', 'server-close'])
  assert.deepEqual(receipt.stdio[0].indices, [1, 2])
  assert.equal(receipt.stopped, true)
  assert.equal(stream.listenerCount(errorMonitor), 0); assert.equal(stream.listenerCount('error'), 0)
  assert.equal(child.listenerCount('close'), 1)
  child.emit('close', 0, null); assert.equal(externalCalls, 2)
  assert.equal(observer.snapshot().events.length, receipt.events.length)
  assert.equal(observer.snapshot().observedThrough, receipt.observedThrough)
})

test('owned browser lifecycle errorMonitor observes the original error without consuming it or storing its text', () => {
  const child = new EventEmitter(), server = new EventEmitter(), stream = new EventEmitter()
  child.stdio = [stream]
  const observer = observeOwnedBrowserLifecycle(server, child)
  const original = Object.assign(new Error('private diagnostic message'), { code: 'EPIPE' })
  assert.equal(stream.listenerCount('error'), 0)
  assert.throws(() => stream.emit('error', original), (error) => error === original)
  const receipt = observer.snapshot()
  assert.equal(receipt.errors[0].code, 'EPIPE')
  assert.match(receipt.errors[0].messageSha256, /^[a-f0-9]{64}$/)
  assert.ok(!JSON.stringify(receipt).includes(original.message))
  observer.dispose()
})

test('owned browser lifecycle does not fabricate an earlier close and overflow remains an explicit failure', () => {
  const child = new EventEmitter(), server = new EventEmitter()
  child.stdio = []; child.exitCode = 0
  child.emit('close', 0, null)
  const observer = observeOwnedBrowserLifecycle(server, child, 'cleanup-late')
  assert.equal(observer.snapshot().processCloseObserved, false)
  assert.equal(observer.snapshot().serverCloseObserved, false)
  for (let count = 0; count < 65; count++) child.emit('exit', 0, null)
  assert.equal(observer.snapshot().events.length, 64)
  assert.deepEqual(observer.snapshot().errors, [{ code: 'LIFECYCLE_OVERFLOW' }])
  observer.dispose()
})

test('owned browser acceptance requires actual closes and a warning-free terminal contract even after a late timeout', () => {
  const complete = { remaining: [], warnings: [], browserServerTerminal: true,
    processCloseObserved: true, serverCloseObserved: true, lifecycleErrors: [] }
  assert.equal(ownedBrowserCleanupAccepted(complete), true)
  for (const change of [{ processCloseObserved: false }, { serverCloseObserved: false }, { browserServerTerminal: false },
    { warnings: ['browser-server cleanup timeout'] }, { warnings: ['context cleanup failed'] },
    { remaining: [{ pid: 123, created: 'controlled-survivor' }] }, { lifecycleErrors: [{ code: 'LIFECYCLE_OVERFLOW' }] },
    { remaining: null }, { warnings: null }]) {
    assert.equal(ownedBrowserCleanupAccepted({ ...complete, ...change }), false)
  }
})
test('Linux browser identity proof distinguishes live, zombie, absence and reused PID without signaling', () => {
  const birth = { pid: 100, starttime: '22', state: 'S', executable: '/controlled/chrome' }
  assert.equal(linuxBrowserIdentityTerminal(birth, birth), false)
  assert.equal(linuxBrowserIdentityTerminal(birth, { ...birth, state: 'Z' }), true)
  assert.equal(linuxBrowserIdentityTerminal(birth, { ...birth, starttime: '23' }), true)
  assert.equal(linuxBrowserIdentityTerminal(birth, null), true)
  for (const current of [{ ...birth, pid: 101 }, { ...birth, starttime: undefined }, undefined]) {
    assert.throws(() => linuxBrowserIdentityTerminal(birth, current))
  }
  assert.throws(() => linuxBrowserIdentityTerminal({ pid: 100 }, null))
})
test('Linux browser birth requires a live direct child and PPID continuity across executable observation', () => {
  const before = { pid: 100, starttime: '22', state: 'S', ppid: 99 }
  assertLinuxBrowserBirth(before, { ...before }, 99)
  for (const [first, after, owner] of [[{ ...before, state: 'Z' }, before, 99],
    [before, { ...before, state: 'X' }, 99], [before, { ...before, ppid: 1 }, 99],
    [before, { ...before, starttime: '23' }, 99], [before, before, 98]]) {
    assert.throws(() => assertLinuxBrowserBirth(first, after, owner))
  }
})
test('Linux CfT admission requires independently closed acquisition cgroup and exact official pins before browser launch', () => {
  const sourcePin = 'a'.repeat(64), sourceHead = 'b'.repeat(40), actorRunId = 'pidfd-consumer-acquisition-controlled'
  const manifest = { schemaVersion: 'dashboard-cft157-linux-acquisition/v1', outcome: 'files-verified-awaiting-owner',
    errors: [], sourceHead, sourceSha256: sourcePin, version: '157.0.8090.0', revision: '@2ea1b71af70d7fc5d41325dda8df37c1f98ac531',
    nativeBrowserExecuted: false, runId: actorRunId, pid: 100, requests: [
      { url: 'https://storage.googleapis.com/storage/v1/b/chrome-for-testing-public/o/157.0.8090.0%2Flinux64%2Fchrome-linux64.zip' },
      { url: 'https://storage.googleapis.com/chrome-for-testing-public/157.0.8090.0/linux64/chrome-linux64.zip',
        bytes: 201551103, md5Measured: 'BvMevHF6ZEenSob5RNSB4g==', crc32cOfficial: 'SFhLhQ==', crc32cCalculated: false },
    ].map((row) => ({ ...row, finalUrl: row.url, httpStatus: 200, redirects: [], connectionFinallyClosed: true, sha256: 'c'.repeat(64) })) }
  const owner = { schemaVersion: 'perception-cgroup-owner-close/v1', mode: 'acquisition', success: true, errors: [],
    sourceCommit: sourceHead, containmentRequired: false, carrierCloseObserved: true, guardianCloseObserved: true, childCloseObserved: true,
    empty: { populated: 0, liveMembershipEmpty: true }, observed: [{}], terminality: [{ terminal: true }],
    actors: [{ closeObserved: true }, { closeObserved: true }, { closeObserved: true }], acquisition: { actorRunId } }
  const actor = { schemaVersion: 'dashboard-cft157-linux-child-close/v1', runId: actorRunId, birth: { pid: 100 }, closeObserved: true, code: 0, signal: null }
  assertDashboardLinuxCftBindings(manifest, owner, actor, sourcePin, sourceHead)
  for (const mutate of [
    (value) => { value.owner.success = false }, (value) => { value.owner.errors.push({ code: 'DEADLINE' }) },
    (value) => { value.owner.empty.populated = 1 }, (value) => { value.owner.containmentRequired = true },
    (value) => { value.owner.guardianCloseObserved = false }, (value) => { value.actor.closeObserved = false },
    (value) => { value.actor.signal = 'SIGKILL' }, (value) => { value.manifest.requests[1].md5Measured = 'wrong' },
    (value) => { value.manifest.requests[1].finalUrl = 'https://other.invalid/' },
    (value) => { value.manifest.sourceSha256 = 'd'.repeat(64) }, (value) => { value.owner.sourceCommit = 'e'.repeat(40) },
    (value) => { value.manifest.version = '154.0.0.0' }, (value) => { value.actor.birth.pid = 101 },
  ]) {
    const value = structuredClone({ manifest, owner, actor }); mutate(value)
    assert.throws(() => assertDashboardLinuxCftBindings(value.manifest, value.owner, value.actor, sourcePin, sourceHead))
  }
})
