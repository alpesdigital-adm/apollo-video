import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLEANUP_BUDGET_MS, attachSupervisorSignals, collectOwnedIdentities, containObservedIdentities, createPerceptionRunId,
  parseLinuxProcessStat, readLinuxProcessIdentity, requireJobBudget, signalObservedIdentity,
  supervisePerceptionCommand,
} from '../../scripts/validation/run-perception-ci.mjs'

const entry = (pid, starttime, extra = {}) => ({ pid, starttime, ppid: 1,
  state: 'S', processGroupId: pid, sessionId: pid, ...extra })
const statText = (overrides = {}) => {
  const fields = Array(50).fill('0')
  Object.assign(fields, { 0: 'S', 1: '2', 2: '3', 3: '4', 19: '987654321987654321' }, overrides)
  return `123 (worker ) with ( spaces)) ${fields.join(' ')}`
}

test('Linux stat identity handles comm parentheses and preserves decimal starttime', () => {
  assert.deepEqual(parseLinuxProcessStat(statText()), entry(123, '987654321987654321', {
    ppid: 2, processGroupId: 3, sessionId: 4,
  }))
  for (const text of [statText().split(' ').slice(0, -1).join(' '), statText({ 0: '?' }),
    statText({ 1: '-1' }), statText({ 2: '1.5' }), statText({ 3: '9007199254740993' }),
    statText({ 19: 'NaN' }), statText().replace('123 (', '123 ['), statText().replace(')) S', '))S')]) {
    assert.throws(() => parseLinuxProcessStat(text))
  }
})

test('observed identities survive setsid and reparenting without adopting a reused root PID', () => {
  const observed = new Map()
  collectOwnedIdentities([entry(10, '100', { runMarked: true }), entry(11, '110', { ppid: 10 })], observed, 10)
  collectOwnedIdentities([entry(10, '999'), entry(11, '110'), entry(12, '120', { runMarked: true })], observed, 10)
  assert.deepEqual([...observed.keys()].sort(), ['10:100', '11:110', '12:120'])
  assert.equal(observed.get('11:110').ppid, 1)
  assert.equal(observed.get('11:110').sessionId, 11)
  assert.equal(observed.get('11:110').ownership, 'ancestry')
  assert.equal(observed.get('12:120').ownership, 'run-id')
  assert.throws(() => collectOwnedIdentities(Array(16_385).fill(entry(1, '1')), observed, 10))
})

test('pidfd outcomes refuse reused or inconclusive identities and do not infer exit from a signal', async () => {
  const owned = entry(10, '100')
  const recycled = await signalObservedIdentity(owned, 'SIGTERM', {
    pidfdSignal: async () => ({ result: 'pid-recycled' }),
    readIdentity: () => { throw new Error('must not read or signal recycled identity') },
  })
  assert.equal(recycled.result, 'pid-recycled')
  assert.equal((await signalObservedIdentity(owned, 'SIGTERM', {
    pidfdSignal: async () => ({ result: 'signaled' }),
  })).result, 'signaled')
  await assert.rejects(signalObservedIdentity(owned, 'SIGKILL', {
    pidfdSignal: async () => ({ result: 'lookup-race' }), readIdentity: async () => owned,
  }), /did not prove terminality/)
  assert.equal((await signalObservedIdentity(owned, 'SIGKILL', {
    pidfdSignal: async () => ({ result: 'lookup-race' }), readIdentity: async () => null,
  })).result, 'absent')
  assert.equal((await signalObservedIdentity(owned, 'SIGKILL', {
    pidfdSignal: async () => ({ result: 'terminal-state' }), readIdentity: async () => ({ ...owned, state: 'Z' }),
  })).result, 'zombie')
  await assert.rejects(signalObservedIdentity(owned, 'SIGTERM', {
    pidfdSignal: async () => { throw new Error('pidfd APIs unavailable') },
  }), /unavailable/)
})

test('aggregate job admission reserves cleanup and rejects missing or exhausted budgets', () => {
  assert.equal(requireJobBudget(String(1000 + 300_000 + CLEANUP_BUDGET_MS), 300_000, 1000),
    1000 + 300_000 + CLEANUP_BUDGET_MS)
  for (const value of [undefined, 'Infinity', 'NaN', '0', '9007199254740993', String(300_999 + CLEANUP_BUDGET_MS)]) {
    assert.throws(() => requireJobBudget(value, 300_000, 1000))
  }
  assert.notEqual(createPerceptionRunId(), createPerceptionRunId())
})

