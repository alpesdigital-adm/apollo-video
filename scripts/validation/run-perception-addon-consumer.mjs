import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, readlink, realpath } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CI_ROOT, budget, identityKey, liveIdentity, readAuthorityIdentitySync, registerAddonConsumer, readRegistry, jsonDigest } from './perception-addon-registry.mjs'
import { loadPidfdBinding, openObservedPidfd } from './perception-pidfd.mjs'
import { collectOwnedIdentities, parseLinuxProcessStat, parseLinuxProcessCredentials, readLinuxProcessIdentity } from './run-perception-ci.mjs'
import { assertPerceptionSuite, COMPOSED_SUITE } from './run-perception-ci-namespace.mjs'
import { assertCgroupScope, parseCgroupMembership, readCgroupSnapshot } from './perception-consumer-cgroup.mjs'

export function fixedConsumer(mode, args) {
  assert.ok(['unit', 'namespace', 'gates', 'dashboard', 'acquisition'].includes(mode), 'Fixed CI consumers only')
  if (mode === 'namespace') { assert.ok(args.length >= 1 && args.length <= 2); assertPerceptionSuite(args[0], args[1] ?? null) }
  else if (mode === 'gates') assert.deepEqual(args, [COMPOSED_SUITE])
  else assert.deepEqual(args, [])
  return [join(CI_ROOT, 'scripts/validation/perception-ci-child-bootstrap.mjs'), mode, ...args]
}
export const DASHBOARD_CI_ARGV = Object.freeze(['--experimental-transform-types',
  '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--test', '--test-reporter=tap',
  'tests/v2/dashboard-runtime-journey.e2e.mjs'])
