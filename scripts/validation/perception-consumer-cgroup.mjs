import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CI_ROOT, budget, digest, identityKey, liveIdentity, readAuthorityIdentitySync,
  registerAddonConsumer, registryLock, readRegistry, writeRegistry, jsonDigest } from './perception-addon-registry.mjs'
import { loadPidfdBinding, openObservedPidfd } from './perception-pidfd.mjs'
import { parseLinuxProcessStat, readLinuxProcessIdentity } from './run-perception-ci.mjs'
import { fixedConsumer } from './run-perception-addon-consumer.mjs'

export const CGROUP_ABI = 'perception-consumer-cgroup/v1'
export const CGROUP_HELPER = join(CI_ROOT, 'scripts/validation/perception-consumer-cgroup.py')
export const CGROUP_FIXTURES = Object.freeze(['wait', 'setsid-reparent', 'zombie', 'member-exit', 'guardian-stop-owner-death'])
export const CGROUP_GATE_SUITE = 'tests/v2/perception-consumer-cgroup.integration.mjs'
const runPattern = /^pidfd-cgroup-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
export const CGROUP_ENVIRONMENT = Object.freeze([
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'CI', 'RUNNER_TEMP',
  'GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'NEXT_TELEMETRY_DISABLED',
  'APOLLO_API_ENVIRONMENT', 'V2_DATABASE_URL', 'APOLLO_LIBRARY_EVIDENCE_ROOT',
  'APOLLO_V2_ARTIFACT_STORAGE_DRIVER', 'APOLLO_V2_ARTIFACT_ROOT', 'APOLLO_PROTECTED_PAYLOAD_KEY_ID', 'APOLLO_PROTECTED_PAYLOAD_KEY',
  'APOLLO_OCR_VIDEO_E2E', 'APOLLO_PERCEPTION_HTTP_E2E', 'APOLLO_TEMPORAL_VIDEO_E2E', 'APOLLO_TEMPORAL_HTTP_E2E',
  'APOLLO_OCR_TESSERACT', 'APOLLO_OCR_TESSDATA', 'APOLLO_OCR_FFMPEG', 'APOLLO_TEMPORAL_FFMPEG',
  'APOLLO_OCR_FFPROBE', 'APOLLO_TEMPORAL_FFPROBE', 'FFMPEG_BIN', 'FFPROBE_BIN',
  'APOLLO_PERCEPTION_PIDFD_ADDON', 'APOLLO_PERCEPTION_PIDFD_PROVENANCE', 'APOLLO_PERCEPTION_PIDFD_SHA256',
  'APOLLO_PERCEPTION_PIDFD_ROOT', 'APOLLO_PERCEPTION_CONSUMER_RUN_ID', 'APOLLO_PERCEPTION_CGROUP_SCOPE',
  'APOLLO_PERCEPTION_JOB_DEADLINE_MS',
])
const safeError = (error) => { const message = String(error?.message ?? ''); return {
  name: error.name, code: error.code ?? null, messageSha256: digest(message), messageBytes: Buffer.byteLength(message),
  ...(error.linuxStatDiagnostic ? { linuxStatDiagnostic: error.linuxStatDiagnostic } : {}),
  ...(error.cgroupSnapshotDiagnostic ? { cgroupSnapshotDiagnostic: error.cgroupSnapshotDiagnostic } : {}) } }

export function assertCgroupScope(scope) {
  assert.ok(scope && typeof scope === 'object')
  assert.deepEqual(Object.keys(scope).sort(), ['path', 'membership', 'directory', 'kill', 'runId'].sort())
  assert.match(scope.runId, runPattern)
  assert.ok(typeof scope.path === 'string' && scope.path.startsWith('/sys/fs/cgroup/') && scope.path.length <= 1200 &&
    !/[\\\0\r\n]/.test(scope.path) && scope.path.split('/').every((part, index) => index === 0 || (part && part !== '.' && part !== '..')))
  assert.ok(scope.path.endsWith('/apollo-' + scope.runId))
  assert.equal(scope.membership, scope.path.slice('/sys/fs/cgroup'.length))
  for (const value of [scope.directory, scope.kill]) {
    assert.deepEqual(Object.keys(value).sort(), ['dev', 'ino'])
    assert.ok(Number.isSafeInteger(value.dev) && value.dev >= 0 && Number.isSafeInteger(value.ino) && value.ino > 0)
  }
  return scope
}

export function parseCgroupMembership(text) {
  assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 65536)
  const found = text.split('\n').filter((line) => line.startsWith('0::'))
  assert.equal(found.length, 1, 'Unique kernel cgroup2 membership required')
  return found[0].slice(3)
}

export function openCgroupKill(scope, uid, io = { lstat: lstatSync, realpath: realpathSync,
  open: openSync, fstat: fstatSync, readlink: readlinkSync, readFile: readFileSync, close: closeSync }) {
  assertCgroupScope(scope)
  let fd
  try {
    assert.equal(io.realpath(scope.path), scope.path, 'Cgroup ancestor symlink forbidden')
    const directory = io.lstat(scope.path)
    assert.ok(directory.isDirectory() && !directory.isSymbolicLink() && directory.uid === 0 && !(directory.mode & 0o022))
    assert.equal(directory.dev, scope.directory.dev); assert.equal(directory.ino, scope.directory.ino)
    const flags = io.flags ?? constants
    assert.ok(Number.isInteger(flags.O_NOFOLLOW), 'Linux O_NOFOLLOW required')
    fd = io.open(posix.join(scope.path, 'cgroup.kill'), flags.O_WRONLY | flags.O_NOFOLLOW)
    const actual = io.fstat(fd)
    assert.ok(actual.isFile() && actual.uid === uid && (actual.mode & 0o777) === 0o200)
    assert.equal(actual.dev, scope.kill.dev); assert.equal(actual.ino, scope.kill.ino)
    assert.equal(io.readlink(`/proc/self/fd/${fd}`), posix.join(scope.path, 'cgroup.kill'))
    const info = io.readFile(`/proc/self/fdinfo/${fd}`, 'utf8')
    assert.ok(typeof info === 'string' && Buffer.byteLength(info) <= 4096)
    const fdFlags = /^flags:\s+([0-7]+)$/m.exec(info)
    assert.ok(fdFlags && (parseInt(fdFlags[1], 8) & 0x80000) !== 0, 'Node-owned cgroup kill FD must be CLOEXEC')
    const after = io.lstat(scope.path)
    assert.equal(after.dev, directory.dev); assert.equal(after.ino, directory.ino)
    return fd
  } catch (error) { if (fd !== undefined) io.close(fd); throw error }
}

