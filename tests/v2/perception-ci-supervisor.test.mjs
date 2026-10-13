import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLEANUP_BUDGET_MS, attachSupervisorSignals, collectOwnedIdentities, containObservedIdentities, createPerceptionRunId,
  parseLinuxProcessStat, readLinuxProcessIdentity, requireJobBudget, signalObservedIdentity,
  supervisePerceptionCommand,
  createLinuxObservationContext, observeLinuxProcesses,
} from '../../scripts/validation/run-perception-ci.mjs'

const entry = (pid, starttime, extra = {}) => ({ pid, starttime, ppid: 1,
  state: 'S', processGroupId: pid, sessionId: pid, ...extra })
const statText = (overrides = {}) => {
  const fields = Array(50).fill('0')
  Object.assign(fields, { 0: 'S', 1: '2', 2: '3', 3: '4', 19: '987654321987654321' }, overrides)
  return `123 (worker ) with ( spaces)) ${fields.join(' ')}`
}

function observationWorld(extra = []) {
  const owner = entry(100, '100'), peer = entry(20, '40')
  const states = new Map([peer, ...extra, owner].map((identity) => [identity.pid, { ...identity, uid: 600 }]))
  const environments = new Map(), denied = new Map()
  const io = {
    entries: async () => [...states.keys()].map(String),
    identity: async (pid) => states.has(pid) ? { ...states.get(pid) } : null,
    owner: async (pid) => ({ uid: states.get(pid)?.uid }),
    environment: async (pid) => {
      if (denied.has(pid)) throw denied.get(pid)
      return Buffer.from(environments.get(pid) ?? '')
    },
  }
  const permission = Object.assign(new Error('controlled environ permission denial'), { code: 'EACCES' })
  return { states, environments, denied, io, permission,
    context: () => createLinuxObservationContext(owner.pid, io) }
}

test('Linux EACCES excludes only a rechecked frozen identity predating the supervisor, with receipt evidence', async () => {
  const world = observationWorld(), context = await world.context()
  world.denied.set(20, world.permission)
  const first = await observeLinuxProcesses('controlled-run', context, world.io)
  assert.ok(first.some((identity) => identity.pid === 20))
  assert.equal(context.captureBaseline, false)
  assert.equal(context.exclusions.get('20:40').reason, 'environ-eacces-preexisting-before-owner-unrelated')
  assert.equal(context.exclusions.get('20:40').ownerStarttime, '100')
  assert.equal(context.exclusions.get('20:40').uid, 600)
  const size = context.baseline.size
  world.states.set(30, { ...entry(30, '30'), uid: 600 })
  await observeLinuxProcesses('controlled-run', context, world.io)
  assert.equal(context.baseline.size, size, 'later observations must never expand the admission baseline')
  world.denied.set(30, world.permission)
  await assert.rejects(observeLinuxProcesses('controlled-run', context, world.io), (error) => error === world.permission)
})

test('Linux unreadable equal/newer, root, owner, observed and ancestry identities remain inconclusive', async () => {
  for (const scenario of ['equal', 'newer', 'root', 'owner', 'observed', 'child', 'transitive-child', 'recycled', 'parent-changed']) {
    const world = observationWorld([entry(21, '45', { ppid: 20 }), entry(31, '48', { ppid: 21 })]), context = await world.context()
    await observeLinuxProcesses('controlled-run', context, world.io)
    let candidate = 20
    if (scenario === 'equal') world.states.get(20).starttime = '100'
    if (scenario === 'newer') world.states.get(20).starttime = '101'
    if (scenario === 'root') context.rootPid = 20
    if (scenario === 'owner') candidate = 100
    if (scenario === 'observed') context.observed.set('20:40', entry(20, '40'))
    if (scenario === 'child') world.states.get(20).ppid = 100
    if (scenario === 'transitive-child') {
      context.observed.set('20:40', entry(20, '40'))
      candidate = 31
    }
    if (scenario === 'recycled') world.states.get(20).starttime = '41'
    if (scenario === 'parent-changed') world.states.get(20).ppid = 999
    world.denied.set(candidate, world.permission)
    await assert.rejects(observeLinuxProcesses('controlled-run', context, world.io), (error) => error === world.permission, scenario)
  }
})

