import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PassThrough } from 'node:stream'
import { chmodSync, createReadStream, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildPublicationAllowed, buildEnvironmentEvidence } from '../../scripts/validation/build-perception-pidfd.mjs'
import { awaitBootstrapGate } from '../../scripts/validation/perception-ci-child-bootstrap.mjs'
import { fixedConsumer, fixedDashboardDeadline, DASHBOARD_CI_ARGV, consumerTerminalProof, unattributedConsumerFacts, recheckUnattributedConsumer } from '../../scripts/validation/run-perception-addon-consumer.mjs'
import { assertCgroupScope, openCgroupKill, parseCgroupMembership, readCgroupSnapshot, cgroupTerminalProof,
  cgroupControlledCaseAccepted } from '../../scripts/validation/perception-consumer-cgroup.mjs'
import { namespaceOwnerClosed, assertArchivePaths, planArchive } from '../../scripts/validation/cleanup-perception-pidfd.mjs'
import { verifyOuterHostDeath, verifySudoCarrierBirth, verifyOuterRoleCredentials } from '../../scripts/validation/perception-outer-host-death.mjs'
import { loadPidfdBinding } from '../../scripts/validation/perception-pidfd.mjs'
import { parseLinuxProcessStat } from '../../scripts/validation/run-perception-ci.mjs'
import { awaitProductGate, bootstrapReadback } from '../../scripts/validation/perception-namespace-node-bootstrap.mjs'
import { CI_PIDFD_SOURCE_PATHS, digest, initializeRegistry, readRegistry, registryLock, assertDashboardPlaywrightFacts,
  registerAddonConsumer, writeRegistry, sourceFingerprint } from '../../scripts/validation/perception-addon-registry.mjs'

const cgroupScope = { runId: 'pidfd-cgroup-11111111-1111-1111-1111-111111111111',
  path: '/sys/fs/cgroup/job/apollo-pidfd-cgroup-11111111-1111-1111-1111-111111111111',
  membership: '/job/apollo-pidfd-cgroup-11111111-1111-1111-1111-111111111111',
  directory: { dev: 20, ino: 30 }, kill: { dev: 20, ino: 31 } }

test('real bootstrap module evaluation reaches both fixed-mode guards without an await import cycle', (t) => {
  const bootstrap = new URL('../../scripts/validation/perception-ci-child-bootstrap.mjs', import.meta.url)
  for (const [mode, message] of [['cgroup-consumer', 'Fixed CI consumers only'], ['cgroup-fixture', 'Literal cgroup fixture enum only']]) {
    // Loader-only fixture: platform/UID facts are deliberately controlled so
    // Windows also evaluates the actual entrypoint's import graph. The invalid
    // enum must reject BEFORE /proc, native addon, cgroup or privileged work.
    const code = `Object.defineProperty(process, 'platform', { value: 'linux' });
      process.getuid = () => 1001;
      process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(bootstrap))}, ${JSON.stringify(mode)}, 'invalid-loader-contract'];
      await import(${JSON.stringify(bootstrap.href)});`
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', code], {
      windowsHide: true, timeout: 3000, maxBuffer: 65536, encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '', APOLLO_PERCEPTION_CGROUP_SCOPE: 'null' },
    })
    t.diagnostic(JSON.stringify({ scope: 'module-loader-only-controlled-platform', mode, pid: result.pid,
      status: result.status, signal: result.signal, synchronousReturnObserved: true }))
    assert.equal(result.error, undefined); assert.equal(result.signal, null)
    assert.equal(result.status, 1); assert.equal(result.stdout, '')
    assert.ok(result.stderr.includes('Fixed bootstrap failed: ' + message), result.stderr)
    assert.equal(result.stderr.includes('unsettled top-level await'), false)
  }
})

function cgroupFdIo() {
  const closed = [], opened = []
  const directory = { isDirectory: () => true, isSymbolicLink: () => false, uid: 0, mode: 0o40755, dev: 20, ino: 30 }
  const kill = { isFile: () => true, uid: 1001, mode: 0o100200, dev: 20, ino: 31 }
  return { closed, opened, directory, kill, flags: { O_NOFOLLOW: 0x20000, O_WRONLY: 1 },
    realpath: (path) => path, lstat: () => directory,
    open: (path, flags) => { opened.push({ path, flags }); return 9 }, fstat: () => kill,
    readlink: () => cgroupScope.path + '/cgroup.kill', readFile: () => 'flags:\t02000001\n',
    close: (fd) => closed.push(fd) }
}

test('cgroup scope binds exact run/path/inodes with no arbitrary scope or migration authority', () => {
  assert.equal(assertCgroupScope(cgroupScope), cgroupScope)
  for (const mutation of [
    (value) => { value.path += '/child' }, (value) => { value.path = '/sys/fs/cgroup/../arbitrary' },
    (value) => { value.membership = '/other' }, (value) => { value.directory.ino = 0 },
    (value) => { value.kill.pid = 123 }, (value) => { value.runId = 'arbitrary' },
    (value) => { value.exec = '/bin/sh' },
  ]) {
    const value = structuredClone(cgroupScope); mutation(value); assert.throws(() => assertCgroupScope(value))
  }
  assert.equal(parseCgroupMembership('0::' + cgroupScope.membership + '\n'), cgroupScope.membership)
  assert.throws(() => parseCgroupMembership('0::/one\n0::/two\n'))
})

test('kill FD verifies O_NOFOLLOW, CLOEXEC and held inode/path; failures close only the acquired descriptor', () => {
  const io = cgroupFdIo()
  assert.equal(openCgroupKill(cgroupScope, 1001, io), 9)
  assert.equal(io.opened[0].path, cgroupScope.path + '/cgroup.kill')
  assert.ok(io.opened[0].flags & io.flags.O_NOFOLLOW); assert.deepEqual(io.closed, [])
  for (const mutation of [
    (value) => { value.kill.ino = 32 }, (value) => { value.kill.uid = 0 },
    (value) => { value.kill.mode = 0o100222 }, (value) => { value.readlink = () => '/sys/fs/cgroup/other/cgroup.kill' },
    (value) => { value.readFile = () => 'flags:\t00000001\n' },
  ]) {
    const failing = cgroupFdIo(); mutation(failing)
    assert.throws(() => openCgroupKill(cgroupScope, 1001, failing)); assert.deepEqual(failing.closed, [9])
  }
  const link = cgroupFdIo(); link.directory.isSymbolicLink = () => true
  assert.throws(() => openCgroupKill(cgroupScope, 1001, link)); assert.deepEqual(link.opened, [])
  const changed = cgroupFdIo(); let calls = 0
  changed.lstat = () => ++calls === 1 ? changed.directory : { ...changed.directory, ino: 999 }
  assert.throws(() => openCgroupKill(cgroupScope, 1001, changed)); assert.deepEqual(changed.closed, [9])
})

function cgroupStat(pid, starttime, ppid = 1, state = 'S') {
  const fields = Array(50).fill('0')
  Object.assign(fields, { 0: state, 1: String(ppid), 2: '8', 3: '8', 19: starttime })
  return `${pid} (controlled (member)) ${fields.join(' ')}`
}

test('cgroup snapshot reads only kernel members, keeps reparenting facts and rejects PID reuse/membership mismatch', async () => {
  const reads = []
  const io = { async readFile(path) {
    reads.push(path)
    if (path.endsWith('/cgroup.procs')) return '9\n9\n'
    if (path.endsWith('/cgroup')) return '0::' + cgroupScope.membership + '\n'
    return cgroupStat(9, '80', reads.length < 4 ? 8 : 1)
  } }
  const result = await readCgroupSnapshot(cgroupScope, Date.now() + 1000, io)
  assert.equal(result.length, 1); assert.equal(result[0].pid, 9); assert.equal(result[0].starttime, '80')
  assert.equal(result[0].previousPpid, 8); assert.equal(result[0].ppid, 1)
  assert.equal(reads[0], cgroupScope.path + '/cgroup.procs')
  assert.equal(reads.some((value) => value.includes('\\')), false, 'Kernel paths stay POSIX on a Windows test host')
  assert.equal(reads.some((path) => path === '/proc' || path.includes('/env') || path.includes('/cmdline')), false)
  for (const kind of ['reuse', 'membership', 'denied']) {
    let stats = 0
    const bad = { async readFile(path) {
      if (path.endsWith('/cgroup.procs')) return '9\n'
      if (kind === 'denied') throw Object.assign(new Error('controlled denial'), { code: 'EACCES' })
      if (path.endsWith('/cgroup')) return '0::' + (kind === 'membership' ? '/outside' : cgroupScope.membership) + '\n'
      return cgroupStat(9, kind === 'reuse' && ++stats === 2 ? '81' : '80')
    } }
    await assert.rejects(readCgroupSnapshot(cgroupScope, Date.now() + 1000, bad))
  }
})

