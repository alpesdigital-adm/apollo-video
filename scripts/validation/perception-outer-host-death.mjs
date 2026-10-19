import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CI_ROOT, budget, digest, identityKey, liveIdentity, readAuthorityIdentitySync } from './perception-addon-registry.mjs'
import { loadPidfdBinding, openObservedPidfd } from './perception-pidfd.mjs'
import { readLinuxProcessIdentity, parseLinuxProcessCredentials } from './run-perception-ci.mjs'
import { COMPOSED_SUITE, verifyGuardianBirth, confirmTerminalIdentity, requireEmptyDatabase } from './run-perception-ci-namespace.mjs'

export function verifySudoCarrierBirth({ facts, expected, current, rechecked, launcher, guardian,
  credentials, uid, gid, namespace, wardenSha256, executable, token }) {
  assert.ok(Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(gid) && gid > 0)
  assert.equal(facts?.schemaVersion, 'perception-sudo-carrier-birth/v1', 'Authenticated carrier birth facts required')
  assert.ok(Number.isSafeInteger(expected?.pid) && expected.pid > 1, 'Carrier must be a host PID above init')
  assert.match(expected.starttime, /^\d+$/)
  assert.equal(facts.measurement, 'privileged-before-drop')
  assert.match(wardenSha256, /^[a-f0-9]{64}$/); assert.equal(facts.sourceSha256, wardenSha256)
  assert.ok(token && token.terminal === false && typeof token.close === 'function', 'Parent-owned carrier pidfd required')
  for (const value of [token.expected, token.current, facts.carrierIdentity, current, rechecked]) {
    assert.equal(identityKey(value), identityKey(expected), 'Carrier PID/starttime mismatch')
    assert.equal(value.ppid, launcher.pid, 'Carrier launcher parent mismatch'); assert.ok(liveIdentity(value))
  }
  assert.equal(identityKey(facts.launcherIdentity), identityKey(launcher), 'Carrier creator identity mismatch')
  assert.equal(facts.launcherIdentity.ppid, launcher.ppid)
  assert.equal(identityKey(facts.guardianIdentity), identityKey(guardian), 'Carrier guardian identity mismatch')
  assert.equal(facts.guardianIdentity.ppid, expected.pid); assert.equal(guardian.ppid, expected.pid)
  assert.match(namespace, /^pid:\[\d+\]$/); assert.equal(facts.hostNamespace, namespace)
  assert.deepEqual(facts.launcherIdentity.uids, Array(4).fill(uid))
  assert.deepEqual(facts.launcherIdentity.gids, Array(4).fill(gid))
  assert.deepEqual(facts.carrierIdentity.uids, [uid, 0, 0, 0])
  assert.deepEqual(credentials.uids, [uid, 0, 0, 0], 'Carrier setuid UID role mismatch')
  assert.ok(['owner-group', 'root-group', 'all-root-group'].includes(facts.gidRole), 'Unknown carrier GID role')
  const expectedGids = facts.gidRole === 'all-root-group' ? [0, 0, 0, 0] :
    [gid, ...Array(3).fill(facts.gidRole === 'owner-group' ? gid : 0)]
  assert.deepEqual(facts.carrierIdentity.gids, expectedGids, 'Carrier attested GID role mismatch')
  assert.deepEqual(credentials.gids, expectedGids, 'Carrier measured GID role mismatch')
  for (const file of [facts.executable, executable]) {
    assert.equal(file.path, '/usr/bin/sudo', 'Carrier executable must be the fixed sudo binary')
    assert.ok(Number.isSafeInteger(file.dev) && file.dev >= 0 && Number.isSafeInteger(file.ino) && file.ino > 0)
    assert.ok(Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= 16 * 1024 * 1024)
    assert.ok(Number.isSafeInteger(file.mode) && (file.mode & 0o170000) === 0o100000)
    assert.equal(file.uid, 0); assert.equal(file.gid, 0)
    assert.ok((file.mode & 0o4000) !== 0 && (file.mode & 0o2022) === 0 && (file.mode & 0o111) !== 0,
      'Carrier executable root/setuid/nonwritable role mismatch')
    assert.match(file.sha256, /^[a-f0-9]{64}$/)
  }
  assert.deepEqual(executable, facts.executable, 'Public sudo file authentication differs from privileged executable facts')
  return { role: 'sudo-carrier', authentication: 'parent-owned-pidfd/status-readback/warden-pre-drop-exe',
    pid: expected.pid, starttime: expected.starttime, ppid: launcher.pid, uidRole: 'owner-real/root-effective-saved-fs',
    gidRole: facts.gidRole, uids: [...credentials.uids], gids: [...credentials.gids], hostNamespace: namespace,
    executable: { ...executable } }
}