test('multiple delayed child identities share one aggregate containment deadline', async () => {
  let calls = 0
  const started = Date.now(), deadlineAt = started + 100
  const result = await containObservedIdentities([entry(10, '100'), entry(11, '110'), entry(12, '120'), entry(13, '130')],
    'SIGTERM', deadlineAt, { pidfdSignal: async (_identity, _signal, _runId, passedDeadline) => {
      calls += 1
      assert.equal(passedDeadline, deadlineAt)
      await new Promise((done) => setTimeout(done, 65))
      return { result: 'signaled' }
    } })
  assert.ok(Date.now() - started < 230, 'Containment must not wait a full deadline per child')
  assert.ok(calls <= 2)
  assert.equal(result.signals.length, 1)
  assert.ok(result.errors.some((error) => /deadline/.test(error)))
})

test('SIGINT and SIGTERM both abort through the shared cleanup path and remove listeners', () => {
  for (const name of ['SIGINT', 'SIGTERM']) {
    const emitter = new EventEmitter(), controller = new AbortController(), report = {}
    const remove = attachSupervisorSignals(controller, report, emitter)
    emitter.emit(name)
    assert.equal(controller.signal.aborted, true)
    assert.equal(report.interruptedBy, name)
    assert.match(controller.signal.reason.message, new RegExp(name))
    remove()
    assert.equal(emitter.listenerCount('SIGINT') + emitter.listenerCount('SIGTERM'), 0)
  }
})

