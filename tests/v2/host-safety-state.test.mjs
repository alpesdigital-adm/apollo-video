import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { evaluateHostSafety, resolveHostSafetyPolicy } from '../../src/v2/infrastructure/host-safety/policy.ts'
import {
  OPS_GATE_SCHEMA_VERSION,
  readGateForDeploy,
  removeGateFile,
  writeGateFile,
} from '../../src/v2/infrastructure/host-safety/gate-file.ts'
import {
  OPS_LATCH_SCHEMA_VERSION,
  engageLatch,
  readLatch,
  releaseLatch,
} from '../../src/v2/infrastructure/host-safety/latch.ts'
import {
  OPS_LOCK_ORPHAN_AFTER_MS,
  OPS_LOCK_SCHEMA_VERSION,
  acquireOperationLock,
  readLockOwner,
  releaseOperationLock,
} from '../../src/v2/infrastructure/host-safety/lock.ts'
import {
  assertJournalDataCarriesNoSecret,
  createOperationJournal,
  journalPath,
  readJournalLines,
  readMonitorSamples,
} from '../../src/v2/infrastructure/host-safety/journal.ts'

const repositoryRoot = resolve(import.meta.dirname, '..', '..')
const opsStateFixtures = resolve(import.meta.dirname, '..', 'fixtures', 'ops-state')
const catalog = JSON.parse(await readFile(resolve(repositoryRoot, 'config/host-safety-policy.json'), 'utf8'))
const policy = resolveHostSafetyPolicy({ catalog, profile: 'isolated-ci' }).policy
const BOOT_ID = '7f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f'

async function stateDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'apollo-ops-state-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

function owner(overrides = {}) {
  return {
    runId: 'deploy-20260918T2359Z-ab12',
    pid: process.pid,
    startedAtIso: '2026-09-18T23:59:00.000Z',
    bootId: BOOT_ID,
    command: 'deploy',
    hostname: 'test-host',
    ...overrides,
  }
}

const gateInput = (stateDir, overrides = {}) => ({
  stateDir,
  state: 'open',
  reasons: [],
  seq: 1,
  issuedAtIso: '2026-09-18T23:59:10.000Z',
  issuedAtMonotonicMs: 1_000_000,
  ttlMs: 30_000,
  owner: { runId: 'run-1', kind: 'monitor', pid: 4242 },
  ...overrides,
})

test('a gate decision is written atomically and leaves no temporary file behind', async (t) => {
  const stateDir = await stateDirectory(t)
  const document = await writeGateFile(gateInput(stateDir))
  assert.equal(document.schemaVersion, OPS_GATE_SCHEMA_VERSION)
  const entries = await readdir(stateDir)
  assert.deepEqual(entries, ['gate.json'], 'a rename-based write leaves only the final name')
  const written = JSON.parse(await readFile(join(stateDir, 'gate.json'), 'utf8'))
  assert.equal(written.seq, 1)
  assert.deepEqual(written.reasons, [])

  // A closed decision keeps its reasons; an open one can never carry any.
  await writeGateFile(gateInput(stateDir, { state: 'closed', reasons: ['steal'], seq: 2 }))
  assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'gate.json'), 'utf8')).reasons, ['steal'])
  await writeGateFile(gateInput(stateDir, { state: 'open', reasons: ['steal'], seq: 3 }))
  assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'gate.json'), 'utf8')).reasons, [])

  await assert.rejects(() => writeGateFile(gateInput(stateDir, { seq: 0 })), /seq/)
  await assert.rejects(() => writeGateFile(gateInput(stateDir, { ttlMs: 0 })), /ttlMs/)
})