export function verifyOuterRoleCredentials(role, status, uid, gid) {
  const credentials = parseLinuxProcessCredentials(status)
  assert.ok(['root-unshare', 'root-init', 'normal-node'].includes(role), 'Unknown outer ancestry role')
  const normal = role === 'normal-node'
  assert.deepEqual(credentials.uids, Array(4).fill(normal ? uid : 0))
  assert.deepEqual(credentials.gids, Array(4).fill(normal ? gid : 0))
  if (normal) {
    for (const name of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'])
      assert.match(status, new RegExp('^' + name + ':\\s+0000000000000000$', 'm'))
    assert.match(status, /^NoNewPrivs:\s+1$/m); assert.match(status, /^Groups:\s*$/m)
  }
  return { role, ...credentials }
}

async function authenticatePublicSudoFile(deadlineAt) {
  const path = '/usr/bin/sudo'
  const before = await budget(() => lstat(path), deadlineAt, 300, 'Public sudo file stat')
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.size > 0 && before.size <= 16 * 1024 * 1024)
  assert.equal(before.uid, 0); assert.equal(before.gid, 0)
  assert.ok((before.mode & 0o4000) !== 0 && (before.mode & 0o2022) === 0 && (before.mode & 0o111) !== 0)
  const bytes = await budget(() => readFile(path), deadlineAt, 1000, 'Public fixed sudo bytes')
  const after = await budget(() => lstat(path), deadlineAt, 300, 'Public sudo file recheck')
  for (const field of ['dev', 'ino', 'size', 'mode', 'uid', 'gid', 'mtimeMs', 'ctimeMs']) assert.equal(after[field], before[field])
  assert.equal(bytes.length, before.size)
  return { path, dev: before.dev, ino: before.ino, bytes: bytes.length, mode: before.mode,
    uid: before.uid, gid: before.gid, sha256: digest(bytes) }
}

