import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import {
  OBSERVER_ABI, createObserverClient, decodeObserverFrames, encodeObserverFrame,
  validateMarkerAttestation, validateObserverIdentity, validateObserverAuthority,
} from '../../scripts/validation/perception-observer-channel.mjs'
import { containStoppedCarrierAfterCascade, decodeRootPackets, namespaceLaunchConfig, NAMESPACE_BUDGET_MS, settleControlPipeErrors } from '../../scripts/validation/run-perception-ci-namespace.mjs'
import { parseLinuxProcessCredentials } from '../../scripts/validation/run-perception-ci.mjs'

const runId = 'perception-namespace-controlled-boundary'

test('stopped carrier containment requires the completed cascade and its retained birth, never a new PID', async () => {
  const carrier = { pid: 71, starttime: '701', ppid: process.pid, state: 'T' }
  const cascade = Object.fromEntries(['guardian', 'unshare', 'init', 'node'].map((role, index) =>
    [role, { pid: 72 + index, starttime: String(702 + index) }]))
  const token = Object.freeze({ controlledBirth: true })
  const calls = [], evidence = {}
  await containStoppedCarrierAfterCascade({ carrier, cascade, token, deadlineAt: Date.now() + 1000, evidence,
    readIdentity: async (pid) => {
      calls.push(['read', pid])
      return pid === carrier.pid ? carrier : pid === cascade.guardian.pid ? { ...cascade.guardian, state: 'Z' } : null
    }, binding: { signal(actual, signal) { assert.equal(actual, token); calls.push(['signal', signal]) } } })
  assert.deepEqual(calls, [['read', 72], ['read', 73], ['read', 74], ['read', 75], ['read', 71], ['signal', 'SIGKILL']])
  assert.equal(evidence.cascade[0].observation, 'Z')
  assert.ok(evidence.cascade.every((value) => value.terminal))
  assert.equal(evidence.result, 'signaled')
  assert.equal(evidence.childCloseObserved, undefined, 'Signal acceptance cannot invent close or reaping')

  for (const fault of ['missing-cascade', 'live-cascade', 'recycled-carrier', 'wrong-parent', 'live-carrier', 'expired', 'late-read', 'eperm']) {
    let signals = 0
    const denied = {}
    await assert.rejects(() => containStoppedCarrierAfterCascade({ carrier,
      cascade: fault === 'missing-cascade' ? { guardian: cascade.guardian } : cascade,
      token, evidence: denied, deadlineAt: Date.now() + (fault === 'expired' ? -1 : fault === 'live-cascade' || fault === 'late-read' ? 35 : 1000),
      readIdentity: async (pid) => {
        if (fault === 'late-read') await new Promise((done) => setTimeout(done, 60))
        if (pid !== carrier.pid) return fault === 'live-cascade' ? { ...cascade.guardian, pid, state: 'S' } : null
        if (fault === 'recycled-carrier') return { ...carrier, starttime: '999' }
        if (fault === 'wrong-parent') return { ...carrier, ppid: process.pid + 1 }
        if (fault === 'live-carrier') return { ...carrier, state: 'S' }
        return carrier
      }, binding: { signal() { signals += 1; throw Object.assign(new Error('controlled EPERM'), { code: 'EPERM' }) } } }),
    fault === 'eperm' ? { code: 'EPERM' } : undefined, fault)
    assert.equal(signals, fault === 'eperm' ? 1 : 0, `${fault} must not signal a carrier prematurely`)
    assert.equal(denied.result, undefined)
  }
})

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

const authority = () => ({
  init: { ...metadata(), pid: 1, ppid: 0, uid: 0, gid: 0, uids: [0, 0, 0, 0], gids: [0, 0, 0, 0],
    CapEff: '0000000000080024', CapPrm: '0000000000080024', CapBnd: '0000000000080024' },
  guardian: { ...metadata(), pid: 77, CapEff: '0000000000000020',
    CapPrm: '0000000000000020', CapBnd: '0000000000000020' },
  initParentDeathSignal: 9, guardianFlags: { keepCaps: 0, parentDeathSignal: 9 },
  namespace: { pid: 'pid:[4026533000]', mount: 'mnt:[4026533001]' },
  order: ['private-propagation-and-proc-mounted', 'normal-bootstrap-dropped-and-measured',
    'init-minimal-capabilities-measured', 'guardian-minimal-capabilities-measured',
    'normal-node-bootstrap-exec-observed', 'normal-node-product-main-released'],
})