test('cgroup stat diagnostics identify the failed read stage and keep only an already validated prior identity', async () => {
  for (const failAt of [1, 2]) {
    let stats = 0
    const io = { async readFile(path) {
      if (path.endsWith('/cgroup.procs')) return '9\n'
      if (path.endsWith('/cgroup')) return '0::' + cgroupScope.membership + '\n'
      const text = cgroupStat(9, '80', 8)
      return ++stats === failAt ? text.split(' ').slice(0, -1).join(' ') : text
    } }
    await assert.rejects(readCgroupSnapshot(cgroupScope, Date.now() + 1000, io), (error) => {
      assert.equal(error.message, 'Incomplete Linux process identity'); assert.equal(error.linuxStatDiagnostic.fieldCount, 49)
      const facts = error.cgroupSnapshotDiagnostic
      assert.equal(facts.stage, failAt === 1 ? 'stat-before' : 'stat-after')
      assert.equal(facts.requestedPid, 9); assert.equal(facts.outcome, 'malformed-stat'); assert.equal(facts.terminalityEstablished, false)
      assert.deepEqual(facts.knownBefore, failAt === 1 ? null : { pid: 9, ppid: 8, processGroupId: 8, sessionId: 8, state: 'S', starttime: '80' })
      assert.doesNotMatch(JSON.stringify(facts), /controlled|member|cmdline|environ/); return true
    })
  }
})

function cgroupUnavailableStat(pid = 9, starttime = '80', changes = {}) {
  const fields = Array(50).fill('0')
  Object.assign(fields, { 0: 'R', 1: '0', 2: '-1', 3: '-1', 19: starttime }, changes)
  return `${pid} (PRIVATE_TASK_COMM) ${fields.join(' ')}`
}

function cgroupSentinelIo({ first = cgroupStat(9, '80', 8), after = cgroupUnavailableStat(),
  rechecks = [cgroupStat(9, '80', 1), cgroupStat(9, '80', 1)], memberships = [cgroupScope.membership, cgroupScope.membership] } = {}) {
  const calls = [], stats = [first, after, ...rechecks]
  let index = 0, membershipIndex = 0
  return { calls, async readFile(path) {
    calls.push(path)
    if (path.endsWith('/cgroup.procs')) return '9\n'
    if (path.endsWith('/cgroup')) return '0::' + memberships[membershipIndex++] + '\n'
    const value = stats[index++]
    if (value instanceof Error) throw value
    assert.notEqual(value, undefined, 'No generic retry beyond the fixed recheck')
    return value
  } }
}

test('cgroup exact unavailable after-stat permits one strict stat membership stat recheck and keeps evidence separate', async () => {
  const io = cgroupSentinelIo()
  const snapshot = await readCgroupSnapshot(cgroupScope, Date.now() + 1000, io)
  assert.deepEqual([...snapshot], [{ pid: 9, state: 'S', ppid: 1, processGroupId: 8, sessionId: 8,
    starttime: '80', previousPpid: 8, cgroupMembership: cgroupScope.membership }])
  assert.equal(Object.keys(snapshot).includes('statUnavailableRechecks'), false)
  assert.equal(snapshot.statUnavailableRechecks.length, 1)
  const facts = snapshot.statUnavailableRechecks[0]
  assert.equal(facts.outcome, 'strict-identity-and-membership-revalidated')
  assert.equal(facts.identityEstablishedBySentinel, false); assert.equal(facts.terminalityEstablished, false)
  assert.ok(facts.completedAt < facts.deadlineAt); assert.ok(facts.deadlineAt - facts.startedAt <= 500)
  assert.ok(facts.completedMonotonic < facts.deadlineMonotonic)
  assert.ok(facts.deadlineMonotonic - facts.startedMonotonic <= 500)
  assert.equal(facts.knownBefore.starttime, '80'); assert.equal(facts.recheckedIdentity.ppid, 1)
  assert.doesNotMatch(JSON.stringify(facts), /PRIVATE_TASK_COMM/)
  assert.deepEqual(io.calls, [cgroupScope.path + '/cgroup.procs', '/proc/9/stat', '/proc/9/cgroup', '/proc/9/stat',
    '/proc/9/stat', '/proc/9/cgroup', '/proc/9/stat'])
})

test('cgroup sentinel requires a prior exact PID starttime and domain, while malformed or denied stat never retries', async () => {
  const malformed = cgroupUnavailableStat().split(' ').slice(0, -1).join(' ')
  const denied = Object.assign(new Error('PRIVATE_READ_DENIAL'), { code: 'EACCES', errno: -13 })
  for (const options of [{ first: cgroupUnavailableStat() }, { after: cgroupUnavailableStat(10) },
    { after: cgroupUnavailableStat(9, '81') }, { after: malformed }, { after: denied },
    { after: cgroupUnavailableStat(9, '80', { 3: '-2' }) }, { memberships: ['/not-admitted'] }]) {
    const io = cgroupSentinelIo(options)
    await assert.rejects(readCgroupSnapshot(cgroupScope, Date.now() + 1000, io), (error) => {
      if (options.after === denied) assert.equal(error, denied)
      assert.equal(error.cgroupSnapshotDiagnostic.unavailableRecheck, undefined)
      assert.equal(error.cgroupSnapshotDiagnostic.terminalityEstablished, false); return true
    })
    assert.ok(io.calls.filter((path) => path.endsWith('/stat')).length <= 2)
  }
})

test('persistent sentinel recycled identity changed membership and read errors preserve the initial assertion without adoption', async () => {
  let initial
  try { parseLinuxProcessStat(cgroupUnavailableStat()) } catch (error) { initial = error }
  const denied = Object.assign(new Error('PRIVATE_RECHECK_DENIAL'), { code: 'EACCES', errno: -13 })
  for (const options of [{ rechecks: [cgroupUnavailableStat()] }, { rechecks: [cgroupStat(9, '81')] },
    { rechecks: [cgroupStat(10, '80')] }, { rechecks: [cgroupStat(9, '80'), cgroupStat(9, '81')] },
    { rechecks: [cgroupStat(9, '80').split(' ').slice(0, -1).join(' ')] },
    { memberships: [cgroupScope.membership, '/changed'] }, { rechecks: [denied] }]) {
    const io = cgroupSentinelIo({ after: initial, ...options })
    await assert.rejects(readCgroupSnapshot(cgroupScope, Date.now() + 1000, io), (error) => {
      assert.equal(error, initial); assert.equal(error.message, 'Incomplete Linux process identity')
      assert.equal(error.cgroupSnapshotDiagnostic.outcome, 'unavailable-stat-recheck-inconclusive')
      const facts = error.cgroupSnapshotDiagnostic.unavailableRecheck
      assert.equal(facts.outcome, 'inconclusive'); assert.equal(facts.identityEstablishedBySentinel, false)
      assert.equal(facts.terminalityEstablished, false)
      if (options.rechecks?.[0] === denied) assert.equal(facts.readErrorCode, 'EACCES')
      assert.doesNotMatch(JSON.stringify(facts), /PRIVATE_READ_DENIAL|PRIVATE_RECHECK_DENIAL|PRIVATE_TASK_COMM/)
      return true
    })
    assert.ok(io.calls.filter((path) => path.endsWith('/stat')).length <= 4)
  }
})

