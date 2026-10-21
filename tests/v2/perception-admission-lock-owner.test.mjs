import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assessAdmissionLock, captureLockOwner, withAdmissionLock } from '../../scripts/validation/perception-addon-registry.mjs'
import { parseLinuxProcessStat } from '../../scripts/validation/run-perception-ci.mjs'

// The admission lock carries a provable owner; only a provably dead owner's lock is
// removed. Everything else fails closed with the unchanged deadline message.
const BOOT = '11111111-2222-4333-8444-555555555555'
const NAMESPACE = 'pid:[4026531836]'
const DEADLINE_MESSAGE = 'Registry admission lock deadline; no stale-lock deletion'
const SELF_PID = 4242, SELF_STARTTIME = '500', OWNER_PID = 7001, OWNER_STARTTIME = '900'

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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'apollo-admission-owner.')), lock = join(root, 'admission.lock')
  mkdirSync(join(root, 'receipts'))
  const uid = lstatSync(root).uid, procs = new Map([[SELF_PID, statLine(SELF_PID, SELF_STARTTIME)]])
  const io = { pid: () => SELF_PID, uid: () => uid, selfStat: () => statLine(SELF_PID, SELF_STARTTIME), bootId: () => BOOT,
    pidNamespace: () => NAMESPACE,
    procStat: (pid) => { const value = procs.get(pid); if (value instanceof Error) throw value; if (value === undefined) throw missing(); return value } }
  const doc = (changes = {}) => ({ schemaVersion: 'registry-admission-lock-owner/v1', pid: OWNER_PID, starttime: OWNER_STARTTIME,
    bootId: BOOT, pidNamespace: NAMESPACE, uid, nonce: randomUUID(), createdAt: '2026-10-21T19:27:49.219Z', ...changes })
  const plant = (value = doc()) => {
    mkdirSync(lock, { mode: 0o700 })
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    writeFileSync(join(lock, 'owner.json'), text)
    return Buffer.from(text)
  }
  return { root, lock, uid, procs, io, doc, plant, receipts: () => readdirSync(join(root, 'receipts')),
    cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
async function withFixture(body) { const f = fixture(); try { return await body(f) } finally { f.cleanup() } }

async function assertFailsClosed(f, reason, deadlineMs = 60) {
  await assert.rejects(withAdmissionLock(f.root, () => assert.fail('Action must not run'), { deadlineAt: Date.now() + deadlineMs, io: f.io }), (error) => {
    assert.equal(error.name, 'AssertionError'); assert.equal(error.message, DEADLINE_MESSAGE)
    const facts = error.admissionLockDiagnostic
    assert.equal(facts.reclaim.assessment.reason, reason); assert.notEqual(facts.reclaim.assessment.verdict, 'stale')
    assert.equal(facts.staleLockDeletion, false); assert.deepEqual(facts.reclaim.reclaims, [])
    return true
  })
  assert.deepEqual(f.receipts(), [], 'No removal, so no reclaim receipt')
  assert.equal(readdirSync(f.root).filter((name) => name !== 'receipts' && name !== 'admission.lock' && name !== 'admission.lock.reclaim').length, 0,
    'No staging directory or tombstone left behind')
}

test('an acquired lock is published with its owner already inside it and is released atomically', async () => {
  await withFixture(async (f) => {
    const result = await withAdmissionLock(f.root, async () => {
      assert.deepEqual(readdirSync(f.lock), ['owner.json'])
      const owner = JSON.parse(readFileSync(join(f.lock, 'owner.json'), 'utf8'))
      assert.deepEqual(Object.keys(owner).sort(), ['bootId', 'createdAt', 'nonce', 'pid', 'pidNamespace', 'schemaVersion', 'starttime', 'uid'])
      assert.equal(owner.schemaVersion, 'registry-admission-lock-owner/v1'); assert.equal(owner.pid, SELF_PID)
      assert.equal(owner.starttime, SELF_STARTTIME); assert.equal(owner.bootId, BOOT); assert.equal(owner.pidNamespace, NAMESPACE)
      assert.equal(owner.uid, f.uid); assert.match(owner.nonce, /^[0-9a-f-]{36}$/); assert.ok(Number.isFinite(Date.parse(owner.createdAt)))
      return 'ran'
    }, { io: f.io })
    assert.equal(result, 'ran'); assert.deepEqual(readdirSync(f.root), ['receipts']); assert.deepEqual(f.receipts(), [])
  })
})

test('the lock is released when the action throws, and a release failure never masks the action failure', async () => {
  await withFixture(async (f) => {
    await assert.rejects(withAdmissionLock(f.root, () => { throw new Error('boom') }, { io: f.io }), /boom/)
    assert.deepEqual(readdirSync(f.root), ['receipts'])
    await assert.rejects(withAdmissionLock(f.root, () => {
      writeFileSync(join(f.lock, 'owner.json'), JSON.stringify(f.doc())); throw new Error('boom')
    }, { io: f.io }), /boom/)
    assert.equal(existsSync(f.lock), true, 'A lock this process does not own is never released')
  })
})

test('a lock whose owner changed under the action is not released and the failure is loud', async () => {
  await withFixture(async (f) => {
    await assert.rejects(withAdmissionLock(f.root, () => { writeFileSync(join(f.lock, 'owner.json'), JSON.stringify(f.doc())) }, { io: f.io }),
      /not owned by this process/)
    assert.equal(JSON.parse(readFileSync(join(f.lock, 'owner.json'), 'utf8')).pid, OWNER_PID)
  })
})

test('captureLockOwner commits to the /proc facts of this very process and refuses a /proc that does not describe it', () => {
  const base = { pid: () => SELF_PID, uid: () => 1, now: () => 0, selfStat: () => statLine(SELF_PID, SELF_STARTTIME), bootId: () => BOOT, pidNamespace: () => NAMESPACE }
  const owner = captureLockOwner(base)
  assert.equal(owner.pid, SELF_PID); assert.equal(owner.starttime, SELF_STARTTIME); assert.equal(owner.createdAt, new Date(0).toISOString())
  assert.throws(() => captureLockOwner({ ...base, selfStat: () => statLine(SELF_PID + 1, SELF_STARTTIME) }), /does not describe this process/)
  assert.throws(() => captureLockOwner({ ...base, bootId: () => 'not-a-boot-id' }))
  assert.throws(() => captureLockOwner({ ...base, pidNamespace: () => 'garbage' }))
})

// A: provably dead owners are the only locks removed.
for (const [name, basis, setup] of [
  ['owner pid absent from /proc (ENOENT)', 'proc-stat-absent', () => {}],
  ['owner pid absent from /proc (ESRCH)', 'proc-stat-absent', (f) => f.procs.set(OWNER_PID, missing('ESRCH'))],
  ['owner pid reused by a younger process (starttime differs)', 'pid-recycled', (f) => f.procs.set(OWNER_PID, statLine(OWNER_PID, '901'))],
]) {
  test(`dead owner is removed, acquired within the deadline and recorded in a receipt: ${name}`, async () => {
    await withFixture(async (f) => {
      const staleBytes = f.plant(f.doc()); setup(f)
      let entered = 0
      const result = await withAdmissionLock(f.root, async () => {
        entered += 1
        const owner = JSON.parse(readFileSync(join(f.lock, 'owner.json'), 'utf8'))
        assert.equal(owner.pid, SELF_PID, 'The new lock carries the new owner')
        return 'acquired'
      }, { deadlineAt: Date.now() + 2000, io: f.io })
      assert.equal(result, 'acquired'); assert.equal(entered, 1); assert.deepEqual(readdirSync(f.root), ['receipts'], 'Lock, mutex and tombstone are all gone')
      const files = f.receipts(); assert.equal(files.length, 1); assert.match(files[0], /^admission-lock-reclaim-[0-9a-f-]{36}\.json$/)
      const receipt = JSON.parse(readFileSync(join(f.root, 'receipts', files[0]), 'utf8'))
      assert.equal(receipt.schemaVersion, 'registry-admission-lock-reclaim/v1'); assert.equal(receipt.phase, 'removed')
      assert.equal(receipt.tombstoneRemoved, true); assert.equal(receipt.tombstone, `admission.lock.stale.${receipt.reclaimId}`)
      assert.equal(files[0], `admission-lock-reclaim-${receipt.reclaimId}.json`)
      assert.equal(receipt.staleOwner.pid, OWNER_PID); assert.equal(receipt.staleOwner.starttime, OWNER_STARTTIME)
      assert.equal(receipt.staleOwnerDigest, createHash('sha256').update(staleBytes).digest('hex'))
      assert.equal(receipt.proof.basis, basis); assert.equal(receipt.proof.recordedStarttime, OWNER_STARTTIME)
      assert.equal(receipt.proof.observedStarttime, basis === 'pid-recycled' ? '901' : null)
      assert.equal(receipt.proof.bootId, BOOT); assert.equal(receipt.proof.pidNamespace, NAMESPACE)
      assert.equal(receipt.reclaimer.pid, SELF_PID); assert.notEqual(receipt.reclaimer.nonce, receipt.staleOwner.nonce)
    })
  })
}

// B: everything else fails closed, exactly as before, with the reason in the diagnostic.
const failClosedCases = [
  ['live owner', 'owner-live', (f) => { f.plant(); f.procs.set(OWNER_PID, statLine(OWNER_PID, OWNER_STARTTIME)) }],
  ['live owner whose starttime has leading zeros is the same process', 'owner-live', (f) => { f.plant(f.doc({ starttime: '0900' })); f.procs.set(OWNER_PID, statLine(OWNER_PID, OWNER_STARTTIME)) }],
  ['zombie with the recorded starttime is not proof (a zombie thread-group leader can coexist with live threads)', 'owner-live', (f) => { f.plant(); f.procs.set(OWNER_PID, statLine(OWNER_PID, OWNER_STARTTIME, 'Z')) }],
  ['different boot id', 'boot-id-differs', (f) => f.plant(f.doc({ bootId: '99999999-2222-4333-8444-555555555555' }))],
  ['different PID namespace', 'pid-namespace-differs', (f) => f.plant(f.doc({ pidNamespace: 'pid:[4026532000]' }))],
  ['legacy bare mkdir lock', 'owner-missing', (f) => mkdirSync(f.lock)],
  ['directory without owner.json', 'owner-missing', (f) => { mkdirSync(f.lock); writeFileSync(join(f.lock, 'other'), '') }],
  ['owner.json is not JSON', 'owner-document-invalid', (f) => f.plant('{')],
  ['owner.json has an extra field', 'owner-document-invalid', (f) => f.plant({ ...f.doc(), extra: 1 })],
  ['owner.json lacks the pid', 'owner-document-invalid', (f) => { const value = f.doc(); delete value.pid; f.plant(value) }],
  ['owner.json has a numeric starttime', 'owner-document-invalid', (f) => f.plant(f.doc({ starttime: 900 }))],
  ['owner.json has the wrong schema', 'owner-document-invalid', (f) => f.plant(f.doc({ schemaVersion: 'other/v1' }))],
  ['owner.json has a non-uuid nonce', 'owner-document-invalid', (f) => f.plant(f.doc({ nonce: 'x' }))],
  ['owner.json is oversized', 'owner-document-invalid', (f) => f.plant(JSON.stringify({ ...f.doc(), pad: 'x'.repeat(5000) }))],
  ['owner.json is a directory', 'owner-document-invalid', (f) => { mkdirSync(f.lock); mkdirSync(join(f.lock, 'owner.json')) }],
  ['lock holds unexpected extra entries', 'unexpected-entries', (f) => { f.plant(); writeFileSync(join(f.lock, 'extra'), '') }],
  ['owner uid is not this uid', 'owner-uid-mismatch', (f) => f.plant(f.doc({ uid: f.uid + 1 }))],
  ['lock is not owned by this uid', 'lock-uid-mismatch', (f) => { f.plant(); f.io.uid = () => f.uid + 1 }],
  ['lock path is a file, not a directory', 'lock-not-a-directory', (f) => writeFileSync(f.lock, '')],
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
]) {
  test(`a /proc that cannot be verified fails closed: ${name}`, async () => {
    await withFixture(async (f) => {
      f.plant(); const healthy = f.io[reader]; let calls = 0
      f.io[reader] = () => (++calls === 1 ? healthy() : degraded())
      await assertFailsClosed(f, 'self-proc-unverifiable')
    })
  })
}

