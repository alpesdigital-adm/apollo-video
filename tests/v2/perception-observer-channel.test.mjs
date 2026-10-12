import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import {
  OBSERVER_ABI, createObserverClient, decodeObserverFrames, encodeObserverFrame,
  validateMarkerAttestation, validateObserverIdentity,
} from '../../scripts/validation/perception-observer-channel.mjs'
import { decodeRootPackets, namespaceLaunchConfig, NAMESPACE_BUDGET_MS } from '../../scripts/validation/run-perception-ci-namespace.mjs'
import { parseLinuxProcessCredentials } from '../../scripts/validation/run-perception-ci.mjs'

const runId = 'perception-namespace-controlled-boundary'
const metadata = () => ({ pid: 7, starttime: '9007199254740993', state: 'S', ppid: 2,
  processGroupId: 7, sessionId: 7, uid: 600, gid: 700, uids: [600, 600, 600, 600], gids: [700, 700, 700, 700],
  groups: [], CapEff: '0000000000000000', CapPrm: '0000000000000000', CapInh: '0000000000000000',
  CapBnd: '0000000000000000', CapAmb: '0000000000000000', NoNewPrivs: 1,
  inodeUid: 0, environInodeUid: 0, environMode: '0o400' })

class Channel extends EventEmitter {
  destroyed = false
  write(frame) { this.lastRequest = decodeObserverFrames(frame).document }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close') } }
  answer(result, overrides = {}) {
    this.emit('data', encodeObserverFrame({ abi: OBSERVER_ABI, runId, seq: this.lastRequest.seq, ok: true, result, ...overrides }))
  }
}

test('observer rejects invalid UTF-8, oversized/pipelined frames and incomplete final frames', () => {
  const invalid = Buffer.from([0, 0, 0, 2, 0xc0, 0x80])
  assert.throws(() => decodeObserverFrames(invalid))
  assert.throws(() => decodeObserverFrames(Buffer.from([0, 1, 0, 1])))
  assert.throws(() => decodeObserverFrames(Buffer.concat([encodeObserverFrame({}), encodeObserverFrame({})])))
  const partial = encodeObserverFrame({ ok: true }).subarray(0, 6)
  assert.deepEqual(decodeObserverFrames(partial).remaining, partial)
})

test('observer accepts serial fragmented replies and attested marker facts without environment bytes', async () => {
  const socket = new Channel(), client = createObserverClient({ socket, runId, deadlineAt: Date.now() + 5000 })
  const pending = client.request('markers', { pid: 7, starttime: metadata().starttime })
  const result = { identity: metadata(), runMarked: true, knownMarker: true,
    attestation: 'privileged-proc-environ-identity-recheck/v1' }
  const frame = encodeObserverFrame({ abi: OBSERVER_ABI, runId, seq: 1, ok: true, result })
  socket.emit('data', frame.subarray(0, 3)); socket.emit('data', frame.subarray(3, 8)); socket.emit('data', frame.subarray(8))
  assert.deepEqual(validateMarkerAttestation(await pending, metadata()), result)
  client.close()
})

test('observer wrong ABI/run/sequence, malformed error, leaked environment and IPC death close the gate', async () => {
  for (const override of [{ abi: 'other' }, { runId: 'other' }, { seq: 2 },
    { ok: false, error: { code: 'EACCES', environ: 'secret' }, result: undefined }]) {
    const socket = new Channel(), client = createObserverClient({ socket, runId, deadlineAt: Date.now() + 5000 })
    const pending = client.request('hello')
    socket.answer({}, override)
    await assert.rejects(pending)
    await assert.rejects(client.request('hello'), 'failed authority cannot reconnect or fall back')
    assert.equal(socket.destroyed, true)
  }
  for (const mode of ['eof', 'truncated', 'timeout']) {
    const socket = new Channel(), client = createObserverClient({ socket, runId, deadlineAt: Date.now() + 5000, timeoutMs: 20 })
    const pending = client.request('hello')
    if (mode === 'truncated') socket.emit('data', Buffer.from([0, 0]))
    if (mode !== 'timeout') socket.emit('end')
    await assert.rejects(pending)
    assert.equal(socket.destroyed, true)
  }
  const facts = { identity: metadata(), runMarked: true, knownMarker: true,
    attestation: 'privileged-proc-environ-identity-recheck/v1', environ: Buffer.from('secret') }
  assert.throws(() => validateMarkerAttestation(facts, metadata()))
})