test('gone during the one sentinel recheck records disappearance but never process terminality', async () => {
  for (const code of ['ENOENT', 'ESRCH']) {
    const io = cgroupSentinelIo({ rechecks: [Object.assign(new Error('PRIVATE_GONE'), { code })] })
    const snapshot = await readCgroupSnapshot(cgroupScope, Date.now() + 1000, io)
    assert.equal(snapshot.length, 0); assert.equal(snapshot.disappearanceReads.length, 1)
    assert.equal(snapshot.statUnavailableRechecks.length, 1)
    assert.equal(snapshot.statUnavailableRechecks[0].outcome, 'read-disappearance-reported')
    assert.equal(snapshot.disappearanceReads[0].readErrorCode, code)
    assert.equal(snapshot.disappearanceReads[0].terminalityEstablished, false)
    assert.equal(snapshot.statUnavailableRechecks[0].terminalityEstablished, false)
    assert.equal(io.calls.filter((path) => path.endsWith('/stat')).length, 3)
    assert.doesNotMatch(JSON.stringify(snapshot.disappearanceReads), /PRIVATE_GONE|PRIVATE_TASK_COMM/)
  }
})

test('sentinel recheck consumes one absolute window and late stat admits no membership or further read', async (t) => {
  let clock = 1000, initial
  t.mock.method(Date, 'now', () => clock)
  try { parseLinuxProcessStat(cgroupUnavailableStat()) } catch (error) { initial = error }
  for (const [outerEnd, late, sharedEnd] of [[3000, 1501, 1500], [1200, 1201, 1200]]) {
    clock = 1000
    const io = cgroupSentinelIo({ after: initial }), read = io.readFile
    let stats = 0
    io.readFile = async (path, options) => {
      const statCall = path.endsWith('/stat') ? ++stats : null
      const value = await read(path, options)
      if (statCall === 3) clock = late
      return value
    }
    await assert.rejects(readCgroupSnapshot(cgroupScope, outerEnd, io), (error) => {
      assert.equal(error, initial)
      const facts = error.cgroupSnapshotDiagnostic.unavailableRecheck
      assert.equal(facts.deadlineAt, sharedEnd); assert.equal(facts.completedAt, late)
      assert.equal(facts.metadataBound.guardCode, 'METADATA_DEADLINE')
      assert.equal(facts.terminalityEstablished, false); return true
    })
    assert.equal(stats, 3); assert.equal(io.calls.filter((path) => path.endsWith('/cgroup')).length, 1)
  }
})

test('cgroup disappearance and read denial stay distinct from malformed stat and never claim terminality', async () => {
  for (const code of ['ENOENT', 'ESRCH', 'EACCES', 'EIO']) {
    const original = Object.assign(new Error('PRIVATE_READ_MESSAGE'), { code, errno: code === 'EACCES' ? -13 : -5 })
    const io = { async readFile(path) { if (path.endsWith('/cgroup.procs')) return '9\n'; throw original } }
    if (['ENOENT', 'ESRCH'].includes(code)) {
      const snapshot = await readCgroupSnapshot(cgroupScope, Date.now() + 1000, io)
      assert.equal(snapshot.length, 0); assert.equal(snapshot.disappearanceReads.length, 1)
      assert.equal(snapshot.disappearanceReads[0].readErrorCode, code)
      assert.equal(snapshot.disappearanceReads[0].outcome, 'read-disappearance-reported')
      assert.equal(snapshot.disappearanceReads[0].terminalityEstablished, false)
      assert.doesNotMatch(JSON.stringify(snapshot.disappearanceReads), /PRIVATE_READ_MESSAGE/)
    } else await assert.rejects(readCgroupSnapshot(cgroupScope, Date.now() + 1000, io), (error) => {
      assert.equal(error, original); assert.equal(error.cgroupSnapshotDiagnostic.stage, 'stat-before')
      assert.equal(error.cgroupSnapshotDiagnostic.readErrorCode, code)
      assert.equal(error.cgroupSnapshotDiagnostic.knownBefore, null); return true
    })
  }
  for (const value of ['x'.repeat(65537), null]) {
    await assert.rejects(readCgroupSnapshot(cgroupScope, Date.now() + 1000, { async readFile(path) {
      return path.endsWith('/cgroup.procs') ? '9\n' : value
    } }), (error) => {
      assert.equal(error.cgroupSnapshotDiagnostic.metadataBound.guardCode, value === null ? 'METADATA_TYPE' : 'METADATA_SIZE')
      assert.equal(error.cgroupSnapshotDiagnostic.metadataBound.sha256, null); return true
    })
  }
  const immutable = Object.freeze(Object.assign(new Error('immutable original'), { code: 'EACCES', errno: -13 }))
  await assert.rejects(readCgroupSnapshot(cgroupScope, Date.now() + 1000, { async readFile(path) {
    if (path.endsWith('/cgroup.procs')) return '9\n'; throw immutable
  } }), (error) => error === immutable)
})

test('cgroup read deadline starts no later action after delayed IO; empty membership is not a close/reap proof', async () => {
  let reads = 0
  await assert.rejects(readCgroupSnapshot(cgroupScope, Date.now() + 10, { readFile: async () => {
    reads++; await new Promise((done) => setTimeout(done, 30)); return '9\n'
  } }))
  assert.equal(reads, 1)
  const valid = { carrierCloseObserved: true, guardianCloseObserved: true, helpers: [{ closeObserved: true }],
    empty: { populated: 0, liveMembershipEmpty: true }, observed: [{ pid: 9, starttime: '80' }], terminality: [{ terminal: true, observation: 'Z' }] }
  assert.equal(cgroupTerminalProof(valid), true)
  for (const change of [{ carrierCloseObserved: false }, { guardianCloseObserved: false }, { helpers: [] },
    { observed: [] }, { terminality: [] }, { terminality: [{ terminal: false }] },
    { empty: { populated: 1, liveMembershipEmpty: false } }]) assert.equal(cgroupTerminalProof({ ...valid, ...change }), false)
})

test('controlled cgroup gate cannot accept terminal fallback, errors, incomplete protocol or absent primary proof', () => {
  const identity = { pid: 9, starttime: '80' }
  const terminal = { ...identity, terminal: true, observation: 'Z' }
  const empty = { populated: 0, liveMembershipEmpty: true, zombieReapingEstablished: false }
  const base = { kind: 'member-exit', expectedFailure: null, errors: [], primaryContainmentObserved: true,
    fallbackRequired: false, protocolComplete: true, ownerCloseObserved: true, containmentConclusive: true,
    observed: [identity], terminality: [terminal], empty,
    primaryContainment: { terminality: [terminal], empty }, innerFinalObserved: true,
    innerFinalSuccess: true, innerFinalErrors: [], ownerCode: 0, ownerSignal: null }
  assert.equal(cgroupControlledCaseAccepted(base), true)
  const negative = { ...base, kind: 'guardian-stop-owner-death', expectedFailure: 'guardian-stopped-then-owner-death',
    guardianStopObserved: true, innerFinalObserved: false, ownerCode: null, ownerSignal: 'SIGKILL' }
  assert.equal(cgroupControlledCaseAccepted(negative), true)
  assert.equal(cgroupControlledCaseAccepted({ ...negative, kind: 'wait', expectedFailure: 'owner-death' }), true)
  for (const valid of [base, negative]) {
    for (const delta of [{ fallbackRequired: true }, { primaryContainmentObserved: false },
      { protocolComplete: false }, { errors: [{ code: 'EACCES' }] }, { primaryContainment: null },
      { observed: [{ pid: '9', starttime: '80' }] },
      { ownerCloseObserved: false }, { containmentConclusive: false }, { observed: [] },
      { primaryContainment: { terminality: [], empty } },
      { primaryContainment: { terminality: [{ ...terminal, starttime: '81' }], empty } },
      { primaryContainment: { terminality: [terminal], empty: { ...empty, populated: 1 } } },
      { terminality: [{ ...terminal, terminal: false }] }, { kind: 'arbitrary' }, { expectedFailure: 'arbitrary' }]) {
      assert.equal(cgroupControlledCaseAccepted({ ...valid, ...delta }), false)
    }
  }
  assert.equal(cgroupControlledCaseAccepted({ ...base, innerFinalErrors: [{ code: 'EIO' }] }), false)
  assert.equal(cgroupControlledCaseAccepted({ ...negative, guardianStopObserved: false }), false)
  assert.equal(cgroupControlledCaseAccepted({ ...negative, innerFinalObserved: true }), false)
  const reparent = { ...negative, kind: 'setsid-reparent', expectedFailure: 'owner-death-after-reparent', reparentedMembershipObserved: true }
  assert.equal(cgroupControlledCaseAccepted(reparent), true)
  assert.equal(cgroupControlledCaseAccepted({ ...reparent, reparentedMembershipObserved: false }), false)
  const zombie = { ...negative, kind: 'zombie', expectedFailure: 'owner-death-with-zombie',
    zombieExcludedFromLiveMembership: true, descendant: { state: 'Z' } }
  assert.equal(cgroupControlledCaseAccepted(zombie), true)
  assert.equal(cgroupControlledCaseAccepted({ ...zombie, descendant: { state: 'S' } }), false)
})