test('a bare legacy lock is never renamed over and no staging directory is left behind', async () => {
  await withFixture(async (f) => {
    mkdirSync(f.lock)
    await assertFailsClosed(f, 'owner-missing')
    assert.deepEqual(readdirSync(f.lock), []); assert.deepEqual(readdirSync(f.root).sort(), ['admission.lock', 'receipts'])
  })
})

test('the failure diagnostic carries the owner facts and the unchanged read-only lock state', async () => {
  await withFixture(async (f) => {
    f.plant(); f.procs.set(OWNER_PID, statLine(OWNER_PID, OWNER_STARTTIME))
    await assert.rejects(withAdmissionLock(f.root, () => assert.fail('Action must not run'), { deadlineAt: Date.now() + 40, io: f.io }), (error) => {
      const facts = error.admissionLockDiagnostic
      assert.equal(facts.schemaVersion, 'registry-admission-lock-state/v1'); assert.equal(facts.exists, true); assert.equal(facts.kind, 'directory')
      assert.deepEqual(facts.entries, { count: 1, names: ['owner.json'] })
      assert.deepEqual(facts.owner, { carried: true, source: 'owner.json', pid: OWNER_PID, starttime: OWNER_STARTTIME, alive: true, aliveBasis: 'proc-stat-live' })
      assert.equal(facts.reclaim.assessment.verdict, 'live'); assert.equal(facts.reclaim.assessment.owner.pid, OWNER_PID)
      assert.equal(facts.reclaim.assessment.owner.bootId, BOOT); assert.equal(facts.reclaim.mutex, null)
      assert.deepEqual(JSON.parse(JSON.stringify(facts)), facts); assert.doesNotMatch(JSON.stringify(facts), /PRIVATE_/)
      return true
    })
  })
})

