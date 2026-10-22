import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assessAdmissionLock, assessLockLeftover, captureLockOwner, namespaceEmptyProof, parseLockLeftoverName, reclaimAdmissionLock,
  reclaimAdmissionMutex, withAdmissionLock } from '../../scripts/validation/perception-addon-registry.mjs'
import { classifyLockLeftover, readNamespaceProofs, removeLockLeftovers } from '../../scripts/validation/cleanup-perception-pidfd.mjs'
import { parseLinuxProcessStat } from '../../scripts/validation/run-perception-ci.mjs'

// The admission lock is a FILE carrying a provable owner, published with link(2). Only a lock whose owner is
// provably gone is removed (dead in this PID namespace, or inside a namespace a host supervisor proved empty).
// Everything else fails closed with the unchanged deadline message.
const BOOT = '11111111-2222-4333-8444-555555555555'
const NAMESPACE = 'pid:[4026531836]', OTHER_NAMESPACE = 'pid:[4026532111]', TIME_NAMESPACE = 'time:[4026531834]'
const DEADLINE_MESSAGE = 'Registry admission lock deadline; no stale-lock deletion'
const SELF_PID = 4242, SELF_STARTTIME = '500', OWNER_PID = 7001, OWNER_STARTTIME = '900'
const OBSERVER = 'perception-namespace-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const SCHEMA = 'registry-admission-lock-owner/v2'