export async function readCgroupSnapshot(scope, deadlineAt, io = { readFile }) {
  assertCgroupScope(scope)
  const text = async (path) => {
    const remaining = deadlineAt - Date.now()
    assert.ok(remaining > 0, 'Cgroup metadata deadline exhausted before read')
    const value = await budget(() => io.readFile(path, { encoding: 'utf8', signal: AbortSignal.timeout(Math.min(500, remaining)) }),
      deadlineAt, Math.min(500, remaining), 'Cgroup metadata')
    try { assert.ok(Date.now() < deadlineAt && typeof value === 'string' && Buffer.byteLength(value) <= 65536) }
    catch (error) {
      const bytes = typeof value === 'string' ? Buffer.byteLength(value) : null
      try { error.cgroupMetadataDiagnostic = { bytes, sha256: bytes !== null && bytes <= 65536 ? digest(value) : null,
        hashScope: bytes === null ? 'not-text' : bytes > 65536 ? 'unmeasured-over-bound' : 'complete',
        guardCode: typeof value !== 'string' ? 'METADATA_TYPE' : bytes > 65536 ? 'METADATA_SIZE' : 'METADATA_DEADLINE' } }
      catch { /* Preserve the original guard if its Error object cannot be annotated. */ }
      throw error
    }
    return value
  }
  const ids = (await text(posix.join(scope.path, 'cgroup.procs'))).trim().split(/\s+/).filter(Boolean)
  assert.ok(ids.length <= 16384 && ids.every((value) => /^[1-9][0-9]*$/.test(value)))
  const entries = []
  const disappearanceReads = []
  Object.defineProperty(entries, 'disappearanceReads', { value: disappearanceReads, enumerable: false })
  for (const pid of new Set(ids.map(Number))) {
    assert.ok(Number.isSafeInteger(pid))
    let before, stage = 'stat-before'
    try {
      before = parseLinuxProcessStat(await text(`/proc/${pid}/stat`))
      stage = 'membership-read'
      const membership = parseCgroupMembership(await text(`/proc/${pid}/cgroup`))
      stage = 'stat-after'
      const after = parseLinuxProcessStat(await text(`/proc/${pid}/stat`))
      stage = 'identity-membership-check'
      assert.equal(identityKey(before), identityKey(after), 'Cgroup membership PID recycled during observation')
      assert.equal(membership, scope.membership, 'Kernel cgroup membership escaped the admitted domain')
      entries.push({ ...after, previousPpid: before.ppid, cgroupMembership: membership })
    } catch (error) {
      const disappeared = ['ENOENT', 'ESRCH'].includes(error.code)
      const facts = { schemaVersion: 'cgroup-snapshot-diagnostic/v1', stage, requestedPid: pid,
        outcome: disappeared ? 'read-disappearance-reported' : error.linuxStatDiagnostic ? 'malformed-stat' : 'read-or-integrity-failure',
        errno: Number.isSafeInteger(error.errno) ? error.errno : null,
        readErrorCode: ['ENOENT', 'ESRCH', 'EACCES', 'EPERM', 'EIO', 'ENOTDIR', 'ABORT_ERR', 'ERR_ASSERTION'].includes(error.code) ? error.code : null,
        knownBefore: before ? { pid: before.pid, ppid: before.ppid, processGroupId: before.processGroupId,
          sessionId: before.sessionId, state: before.state, starttime: before.starttime.length <= 32 ? before.starttime : null } : null,
        metadataBound: error.cgroupMetadataDiagnostic ?? null,
        terminalityEstablished: false }
      if (disappeared) {
        if (disappearanceReads.length < 8) disappearanceReads.push(facts)
      } else {
        try { error.cgroupSnapshotDiagnostic = facts } catch { /* Never mask an immutable original Error. */ }
        throw error
      }
    }
  }
  return entries
}

export function cgroupTerminalProof(report) {
  return report.carrierCloseObserved === true && report.guardianCloseObserved === true &&
    Array.isArray(report.helpers) && report.helpers.length > 0 && report.helpers.every((value) => value.closeObserved === true) && report.empty?.populated === 0 &&
    report.empty?.liveMembershipEmpty === true && report.observed.length > 0 &&
    report.terminality.length === report.observed.length && report.terminality.every((value) => value.terminal)
}