test('Linux age guard rejects unchanged equal/newer baseline peers and compares large decimal starttimes exactly', async () => {
  for (const starttime of ['100', '101']) {
    const world = observationWorld()
    world.states.get(20).starttime = starttime
    world.denied.set(20, world.permission)
    const context = await world.context()
    await assert.rejects(observeLinuxProcesses('controlled-run', context, world.io), (error) => error === world.permission)
    assert.equal(context.baseline.get(`20:${starttime}`).starttime, starttime,
      'age denial must exercise an unchanged identity that is actually in the baseline')
    assert.equal(context.exclusions.size, 0)
  }
  const world = observationWorld()
  world.states.get(20).starttime = '9007199254740992'
  world.states.get(100).starttime = '9007199254740993'
  world.denied.set(20, world.permission)
  const context = await world.context()
  await observeLinuxProcesses('controlled-run', context, world.io)
  assert.equal(context.exclusions.get('20:9007199254740992').ownerStarttime, '9007199254740993')
})

test('Linux known markers and later-listed marked parents cannot be excluded by environment enumeration order', async () => {
  const world = observationWorld([entry(30, '30')]), context = await world.context()
  world.states.get(20).ppid = 30
  world.denied.set(20, world.permission)
  world.environments.set(30, 'APOLLO_PERCEPTION_RUN_ID=controlled-run\0')
  await assert.rejects(observeLinuxProcesses('controlled-run', context, world.io), (error) => error === world.permission)
  assert.equal(context.exclusions.size, 0)
  world.denied.delete(20)
  await observeLinuxProcesses('controlled-run', context, world.io)
  world.environments.set(30, '')
  world.denied.set(30, world.permission)
  await assert.rejects(observeLinuxProcesses('controlled-run', context, world.io), (error) => error === world.permission)
})

test('Linux baseline UID, recheck identity/UID/parentage and stat/environment errors cannot grant an exclusion', async () => {
  for (const scenario of ['baseline-uid', 'recheck-uid', 'recheck-starttime', 'recheck-ppid', 'recheck-eacces', 'environment-eio', 'stat-eacces']) {
    const world = observationWorld()
    if (scenario === 'baseline-uid') world.states.get(20).uid = 601
    const context = await world.context()
    await observeLinuxProcesses('controlled-run', context, world.io)
    world.states.get(20).uid = 600
    const failure = scenario === 'environment-eio'
      ? Object.assign(new Error('controlled environment IO failure'), { code: 'EIO' }) : world.permission
    if (scenario !== 'stat-eacces') world.denied.set(20, failure)
    let identityReads = 0, ownerReads = 0
    const originalIdentity = world.io.identity, originalOwner = world.io.owner
    world.io.identity = async (pid) => {
      const current = await originalIdentity(pid)
      if (pid === 20 && ++identityReads === 2) {
        if (scenario === 'recheck-starttime') current.starttime = '41'
        if (scenario === 'recheck-ppid') current.ppid = 999
        if (['recheck-eacces', 'stat-eacces'].includes(scenario)) throw world.permission
      }
      return current
    }
    world.io.owner = async (pid) => {
      const owner = await originalOwner(pid)
      if (pid === 20 && ++ownerReads === 2 && scenario === 'recheck-uid') owner.uid = 601
      return owner
    }
    await assert.rejects(observeLinuxProcesses('controlled-run', context, world.io), (error) => error === failure, scenario)
    assert.equal(context.exclusions.size, 0, scenario)
  }
})

test('Linux baseline cannot be created after spawn or survive a changed supervisor identity', async () => {
  const afterSpawn = observationWorld(), lateContext = await afterSpawn.context()
  lateContext.rootPid = 999
  await assert.rejects(observeLinuxProcesses('controlled-run', lateContext, afterSpawn.io), /Baseline cannot be established after child spawn/)
  assert.equal(lateContext.baseline.size, 0)
  for (const field of ['uid', 'starttime']) {
    const world = observationWorld(), context = await world.context()
    world.states.get(100)[field] = field === 'uid' ? 601 : '101'
    await assert.rejects(observeLinuxProcesses('controlled-run', context, world.io), /Supervisor owner identity or UID changed/)
  }
})

