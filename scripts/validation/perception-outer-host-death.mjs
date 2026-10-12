import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CI_ROOT, budget, digest, identityKey, liveIdentity, readAuthorityIdentitySync } from './perception-addon-registry.mjs'
import { loadPidfdBinding, openObservedPidfd } from './perception-pidfd.mjs'
import { readLinuxProcessIdentity, parseLinuxProcessCredentials } from './run-perception-ci.mjs'
import { COMPOSED_SUITE, verifyGuardianBirth, confirmTerminalIdentity, requireEmptyDatabase } from './run-perception-ci-namespace.mjs'

export function verifyOuterHostDeath(report) {
  assert.equal(report.kind, 'outer-host-death')
  assert.equal(report.launcherCloseObserved, true); assert.equal(report.launcherSignal, 'SIGKILL')
  assert.equal(report.launcherTerminal?.terminal, true)
  assert.equal(report.productGateReleased, false)
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
  const fail = (error) => report.errors.push({ name: error.name, code: error.code ?? null, message: String(error.message).slice(0, 512) })
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
    for (const [identity, parent, uid] of [[expected[0], birth, process.getuid()], [expected[2], expected[1], 0],
      [expected[3], expected[2], 0], [expected[4], expected[3], process.getuid()]]) {
      const stat = await budget(() => readLinuxProcessIdentity(identity.pid), deadlineAt, 300, 'Parent ancestry recheck')
      assert.equal(identityKey(stat), identityKey(identity)); assert.equal(stat.ppid, parent.pid); assert.ok(liveIdentity(stat))
      const credentials = parseLinuxProcessCredentials(await budget(() => readFile(`/proc/${identity.pid}/status`, 'utf8'), deadlineAt, 300, 'Parent UID recheck'))
      assert.deepEqual(credentials.uids, Array(4).fill(uid))
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