export function cgroupControlledCaseAccepted(value) {
  const kinds = { 'member-exit': null, wait: 'owner-death',
    'guardian-stop-owner-death': 'guardian-stopped-then-owner-death',
    'setsid-reparent': 'owner-death-after-reparent', zombie: 'owner-death-with-zombie' }
  if (!value || !Object.hasOwn(kinds, value.kind) || value.expectedFailure !== kinds[value.kind] ||
    !Array.isArray(value.errors) || value.errors.length || value.primaryContainmentObserved !== true ||
    value.fallbackRequired !== false || value.protocolComplete !== true || value.ownerCloseObserved !== true ||
    value.containmentConclusive !== true || !Array.isArray(value.observed) || !value.observed.length) return false
  const identity = (facts) => facts && Number.isSafeInteger(facts.pid) && facts.pid > 0 &&
    typeof facts.starttime === 'string' && /^[0-9]+$/.test(facts.starttime)
  if (!value.observed.every(identity)) return false
  const terminal = (facts) => Array.isArray(facts) && facts.length === value.observed.length && facts.every(identity) &&
    new Set(facts.map(identityKey)).size === facts.length && facts.every((entry) => entry.terminal === true &&
      value.observed.some((expected) => identityKey(expected) === identityKey(entry)))
  const empty = (facts) => facts?.populated === 0 && facts.liveMembershipEmpty === true
  if (!terminal(value.terminality) || !terminal(value.primaryContainment?.terminality) ||
    !empty(value.empty) || !empty(value.primaryContainment?.empty)) return false
  if (value.expectedFailure === null) return value.innerFinalObserved === true && value.ownerCode === 0 &&
    value.ownerSignal === null && value.innerFinalSuccess === true && Array.isArray(value.innerFinalErrors) && !value.innerFinalErrors.length
  return value.innerFinalObserved === false && value.ownerSignal === 'SIGKILL' &&
    (value.kind !== 'guardian-stop-owner-death' || value.guardianStopObserved === true) &&
    (value.kind !== 'setsid-reparent' || value.reparentedMembershipObserved === true) &&
    (value.kind !== 'zombie' || value.zombieExcludedFromLiveMembership === true && value.descendant?.state === 'Z')
}

async function cgroupEmpty(scope, end) {
  const text = await budget(() => readFile(posix.join(scope.path, 'cgroup.events'), 'utf8'), end, 500, 'Cgroup empty evidence')
  assert.ok(Buffer.byteLength(text) <= 65536)
  assert.equal(text.split('\n').filter((line) => line.startsWith('populated ')).length, 1)
  assert.match(text, /^populated [01]$/m)
  if (/^populated 1$/m.test(text)) throw Object.assign(new Error('Cgroup still populated'), { code: 'CGROUP_NOT_EMPTY' })
  if ((await readCgroupSnapshot(scope, end)).length) throw Object.assign(new Error('Cgroup live membership remains'), { code: 'CGROUP_NOT_EMPTY' })
  return { populated: 0, liveMembershipEmpty: true, zombieReapingEstablished: false }
}