function unknownMetadataIo(identities) {
  const values = new Map(identities.map((value) => [value.pid, value]))
  return {
    async readFile(path) {
      const [, pid, name] = /^\/proc\/(\d+)\/(stat|status)$/.exec(path)
      const identity = values.get(Number(pid))
      assert.ok(identity)
      if (name === 'status') return `Uid:\t1001\t1001\t1001\t1001\nGid:\t1001\t1001\t1001\t1001\nNSpid:\t${pid}\n`
      const fields = Array(50).fill('0')
      Object.assign(fields, { 0: identity.state, 1: String(identity.ppid), 2: String(identity.processGroupId ?? 3),
        3: String(identity.sessionId ?? 3), 19: identity.starttime })
      return `${pid} (controlled (peer)) ${fields.join(' ')}`
    },
    async readlink(path) { assert.match(path, /^\/proc\/\d+\/ns\/pid$/); return 'pid:[900]' },
  }
}

test('fixed CI consumer permits literal npm test, eight named namespaces, fixed dashboard/acquisition and infrastructure gate only', () => {
  assert.equal(fixedConsumer('unit', []).at(-1), 'unit')
  assert.equal(fixedConsumer('gates', ['tests/v2/perception-namespace-observer.integration.mjs']).at(-2), 'gates')
  const face = 'tests/v2/prisma-face-producer.integration.mjs'
  assert.deepEqual(fixedConsumer('namespace', [face, 'publish-race|face control']).slice(-2), [face, 'publish-race|face control'])
  assert.equal(fixedConsumer('dashboard', []).at(-1), 'dashboard')
  assert.equal(fixedConsumer('acquisition', []).at(-1), 'acquisition')
  assert.deepEqual(DASHBOARD_CI_ARGV, ['--experimental-transform-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
    '--test', '--test-reporter=tap', 'tests/v2/dashboard-runtime-journey.e2e.mjs'])
  for (const [mode, args] of [['exec', ['/bin/true']], ['unit', ['--skip']], ['gates', ['ignored']],
    ['namespace', ['tests/v2/arbitrary.integration.mjs']], ['namespace', [face, 'face']],
    ['dashboard', ['tests/v2/arbitrary.mjs']], ['acquisition', ['https://arbitrary.invalid']], ['dashboard-test', []]]) {
    assert.throws(() => fixedConsumer(mode, args))
  }
})
test('fixed acquisition/dashboard owner budgets cap original admission without renewing or changing namespace budgets', () => {
  assert.equal(fixedDashboardDeadline('acquisition', 900000, 100000), 400000)
  assert.equal(fixedDashboardDeadline('dashboard', 900000, 100000), 545000)
  assert.equal(fixedDashboardDeadline('dashboard', 180000, 100000), 180000)
  assert.equal(fixedDashboardDeadline('namespace', 900000, 100000), 900000)
  for (const value of [NaN, Infinity, 130000, 100000]) assert.throws(() => fixedDashboardDeadline('acquisition', value, 100000))
})
test('CfT build provenance requires the three exact measured Playwright 1.62 files and lock origin', () => {
  const root = '/controlled/checkout'
  const facts = { schemaVersion: 'dashboard-playwright-installation/v1', version: '1.62.0', lockIntegrity: 'sha512-YWJj',
    fullDependencyClosureClaimed: false, hashesAreUpstream: false, files: ['package.json', 'index.js', 'lib/coreBundle.js']
      .map((name) => ({ path: root + '/node_modules/playwright-core/' + name, bytes: 9, sha256: 'a'.repeat(64) })) }
  assert.equal(assertDashboardPlaywrightFacts(facts, root), facts)
  for (const mutate of [(value) => { value.version = '1.61.0' }, (value) => { value.files.pop() },
    (value) => { value.files[0].sha256 = 'wrong' }, (value) => { value.files[1].path = '/other/index.js' },
    (value) => { value.hashesAreUpstream = true }, (value) => { value.fullDependencyClosureClaimed = true }]) {
    const changed = structuredClone(facts); mutate(changed); assert.throws(() => assertDashboardPlaywrightFacts(changed, root))
  }
  assert.throws(() => assertDashboardPlaywrightFacts(undefined, root))
})

test('build publication requires compiler success, actual close and every observed identity terminal', () => {
  const valid = { errors: [], interruptedBy: null, childCloseObserved: true, compilerExitCode: 0,
    childSignal: null, observed: [{ pid: 7, starttime: '10' }], terminality: [{ terminal: true }] }
  assert.equal(buildPublicationAllowed(valid), true)
  for (const patch of [{ compilerExitCode: 1 }, { compilerExitCode: 124 }, { compilerExitCode: 137 },
    { childCloseObserved: false }, { childSignal: 'SIGKILL' }, { interruptedBy: 'SIGTERM' },
    { errors: ['inventory unknown'] }, { observed: [] }, { terminality: [] }, { terminality: [{ terminal: false }] }]) {
    assert.equal(buildPublicationAllowed({ ...valid, ...patch }), false)
  }
  assert.equal(consumerTerminalProof({ childCloseObserved: true, observed: valid.observed, terminality: valid.terminality }), true)
  assert.equal(consumerTerminalProof({ childCloseObserved: false, observed: valid.observed, terminality: valid.terminality }), false)
})

test('build receipt serializes observer denial and terminal recheck without permitting a failed build', () => {
  // Controlled facts exercise serialization; they do not reconstruct the CI denial's missing metadata.
  const before = { pid: 3365, starttime: '60217', ppid: 3000, state: 'S', uid: 1001 }
  const denial = { pid: 3365, starttime: '60217', code: 'EACCES', before,
    recheck: { ...before }, guardReason: 'new-live-process-or-inconclusive', observedAt: '2030-01-01T00:00:00.000Z' }
  const terminal = { pid: 7, starttime: '70', uid: 1001, before: { pid: 7, starttime: '70', state: 'S' },
    recheck: { pid: 7, starttime: '70', state: 'Z', uid: 1001 }, observation: 'terminal-state', state: 'Z',
    reason: 'environ-eacces-same-identity-same-uid-terminal', observedAt: '2030-01-01T00:00:00.001Z' }
  const context = { environmentDenials: new Map([['3365:60217', denial]]),
    terminalEnvironmentRechecks: new Map([['7:70', terminal]]) }
  const report = { errors: [{ code: 'EACCES' }], interruptedBy: null, childCloseObserved: true,
    compilerExitCode: 0, childSignal: null, observed: [before], terminality: [{ terminal: true }],
    ...buildEnvironmentEvidence(context) }
  const receipt = JSON.parse(JSON.stringify(report))
  assert.deepEqual(receipt.environmentDenials, [denial])
  assert.deepEqual(receipt.terminalEnvironmentRechecks, [terminal])
  assert.equal(buildPublicationAllowed(receipt), false)
  assert.equal(context.environmentDenials.get('3365:60217'), denial)
  assert.equal(context.terminalEnvironmentRechecks.get('7:70'), terminal)
})

test('build bootstrap failure records honest empty observer evidence when context was never created', () => {
  const receipt = JSON.parse(JSON.stringify({ errors: [{ code: 'BOOTSTRAP_CONTEXT_FAILED' }], childCloseObserved: false,
    observed: [], terminality: [], ...buildEnvironmentEvidence(undefined) }))
  assert.deepEqual(receipt.environmentDenials, [])
  assert.deepEqual(receipt.terminalEnvironmentRechecks, [])
  assert.equal(buildPublicationAllowed(receipt), false)
})