test('Linux EACCES terminal rechecks retain identity, current parent and historical ownership closure', async () => {
  for (const state of ['Z', 'X', 'x']) {
    const world = observationWorld(), context = await world.context()
    await observeLinuxProcesses('controlled-run', context, world.io)
    // The denied child precedes its marked parent in /proc enumeration, and
    // reparenting happens between captured metadata and the terminal recheck.
    for (const identity of [entry(31, '131', { ppid: 30 }), entry(32, '132', { ppid: 31 }), entry(30, '130')]) {
      world.states.set(identity.pid, { ...identity, uid: 600 })
    }
    context.rootPid = 30
    world.environments.set(30, 'APOLLO_PERCEPTION_RUN_ID=controlled-run\0')
    world.denied.set(31, world.permission)
    const originalIdentity = world.io.identity
    let reads = 0
    world.io.identity = async (pid) => {
      const identity = await originalIdentity(pid)
      return pid === 31 && ++reads === 2 ? { ...identity, state, ppid: 1 } : identity
    }
    const snapshot = await observeLinuxProcesses('controlled-run', context, world.io)
    const terminal = snapshot.find((identity) => identity.pid === 31)
    assert.equal(terminal.state, state)
    assert.equal(terminal.ppid, 1, 'historical ancestry must not overwrite current PPID')
    assert.equal(Object.hasOwn(terminal, 'historicalPpids'), false)
    assert.equal(context.exclusions.size, 0)
    const receipt = context.terminalEnvironmentRechecks.get('31:131')
    assert.equal(receipt.observation, 'terminal-state')
    assert.equal(receipt.before.ppid, 30)
    assert.equal(receipt.before.state, 'S')
    assert.equal(receipt.recheck.ppid, 1)
    assert.equal(receipt.recheck.state, state)
    assert.equal(receipt.recheck.uid, 600)
    assert.equal(context.environmentDenials.get('31:131').guardReason, receipt.reason)
    assert.deepEqual([...context.observed.keys()].sort(), ['30:130', '31:131', '32:132'])
    assert.equal(context.observed.get('31:131').state, state)
    assert.deepEqual(context.observed.get('31:131').historicalParentIdentities, [{ pid: 30, starttime: '130' }])
    assert.equal(context.observed.get('32:132').ownership, 'ancestry')
  }
})

test('Linux live denied owned child remains a failure but survives reparenting for bounded containment', async () => {
  const world = observationWorld(), context = await world.context()
  await observeLinuxProcesses('controlled-run', context, world.io)
  world.states.set(31, { ...entry(31, '131', { ppid: 30 }), uid: 600 })
  world.states.set(30, { ...entry(30, '130'), uid: 600 })
  context.rootPid = 30
  world.environments.set(30, 'APOLLO_PERCEPTION_RUN_ID=controlled-run\0')
  world.denied.set(31, world.permission)
  const originalIdentity = world.io.identity
  let reads = 0
  world.io.identity = async (pid) => {
    const identity = await originalIdentity(pid)
    return pid === 31 && ++reads === 2 ? { ...identity, ppid: 1 } : identity
  }
  await assert.rejects(observeLinuxProcesses('controlled-run', context, world.io), (error) => error === world.permission)
  assert.deepEqual([...context.observed.keys()].sort(), ['30:130', '31:131'])
  assert.equal(context.observed.get('31:131').ppid, 1)
  assert.deepEqual(context.observed.get('31:131').historicalParentIdentities, [{ pid: 30, starttime: '130' }])
  const receipt = context.environmentDenials.get('31:131')
  assert.equal(receipt.before.ppid, 30)
  assert.equal(receipt.recheck.ppid, 1)
  assert.equal(receipt.guardReason, 'owned-or-marker-protected')
  assert.equal(context.terminalEnvironmentRechecks.size, 0)
  const signaled = []
  const contained = await containObservedIdentities(context.observed.values(), 'SIGTERM', Date.now() + 1000, {
    pidfdSignal: async (identity) => { signaled.push(identity.pid); return { result: 'signaled' } },
  })
  assert.deepEqual(signaled.sort(), [30, 31])
  assert.ok(contained.signals.every((signal) => signal.result === 'signaled'))
  assert.deepEqual(contained.errors, [])
})