test('an orphaned reclaim mutex fails closed and is reported, never reclaimed', async () => {
  await withFixture(async (f) => {
    f.plant(); const mutex = `${f.lock}.reclaim`
    mkdirSync(mutex); writeFileSync(join(mutex, 'owner.json'), JSON.stringify(f.doc()))
    await assert.rejects(withAdmissionLock(f.root, () => assert.fail('Action must not run'), { deadlineAt: Date.now() + 60, io: f.io }), (error) => {
      assert.equal(error.message, DEADLINE_MESSAGE)
      assert.equal(error.admissionLockDiagnostic.reclaim.assessment.reason, 'reclaim-mutex-held')
      assert.equal(error.admissionLockDiagnostic.reclaim.mutex.exists, true); assert.equal(error.admissionLockDiagnostic.staleLockDeletion, false)
      return true
    })
    assert.equal(existsSync(f.lock), true); assert.equal(existsSync(mutex), true); assert.deepEqual(f.receipts(), [])
  })
})

test('without a writable receipt directory nothing is removed (no un-audited removal)', async () => {
  await withFixture(async (f) => {
    f.plant(); rmSync(join(f.root, 'receipts'), { recursive: true })
    await assert.rejects(withAdmissionLock(f.root, () => assert.fail('Action must not run'), { deadlineAt: Date.now() + 60, io: f.io }), (error) => {
      assert.equal(error.message, DEADLINE_MESSAGE); assert.match(error.admissionLockDiagnostic.reclaim.assessment.reason, /^reclaim-receipt-/)
      return true
    })
    assert.equal(existsSync(f.lock), true); assert.deepEqual(readdirSync(f.root).sort(), ['admission.lock'])
  })
})