test('unknown metadata retains snapshot gap and later parent facts without adopting identities', async () => {
  const child = { pid: 9, starttime: '90', ppid: 7, state: 'R', processGroupId: 3, sessionId: 3 }
  const parent = { pid: 7, starttime: '70', ppid: 0, state: 'S', processGroupId: 3, sessionId: 3 }
  const observed = new Map([['7:70', parent]]), baseline = new Map()
  const facts = unattributedConsumerFacts(child, [child], baseline, observed, { snapshotStartedAt: 1, snapshotFinishedAt: 2 })
  assert.deepEqual(facts.before, child); assert.equal(facts.parentFromSnapshot, null)
  assert.deepEqual(facts.parentsFromObserved, [parent])
  await recheckUnattributedConsumer(facts, Date.now() + 1000, async (pid) => pid === 9 ? child : parent,
    unknownMetadataIo([child, parent]))
  assert.equal(facts.recheck[0].stableIdentityEdge, true); assert.equal(facts.completed, true)
  assert.deepEqual([...observed], [['7:70', parent]]); assert.equal(baseline.size, 0)
  assert.equal(facts.membership.observed, false)
})

test('unknown metadata never treats child or parent PID reuse as ownership evidence', async () => {
  const child = { pid: 9, starttime: '90', ppid: 7, state: 'R', processGroupId: 3, sessionId: 3 }
  const facts = () => unattributedConsumerFacts(child, [child], new Map(), new Map(), {})
  const reused = facts()
  await recheckUnattributedConsumer(reused, Date.now() + 1000, async () => ({ ...child, starttime: '91' }), unknownMetadataIo([]))
  assert.equal(reused.selectedIdentityMatches, false); assert.deepEqual(reused.recheck, [])
  const parentReuse = facts()
  const parent = { pid: 7, starttime: '100', ppid: 0, state: 'R' }
  await recheckUnattributedConsumer(parentReuse, Date.now() + 1000,
    async (pid) => pid === 9 ? child : parent, unknownMetadataIo([child, parent]))
  assert.equal(parentReuse.recheck[0].parentStartedAfterChild, true)
  assert.equal(parentReuse.scope, 'metadata-diagnostic-not-ownership-authority')
})

test('unknown metadata read failure and expired budget remain diagnostic without additional reads', async () => {
  const child = { pid: 9, starttime: '90', ppid: 7, state: 'R' }
  const facts = () => unattributedConsumerFacts(child, [child], new Map(), new Map(), {})
  const unreadable = facts()
  await recheckUnattributedConsumer(unreadable, Date.now() + 1000,
    async () => { throw Object.assign(new Error('controlled denied'), { code: 'EACCES' }) }, unknownMetadataIo([]))
  assert.equal(unreadable.completed, false); assert.equal(unreadable.errors[0].code, 'EACCES')
  let reads = 0
  const expired = facts()
  await recheckUnattributedConsumer(expired, Date.now() - 1, async () => { reads += 1 }, unknownMetadataIo([]))
  assert.equal(reads, 0); assert.equal(expired.completed, false); assert.equal(expired.errors.length, 1)
  const timed = facts()
  await recheckUnattributedConsumer(timed, Date.now() + 20, () => new Promise(() => {}), unknownMetadataIo([]))
  assert.equal(timed.completed, false); assert.equal(timed.errors.length, 1)
  assert.ok(timed.recheckDeadlineAt - timed.recheckStartedAt <= 1000)
})

test('unknown selected process and immediate baseline parent retain bounded comm credentials and namespace without adoption', async () => {
  const child = { pid: 9, starttime: '90', ppid: 7, state: 'S' }
  const parent = { pid: 7, starttime: '70', ppid: 0, state: 'S' }
  const baseline = new Map([['7:70', parent]]), observed = new Map()
  const facts = unattributedConsumerFacts(child, [child, parent], baseline, observed, {})
  await recheckUnattributedConsumer(facts, Date.now() + 1000, async (pid) => pid === 9 ? child : parent,
    unknownMetadataIo([child, parent]))
  assert.deepEqual(facts.processDetails.map((value) => value.role), ['selected', 'immediate-parent'])
  for (const detail of facts.processDetails) {
    assert.equal(detail.consistent, true); assert.deepEqual(detail.errors, [])
    assert.equal(detail.comm, 'controlled (peer)'); assert.equal(detail.namespaceBefore, 'pid:[900]')
    assert.deepEqual(detail.statusBefore.uids, [1001, 1001, 1001, 1001])
    assert.deepEqual(detail.statusBefore.gids, [1001, 1001, 1001, 1001])
    assert.deepEqual(detail.statusBefore.nspids, [detail.expected.pid])
    assert.equal(Object.hasOwn(detail, 'raw'), false); assert.equal(Object.hasOwn(detail, 'environ'), false)
  }
  assert.equal(observed.size, 0); assert.deepEqual([...baseline], [['7:70', parent]])
  assert.equal(facts.membership.observed, false)
  assert.equal(facts.processDetailsComplete, true)
})

test('unknown detail EACCES remains explicit and still attempts the valid immediate parent within the same budget', async () => {
  const child = { pid: 9, starttime: '90', ppid: 7, state: 'S' }
  const parent = { pid: 7, starttime: '70', ppid: 0, state: 'S' }
  const io = unknownMetadataIo([child, parent]), original = io.readlink
  io.readlink = async (path) => {
    if (path === '/proc/9/ns/pid') throw Object.assign(new Error('controlled denied'), { code: 'EACCES' })
    return original(path)
  }
  const facts = unattributedConsumerFacts(child, [child], new Map(), new Map(), {})
  await recheckUnattributedConsumer(facts, Date.now() + 1000, async (pid) => pid === 9 ? child : parent, io)
  assert.equal(facts.processDetails[0].consistent, false)
  assert.equal(facts.processDetails[0].errors[0].code, 'EACCES')
  assert.equal(facts.processDetails[0].errors[0].phase, 'namespace-before')
  assert.equal(facts.processDetails[1].consistent, true)
  assert.equal(facts.processDetailsComplete, false)
})

test('unknown detail rejects PID parent credentials and namespace changes after metadata reads without adopting reused identities', async () => {
  const child = { pid: 9, starttime: '90', ppid: 0, state: 'S' }
  for (const changed of ['pid-reuse', 'parent', 'credentials', 'namespace', 'oversize-status', 'nspid']) {
    const io = unknownMetadataIo([child]), read = io.readFile
    let statReads = 0, statusReads = 0, namespaceReads = 0
    io.readFile = async (path) => {
      let text = await read(path)
      if (path.endsWith('/stat') && ++statReads === 2) {
        if (changed === 'pid-reuse') text = text.replace(' 90 ', ' 91 ')
        if (changed === 'parent') text = text.replace(') S 0 ', ') S 7 ')
      }
      if (path.endsWith('/status')) {
        if (++statusReads === 2 && changed === 'credentials') text = text.replaceAll('1001', '1002')
        if (changed === 'oversize-status') text += 'x'.repeat(65537)
        if (changed === 'nspid') text = text.replace('NSpid:\t9', 'NSpid:\t8')
      }
      return text
    }
    io.readlink = async () => ++namespaceReads === 2 && changed === 'namespace' ? 'pid:[901]' : 'pid:[900]'
    const observed = new Map(), facts = unattributedConsumerFacts(child, [child], new Map(), observed, {})
    await recheckUnattributedConsumer(facts, Date.now() + 1000, async () => child, io)
    assert.equal(facts.processDetails[0].consistent, false, changed)
    assert.ok(facts.processDetails[0].mismatches?.length || facts.processDetails[0].errors.length, changed)
    assert.equal(facts.processDetailsComplete, false)
    assert.equal(observed.size, 0)
  }
})

test('unknown detail delayed read consumes the existing absolute deadline and starts no later metadata action', async () => {
  const child = { pid: 9, starttime: '90', ppid: 0, state: 'S' }
  let reads = 0
  const io = { readFile() { reads++; return new Promise(() => {}) }, readlink() { assert.fail('no later read') } }
  const facts = unattributedConsumerFacts(child, [child], new Map(), new Map(), {})
  await recheckUnattributedConsumer(facts, Date.now() + 20, async () => child, io)
  assert.equal(reads, 1); assert.equal(facts.processDetails[0].consistent, false)
  assert.equal(facts.processDetails[0].errors.length, 1)
  assert.ok(facts.recheckFinishedAt - facts.recheckStartedAt < 1000)
  assert.ok(facts.recheckDeadlineAt - facts.recheckStartedAt <= 20)
})

