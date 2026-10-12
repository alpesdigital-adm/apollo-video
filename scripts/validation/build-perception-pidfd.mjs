import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, mkdtempSync, openSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CI_ROOT, budget, digest, initializeRegistry, sourceFingerprint, writeRegistry,
  readAuthorityIdentitySync, identityKey, liveIdentity } from './perception-addon-registry.mjs'
import { createLinuxObservationContext, linuxProcessSnapshot, collectOwnedIdentities, readLinuxProcessIdentity } from './run-perception-ci.mjs'

export function buildPublicationAllowed(report) {
  return report.errors.length === 0 && !report.interruptedBy && report.childCloseObserved === true &&
    report.compilerExitCode === 0 && report.childSignal === null && report.observed.length > 0 &&
    report.terminality.length === report.observed.length && report.terminality.every((item) => item.terminal)
}
export async function buildPidfd({ compiler, timeout, headers, env = process.env } = {}) {
  assert.equal(process.platform, 'linux'); assert.ok(process.getuid() > 0 && process.getgid() > 0)
  assert.ok(Number(process.versions.napi) >= 8)
  for (const path of [compiler, timeout, headers, env.RUNNER_TEMP, env.GITHUB_ENV]) assert.ok(path && path.startsWith('/'))
  const started = Date.now(), deadlineAt = Math.min(started + 110000, Number(env.APOLLO_PERCEPTION_JOB_DEADLINE_MS ?? Infinity))
  assert.ok(deadlineAt - started >= 90000, 'Build gate/compiler/terminality/log reserve insufficient')
  const runId = `pidfd-build-${randomUUID()}`, root = mkdtempSync(join(env.RUNNER_TEMP, 'apollo-ci-pidfd.'))
  chmodSync(root, 0o700)
  // Root location is cleanup evidence, not publication of a usable addon.
  appendFileSync(env.GITHUB_ENV, `APOLLO_PERCEPTION_PIDFD_ROOT=${root}\n`)
  const registry = initializeRegistry(root, runId, env)
  registry.sourceFiles = sourceFingerprint(); writeRegistry(root, registry)
  const fact = (path) => ({ path, sha256: digest(readFileSync(path)) })
  const report = { schemaVersion: 'perception-pidfd-build/v2', sourceCommit: env.GITHUB_SHA, runId,
    owner: registry.creator, registryRoot: registry.root, sourceFiles: registry.sourceFiles,
    uid: process.getuid(), gid: process.getgid(), napiVersion: 8, success: false, errors: [],
    childCloseObserved: false, observed: [], terminality: [], deadlineAt, foregroundBudgetMs: 60000,
    compiledAsNormalUid: true }
  writeFileSync(join(root, 'build-owner.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 })
  const observed = new Map()
  let child, closed = false, closePromise, birth, stdoutFd, stderrFd, context, interval, observerWork = Promise.resolve(), interrupted
  const fail = (error) => report.errors.push({ name: error.name, code: error.code ?? null, message: String(error.message).slice(0, 512) })
  const observe = async () => collectOwnedIdentities(await budget(() => linuxProcessSnapshot(runId, context), deadlineAt, 2000, 'Build inventory'), observed, birth?.pid)
  const signals = ['SIGINT', 'SIGTERM'].map((name) => {
    const handler = () => { interrupted ??= name; child?.stdin.end() }
    process.on(name, handler); return [name, handler]
  })
  try {
    report.source = fact(join(CI_ROOT, 'scripts/validation/perception-pidfd.c'))
    report.compiler = fact(compiler); report.timeout = fact(timeout)
    report.node = { ...fact(process.execPath), version: process.version, napiVersion: process.versions.napi }
    report.headers = ['node_api.h', 'node_api_types.h', 'js_native_api.h', 'js_native_api_types.h'].map((name) => fact(join(headers, name)))
    context = await budget(() => createLinuxObservationContext(), deadlineAt, 2000, 'Build owner context')
    context.observed = observed
    await observe()
    stdoutFd = openSync(join(root, 'compiler.stdout'), 'wx', 0o600); stderrFd = openSync(join(root, 'compiler.stderr'), 'wx', 0o600)
    child = spawn(process.execPath, [join(CI_ROOT, 'scripts/validation/perception-ci-child-bootstrap.mjs'),
      'compile', compiler, timeout, headers, report.source.path, root], {
      cwd: CI_ROOT, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', APOLLO_PERCEPTION_RUN_ID: runId },
      stdio: ['pipe', stdoutFd, stderrFd],
    })
    // Addon not built yet. Capture this DIRECT birth before yielding. If it
    // fails, EOF/5s bootstrap deadline prevents compiler execution.
    try {
      birth = readAuthorityIdentitySync(child.pid)
      assert.equal(birth.ppid, process.pid); assert.ok(liveIdentity(birth))
      assert.deepEqual(birth.uids, Array(4).fill(process.getuid())); report.bootstrapBirth = birth
    } finally {
      closePromise = new Promise((done) => child.once('close', (code, signal) => {
        closed = true; report.childCloseObserved = true; report.compilerExitCode = code; report.childSignal = signal; done()
      }))
      child.once('error', fail); child.stdin.on('error', fail)
    }
    observed.set(identityKey(birth), { ...birth, runMarked: true, ownershipVerified: true })
    context.rootPid = birth.pid
    const asyncVerified = await budget(() => readLinuxProcessIdentity(birth.pid), deadlineAt, 1000, 'Gated compiler birth recheck')
    assert.equal(identityKey(asyncVerified), identityKey(birth)); assert.equal(asyncVerified.ppid, process.pid)
    const verified = readAuthorityIdentitySync(birth.pid)
    assert.equal(identityKey(verified), identityKey(birth)); assert.equal(verified.ppid, process.pid)
    assert.ok(liveIdentity(verified)); assert.equal(verified.namespace, birth.namespace)
    child.stdin.end('G'); report.gateReleased = true
    let observing = false
    interval = setInterval(() => {
      if (observing) return
      observing = true
      observerWork = observe().catch((error) => { fail(error); child?.stdin.end() }).finally(() => { observing = false })
    }, 20)
    await budget(() => closePromise, deadlineAt - 15000, 65000, 'Fixed compiler chain close')
    assert.equal(report.compilerExitCode, 0); assert.equal(report.childSignal, null)
  } catch (error) { fail(error); child?.stdin.end() }
  finally {
    clearInterval(interval)
    try { await budget(() => observerWork, deadlineAt, 2000, 'Build observer finish'); if (context) await observe() } catch (error) { fail(error) }
    if (child && !closed) { try { await budget(() => closePromise, deadlineAt - 5000, 10000, 'Build final close') } catch (error) { fail(error) } }
    for (const expected of observed.values()) {
      try {
        const current = await budget(() => readLinuxProcessIdentity(expected.pid), deadlineAt - 3000, 1000, 'Build terminal identity')
        report.terminality.push({ pid: expected.pid, starttime: expected.starttime,
          terminal: !current || identityKey(current) !== identityKey(expected) || !liveIdentity(current),
          observation: !current ? 'absent' : identityKey(current) !== identityKey(expected) ? 'pid-recycled' : current.state })
      } catch (error) { fail(error) }
    }
    report.observed = [...observed.values()]
    for (const fd of [stdoutFd, stderrFd]) if (fd !== undefined) { try { closeSync(fd) } catch (error) { fail(error) } }
    for (const [name, handler] of signals) process.removeListener(name, handler)
    report.interruptedBy = interrupted ?? null
    try {
      report.success = buildPublicationAllowed(report)
      if (report.success) {
        assert.deepEqual(sourceFingerprint(), registry.sourceFiles, 'Source changed during build')
        report.compiler.version = readFileSync(join(root, 'compiler.version'), 'utf8').split('\n')[0].slice(0, 256)
        report.addon = fact(join(root, 'perception-pidfd.node'))
      }
    } catch (error) { fail(error); report.success = false }
    report.completedAt = new Date().toISOString()
    try {
      const receipt = join(root, 'provenance.json')
      writeFileSync(receipt, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 })
      registry.admission = report.success ? 'open' : 'closed'; registry.provenanceSha256 = digest(readFileSync(receipt))
      registry.addonSha256 = report.addon?.sha256 ?? null; writeRegistry(root, registry)
      if (report.success) appendFileSync(env.GITHUB_ENV,
        `APOLLO_PERCEPTION_PIDFD_ADDON=${report.addon.path}\nAPOLLO_PERCEPTION_PIDFD_PROVENANCE=${receipt}\nAPOLLO_PERCEPTION_PIDFD_SHA256=${report.addon.sha256}\n`)
    } catch (error) { fail(error); report.success = false }
    process.stdout.write(`Pidfd build owner: ${report.success ? 'PASS' : 'FAIL'}; retainedRoot=${root}\n`)
    if (!report.success) process.stderr.write(`${JSON.stringify(report)}\n`)
    // Never destroy handles/unref/force-exit if GNU containment is inconclusive.
  }
  return report
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [compiler, timeout, headers] = process.argv.slice(2)
  try { if (!(await buildPidfd({ compiler, timeout, headers })).success) process.exitCode = 1 }
  catch (error) { process.stderr.write(`Pidfd build admission failed: ${error.message}\n`); process.exitCode = 1 }
}