test('two contenders racing on the same stale lock: exactly one reclaims, they never overlap', async () => {
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

test('a lock swapped between assessment and rename is detected by the owner digest, restored and fails closed', async () => {
  await withFixture(async (f) => {
    f.plant(); const live = f.doc({ pid: OWNER_PID + 1 })
    f.procs.set(OWNER_PID + 1, statLine(OWNER_PID + 1, OWNER_STARTTIME))
    let swapped = false
    f.io.rename = (from, to) => {
      // The dead owner's lock is replaced by a live owner's lock right before the reclaim rename (violating the model).
      if (!swapped && from === f.lock && /\.stale\./.test(to)) {
        swapped = true; rmSync(f.lock, { recursive: true }); mkdirSync(f.lock); writeFileSync(join(f.lock, 'owner.json'), JSON.stringify(live))
      }
      return renameSync(from, to)
    }
    await assert.rejects(withAdmissionLock(f.root, () => assert.fail('Action must not run'), { deadlineAt: Date.now() + 500, io: f.io }),
      /changed during stale-lock reclaim/)
    assert.equal(swapped, true)
    assert.equal(JSON.parse(readFileSync(join(f.lock, 'owner.json'), 'utf8')).pid, OWNER_PID + 1, 'The live owner lock was restored')
    assert.equal(readdirSync(f.root).some((name) => name.endsWith('.reclaim')), false, 'The reclaim mutex is released')
  })
})

// C: mutation checks of the proofs. Each mutant is a textual edit of the real module.
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
    ['live', (f) => f.procs.set(OWNER_PID, statLine(OWNER_PID, OWNER_STARTTIME))],
    ['otherBoot', (f, plant) => plant(f.doc({ bootId: '99999999-2222-4333-8444-555555555555' }))],
    ['otherNamespace', (f, plant) => plant(f.doc({ pidNamespace: 'pid:[4026532000]' }))],
  ]) {
    const f = fixture()
    try {
      let planted = false
      setup(f, (value) => { f.plant(value); planted = true })
      if (!planted) f.plant()
      table[name] = module.assessAdmissionLock(f.lock, f.io).verdict
    } finally { f.cleanup() }
  }
  return table
}