export async function runCgroupConsumer(mode, args = [], env = process.env) {
  const fixture = mode === 'fixture'
  if (fixture) assert.ok(args.length === 1 && CGROUP_FIXTURES.includes(args[0]), 'Closed CI cgroup fixture required')
  else fixedConsumer(mode, args)
  assert.equal(process.platform, 'linux'); assert.ok(process.getuid() > 0 && process.getgid() > 0)
  const started = Date.now(), deadlineAt = Number(env.APOLLO_PERCEPTION_JOB_DEADLINE_MS ?? started + 1200000)
  assert.ok(Number.isSafeInteger(deadlineAt) && deadlineAt > started + 30000)
  const workEnd = deadlineAt - 25000, runId = 'pidfd-cgroup-' + randomUUID()
  const consumerRunId = fixture ? env.APOLLO_PERCEPTION_CONSUMER_RUN_ID : 'pidfd-consumer-cgroup-' + randomUUID()
  assert.match(consumerRunId ?? '', /^pidfd-consumer-[a-z-]+-[a-f0-9-]+$/)
  env = { ...env, APOLLO_PERCEPTION_CONSUMER_RUN_ID: consumerRunId }
  process.env.APOLLO_PERCEPTION_CONSUMER_RUN_ID = consumerRunId
  const registration = await registerAddonConsumer(env)
  const { binding } = await loadPidfdBinding(env)
  const owner = readAuthorityIdentitySync(process.pid)
  const config = { abi: CGROUP_ABI, runId, sourceCommit: env.GITHUB_SHA,
    helperSha256: registration.registry.sourceFiles.find((value) => value.path === 'scripts/validation/perception-consumer-cgroup.py')?.sha256,
    owner: { pid: owner.pid, starttime: owner.starttime, uid: process.getuid(), gid: process.getgid(), namespace: owner.namespace }, deadlineAt }
  assert.match(config.helperSha256 ?? '', /^[a-f0-9]{64}$/)
  assert.equal(digest(readFileSync(CGROUP_HELPER)), config.helperSha256, 'External registry pin differs from root helper')
  const executables = registration.registry.cgroupExecutables
  assert.ok(Array.isArray(executables) && executables.length === 2)
  for (const path of ['/usr/bin/sudo', '/usr/bin/python3']) {
    const expected = executables.find((value) => value.path === path)
    assert.ok(expected); assert.equal(realpathSync(path), expected.realpath)
    const actual = lstatSync(expected.realpath)
    assert.ok(actual.isFile() && !actual.isSymbolicLink() && actual.uid === 0 && !(actual.mode & 0o022))
    assert.equal(actual.dev, expected.dev); assert.equal(actual.ino, expected.ino)
    assert.equal(digest(readFileSync(expected.realpath)), expected.sha256, 'Root/guardian executable changed before spawn')
  }
  const report = { schemaVersion: 'perception-cgroup-owner-close/v1', runId: consumerRunId, cgroupRunId: runId,
    sourceCommit: env.GITHUB_SHA, buildRunId: registration.entry.buildRunId, owner,
    success: false, helpers: [], observed: [], terminality: [], errors: [],
    childCloseObserved: false, carrierCloseObserved: false, guardianCloseObserved: false, containmentRequired: false,
    securitySandboxClaimed: false, fixtureKind: fixture ? args[0] : null }
  const actors = [], observed = new Map(), tokens = new Map()
  let killFd, guardian, carrier, interrupted
  const fail = (error) => report.errors.push(safeError(error))
  const signals = ['SIGINT', 'SIGTERM'].map((name) => {
    const handler = () => { interrupted ??= name }; process.on(name, handler); return [name, handler]
  })
  const birth = (executable, argv, stdio, role, processEnv) => {
    const child = spawn(executable, argv, { cwd: CI_ROOT, env: processEnv, stdio })
    const actor = { child, role, closeObserved: false, packets: [], pending: '', bytes: 0,
      decoder: new TextDecoder('utf-8', { fatal: true }) }
    actors.push(actor)
    try {
      assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0)
      actor.token = binding.open(child.pid)
      // sudo may already be non-dumpable UID0. Its direct-child birth authority
      // is the real stat+pidfd, not a privileged namespace readlink assumption.
      actor.identity = role === 'guardian' ? readAuthorityIdentitySync(child.pid)
        : parseLinuxProcessStat(readFileSync(`/proc/${child.pid}/stat`, 'utf8'))
      assert.equal(actor.identity.ppid, process.pid); assert.ok(liveIdentity(actor.identity))
      observed.set(identityKey(actor.identity), actor.identity)
    } finally {
      actor.close = new Promise((done) => child.once('close', (code, signal) => {
        if (!actor.released) {
          try { actor.pending += actor.decoder.decode(); assert.equal(actor.pending, '', 'Truncated cgroup receipt') }
          catch (error) { fail(error) }
        }
        actor.closeObserved = true; actor.code = code; actor.signal = signal; done()
      }))
      child.once('error', fail); child.stdin.on('error', (error) => { if (!actor.closeObserved) fail(error) })
      child.stderr.on('data', (bytes) => process.stderr.write(bytes))
      child.stdout.on('data', (bytes) => {
        if (actor.released) { process.stdout.write(bytes); return }
        try {
          actor.bytes += bytes.length; assert.ok(actor.bytes <= 65536, 'Cgroup framed receipt byte bound')
          actor.pending += actor.decoder.decode(bytes, { stream: true })
          let separator
          while ((separator = actor.pending.indexOf('\n')) !== -1) {
            const line = actor.pending.slice(0, separator); actor.pending = actor.pending.slice(separator + 1)
            const packet = JSON.parse(line)
            assert.equal(packet.abi, CGROUP_ABI); assert.equal(packet.runId, runId)
            const stages = role === 'guardian' ? ['guardian-ready', 'guardian-final']
              : role === 'carrier' ? ['admit-exec-intent', 'normal-node-ready'] : [role + '-final']
            assert.equal(packet.stage, stages[actor.packets.length], 'Closed ordered cgroup receipt stages')
            assert.ok(actor.packets.length < 4); actor.packets.push(packet)
          }
        } catch (error) { fail(error) }
      })
    }
    return actor
  }
  const minimalEnvironment = { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }
  const shortHelper = async (mode, extra, end) => {
    const helper = birth('/usr/bin/sudo', ['-n', '/usr/bin/python3', '-I', '-S', CGROUP_HELPER, '--' + mode],
      ['pipe', 'pipe', 'pipe'], mode, minimalEnvironment)
    report.helpers.push(helper)
    helper.child.stdin.end(JSON.stringify({ ...config, ...extra, deadlineAt: end }) + '\n')
    await budget(() => helper.close, end, 5000, 'Short cgroup helper close')
    assert.equal(helper.code, 0); assert.equal(helper.signal, null); assert.equal(helper.pending, '')
    assert.equal(helper.packets.length, 1); assert.equal(helper.packets[0].stage, mode + '-final')
    assert.equal(helper.packets[0].success, true)
    const identity = helper.packets[0].helperIdentity
    assert.ok(identity && Number.isSafeInteger(identity.pid) && /^[0-9]+$/.test(identity.starttime))
    observed.set(identityKey(identity), identity)
    return helper.packets[0]
  }
  const waitPacket = async (actor, stage, end) => {
    while (!actor.packets.some((value) => value.stage === stage) && !actor.closeObserved && !report.errors.length) {
      await budget(() => new Promise((done) => setTimeout(done, 10)), end, 20, 'Cgroup birth readiness')
    }
    assert.equal(report.errors.length, 0, 'Cgroup protocol failed before readiness')
    const packets = actor.packets.filter((value) => value.stage === stage)
    assert.equal(packets.length, 1, 'Required cgroup readiness not observed exactly once')
    return packets[0]
  }
  try {
    await registryLock(env.APOLLO_PERCEPTION_PIDFD_ROOT, async () => {
      const registry = readRegistry(env.APOLLO_PERCEPTION_PIDFD_ROOT, env)
      registry.cgroups ??= []
      assert.ok(registry.cgroups.length < 64 && !registry.cgroups.some((value) => value.runId === runId))
      registry.cgroups.push({ runId, consumerRunId, owner, state: 'creating', sourceCommit: env.GITHUB_SHA })
      writeRegistry(env.APOLLO_PERCEPTION_PIDFD_ROOT, registry)
    }, { env, deadlineAt: Math.min(workEnd, Date.now() + 750) })
    const created = await shortHelper('create', {}, Math.min(workEnd, Date.now() + 5000))
    const scope = assertCgroupScope(created.scope); report.scope = scope
    assert.equal(scope.runId, runId)
    killFd = openCgroupKill(scope, process.getuid())
    await registryLock(env.APOLLO_PERCEPTION_PIDFD_ROOT, async () => {
      const registry = readRegistry(env.APOLLO_PERCEPTION_PIDFD_ROOT, env)
      const entry = registry.cgroups.find((value) => value.runId === runId)
      assert.equal(entry.state, 'creating'); entry.scope = scope; entry.state = 'open'
      writeRegistry(env.APOLLO_PERCEPTION_PIDFD_ROOT, registry)
    }, { env, deadlineAt: Math.min(workEnd, Date.now() + 750) })
    guardian = birth('/usr/bin/python3', ['-I', '-S', CGROUP_HELPER, '--guardian'], ['pipe', 'pipe', 'pipe', killFd], 'guardian', minimalEnvironment)
    guardian.child.stdin.write(JSON.stringify({ ...config, scope, controlledStop: fixture && args[0] === 'guardian-stop-owner-death' }) + '\n')
    const ready = await waitPacket(guardian, 'guardian-ready', Math.min(workEnd, Date.now() + 5000))
    assert.equal(identityKey(ready.identity), identityKey(guardian.identity)); assert.equal(ready.identity.ppid, process.pid)
    assert.deepEqual(ready.scope, scope); assert.equal(ready.parentDeathSignal, 'SIGCONT')
    assert.deepEqual(ready.credentials.uids, Array(4).fill(process.getuid()))
    assert.deepEqual(ready.credentials.gids, Array(4).fill(process.getgid()))
    for (const key of ['CapEff', 'CapPrm', 'CapInh', 'CapAmb']) assert.equal(BigInt('0x' + ready.credentials[key]), 0n)
    assert.equal(ready.credentials.NoNewPrivs, 1); report.guardianReady = ready
    const normalEnvironment = Object.fromEntries(CGROUP_ENVIRONMENT.filter((name) => env[name] !== undefined).map((name) => [name, env[name]]))
    normalEnvironment.APOLLO_PERCEPTION_CGROUP_SCOPE = JSON.stringify(scope)
    const provenance = JSON.parse(readFileSync(env.APOLLO_PERCEPTION_PIDFD_PROVENANCE, 'utf8'))
    const bootstrapEnd = Math.min(workEnd, Date.now() + 5000)
    carrier = birth('/usr/bin/sudo', ['-n', '/usr/bin/python3', '-I', '-S', CGROUP_HELPER, '--admit'],
      ['pipe', 'pipe', 'pipe'], 'carrier', minimalEnvironment)
    carrier.child.stdin.write(JSON.stringify({ ...config, scope, deadlineAt: bootstrapEnd,
      consumer: { mode, args }, node: process.execPath, nodeSha256: provenance.node.sha256,
      bootstrapSha256: registration.registry.sourceFiles.find((value) => value.path === 'scripts/validation/perception-ci-child-bootstrap.mjs').sha256,
      environment: normalEnvironment }) + '\n')
    const intent = await waitPacket(carrier, 'admit-exec-intent', bootstrapEnd)
    assert.deepEqual(intent.scope, scope)
    assert.equal(intent.node, process.execPath); assert.equal(intent.nodeSha256, provenance.node.sha256)
    report.consumerExecIntent = intent
    observed.set(identityKey(intent.identity), intent.identity)
    const held = await openObservedPidfd(intent.identity, { binding, readIdentity: readLinuxProcessIdentity,
      deadlineAt: bootstrapEnd, verifyDeadlineAt: bootstrapEnd })
    tokens.set(identityKey(intent.identity), held)
    const nodeReady = await waitPacket(carrier, 'normal-node-ready', bootstrapEnd)
    assert.equal(identityKey(nodeReady.identity), identityKey(intent.identity))
    assert.equal(nodeReady.bootstrapSha256, intent.bootstrapSha256)
    assert.equal(nodeReady.node, process.execPath); assert.equal(nodeReady.cgroupMembership, scope.membership)
    assert.equal(nodeReady.killFdInherited, false)
    assert.deepEqual(carrier.packets.map((value) => value.stage), ['admit-exec-intent', 'normal-node-ready'])
    const normal = readAuthorityIdentitySync(intent.identity.pid)
    assert.equal(identityKey(normal), identityKey(intent.identity)); assert.ok(liveIdentity(normal))
    assert.equal(normal.ppid, intent.identity.ppid)
    assert.equal(readlinkSync(`/proc/${normal.pid}/exe`), process.execPath)
    assert.deepEqual(normal.uids, Array(4).fill(process.getuid())); assert.deepEqual(normal.gids, Array(4).fill(process.getgid()))
    assert.equal(parseCgroupMembership(readFileSync(`/proc/${normal.pid}/cgroup`, 'utf8')), scope.membership)
    assert.equal(readlinkSync(`/proc/self/fd/${killFd}`), posix.join(scope.path, 'cgroup.kill'))
    report.consumerExecObserved = normal
    report.normalNodeReady = nodeReady
    if (fixture) {
      // Only the independent fixture-owner reaches this branch. A bootstrap
      // loading this module must not statically wait on its own top-level main.
      const { awaitBootstrapGate } = await import('./perception-ci-child-bootstrap.mjs')
      assert.ok(Date.now() < bootstrapEnd, 'Fixture gate import exceeded bootstrap deadline')
      // An independent normal driver opens its OWN tokens from these facts and
      // rereads the kernel before ACK. No native handle is serialized.
      process.stdout.write(JSON.stringify({ abi: CGROUP_ABI, stage: 'fixture-owner-ready', runId,
        fixtureKind: args[0], owner, scope, nodeReady, guardian: ready,
        actors: actors.map((actor) => ({ role: actor.role, identity: actor.identity, closeObserved: actor.closeObserved })) }) + '\n')
      await awaitBootstrapGate(process.stdin, Math.min(5000, bootstrapEnd - Date.now()))
      assert.ok(Date.now() < bootstrapEnd, 'Fixture driver ACK expired')
    }
    assert.equal(carrier.pending + carrier.decoder.decode(), '', 'Extra/truncated pre-release cgroup frame')
    carrier.released = true; carrier.child.stdin.end('G'); report.productGateReleased = true
    while (!carrier.closeObserved && !interrupted && !report.errors.length) {
      const snapshot = await readCgroupSnapshot(scope, workEnd)
      if (snapshot.disappearanceReads.length) {
        const facts = report.cgroupSnapshotDisappearanceReads ??= []
        facts.push(...snapshot.disappearanceReads.slice(0, Math.max(0, 64 - facts.length)))
      }
      for (const entry of snapshot) observed.set(identityKey(entry), entry)
      await budget(() => Promise.race([carrier.close, new Promise((done) => setTimeout(done, 20))]), workEnd, 1000, 'Cgroup consumer close poll')
    }
    assert.ok(carrier.closeObserved && carrier.code === 0 && carrier.signal === null && !interrupted, 'Fixed cgroup consumer did not close successfully')
    report.empty = await cgroupEmpty(scope, workEnd)
    guardian.child.stdin.end('F')
    await budget(() => guardian.close, workEnd, 5000, 'Cgroup guardian close')
    assert.equal(guardian.code, 0); assert.equal(guardian.signal, null)
    const finals = guardian.packets.filter((value) => value.stage === 'guardian-final')
    assert.equal(finals.length, 1); assert.equal(finals[0].containment, false)
  } catch (error) { fail(error) }
  finally {
    const end = Math.min(deadlineAt, Date.now() + 25000)
    if (killFd !== undefined && (report.errors.length || interrupted)) {
      try { writeFileSync(killFd, '1'); report.containmentRequired = true } catch (error) { fail(error) }
    }
    if (guardian && !guardian.closeObserved) { try { guardian.child.stdin.end() } catch (error) { fail(error) } }
    for (const actor of actors) {
      if (!actor.closeObserved) {
        try {
          // Only normal direct-child guardian is signaled by the owner. Root
          // helper/carrier timeout remains inconclusive until external cleanup.
          if (actor.role === 'guardian' && actor.token) binding.signal(actor.token, 'SIGKILL')
          await budget(() => actor.close, end, 5000, 'Cgroup actor close observation')
        } catch (error) { fail(error) }
      }
    }
    if (report.scope) { try { report.empty = await cgroupEmpty(report.scope, end) } catch (error) { fail(error) } }
    for (const expected of observed.values()) {
      try {
        const current = await budget(() => readLinuxProcessIdentity(expected.pid), end, 500, 'Cgroup final identity observation')
        report.terminality.push({ ...expected, terminal: !current || identityKey(current) !== identityKey(expected) || !liveIdentity(current),
          observation: !current ? 'absent' : identityKey(current) !== identityKey(expected) ? 'pid-recycled' : current.state })
      } catch (error) { fail(error) }
    }
    for (const token of tokens.values()) { try { token.close() } catch (error) { fail(error) } }
    for (const actor of actors) if (actor.token) { try { binding.close(actor.token) } catch (error) { fail(error) } }
    report.carrierCloseObserved = carrier?.closeObserved === true
    report.childCloseObserved = report.carrierCloseObserved
    report.guardianCloseObserved = guardian?.closeObserved === true
    report.code = carrier?.code ?? null; report.signal = carrier?.signal ?? null
    report.observed = [...observed.values()]; report.interruptedBy = interrupted ?? null
    // Serialize only facts, never ChildProcess/stream/native handle objects.
    report.helpers = report.helpers.map((actor) => ({ role: actor.role, identity: actor.identity,
      closeObserved: actor.closeObserved, code: actor.code ?? null, signal: actor.signal ?? null, packets: actor.packets }))
    report.actors = actors.map((actor) => ({ role: actor.role, pidFromSpawn: actor.child.pid ?? null, identity: actor.identity ?? null,
      birthIdentityObserved: actor.identity !== undefined, closeObserved: actor.closeObserved,
      code: actor.code ?? null, signal: actor.signal ?? null, packets: actor.packets }))
    for (const [name, handler] of signals) process.removeListener(name, handler)
    if (killFd !== undefined) { try { closeSync(killFd) } catch (error) { fail(error) } }
    report.success = !report.errors.length && !interrupted && !report.containmentRequired && cgroupTerminalProof(report)
    report.completedAt = new Date().toISOString()
    try {
      if (fixture) {
        process.stdout.write(JSON.stringify({ abi: CGROUP_ABI, stage: 'fixture-owner-final', runId, report }) + '\n')
      } else {
      const path = join(env.APOLLO_PERCEPTION_PIDFD_ROOT, 'receipts', `${consumerRunId}.json`)
      writeFileSync(path, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 })
      writeFileSync(path.replace(/\.json$/, '.sha256'), jsonDigest(report), { flag: 'wx', mode: 0o600 })
      }
    } catch (error) { fail(error); report.success = false }
    if (!report.success) process.stderr.write(JSON.stringify(report) + '\n')
  }
  return report
}