test('Linux ancestry refuses a reused numeric parent and a child older than its newly marked parent', async () => {
  for (const marked of [false, true]) {
    const observed = new Map()
    collectOwnedIdentities([entry(30, '130', { runMarked: true })], observed, 30)
    collectOwnedIdentities([entry(30, '999', { runMarked: marked }), entry(31, '131', { ppid: 30 })], observed, 30)
    assert.equal(observed.has('31:131'), false)
    const signaled = []
    await containObservedIdentities(observed.values(), 'SIGTERM', Date.now() + 1000, {
      pidfdSignal: async (identity) => { signaled.push(`${identity.pid}:${identity.starttime}`); return { result: 'pid-recycled' } },
    })
    assert.equal(signaled.includes('31:131'), false)
    assert.equal(signaled.includes('30:999'), marked)
  }
})

test('Linux terminal permission handling rejects live, reused, uncertain UID and failed metadata rechecks with diagnostics', async () => {
  for (const scenario of ['live', 'reused', 'uid-changed', 'uid-unavailable', 'stat-eio', 'owner-eacces', 'environment-eio']) {
    const world = observationWorld(), context = await world.context()
    await observeLinuxProcesses('controlled-run', context, world.io)
    world.states.set(30, { ...entry(30, '130'), uid: 600 })
    const ioFailure = Object.assign(new Error('controlled metadata IO failure'), { code: 'EIO' })
    world.denied.set(30, scenario === 'environment-eio' ? ioFailure : world.permission)
    const originalIdentity = world.io.identity, originalOwner = world.io.owner
    let identityReads = 0, ownerReads = 0
    world.io.identity = async (pid) => {
      const identity = await originalIdentity(pid)
      if (pid !== 30 || ++identityReads !== 2) return identity
      if (scenario === 'stat-eio') throw ioFailure
      return { ...identity, state: scenario === 'live' ? 'S' : 'Z',
        starttime: scenario === 'reused' ? '999' : identity.starttime, ppid: 1 }
    }
    world.io.owner = async (pid) => {
      const owner = await originalOwner(pid)
      if (pid !== 30 || ++ownerReads !== 2) return owner
      if (scenario === 'owner-eacces') throw world.permission
      return { uid: scenario === 'uid-changed' ? 601 : scenario === 'uid-unavailable' ? undefined : owner.uid }
    }
    await assert.rejects(observeLinuxProcesses('controlled-run', context, world.io),
      (error) => error === (['stat-eio', 'environment-eio'].includes(scenario) ? ioFailure : world.permission), scenario)
    assert.equal(context.terminalEnvironmentRechecks.size, 0, scenario)
    assert.equal(context.exclusions.size, 0, scenario)
    assert.equal(context.observed.size, 0, 'rejected metadata must not adopt a process')
    const receipt = context.environmentDenials.get('30:130')
    assert.equal(receipt.before.pid, 30)
    assert.equal(receipt.before.starttime, '130')
    assert.equal(receipt.before.uid, 600)
    assert.ok(receipt.guardReason)
    assert.equal(Object.hasOwn(receipt, 'environment'), false)
    if (scenario === 'reused') assert.equal(receipt.recheck.starttime, '999')
    if (scenario === 'uid-unavailable') assert.equal(receipt.recheck.uid, null)
    if (scenario === 'owner-eacces') assert.equal(receipt.recheck.state, 'Z')
  }
})