test('mutation checks: the starttime comparison, the bootId check, the PID namespace check and the absence proof each matter', async () => {
  const original = verdictTable({ assessAdmissionLock })
  assert.deepEqual(original, { absent: 'stale', recycled: 'stale', live: 'live', otherBoot: 'unproven', otherNamespace: 'unproven' })
  for (const [label, from, to, differs] of [
    ['starttime comparison ignored', 'BigInt(observed.starttime) !== BigInt(owner.starttime)', 'false', 'recycled'],
    ['starttime comparison inverted', 'BigInt(observed.starttime) !== BigInt(owner.starttime)', 'true', 'live'],
    ['bootId check removed', 'owner.bootId !== bootId', 'false', 'otherBoot'],
    ['PID namespace check removed', 'owner.pidNamespace !== pidNamespace', 'false', 'otherNamespace'],
    ['absence proof removed', "['ENOENT', 'ESRCH'].includes(error?.code)) return stale", 'false) return stale', 'absent'],
  ]) {
    const mutated = verdictTable(await loadMutant(from, to))
    assert.notDeepEqual(mutated, original, `${label}: mutant must be caught`)
    assert.notEqual(mutated[differs], original[differs], `${label}: the ${differs} case must flip`)
  }
})

// D: real /proc, real rename(2), real processes (Linux only).
const linux = { skip: process.platform !== 'linux' }
async function deadChildOwner() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const starttime = parseLinuxProcessStat(readFileSync(`/proc/${child.pid}/stat`, 'utf8')).starttime
  child.kill('SIGKILL'); await once(child, 'exit')
  return { ...captureLockOwner(), pid: child.pid, starttime, nonce: randomUUID() }
}
function realRoot() {
  const root = mkdtempSync(join(tmpdir(), 'apollo-admission-real.')); mkdirSync(join(root, 'receipts'))
  return root
}
function plantReal(root, owner) {
  mkdirSync(join(root, 'admission.lock')); writeFileSync(join(root, 'admission.lock', 'owner.json'), JSON.stringify(owner))
}

test('real /proc: a SIGKILLed owner is reclaimed; a live owner and a recycled-looking live process are judged correctly', linux, async () => {
  const root = realRoot()
  try {
    plantReal(root, await deadChildOwner())
    assert.equal(await withAdmissionLock(root, () => 'acquired', { deadlineAt: Date.now() + 3000 }), 'acquired')
    assert.equal(readdirSync(join(root, 'receipts')).length, 1); assert.deepEqual(readdirSync(root), ['receipts'])
    const self = captureLockOwner()
    plantReal(root, { ...self, nonce: randomUUID() })
    assert.equal(assessAdmissionLock(join(root, 'admission.lock')).verdict, 'live')
    rmSync(join(root, 'admission.lock'), { recursive: true })
    plantReal(root, { ...self, nonce: randomUUID(), starttime: String(BigInt(self.starttime) + 1n) })
    const recycled = assessAdmissionLock(join(root, 'admission.lock'))
    assert.equal(recycled.verdict, 'stale'); assert.equal(recycled.proof.basis, 'pid-recycled')
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