export async function prepareCgroupCleanup(registry, env, end, report) {
  assert.ok(Array.isArray(registry.cgroups) && registry.cgroups.length <= 64, 'Closed cgroup registry required')
  report.cgroups = []
  const prepared = []
  for (const entry of registry.cgroups) {
    const facts = { runId: entry.runId, consumerRunId: entry.consumerRunId, owner: entry.owner,
      success: false, removed: false, errors: [] }
    report.cgroups.push(facts)
    let fd
    try {
      assert.equal(entry.sourceCommit, env.GITHUB_SHA); assert.equal(entry.state, 'open')
      const scope = assertCgroupScope(entry.scope)
      assert.equal(scope.runId, entry.runId); facts.scope = scope
      fd = openCgroupKill(scope, process.getuid())
      const current = await readCgroupSnapshot(scope, end)
      if (current.length) { writeFileSync(fd, '1'); facts.containmentRequired = true }
      while (true) {
        assert.ok(Date.now() < end, 'Cgroup cleanup aggregate deadline')
        try { facts.empty = await cgroupEmpty(scope, end); break }
        catch (error) {
          if (error.code !== 'CGROUP_NOT_EMPTY' || end - Date.now() <= 20) throw error
          await budget(() => new Promise((done) => setTimeout(done, 10)), end, 20, 'Cgroup empty poll')
        }
      }
      const owner = await budget(() => readLinuxProcessIdentity(entry.owner.pid), end, 500, 'Cgroup controller terminality')
      assert.ok(!owner || identityKey(owner) !== identityKey(entry.owner) || !liveIdentity(owner),
        'Known cgroup controller is still live; no unknown/UID0 signal fallback')
      facts.ownerTerminal = { terminal: true, observation: !owner ? 'absent'
        : identityKey(owner) !== identityKey(entry.owner) ? 'pid-recycled' : owner.state }
      facts.success = true; prepared.push({ entry, facts })
    } catch (error) { facts.errors.push(safeError(error)); report.errors.push(safeError(error)) }
    finally { if (fd !== undefined) { try { closeSync(fd) } catch (error) { facts.success = false; report.errors.push(safeError(error)) } } }
  }
  return prepared
}