export function fixedDashboardDeadline(mode, configured, started) {
  const cap = mode === 'dashboard' ? 445000 : mode === 'acquisition' ? 300000 : null
  if (cap === null) return configured
  assert.ok(Number.isSafeInteger(configured) && configured > started + 30000, 'Dashboard owner absolute deadline required')
  return Math.min(configured, started + cap)
}
// Kernel-admitted domain only. Processes outside this exact cgroup are outside
// the run's inventory, not UID/baseline exceptions. Unknown members still fail.
export async function consumerSnapshot(deadlineAt, scope) {
  return readCgroupSnapshot(assertCgroupScope(scope), deadlineAt)
}
export function consumerTerminalProof(report) {
  return report.childCloseObserved === true && report.observed.length > 0 &&
    report.terminality.length === report.observed.length && report.terminality.every((value) => value.terminal)
}
export function collectConsumerIdentities(snapshot, observed, rootPid, baseline = new Map()) {
  const kernelProofs = [...observed].filter(([, entry]) => entry.ownershipAuthority === 'kernel-cgroup-membership')
  collectOwnedIdentities(snapshot.filter((entry) => !baseline.has(identityKey(entry)) || observed.has(identityKey(entry))), observed, rootPid)
  for (const [key, prior] of kernelProofs) {
    const current = observed.get(key)
    if (current) observed.set(key, { ...current, ownership: 'kernel-cgroup-membership',
      ownershipAuthority: prior.ownershipAuthority, kernelCgroupProof: prior.kernelCgroupProof })
  }
}
// The registered kernel domain can contain members whose original parent has
// already exited. A fresh scope proof, never a name/UID/baseline exception,
// must bind their PID/starttime to a retained native token before adoption.
export async function adoptKernelCgroupMember(expected, { scope, registration, env = process.env,
  baseline, observed, held, binding, deadlineAt, verifyDeadlineAt = deadlineAt,
  io = { lstat, realpath, readFile, readRegistry } }) {
  assertCgroupScope(scope)
  assert.ok(observed.size < 4096 && held.size < 4096, 'Kernel member inventory exceeds observation bound')
  const key = identityKey(expected)
  assert.ok(!baseline.has(key) && !observed.has(key) && !held.has(key), 'Kernel admission cannot adopt a baseline or existing identity')
  assert.ok(Number.isSafeInteger(expected.pid) && expected.pid > 0 && liveIdentity(expected))
  assert.match(expected.starttime, /^[0-9]+$/)
  assert.equal(expected.cgroupMembership, scope.membership)
  assert.deepEqual(registration.entry.cgroupScope, scope, 'Kernel authority differs from admitted consumer scope')
  const end = Math.min(deadlineAt, verifyDeadlineAt, Date.now() + 500)
  const monotonicEnd = performance.now() + Math.max(0, end - Date.now())
  const check = () => assert.ok(Date.now() < end && performance.now() < monotonicEnd, 'Kernel member verification deadline exhausted')
  const action = async (operation) => { check(); const value = await operation(); check(); return value }
  const authority = async () => {
    const registry = await action(() => io.readRegistry(env.APOLLO_PERCEPTION_PIDFD_ROOT, env, { deadlineAt: end }))
    assert.equal(registry.admission, 'open'); assert.equal(registry.runId, registration.entry.buildRunId)
    assert.equal(registry.sourceCommit, registration.entry.sourceCommit); assert.equal(registry.sourceCommit, env.GITHUB_SHA)
    assert.equal(registry.cgroups?.filter((entry) => entry.state === 'open' && entry.runId === scope.runId &&
      jsonDigest(entry.scope) === jsonDigest(scope)).length, 1, 'Unique registered kernel domain required')
    assert.equal(await action(() => io.realpath(scope.path)), scope.path)
    const directory = await action(() => io.lstat(scope.path))
    assert.ok(directory.isDirectory() && !directory.isSymbolicLink() && directory.uid === 0 && !(directory.mode & 0o022))
    assert.equal(directory.dev, scope.directory.dev); assert.equal(directory.ino, scope.directory.ino)
    const kill = await action(() => io.lstat(posix.join(scope.path, 'cgroup.kill')))
    assert.ok(kill.isFile() && !kill.isSymbolicLink())
    assert.equal(kill.dev, scope.kill.dev); assert.equal(kill.ino, scope.kill.ino)
  }
  const text = async (path) => {
    const value = await action(() => io.readFile(path, { encoding: 'utf8', signal: AbortSignal.timeout(Math.max(1, end - Date.now())) }))
    assert.ok(typeof value === 'string' && Buffer.byteLength(value) <= 65536, 'Kernel member metadata exceeds bound')
    return value
  }
  const recheck = async () => {
    const before = parseLinuxProcessStat(await text(`/proc/${expected.pid}/stat`))
    assert.equal(identityKey(before), key); assert.ok(liveIdentity(before))
    assert.equal(parseCgroupMembership(await text(`/proc/${expected.pid}/cgroup`)), scope.membership)
    const after = parseLinuxProcessStat(await text(`/proc/${expected.pid}/stat`))
    assert.equal(identityKey(after), key); assert.ok(liveIdentity(after))
    return { ...after, cgroupMembership: scope.membership }
  }
  let owned, committed = false
  try {
    await authority()
    check()
    owned = await openObservedPidfd(expected, { binding, readIdentity: recheck,
      deadlineAt, verifyDeadlineAt: end })
    check(); assert.equal(owned.terminal, false, 'Kernel member identity became unavailable during admission')
    await authority()
    // Revalidate membership after the scope readback, while the same token is
    // held. Disappearance/recycle/denial is a failed admission, never terminal
    // proof or authority to acquire a replacement PID.
    const current = await recheck()
    check()
    const member = { ...current, ownership: 'kernel-cgroup-membership', ownershipAuthority: 'kernel-cgroup-membership', kernelCgroupProof: {
      schemaVersion: 'perception-kernel-cgroup-member/v1', scope: structuredClone(scope),
      buildRunId: registration.entry.buildRunId, consumerRunId: registration.entry.consumerRunId,
      verifiedAt: Date.now(), pidfdRetained: true, runMarkedAttested: false } }
    assert.ok(!baseline.has(key) && !observed.has(key) && !held.has(key))
    held.set(key, owned); observed.set(key, member); committed = true
    return member
  } finally { if (!committed) owned?.close() }
}
export function unattributedConsumerFacts(entry, snapshot, baseline, observed, interval) {
  const membership = (value) => ({ baseline: baseline.has(identityKey(value)), observed: observed.has(identityKey(value)) })
  const byPid = new Map(snapshot.map((value) => [value.pid, value]))
  const ancestry = [], seen = new Set()
  let current = entry
  for (let depth = 0; current && depth < 16 && !seen.has(identityKey(current)); depth += 1) {
    seen.add(identityKey(current)); ancestry.push({ ...current, membership: membership(current) })
    current = byPid.get(current.ppid)
  }
  const parents = (values) => [...values].filter((value) => value.pid === entry.ppid).slice(0, 4).map((value) => ({ ...value }))
  return { scope: 'metadata-diagnostic-not-ownership-authority', before: { ...entry }, membership: membership(entry),
    snapshotInterval: interval, snapshotSize: snapshot.length, snapshotAncestry: ancestry,
    snapshotAncestryTruncated: current !== undefined && current !== null,
    parentFromSnapshot: byPid.get(entry.ppid) ?? null,
    parentsFromBaseline: parents(baseline.values()), parentsFromObserved: parents(observed.values()),
    recheck: [], errors: [], completed: false }
}
async function unknownProcessDetails(expected, role, end, io) {
  const detail = { role, expected: { ...expected }, scope: 'metadata-only-not-ownership', consistent: false, errors: [] }
  let phase = 'stat-before'
  const bounded = async (action) => {
    const remaining = end - Date.now()
    assert.ok(remaining > 0, 'Unknown process detail deadline exhausted before read')
    const value = await budget(action, end, Math.min(250, remaining), 'Unknown process detail')
    assert.ok(Date.now() < end, 'Unknown process detail expired before accepting read')
    return value
  }
  const text = async (name) => {
    const value = await bounded(() => {
      const remaining = end - Date.now()
      assert.ok(remaining > 0, 'Unknown process detail expired before file action')
      return io.readFile(`/proc/${expected.pid}/${name}`,
        { encoding: 'utf8', signal: AbortSignal.timeout(Math.min(250, remaining)) })
    })
    assert.ok(typeof value === 'string' && Buffer.byteLength(value) <= 65536, 'Unknown process metadata byte limit')
    return value
  }
  const statusFacts = (value) => {
    for (const field of ['Uid', 'Gid', 'NSpid'])
      assert.equal(value.split('\n').filter((line) => line.startsWith(field + ':')).length, 1)
    const credentials = parseLinuxProcessCredentials(value)
    const matched = /^NSpid:[\t ]+([0-9]+(?:[\t ]+[0-9]+)*)[\t ]*$/m.exec(value)
    assert.ok(matched, 'Unknown process namespace PID metadata missing')
    const nspids = matched[1].split(/[\t ]+/).map(Number)
    assert.ok(nspids.length <= 32 && nspids[0] === expected.pid &&
      nspids.every((pid) => Number.isSafeInteger(pid) && pid > 0))
    return { ...credentials, nspids }
  }
  const namespace = async () => {
    const value = await bounded(() => io.readlink(`/proc/${expected.pid}/ns/pid`))
    assert.ok(typeof value === 'string' && value.length <= 64 && /^pid:\[\d+\]$/.test(value))
    return value
  }
  const matches = (value) => identityKey(value) === identityKey(expected) && value.ppid === expected.ppid
  try {
    const raw = await text('stat')
    detail.before = parseLinuxProcessStat(raw)
    assert.ok(matches(detail.before), 'Unknown process identity changed before metadata')
    const comm = raw.slice(raw.indexOf('(') + 1, raw.lastIndexOf(')'))
    assert.ok(Buffer.byteLength(comm) > 0 && Buffer.byteLength(comm) <= 128, 'Unknown process comm exceeds bound')
    detail.comm = comm
    phase = 'status-before'; detail.statusBefore = statusFacts(await text('status'))
    phase = 'namespace-before'; detail.namespaceBefore = await namespace()
    phase = 'status-after'; detail.statusAfter = statusFacts(await text('status'))
    phase = 'namespace-after'; detail.namespaceAfter = await namespace()
    phase = 'stat-after'; detail.after = parseLinuxProcessStat(await text('stat'))
    detail.mismatches = []
    if (!matches(detail.after)) detail.mismatches.push('identity-or-parent')
    for (const field of ['uids', 'gids', 'nspids']) {
      if (JSON.stringify(detail.statusBefore[field]) !== JSON.stringify(detail.statusAfter[field])) detail.mismatches.push(field)
    }
    if (detail.namespaceBefore !== detail.namespaceAfter) detail.mismatches.push('namespace')
    detail.consistent = detail.mismatches.length === 0
  } catch (error) {
    const message = String(error?.message ?? '')
    detail.errors.push({ phase, name: error.name, code: error.code ?? null,
      messageSha256: createHash('sha256').update(message).digest('hex'), messageBytes: Buffer.byteLength(message) })
  }
  return detail
}
export async function recheckUnattributedConsumer(facts, deadlineAt, readIdentity = readLinuxProcessIdentity,
  io = { readFile, readlink }) {
  const started = Date.now(), end = Math.min(deadlineAt, started + 1000)
  facts.recheckStartedAt = started; facts.recheckDeadlineAt = end
  const read = async (pid) => {
    assert.ok(Date.now() < end, 'Unknown identity metadata deadline exhausted before read')
    const value = await budget(() => readIdentity(pid), end, Math.min(250, end - Date.now()), 'Unknown identity metadata')
    assert.ok(Date.now() < end, 'Unknown identity metadata expired before accepting read')
    return value
  }
  try {
    let current = await read(facts.before.pid)
    facts.selectedRecheck = current
    if (!current || identityKey(current) !== identityKey(facts.before)) {
      facts.selectedIdentityMatches = false; facts.completed = true; return facts
    }
    facts.selectedIdentityMatches = true
    facts.processDetails = [await unknownProcessDetails(current, 'selected', end, io)]
    const seen = new Set()
    for (let depth = 0; current.ppid > 0 && depth < 16 && !seen.has(identityKey(current)); depth += 1) {
      seen.add(identityKey(current))
      const parent = await read(current.ppid), childAfter = await read(current.pid)
      const parentAfter = parent ? await read(parent.pid) : null
      const stable = Boolean(parent && parentAfter && childAfter && identityKey(current) === identityKey(childAfter) &&
        current.ppid === childAfter.ppid && parent.pid === childAfter.ppid && identityKey(parent) === identityKey(parentAfter))
      const parentStartedAfterChild = parent ? BigInt(parent.starttime) > BigInt(current.starttime) : null
      facts.recheck.push({ childBefore: current, childAfter, parentBefore: parent, parentAfter,
        stableIdentityEdge: stable, parentStartedAfterChild })
      if (depth === 0 && parent) facts.processDetails.push(await unknownProcessDetails(parent, 'immediate-parent', end, io))
      if (!stable || parentStartedAfterChild) break
      current = parentAfter
    }
    facts.recheckTruncated = facts.recheck.length === 16 && current.ppid > 0
    facts.recheckCycleDetected = Boolean(seen.has(identityKey(current)) && facts.recheck.at(-1)?.parentAfter &&
      identityKey(facts.recheck.at(-1).parentAfter) === identityKey(current))
    facts.completed = true
  } catch (error) {
    const message = String(error?.message ?? '')
    facts.errors.push({ name: error.name, code: error.code ?? null,
      messageSha256: createHash('sha256').update(message).digest('hex'), messageBytes: Buffer.byteLength(message) })
  } finally {
    facts.recheckFinishedAt = Date.now()
    if (facts.processDetails) facts.processDetailsComplete =
      facts.processDetails.length === (facts.selectedRecheck.ppid > 0 ? 2 : 1) &&
      facts.processDetails.every((value) => value.consistent && !value.errors.length)
  }
  return facts
}
export async function runAddonConsumer(mode, args = [], env = process.env) {
  const command = fixedConsumer(mode, args)
  assert.equal(process.platform, 'linux'); assert.ok(process.getuid() > 0 && process.getgid() > 0)
  const runId = `pidfd-consumer-${mode}-${randomUUID()}`
  env = { ...env, APOLLO_PERCEPTION_CONSUMER_RUN_ID: runId }
  process.env.APOLLO_PERCEPTION_CONSUMER_RUN_ID = runId
  const started = Date.now(), configured = Number(env.APOLLO_PERCEPTION_JOB_DEADLINE_MS ?? started + 1200000)
  assert.ok(Number.isSafeInteger(configured) && configured > started + 30000)
  const deadlineAt = fixedDashboardDeadline(mode, configured, started), workDeadline = deadlineAt - 25000
  const scope = assertCgroupScope(JSON.parse(env.APOLLO_PERCEPTION_CGROUP_SCOPE ?? 'null'))
  assert.equal(scope.membership, parseCgroupMembership(await budget(() => readFile(`/proc/${process.pid}/cgroup`,
    { encoding: 'utf8', signal: AbortSignal.timeout(500) }), workDeadline, 500, 'Consumer kernel admission')),
  'Consumer kernel admission must already be complete')
  const registration = await registerAddonConsumer(env) // Owner BEFORE native load.
  const { binding } = await loadPidfdBinding(env)
  const baseline = new Map((await consumerSnapshot(deadlineAt, scope)).map((value) => [identityKey(value), value]))
  const observed = new Map(), held = new Map()
  const report = { schemaVersion: 'perception-pidfd-consumer-close/v1', runId, mode, args,
    sourceCommit: env.GITHUB_SHA, buildRunId: registration.entry.buildRunId,
    owner: registration.entry.identity, scope, childCloseObserved: false, success: false, errors: [], observed: [], terminality: [] }
  const fail = (error) => report.errors.push({ name: error.name, code: error.code ?? null, message: String(error.message).slice(0, 512) })
  let child, birthToken, closed = false, closePromise, interrupted
  const signals = ['SIGINT', 'SIGTERM'].map((name) => {
    const handler = () => { interrupted ??= name; child?.stdin.end() }; process.on(name, handler); return [name, handler]
  })
  try {
    child = spawn(process.execPath, command, { cwd: CI_ROOT, env, stdio: ['pipe', 'inherit', 'inherit'] })
    // Binding loaded first. Birth token and stat are synchronous before libuv
    // can reap this DIRECT child; no later PID adoption if either fails.
    try {
      assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0)
      birthToken = binding.open(child.pid)
      const birth = readAuthorityIdentitySync(child.pid)
      assert.equal(birth.ppid, process.pid); assert.ok(liveIdentity(birth))
      assert.deepEqual(birth.uids, Array(4).fill(process.getuid()))
      report.childBirth = birth; observed.set(identityKey(birth), { ...birth, runMarked: true })
    } finally {
      closePromise = new Promise((done) => child.once('close', (code, signal) => {
        closed = true; report.childCloseObserved = true; report.code = code; report.signal = signal; done()
      }))
      child.once('error', fail); child.stdin.on('error', (error) => { if (!closed) fail(error) })
    }
    const recheck = await budget(() => readLinuxProcessIdentity(report.childBirth.pid), workDeadline, 1000, 'Consumer gated birth recheck')
    assert.equal(identityKey(recheck), identityKey(report.childBirth)); assert.equal(recheck.ppid, process.pid); assert.ok(liveIdentity(recheck))
    child.stdin.end('G'); report.gateReleased = true
    while (!closed && !interrupted && !report.errors.length) {
      const snapshotStartedAt = Date.now()
      const snapshot = await consumerSnapshot(workDeadline, scope)
      const snapshotFinishedAt = Date.now()
      collectConsumerIdentities(snapshot, observed, report.childBirth.pid, baseline)
      for (const entry of snapshot) {
        if (baseline.has(identityKey(entry)) || observed.has(identityKey(entry)) || entry.pid === process.pid || !liveIdentity(entry)) continue
        try {
          await adoptKernelCgroupMember(entry, { scope, registration, env, baseline, observed, held, binding,
            deadlineAt, verifyDeadlineAt: Math.min(workDeadline, Date.now() + 500) })
          continue
        } catch (error) {
          report.kernelMemberAdmissionError = { name: error.name, code: error.code ?? null,
            messageSha256: createHash('sha256').update(String(error.message)).digest('hex') }
        }
        // Preserve this exact selected entry BEFORE creating the original
        // failure. Diagnostic rechecks never update observed or open pidfds.
        report.unattributed = unattributedConsumerFacts(entry, snapshot, baseline, observed, { snapshotStartedAt, snapshotFinishedAt })
        let original
        try { assert.fail(`Unattributed new live process ${entry.pid}:${entry.starttime}; retained root`) } catch (error) { original = error }
        try { await recheckUnattributedConsumer(report.unattributed, workDeadline) }
        catch (error) { report.unattributed.errors.push({ name: error.name, code: error.code ?? null }) }
        try {
          // The existing owned CI log survives containment. No new artifact
          // name bypasses the closed prerequisite-root receipt allowlist.
          process.stderr.write(`${JSON.stringify({ kind: 'unattributed-consumer-metadata', runId, facts: report.unattributed })}\n`)
        } catch (error) { report.unattributed.errors.push({ name: error.name, code: error.code ?? null, phase: 'diagnostic-write' }) }
        throw original
      }
      await budget(() => Promise.race([closePromise, new Promise((done) => setTimeout(done, 20))]), workDeadline, 1000, 'Consumer close poll')
    }
    assert.ok(closed && report.code === 0 && report.signal === null && !interrupted, 'Fixed consumer did not close successfully')
  } catch (error) { fail(error); child?.stdin.end() }
  finally {
    const cleanupDeadline = Math.min(deadlineAt, Date.now() + 25000)
    try {
      const snapshot = await consumerSnapshot(cleanupDeadline, scope)
      collectConsumerIdentities(snapshot, observed, report.childBirth?.pid, baseline)
      for (const entry of snapshot) {
        if (baseline.has(identityKey(entry)) || observed.has(identityKey(entry)) || entry.pid === process.pid || !liveIdentity(entry)) continue
        try { await adoptKernelCgroupMember(entry, { scope, registration, env, baseline, observed, held, binding,
          deadlineAt, verifyDeadlineAt: Math.min(cleanupDeadline, Date.now() + 500) }) }
        catch (error) { fail(error) }
      }
    } catch (error) { fail(error) }
    // Only known identities. Attach before recheck; no bare-PID fallback.
    for (const expected of [...observed.values()].reverse()) {
      try {
        const current = await budget(() => readLinuxProcessIdentity(expected.pid), cleanupDeadline, 500, 'Consumer containment precheck')
        if (!current || identityKey(current) !== identityKey(expected) || !liveIdentity(current)) continue
        const owned = held.get(identityKey(expected)) ?? await openObservedPidfd(expected, { binding, readIdentity: readLinuxProcessIdentity,
          deadlineAt: cleanupDeadline, verifyDeadlineAt: Math.min(cleanupDeadline, Date.now() + 500) })
        if (!held.has(identityKey(expected))) held.set(identityKey(expected), owned)
        if (!owned.terminal) { owned.signal('SIGKILL'); report.containmentRequired = true }
      } catch (error) {
        if (['ESRCH', 'ENOENT'].includes(error.code)) {
          try {
            const current = await budget(() => readLinuxProcessIdentity(expected.pid), cleanupDeadline, 500, 'Consumer pidfd race recheck')
            assert.ok(!current || identityKey(current) !== identityKey(expected) || !liveIdentity(current), 'Pidfd failure did not prove terminality')
          } catch (recheckError) { fail(recheckError) }
        } else fail(error)
      }
    }
    if (birthToken && !closed) {
      try { binding.signal(birthToken, 'SIGKILL'); report.containmentRequired = true } catch (error) { fail(error) }
    }
    if (child && !closed) { try { await budget(() => closePromise, cleanupDeadline, 5000, 'Consumer child close') } catch (error) { fail(error) } }
    for (const expected of observed.values()) {
      try {
        let current
        do {
          current = await budget(() => readLinuxProcessIdentity(expected.pid), cleanupDeadline, 500, 'Consumer terminality')
          if (!current || identityKey(current) !== identityKey(expected) || !liveIdentity(current)) break
          await budget(() => new Promise((done) => setTimeout(done, 10)), cleanupDeadline, 20, 'Consumer terminal poll')
        } while (Date.now() < cleanupDeadline)
        report.terminality.push({ ...expected, terminal: !current || identityKey(current) !== identityKey(expected) || !liveIdentity(current),
          observation: !current ? 'absent' : identityKey(current) !== identityKey(expected) ? 'pid-recycled' : current.state })
      } catch (error) { fail(error) }
    }
    for (const token of held.values()) { try { token.close() } catch (error) { fail(error) } }
    if (birthToken) { try { binding.close(birthToken) } catch (error) { fail(error) } }
    for (const [name, handler] of signals) process.removeListener(name, handler)
    report.observed = [...observed.values()]; report.interruptedBy = interrupted ?? null
    report.success = report.errors.length === 0 && report.code === 0 && report.signal === null &&
      !report.interruptedBy && !report.containmentRequired && consumerTerminalProof(report)
    report.completedAt = new Date().toISOString()
    report.receiptPath = join(env.APOLLO_PERCEPTION_PIDFD_ROOT, 'receipts', `${runId}.json`)
    try { writeFileSync(report.receiptPath, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 })
      writeFileSync(join(env.APOLLO_PERCEPTION_PIDFD_ROOT, 'receipts', `${runId}.sha256`), jsonDigest(report), { flag: 'wx', mode: 0o600 })
    } catch (error) { fail(error); report.success = false }
    if (!report.success) process.stderr.write(`${JSON.stringify(report)}\n`)
  }
  return report
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const [mode, ...args] = process.argv.slice(2); if (!(await runAddonConsumer(mode, args)).success) process.exitCode = 1 }
  catch (error) { process.stderr.write(`Fixed consumer admission failed: ${error.message}\n`); process.exitCode = 1 }
}