test('fixed bootstrap denies EOF, malformed ACK and total deadline before workload release', async () => {
  const good = new PassThrough(), success = awaitBootstrapGate(good, 100); good.end('G'); await success
  const eof = new PassThrough(), missing = awaitBootstrapGate(eof, 100); eof.end()
  await assert.rejects(missing, /EOF/)
  const bad = new PassThrough(), invalid = awaitBootstrapGate(bad, 100); bad.end('GG')
  await assert.rejects(invalid, /Invalid/)
  const silent = new PassThrough()
  await assert.rejects(awaitBootstrapGate(silent, 10), /deadline/); silent.destroy()
})

// Actual Node ReadStream with controlled fs callbacks: no native descriptor is
// opened/closed, and this does not claim a real FIFO/namespace kernel proof.
function controlledProductGate({ bytes = 'G', readError = null, closeError = null, stall = false, holdClose = false } = {}) {
  const state = { closeCalls: 0, pendingRead: null, pendingClose: null, readDone: false }
  const stream = createReadStream(null, { fd: 41, autoClose: true, emitClose: true, highWaterMark: 2, fs: {
    read(_fd, buffer, offset, _length, _position, callback) {
      const complete = () => {
        if (readError) callback(readError)
        else if (state.readDone) callback(null, 0, buffer)
        else {
          state.readDone = true; const data = Buffer.from(bytes); data.copy(buffer, offset)
          callback(null, data.length, buffer)
        }
      }
      if (stall) state.pendingRead = () => callback(null, 0, buffer)
      else setImmediate(complete)
    },
    close(_fd, callback) {
      state.closeCalls += 1
      const complete = () => { state.pendingClose = null; callback(closeError) }
      if (holdClose) state.pendingClose = complete
      else queueMicrotask(complete)
    },
  } })
  return { stream, state }
}

test('product ACK does not release workload before sole ReadStream owner observes close', async () => {
  const { stream, state } = controlledProductGate({ holdClose: true })
  const pending = awaitProductGate(stream, 200)
  let released = false; void pending.then(() => { released = true }, () => {})
  try {
    while (!state.pendingClose) {
      assert.ok(performance.now() < pending.lifecycle.deadlineMonotonicMs, 'Controlled close callback must arrive within the same gate deadline')
      await new Promise((resolve) => setImmediate(resolve))
    }
    assert.equal(released, false); assert.equal(pending.lifecycle.acknowledged, true)
    assert.equal(pending.lifecycle.closeObserved, false); assert.equal(stream.listenerCount('error'), 1)
    state.pendingClose()
    assert.deepEqual(await pending, { acknowledged: true, closeObserved: true })
    assert.equal(state.closeCalls, 1); assert.equal(stream.fd, null); assert.equal(stream.listenerCount('error'), 0)
  } finally {
    if (state.pendingClose) state.pendingClose()
    await pending.catch(() => {}) // Original assertion/rejection remains primary.
  }
})

test('product gate EOF, invalid ACK and read error close once and remain failures', async () => {
  for (const options of [{ bytes: '' }, { bytes: 'GG' }, { readError: Object.assign(new Error('controlled read'), { code: 'EIO', syscall: 'read' }) }]) {
    const { stream, state } = controlledProductGate(options)
    const pending = awaitProductGate(stream, 200)
    await assert.rejects(pending, options.readError ? (error) => error === options.readError : /EOF|Invalid/)
    assert.equal(state.closeCalls, 1); assert.equal(pending.lifecycle.closeObserved, true)
    assert.equal(pending.lifecycle.acknowledged, false); assert.equal(stream.listenerCount('error'), 0)
  }
})

test('close EBADF after ACK is preserved exactly instead of unhandled or accepted', async () => {
  const original = Object.assign(new Error('controlled close'), { code: 'EBADF', errno: -9, syscall: 'close' })
  const { stream, state } = controlledProductGate({ closeError: original })
  const pending = awaitProductGate(stream, 200)
  await assert.rejects(pending, (error) => error === original)
  assert.equal(state.closeCalls, 1); assert.equal(pending.lifecycle.acknowledged, true)
  assert.equal(pending.lifecycle.closeObserved, true)
  assert.equal(pending.lifecycle.errors[0].code, 'EBADF'); assert.equal(pending.lifecycle.errors[0].syscall, 'close')
})

test('gate primary EOF remains primary when descriptor close also fails', async () => {
  const secondary = Object.assign(new Error('controlled close'), { code: 'EBADF', syscall: 'close' })
  const { stream, state } = controlledProductGate({ bytes: '', closeError: secondary })
  const pending = awaitProductGate(stream, 200)
  await assert.rejects(pending, /EOF/)
  assert.equal(state.closeCalls, 1)
  assert.deepEqual(pending.lifecycle.errors.map((error) => error.phase), ['eof', 'stream-error'])
  assert.equal(pending.lifecycle.errors[1].code, 'EBADF')
})

test('gate total deadline does not restart for pending IO closure or remove late error observation', async () => {
  const secondary = Object.assign(new Error('controlled late close'), { code: 'EBADF', syscall: 'close' })
  const { stream, state } = controlledProductGate({ stall: true, closeError: secondary })
  const pending = awaitProductGate(stream, 15)
  await assert.rejects(pending, /deadline/)
  assert.equal(pending.lifecycle.closeObserved, false); assert.equal(stream.listenerCount('error'), 1)
  assert.equal(state.closeCalls, 0)
  const closed = new Promise((resolve) => stream.once('close', resolve))
  state.pendingRead(); await closed
  assert.equal(state.closeCalls, 1); assert.equal(pending.lifecycle.closeObserved, true)
  assert.equal(pending.lifecycle.errors[0].phase, 'deadline'); assert.equal(pending.lifecycle.errors.at(-1).code, 'EBADF')
  assert.equal(stream.listenerCount('error'), 0)
})

test('normal namespace bootstrap refuses incomplete or elevated readback before product import', () => {
  const fields = ['S', '1', '2', '2', ...Array(46).fill('0')]; fields[19] = '99'
  const stat = `2 (node bootstrap) ${fields.join(' ')}`
  const status = ['Uid:\t600 600 600 600', 'Gid:\t700 700 700 700', 'Groups:\t', 'NoNewPrivs:\t1',
    ...['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'].map((name) => `${name}:\t0000000000000000`)].join('\n')
  const input = { stat, status, pid: 2, uid: 600, gid: 700, namespace: 'pid:[77]' }
  assert.equal(bootstrapReadback(input).identity.starttime, '99')
  for (const changed of [status.replace('CapEff:\t0000000000000000', 'CapEff:\t0000000000000020'),
    status.replace('CapBnd:\t0000000000000000', ''), status.replace('NoNewPrivs:\t1', 'NoNewPrivs:\t0'),
    status.replace('Uid:\t600 600 600 600', 'Uid:\t600 0 600 600'), status.replace('Groups:\t', 'Groups:\t700')])
    assert.throws(() => bootstrapReadback({ ...input, status: changed }))
  assert.throws(() => bootstrapReadback({ ...input, stat: stat.replace(') S 1 ', ') S 9 ') }))
})

test('namespace cleanup binds local PID to observed host inode and actual FINAL; no local-to-host PID lookup', () => {
  const owner = { observerRunId: 'namespace-run', sourceCommit: 'a'.repeat(40),
    identity: { namespace: 'pid:[77]', pid: 3, starttime: '12' } }
  const report = { runId: owner.observerRunId, sourceCommit: owner.sourceCommit, childCloseObserved: true,
    namespaceBinding: { directlyObserved: { namespace: owner.identity.namespace },
      wardenAttested: { localNodeIdentity: { pid: 2, starttime: '11' } } },
    rootReceipts: [{ stage: 'guardian-final', initFinal: { nodeCloseObserved: true, cleanup: { namespaceEmpty: true } } }],
    externalIdentities: Array.from({ length: 5 }, () => ({ terminal: true })), postflight: { backendCount: 0 } }
  assert.equal(namespaceOwnerClosed(owner, [report]), true)
  for (const patch of [{ runId: 'other' }, { sourceCommit: 'b'.repeat(40) }, { childCloseObserved: false },
    { rootReceipts: [] }, { postflight: { backendCount: 1 } }, { externalIdentities: [{ terminal: true }] },
    { namespaceBinding: { ...report.namespaceBinding, directlyObserved: { namespace: 'pid:[78]' } } }]) {
    assert.throws(() => namespaceOwnerClosed(owner, [{ ...report, ...patch }]))
  }
  assert.throws(() => namespaceOwnerClosed({ ...owner, identity: { ...owner.identity, starttime: '10' } }, [report]))
  assert.throws(() => namespaceOwnerClosed(owner, [report, report]))
})