test('the deploy refuses an absent, stale, frozen, closed or undecodable gate', async (t) => {
  const stateDir = await stateDirectory(t)
  const base = { stateDir, maximumDecisionAgeMs: 20_000 }

  const finished = await readGateForDeploy({ ...base, nowMonotonicMs: 1_000_000 })
  assert.equal(finished.admit, true, 'no gate file means no supervised operation is in flight')
  const inFlight = await readGateForDeploy({ ...base, nowMonotonicMs: 1_000_000, requirePresent: true })
  assert.deepEqual(inFlight.reasons, ['gate-absent'])

  await writeGateFile(gateInput(stateDir, { seq: 7 }))
  const fresh = await readGateForDeploy({ ...base, nowMonotonicMs: 1_005_000, requirePresent: true, lastSeenSeq: 6 })
  assert.equal(fresh.admit, true)
  assert.equal(fresh.ageMs, 5_000)

  const tooOld = await readGateForDeploy({ ...base, nowMonotonicMs: 1_020_001, requirePresent: true })
  assert.deepEqual(tooOld.reasons, ['gate-decision-too-old'])
  const stale = await readGateForDeploy({ ...base, nowMonotonicMs: 1_040_000, requirePresent: true })
  assert.deepEqual(stale.reasons, ['stale-gate', 'gate-decision-too-old'])
  const backwards = await readGateForDeploy({ ...base, nowMonotonicMs: 999_999, requirePresent: true })
  assert.deepEqual(backwards.reasons, ['gate-clock-reset'])
  // A monitor that hung republishes nothing: mtime looks recent, seq does not move.
  const frozen = await readGateForDeploy({ ...base, nowMonotonicMs: 1_005_000, requirePresent: true, lastSeenSeq: 7 })
  assert.deepEqual(frozen.reasons, ['gate-seq-not-advancing'])

  await writeGateFile(gateInput(stateDir, { state: 'closed', reasons: ['cpu-busy-peak', 'steal'], seq: 8 }))
  const closed = await readGateForDeploy({ ...base, nowMonotonicMs: 1_005_000, requirePresent: true })
  assert.deepEqual(closed.reasons, ['cpu-busy-peak', 'steal'])

  await writeFile(join(stateDir, 'gate.json'), '{ not json', 'utf8')
  const unreadable = await readGateForDeploy({ ...base, nowMonotonicMs: 1_005_000, requirePresent: true })
  assert.match(unreadable.reasons[0], /^gate-unreadable/)

  await writeFile(join(stateDir, 'gate.json'), JSON.stringify({ schemaVersion: 'apollo-ops-gate/v2', state: 'open' }), 'utf8')
  const malformed = await readGateForDeploy({ ...base, nowMonotonicMs: 1_005_000, requirePresent: true })
  assert.deepEqual(malformed.reasons, ['gate-malformed'])

  await removeGateFile(stateDir)
  assert.deepEqual(await readdir(stateDir), [])
  await removeGateFile(stateDir)
})

test('the published gate fixtures are exactly what the reader accepts', async (t) => {
  const stateDir = await stateDirectory(t)
  for (const [fixture, expected] of [
    ['gate-open.json', { admit: true, seq: 43 }],
    ['gate-closed.json', { admit: false, seq: 42 }],
  ]) {
    await copyFile(join(opsStateFixtures, fixture), join(stateDir, 'gate.json'))
    const decision = await readGateForDeploy({
      stateDir,
      nowMonotonicMs: JSON.parse(await readFile(join(stateDir, 'gate.json'), 'utf8')).issuedAtMonotonicMs + 1_000,
      maximumDecisionAgeMs: 20_000,
      requirePresent: true,
    })
    assert.equal(decision.admit, expected.admit, fixture)
    assert.equal(decision.document.seq, expected.seq, fixture)
  }
  const latchFixture = JSON.parse(await readFile(join(opsStateFixtures, 'latch.json'), 'utf8'))
  assert.equal(latchFixture.schemaVersion, OPS_LATCH_SCHEMA_VERSION)
  const lockFixture = JSON.parse(await readFile(join(opsStateFixtures, 'lock-owner.json'), 'utf8'))
  assert.equal(lockFixture.schemaVersion, OPS_LOCK_SCHEMA_VERSION)
})