export function verifyOuterHostDeath(report) {
  assert.equal(report.kind, 'outer-host-death')
  assert.equal(report.launcherCloseObserved, true); assert.equal(report.launcherSignal, 'SIGKILL')
  assert.equal(report.launcherTerminal?.terminal, true)
  assert.equal(report.productGateReleased, false)
  assert.equal(report.carrierCredentials?.role, 'sudo-carrier', 'Measured carrier role proof required')
  assert.equal(report.carrierCredentials.authentication, 'parent-owned-pidfd/status-readback/warden-pre-drop-exe')
  assert.equal(report.identities.length, 5); assert.ok(report.identities.every((value) => value.terminal))
  assert.equal(report.postflight?.backendCount, 0); assert.equal(report.errors.length, 0)
  assert.equal(report.observedRunSuccess, false); assert.equal(report.innerReceiptPresent, false)
  assert.equal(report.outerReceiptPresent, false)
  assert.equal(report.namespaceEmpty, undefined, 'No FINAL cannot prove namespaceEmpty')
  assert.equal(report.nodeCloseObserved, undefined, 'Kernel containment cannot fabricate init close')
}
export async function runOuterHostDeath(env = process.env) {
  const started = Date.now(), deadlineAt = started + 60000
  assert.ok(Number(env.APOLLO_PERCEPTION_JOB_DEADLINE_MS) >= started + 480000)
  const { binding } = await loadPidfdBinding(env)
  const evidence = join(env.APOLLO_LIBRARY_EVIDENCE_ROOT, 'namespace-gates', 'outer-host-death')
  await mkdir(evidence, { recursive: true })
  const report = { schemaVersion: 'perception-outer-host-death/v1', kind: 'outer-host-death',
    sourceCommit: env.GITHUB_SHA, parent: readAuthorityIdentitySync(process.pid), errors: [],
    identities: [], observedRunSuccess: false, containmentTerminal: false, productGateReleased: false }
  const fail = (error) => report.errors.push({ name: error.name, code: error.code ?? null, message: String(error.message).slice(0, 512),
    ...(error.admissionLockDiagnostic ? { admissionLockDiagnostic: error.admissionLockDiagnostic } : {}) })
  let child, birthToken, closed = false, closePromise, readyPromise, prepared, birth, protocolError
  const held = new Map()
  try {
    child = spawn(process.execPath, [join(CI_ROOT, 'scripts/validation/perception-ci-child-bootstrap.mjs'), 'outer-launcher'], {
      cwd: CI_ROOT, env: { ...env, APOLLO_LIBRARY_EVIDENCE_ROOT: evidence }, stdio: ['pipe', 'inherit', 'inherit', 'ipc'],
    })
    try {
      assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0)
      birthToken = binding.open(child.pid) // DIRECT child; synchronous before yield/reap.
      birth = readAuthorityIdentitySync(child.pid)
      assert.equal(birth.ppid, process.pid); assert.ok(liveIdentity(birth))
      assert.deepEqual(birth.uids, Array(4).fill(process.getuid())); report.launcherBirth = birth
    } finally {
      closePromise = new Promise((done) => child.once('close', (code, signal) => {
        closed = true; report.launcherCloseObserved = true; report.launcherCode = code; report.launcherSignal = signal; done()
      }))
      child.once('error', fail); child.stdin.on('error', (error) => { if (!closed) fail(error) })
      readyPromise = new Promise((done, reject) => {
        child.on('message', (value) => {
          try {
            assert.equal(value?.kind, 'namespace-parent-ready'); assert.deepEqual(Object.keys(value).sort(), ['kind', 'ready'])
            assert.ok(!prepared, 'Duplicate parent READY')
            assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 65536)
            prepared = value.ready; done(prepared)
          } catch (error) { protocolError ??= error; reject(error) }
        })
        child.once('disconnect', () => { if (!prepared) reject(new Error('Launcher IPC closed before READY')) })
      })
      readyPromise.catch(() => {})
    }
    const verified = await budget(() => readLinuxProcessIdentity(birth.pid), deadlineAt, 1000, 'Outer direct birth recheck')
    assert.equal(identityKey(verified), identityKey(birth)); assert.equal(verified.ppid, process.pid); assert.ok(liveIdentity(verified))
    child.stdin.end('G') // Releases only normal launcher, never namespace product.
    await budget(() => readyPromise, deadlineAt - 20000, 35000, 'Authenticated child READY')
    if (protocolError) throw protocolError
    report.runId = prepared.config.runId
    assert.deepEqual(Object.keys(prepared.config).sort(), ['abi', 'runId', 'sourceCommit', 'suite', 'pattern',
      'controlledFault', 'uid', 'gid', 'deadlineAt', 'innerDeadlineAt'].sort(), 'READY must never forward environment bytes')
    assert.equal(prepared.config.suite, COMPOSED_SUITE)
    assert.equal(prepared.config.controlledFault, null); assert.equal(prepared.config.sourceCommit, env.GITHUB_SHA)
    assert.equal(prepared.packet.runId, report.runId); assert.equal(prepared.packet.sourceCommit, env.GITHUB_SHA)
    assert.equal(prepared.packet.stage, 'guardian-ready')
    assert.equal(prepared.packet.wardenSha256, digest(await budget(() => readFile(join(CI_ROOT,
      'scripts/validation/perception_namespace_warden.py')), deadlineAt, 300, 'Warden source authentication')))
    assert.equal(prepared.sudoIdentity.ppid, birth.pid)
    const expected = [prepared.sudoIdentity, prepared.packet.guardianIdentity, prepared.packet.unshareIdentity,
      prepared.packet.initIdentity, prepared.packet.nodeHostIdentity]
    assert.equal(new Set(expected.map(identityKey)).size, 5)
    report.readyIdentities = expected
    // Parent opens OWN tokens; metadata/launcher tokens are not authority.
    for (const identity of expected) {
      const owned = await openObservedPidfd(identity, { binding, readIdentity: readLinuxProcessIdentity,
        deadlineAt, verifyDeadlineAt: Math.min(deadlineAt, Date.now() + 300) })
      assert.equal(owned.terminal, false); held.set(identityKey(identity), owned)
    }
    report.namespaceBinding = await budget(() => verifyGuardianBirth(prepared.packet, prepared.sudoIdentity),
      deadlineAt, 1500, 'Parent independently measured normal Node anchor')
    assert.equal(report.namespaceBinding.directlyObserved.namespace, prepared.namespaceBinding.directlyObserved.namespace)
    assert.equal(prepared.config.uid, process.getuid()); assert.equal(prepared.config.gid, process.getgid())
    // Privileged pre-drop executable/namespace facts are bound to current
    // status, live ancestry and our OWN token; no normal setuid /proc/exe read.
    const sudoFile = await authenticatePublicSudoFile(deadlineAt)
    const carrierCurrent = await budget(() => readLinuxProcessIdentity(expected[0].pid), deadlineAt, 300, 'Parent carrier identity')
    const carrierCredentials = parseLinuxProcessCredentials(await budget(() => readFile(`/proc/${expected[0].pid}/status`, 'utf8'),
      deadlineAt, 300, 'Parent carrier credentials'))
    const carrierRechecked = await budget(() => readLinuxProcessIdentity(expected[0].pid), deadlineAt, 300, 'Parent carrier final identity')
    report.carrierBirthFacts = prepared.packet.carrierBirthFacts
    report.carrierCredentials = verifySudoCarrierBirth({ facts: prepared.packet.carrierBirthFacts,
      expected: expected[0], current: carrierCurrent, rechecked: carrierRechecked, launcher: birth,
      guardian: expected[1], credentials: carrierCredentials, uid: prepared.config.uid, gid: prepared.config.gid,
      namespace: birth.namespace, wardenSha256: prepared.packet.wardenSha256, executable: sudoFile,
      token: held.get(identityKey(expected[0])) })
    report.ancestryCredentials = []
    for (const [role, identity, parent] of [['root-unshare', expected[2], expected[1]],
      ['root-init', expected[3], expected[2]], ['normal-node', expected[4], expected[3]]]) {
      const stat = await budget(() => readLinuxProcessIdentity(identity.pid), deadlineAt, 300, 'Parent ancestry recheck')
      assert.equal(identityKey(stat), identityKey(identity)); assert.equal(stat.ppid, parent.pid); assert.ok(liveIdentity(stat))
      const status = await budget(() => readFile(`/proc/${identity.pid}/status`, 'utf8'), deadlineAt, 300, 'Parent role credentials')
      const credentials = verifyOuterRoleCredentials(role, status, prepared.config.uid, prepared.config.gid)
      const rechecked = await budget(() => readLinuxProcessIdentity(identity.pid), deadlineAt, 300, 'Parent role final identity')
      assert.equal(identityKey(rechecked), identityKey(identity)); assert.equal(rechecked.ppid, parent.pid); assert.ok(liveIdentity(rechecked))
      report.ancestryCredentials.push({ ...credentials, pid: identity.pid, starttime: identity.starttime, ppid: parent.pid })
    }
    report.parentTokensOpenedAndRechecked = expected.map((value) => ({ pid: value.pid, starttime: value.starttime }))
    // Intentionally NEVER send parent ACK: the actual HOST outer dies gated.
    binding.signal(birthToken, 'SIGKILL'); report.launcherKillSent = true
    assert.equal(report.launcherCloseObserved, undefined, 'Signal success is not observed close')
    await budget(() => closePromise, deadlineAt - 10000, 10000, 'Killed host launcher close')
  } catch (error) { fail(error) }
  finally {
    if (birthToken && !closed) { try { binding.signal(birthToken, 'SIGKILL') } catch (error) { fail(error) } }
    // Retained own tokens may contain ONLY the validated normal guardian and
    // Node. Root PID1/unshare termination is kernel parent-death, never RPC.
    for (const expected of [prepared?.packet.guardianIdentity, prepared?.packet.nodeHostIdentity].filter(Boolean)) {
      try {
        const token = held.get(identityKey(expected))
        const observation = await budget(() => confirmTerminalIdentity(expected), deadlineAt, 500, 'Cascade observation')
        if (!observation.terminal && token) token.signal('SIGKILL')
      } catch (error) { fail(error) }
    }
    if (child && !closed) { try { await budget(() => closePromise, deadlineAt, 5000, 'Final host launcher close') } catch (error) { fail(error) } }
    for (const expected of [birth, ...(report.readyIdentities ?? [])].filter(Boolean)) {
      try {
        let observation
        do {
          observation = await budget(() => confirmTerminalIdentity(expected), deadlineAt - 5000, 300, 'Minted terminality')
          if (observation.terminal) break
          await budget(() => new Promise((done) => setTimeout(done, 10)), deadlineAt - 5000, 20, 'Terminality poll')
        } while (Date.now() < deadlineAt - 5000)
        if (expected === birth) report.launcherTerminal = observation
        else report.identities.push(observation)
      } catch (error) { fail(error) }
    }
    try { report.postflight = await requireEmptyDatabase(env, report.runId ?? 'unreleased-outer-death', deadlineAt) } catch (error) { fail(error) }
    for (const [name, file] of [['innerReceiptPresent', 'perception-namespace-observer.json'], ['outerReceiptPresent', 'perception-namespace-observer.namespace.json']]) {
      try { await budget(() => readFile(join(evidence, file)), deadlineAt, 300, 'Forbidden fabricated receipt check'); report[name] = true }
      catch (error) { if (error.code === 'ENOENT') report[name] = false; else fail(error) }
    }
    for (const token of held.values()) { try { token.close() } catch (error) { fail(error) } }
    if (birthToken) { try { binding.close(birthToken) } catch (error) { fail(error) } }
    try { verifyOuterHostDeath(report); report.containmentTerminal = true } catch (error) { fail(error) }
    report.receiptPath = join(evidence, 'outer-host-death.json')
    try { await budget(() => writeFile(report.receiptPath, JSON.stringify(report, null, 2)), deadlineAt, 1000, 'Outer death containment receipt') } catch (error) { fail(error) }
  }
  return report
}