test('Linux failed inventory preserves independently verified owned identities without granting terminality', async () => {
  for (const stage of ['metadata', 'environment']) {
    const world = observationWorld(), context = await world.context()
    await observeLinuxProcesses('controlled-run', context, world.io)
    for (const identity of [entry(30, '130'), entry(31, '131', { ppid: 30 }), entry(40, '140')]) {
      world.states.set(identity.pid, { ...identity, uid: 600 })
    }
    context.rootPid = 30
    world.environments.set(30, 'APOLLO_PERCEPTION_RUN_ID=controlled-run\0')
    const failure = Object.assign(new Error('controlled unrelated inventory failure'), { code: 'EIO' })
    if (stage === 'environment') world.denied.set(40, failure)
    else {
      const originalIdentity = world.io.identity
      world.io.identity = async (pid) => { if (pid === 40) throw failure; return originalIdentity(pid) }
    }
    await assert.rejects(observeLinuxProcesses('controlled-run', context, world.io), (error) => error === failure)
    assert.deepEqual([...context.observed.keys()].sort(), ['30:130', '31:131'])
    assert.equal(context.observed.get('31:131').state, 'S')
    assert.equal(context.terminalEnvironmentRechecks.size, 0)
    const signals = []
    const contained = await containObservedIdentities(context.observed.values(), 'SIGTERM', Date.now() + 1000, {
      pidfdSignal: async (identity) => { signals.push(identity.pid); return { result: 'signaled' } },
    })
    assert.deepEqual(signals.sort(), [30, 31])
    assert.ok(contained.signals.every((signal) => signal.result === 'signaled'), 'a signal must not claim terminality')
    assert.deepEqual(contained.errors, [])
  }
})

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

test('Linux stat failure diagnostics retain strict fifty-field guards and hashes without comm or raw field text', () => {
  const mutations = [
    [statText().split(' ').slice(0, -1).join(' '), 'FIELD_COUNT', 49],
    [statText({ 0: '?' }), 'STATE_FORMAT', 50],
    [statText({ 19: 'NaN' }), 'STARTTIME_FORMAT', 50],
    [statText({ 49: 'PRIVATE_FIELD' }), 'NUMERIC_FIELD_FORMAT', 50],
    [statText({ 1: '-1' }), 'PPID_FORMAT_OR_RANGE', 50],
    [statText({ 2: '9007199254740993' }), 'PGRP_FORMAT_OR_RANGE', 50],
    [statText({ 3: '9007199254740993' }), 'SESSION_FORMAT_OR_RANGE', 50],
  ]
  for (const [text, code, count] of mutations) {
    assert.throws(() => parseLinuxProcessStat(text), (error) => {
      assert.equal(error.code, 'ERR_ASSERTION'); assert.equal(error.message, 'Incomplete Linux process identity')
      assert.equal(createHash('sha256').update(error.message).digest('hex'), '17d566a82990cc222139b09fb17c33bf9bd3cb4977a59ccd6d4af40433f7f048')
      const facts = error.linuxStatDiagnostic
      assert.equal(facts.guardCode, code); assert.equal(facts.fieldCount, count); assert.equal(facts.minimumFieldCount, 50)
      assert.equal(facts.commFormat, 'valid-delimited'); assert.equal(facts.statBytes, Buffer.byteLength(text))
      assert.equal(facts.statSha256, createHash('sha256').update(text).digest('hex'))
      assert.equal(facts.statHashScope, 'complete'); assert.ok(facts.invalidNumericFieldNumbers.length <= 8)
      assert.doesNotMatch(JSON.stringify(facts), /PRIVATE_FIELD|worker|spaces|NaN/)
      return true
    })
  }
  for (const [text, code, format] of [[null, 'VALUE_TYPE', 'not-string'],
    [statText().replace('123 (', '123 ['), 'PID_PREFIX', 'invalid-prefix'],
    [statText().replace(')) S', '))S'), 'COMM_DELIMITER', 'invalid-delimiter']]) {
    assert.throws(() => parseLinuxProcessStat(text), (error) => {
      assert.equal(error.linuxStatDiagnostic.guardCode, code); assert.equal(error.linuxStatDiagnostic.commFormat, format)
      assert.equal(error.linuxStatDiagnostic.fieldCount, null); return true
    })
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
    const inconclusive = await run({ snapshot: async (runId, context) => {
      if (++observations === 3) throw new Error('controlled inventory failure')
      return linuxProcessSnapshot(runId, context)
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