test('archive planning rejects source recursion, ancestor aliases and root identity drift before mutation', () => {
  const root = '/tmp/runner/apollo-ci-pidfd.run', temporary = '/tmp/runner', runId = 'pidfd-build-abc-123'
  const valid = { root, runnerTemp: temporary, archiveParent: temporary + '/archive', runId,
    rootIdentity: { dev: 4, ino: 9 }, uid: 600 }
  const directory = (ino = 9, symlink = false) => ({ uid: 600, dev: 4, ino,
    isDirectory: () => true, isSymbolicLink: () => symlink })
  const missing = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }
  const io = { lstat(path) { return [root, temporary].includes(path) ? directory() : missing() }, realpath: (path) => path }
  assert.equal(planArchive(valid, io).archive, temporary + '/archive/' + runId)
  for (const archiveParent of [root, root + '/nested', root + '/../apollo-ci-pidfd.run/deeper'])
    assert.throws(() => planArchive({ ...valid, archiveParent }, io), /source root|subtree/)
  assert.throws(() => assertArchivePaths(root, temporary + '/archive', root, temporary))
  assert.throws(() => assertArchivePaths(root, '/elsewhere/archive', '/elsewhere/archive/' + runId, temporary))
  assert.throws(() => planArchive(valid, { ...io, lstat(path) { return path === root ? directory(10) : io.lstat(path) } }), /identity changed/)
  assert.throws(() => planArchive(valid, { ...io, realpath(path) { return path === root ? '/tmp/elsewhere' : path } }), /symlink/)
  const alias = temporary + '/alias'
  assert.throws(() => planArchive({ ...valid, archiveParent: alias }, {
    lstat(path) { return path === alias ? directory(11, true) : io.lstat(path) }, realpath(path) { return path === alias ? root : path },
  }), /owner\/link/)
  assert.throws(() => planArchive({ ...valid, archiveParent: alias + '/nested' }, {
    lstat(path) { return path === alias ? directory(11) : io.lstat(path) }, realpath(path) { return path === alias ? root : path },
  }), /symlink/)
  assert.throws(() => planArchive(valid, { ...io, lstat(path) {
    return path === temporary + '/archive/' + runId ? directory(12) : io.lstat(path)
  } }), /already exists/)
})

test('host launcher death requires actual SIGKILL close, five terminal births and PG0 without fabricated inner proof', () => {
  const valid = { kind: 'outer-host-death', launcherCloseObserved: true, launcherSignal: 'SIGKILL',
    launcherTerminal: { terminal: true }, productGateReleased: false, identities: Array.from({ length: 5 }, () => ({ terminal: true })),
    postflight: { backendCount: 0 }, errors: [], observedRunSuccess: false, innerReceiptPresent: false, outerReceiptPresent: false,
    carrierCredentials: verifySudoCarrierBirth(sudoCarrierFixture()) }
  verifyOuterHostDeath(valid)
  for (const patch of [{ launcherCloseObserved: false }, { launcherSignal: 'SIGTERM' }, { productGateReleased: true },
    { identities: [{ terminal: true }] }, { carrierCredentials: undefined }, { namespaceEmpty: true }, { nodeCloseObserved: true },
    { innerReceiptPresent: true }, { observedRunSuccess: true }, { errors: ['inconclusive'] }]) {
    assert.throws(() => verifyOuterHostDeath({ ...valid, ...patch }))
  }
})


// Metadata-only role fixtures execute the real parent validator; no sudo,
// native addon, /proc, privilege or Linux delivery is exercised by these tests.
function sudoCarrierFixture(gidRole = 'owner-group') {
  const launcher = { pid: 20, ppid: 10, starttime: '200', state: 'S', uids: [1001, 1001, 1001, 1001],
    gids: [1002, 1002, 1002, 1002] }
  const carrier = { pid: 21, ppid: 20, starttime: '201', state: 'S' }
  const guardian = { pid: 22, ppid: 21, starttime: '202', state: 'S' }
  const gids = gidRole === 'all-root-group' ? [0, 0, 0, 0] :
    [1002, ...Array(3).fill(gidRole === 'owner-group' ? 1002 : 0)]
  const executable = { path: '/usr/bin/sudo', dev: 8, ino: 31, bytes: 1234, mode: 0o104755,
    uid: 0, gid: 0, sha256: 'b'.repeat(64) }
  return { expected: { ...carrier }, current: { ...carrier }, rechecked: { ...carrier }, launcher, guardian,
    uid: 1001, gid: 1002, namespace: 'pid:[42]', wardenSha256: 'a'.repeat(64), executable,
    credentials: { uids: [1001, 0, 0, 0], gids: [...gids] },
    token: { terminal: false, expected: { ...carrier }, current: { ...carrier }, close() {} },
    facts: { schemaVersion: 'perception-sudo-carrier-birth/v1', measurement: 'privileged-before-drop',
      sourceSha256: 'a'.repeat(64), carrierIdentity: { ...carrier, uids: [1001, 0, 0, 0], gids: [...gids] },
      launcherIdentity: structuredClone(launcher), guardianIdentity: { ...guardian },
      hostNamespace: 'pid:[42]', gidRole, executable: { ...executable } } }
}

test('outer death carrier validates fixed setuid UID and all three explicitly measured closed GID roles', () => {
  for (const role of ['owner-group', 'root-group', 'all-root-group']) {
    const input = sudoCarrierFixture(role)
    const result = verifySudoCarrierBirth(input)
    assert.equal(result.role, 'sudo-carrier'); assert.equal(result.gidRole, role)
    assert.deepEqual(result.uids, [1001, 0, 0, 0]); assert.deepEqual(result.gids, input.credentials.gids)
    assert.equal(result.authentication, 'parent-owned-pidfd/status-readback/warden-pre-drop-exe')
    assert.deepEqual(result.executable, input.executable)
  }
})

test('outer death all-root carrier GID role still requires exact attested and measured tuple and owner real UID', () => {
  for (const [label, mutate] of [
    ['mixed', (v) => { v.credentials.gids = [0, 0, 1002, 0]; v.facts.carrierIdentity.gids = [...v.credentials.gids] }],
    ['arbitrary', (v) => { v.credentials.gids = [7, 7, 7, 7]; v.facts.carrierIdentity.gids = [...v.credentials.gids] }],
    ['attested-mismatch', (v) => { v.facts.carrierIdentity.gids = [1002, 0, 0, 0] }],
    ['measured-mismatch', (v) => { v.credentials.gids = [1002, 0, 0, 0] }],
    ['role-mismatch', (v) => { v.facts.gidRole = 'root-group' }],
    ['root-real-uid', (v) => { v.credentials.uids = [0, 0, 0, 0]; v.facts.carrierIdentity.uids = [0, 0, 0, 0] }],
  ]) {
    const input = sudoCarrierFixture('all-root-group'); mutate(input)
    assert.throws(() => verifySudoCarrierBirth(input), undefined, label)
  }
})

test('outer death carrier rejects absent or foreign source facts and reused parent-owned identities', () => {
  const mutations = [
    ['host-pid1', (v) => { v.expected.pid = 1 }],
    ['missing-facts', (v) => { delete v.facts }],
    ['source', (v) => { v.facts.sourceSha256 = 'c'.repeat(64) }],
    ['measurement', (v) => { v.facts.measurement = 'after-drop' }],
    ['schema', (v) => { v.facts.schemaVersion = 'perception-sudo-carrier-birth/v2' }],
    ['missing-token', (v) => { delete v.token }],
    ['terminal-token', (v) => { v.token.terminal = true }],
    ['wrong-token-birth', (v) => { v.token.expected.starttime = '999' }],
    ['wrong-carrier', (v) => { v.current.pid = 99 }],
    ['reused-pid', (v) => { v.rechecked.starttime = '999' }],
    ['changed-parent', (v) => { v.rechecked.ppid = 19 }],
    ['dead', (v) => { v.rechecked.state = 'Z' }],
    ['attested-birth', (v) => { v.facts.carrierIdentity.starttime = '999' }],
    ['launcher-reuse', (v) => { v.facts.launcherIdentity.starttime = '999' }],
    ['launcher-parent', (v) => { v.facts.launcherIdentity.ppid = 19 }],
    ['guardian-reuse', (v) => { v.facts.guardianIdentity.starttime = '999' }],
    ['guardian-parent', (v) => { v.guardian.ppid = 19 }],
    ['host-namespace', (v) => { v.facts.hostNamespace = 'pid:[43]' }],
  ]
  for (const [label, mutate] of mutations) {
    const value = sudoCarrierFixture(); mutate(value)
    assert.throws(() => verifySudoCarrierBirth(value), undefined, label)
  }
})

