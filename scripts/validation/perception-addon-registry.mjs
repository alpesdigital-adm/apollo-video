import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { basename, join, posix, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseLinuxProcessStat, parseLinuxProcessCredentials } from './run-perception-ci.mjs'

export const CI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const CI_PIDFD_SOURCE_PATHS = Object.freeze([
  'scripts/validation/perception-pidfd.c', 'scripts/validation/perception-pidfd.mjs',
  'scripts/validation/perception-addon-registry.mjs', 'scripts/validation/build-perception-pidfd.sh',
  'scripts/validation/build-perception-pidfd.mjs', 'scripts/validation/perception-ci-child-bootstrap.mjs',
  'scripts/validation/run-perception-addon-consumer.mjs', 'scripts/validation/cleanup-perception-pidfd.mjs',
  'scripts/validation/run-perception-ci.mjs', 'scripts/validation/run-perception-ci-namespace.mjs',
  'scripts/validation/run-perception-namespace-gates.mjs', 'scripts/validation/perception_namespace_warden.py',
  'scripts/validation/perception-observer-channel.mjs',
  'scripts/validation/perception-outer-host-death.mjs',
  'scripts/validation/perception-namespace-node-bootstrap.mjs',
  'scripts/validation/perception-consumer-cgroup.py', 'scripts/validation/perception-consumer-cgroup.mjs',
  'tests/v2/perception-consumer-cgroup.integration.mjs',
  'scripts/validation/acquire-dashboard-cft157-linux.py',
  'tests/v2/dashboard-runtime-journey.e2e.mjs',
  'tests/v2/helpers/dashboard-runtime-journey.mjs', 'tests/v2/helpers/library-browser-proof.mjs',
  'src/components/AppShellNavigation.tsx',
  'tests/v2/helpers/catalog-output-browser-proof.mjs', 'package-lock.json',
])
export const identityKey = (value) => `${value.pid}:${value.starttime}`
export const liveIdentity = (value) => value && !['Z', 'X', 'x'].includes(value.state)
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const jsonDigest = (value) => digest(Buffer.from(JSON.stringify(value)))
const allowedRoot = /^apollo-ci-pidfd\.[A-Za-z0-9_-]+$/

function admissionCheck(deadlineAt, signal) {
  assert.ok(!signal?.aborted && Date.now() < deadlineAt, 'Registry admission deadline exhausted')
}

function readAdmissionFile(path, limit, deadlineAt = Infinity, signal) {
  admissionCheck(deadlineAt, signal)
  const fd = openSync(path, 'r')
  try {
    admissionCheck(deadlineAt, signal)
    const metadata = fstatSync(fd)
    assert.ok(metadata.isFile() && metadata.size <= limit, 'Registry admission input exceeds byte bound')
    const chunks = []; let size = 0
    while (true) {
      admissionCheck(deadlineAt, signal)
      const chunk = Buffer.alloc(Math.min(65536, limit - size + 1))
      const bytes = readSync(fd, chunk, 0, chunk.length, null)
      admissionCheck(deadlineAt, signal)
      if (!bytes) break
      size += bytes
      assert.ok(size <= limit, 'Registry admission input grew beyond byte bound')
      chunks.push(chunk.subarray(0, bytes))
    }
    return Buffer.concat(chunks, size)
  } finally { closeSync(fd) }
}