function statLine(pid, starttime, state = 'S') {
  const fields = Array(50).fill('0')
  Object.assign(fields, { 0: state, 1: '1', 2: '8', 3: '8', 19: starttime })
  return `${pid} (admission (owner)) ${fields.join(' ')}`
}
function sentinelStat(pid, starttime) {
  const fields = Array(50).fill('0')
  Object.assign(fields, { 0: 'R', 1: '0', 2: '-1', 3: '-1', 19: starttime })
  return `${pid} (PRIVATE_TASK_COMM) ${fields.join(' ')}`
}
const missing = (code = 'ENOENT') => Object.assign(new Error(`PRIVATE_${code}`), { code })
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'apollo-admission-owner.')), lock = join(root, 'admission.lock')
  mkdirSync(join(root, 'receipts'))
  const uid = lstatSync(root).uid, procs = new Map([[SELF_PID, statLine(SELF_PID, SELF_STARTTIME)]])
  const io = { pid: () => SELF_PID, uid: () => uid, selfStat: () => statLine(SELF_PID, SELF_STARTTIME), bootId: () => BOOT,
    pidNamespace: () => NAMESPACE, timeNamespace: () => TIME_NAMESPACE,
    procStat: (pid) => { const value = procs.get(pid); if (value instanceof Error) throw value; if (value === undefined) throw missing(); return value } }
  const doc = (changes = {}) => ({ schemaVersion: SCHEMA, pid: OWNER_PID, starttime: OWNER_STARTTIME, bootId: BOOT, pidNamespace: NAMESPACE,
    timeNamespace: TIME_NAMESPACE, observerRunId: null, uid, nonce: randomUUID(), createdAt: '2026-10-21T19:27:49.219Z', ...changes })
  const plant = (value = doc(), path = lock) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    writeFileSync(path, text)
    return Buffer.from(text)
  }
  const proof = (changes = {}) => ({ kind: 'namespace-empty', runId: OBSERVER, namespace: OTHER_NAMESPACE, anchorStarttime: '800',
    evidence: { path: 'receipts/namespace-x.json', sha256: 'f'.repeat(64) }, ...changes })
  return { root, lock, uid, procs, io, doc, plant, proof, receipts: () => readdirSync(join(root, 'receipts')),
    cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
async function withFixture(body) { const f = fixture(); try { return await body(f) } finally { f.cleanup() } }
const strayNames = (f) => readdirSync(f.root).filter((name) => !['receipts', 'admission.lock', 'admission.lock.reclaim'].includes(name))

async function assertFailsClosed(f, reason, options = {}) {
  await assert.rejects(withAdmissionLock(f.root, () => assert.fail('Action must not run'), { deadlineAt: Date.now() + 60, io: f.io, ...options }), (error) => {
    assert.equal(error.name, 'AssertionError'); assert.equal(error.message, DEADLINE_MESSAGE)
    const facts = error.admissionLockDiagnostic
    assert.equal(facts.reclaim.assessment.reason, reason); assert.notEqual(facts.reclaim.assessment.verdict, 'stale')
    assert.equal(facts.staleLockDeletion, false); assert.deepEqual(facts.reclaim.reclaims, [])
    return true
  })
  assert.deepEqual(f.receipts(), [], 'No removal, so no reclaim receipt')
  assert.deepEqual(strayNames(f), [], 'No staging file or tombstone left behind')
}

test('link(2) publishes a complete owner file, never replaces, and works on this platform', () => {
  const root = mkdtempSync(join(tmpdir(), 'apollo-admission-link.'))
  try {
    writeFileSync(join(root, 'a'), 'one'); writeFileSync(join(root, 'b'), 'two')
    linkSync(join(root, 'a'), join(root, 'lock'))
    assert.equal(readFileSync(join(root, 'lock'), 'utf8'), 'one')
    assert.throws(() => linkSync(join(root, 'b'), join(root, 'lock')), { code: 'EEXIST' })
    mkdirSync(join(root, 'legacy'))
    assert.throws(() => linkSync(join(root, 'b'), join(root, 'legacy')), { code: 'EEXIST' }, 'Not even a legacy directory is replaced')
    assert.equal(readFileSync(join(root, 'lock'), 'utf8'), 'one')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('an acquired lock is a complete owner file from its first instant and is released only with the exact bytes published', async () => {
  await withFixture(async (f) => {
    const result = await withAdmissionLock(f.root, async () => {
      assert.deepEqual(readdirSync(f.root).sort(), ['admission.lock', 'receipts'], 'The staging file is already gone')
      const owner = JSON.parse(readFileSync(f.lock, 'utf8'))
      assert.deepEqual(Object.keys(owner).sort(), ['bootId', 'createdAt', 'nonce', 'observerRunId', 'pid', 'pidNamespace', 'schemaVersion', 'starttime', 'timeNamespace', 'uid'])
      assert.equal(owner.schemaVersion, SCHEMA); assert.equal(owner.pid, SELF_PID); assert.equal(owner.starttime, SELF_STARTTIME)
      assert.equal(owner.bootId, BOOT); assert.equal(owner.pidNamespace, NAMESPACE); assert.equal(owner.timeNamespace, TIME_NAMESPACE)
      assert.equal(owner.observerRunId, OBSERVER); assert.equal(owner.uid, f.uid)
      assert.match(owner.nonce, /^[0-9a-f-]{36}$/); assert.ok(Number.isFinite(Date.parse(owner.createdAt)))
      assert.equal(lstatSync(f.lock).isFile(), true)
      return 'ran'
    }, { io: f.io, env: { APOLLO_OBSERVER_RUN_ID: OBSERVER } })
    assert.equal(result, 'ran'); assert.deepEqual(readdirSync(f.root), ['receipts']); assert.deepEqual(f.receipts(), [])
  })
})

test('the lock is released when the action throws, and a release failure never masks the action failure', async () => {
  await withFixture(async (f) => {
    await assert.rejects(withAdmissionLock(f.root, () => { throw new Error('boom') }, { io: f.io }), /boom/)
    assert.deepEqual(readdirSync(f.root), ['receipts'])
    await assert.rejects(withAdmissionLock(f.root, () => { writeFileSync(f.lock, JSON.stringify(f.doc())); throw new Error('boom') }, { io: f.io }), /boom/)
    assert.equal(existsSync(f.lock), true, 'A lock this process does not own is never released')
  })
})

test('a lock whose bytes changed under the action is not released and the failure is loud', async () => {
  await withFixture(async (f) => {
    await assert.rejects(withAdmissionLock(f.root, () => { writeFileSync(f.lock, JSON.stringify(f.doc())) }, { io: f.io }), /not owned by this process/)
    assert.equal(JSON.parse(readFileSync(f.lock, 'utf8')).pid, OWNER_PID)
  })
})

test('captureLockOwner commits to the /proc facts of this very process and refuses a /proc that does not describe it', () => {
  const base = { pid: () => SELF_PID, uid: () => 1, now: () => 0, selfStat: () => statLine(SELF_PID, SELF_STARTTIME), bootId: () => BOOT,
    pidNamespace: () => NAMESPACE, timeNamespace: () => null }
  const owner = captureLockOwner(base)
  assert.equal(owner.pid, SELF_PID); assert.equal(owner.starttime, SELF_STARTTIME); assert.equal(owner.createdAt, new Date(0).toISOString())
  assert.equal(owner.timeNamespace, null, 'Kernels without time namespaces record null'); assert.equal(owner.observerRunId, null)
  assert.equal(captureLockOwner(base, { observerRunId: OBSERVER }).observerRunId, OBSERVER)
  assert.throws(() => captureLockOwner(base, { observerRunId: 'bad run id' }))
  assert.throws(() => captureLockOwner({ ...base, selfStat: () => statLine(SELF_PID + 1, SELF_STARTTIME) }), /does not describe this process/)
  assert.throws(() => captureLockOwner({ ...base, bootId: () => 'not-a-boot-id' }))
  assert.throws(() => captureLockOwner({ ...base, pidNamespace: () => 'garbage' }))
  assert.throws(() => captureLockOwner({ ...base, timeNamespace: () => 'garbage' }))
})

// A: provably gone owners in THIS PID namespace are the only locks removed.
for (const [name, basis, setup] of [
  ['owner pid absent from /proc (ENOENT)', 'proc-stat-absent', () => {}],
  ['owner pid absent from /proc (ESRCH)', 'proc-stat-absent', (f) => f.procs.set(OWNER_PID, missing('ESRCH'))],
  ['owner pid reused by a strictly younger process', 'pid-recycled', (f) => f.procs.set(OWNER_PID, statLine(OWNER_PID, '901'))],
]) {
  test(`dead owner is removed, acquired within the deadline and recorded in a receipt: ${name}`, async () => {
    await withFixture(async (f) => {
      const staleBytes = f.plant(f.doc()); setup(f)
      let entered = 0
      const result = await withAdmissionLock(f.root, async () => {
        entered += 1
        assert.equal(JSON.parse(readFileSync(f.lock, 'utf8')).pid, SELF_PID, 'The new lock carries the new owner')
        return 'acquired'
      }, { deadlineAt: Date.now() + 2000, io: f.io })
      assert.equal(result, 'acquired'); assert.equal(entered, 1); assert.deepEqual(readdirSync(f.root), ['receipts'], 'Lock, mutex and tombstone are all gone')
      const files = f.receipts(); assert.equal(files.length, 1); assert.match(files[0], /^admission-lock-reclaim-[0-9a-f-]{36}\.json$/)
      const receipt = JSON.parse(readFileSync(join(f.root, 'receipts', files[0]), 'utf8'))
      assert.equal(receipt.schemaVersion, 'registry-admission-lock-reclaim/v2'); assert.equal(receipt.phase, 'removed')
      assert.equal(receipt.tombstoneRemoved, true); assert.match(receipt.tombstone, /^admission\.lock\.stale\.4026531836-4242-500-[0-9a-f]{8}\.[0-9a-f-]{36}$/)
      assert.equal(files[0], `admission-lock-reclaim-${receipt.reclaimId}.json`)
      assert.equal(receipt.staleOwner.pid, OWNER_PID); assert.equal(receipt.staleOwner.starttime, OWNER_STARTTIME)
      assert.equal(receipt.staleOwnerDigest, sha(staleBytes))
      assert.equal(receipt.proof.basis, basis); assert.equal(receipt.proof.recordedStarttime, OWNER_STARTTIME)
      assert.equal(receipt.proof.observedStarttime, basis === 'pid-recycled' ? '901' : null)
      assert.equal(receipt.proof.bootId, BOOT); assert.equal(receipt.proof.pidNamespace, NAMESPACE); assert.equal(receipt.proof.timeNamespace, TIME_NAMESPACE)
      assert.equal(receipt.reclaimer.pid, SELF_PID); assert.notEqual(receipt.reclaimer.nonce, receipt.staleOwner.nonce)
    })
  })
}

// B: everything else fails closed, exactly as before, with the reason in the diagnostic.
const failClosedCases = [
  ['live owner', 'owner-live', (f) => { f.plant(); f.procs.set(OWNER_PID, statLine(OWNER_PID, OWNER_STARTTIME)) }],
  ['live owner whose starttime has leading zeros is the same process', 'owner-live', (f) => { f.plant(f.doc({ starttime: '0900' })); f.procs.set(OWNER_PID, statLine(OWNER_PID, OWNER_STARTTIME)) }],
  ['zombie with the recorded starttime is not proof (a zombie thread-group leader can coexist with live threads)', 'owner-live', (f) => { f.plant(); f.procs.set(OWNER_PID, statLine(OWNER_PID, OWNER_STARTTIME, 'Z')) }],
  ['a process OLDER than the recorded owner is not a PID-reuse proof', 'starttime-went-backwards', (f) => { f.plant(); f.procs.set(OWNER_PID, statLine(OWNER_PID, '899')) }],
  ['different boot id', 'boot-id-differs', (f) => f.plant(f.doc({ bootId: '99999999-2222-4333-8444-555555555555' }))],
  ['different PID namespace and no host proof', 'pid-namespace-differs', (f) => f.plant(f.doc({ pidNamespace: OTHER_NAMESPACE, observerRunId: OBSERVER }))],
  ['different time namespace (starttime clocks are not comparable)', 'time-namespace-differs', (f) => { f.plant(f.doc({ timeNamespace: 'time:[4026532999]' })); f.procs.set(OWNER_PID, statLine(OWNER_PID, '901')) }],
  ['recorded no time namespace but this process has one', 'time-namespace-differs', (f) => f.plant(f.doc({ timeNamespace: null }))],
  ['legacy bare mkdir directory lock', 'legacy-directory-lock', (f) => mkdirSync(f.lock)],
  ['legacy directory lock with an owner.json inside', 'legacy-directory-lock', (f) => { mkdirSync(f.lock); writeFileSync(join(f.lock, 'owner.json'), JSON.stringify(f.doc())) }],
  ['lock file is empty', 'owner-document-invalid', (f) => f.plant('')],
  ['lock file is not JSON', 'owner-document-invalid', (f) => f.plant('{')],
  ['lock file has an extra field', 'owner-document-invalid', (f) => f.plant({ ...f.doc(), extra: 1 })],
  ['lock file lacks the pid', 'owner-document-invalid', (f) => { const value = f.doc(); delete value.pid; f.plant(value) }],
  ['lock file has a numeric starttime', 'owner-document-invalid', (f) => f.plant(f.doc({ starttime: 900 }))],
  ['lock file has the previous schema', 'owner-document-invalid', (f) => f.plant(f.doc({ schemaVersion: 'registry-admission-lock-owner/v1' }))],
  ['lock file has a non-uuid nonce', 'owner-document-invalid', (f) => f.plant(f.doc({ nonce: 'x' }))],
  ['lock file is oversized', 'owner-document-invalid', (f) => f.plant(JSON.stringify({ ...f.doc(), pad: 'x'.repeat(5000) }))],
  ['owner uid is not this uid', 'owner-uid-mismatch', (f) => f.plant(f.doc({ uid: f.uid + 1 }))],
  ['lock is not owned by this uid', 'lock-uid-mismatch', (f) => { f.plant(); f.io.uid = () => f.uid + 1 }],
  ['/proc/<pid>/stat denied', 'proc-stat-EACCES', (f) => { f.plant(); f.procs.set(OWNER_PID, missing('EACCES')) }],
  ['/proc/<pid>/stat unparseable', 'proc-stat-unparseable', (f) => { f.plant(); f.procs.set(OWNER_PID, 'garbage') }],
  ['/proc/<pid>/stat is the sighand-unavailable tuple', 'proc-stat-unparseable', (f) => { f.plant(); f.procs.set(OWNER_PID, sentinelStat(OWNER_PID, OWNER_STARTTIME)) }],
  ['/proc/<pid>/stat answers for another pid', 'proc-stat-pid-mismatch', (f) => { f.plant(); f.procs.set(OWNER_PID, statLine(OWNER_PID + 1, OWNER_STARTTIME)) }],
]
for (const [name, reason, setup] of failClosedCases) {
  test(`fails closed and leaves the lock untouched: ${name}`, async () => {
    await withFixture(async (f) => {
      setup(f)
      const before = lstatSync(f.lock)
      await assertFailsClosed(f, reason)
      assert.equal(lstatSync(f.lock).ino, before.ino, 'The very same lock is still there')
    })
  })
}

// The holder identity is captured with healthy readers; only later (assessment) reads are degraded.
for (const [name, reader, degraded] of [
  ['/proc/self/stat answers for another process (the mount is not this PID namespace)', 'selfStat', () => statLine(SELF_PID + 1, SELF_STARTTIME)],
  ['/proc/self/stat unreadable', 'selfStat', () => { throw missing() }],
  ['boot id unreadable', 'bootId', () => { throw missing() }],
  ['boot id malformed', 'bootId', () => 'not-a-boot-id'],
  ['PID namespace unreadable', 'pidNamespace', () => { throw missing() }],
  ['PID namespace malformed', 'pidNamespace', () => 'garbage'],
  ['time namespace unreadable', 'timeNamespace', () => { throw missing('EACCES') }],
]) {
  test(`a /proc that cannot be verified fails closed: ${name}`, async () => {
    await withFixture(async (f) => {
      f.plant(); const healthy = f.io[reader]; let calls = 0
      f.io[reader] = () => (++calls === 1 ? healthy() : degraded())
      await assertFailsClosed(f, 'self-proc-unverifiable')
    })
  })
}

test('a legacy directory lock is never replaced and no staging file is even created while a lock exists', async () => {
  await withFixture(async (f) => {
    mkdirSync(f.lock)
    const created = []
    const spy = { ...f.io, writeOwner: (...args) => { created.push(args[0]); throw new Error('Must not stage while the lock exists') } }
    await assert.rejects(withAdmissionLock(f.root, () => assert.fail('Action must not run'), { deadlineAt: Date.now() + 80, io: spy }), (error) => {
      assert.equal(error.message, DEADLINE_MESSAGE); return true
    })
    assert.deepEqual(created, [], 'No per-poll staging while the lock is present')
    assert.deepEqual(readdirSync(f.root).sort(), ['admission.lock', 'receipts']); assert.equal(lstatSync(f.lock).isDirectory(), true)
  })
})

test('the failure diagnostic carries the owner facts and the unchanged read-only lock state', async () => {
  await withFixture(async (f) => {
    f.plant(); f.procs.set(OWNER_PID, statLine(OWNER_PID, OWNER_STARTTIME))
    await assert.rejects(withAdmissionLock(f.root, () => assert.fail('Action must not run'), { deadlineAt: Date.now() + 40, io: f.io }), (error) => {
      const facts = error.admissionLockDiagnostic
      assert.equal(facts.schemaVersion, 'registry-admission-lock-state/v1'); assert.equal(facts.exists, true); assert.equal(facts.kind, 'file')
      assert.deepEqual(facts.owner, { carried: true, source: 'lock-file', pid: OWNER_PID, starttime: OWNER_STARTTIME, alive: true, aliveBasis: 'proc-stat-live' })
      assert.equal(facts.reclaim.assessment.verdict, 'live'); assert.equal(facts.reclaim.assessment.owner.pid, OWNER_PID)
      assert.equal(facts.reclaim.assessment.owner.bootId, BOOT); assert.equal(facts.reclaim.mutex, null)
      assert.deepEqual(JSON.parse(JSON.stringify(facts)), facts); assert.doesNotMatch(JSON.stringify(facts), /PRIVATE_/)
      return true
    })
  })
})

test('a reclaim mutex whose holder is not provably gone fails closed and is reported', async () => {
  await withFixture(async (f) => {
    f.plant(); const mutex = `${f.lock}.reclaim`
    f.plant(f.doc({ pid: OWNER_PID + 1 }), mutex); f.procs.set(OWNER_PID + 1, statLine(OWNER_PID + 1, OWNER_STARTTIME))
    await assert.rejects(withAdmissionLock(f.root, () => assert.fail('Action must not run'), { deadlineAt: Date.now() + 60, io: f.io }), (error) => {
      assert.equal(error.message, DEADLINE_MESSAGE)
      assert.equal(error.admissionLockDiagnostic.reclaim.assessment.reason, 'reclaim-mutex-held')
      assert.equal(error.admissionLockDiagnostic.reclaim.mutex.exists, true); assert.equal(error.admissionLockDiagnostic.staleLockDeletion, false)
      return true
    })
    assert.equal(existsSync(f.lock), true); assert.equal(existsSync(mutex), true); assert.deepEqual(f.receipts(), [])
  })
})

test('a reclaim mutex whose holder is provably gone is removed under the same proof (own receipt), then the lock is reclaimed', async () => {
  await withFixture(async (f) => {
    f.plant(); const mutex = `${f.lock}.reclaim`, mutexBytes = f.plant(f.doc({ pid: OWNER_PID + 1 }), mutex)
    assert.equal(await withAdmissionLock(f.root, () => 'acquired', { deadlineAt: Date.now() + 2000, io: f.io }), 'acquired')
    assert.deepEqual(readdirSync(f.root), ['receipts'])
    const receipts = f.receipts().map((name) => JSON.parse(readFileSync(join(f.root, 'receipts', name), 'utf8')))
    assert.deepEqual(receipts.map((value) => value.target).sort(), ['admission.lock', 'admission.lock.reclaim'])
    const orphan = receipts.find((value) => value.target === 'admission.lock.reclaim')
    assert.equal(orphan.staleOwnerDigest, sha(mutexBytes)); assert.equal(orphan.proof.basis, 'proc-stat-absent'); assert.equal(orphan.phase, 'removed')
    // The same protocol refuses a live holder's mutex.
    f.plant(f.doc({ pid: OWNER_PID + 1 }), mutex); f.procs.set(OWNER_PID + 1, statLine(OWNER_PID + 1, OWNER_STARTTIME))
    assert.equal(reclaimAdmissionMutex(f.root, { io: f.io }).assessment.reason, 'owner-live'); assert.equal(existsSync(mutex), true)
  })
})

test('without a writable receipt directory nothing is removed (no un-audited removal)', async () => {
  await withFixture(async (f) => {
    f.plant(); rmSync(join(f.root, 'receipts'), { recursive: true })
    await assert.rejects(withAdmissionLock(f.root, () => assert.fail('Action must not run'), { deadlineAt: Date.now() + 60, io: f.io }), (error) => {
      assert.equal(error.message, DEADLINE_MESSAGE); assert.match(error.admissionLockDiagnostic.reclaim.assessment.reason, /^reclaim-receipt-|^reclaim-already-attempted$/)
      return true
    })
    assert.equal(existsSync(f.lock), true); assert.deepEqual(readdirSync(f.root).sort(), ['admission.lock'])
  })
})

test('one intent receipt per reclaim attempt, not one per poll, when the removal itself keeps failing', async () => {
  await withFixture(async (f) => {
    f.plant(); const failing = { ...f.io, rename: (from, to) => { if (/\.stale\./.test(to)) throw missing('EPERM'); return renameSync(from, to) } }
    await assert.rejects(withAdmissionLock(f.root, () => assert.fail('Action must not run'), { deadlineAt: Date.now() + 200, io: failing }), (error) => {
      assert.equal(error.message, DEADLINE_MESSAGE); return true
    })
    assert.equal(f.receipts().length, 1, 'Polling for 200 ms did not multiply the receipt'); assert.equal(existsSync(f.lock), true)
    assert.equal(JSON.parse(readFileSync(join(f.root, 'receipts', f.receipts()[0]), 'utf8')).phase, 'intent')
    const attempted = new Set()
    for (let index = 0; index < 3; index += 1) reclaimAdmissionLock(f.root, { io: failing, attempted })
    assert.equal(f.receipts().length, 2, 'A fresh attempt (new bookkeeping) is one more attempt, repeated polls with the same bookkeeping are none')
  })
})

test('two contenders racing on the same stale lock in one event loop: exactly one reclaims, they never overlap', async () => {
  await withFixture(async (f) => {
    f.plant(); const log = []
    const contender = (name) => withAdmissionLock(f.root, async () => {
      log.push(`in ${name}`); await new Promise((done) => setTimeout(done, 25)); log.push(`out ${name}`)
    }, { deadlineAt: Date.now() + 3000, io: { ...f.io } })
    await Promise.all([contender('a'), contender('b')])
    assert.equal(log.length, 4); assert.match(log[0], /^in /); assert.equal(log[1], log[0].replace('in', 'out'))
    assert.match(log[2], /^in /); assert.equal(log[3], log[2].replace('in', 'out'))
    assert.equal(f.receipts().length, 1, 'One stale lock, one removal'); assert.deepEqual(readdirSync(f.root), ['receipts'])
  })
})

test('a lock swapped between assessment and rename is detected by the owner digest, restored without replacing, and fails closed', async () => {
  await withFixture(async (f) => {
    f.plant(); const live = f.doc({ pid: OWNER_PID + 1 })
    f.procs.set(OWNER_PID + 1, statLine(OWNER_PID + 1, OWNER_STARTTIME))
    let swapped = false
    f.io.rename = (from, to) => {
      // The dead owner's lock is replaced by a live owner's lock right before the reclaim rename (violating the model).
      if (!swapped && from === f.lock && /\.stale\./.test(to)) { swapped = true; rmSync(f.lock); writeFileSync(f.lock, JSON.stringify(live)) }
      return renameSync(from, to)
    }
    await assert.rejects(withAdmissionLock(f.root, () => assert.fail('Action must not run'), { deadlineAt: Date.now() + 500, io: f.io }),
      /changed during stale-lock reclaim/)
    assert.equal(swapped, true)
    assert.equal(JSON.parse(readFileSync(f.lock, 'utf8')).pid, OWNER_PID + 1, 'The live owner lock was restored')
    assert.deepEqual(strayNames(f), [], 'No tombstone is left once the lock is back'); assert.equal(existsSync(`${f.lock}.reclaim`), false)
  })
})

test('a restore never replaces a lock somebody else published meanwhile (link, not rename)', async () => {
  await withFixture(async (f) => {
    f.plant(); const live = f.doc({ pid: OWNER_PID + 1 }), newer = f.doc({ pid: OWNER_PID + 2 })
    let swapped = false
    f.io.rename = (from, to) => {
      if (!swapped && from === f.lock && /\.stale\./.test(to)) { swapped = true; rmSync(f.lock); writeFileSync(f.lock, JSON.stringify(live)) }
      renameSync(from, to)
      if (swapped && /\.stale\./.test(to)) writeFileSync(f.lock, JSON.stringify(newer)) // a third party publishes in the gap
    }
    await assert.rejects(withAdmissionLock(f.root, () => assert.fail('Action must not run'), { deadlineAt: Date.now() + 500, io: f.io }),
      /changed during stale-lock reclaim/)
    assert.equal(JSON.parse(readFileSync(f.lock, 'utf8')).pid, OWNER_PID + 2, 'The newer lock was not overwritten')
    assert.equal(strayNames(f).length, 1, 'The displaced lock stays as an attributable tombstone (evidence)')
  })
})

// C: a private PID namespace the HOST supervisor proved empty.
test('host reclaim: a lock owned inside a namespace proven empty is removed, with a receipt naming the proof', async () => {
  await withFixture(async (f) => {
    const staleBytes = f.plant(f.doc({ pidNamespace: OTHER_NAMESPACE, observerRunId: OBSERVER, starttime: '900' }))
    const proof = f.proof()
    const outcome = reclaimAdmissionLock(f.root, { io: f.io, namespaceProofs: [proof] })
    assert.equal(outcome.reclaimed, true); assert.equal(existsSync(f.lock), false); assert.deepEqual(readdirSync(f.root), ['receipts'])
    const receipt = JSON.parse(readFileSync(join(f.root, 'receipts', f.receipts()[0]), 'utf8'))
    assert.equal(receipt.phase, 'removed'); assert.equal(receipt.proof.basis, 'namespace-empty'); assert.equal(receipt.proof.runId, OBSERVER)
    assert.equal(receipt.proof.namespace, OTHER_NAMESPACE); assert.equal(receipt.proof.anchorStarttime, '800')
    assert.deepEqual(receipt.proof.evidence, proof.evidence); assert.equal(receipt.staleOwnerDigest, sha(staleBytes))
    // A contender of the NEXT gate (yet another namespace) acquires through the same proof once handed it.
    f.plant(f.doc({ pidNamespace: OTHER_NAMESPACE, observerRunId: OBSERVER }))
    assert.equal(await withAdmissionLock(f.root, () => 'next', { io: f.io, namespaceProofs: [proof], deadlineAt: Date.now() + 2000 }), 'next')
  })
})

for (const [name, ownerChanges, proofChanges] of [
  ['the proof is for another run', {}, { runId: 'perception-namespace-ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee' }],
  ['the proof is for another namespace', {}, { namespace: 'pid:[4026539999]' }],
  ['the owner predates the namespace anchor', { starttime: '700' }, {}],
  ['the owner never named an observer run', { observerRunId: null }, {}],
  ['the owner is from another boot', { bootId: '99999999-2222-4333-8444-555555555555' }, {}],
]) {
  test(`host reclaim fails closed: ${name}`, async () => {
    await withFixture(async (f) => {
      f.plant(f.doc({ pidNamespace: OTHER_NAMESPACE, observerRunId: OBSERVER, starttime: '900', ...ownerChanges }))
      const outcome = reclaimAdmissionLock(f.root, { io: f.io, namespaceProofs: [f.proof(proofChanges)] })
      assert.equal(outcome.reclaimed, false); assert.notEqual(outcome.assessment.verdict, 'stale')
      assert.equal(existsSync(f.lock), true); assert.deepEqual(f.receipts(), [])
    })
  })
}

test('host reclaim never applies to the same-namespace case by proof alone: a LIVE owner stays', () => {
  const f = fixture()
  try {
    f.plant(f.doc({ observerRunId: OBSERVER })); f.procs.set(OWNER_PID, statLine(OWNER_PID, OWNER_STARTTIME))
    const outcome = reclaimAdmissionLock(f.root, { io: f.io, namespaceProofs: [f.proof({ namespace: NAMESPACE })] })
    assert.equal(outcome.reclaimed, false); assert.equal(outcome.assessment.reason, 'owner-live')
  } finally { f.cleanup() }
})

test('namespaceEmptyProof demands the full authenticated-empty evidence and nothing less', () => {
  const report = () => ({ runId: OBSERVER, sourceCommit: 'a'.repeat(40), childCloseObserved: true,
    namespaceBinding: { directlyObserved: { namespace: OTHER_NAMESPACE }, wardenAttested: { localNodeIdentity: { pid: 5, starttime: '800' } } },
    rootReceipts: [{ stage: 'guardian-ready' }, { stage: 'guardian-final', initFinal: { nodeCloseObserved: true, cleanup: { namespaceEmpty: true } } }],
    externalIdentities: Array.from({ length: 5 }, () => ({ terminal: true })), postflight: { backendCount: 0 } })
  const evidence = { path: 'receipts/namespace-x.json', sha256: 'e'.repeat(64) }
  const good = namespaceEmptyProof(report(), evidence, { sourceCommit: 'a'.repeat(40) })
  assert.deepEqual({ ...good }, { kind: 'namespace-empty', runId: OBSERVER, namespace: OTHER_NAMESPACE, anchorStarttime: '800', evidence })
  for (const [name, mutate] of [
    ['other commit', (value) => { value.sourceCommit = 'b'.repeat(40) }],
    ['no run id', (value) => { delete value.runId }],
    ['child close not observed', (value) => { value.childCloseObserved = false }],
    ['namespace not observed', (value) => { delete value.namespaceBinding.directlyObserved }],
    ['no anchor', (value) => { delete value.namespaceBinding.wardenAttested }],
    ['no guardian final', (value) => { value.rootReceipts.pop() }],
    ['node close not observed', (value) => { value.rootReceipts[1].initFinal.nodeCloseObserved = false }],
    ['namespace not empty', (value) => { value.rootReceipts[1].initFinal.cleanup.namespaceEmpty = false }],
    ['an external identity not terminal', (value) => { value.externalIdentities[3].terminal = false }],
    ['four external identities', (value) => { value.externalIdentities.pop() }],
    ['backend still counted', (value) => { value.postflight.backendCount = 1 }],
  ]) {
    const value = report(); mutate(value)
    assert.equal(namespaceEmptyProof(value, evidence, { sourceCommit: 'a'.repeat(40) }), null, name)
  }
})

// D: leftovers recognised by exact name and judged by their creator.
test('lock artifact names are matched exactly and carry their creator', () => {
  assert.deepEqual(parseLockLeftoverName('admission.lock'), { kind: 'lock' })
  assert.deepEqual(parseLockLeftoverName('admission.lock.reclaim'), { kind: 'mutex' })
  const uuid = randomUUID()
  assert.deepEqual(parseLockLeftoverName(`admission.lock.new.4026531836-4242-500-0a1b2c3d.${uuid}`),
    { kind: 'staging', base: 'admission.lock', creator: { pidNamespace: 'pid:[4026531836]', pid: 4242, starttime: '500', runTag: '0a1b2c3d' } })
  assert.equal(parseLockLeftoverName(`admission.lock.stale.4026531836-4242-500-0a1b2c3d.${uuid}`).kind, 'tombstone')
  assert.equal(parseLockLeftoverName(`admission.lock.released.4026531836-4242-500-0a1b2c3d.${uuid}`).kind, 'tombstone')
  assert.equal(parseLockLeftoverName(`admission.lock.reclaim.new.4026531836-4242-500-0a1b2c3d.${uuid}`).base, 'admission.lock.reclaim')
  for (const name of ['admission.lock.new', 'admission.lock.new.x', `admission.lock.new.4026531836-0-500-0a1b2c3d.${uuid}`,
    `admission.lock.freed.4026531836-4242-500-0a1b2c3d.${uuid}`, `xadmission.lock.new.4026531836-4242-500-0a1b2c3d.${uuid}`,
    `admission.lock.new.4026531836-4242-500-0a1b2c3d.${uuid}.extra`, 'registry.json', 'admission.lock.reclaimed']) {
    assert.equal(parseLockLeftoverName(name), null, name)
  }
})

test('leftover files are judged by the identity in their NAME, even when their content never became complete', () => {
  const f = fixture()
  try {
    const creatorName = (pid, starttime, tag = 'abcdef12', ns = '4026531836') => `admission.lock.new.${ns}-${pid}-${starttime}-${tag}.${randomUUID()}`
    const judge = (name, content, proofs = []) => {
      const path = join(f.root, name); writeFileSync(path, content)
      return assessLockLeftover(path, parseLockLeftoverName(name), f.io, { namespaceProofs: proofs })
    }
    assert.equal(judge(creatorName(OWNER_PID, OWNER_STARTTIME), '').verdict, 'stale', 'An EMPTY staging file of a dead creator')
    assert.equal(judge(creatorName(OWNER_PID, OWNER_STARTTIME), '{"partial').reason, 'proc-stat-absent')
    f.procs.set(OWNER_PID, statLine(OWNER_PID, OWNER_STARTTIME))
    assert.equal(judge(creatorName(OWNER_PID, OWNER_STARTTIME), '').verdict, 'live')
    f.procs.set(OWNER_PID, statLine(OWNER_PID, '901'))
    assert.equal(judge(creatorName(OWNER_PID, OWNER_STARTTIME), '').reason, 'pid-recycled')
    assert.equal(judge(creatorName(OWNER_PID, OWNER_STARTTIME, 'abcdef12', '4026532111'), '').reason, 'pid-namespace-differs')
    const tag = createHash('sha256').update(OBSERVER).digest('hex').slice(0, 8)
    assert.equal(judge(creatorName(OWNER_PID, '900', tag, '4026532111'), '', [f.proof()]).reason, 'namespace-empty')
    assert.equal(judge(creatorName(OWNER_PID, '900', 'deadbeef', '4026532111'), '', [f.proof()]).reason, 'pid-namespace-differs', 'Another run tag')
    assert.equal(judge(creatorName(OWNER_PID, '700', tag, '4026532111'), '', [f.proof()]).reason, 'pid-namespace-differs', 'Born before the anchor')
    // Lock and mutex leftovers are judged by their document.
    const mutex = join(f.root, 'admission.lock.reclaim'); f.plant(f.doc(), mutex); f.procs.delete(OWNER_PID)
    assert.equal(assessLockLeftover(mutex, { kind: 'mutex' }, f.io).verdict, 'stale')
    // A directory or another uid is never removed on the strength of a name.
    const directory = join(f.root, creatorName(OWNER_PID, OWNER_STARTTIME)); mkdirSync(directory)
    assert.equal(assessLockLeftover(directory, parseLockLeftoverName(directory.slice(f.root.length + 1)), f.io).reason, 'leftover-not-a-file')
    const foreign = join(f.root, creatorName(OWNER_PID, OWNER_STARTTIME)); writeFileSync(foreign, '')
    assert.equal(assessLockLeftover(foreign, parseLockLeftoverName(foreign.slice(f.root.length + 1)), { ...f.io, uid: () => f.uid + 1 }).reason, 'leftover-uid-mismatch')
  } finally { f.cleanup() }
})

test('cleanup classifies first and removes only after the inventory: staging files and tombstones need the proof, the files stay until then', () => {
  const f = fixture()
  try {
    const dead = `admission.lock.new.4026531836-${OWNER_PID}-${OWNER_STARTTIME}-abcdef12.${randomUUID()}`
    const live = `admission.lock.stale.4026531836-${SELF_PID}-${SELF_STARTTIME}-abcdef12.${randomUUID()}`
    writeFileSync(join(f.root, dead), '{"half'); writeFileSync(join(f.root, live), 'x')
    const entry = classifyLockLeftover(join(f.root, dead), dead, lstatSync(join(f.root, dead)), { io: f.io })
    assert.equal(existsSync(join(f.root, dead)), true, 'Classification never deletes')
    assert.throws(() => classifyLockLeftover(join(f.root, live), live, lstatSync(join(f.root, live)), { io: f.io }),
      /no proof that its creator is gone \(owner-live\); retain evidence/)
    assert.equal(existsSync(join(f.root, live)), true, 'A live creator file is retained as evidence')
    assert.equal(classifyLockLeftover(join(f.root, 'registry.json'), 'registry.json', { size: 1 }, { io: f.io }), null)
    const report = {}
    removeLockLeftovers(f.root, [entry], { report, io: f.io })
    assert.equal(existsSync(join(f.root, dead)), false)
    assert.deepEqual(report.admissionLockLeftovers.map((value) => [value.name, value.kind, value.bytes, value.sha256, value.proof.basis, value.action]),
      [[dead, 'staging', 6, sha('{"half'), 'proc-stat-absent', 'removed']])
    // A file that changed after classification, or whose creator turned out alive, is kept.
    const other = `admission.lock.new.4026531836-${OWNER_PID}-${OWNER_STARTTIME}-abcdef12.${randomUUID()}`
    writeFileSync(join(f.root, other), 'a'); const pending = classifyLockLeftover(join(f.root, other), other, lstatSync(join(f.root, other)), { io: f.io })
    writeFileSync(join(f.root, other), 'b')
    assert.throws(() => removeLockLeftovers(f.root, [pending], { report, io: f.io }), /changed; retain evidence/)
    writeFileSync(join(f.root, other), 'a'); f.procs.set(OWNER_PID, statLine(OWNER_PID, OWNER_STARTTIME))
    assert.throws(() => removeLockLeftovers(f.root, [pending], { report, io: f.io }), /lost its proof \(owner-live\)/)
    assert.equal(existsSync(join(f.root, other)), true)
  } finally { f.cleanup() }
})

test('cleanup removes a leftover lock only through the reclaim protocol: a lock republished by a live owner since classification survives', () => {
  const f = fixture()
  try {
    f.plant(); const report = {}
    const entry = classifyLockLeftover(f.lock, 'admission.lock', lstatSync(f.lock), { io: f.io })
    // A contender reclaims the dead owner lock and republishes its own LIVE one before cleanup acts.
    rmSync(f.lock); f.plant(f.doc({ pid: SELF_PID, starttime: SELF_STARTTIME }))
    assert.throws(() => removeLockLeftovers(f.root, [entry], { report, io: f.io }), /could not be reclaimed under proof \(owner-live\); retain evidence/)
    assert.equal(JSON.parse(readFileSync(f.lock, 'utf8')).pid, SELF_PID, 'The live lock is untouched')
    assert.deepEqual(f.receipts(), []); assert.deepEqual(strayNames(f), [])
  } finally { f.cleanup() }
})

test('cleanup reclaim race, injected: the dead owner lock is swapped for a live one between the proof and the removal - restored, nothing removed', () => {
  const f = fixture()
  try {
    f.plant(); const report = {}, live = f.doc({ pid: OWNER_PID + 1 }); f.procs.set(OWNER_PID + 1, statLine(OWNER_PID + 1, OWNER_STARTTIME))
    const entry = classifyLockLeftover(f.lock, 'admission.lock', lstatSync(f.lock), { io: f.io })
    let swapped = false
    const io = { ...f.io, rename: (from, to) => {
      if (!swapped && from === f.lock && /\.stale\./.test(to)) { swapped = true; rmSync(f.lock); writeFileSync(f.lock, JSON.stringify(live)) }
      return renameSync(from, to)
    } }
    assert.throws(() => removeLockLeftovers(f.root, [entry], { report, io }), /changed during stale-lock reclaim/)
    assert.equal(swapped, true); assert.equal(JSON.parse(readFileSync(f.lock, 'utf8')).pid, OWNER_PID + 1)
    assert.deepEqual(strayNames(f), []); assert.equal(report.admissionLockLeftovers, undefined)
  } finally { f.cleanup() }
})

test('cleanup reclaims a still-stale leftover lock and an orphaned mutex, with receipts, and records them', () => {
  const f = fixture()
  try {
    f.plant(); f.plant(f.doc({ pid: OWNER_PID + 1 }), `${f.lock}.reclaim`)
    const pending = [['admission.lock', f.lock], ['admission.lock.reclaim', `${f.lock}.reclaim`]]
      .map(([name, path]) => classifyLockLeftover(path, name, lstatSync(path), { io: f.io }))
    const report = {}
    removeLockLeftovers(f.root, pending, { report, io: f.io })
    assert.deepEqual(readdirSync(f.root), ['receipts']); assert.equal(f.receipts().length, 2, 'Lock and orphaned mutex each have a receipt')
    assert.deepEqual(report.admissionLockLeftovers.map((value) => [value.name, value.action]), [['admission.lock', 'reclaimed'], ['admission.lock.reclaim', 'already-absent']])
  } finally { f.cleanup() }
})

test('release verifies the tombstone bytes: a lock replaced by another owner is put back, never deleted', async () => {
  await withFixture(async (f) => {
    const other = f.doc({ pid: OWNER_PID + 1 })
    await assert.rejects(withAdmissionLock(f.root, () => { rmSync(f.lock); writeFileSync(f.lock, JSON.stringify(other)) }, { io: f.io }), /not owned by this process/)
    assert.equal(JSON.parse(readFileSync(f.lock, 'utf8')).nonce, other.nonce); assert.deepEqual(strayNames(f), [])
  })
})

// E: mutation checks. Each mutant is a textual edit of the real module.
const registryUrl = new URL('../../scripts/validation/perception-addon-registry.mjs', import.meta.url)
async function loadMutant(from, to) {
  let source = readFileSync(registryUrl, 'utf8')
  assert.equal(source.split(from).length, 2, `Mutation anchor must be unique: ${from}`)
  source = source.replace(from, () => to)
    .replace("'./run-perception-ci.mjs'", () => JSON.stringify(new URL('../../scripts/validation/run-perception-ci.mjs', import.meta.url).href))
  const directory = mkdtempSync(join(tmpdir(), 'apollo-admission-mutant.')), file = join(directory, 'mutant.mjs')
  try { writeFileSync(file, source); return await import(pathToFileURL(file).href) } finally { rmSync(directory, { recursive: true, force: true }) }
}
function verdictTable(module) {
  const table = {}
  for (const [name, setup] of [
    ['absent', () => {}],
    ['recycled', (f) => f.procs.set(OWNER_PID, statLine(OWNER_PID, '901'))],
    ['backwards', (f) => f.procs.set(OWNER_PID, statLine(OWNER_PID, '899'))],
    ['live', (f) => f.procs.set(OWNER_PID, statLine(OWNER_PID, OWNER_STARTTIME))],
    ['otherBoot', (f, plant) => plant(f.doc({ bootId: '99999999-2222-4333-8444-555555555555' }))],
    ['otherNamespace', (f, plant) => plant(f.doc({ pidNamespace: OTHER_NAMESPACE }))],
    ['otherTimeNamespace', (f, plant) => plant(f.doc({ timeNamespace: 'time:[4026532999]' }))],
    ['legacyDirectory', (f, plant, directory) => directory()],
    ['foreignLockUid', (f) => { f.io.uid = () => f.uid + 1 }],
    ['foreignOwnerUid', (f, plant) => plant(f.doc({ uid: f.uid + 1 }))],
    ['nsProof', (f, plant, directory, proofs) => { plant(f.doc({ pidNamespace: OTHER_NAMESPACE, observerRunId: OBSERVER })); proofs.push(f.proof()) }],
    ['nsProofOtherRun', (f, plant, directory, proofs) => { plant(f.doc({ pidNamespace: OTHER_NAMESPACE, observerRunId: OBSERVER })); proofs.push(f.proof({ runId: 'perception-namespace-other' })) }],
    ['nsProofBeforeAnchor', (f, plant, directory, proofs) => { plant(f.doc({ pidNamespace: OTHER_NAMESPACE, observerRunId: OBSERVER, starttime: '700' })); proofs.push(f.proof()) }],
  ]) {
    const f = fixture()
    try {
      let planted = false; const proofs = []
      setup(f, (value) => { f.plant(value); planted = true }, () => { mkdirSync(f.lock); planted = true }, proofs)
      if (!planted) f.plant()
      const result = module.assessAdmissionLock(f.lock, f.io, { namespaceProofs: proofs })
      table[name] = `${result.verdict}/${result.reason}`
    } finally { f.cleanup() }
  }
  return table
}
// Two reclaimers in one stale lock: B starts right before A's removal. The reclaim mutex must keep B out.
function interleavingOutcome(module) {
  const f = fixture()
  try {
    f.plant(); let b = null
    const ioA = { ...f.io, rename: (from, to) => {
      if (b === null && from === f.lock && /\.stale\./.test(to)) b = module.reclaimAdmissionLock(f.root, { io: f.io })
      return renameSync(from, to)
    } }
    const a = module.reclaimAdmissionLock(f.root, { io: ioA })
    return { aReclaimed: a.reclaimed, bReclaimed: b?.reclaimed ?? null, bReason: b?.assessment?.reason ?? null, receipts: f.receipts().length }
  } finally { f.cleanup() }
}
function attemptsOutcome(module) {
  const f = fixture()
  try {
    f.plant(); const failing = { ...f.io, rename: (from, to) => { if (/\.stale\./.test(to)) throw missing('EPERM'); return renameSync(from, to) } }, attempted = new Set()
    for (let index = 0; index < 3; index += 1) module.reclaimAdmissionLock(f.root, { io: failing, attempted })
    return f.receipts().length
  } finally { f.cleanup() }
}

test('mutation checks: every proof of the assessment and the reclaim protocol matters', async () => {
  const expected = {
    absent: 'stale/proc-stat-absent', recycled: 'stale/pid-recycled', backwards: 'unproven/starttime-went-backwards', live: 'live/owner-live',
    otherBoot: 'unproven/boot-id-differs', otherNamespace: 'unproven/pid-namespace-differs', otherTimeNamespace: 'unproven/time-namespace-differs',
    legacyDirectory: 'unproven/legacy-directory-lock', foreignLockUid: 'unproven/lock-uid-mismatch', foreignOwnerUid: 'unproven/owner-uid-mismatch',
    nsProof: 'stale/namespace-empty', nsProofOtherRun: 'unproven/pid-namespace-differs', nsProofBeforeAnchor: 'unproven/pid-namespace-differs',
  }
  const original = verdictTable({ assessAdmissionLock })
  assert.deepEqual(original, expected)
  for (const [label, from, to, differs] of [
    ['younger-process (PID reuse) comparison removed', 'BigInt(observed.starttime) > BigInt(identity.starttime)', 'false', 'recycled'],
    ['older-process comparison removed', 'BigInt(observed.starttime) < BigInt(identity.starttime)', 'false', 'backwards'],
    ['younger-process comparison always true', 'BigInt(observed.starttime) > BigInt(identity.starttime)', 'true', 'live'],
    ['bootId check removed', 'identity.bootId !== bootId', 'false', 'otherBoot'],
    ['PID namespace check removed', 'identity.pidNamespace !== pidNamespace', 'false', 'otherNamespace'],
    ['time namespace check removed', 'identity.timeNamespace !== timeNamespace', 'false', 'otherTimeNamespace'],
    ['absence proof removed', "['ENOENT', 'ESRCH'].includes(error?.code)) return stale", 'false) return stale', 'absent'],
    ['legacy directory check removed', "if (metadata.isDirectory()) return unproven('legacy-directory-lock')", "if (false) return unproven('legacy-directory-lock')", 'legacyDirectory'],
    ['lock uid check removed', "if (metadata.uid !== uid) return unproven('lock-uid-mismatch')", "if (false) return unproven('lock-uid-mismatch')", 'foreignLockUid'],
    ['owner uid check removed', "if (owner.uid !== uid) return unproven('owner-uid-mismatch'", "if (false) return unproven('owner-uid-mismatch'", 'foreignOwnerUid'],
    ['namespace proof run binding removed', 'identity.observerRunId !== null && identity.observerRunId === value.runId', 'true', 'nsProofOtherRun'],
    ['namespace proof anchor removed', 'BigInt(identity.starttime) >= BigInt(value.anchorStarttime)', 'true', 'nsProofBeforeAnchor'],
  ]) {
    const mutated = verdictTable(await loadMutant(from, to))
    assert.notEqual(mutated[differs], original[differs], `${label}: the ${differs} case must flip`)
  }
  assert.deepEqual(interleavingOutcome({ reclaimAdmissionLock }), { aReclaimed: true, bReclaimed: false, bReason: 'reclaim-mutex-held', receipts: 1 })
  const noMutex = interleavingOutcome(await loadMutant('!publishOwnedFile(mutex, holderText, holder, io)', 'false'))
  assert.notDeepEqual(noMutex, { aReclaimed: true, bReclaimed: false, bReason: 'reclaim-mutex-held', receipts: 1 }, 'Without the mutex B gets in')
  assert.equal(noMutex.bReclaimed, true)
  assert.equal(attemptsOutcome({ reclaimAdmissionLock }), 1)
  assert.equal(attemptsOutcome(await loadMutant('attempted.add(assessment.ownerDigest)\n    return removeStaleEntry(root, lock', 'void 0\n    return removeStaleEntry(root, lock')), 3, 'Without the bookkeeping every poll writes a receipt')
})

// F: real /proc, real link(2)/rename(2), real processes (Linux only).
const linux = { skip: process.platform !== 'linux' }
async function deadChildOwner(changes = {}) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const starttime = parseLinuxProcessStat(readFileSync(`/proc/${child.pid}/stat`, 'utf8')).starttime
  child.kill('SIGKILL'); await once(child, 'exit')
  return { ...captureLockOwner(), pid: child.pid, starttime, nonce: randomUUID(), ...changes }
}
function realRoot() {
  const root = mkdtempSync(join(tmpdir(), 'apollo-admission-real.')); mkdirSync(join(root, 'receipts'))
  return root
}
const plantReal = (root, owner) => writeFileSync(join(root, 'admission.lock'), JSON.stringify(owner))

test('real /proc: a SIGKILLed owner is reclaimed; a live owner and PID reuse are judged correctly', linux, async () => {
  const root = realRoot()
  try {
    plantReal(root, await deadChildOwner())
    assert.equal(await withAdmissionLock(root, () => 'acquired', { deadlineAt: Date.now() + 3000 }), 'acquired')
    assert.equal(readdirSync(join(root, 'receipts')).length, 1); assert.deepEqual(readdirSync(root), ['receipts'])
    const self = captureLockOwner(), lock = join(root, 'admission.lock')
    plantReal(root, { ...self, nonce: randomUUID() })
    assert.equal(assessAdmissionLock(lock).verdict, 'live'); rmSync(lock)
    plantReal(root, { ...self, nonce: randomUUID(), starttime: String(BigInt(self.starttime) - 1n) })
    const recycled = assessAdmissionLock(lock)
    assert.equal(recycled.verdict, 'stale'); assert.equal(recycled.proof.basis, 'pid-recycled'); rmSync(lock)
    plantReal(root, { ...self, nonce: randomUUID(), starttime: String(BigInt(self.starttime) + 1n) })
    assert.equal(assessAdmissionLock(lock).reason, 'starttime-went-backwards')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('real /proc: an owner in a namespace this process cannot see is stale only with the host proof', linux, async () => {
  const root = realRoot()
  try {
    const self = captureLockOwner(), lock = join(root, 'admission.lock')
    plantReal(root, { ...self, pidNamespace: 'pid:[4026539999]', observerRunId: OBSERVER, nonce: randomUUID() })
    assert.equal(assessAdmissionLock(lock).reason, 'pid-namespace-differs')
    const proof = { kind: 'namespace-empty', runId: OBSERVER, namespace: 'pid:[4026539999]', anchorStarttime: '1', evidence: { path: 'r', sha256: null } }
    assert.equal(reclaimAdmissionLock(root, { namespaceProofs: [proof] }).reclaimed, true)
    assert.deepEqual(readdirSync(root), ['receipts'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('real /proc: readNamespaceProofs accepts only this uid\'s authenticated-empty receipts', linux, () => {
  const root = realRoot()
  try {
    const good = { runId: OBSERVER, sourceCommit: 'a'.repeat(40), childCloseObserved: true,
      namespaceBinding: { directlyObserved: { namespace: OTHER_NAMESPACE }, wardenAttested: { localNodeIdentity: { starttime: '800' } } },
      rootReceipts: [{ stage: 'guardian-final', initFinal: { nodeCloseObserved: true, cleanup: { namespaceEmpty: true } } }],
      externalIdentities: Array.from({ length: 5 }, () => ({ terminal: true })), postflight: { backendCount: 0 } }
    writeFileSync(join(root, 'receipts', `namespace-${OBSERVER}.json`), JSON.stringify(good))
    writeFileSync(join(root, 'receipts', 'namespace-perception-namespace-11111111-1111-4111-8111-111111111111.json'), JSON.stringify({ ...good, childCloseObserved: false }))
    writeFileSync(join(root, 'receipts', 'namespace-perception-namespace-22222222-2222-4222-8222-222222222222.json'), '{')
    const proofs = readNamespaceProofs(root, { GITHUB_SHA: 'a'.repeat(40) })
    assert.equal(proofs.length, 1); assert.equal(proofs[0].runId, OBSERVER)
    assert.match(proofs[0].evidence.path, /^receipts\/namespace-/); assert.match(proofs[0].evidence.sha256, /^[0-9a-f]{64}$/)
    assert.equal(readNamespaceProofs(root, { GITHUB_SHA: 'b'.repeat(40) }).length, 0, 'Another commit proves nothing')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('real processes racing on the same orphaned lock: one removal, strictly serialized critical sections', linux, async () => {
  const root = realRoot(), log = join(root, 'order.log')
  try {
    plantReal(root, await deadChildOwner())
    const code = `import { withAdmissionLock } from ${JSON.stringify(registryUrl.href)}
import { appendFileSync } from 'node:fs'
const [root, log, id] = process.argv.slice(1)
await withAdmissionLock(root, async () => {
  appendFileSync(log, 'in ' + id + '\\n'); await new Promise((done) => setTimeout(done, 60)); appendFileSync(log, 'out ' + id + '\\n')
}, { deadlineAt: Date.now() + 15000 })`
    const children = [0, 1, 2, 3].map((id) => spawn(process.execPath, ['--input-type=module', '-e', code, root, log, String(id)], { stdio: ['ignore', 'inherit', 'inherit'] }))
    const codes = await Promise.all(children.map(async (child) => (await once(child, 'exit'))[0]))
    assert.deepEqual(codes, [0, 0, 0, 0])
    const lines = readFileSync(log, 'utf8').trim().split('\n'); assert.equal(lines.length, 8)
    for (let index = 0; index < lines.length; index += 2) {
      const [enter, id] = lines[index].split(' '); assert.equal(enter, 'in'); assert.equal(lines[index + 1], `out ${id}`)
    }
    assert.equal(readdirSync(join(root, 'receipts')).length, 1, 'Exactly one process won the removal')
    assert.deepEqual(readdirSync(root).sort(), ['order.log', 'receipts'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('real processes: the reclaim mutex lets exactly one of two simultaneous reclaimers remove the lock, round after round', linux, async () => {
  const code = `import { reclaimAdmissionLock } from ${JSON.stringify(registryUrl.href)}
import { existsSync, writeFileSync } from 'node:fs'
const [root, barrier, id] = process.argv.slice(1)
writeFileSync(root + '/ready-' + id, '')
while (!existsSync(barrier)) { /* spin until both processes are imported and waiting */ }
const outcome = reclaimAdmissionLock(root, {})
writeFileSync(root + '/outcome-' + id + '.json', JSON.stringify({ reclaimed: outcome.reclaimed, reason: outcome.assessment?.reason ?? null }))`
  const root = realRoot()
  try {
    for (let round = 0; round < 8; round += 1) {
      const barrier = join(root, `barrier-${round}`)
      plantReal(root, await deadChildOwner())
      const ids = [`${round}a`, `${round}b`]
      const children = ids.map((id) => spawn(process.execPath, ['--input-type=module', '-e', code, root, barrier, id], { stdio: ['ignore', 'inherit', 'inherit'] }))
      const exits = children.map(async (child) => (await once(child, 'exit'))[0])
      const waitUntil = Date.now() + 20000
      while (!ids.every((id) => existsSync(join(root, `ready-${id}`))) && Date.now() < waitUntil) await new Promise((done) => setTimeout(done, 5))
      writeFileSync(barrier, '')
      assert.deepEqual(await Promise.all(exits), [0, 0])
      const outcomes = ids.map((id) => JSON.parse(readFileSync(join(root, `outcome-${id}.json`), 'utf8')))
      assert.equal(outcomes.filter((value) => value.reclaimed).length, 1, `Round ${round}: ${JSON.stringify(outcomes)}`)
      assert.equal(existsSync(join(root, 'admission.lock')), false)
      assert.equal(readdirSync(join(root, 'receipts')).length, round + 1, 'One receipt per round')
    }
    assert.equal(readdirSync(root).filter((name) => name.startsWith('admission.lock')).length, 0, 'No mutex, staging file or tombstone left')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
