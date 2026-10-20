import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLEANUP_BUDGET_MS, attachSupervisorSignals, collectOwnedIdentities, containObservedIdentities, createPerceptionRunId,
  parseLinuxProcessStat, readLinuxProcessIdentity, requireJobBudget, signalObservedIdentity, linuxProcessSnapshot,
  supervisePerceptionCommand,
  createLinuxObservationContext, observeLinuxProcesses, sanitizeCommName,
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

// CI run 39353740559 attempt 1 (Dashboard "Build unprivileged CI pidfd addon"): pid 3324, a child born inside the build (parent 3322 marked, same
// uid), answered EACCES on /proc/<pid>/environ while it was state D, was state R at the recheck and was gone at the terminality read.
function bornChildWorld(reads) {
  const world = observationWorld()
  const environment = world.io.environment
  world.io.environment = async (pid) => { reads.set(pid, (reads.get(pid) ?? 0) + 1); return environment(pid) }
  world.io.comm = async (pid) => pid === 31 ? 'cc1' : null
  return world
}
async function spawnBornChild(world, context) {
  await observeLinuxProcesses('controlled-run', context, world.io)
  world.states.set(30, { ...entry(30, '130'), uid: 600 })
  world.states.set(31, { ...entry(31, '131', { ppid: 30, state: 'D' }), uid: 600 })
  context.rootPid = 30
  world.environments.set(30, 'APOLLO_PERCEPTION_RUN_ID=controlled-run\0')
  world.environments.set(31, 'APOLLO_PERCEPTION_RUN_ID=controlled-run\0')
}

test('Linux EACCES on a child born after the baseline that is mid-exec is re-read once it settles, and the child is observed as marked', async () => {
  const reads = new Map(), world = bornChildWorld(reads), context = await world.context()
  await spawnBornChild(world, context)
  let left = 2
  const environment = world.io.environment
  world.io.environment = async (pid) => { if (pid === 31 && left-- > 0) { reads.set(pid, (reads.get(pid) ?? 0) + 1); throw world.permission } return environment(pid) }
  const snapshot = await observeLinuxProcesses('controlled-run', context, world.io)
  assert.equal(reads.get(31), 3, 'two denials while the exec completes, then the read')
  assert.equal(snapshot.find((identity) => identity.pid === 31).runMarked, true)
  assert.equal(context.environmentDenials.size, 0, 'a settled read leaves no denial')
  assert.ok(context.observed.has('31:131'))
})

test('Linux EACCES on a born child that disappears while it is re-read is an absence, not a failure', async () => {
  const reads = new Map(), world = bornChildWorld(reads), context = await world.context()
  await spawnBornChild(world, context)
  const gone = Object.assign(new Error('gone'), { code: 'ENOENT' })
  const environment = world.io.environment
  world.io.environment = async (pid) => { if (pid === 31) { reads.set(pid, (reads.get(pid) ?? 0) + 1); throw reads.get(pid) === 1 ? world.permission : gone } return environment(pid) }
  const snapshot = await observeLinuxProcesses('controlled-run', context, world.io)
  assert.equal(snapshot.some((identity) => identity.pid === 31), false)
  assert.equal(context.environmentDenials.size, 0)
})

test('Linux EACCES that persists on a born, owned child is still a failure, and the receipt names the process and the reads', async () => {
  const reads = new Map(), world = bornChildWorld(reads), context = await world.context()
  await spawnBornChild(world, context)
  world.denied.set(31, world.permission)
  await assert.rejects(observeLinuxProcesses('controlled-run', context, world.io), (error) => error === world.permission)
  assert.equal(reads.get(31), 5, 'the first read and the bounded re-reads, no more')
  const receipt = context.environmentDenials.get('31:131')
  assert.equal(receipt.guardReason, 'owned-or-marker-protected')
  assert.equal(receipt.comm, 'cc1')
  assert.equal(receipt.environReads, 5)
  assert.equal(receipt.before.ppid, 30); assert.equal(receipt.before.uid, 600); assert.equal(receipt.before.state, 'D')
  assert.equal(receipt.recheck.uid, 600)
})