export function readAuthorityIdentitySync(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0)
  const identity = parseLinuxProcessStat(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  const status = readFileSync(`/proc/${pid}/status`, 'utf8')
  const credentials = parseLinuxProcessCredentials(status)
  const namespace = readlinkSync(`/proc/${pid}/ns/pid`)
  const verified = parseLinuxProcessStat(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  assert.equal(identityKey(verified), identityKey(identity), 'Identity changed during synchronous birth capture')
  assert.match(namespace, /^pid:\[\d+\]$/)
  const nspids = /^NSpid:\s+([\d\s]+)$/m.exec(status)?.[1].trim().split(/\s+/).map(Number)
  assert.ok(nspids?.length && nspids[0] === pid)
  return Object.freeze({ ...verified, ...credentials, namespace, nspids })
}

export async function budget(action, deadlineAt, limit, label) {
  const saldo = deadlineAt - Date.now()
  assert.ok(saldo > 0, `${label}: expired before action`)
  let timer
  try { return await Promise.race([action(), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: deadline exceeded`)), Math.min(saldo, limit))
  })]) } finally { clearTimeout(timer) }
}

export function assertOwnedRoot(root, env = process.env, expected) {
  assert.ok(env.RUNNER_TEMP && resolve(root).startsWith(resolve(env.RUNNER_TEMP) + '/'))
  assert.match(root.slice(root.lastIndexOf('/') + 1), allowedRoot)
  const actual = lstatSync(root)
  assert.ok(actual.isDirectory() && !actual.isSymbolicLink() && actual.uid === process.getuid() && (actual.mode & 0o777) === 0o700)
  if (expected) { assert.equal(actual.dev, expected.dev); assert.equal(actual.ino, expected.ino) }
  return { path: resolve(root), dev: actual.dev, ino: actual.ino, uid: actual.uid }
}

export function readRegistry(root, env = process.env, { deadlineAt = Infinity, signal } = {}) {
  admissionCheck(deadlineAt, signal)
  assertOwnedRoot(root, env)
  const path = join(root, 'registry.json'), entry = lstatSync(path)
  assert.ok(entry.isFile() && !entry.isSymbolicLink() && entry.uid === process.getuid() && entry.size <= 65536)
  const registry = JSON.parse(readAdmissionFile(path, 65536, deadlineAt, signal).toString('utf8'))
  assert.equal(registry.schemaVersion, 'perception-pidfd-registry/v1')
  assert.equal(registry.sourceCommit, env.GITHUB_SHA)
  assertOwnedRoot(root, env, registry.root)
  assert.match(registry.runId, /^pidfd-build-[a-f0-9-]+$/)
  return registry
}

export function writeRegistry(root, value) {
  const path = join(root, 'registry.json'), pending = join(root, `registry.${randomUUID()}.pending`)
  writeFileSync(pending, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 })
  renameSync(pending, path)
}

// Every effect and every /proc / boot / uid fact of the admission lock goes through
// this object so each branch is unit-testable with injected readers.
const lockIo = Object.freeze({ lstat: lstatSync, readdir: readdirSync, readFile: readFileSync,
  procStat: (pid) => readFileSync(`/proc/${pid}/stat`, 'utf8'),
  selfStat: () => readFileSync('/proc/self/stat', 'utf8'),
  bootId: () => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
  pidNamespace: () => readlinkSync('/proc/self/ns/pid'),
  // Kernels without time namespaces have no such link: recorded and compared as null.
  timeNamespace: () => { try { return readlinkSync('/proc/self/ns/time') } catch (error) { if (error?.code === 'ENOENT') return null; throw error } },
  pid: () => process.pid, uid: () => process.getuid(), now: () => Date.now(),
  link: linkSync, unlink: unlinkSync, rename: renameSync, writeFile: writeFileSync,
  writeOwner: (path, text) => {
    const fd = openSync(path, 'wx', 0o600)
    try { writeSync(fd, text); fsyncSync(fd) } finally { closeSync(fd) }
  } })

// Read-only evidence for a failed admission-lock acquisition (it never repairs
// anything; removal of a provably gone owner's lock is `reclaimAdmissionLock`).
// A lock published by `registryLock` is a FILE holding the owner document; a legacy
// bare `mkdir` directory lock carries no owner (`owner.carried` false) and its
// holder's liveness cannot be established from the lock alone.
// If a lock file (or an `owner.json` inside a lock directory) carries
// `{pid, starttime?}`, its owner is looked up in /proc without any signal. This is
// evidence only: the reclaim decision is the stricter `assessAdmissionLock`.
// `ageMs` is the time since the lock inode's mtime, i.e. since its creation.
export function describeAdmissionLock(lockPath, { now = Date.now(), io = lockIo } = {}) {
  const facts = { schemaVersion: 'registry-admission-lock-state/v1', path: String(lockPath).slice(0, 512),
    observedAt: new Date(now).toISOString(), exists: false, kind: null, stat: null, entries: null,
    owner: { carried: false, source: null, pid: null, starttime: null, alive: null, aliveBasis: null },
    readErrors: [], staleLockDeletion: false }
  const note = (stage, error) => { if (facts.readErrors.length < 8) facts.readErrors.push({ stage, code: error?.code ?? error?.name ?? null }) }
  let metadata
  try { metadata = io.lstat(lockPath) }
  catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) note('lstat', error); return facts }
  facts.exists = true
  facts.kind = metadata.isDirectory() ? 'directory' : metadata.isFile() ? 'file' : metadata.isSymbolicLink() ? 'symlink' : 'other'
  facts.stat = { size: metadata.size, mtimeMs: metadata.mtimeMs, ctimeMs: metadata.ctimeMs, birthtimeMs: metadata.birthtimeMs,
    ino: metadata.ino, dev: metadata.dev, nlink: metadata.nlink, uid: metadata.uid, mode: (metadata.mode & 0o7777).toString(8),
    ageMs: Number.isFinite(metadata.mtimeMs) ? Math.max(0, now - metadata.mtimeMs) : null }
  let ownerPath = null
  if (facts.kind === 'directory') {
    try {
      const names = io.readdir(lockPath).map(String)
      facts.entries = { count: names.length, names: names.slice(0, 8).map((name) => /^[A-Za-z0-9._-]{1,64}$/.test(name) ? name : '<redacted>') }
      if (names.includes('owner.json')) ownerPath = join(lockPath, 'owner.json')
    } catch (error) { note('readdir', error) }
  } else if (facts.kind === 'file') ownerPath = lockPath
  if (ownerPath) {
    try {
      const ownerMeta = ownerPath === lockPath ? metadata : io.lstat(ownerPath)
      assert.ok(ownerMeta.isFile() && ownerMeta.size <= 4096, 'Lock owner document is not a bounded regular file')
      const bytes = io.readFile(ownerPath)
      assert.ok(Buffer.byteLength(bytes) <= 4096, 'Lock owner document exceeds byte bound')
      const owner = JSON.parse(Buffer.from(bytes).toString('utf8'))
      assert.ok(owner && typeof owner === 'object' && Number.isSafeInteger(owner.pid) && owner.pid > 0, 'Lock owner document has no PID')
      Object.assign(facts.owner, { carried: true, source: ownerPath === lockPath ? 'lock-file' : 'owner.json', pid: owner.pid,
        starttime: typeof owner.starttime === 'string' && /^\d{1,32}$/.test(owner.starttime) ? owner.starttime : null })
      try {
        const current = parseLinuxProcessStat(io.procStat(owner.pid))
        const same = facts.owner.starttime === null || current.starttime === facts.owner.starttime
        facts.owner.alive = same && !['Z', 'X', 'x'].includes(current.state)
        facts.owner.aliveBasis = !same ? 'pid-recycled' : facts.owner.alive ? 'proc-stat-live' : `proc-stat-state-${current.state}`
      } catch (error) {
        if (['ENOENT', 'ESRCH'].includes(error?.code)) Object.assign(facts.owner, { alive: false, aliveBasis: 'proc-stat-absent' })
        else {
          // The sighand-unavailable tuple, a missing /proc or a denial is no liveness claim either way.
          facts.owner.aliveBasis = error?.linuxStatDiagnostic?.unavailableObservation ? 'proc-stat-unavailable-tuple'
            : `proc-stat-error-${error?.code ?? error?.name ?? 'unknown'}`
        }
      }
    } catch (error) { note('owner-document', error) }
  }
  return facts
}

const LOCK_OWNER_SCHEMA = 'registry-admission-lock-owner/v2'
const LOCK_RECLAIM_SCHEMA = 'registry-admission-lock-reclaim/v2'
const LOCK_OWNER_KEYS = Object.freeze(['bootId', 'createdAt', 'nonce', 'observerRunId', 'pid', 'pidNamespace', 'schemaVersion',
  'starttime', 'timeNamespace', 'uid'])
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const PID_NAMESPACE_SHAPE = /^pid:\[\d+\]$/
const TIME_NAMESPACE_SHAPE = /^time:\[\d+\]$/
const RUN_ID_SHAPE = /^[A-Za-z0-9._-]{1,128}$/
const NO_ENTRY = Object.freeze(['ENOENT', 'ENOTDIR'])
const LOCK_FILE_LIMIT = 4096

// The identity a lock holder commits to inside the lock itself. `starttime`
// (/proc/<pid>/stat field 22) plus the boot id make a PID reusable only by a
// younger process; the PID namespace says which /proc can answer; the time
// namespace says the starttime clock is comparable; `observerRunId` binds a lock
// taken inside a private namespace to the host supervisor run that observes it.
export function captureLockOwner(io = lockIo, { observerRunId = null } = {}) {
  const pid = io.pid()
  const self = parseLinuxProcessStat(io.selfStat())
  assert.equal(self.pid, pid, 'Admission lock owner: /proc does not describe this process')
  const pidNamespace = io.pidNamespace(), bootId = io.bootId(), timeNamespace = io.timeNamespace()
  assert.match(pidNamespace, PID_NAMESPACE_SHAPE); assert.match(bootId, UUID_SHAPE)
  assert.ok(timeNamespace === null || TIME_NAMESPACE_SHAPE.test(timeNamespace))
  assert.ok(observerRunId === null || RUN_ID_SHAPE.test(observerRunId))
  return { schemaVersion: LOCK_OWNER_SCHEMA, pid, starttime: self.starttime, bootId, pidNamespace, timeNamespace,
    observerRunId, uid: io.uid(), nonce: randomUUID(), createdAt: new Date(io.now()).toISOString() }
}

function parseLockOwner(text) {
  const owner = JSON.parse(text)
  assert.ok(owner && typeof owner === 'object' && !Array.isArray(owner), 'Lock owner is not an object')
  assert.deepEqual(Object.keys(owner).sort(), LOCK_OWNER_KEYS, 'Lock owner has unexpected fields')
  assert.equal(owner.schemaVersion, LOCK_OWNER_SCHEMA)
  assert.ok(Number.isSafeInteger(owner.pid) && owner.pid > 0 && Number.isSafeInteger(owner.uid) && owner.uid >= 0)
  assert.match(owner.starttime, /^\d{1,32}$/); assert.match(owner.bootId, UUID_SHAPE); assert.match(owner.nonce, UUID_SHAPE)
  assert.match(owner.pidNamespace, PID_NAMESPACE_SHAPE)
  assert.ok(owner.timeNamespace === null || TIME_NAMESPACE_SHAPE.test(owner.timeNamespace))
  assert.ok(owner.observerRunId === null || RUN_ID_SHAPE.test(owner.observerRunId))
  assert.ok(typeof owner.createdAt === 'string' && Number.isFinite(Date.parse(owner.createdAt)))
  return owner
}

function pathExists(path, io) {
  try { io.lstat(path); return true } catch (error) { if (NO_ENTRY.includes(error?.code)) return false; throw error }
}

const runTag = (runId) => createHash('sha256').update(runId ?? '').digest('hex').slice(0, 8)

// Staging files and tombstones carry their creator's identity in the NAME, so a
// leftover of a creator killed before the content was complete is still
// attributable: `<base>.<new|stale>.<pidNsInode>-<pid>-<starttime>-<runTag>.<uuid>`.
function leftoverName(base, kind, creator) {
  return `${base}.${kind}.${/^pid:\[(\d+)\]$/.exec(creator.pidNamespace)[1]}-${creator.pid}-${creator.starttime}-${runTag(creator.observerRunId)}.${randomUUID()}`
}
const LEFTOVER_NAME = /^(admission\.lock(?:\.reclaim)?)\.(new|stale|released)\.(\d+)-([1-9]\d*)-(\d{1,32})-([0-9a-f]{8})\.[0-9a-f-]{36}$/
export function parseLockLeftoverName(name) {
  if (name === 'admission.lock') return { kind: 'lock' }
  if (name === 'admission.lock.reclaim') return { kind: 'mutex' }
  const match = LEFTOVER_NAME.exec(String(name))
  if (!match) return null
  return { kind: match[2] === 'new' ? 'staging' : 'tombstone', base: match[1], creator: {
    pidNamespace: `pid:[${match[3]}]`, pid: Number(match[4]), starttime: match[5], runTag: match[6] } }
}

// What a host supervisor that already proved a private PID namespace EMPTY hands
// over: every process that ever lived in `namespace`, including any lock owner, is
// gone. The proof is the same structural evidence cleanup demands of namespace owners.
export function namespaceEmptyProof(report, evidence, { sourceCommit } = {}) {
  try {
    assert.match(report.runId, RUN_ID_SHAPE)
    if (sourceCommit !== undefined) assert.equal(report.sourceCommit, sourceCommit)
    const namespace = report.namespaceBinding?.directlyObserved?.namespace
    assert.match(namespace, PID_NAMESPACE_SHAPE)
    const anchor = report.namespaceBinding?.wardenAttested?.localNodeIdentity
    assert.match(anchor?.starttime, /^\d{1,32}$/)
    assert.equal(report.childCloseObserved, true)
    const last = report.rootReceipts?.at(-1)
    assert.equal(last?.stage, 'guardian-final'); assert.equal(last.initFinal?.nodeCloseObserved, true)
    assert.equal(last.initFinal.cleanup?.namespaceEmpty, true)
    assert.equal(report.externalIdentities?.length, 5); assert.ok(report.externalIdentities.every((value) => value.terminal === true))
    assert.equal(report.postflight?.backendCount, 0)
    return Object.freeze({ kind: 'namespace-empty', runId: report.runId, namespace, anchorStarttime: anchor.starttime,
      evidence: { path: String(evidence?.path ?? '').slice(0, 512), sha256: evidence?.sha256 ?? null } })
  } catch { return null }
}

// Judges whether a lock creator is provably gone. `identity` always has
// pidNamespace/pid/starttime; a lock document adds bootId, timeNamespace, uid and
// observerRunId, a file NAME adds runTag only. Anything not proven is not stale.
function judgeCreator(identity, io, namespaceProofs) {
  const unproven = (reason) => ({ verdict: 'unproven', reason })
  let bootId, pidNamespace, timeNamespace
  try {
    assert.equal(parseLinuxProcessStat(io.selfStat()).pid, io.pid())
    bootId = io.bootId(); pidNamespace = io.pidNamespace(); timeNamespace = io.timeNamespace()
    assert.match(bootId, UUID_SHAPE); assert.match(pidNamespace, PID_NAMESPACE_SHAPE)
    assert.ok(timeNamespace === null || TIME_NAMESPACE_SHAPE.test(timeNamespace))
  } catch { return unproven('self-proc-unverifiable') }
  if (identity.bootId !== undefined && identity.bootId !== bootId) return unproven('boot-id-differs')
  if (identity.pidNamespace !== pidNamespace) {
    // A private PID namespace this process cannot see into: only a host supervisor's proof that the
    // whole namespace is empty (bound to this run and to a process born after its anchor) proves death.
    const bound = (value) => identity.observerRunId !== undefined ? identity.observerRunId !== null && identity.observerRunId === value.runId
      : identity.runTag !== undefined && identity.runTag === runTag(value.runId)
    const proof = namespaceProofs.find((value) => value.namespace === identity.pidNamespace &&
      BigInt(identity.starttime) >= BigInt(value.anchorStarttime) && bound(value))
    return proof ? { verdict: 'stale', reason: 'namespace-empty', proof: { basis: 'namespace-empty', runId: proof.runId,
      namespace: proof.namespace, anchorStarttime: proof.anchorStarttime, evidence: proof.evidence, recordedStarttime: identity.starttime,
      bootId, pidNamespace } } : unproven('pid-namespace-differs')
  }
  // Time namespaces shift /proc starttime, so the clock is only comparable inside the same one.
  if (identity.timeNamespace !== undefined && identity.timeNamespace !== timeNamespace) return unproven('time-namespace-differs')
  const stale = (basis, observedStarttime = null) => ({ verdict: 'stale', reason: basis,
    proof: { basis, recordedStarttime: identity.starttime, observedStarttime, bootId, pidNamespace, timeNamespace } })
  let observed
  try { observed = parseLinuxProcessStat(io.procStat(identity.pid)) }
  catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error?.code)) return stale('proc-stat-absent')
    return unproven(error?.code === 'ERR_ASSERTION' ? 'proc-stat-unparseable' : `proc-stat-${error?.code ?? 'error'}`)
  }
  if (observed.pid !== identity.pid) return unproven('proc-stat-pid-mismatch')
  // A reused PID belongs to a strictly younger process; equal is the same process, older is not a proof.
  if (BigInt(observed.starttime) > BigInt(identity.starttime)) return stale('pid-recycled', observed.starttime)
  if (BigInt(observed.starttime) < BigInt(identity.starttime)) return unproven('starttime-went-backwards')
  return { verdict: 'live', reason: 'owner-live', observedState: observed.state }
}

// Read-only decision for the lock at `lockPath`. `stale` is returned ONLY when every
// proof holds; a legacy directory lock, a live owner, a zombie, another boot, a
// namespace without a proof, or any read error is `live`/`unproven` and callers fail closed.
export function assessAdmissionLock(lockPath, ioOverride = {}, { namespaceProofs = [] } = {}) {
  const io = { ...lockIo, ...ioOverride }
  const unproven = (reason, extra = {}) => ({ verdict: 'unproven', reason, ...extra })
  let metadata
  try { metadata = io.lstat(lockPath) }
  catch (error) { return NO_ENTRY.includes(error?.code) ? { verdict: 'absent', reason: 'lock-absent' } : unproven(`lock-lstat-${error?.code ?? 'error'}`) }
  if (metadata.isDirectory()) return unproven('legacy-directory-lock')
  if (!metadata.isFile()) return unproven('lock-not-a-file')
  let uid
  try { uid = io.uid() } catch { return unproven('uid-unavailable') }
  if (metadata.uid !== uid) return unproven('lock-uid-mismatch')
  let owner, ownerDigest
  try {
    assert.ok(metadata.size <= LOCK_FILE_LIMIT)
    const bytes = Buffer.from(io.readFile(lockPath))
    assert.ok(bytes.length <= LOCK_FILE_LIMIT)
    owner = parseLockOwner(bytes.toString('utf8')); ownerDigest = digest(bytes)
  } catch { return unproven('owner-document-invalid') }
  if (owner.uid !== uid) return unproven('owner-uid-mismatch', { owner })
  const judged = judgeCreator(owner, io, namespaceProofs)
  const result = { ...judged, owner, ownerDigest }
  if (judged.verdict === 'stale') result.lock = { dev: metadata.dev, ino: metadata.ino,
    ageMs: Number.isFinite(metadata.mtimeMs) ? Math.max(0, io.now() - metadata.mtimeMs) : null }
  return result
}

// A root entry named like an admission-lock artifact (staging file, tombstone,
// reclaim mutex, the lock itself): is its creator provably gone? Used by cleanup.
export function assessLockLeftover(path, parsed, ioOverride = {}, { namespaceProofs = [] } = {}) {
  const io = { ...lockIo, ...ioOverride }
  if (parsed.kind === 'lock' || parsed.kind === 'mutex') return assessAdmissionLock(path, io, { namespaceProofs })
  let metadata
  try { metadata = io.lstat(path) } catch (error) { return { verdict: 'unproven', reason: `leftover-lstat-${error?.code ?? 'error'}` } }
  if (!metadata.isFile()) return { verdict: 'unproven', reason: 'leftover-not-a-file' }
  try { assert.equal(metadata.uid, io.uid()) } catch { return { verdict: 'unproven', reason: 'leftover-uid-mismatch' } }
  return { ...judgeCreator(parsed.creator, io, namespaceProofs), name: basename(path) }
}

// Publishes `path` as a FILE whose owner document is already complete: written and
// fsynced to a private staging file, then link(2)ed to `path`. link never replaces
// anything (EEXIST on any existing entry, including a legacy directory lock) and
// the lock never exists half-written. Staging happens only while `path` is absent.
function publishOwnedFile(path, ownerText, creator, io) {
  if (pathExists(path, io)) return false
  const staging = leftoverName(path, 'new', creator)
  try {
    io.writeOwner(staging, ownerText)
    try { io.link(staging, path); return true }
    catch (error) { if (pathExists(path, io)) return false; throw error }
  } finally { try { io.unlink(staging) } catch { /* A leftover staging file stays attributable by name for cleanup. */ } }
}

// Releasing renames the lock to a unique tombstone (atomic held -> absent), verifies that the
// bytes are exactly the ones this process published, then unlinks the tombstone. Anything else
// is put back with link(2), which cannot replace, and refused.
function releaseOwnedFile(path, ownerText, creator, io) {
  const tombstone = leftoverName(path, 'released', creator)
  io.rename(path, tombstone)
  let bytes = null
  try { bytes = Buffer.from(io.readFile(tombstone)) } catch { /* Treated as not ours below. */ }
  if (bytes === null || !bytes.equals(Buffer.from(ownerText))) {
    try { io.link(tombstone, path); io.unlink(tombstone) } catch { /* The tombstone stays as evidence. */ }
    assert.fail('Admission lock is not owned by this process; refusing to release it')
  }
  io.unlink(tombstone)
}

// Removal of one provably stale entry (the lock, or an orphaned reclaim mutex): intent receipt first
// (no receipt, no removal), rename to a unique tombstone, re-verify the tombstone's bytes against the
// assessed digest (a mismatch is put back with link, never rename), unlink, final receipt.
function removeStaleEntry(root, target, assessment, holder, io) {
  const tombstone = leftoverName(target, 'stale', holder), id = randomUUID()
  const receiptPath = join(root, 'receipts', `admission-lock-reclaim-${id}.json`)
  const record = { schemaVersion: LOCK_RECLAIM_SCHEMA, reclaimId: id, phase: 'intent', target: basename(target),
    lock: target.slice(0, 512), tombstone: basename(tombstone), observedAt: new Date(io.now()).toISOString(), reclaimer: holder,
    staleOwner: assessment.owner, staleOwnerDigest: assessment.ownerDigest, proof: assessment.proof,
    lockStat: assessment.lock, tombstoneRemoved: null }
  try { io.writeFile(receiptPath, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 }) }
  catch (error) { return { reclaimed: false, assessment: { ...assessment, verdict: 'unproven', reason: `reclaim-receipt-${error?.code ?? 'unavailable'}` } } }
  try { io.rename(target, tombstone) }
  catch (error) { return { reclaimed: false, assessment: { ...assessment, verdict: 'unproven', reason: `reclaim-rename-${error?.code ?? 'failed'}` } } }
  let renamed = null
  try { renamed = digest(Buffer.from(io.readFile(tombstone))) } catch { /* Treated as a mismatch below. */ }
  if (renamed !== assessment.ownerDigest) {
    // Not the entry that was judged: put it back WITHOUT replacing anything (link fails if a new one exists).
    try { io.link(tombstone, target); io.unlink(tombstone) } catch { /* The tombstone stays as evidence. */ }
    throw new Error('Admission lock changed during stale-lock reclaim; failing closed')
  }
  let removed = true
  try { io.unlink(tombstone) } catch { removed = false }
  record.phase = 'removed'; record.tombstoneRemoved = removed
  try { io.writeFile(receiptPath, JSON.stringify(record, null, 2), { flag: 'w', mode: 0o600 }) } catch { /* The intent receipt remains. */ }
  return { reclaimed: true, assessment, record }
}

// An orphaned reclaim mutex is removable under the same proof as a lock: its holder is provably gone.
export function reclaimAdmissionMutex(root, { io: ioOverride, namespaceProofs = [], self, attempted = new Set(), env = process.env } = {}) {
  const io = { ...lockIo, ...ioOverride }, mutex = join(root, 'admission.lock.reclaim')
  const assessment = assessAdmissionLock(mutex, io, { namespaceProofs })
  if (assessment.verdict !== 'stale') return { reclaimed: false, assessment }
  if (attempted.has(assessment.ownerDigest)) return { reclaimed: false, assessment: { ...assessment, verdict: 'unproven', reason: 'reclaim-already-attempted' } }
  attempted.add(assessment.ownerDigest)
  const holder = { ...(self ?? captureLockOwner(io, { observerRunId: observerRunIdOf(env) })), nonce: randomUUID() }
  return removeStaleEntry(root, mutex, assessment, holder, io)
}

// Removes the lock ONLY when `assessAdmissionLock` proves its owner gone. Reclaimers are
// serialized by `<lock>.reclaim` (same link-published protocol; an orphaned one is removable only
// under the same dead-holder proof). Under that mutex the lock cannot be replaced between assessment
// and removal: acquirers cannot publish over an existing lock, a dead owner cannot release it,
// nobody else removes it. The tombstone is re-verified against the assessed bytes anyway. The intent
// receipt is written once per reclaim attempt (keyed by the assessed owner digest in `attempted`)
// BEFORE the removal; with no receipt nothing is removed.
export function reclaimAdmissionLock(root, { io: ioOverride, namespaceProofs = [], self, attempted = new Set(), env = process.env } = {}) {
  const io = { ...lockIo, ...ioOverride }, lock = join(root, 'admission.lock')
  const first = assessAdmissionLock(lock, io, { namespaceProofs })
  if (first.verdict !== 'stale') return { reclaimed: false, assessment: first }
  if (attempted.has(first.ownerDigest)) return { reclaimed: false, assessment: { ...first, verdict: 'unproven', reason: 'reclaim-already-attempted' } }
  const holderBase = self ?? captureLockOwner(io, { observerRunId: observerRunIdOf(env) })
  const mutex = `${lock}.reclaim`, holder = { ...holderBase, nonce: randomUUID() }, holderText = JSON.stringify(holder)
  let held = !publishOwnedFile(mutex, holderText, holder, io)
  if (held) {
    const orphan = reclaimAdmissionMutex(root, { io, namespaceProofs, self: holderBase, attempted })
    held = !(orphan.reclaimed && publishOwnedFile(mutex, holderText, holder, io))
  }
  if (held) return { reclaimed: false, assessment: { ...first, verdict: 'unproven', reason: 'reclaim-mutex-held' } }
  try {
    const assessment = assessAdmissionLock(lock, io, { namespaceProofs })
    if (assessment.verdict !== 'stale') return { reclaimed: false, assessment }
    if (attempted.has(assessment.ownerDigest)) return { reclaimed: false, assessment: { ...assessment, verdict: 'unproven', reason: 'reclaim-already-attempted' } }
    attempted.add(assessment.ownerDigest)
    return removeStaleEntry(root, lock, assessment, holder, io)
  } finally { try { releaseOwnedFile(mutex, holderText, holder, io) } catch { /* A stuck reclaim mutex fails closed and is reported. */ } }
}

const observerRunIdOf = (env) => {
  const value = env?.APOLLO_OBSERVER_RUN_ID ?? env?.APOLLO_PERCEPTION_RUN_ID ?? null
  return typeof value === 'string' && RUN_ID_SHAPE.test(value) ? value : null
}

function admissionLockDiagnostic(lock, assessment, reclaims, io) {
  const facts = describeAdmissionLock(lock, { io })
  const mutex = describeAdmissionLock(`${lock}.reclaim`, { io })
  facts.staleLockDeletion = reclaims.length > 0
  facts.reclaim = { assessment: assessment && { verdict: assessment.verdict, reason: assessment.reason, owner: assessment.owner ?? null,
    proof: assessment.proof ?? null, observedState: assessment.observedState ?? null }, mutex: mutex.exists ? mutex : null, reclaims }
  return facts
}

export async function registryLock(root, action, options = {}) {
  admissionCheck(options.deadlineAt ?? Infinity, options.signal)
  assertOwnedRoot(root, options.env ?? process.env)
  return withAdmissionLock(root, action, options)
}

// `registryLock` without the Linux-only root ownership assertion (unit-testable with
// injected `io`). `namespaceProofs` are host-supervisor proofs (see `namespaceEmptyProof`).
export async function withAdmissionLock(root, action, { deadlineAt = Date.now() + 750, signal, io: ioOverride, env = process.env, namespaceProofs = [] } = {}) {
  admissionCheck(deadlineAt, signal)
  const io = { ...lockIo, ...ioOverride }
  const lock = join(root, 'admission.lock')
  let acquired = false, owner = null, ownerText = null, assessment = null
  const reclaims = [], attempted = new Set()
  try {
    owner = captureLockOwner(io, { observerRunId: observerRunIdOf(env) }); ownerText = JSON.stringify(owner)
    while (Date.now() < deadlineAt) {
      // The loop condition is the deadline test; a second clock read here could cross the deadline and replace the lock-deadline failure.
      if (signal?.aborted) admissionCheck(deadlineAt, signal)
      if (publishOwnedFile(lock, ownerText, owner, io)) { acquired = true; break }
      const attempt = reclaimAdmissionLock(root, { io, namespaceProofs, self: owner, attempted })
      assessment = attempt.assessment
      if (attempt.reclaimed) { reclaims.push(attempt.record); continue }
      await new Promise((done) => setTimeout(done, Math.min(10, Math.max(0, deadlineAt - Date.now()))))
    }
    assert.ok(acquired, 'Registry admission lock deadline; no stale-lock deletion')
  } catch (error) {
    // Evidence only: the original failure, its class and its message are unchanged.
    if (!acquired) { try { error.admissionLockDiagnostic = admissionLockDiagnostic(lock, assessment, reclaims, io) } catch { /* Never mask the original failure. */ } }
    throw error
  }
  let failed = false
  try {
    admissionCheck(deadlineAt, signal)
    const result = await action()
    admissionCheck(deadlineAt, signal)
    return result
  } catch (error) { failed = true; throw error }
  finally { try { releaseOwnedFile(lock, ownerText, owner, io) } catch (error) { if (!failed) throw error } }
}

export function assertDashboardPlaywrightFacts(facts, root = CI_ROOT) {
  assert.equal(facts?.schemaVersion, 'dashboard-playwright-installation/v1')
  assert.equal(facts.version, '1.62.0'); assert.match(facts.lockIntegrity, /^sha512-[A-Za-z0-9+/]+=*$/)
  assert.equal(facts.fullDependencyClosureClaimed, false); assert.equal(facts.hashesAreUpstream, false)
  assert.deepEqual(facts.files.map((row) => row.path), ['package.json', 'index.js', 'lib/coreBundle.js'].map((name) => posix.join(root, 'node_modules/playwright-core', name)))
  for (const row of facts.files) { assert.ok(Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes <= 16 * 1024 * 1024); assert.match(row.sha256, /^[a-f0-9]{64}$/) }
  return facts
}
export function initializeRegistry(root, runId, env = process.env) {
  assert.equal(process.platform, 'linux'); assert.ok(process.getuid() > 0 && process.getgid() > 0)
  assert.match(env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/)
  const owner = readAuthorityIdentitySync(process.pid)
  assert.ok(liveIdentity(owner)); assert.deepEqual(owner.uids, Array(4).fill(process.getuid()))
  const cgroupExecutables = ['/usr/bin/sudo', '/usr/bin/python3'].map((path) => {
    const realpath = realpathSync(path), metadata = lstatSync(realpath)
    assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.uid === 0 && !(metadata.mode & 0o022))
    return { path, realpath, dev: metadata.dev, ino: metadata.ino,
      sha256: digest(readAdmissionFile(realpath, 256 * 1024 * 1024, Date.now() + 3500)) }
  })
  const registry = { schemaVersion: 'perception-pidfd-registry/v1', runId, sourceCommit: env.GITHUB_SHA,
    root: assertOwnedRoot(root, env), creator: owner, admission: 'building', sourceFiles: [], cgroups: [], cgroupExecutables,
    createdAt: new Date().toISOString() }
  if (env.APOLLO_DASHBOARD_CFT157_LINUX_ROOT !== undefined) {
    const end = Date.now() + 3500
    const directory = join(CI_ROOT, 'node_modules/playwright-core')
    const files = ['package.json', 'index.js', 'lib/coreBundle.js'].map((name) => {
      const path = join(directory, name); assert.equal(realpathSync(path), path)
      const bytes = readAdmissionFile(path, 16 * 1024 * 1024, end)
      return { path, bytes: bytes.length, sha256: digest(bytes) }
    })
    const installation = JSON.parse(readAdmissionFile(join(directory, 'package.json'), 65536, end))
    const lock = JSON.parse(readAdmissionFile(join(CI_ROOT, 'package-lock.json'), 16 * 1024 * 1024, end))
    assert.equal(lock.packages['node_modules/playwright-core'].version, '1.62.0')
    registry.dashboardPlaywright = assertDashboardPlaywrightFacts({ schemaVersion: 'dashboard-playwright-installation/v1',
      version: installation.version, lockIntegrity: lock.packages['node_modules/playwright-core'].integrity,
      hashesAreUpstream: false, fullDependencyClosureClaimed: false, files })
  }
  mkdirSync(join(root, 'owners'), { mode: 0o700 })
  mkdirSync(join(root, 'receipts'), { mode: 0o700 })
  writeFileSync(join(root, 'registry.json'), JSON.stringify(registry, null, 2), { flag: 'wx', mode: 0o600 })
  return registry
}

export function sourceFingerprint({ deadlineAt = Infinity, signal } = {}) {
  // Explicit allowlist includes new untracked source files; never deps/evidence.
  return CI_PIDFD_SOURCE_PATHS.map((path) => {
    const sha256 = digest(readAdmissionFile(join(CI_ROOT, path), 1024 * 1024, deadlineAt, signal))
    admissionCheck(deadlineAt, signal)
    return { path, sha256 }
  })
}

export async function registerAddonConsumer(env = process.env, { deadlineAt = Date.now() + 3500, signal } = {}) {
  admissionCheck(deadlineAt, signal)
  const root = env.APOLLO_PERCEPTION_PIDFD_ROOT
  assert.ok(root, 'CI addon requires an explicit closed-admission registry')
  return registryLock(root, async () => {
    const registry = readRegistry(root, env, { deadlineAt, signal })
    assert.equal(registry.admission, 'open', 'CI addon admission is closed')
    assert.deepEqual(sourceFingerprint({ deadlineAt, signal }), registry.sourceFiles, 'CI authority source changed before native admission/cache')
    assert.equal(registry.addonSha256, env.APOLLO_PERCEPTION_PIDFD_SHA256)
    assert.equal(registry.addonSha256, digest(readAdmissionFile(env.APOLLO_PERCEPTION_PIDFD_ADDON, 16 * 1024 * 1024, deadlineAt, signal)), 'Addon changed before cache admission')
    assert.equal(registry.provenanceSha256, digest(readAdmissionFile(env.APOLLO_PERCEPTION_PIDFD_PROVENANCE, 1024 * 1024, deadlineAt, signal)))
    assert.equal(env.APOLLO_PERCEPTION_PIDFD_ADDON, join(root, 'perception-pidfd.node'))
    assert.equal(env.APOLLO_PERCEPTION_PIDFD_PROVENANCE, join(root, 'provenance.json'))
    admissionCheck(deadlineAt, signal)
    const identity = readAuthorityIdentitySync(process.pid)
    admissionCheck(deadlineAt, signal)
    assert.ok(liveIdentity(identity)); assert.deepEqual(identity.uids, Array(4).fill(process.getuid()))
    assert.match(env.APOLLO_PERCEPTION_CONSUMER_RUN_ID ?? '', /^pidfd-consumer-[a-z-]+-[a-f0-9-]+$/)
    let cgroupScope = null
    if (env.APOLLO_PERCEPTION_CGROUP_SCOPE !== undefined) {
      assert.ok(Buffer.byteLength(env.APOLLO_PERCEPTION_CGROUP_SCOPE) <= 4096)
      cgroupScope = JSON.parse(env.APOLLO_PERCEPTION_CGROUP_SCOPE)
      const groups = registry.cgroups?.filter((value) => value.state === 'open' &&
        value.runId === cgroupScope.runId && jsonDigest(value.scope) === jsonDigest(cgroupScope)) ?? []
      assert.equal(groups.length, 1, 'Native consumer has no unique sealed cgroup owner')
      const membership = readAdmissionFile('/proc/self/cgroup', 65536, deadlineAt, signal).toString('utf8')
        .split('\n').filter((line) => line.startsWith('0::'))
      assert.equal(membership.length, 1); assert.equal(membership[0].slice(3), cgroupScope.membership)
    }
    const entry = { schemaVersion: 'perception-pidfd-consumer/v1', identity, buildRunId: registry.runId,
      consumerRunId: env.APOLLO_PERCEPTION_CONSUMER_RUN_ID,
      observerRunId: env.APOLLO_OBSERVER_RUN_ID ?? env.APOLLO_PERCEPTION_RUN_ID ?? null,
      sourceCommit: env.GITHUB_SHA, addonSha256: registry.addonSha256, provenanceSha256: registry.provenanceSha256,
      cgroupScope, registrationIsNotProcessClose: true }
    const id = jsonDigest([identity.namespace, identity.pid, identity.starttime])
    const path = join(root, 'owners', `${id}.json`)
    admissionCheck(deadlineAt, signal)
    try { writeFileSync(path, JSON.stringify(entry, null, 2), { flag: 'wx', mode: 0o600 }) }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      const existing = JSON.parse(readAdmissionFile(path, 65536, deadlineAt, signal).toString('utf8'))
      for (const key of ['buildRunId', 'consumerRunId', 'observerRunId', 'sourceCommit', 'addonSha256', 'provenanceSha256']) assert.equal(existing[key], entry[key])
      assert.equal(identityKey(existing.identity), identityKey(identity)); assert.equal(existing.identity.namespace, identity.namespace)
      assert.deepEqual(existing.identity.uids, identity.uids)
      assert.equal(jsonDigest(existing.cgroupScope), jsonDigest(entry.cgroupScope))
    }
    admissionCheck(deadlineAt, signal)
    return Object.freeze({ id, path, entry, registry })
  }, { env, deadlineAt: Math.min(deadlineAt, Date.now() + 750), signal })
}