test('observer verifies PID/starttime and four credentials independently of root-owned environ inode', () => {
  assert.equal(validateObserverIdentity(metadata(), 7).uid, 600)
  assert.deepEqual(parseLinuxProcessCredentials('Uid:\t600\t600\t600\t600\nGid:\t700\t700\t700\t700\n'),
    { uid: 600, gid: 700, uids: [600, 600, 600, 600], gids: [700, 700, 700, 700] })
  assert.throws(() => parseLinuxProcessCredentials('Uid: 600\nGid: 700 700 700 700\n'))
  for (const changed of [{ pid: 8 }, { starttime: '9007199254740994' },
    { uids: [600, 601, 600, 600] }, { gids: [700, 700, 701, 700] }]) {
    assert.throws(() => validateMarkerAttestation({ identity: { ...metadata(), ...changed },
      runMarked: true, knownMarker: true, attestation: 'privileged-proc-environ-identity-recheck/v1' }, metadata()))
  }
  assert.throws(() => validateObserverIdentity({ ...metadata(), environ: 'secret' }, 7))
})

test('namespace config never passes loader/Python privilege environment and reserves aggregate cleanup before launch', () => {
  const now = 1000000, sourceCommit = 'a'.repeat(40)
  const env = { GITHUB_SHA: sourceCommit, APOLLO_PERCEPTION_JOB_DEADLINE_MS: String(now + NAMESPACE_BUDGET_MS),
    PATH: '/product/path', V2_DATABASE_URL: 'private', LD_PRELOAD: 'private', PYTHONPATH: 'private',
    APOLLO_OBSERVER_FD: '99', SECRET_NOT_ALLOWLISTED: 'private' }
  const config = namespaceLaunchConfig({ suite: 'tests/v2/tesseract-ocr-video-adapter.integration.mjs',
    env, uid: 600, gid: 700, node: '/usr/bin/node', now })
  assert.deepEqual(Object.keys(config.environment).sort(), ['GITHUB_SHA', 'PATH', 'V2_DATABASE_URL'])
  assert.equal(config.innerDeadlineAt, now + NAMESPACE_BUDGET_MS - 60000)
  assert.equal(config.deadlineAt, now + NAMESPACE_BUDGET_MS - 30000)
  assert.throws(() => namespaceLaunchConfig({ suite: config.suite, uid: 600, gid: 700, node: config.node,
    env: { ...env, APOLLO_PERCEPTION_JOB_DEADLINE_MS: String(now + NAMESPACE_BUDGET_MS - 1) }, now }))
  assert.throws(() => namespaceLaunchConfig({ suite: config.suite, uid: 0, gid: 700, env, now }))
  assert.throws(() => namespaceLaunchConfig({ suite: config.suite, uid: 600, gid: 700, env, now, pattern: 'skip' }))
  assert.throws(() => namespaceLaunchConfig({ suite: config.suite, uid: 600, gid: 700, env, now, controlledFault: 'guardian-stop' }))
  const composed = { suite: 'tests/v2/perception-namespace-observer.integration.mjs', uid: 600, gid: 700, env, now }
  assert.equal(namespaceLaunchConfig({ ...composed, controlledFault: 'guardian-stop' }).controlledFault, 'guardian-stop')
  assert.throws(() => namespaceLaunchConfig({ ...composed, controlledFault: 'arbitrary-exec' }))
})

test('root receipt descriptor supports coalesced frames with fatal UTF-8 and a bounded incomplete tail', () => {
  const ready = encodeObserverFrame({ stage: 'guardian-ready' }), final = encodeObserverFrame({ stage: 'guardian-final' })
  assert.deepEqual(decodeRootPackets(Buffer.concat([ready, final])).packets,
    [{ stage: 'guardian-ready' }, { stage: 'guardian-final' }])
  const partial = final.subarray(0, 5)
  assert.deepEqual(decodeRootPackets(Buffer.concat([ready, partial])).remaining, partial)
  assert.throws(() => decodeRootPackets(Buffer.from([0, 0, 0, 2, 0xc0, 0x80])))
})