test('a latch survives a restart, keeps the first cause and is archived instead of deleted', async (t) => {
  const stateDir = await stateDirectory(t)
  assert.deepEqual(await readLatch(stateDir), { engaged: false })

  const engaged = await engageLatch({
    stateDir,
    runId: 'run-1',
    reason: 'stop-timeout',
    detail: 'docker stop apollo-video-render-worker did not reach a terminal state within 30s',
    evidence: { journal: 'journal/run-1.ndjson', lastSampleSeq: 41 },
    engagedAtIso: '2026-09-18T23:59:20.000Z',
  })
  assert.equal(engaged.alreadyEngaged, false)

  // A second failure must not overwrite the evidence of the first one.
  const again = await engageLatch({
    stateDir,
    runId: 'run-2',
    reason: 'readback-mismatch',
    detail: 'a later failure',
    evidence: { journal: 'journal/run-2.ndjson', lastSampleSeq: 99 },
    engagedAtIso: '2026-09-19T00:10:00.000Z',
  })
  assert.equal(again.alreadyEngaged, true)
  assert.equal(again.engaged.reason, 'stop-timeout')

  // Reading it again is what a restarted process does: the latch is on the host.
  const afterRestart = await readLatch(stateDir)
  assert.equal(afterRestart.engaged, true)
  assert.equal(afterRestart.document.runId, 'run-1')
  const stillClosed = evaluateHostSafety({ samples: [], nowMonotonicMs: 1, policy, phase: 'preflight', latchEngaged: afterRestart.engaged })
  assert.ok(stillClosed.reasons.includes('latch-engaged'))

  assert.deepEqual(await releaseLatch({ stateDir, reason: '   ', releasedAtIso: '2026-09-19T00:20:00.000Z' }), {
    released: false,
    error: 'a release requires the operator reason',
  })
  const released = await releaseLatch({
    stateDir,
    reason: 'owner authorised the resume after the host recovered',
    releasedAtIso: '2026-09-19T00:20:00.000Z',
    operator: 'owner',
  })
  assert.equal(released.released, true)
  assert.deepEqual(await readLatch(stateDir), { engaged: false })
  const archived = JSON.parse(await readFile(released.archivedAt, 'utf8'))
  assert.equal(archived.reason, 'stop-timeout')
  assert.equal(archived.releasedAtIso, '2026-09-19T00:20:00.000Z')
  assert.equal(archived.releaseReason, 'owner authorised the resume after the host recovered')
  const journalEntries = await readdir(join(stateDir, 'journal'))
  assert.ok(journalEntries.some((entry) => entry.endsWith('.released.json')))
  assert.ok(journalEntries.some((entry) => entry.endsWith('.released.json.source')), 'the original document is kept, never removed')

  assert.equal((await releaseLatch({ stateDir, reason: 'nothing to release', releasedAtIso: 'x' })).released, false)
})

test('a latch that cannot be parsed counts as engaged and can still be released', async (t) => {
  const stateDir = await stateDirectory(t)
  await writeFile(join(stateDir, 'latch.json'), 'not json at all', 'utf8')
  const corrupt = await readLatch(stateDir)
  assert.equal(corrupt.engaged, true)
  assert.equal(corrupt.document, null)

  await writeFile(join(stateDir, 'latch.json'), JSON.stringify({ schemaVersion: 'apollo-ops-latch/v2' }), 'utf8')
  assert.equal((await readLatch(stateDir)).engaged, true)

  const released = await releaseLatch({ stateDir, reason: 'corrupt latch cleared by the operator', releasedAtIso: '2026-09-19T00:30:00.000Z' })
  assert.equal(released.released, true)
  assert.equal((await readLatch(stateDir)).engaged, false)
})