// Called only AFTER the prerequisite evidence has been archived and its known
// owner/guardian/helpers were proved terminal. Never require/load the addon here.
export async function removeArchivedCgroups(prepared, registry, env, end, report) {
  const pin = registry.sourceFiles.find((value) => value.path === 'scripts/validation/perception-consumer-cgroup.py')?.sha256
  assert.match(pin ?? '', /^[a-f0-9]{64}$/); assert.equal(digest(readFileSync(CGROUP_HELPER)), pin)
  for (const { entry, facts } of [...prepared].sort((a, b) => b.entry.scope.path.length - a.entry.scope.path.length)) {
    let child, identity, helperIdentity, closed = false, closePromise, raw = '', bytes = 0, primary
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const helperEnd = Math.min(end, Date.now() + 5000)
    try {
      assert.ok(helperEnd - Date.now() > 100, 'No remove helper starts after cleanup budget')
      for (const path of ['/usr/bin/sudo', '/usr/bin/python3']) {
        const executable = registry.cgroupExecutables.find((value) => value.path === path)
        assert.ok(executable); assert.equal(realpathSync(path), executable.realpath)
        const metadata = lstatSync(executable.realpath)
        assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.uid === 0 && !(metadata.mode & 0o022))
        assert.equal(metadata.dev, executable.dev); assert.equal(metadata.ino, executable.ino)
        assert.equal(digest(readFileSync(executable.realpath)), executable.sha256)
        assert.ok(Date.now() < helperEnd, 'Remove executable authentication expired')
      }
      child = spawn('/usr/bin/sudo', ['-n', '/usr/bin/python3', '-I', '-S', CGROUP_HELPER, '--remove'],
        { cwd: CI_ROOT, env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'] })
      try {
        assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0)
        identity = parseLinuxProcessStat(readFileSync(`/proc/${child.pid}/stat`, 'utf8'))
        assert.equal(identity.ppid, process.pid); assert.ok(liveIdentity(identity))
      } finally {
        closePromise = new Promise((done) => child.once('close', (code, signal) => {
          try { raw += decoder.decode() } catch (error) { primary ??= error }
          closed = true; facts.removeHelper.code = code; facts.removeHelper.signal = signal; done()
        }))
        facts.removeHelper = { identity: identity ?? null, pidFromSpawn: child.pid ?? null, closeObserved: false }
        child.once('error', (error) => { primary ??= error })
        child.stdin.on('error', (error) => { primary ??= error })
        child.stdout.on('data', (chunk) => {
          try {
            bytes += chunk.length
            assert.ok(bytes <= 65536, 'Cgroup remove receipt byte bound')
            raw += decoder.decode(chunk, { stream: true })
          } catch (error) { primary ??= error }
        })
        child.stderr.on('data', (chunk) => process.stderr.write(chunk))
      }
      child.stdin.end(JSON.stringify({ abi: CGROUP_ABI, runId: entry.runId, sourceCommit: env.GITHUB_SHA,
        helperSha256: pin, owner: { pid: entry.owner.pid, starttime: entry.owner.starttime,
          uid: entry.owner.uids[0], gid: entry.owner.gids[0], namespace: entry.owner.namespace },
        deadlineAt: helperEnd, scope: entry.scope }) + '\n')
      await budget(() => closePromise, helperEnd, 5000, 'Archived cgroup remove helper close')
      if (primary) throw primary
      assert.equal(facts.removeHelper.code, 0); assert.equal(facts.removeHelper.signal, null)
      const packet = JSON.parse(raw)
      assert.equal(packet.abi, CGROUP_ABI); assert.equal(packet.runId, entry.runId)
      assert.equal(packet.stage, 'remove-final'); assert.equal(packet.success, true)
      assert.deepEqual(packet.scope, entry.scope); facts.removeHelper.receipt = packet
      helperIdentity = packet.helperIdentity
      assert.ok(helperIdentity && Number.isSafeInteger(helperIdentity.pid) && /^[0-9]+$/.test(helperIdentity.starttime))
      facts.removed = true
    } catch (error) { facts.errors.push(safeError(error)); report.errors.push(safeError(error)); facts.success = false }
    finally {
      if (facts.removeHelper) facts.removeHelper.closeObserved = closed
      if (child && !closed && Date.now() < end) {
        try { await budget(() => closePromise, end, end - Date.now(), 'Remove helper final close observation') }
        catch (error) { facts.errors.push(safeError(error)); report.errors.push(safeError(error)) }
      }
      if (facts.removeHelper) facts.removeHelper.closeObserved = closed
      for (const expected of [identity, helperIdentity].filter(Boolean)) {
        try {
          const current = await budget(() => readLinuxProcessIdentity(expected.pid), end, 500, 'Remove helper terminal identity')
          const terminal = !current || identityKey(current) !== identityKey(expected) || !liveIdentity(current)
          const terminality = facts.removeHelper.terminality ??= []
          terminality.push({ ...expected, terminal,
            observation: !current ? 'absent' : identityKey(current) !== identityKey(expected) ? 'pid-recycled' : current.state })
          assert.equal(terminal, true)
        } catch (error) { report.errors.push(safeError(error)); facts.success = false }
      }
    }
  }
}