test('outer death carrier rejects wrong executable bytes inode and root/setuid permissions', () => {
  const mutations = [
    ['exe', (v) => { v.facts.executable.path = '/usr/bin/python3' }],
    ['public-exe', (v) => { v.executable.path = '/bin/sudo' }],
    ['hash', (v) => { v.executable.sha256 = 'c'.repeat(64) }],
    ['inode', (v) => { v.executable.ino += 1 }],
    ['device', (v) => { v.executable.dev += 1 }],
    ['bytes', (v) => { v.executable.bytes += 1 }],
    ['owner', (v) => { v.facts.executable.uid = 1001 }],
    ['group', (v) => { v.facts.executable.gid = 1002 }],
    ['no-setuid', (v) => { v.facts.executable.mode = 0o100755 }],
    ['setgid', (v) => { v.facts.executable.mode |= 0o2000 }],
    ['group-write', (v) => { v.facts.executable.mode |= 0o20 }],
    ['world-write', (v) => { v.facts.executable.mode |= 0o2 }],
    ['not-regular', (v) => { v.facts.executable.mode = 0o044755 }],
  ]
  for (const [label, mutate] of mutations) {
    const value = sudoCarrierFixture(); mutate(value)
    assert.throws(() => verifySudoCarrierBirth(value), undefined, label)
  }
})

test('outer death carrier rejects normal or partial UID tuples and mixed arbitrary or inconsistent GID tuples', () => {
  const mutations = [
    ['normal-uid', (v) => { v.credentials.uids = [1001, 1001, 1001, 1001] }],
    ['root-real-uid', (v) => { v.credentials.uids = [0, 0, 0, 0] }],
    ['partial-uid', (v) => { v.credentials.uids = [1001, 0, 1001, 0] }],
    ['attested-uid', (v) => { v.facts.carrierIdentity.uids = [1001, 0, 0, 1001] }],
    ['wrong-real-gid', (v) => { v.credentials.gids = [0, 1002, 1002, 1002] }],
    ['mixed-gid', (v) => { v.credentials.gids = [1002, 0, 1002, 0] }],
    ['arbitrary-gid', (v) => { v.credentials.gids = [1002, 7, 7, 7]; v.facts.carrierIdentity.gids = [1002, 7, 7, 7] }],
    ['different-readback', (v) => { v.credentials.gids = [1002, 0, 0, 0] }],
    ['role-mismatch', (v) => { v.facts.gidRole = 'root-group' }],
    ['unknown-role', (v) => { v.facts.gidRole = 'whatever-observed' }],
  ]
  for (const [label, mutate] of mutations) {
    const value = sudoCarrierFixture(); mutate(value)
    assert.throws(() => verifySudoCarrierBirth(value), undefined, label)
  }
})

function outerRoleStatus(uids, gids) {
  return 'Uid:\t' + uids.join('\t') + '\nGid:\t' + gids.join('\t') + '\nGroups:\t\nNoNewPrivs:\t1\n' +
    ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'].map((name) => name + ':\t0000000000000000\n').join('')
}

test('outer death normal Node keeps all owner credentials zero caps and no root-role fallback', () => {
  const normal = outerRoleStatus([1001, 1001, 1001, 1001], [1002, 1002, 1002, 1002])
  assert.equal(verifyOuterRoleCredentials('normal-node', normal, 1001, 1002).role, 'normal-node')
  for (const status of [outerRoleStatus([0, 0, 0, 0], [1002, 1002, 1002, 1002]),
    outerRoleStatus([1001, 0, 0, 0], [1002, 1002, 1002, 1002]),
    outerRoleStatus([1001, 1001, 1001, 1001], [1002, 0, 0, 0]),
    normal.replace('CapEff:\t0000000000000000', 'CapEff:\t0000000000000020'),
    normal.replace('NoNewPrivs:\t1', 'NoNewPrivs:\t0'), normal.replace('Groups:\t', 'Groups:\t0')]) {
    assert.throws(() => verifyOuterRoleCredentials('normal-node', status, 1001, 1002))
  }
  const root = outerRoleStatus([0, 0, 0, 0], [0, 0, 0, 0])
  for (const role of ['root-unshare', 'root-init']) {
    assert.equal(verifyOuterRoleCredentials(role, root, 1001, 1002).role, role)
    assert.throws(() => verifyOuterRoleCredentials(role, normal, 1001, 1002))
  }
  assert.throws(() => verifyOuterRoleCredentials('sudo-carrier', root, 1001, 1002))
})

test('CI source fingerprint explicitly includes new files without relying on tracked-only inventory', () => {
  const files = sourceFingerprint()
  assert.equal(new Set(files.map((value) => value.path)).size, CI_PIDFD_SOURCE_PATHS.length)
  for (const name of ['build-perception-pidfd.mjs', 'perception-addon-registry.mjs', 'cleanup-perception-pidfd.mjs',
    'run-perception-addon-consumer.mjs', 'perception-outer-host-death.mjs']) assert.ok(files.some((value) => value.path.endsWith('/' + name)))
  assert.ok(files.every((value) => /^[a-f0-9]{64}$/.test(value.sha256)))
})

test('normal Linux registry authenticates real self before invalid addon load and refuses closed admission',
  { skip: process.platform !== 'linux' }, async () => {
    assert.ok(process.getuid() > 0)
    const root = mkdtempSync(join(tmpdir(), 'apollo-ci-pidfd.')); chmodSync(root, 0o700)
    const env = { RUNNER_TEMP: tmpdir(), GITHUB_SHA: 'a'.repeat(40),
      APOLLO_PERCEPTION_PIDFD_ROOT: root, APOLLO_PERCEPTION_CONSUMER_RUN_ID: 'pidfd-consumer-unit-11111111-1111-1111-1111-111111111111',
      APOLLO_PERCEPTION_PIDFD_ADDON: join(root, 'perception-pidfd.node'), APOLLO_PERCEPTION_PIDFD_PROVENANCE: join(root, 'provenance.json') }
    try {
      const registry = initializeRegistry(root, 'pidfd-build-22222222-2222-2222-2222-222222222222', env)
      registry.sourceFiles = sourceFingerprint()
      writeFileSync(env.APOLLO_PERCEPTION_PIDFD_ADDON, 'invalid native bytes', { mode: 0o600 })
      writeFileSync(env.APOLLO_PERCEPTION_PIDFD_PROVENANCE, '{}', { mode: 0o600 })
      registry.addonSha256 = env.APOLLO_PERCEPTION_PIDFD_SHA256 = digest(readFileSync(env.APOLLO_PERCEPTION_PIDFD_ADDON))
      registry.provenanceSha256 = digest(readFileSync(env.APOLLO_PERCEPTION_PIDFD_PROVENANCE))
      registry.admission = 'closed'; writeRegistry(root, registry)
      await assert.rejects(loadPidfdBinding(env), /admission is closed/, 'Invalid addon cannot be required before registration')
      registry.admission = 'open'; writeRegistry(root, registry)
      const registered = await registerAddonConsumer(env)
      assert.equal(registered.entry.identity.pid, process.pid)
      assert.equal(registered.entry.registrationIsNotProcessClose, true)
      assert.equal(registered.entry.identity.namespace, registry.creator.namespace)
      assert.deepEqual(registered.entry.identity.uids, Array(4).fill(process.getuid()))
      assert.deepEqual(readRegistry(root, env).creator, registry.creator)
      const second = await registerAddonConsumer(env); assert.equal(second.path, registered.path)
      mkdirSync(join(root, 'admission.lock'), { mode: 0o700 })
      await assert.rejects(registryLock(root, () => assert.fail('Action must not run'), { env, deadlineAt: Date.now() + 10 }), /lock deadline/)
    } finally { rmSync(root, { recursive: true }) } // No processes/addon were created by this test.
})