test('Linux EACCES on a peer of the frozen baseline keeps its single read (no re-read) and still carries its command name', async () => {
  const reads = new Map(), world = bornChildWorld(reads), context = await world.context()
  world.io.comm = async (pid) => pid === 20 ? 'runner-helper' : null
  world.denied.set(20, world.permission)
  await observeLinuxProcesses('controlled-run', context, world.io)
  assert.equal(reads.get(20), 1)
  assert.equal(context.exclusions.get('20:40').reason, 'environ-eacces-preexisting-before-owner-unrelated')
  const receipt = context.environmentDenials.get('20:40')
  assert.equal(receipt.guardReason, 'preexisting-exclusion-guards-confirmed')
  assert.deepEqual([receipt.comm, receipt.environReads], ['runner-helper', 1])
})

test('Linux the command name of a denied process is printable ASCII of at most 15 characters, else null', () => {
  assert.equal(sanitizeCommName('cc1\n'), 'cc1')
  assert.equal(sanitizeCommName('Web Content\n'), 'Web Content')
  for (const bad of ['', '\n', ' lead', 'has\nnewline', 'a'.repeat(16), 'tab\there', 'éclair', 'nul\u0000byte']) assert.equal(sanitizeCommName(bad), null, JSON.stringify(bad))
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

test('Linux unavailable task tuple remains a strict parser failure and only exact complete facts are classified', () => {
  const sentinel = { 1: '0', 2: '-1', 3: '-1' }
  const text = statText(sentinel)
  assert.throws(() => parseLinuxProcessStat(text), (error) => {
    assert.equal(error.code, 'ERR_ASSERTION'); assert.equal(error.message, 'Incomplete Linux process identity')
    assert.equal(error.linuxStatDiagnostic.guardCode, 'PGRP_FORMAT_OR_RANGE')
    assert.deepEqual(error.linuxStatDiagnostic.numericAncestry, { ppid: 0, processGroupId: -1, sessionId: -1 })
    assert.deepEqual(error.linuxStatDiagnostic.unavailableObservation, {
      schemaVersion: 'linux-task-sighand-unavailable/v1', pid: 123, state: 'S', starttime: '987654321987654321',
      ppid: 0, processGroupId: -1, sessionId: -1, identityEstablished: false, terminalityEstablished: false,
    })
    assert.doesNotMatch(JSON.stringify(error.linuxStatDiagnostic), /worker|spaces|commline|environ/)
    return true
  })
  for (const value of [statText({ ...sentinel, 1: '1' }), statText({ ...sentinel, 2: '-2' }),
    statText({ ...sentinel, 3: '-2' }), statText({ ...sentinel, 0: '?' }),
    statText({ ...sentinel, 19: '-1' }), statText({ ...sentinel, 49: 'PRIVATE_FIELD' }),
    statText(sentinel).split(' ').slice(0, -1).join(' '), statText({ ...sentinel, 1: '00' }),
    statText({ ...sentinel, 2: '-01' }), statText(sentinel).replace('123 (', '9007199254740993 (')]) {
    assert.throws(() => parseLinuxProcessStat(value), (error) => {
      assert.equal(error.linuxStatDiagnostic.unavailableObservation, null); return true
    })
  }
})

// CI job 118192911424: a task caught mid-exit answers /proc/<pid>/stat with the
// sighand-unavailable tuple. Every single-shot identity read (supervisor snapshot,
// terminality polls, birth rechecks) goes through readLinuxProcessIdentity.
const dyingStat = (pid, starttime = '40', changes = {}) =>
  statText({ 1: '0', 2: '-1', 3: '-1', 19: starttime, ...changes }).replace('123 (', `${pid} (`)
const liveStat = (pid, starttime = '40', changes = {}) =>
  statText({ 19: starttime, ...changes }).replace('123 (', `${pid} (`)
const goneError = (code = 'ENOENT') => Object.assign(new Error('PRIVATE_GONE'), { code })
function procStatIo(...answers) {
  const calls = []
  return { calls, async readFile(path, options) {
    calls.push({ path, options })
    const answer = answers[calls.length - 1]
    assert.notEqual(answer, undefined, 'No read beyond the single bounded re-read')
    if (answer instanceof Error) throw answer
    return answer
  } }
}

test('Linux stat read of a task caught mid-exit gets ONE bounded re-read: gone is absent, a strict same-identity stat is returned', async () => {
  const expected = { pid: 20, state: 'S', ppid: 2, processGroupId: 3, sessionId: 4, starttime: '40' }
  for (const code of ['ENOENT', 'ESRCH']) {
    const io = procStatIo(dyingStat(20), goneError(code))
    assert.equal(await readLinuxProcessIdentity(20, io), null)
    assert.deepEqual(io.calls.map((call) => call.path), ['/proc/20/stat', '/proc/20/stat'])
    assert.equal(io.calls[0].options, 'utf8', 'The first read is unchanged')
    assert.equal(io.calls[1].options.encoding, 'utf8'); assert.ok(io.calls[1].options.signal instanceof AbortSignal)
  }
  const io = procStatIo(dyingStat(20), liveStat(20))
  assert.deepEqual(await readLinuxProcessIdentity(20, io), expected)
  assert.equal(io.calls.length, 2)
  // First-sight behaviour without a sentinel is untouched: one read.
  const missing = procStatIo(goneError())
  assert.equal(await readLinuxProcessIdentity(20, missing), null); assert.equal(missing.calls.length, 1)
  const live = procStatIo(liveStat(20))
  assert.deepEqual(await readLinuxProcessIdentity(20, live), expected); assert.equal(live.calls.length, 1)
})

test('Linux stat re-read that is still the sentinel, mismatched, malformed, denied or late fails closed with the INITIAL error', async (t) => {
  let wall = 1000, mono = 100.125, initial
  t.mock.method(Date, 'now', () => wall)
  t.mock.method(performance, 'now', () => mono)
  try { parseLinuxProcessStat(dyingStat(20)) } catch (error) { initial = error }
  const denied = Object.assign(new Error('PRIVATE_DENIAL'), { code: 'EACCES' })
  for (const [name, answer, advance] of [
    ['sentinel again', dyingStat(20)], ['sentinel again with the exit state', dyingStat(20, '40', { 0: 'X' })],
    ['starttime changed', liveStat(20, '41')], ['other pid', liveStat(21)],
    ['malformed', liveStat(20).split(' ').slice(0, -1).join(' ')], ['denied', denied],
    ['wall at the exact 500 ms cap', liveStat(20), () => { wall = 1500 }],
    ['wall past the cap', liveStat(20), () => { wall = 1501 }],
    ['monotonic at the exact cap', liveStat(20), () => { mono = 600.125 }],
    ['wall clock rollback', liveStat(20), () => { wall = 999 }]]) {
    wall = 1000; mono = 100.125
    const io = procStatIo(initial, answer), read = io.readFile
    io.readFile = async (path, options) => { const value = await read(path, options); if (io.calls.length === 2) advance?.(); return value }
    await assert.rejects(readLinuxProcessIdentity(20, io), (error) => {
      assert.equal(error, initial, name); assert.equal(error.message, 'Incomplete Linux process identity')
      const facts = error.linuxStatRecheckDiagnostic
      assert.equal(facts.schemaVersion, 'linux-stat-unavailable-recheck/v1'); assert.equal(facts.requestedPid, 20)
      assert.equal(facts.allocatedMs, 500); assert.equal(facts.outcome, 'inconclusive', name)
      assert.equal(facts.terminalityEstablished, false)
      if (name.startsWith('sentinel again')) assert.equal(facts.recheckStatDiagnostic.unavailableObservation.identityEstablished, false)
      assert.doesNotMatch(JSON.stringify(facts), /PRIVATE_DENIAL|worker|spaces/)
      return true
    }, name)
    assert.equal(io.calls.length, 2, name + ': exactly one re-read')
    delete initial.linuxStatRecheckDiagnostic
  }
})

test('Linux stat sentinel of another PID, a non-exact tuple, a malformed or denied first read is never re-read', async () => {
  const denied = Object.assign(new Error('PRIVATE_DENIAL'), { code: 'EACCES' })
  for (const [answer, message] of [
    [dyingStat(21), 'Incomplete Linux process identity'], [dyingStat(20, '40', { 3: '-2' }), 'Incomplete Linux process identity'],
    [dyingStat(20, '40', { 1: '1' }), 'Incomplete Linux process identity'],
    [liveStat(20).split(' ').slice(0, -1).join(' '), 'Incomplete Linux process identity'],
    [liveStat(21), 'Linux stat PID mismatch'], [denied, 'PRIVATE_DENIAL']]) {
    const io = procStatIo(answer, liveStat(20))
    await assert.rejects(readLinuxProcessIdentity(20, io), (error) => {
      assert.ok(error.message.startsWith(message), error.message)
      assert.equal(error.linuxStatRecheckDiagnostic, undefined, 'No recheck was attempted'); return true
    })
    assert.equal(io.calls.length, 1, message + ': exactly one read')
  }
})

test('mid-exit sentinel no longer breaks the supervisor /proc snapshot or terminal verification, while a persistent one still fails closed', async () => {
  for (const [answers, absent] of [[[dyingStat(20), goneError()], true], [[dyingStat(20), dyingStat(20)], false]]) {
    const world = observationWorld(), baseIdentity = world.io.identity, dying = procStatIo(...answers)
    world.io.identity = async (pid) => pid === 20 ? readLinuxProcessIdentity(20, dying) : baseIdentity(pid)
    const context = await world.context()
    if (absent) {
      const snapshot = await observeLinuxProcesses('controlled-run', context, world.io)
      assert.equal(snapshot.some((identity) => identity.pid === 20), false)
      assert.equal(context.baseline.has('20:40'), false); assert.equal(context.baseline.has('100:100'), true)
    } else await assert.rejects(observeLinuxProcesses('controlled-run', context, world.io), /Incomplete metadata inventory/)
    assert.equal(dying.calls.length, 2)
  }
  const owned = entry(20, '40'), lookupRace = async () => ({ result: 'lookup-race' })
  assert.equal((await signalObservedIdentity(owned, 'SIGKILL', { pidfdSignal: lookupRace,
    readIdentity: (pid) => readLinuxProcessIdentity(pid, procStatIo(dyingStat(20), goneError())) })).result, 'absent')
  await assert.rejects(signalObservedIdentity(owned, 'SIGKILL', { pidfdSignal: lookupRace,
    readIdentity: (pid) => readLinuxProcessIdentity(pid, procStatIo(dyingStat(20), dyingStat(20))) }), /Incomplete Linux process identity/)
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

function controlledReportsHaveClosedAdmittedChildren(reports, preAdmission) {
  if (!Array.isArray(reports) || reports.length === 0 ||
      reports.some((report) => !report || typeof report.runId !== 'string' || report.runId.length === 0) ||
      new Set(reports.map((report) => report.runId)).size !== reports.length) return false
  if (preAdmission && (preAdmission.case !== 'cancel-before-child-admission' || preAdmission.signal !== 'SIGTERM' ||
      typeof preAdmission.runId !== 'string' || preAdmission.runId.length === 0 ||
      reports.filter((report) => report === preAdmission.report).length !== 1 ||
      reports.filter((report) => report.runId === preAdmission.runId).length !== 1)) return false
  return reports.every((report) => {
    if (!report || !Array.isArray(report.observedProcesses)) return false
    if (report === preAdmission?.report) {
      return report.runId === preAdmission.runId && report.rootPid === undefined &&
        report.observedProcesses.length === 0 && report.childCloseObserved === false && report.childClosed === true &&
        report.success === false && report.observationComplete === true && report.inventoryInconclusive === false &&
        Array.isArray(report.activeSurvivors) && report.activeSurvivors.length === 0 &&
        Array.isArray(report.cleanupErrors) && report.cleanupErrors.length === 0 &&
        typeof report.error === 'string' && report.error.split(/\r?\n/, 1)[0] === 'Error: Perception supervisor received SIGTERM'
    }
    return Number.isSafeInteger(report.rootPid) && report.rootPid > 0 && report.childCloseObserved === true
  })
}

test('controlled cleanup distinguishes its registered pre-admission rejection from admitted ChildProcess close', () => {
  const cancelled = { runId: 'controlled-pre-admission', rootPid: undefined, observedProcesses: [],
    childCloseObserved: false, childClosed: true, success: false, observationComplete: true,
    inventoryInconclusive: false, activeSurvivors: [], cleanupErrors: [],
    error: 'Error: Perception supervisor received SIGTERM\n    at controlled-test' }
  const registration = { case: 'cancel-before-child-admission', signal: 'SIGTERM', runId: cancelled.runId, report: cancelled }
  const admitted = { runId: 'controlled-admitted', rootPid: 123, observedProcesses: [entry(123, '123')],
    childCloseObserved: true, processTreeTerminal: false, inventoryInconclusive: true }
  assert.equal(controlledReportsHaveClosedAdmittedChildren([admitted, cancelled], registration), true)
  assert.equal(cancelled.childCloseObserved, false, 'A no-child case never fabricates a close event')
  assert.equal(admitted.processTreeTerminal, false, 'Close aggregation never upgrades an inconclusive tree')
  assert.equal(admitted.inventoryInconclusive, true)
  assert.equal(controlledReportsHaveClosedAdmittedChildren([admitted]), true)
  assert.equal(controlledReportsHaveClosedAdmittedChildren([admitted, cancelled]), false)
  assert.equal(controlledReportsHaveClosedAdmittedChildren([admitted, { ...cancelled }], registration), false)
  assert.equal(controlledReportsHaveClosedAdmittedChildren([admitted, cancelled], { ...registration, runId: 'wrong-run' }), false)
  assert.equal(controlledReportsHaveClosedAdmittedChildren([admitted, cancelled, cancelled], registration), false)
})

test('controlled cleanup rejects unknown no-root reports, admitted children without close and contradictory cancellation facts', () => {
  const cancelled = { runId: 'controlled-pre-admission', observedProcesses: [], childCloseObserved: false,
    childClosed: true, success: false, observationComplete: true, inventoryInconclusive: false,
    activeSurvivors: [], cleanupErrors: [], error: 'Error: Perception supervisor received SIGTERM' }
  for (const changed of [{ rootPid: 123 }, { rootPid: null }, { observedProcesses: [entry(123, '123')] },
      { childCloseObserved: true }, { childClosed: false }, { success: true }, { observationComplete: false },
      { inventoryInconclusive: true }, { cleanupErrors: ['controlled error'] }, { activeSurvivors: [entry(123, '123')] },
      { error: 'Error: controlled inventory failure' }]) {
    const report = { ...cancelled, ...changed }
    assert.equal(controlledReportsHaveClosedAdmittedChildren([report], {
      case: 'cancel-before-child-admission', signal: 'SIGTERM', runId: report.runId, report }), false, JSON.stringify(changed))
  }
  for (const report of [null, { rootPid: 123, observedProcesses: [], childCloseObserved: true },
      { runId: 'unknown', observedProcesses: [], childCloseObserved: true },
      { runId: 'admitted', rootPid: 123, observedProcesses: [entry(123, '123')], childCloseObserved: false },
      { runId: 'unknown', rootPid: null, observedProcesses: [], childCloseObserved: true }]) {
    assert.equal(controlledReportsHaveClosedAdmittedChildren([report]), false)
  }
  assert.equal(controlledReportsHaveClosedAdmittedChildren([]), false)
})

test('Linux owned cleanup proves close and terminal identities for setsid, timeout, signals and observation failure', {
  skip: process.platform !== 'linux', timeout: 90_000,
}, async (t) => {
  // Explicit setsid is confined to this controlled test. The real owner spawn
  // retains normal parentage and inherits a unique run marker.
  const root = await mkdtemp(join(tmpdir(), 'apollo-perception-supervisor-'))
  const reports = [], pidPath = join(root, 'setsid-pid')
  let primaryError, preAdmissionCancellation
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

    {
      const emitter = new EventEmitter(), controller = new AbortController(), interruption = {}
      const remove = attachSupervisorSignals(controller, interruption, emitter)
      try {
        emitter.emit('SIGTERM')
        const cancelled = await run({ signal: controller.signal })
        preAdmissionCancellation = { case: 'cancel-before-child-admission', signal: 'SIGTERM',
          runId: cancelled.runId, report: cancelled }
        t.diagnostic(JSON.stringify({ scope: 'controlled-cancel-before-child-admission', rootPid: cancelled.rootPid ?? null,
          observedIdentities: cancelled.observedProcesses.length, childCloseObserved: cancelled.childCloseObserved }))
        assert.equal(interruption.interruptedBy, 'SIGTERM'); assert.match(cancelled.error, /SIGTERM/)
        assert.equal(cancelled.success, false); assert.equal(cancelled.rootPid, undefined)
        assert.deepEqual(cancelled.observedProcesses, []); assert.equal(cancelled.childCloseObserved, false)
        assert.equal(cancelled.childClosed, true, 'No child existed; this is not a close event')
        assert.deepEqual(cancelled.activeSurvivors, [])
      } finally { remove() }
    }

    for (const name of ['SIGINT', 'SIGTERM']) {
      const emitter = new EventEmitter(), controller = new AbortController(), interruption = {}
      const remove = attachSupervisorSignals(controller, interruption, emitter)
      const admissionDeadlineAt = Date.now() + 1500
      let release
      try {
        const interrupted = await run({ signal: controller.signal, snapshot: async (runId, context) => {
          const entries = await linuxProcessSnapshot(runId, context)
          const root = context.rootPid === undefined ? undefined : entries.find((identity) => identity.pid === context.rootPid &&
            !['Z', 'X', 'x'].includes(identity.state))
          const owned = root && context.observed.get(root.pid + ':' + root.starttime)
          if (!release && root && owned) {
            assert.equal(root.ppid, process.pid); assert.equal(owned.starttime, root.starttime)
            assert.equal(owned.ownership, 'spawn+run-id')
            const releasedAt = Date.now()
            assert.ok(releasedAt < admissionDeadlineAt, 'Signal fixture must observe the real admitted child within the original 1500ms')
            release = { scope: 'after-real-owned-child-snapshot', runId, pid: root.pid, starttime: root.starttime,
              ppid: root.ppid, releasedAt, admissionDeadlineAt, signal: name }
            emitter.emit(name)
          }
          return entries
        } })
        t.diagnostic(JSON.stringify({ controlledSignalRelease: release ?? null, rootPid: interrupted.rootPid ?? null,
          childCloseObserved: interrupted.childCloseObserved }))
        assert.ok(release, 'Signal cannot be released by elapsed time before child admission')
        assert.equal(interrupted.rootPid, release.pid)
        assert.ok(interrupted.observedProcesses.some((identity) => identity.pid === release.pid && identity.starttime === release.starttime))
        assert.equal(interruption.interruptedBy, name)
        assert.equal(interrupted.success, false)
        await requireTerminal(interrupted)
      } finally { remove() }
    }

    let observations = 0
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
        controlledReportsHaveClosedAdmittedChildren(reports, preAdmissionCancellation)
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