export async function runControlledCgroupGate(env = process.env) {
  assert.equal(process.platform, 'linux'); assert.ok(process.getuid() > 0 && process.getgid() > 0)
  const runId = 'pidfd-consumer-cgroup-gates-' + randomUUID()
  const deadlineAt = Math.min(Number(env.APOLLO_PERCEPTION_JOB_DEADLINE_MS), Date.now() + 120000)
  assert.ok(Number.isSafeInteger(deadlineAt) && deadlineAt > Date.now() + 30000)
  const workEnd = deadlineAt - 25000
  env = { ...env, APOLLO_PERCEPTION_CONSUMER_RUN_ID: runId, APOLLO_CGROUP_GATE_DEADLINE_MS: String(deadlineAt) }
  process.env.APOLLO_PERCEPTION_CONSUMER_RUN_ID = runId
  const registration = await registerAddonConsumer(env)
  const { binding } = await loadPidfdBinding(env)
  const file = join(CI_ROOT, CGROUP_GATE_SUITE)
  assert.equal(digest(readFileSync(file)), registration.registry.sourceFiles.find((value) => value.path === CGROUP_GATE_SUITE)?.sha256)
  const report = { schemaVersion: 'perception-cgroup-controlled-driver/v1', runId, sourceCommit: env.GITHUB_SHA,
    buildRunId: registration.registry.runId, owner: registration.entry.identity, success: false,
    errors: [], observed: [], terminality: [], childCloseObserved: false, cases: [] }
  let child, token, birth, closed = false, closePromise, interrupted
  const fail = (error) => report.errors.push(safeError(error))
  const handlers = ['SIGINT', 'SIGTERM'].map((name) => {
    const handler = () => { interrupted ??= name }; process.on(name, handler); return [name, handler]
  })
  try {
    child = spawn(process.execPath, [file], { cwd: CI_ROOT, env, stdio: ['pipe', 'inherit', 'inherit'] })
    try {
      assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0)
      token = binding.open(child.pid)
      birth = readAuthorityIdentitySync(child.pid)
      assert.equal(birth.ppid, process.pid); assert.ok(liveIdentity(birth)); report.observed.push(birth)
    } finally {
      closePromise = new Promise((done) => child.once('close', (code, signal) => {
        closed = true; report.childCloseObserved = true; report.code = code; report.signal = signal; done()
      }))
      child.once('error', fail); child.stdin.on('error', fail)
    }
    const current = await readLinuxProcessIdentity(birth.pid)
    assert.equal(identityKey(current), identityKey(birth)); assert.equal(current.ppid, process.pid)
    child.stdin.end('G')
    while (!closed && !interrupted && !report.errors.length) {
      await budget(() => Promise.race([closePromise, new Promise((done) => setTimeout(done, 20))]), workEnd, 1000, 'Controlled cgroup gate close')
    }
    assert.ok(closed && report.code === 0 && report.signal === null && !interrupted)
  } catch (error) { fail(error) }
  finally {
    const end = Math.min(deadlineAt, Date.now() + 25000)
    if (token && !closed) { try { binding.signal(token, 'SIGKILL'); report.containmentRequired = true } catch (error) { fail(error) } }
    if (child && !closed) { try { await budget(() => closePromise, end, 5000, 'Cgroup gate final child close') } catch (error) { fail(error) } }
    try {
      const path = join(env.APOLLO_PERCEPTION_PIDFD_ROOT, 'receipts', `${runId}.cases.json`)
      const bytes = readFileSync(path); assert.ok(bytes.length <= 1048576)
      assert.equal(digest(bytes), readFileSync(path.replace(/\.json$/, '.sha256'), 'utf8'))
      const ledger = JSON.parse(bytes)
      assert.equal(ledger.runId, runId); assert.equal(ledger.sourceCommit, env.GITHUB_SHA)
      assert.deepEqual(ledger.errors, [])
      assert.deepEqual(ledger.cases.map((value) => value.kind), ['member-exit', 'wait', 'guardian-stop-owner-death', 'setsid-reparent', 'zombie'])
      assert.deepEqual(ledger.cases.map((value) => value.expectedFailure), [null, 'owner-death',
        'guardian-stopped-then-owner-death', 'owner-death-after-reparent', 'owner-death-with-zombie'])
      assert.ok(ledger.cases.every((value) => value.expectedFailure === null ? value.innerFinalObserved === true
        : value.innerFinalObserved === false && value.ownerSignal === 'SIGKILL'))
      assert.ok(ledger.cases.every((value) => value.assertionsPassed === true && cgroupControlledCaseAccepted(value)))
      report.cases = ledger.cases
      report.observed.push(...ledger.observed)
      report.caseLedgerSha256 = digest(bytes)
    } catch (error) { fail(error) }
    const unique = new Map(report.observed.map((value) => [identityKey(value), value]))
    report.observed = [...unique.values()]
    for (const expected of report.observed) {
      try {
        const current = await budget(() => readLinuxProcessIdentity(expected.pid), end, 500, 'Controlled cgroup gate identity terminality')
        report.terminality.push({ ...expected, terminal: !current || identityKey(current) !== identityKey(expected) || !liveIdentity(current),
          observation: !current ? 'absent' : identityKey(current) !== identityKey(expected) ? 'pid-recycled' : current.state })
      } catch (error) { fail(error) }
    }
    if (token) { try { binding.close(token) } catch (error) { fail(error) } }
    for (const [name, handler] of handlers) process.removeListener(name, handler)
    report.success = !report.errors.length && !report.containmentRequired && !interrupted && report.childCloseObserved &&
      report.code === 0 && report.signal === null && report.terminality.length === report.observed.length && report.terminality.every((value) => value.terminal)
    try {
      const path = join(env.APOLLO_PERCEPTION_PIDFD_ROOT, 'receipts', `${runId}.json`)
      writeFileSync(path, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 })
      writeFileSync(path.replace(/\.json$/, '.sha256'), jsonDigest(report), { flag: 'wx', mode: 0o600 })
    } catch (error) { fail(error); report.success = false }
    if (!report.success) process.stderr.write(JSON.stringify(report) + '\n')
  }
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, ...args] = process.argv.slice(2)
    if (mode === '--controlled-gates') {
      assert.deepEqual(args, []); if (!(await runControlledCgroupGate()).success) process.exitCode = 1
    } else if (!(await runCgroupConsumer(mode === '--fixture-owner' ? 'fixture' : mode, args)).success) process.exitCode = 1
  }
  catch (error) { process.stderr.write(JSON.stringify(safeError(error)) + '\n'); process.exitCode = 1 }
}