test('five minutes of stability are required after a release, and cannot be faked by sample count', async (t) => {
  const stateDir = await stateDirectory(t)
  const base = 5_000_000
  const sample = (index) => ({
    seq: index + 1,
    monotonicMs: base + index * policy.observation.sampleIntervalMs,
    capturedAtIso: '2026-09-19T00:40:00.000Z',
    cpu: { busy: 0.05, steal: 0.01, iowait: 0.01 },
    hostCpus: 4,
    load1: 0.5,
    memoryAvailableBytes: 8 * 1024 ** 3,
    oom: { total: 0, sinceRunStart: 0, lastIncreaseMonotonicMs: null },
    postgres: { connections: 4, maxConnections: 100, backendsByApplicationName: {} },
    health: { ok: true, statusCode: 200, latencyMs: 12, error: null },
  })
  const thirty = Array.from({ length: 30 }, (unused, index) => sample(index))
  const now = thirty[29].monotonicMs + 1_000
  assert.equal(evaluateHostSafety({ samples: thirty, nowMonotonicMs: now, policy, phase: 'stability' }).admit, true)
  assert.ok(
    evaluateHostSafety({ samples: thirty.slice(0, 29), nowMonotonicMs: thirty[28].monotonicMs + 1_000, policy, phase: 'stability' }).reasons.includes(
      'window-incomplete',
    ),
  )
  // Thirty samples one second apart are still thirty samples and still not 300s.
  const crowded = Array.from({ length: 30 }, (unused, index) => ({ ...sample(index), monotonicMs: base + index * 1_000 }))
  assert.ok(
    evaluateHostSafety({ samples: crowded, nowMonotonicMs: base + 30_000, policy, phase: 'stability' }).reasons.includes('window-incomplete'),
  )
  await rm(stateDir, { recursive: true, force: true })
})

test('exactly one of two concurrent acquirers gets the lock', async (t) => {
  const stateDir = await stateDirectory(t)
  const attempt = (runId) =>
    acquireOperationLock({
      stateDir,
      owner: owner({ runId }),
      currentBootId: BOOT_ID,
      nowMs: Date.parse('2026-09-18T23:59:01.000Z'),
      processExists: () => true,
    })
  const [first, second] = await Promise.all([attempt('run-a'), attempt('run-b')])
  const winners = [first, second].filter((result) => result.acquired)
  const losers = [first, second].filter((result) => !result.acquired)
  assert.equal(winners.length, 1)
  assert.equal(losers.length, 1)
  assert.match(losers[0].reason, /^lock-held/)
  const held = await readLockOwner(stateDir)
  assert.equal(held.owner.runId, winners[0].owner.runId)

  // A third attempt is refused with the identity of the holder, not a timeout.
  const third = await attempt('run-c')
  assert.equal(third.acquired, false)
  assert.ok(third.holderDescription.includes(winners[0].owner.runId))
  assert.ok(third.holderDescription.includes(String(process.pid)))
})

test('a lock is an orphan by identity, never by age alone', async (t) => {
  const stateDir = await stateDirectory(t)
  const startedAtMs = Date.parse('2026-09-18T23:00:00.000Z')
  const acquireAs = (runId, options) =>
    acquireOperationLock({
      stateDir,
      owner: owner({ runId, startedAtIso: new Date(startedAtMs).toISOString() }),
      currentBootId: options.currentBootId ?? BOOT_ID,
      nowMs: options.nowMs,
      processExists: options.processExists,
    })

  assert.equal((await acquireAs('holder', { nowMs: startedAtMs, processExists: () => true })).acquired, true)

  // Hours old, but the PID is alive: that is a slow operation, not an orphan.
  const alive = await acquireAs('challenger', { nowMs: startedAtMs + 10 * 3_600_000, processExists: () => true })
  assert.equal(alive.acquired, false)
  assert.equal(alive.reason, 'lock-held')

  // PID gone but still inside the grace window: refuse, do not race the fork.
  const young = await acquireAs('challenger', { nowMs: startedAtMs + OPS_LOCK_ORPHAN_AFTER_MS, processExists: () => false })
  assert.equal(young.acquired, false)
  assert.equal(young.reason, 'lock-held-recently-by-a-gone-pid')

  const orphan = await acquireAs('challenger', { nowMs: startedAtMs + OPS_LOCK_ORPHAN_AFTER_MS + 1, processExists: () => false })
  assert.equal(orphan.acquired, true)
  assert.ok(orphan.tookOverOrphan.endsWith('lock-holder.orphaned.json'))
  const archived = JSON.parse(await readFile(orphan.tookOverOrphan, 'utf8'))
  assert.equal(archived.orphanedBecause, 'pid-absent-and-older-than-grace')
  assert.equal(archived.runId, 'holder')

  // A different boot id means no process of that run can exist, alive PID or not.
  await releaseOperationLock({ stateDir, runId: 'challenger' })
  assert.equal((await acquireAs('holder', { nowMs: startedAtMs, processExists: () => true })).acquired, true)
  const rebooted = await acquireAs('after-reboot', {
    nowMs: startedAtMs + 1_000,
    processExists: () => true,
    currentBootId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
  })
  assert.equal(rebooted.acquired, true)
  assert.equal(JSON.parse(await readFile(rebooted.tookOverOrphan, 'utf8')).orphanedBecause, 'different-boot-id')
})