test('observer controlled hello validates six authority stages through the ABI/run/sequence frame contract', async () => {
  const socket = new Channel(), client = createObserverClient({ socket, runId, deadlineAt: Date.now() + 5000 })
  try {
    const pending = client.request('hello')
    const result = { abi: OBSERVER_ABI, owner: metadata(), authority: authority() }
    socket.answer(result)
    const hello = await pending
    assert.equal(validateObserverAuthority(hello.authority, 600, 700), hello.authority)
    assert.deepEqual(hello.authority, result.authority)
  } finally { client.close() }
})

test('observer authority rejects missing, exchanged, duplicated or legacy release stages', () => {
  const original = authority()
  for (let index = 0; index < original.order.length; index++) {
    const missing = structuredClone(original)
    missing.order.splice(index, 1)
    assert.throws(() => validateObserverAuthority(missing, 600, 700))
  }
  for (let index = 0; index < original.order.length - 1; index++) {
    const exchanged = structuredClone(original)
    ;[exchanged.order[index], exchanged.order[index + 1]] = [exchanged.order[index + 1], exchanged.order[index]]
    assert.throws(() => validateObserverAuthority(exchanged, 600, 700))
  }
  const legacy = structuredClone(original)
  legacy.order.splice(4, 2, 'normal-node-exec-released')
  assert.throws(() => validateObserverAuthority(legacy, 600, 700))
  const duplicated = structuredClone(original)
  duplicated.order.push(duplicated.order.at(-1))
  assert.throws(() => validateObserverAuthority(duplicated, 600, 700))
})

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

// CI run 39446701464 attempt 2: the suite passed, the warden's final receipt succeeded and it closed with 0; a heartbeat byte written to its already
// closed control pipe answered EPIPE and was the only error.
test('an EPIPE on the warden control pipe is benign only when captured AFTER the final receipt, and the final succeeded with a zero close', () => {
  const after = { name: 'Error', code: 'EPIPE', message: 'write EPIPE', afterFinal: true }
  const before = { ...after, afterFinal: false }
  const closed = { rootFinal: { success: true }, code: 0, childCloseObserved: true }
  assert.deepEqual(settleControlPipeErrors({ pipeErrors: [after], ...closed }), { errors: [], afterFinal: [after] })
  assert.deepEqual(settleControlPipeErrors({ pipeErrors: [], rootFinal: null, code: null, childCloseObserved: false }), { errors: [], afterFinal: null })
  // an EPIPE before the final stays an error even though the final later succeeds, alone or beside a benign one
  assert.deepEqual(settleControlPipeErrors({ pipeErrors: [before], ...closed }), { errors: [before], afterFinal: null })
  assert.deepEqual(settleControlPipeErrors({ pipeErrors: [after, before], ...closed }), { errors: [after, before], afterFinal: null })
  for (const [label, input] of Object.entries({
    'no final receipt': { rootFinal: undefined, code: 0, childCloseObserved: true },
    'failed final receipt': { rootFinal: { success: false }, code: 0, childCloseObserved: true },
    'non-zero close': { rootFinal: { success: true }, code: 1, childCloseObserved: true },
    'signal close': { rootFinal: { success: true }, code: null, childCloseObserved: true },
    'close not observed': { rootFinal: { success: true }, code: 0, childCloseObserved: false },
  })) {
    assert.deepEqual(settleControlPipeErrors({ pipeErrors: [after], ...input }), { errors: [after], afterFinal: null }, label)
  }
  const other = { name: 'Error', code: 'ECONNRESET', message: 'reset', afterFinal: true }
  assert.deepEqual(settleControlPipeErrors({ pipeErrors: [after, other], ...closed }), { errors: [after, other], afterFinal: null }, 'only EPIPE is ever tolerated')
  assert.deepEqual(settleControlPipeErrors({ pipeErrors: [{ ...after, afterFinal: undefined }], ...closed }).errors.length, 1, 'an untagged EPIPE is an error')
})