test('Linux owned cleanup proves close and terminal identities for setsid, timeout, signals and observation failure', {
  skip: process.platform !== 'linux', timeout: 90_000,
}, async () => {
  // Explicit setsid is confined to this controlled test. The real owner spawn
  // retains normal parentage and inherits a unique run marker.
  const root = await mkdtemp(join(tmpdir(), 'apollo-perception-supervisor-'))
  const reports = [], pidPath = join(root, 'setsid-pid')
  let primaryError
  const budget = () => String(Date.now() + 120_000)
  const run = async (extra) => {
    const report = await supervisePerceptionCommand({ args: ['-e', 'setInterval(() => {}, 1000)'],
      deadlineMs: 1500, observationIntervalMs: 50, jobDeadline: budget(), ...extra })
    reports.push(report)
    // Preserve ownership evidence before any assertion in the calling case.
    await writeFile(join(root, `report-${reports.length}.json`), JSON.stringify(report, null, 2))
    return report
  }
  const requireTerminal = async (report) => {
    assert.equal(report.childCloseObserved, true)
    assert.equal(report.processTreeTerminal, true, JSON.stringify(report))
    assert.deepEqual(report.activeSurvivors, [])
    for (const identity of report.observedProcesses) {
      const current = await readLinuxProcessIdentity(identity.pid)
      assert.ok(!current || current.starttime !== identity.starttime || ['Z', 'X', 'x'].includes(current.state))
    }
  }
  try {
    const ownIdentity = await readLinuxProcessIdentity(process.pid)
    const refused = await signalObservedIdentity({ ...ownIdentity, starttime: String(BigInt(ownIdentity.starttime) + 1n) }, 'SIGTERM', {
      runId: createPerceptionRunId(),
    })
    assert.equal(refused.result, 'pid-recycled', 'The real pidfd bridge must reject a mismatched live identity')

    const natural = await run({ args: ['-e', 'setTimeout(() => {}, 250)'] })
    assert.equal(natural.success, true, JSON.stringify(natural))
    await requireTerminal(natural)

    const escaped = await run({ deadlineMs: 3000, args: ['-e', `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const escaped = spawn('setsid', [process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      const stat = fs.readFileSync('/proc/' + escaped.pid + '/stat', 'utf8');
      const starttime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/)[19];
      fs.writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify({ pid: escaped.pid, starttime }));
      setTimeout(() => process.exit(0), 650);
    `] })
    const escapedPid = JSON.parse(await readFile(pidPath, 'utf8')).pid
    assert.equal(escaped.success, false)
    assert.equal(escaped.containmentRequired, true)
    assert.ok(escaped.observedProcesses.some((identity) => identity.pid === escapedPid && identity.sessionId === escapedPid))
    await requireTerminal(escaped)

    const timeout = await run({ deadlineMs: 350 })
    assert.match(timeout.error, /exceeded its deadline/)
    assert.equal(timeout.success, false)
    await requireTerminal(timeout)

    for (const name of ['SIGINT', 'SIGTERM']) {
      const emitter = new EventEmitter(), controller = new AbortController(), interruption = {}
      const remove = attachSupervisorSignals(controller, interruption, emitter)
      const timer = setTimeout(() => emitter.emit(name), 350)
      try {
        const interrupted = await run({ signal: controller.signal })
        assert.equal(interruption.interruptedBy, name)
        assert.equal(interrupted.success, false)
        await requireTerminal(interrupted)
      } finally { clearTimeout(timer); remove() }
    }

    let observations = 0
    const { linuxProcessSnapshot } = await import('../../scripts/validation/run-perception-ci.mjs')
    const inconclusive = await run({ snapshot: async (runId) => {
      if (++observations === 3) throw new Error('controlled inventory failure')
      return linuxProcessSnapshot(runId)
    } })
    assert.equal(inconclusive.success, false)
    assert.equal(inconclusive.observationComplete, false)
    assert.equal(inconclusive.inventoryInconclusive, true)
    assert.equal(inconclusive.processTreeTerminal, false)
    assert.equal(inconclusive.childCloseObserved, true)
    assert.deepEqual(inconclusive.activeSurvivors, [])
    const failedIdentity = await readLinuxProcessIdentity(inconclusive.rootPid)
    assert.ok(!failedIdentity || ['Z', 'X', 'x'].includes(failedIdentity.state))
  } catch (error) { primaryError = error; throw error }
  finally {
    const deadlineAt = Date.now() + 25_000, cleanup = { signals: [], identities: [], errors: [] }
    const owned = new Map()
    for (const report of reports) for (const identity of report.observedProcesses ?? []) {
      owned.set(`${identity.pid}:${identity.starttime}`, { ...identity, runId: report.runId })
    }
    const wait = async (action, limit = 2000) => {
      const remaining = deadlineAt - Date.now()
      assert.ok(remaining > 0, 'Controlled test cleanup deadline exhausted')
      let timer
      try { return await Promise.race([action(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Controlled test cleanup deadline exhausted')), Math.min(limit, remaining))
      })]) } finally { clearTimeout(timer) }
    }
    const inspect = async () => {
      const active = []
      cleanup.identities = []
      for (const identity of owned.values()) {
        try {
          const current = await wait(() => readLinuxProcessIdentity(identity.pid))
          const observation = !current ? 'absent' : current.starttime !== identity.starttime ? 'pid-recycled' : current.state
          cleanup.identities.push({ pid: identity.pid, starttime: identity.starttime, observation })
          if (current?.starttime === identity.starttime && !['Z', 'X', 'x'].includes(current.state)) active.push(identity)
        } catch (error) {
          cleanup.errors.push(String(error.stack ?? error))
          cleanup.identities.push({ pid: identity.pid, starttime: identity.starttime, observation: 'inconclusive' })
          // The pidfd bridge can still validate this known identity safely.
          // One unreadable entry must not suppress containment of the others.
          active.push(identity)
        }
      }
      return active
    }
    try {
      try {
        const identity = JSON.parse(await wait(() => readFile(pidPath, 'utf8')))
        assert.ok(Number.isSafeInteger(identity.pid) && identity.pid > 0 && /^\d+$/.test(identity.starttime))
        const key = `${identity.pid}:${identity.starttime}`
        owned.set(key, { ...owned.get(key), ...identity })
      } catch (error) { if (error.code !== 'ENOENT') cleanup.errors.push(String(error.stack ?? error)) }
      let active = await inspect()
      for (const signal of ['SIGTERM', 'SIGKILL']) {
        if (!active.length) break
        const contained = await containObservedIdentities(active, signal, deadlineAt)
        cleanup.signals.push(...contained.signals); cleanup.errors.push(...contained.errors)
        if (Date.now() < deadlineAt) await wait(() => new Promise((done) => setTimeout(done, 100)))
        active = await inspect()
      }
      while (active.length && Date.now() < deadlineAt) {
        await wait(() => new Promise((done) => setTimeout(done, 100)))
        active = await inspect()
      }
      cleanup.terminal = cleanup.errors.length === 0 && active.length === 0 &&
        reports.every((report) => report.childCloseObserved === true)
      if (!cleanup.terminal) cleanup.errors.push('Controlled test retained a live identity or unverified ChildProcess.close')
    } catch (error) { cleanup.terminal = false; cleanup.errors.push(String(error.stack ?? error)) }
    const preserve = primaryError || cleanup.errors.length || !cleanup.terminal ||
      reports.some((report) => !report.observationComplete || report.inventoryInconclusive)
    if (preserve) {
      const evidence = { root, error: primaryError ? String(primaryError.stack ?? primaryError) : null, reports, cleanup }
      try { await wait(() => writeFile(join(root, 'cleanup.json'), JSON.stringify(evidence, null, 2)), 5000) }
      catch (error) { cleanup.errors.push(String(error.stack ?? error)) }
      process.stderr.write(`Controlled perception test evidence preserved: ${root}\n${JSON.stringify(evidence)}\n`)
    } else {
      try { await wait(() => rm(root, { recursive: true, force: true }), 5000) }
      catch (error) { cleanup.errors.push(String(error.stack ?? error)); process.stderr.write(`Controlled perception evidence cleanup failed: ${root}\n${JSON.stringify(cleanup)}\n`) }
    }
    if (!primaryError && cleanup.errors.length) assert.fail(JSON.stringify(cleanup))
  }
})