test('an owner file that is still being written is held, never an orphan', async (t) => {
  const stateDir = await stateDirectory(t)
  const startedAtMs = Date.parse('2026-09-18T23:00:00.000Z')
  const attempt = (contents) =>
    writeFile(join(stateDir, 'lock', 'owner.json'), contents, 'utf8').then(() =>
      acquireOperationLock({
        stateDir,
        owner: owner({ runId: 'challenger' }),
        // Everything here argues FOR taking over: a different boot, a dead pid, and a
        // start far outside the grace window. The only thing that must stop it is that
        // the owner cannot be read.
        currentBootId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
        nowMs: startedAtMs + 10 * 3_600_000,
        processExists: () => false,
        ownerReadAttempts: 2,
        delay: async () => {},
      }),
    )
  await mkdir(join(stateDir, 'lock'), { recursive: true })

  for (const [description, contents] of [
    ['empty', ''],
    ['half written', '{\n  "schemaVersion": "apollo-ops-lock/v1",\n  "runId": "deploy-2026'],
    ['no bootId', JSON.stringify({ schemaVersion: 'apollo-ops-lock/v1', runId: 'r', pid: 5, startedAtIso: '2026-09-18T23:00:00.000Z' })],
    ['no pid', JSON.stringify({ schemaVersion: 'apollo-ops-lock/v1', runId: 'r', bootId: BOOT_ID, startedAtIso: '2026-09-18T23:00:00.000Z' })],
    ['no runId', JSON.stringify({ schemaVersion: 'apollo-ops-lock/v1', pid: 5, bootId: BOOT_ID, startedAtIso: '2026-09-18T23:00:00.000Z' })],
  ]) {
    const result = await attempt(contents)
    assert.equal(result.acquired, false, `an ${description} owner.json was taken over`)
    assert.equal(result.reason, 'lock-held-by-unknown-owner')
    assert.match(result.holderDescription, /still being written; it is never treated as an orphan/)
  }
  // The journal must not contain an orphan record: nothing was taken over.
  await assert.rejects(() => readdir(join(stateDir, 'journal')), /ENOENT/)

  // A complete owner with the same evidence IS an orphan, so the refusal above is about
  // readability and not about some other precondition failing.
  await writeFile(
    join(stateDir, 'lock', 'owner.json'),
    JSON.stringify({ ...owner({ runId: 'complete' }), schemaVersion: 'apollo-ops-lock/v1' }),
    'utf8',
  )
  const takenOver = await acquireOperationLock({
    stateDir,
    owner: owner({ runId: 'challenger' }),
    currentBootId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
    nowMs: startedAtMs + 10 * 3_600_000,
    processExists: () => false,
    delay: async () => {},
  })
  assert.equal(takenOver.acquired, true)
  assert.equal(JSON.parse(await readFile(takenOver.tookOverOrphan, 'utf8')).orphanedBecause, 'different-boot-id')
})

test('a lock directory with no readable owner is held, not free', async (t) => {
  const stateDir = await stateDirectory(t)
  await mkdir(join(stateDir, 'lock'))
  const blocked = await acquireOperationLock({
    stateDir,
    owner: owner({ runId: 'run-x' }),
    currentBootId: BOOT_ID,
    nowMs: Date.now(),
    processExists: () => false,
  })
  assert.equal(blocked.acquired, false)
  assert.equal(blocked.reason, 'lock-held-by-unknown-owner')

  await writeFile(join(stateDir, 'lock', 'owner.json'), '{ broken', 'utf8')
  const holder = await readLockOwner(stateDir)
  assert.equal(holder.held, true)
  assert.equal(holder.owner, null)
})

test('only the run that owns the lock may release it', async (t) => {
  const stateDir = await stateDirectory(t)
  await acquireOperationLock({
    stateDir,
    owner: owner({ runId: 'run-1' }),
    currentBootId: BOOT_ID,
    nowMs: Date.now(),
    processExists: () => true,
  })
  const foreign = await releaseOperationLock({ stateDir, runId: 'run-2' })
  assert.deepEqual({ released: foreign.released, reason: foreign.reason }, { released: false, reason: 'lock-owned-by-another-run' })
  assert.equal((await releaseOperationLock({ stateDir, runId: 'run-1' })).released, true)
  assert.equal((await readLockOwner(stateDir)).held, false)
  assert.equal((await releaseOperationLock({ stateDir, runId: 'run-1' })).reason, 'no-lock-held')
})

test('the journal is append-only, torn-line tolerant and carries no secret', async (t) => {
  const stateDir = await stateDirectory(t)
  let monotonic = 10
  const journal = await createOperationJournal({
    stateDir,
    runId: 'run-1',
    stream: 'operation',
    now: () => new Date('2026-09-19T01:00:00.000Z'),
    monotonicNow: () => (monotonic += 5),
  })
  await journal.append('lock-acquired', { pid: 123 })
  await journal.append('step-start', { target: { name: 'apollo-video-render-worker', id: 'abc', labels: { 'apollo.role': 'render-worker' } } })
  await journal.append('step-verify', { verify: { status: 'exited', pid: 0, backends: 0 } })
  assert.equal(journal.path, journalPath(stateDir, 'run-1', 'operation'))

  const lines = await readJournalLines(journal.path)
  assert.deepEqual(
    lines.map((line) => line.event),
    ['lock-acquired', 'step-start', 'step-verify'],
  )
  assert.ok(lines[1].monotonicMs > lines[0].monotonicMs)
  assert.equal(lines[0].tIso, '2026-09-19T01:00:00.000Z')

  // A process killed mid-write leaves an unterminated line; the reader skips it
  // instead of refusing to read the evidence that came before.
  await writeFile(journal.path, `${await readFile(journal.path, 'utf8')}{"event":"step-`, 'utf8')
  assert.equal((await readJournalLines(journal.path)).length, 3)
  assert.deepEqual(await readJournalLines(join(stateDir, 'journal', 'absent.ndjson')), [])

  const monitor = await createOperationJournal({
    stateDir,
    runId: 'run-1',
    stream: 'monitor',
    now: () => new Date('2026-09-19T01:00:10.000Z'),
    monotonicNow: () => 20,
  })
  assert.notEqual(monitor.path, journal.path, 'one writer per file: the monitor never shares the orchestrator log')
  await monitor.append('monitor-started', { pid: 1 })
  await monitor.append('host-sample', { seq: 1, monotonicMs: 100 })
  await monitor.append('host-sample', { seq: 2, monotonicMs: 200 })
  assert.deepEqual(await readMonitorSamples({ stateDir, runId: 'run-1' }), [
    { seq: 1, monotonicMs: 100 },
    { seq: 2, monotonicMs: 200 },
  ])

  assert.throws(
    () => assertJournalDataCarriesNoSecret({ detail: 'value super-secret-token-42 leaked' }, ['super-secret-token-42']),
    /secret/,
  )
  assertJournalDataCarriesNoSecret({ detail: 'nothing sensitive' }, ['super-secret-token-42'])
  assertJournalDataCarriesNoSecret({ detail: 'short' }, [])
})
