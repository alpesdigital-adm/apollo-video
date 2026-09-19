import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import * as importedClock from '../../src/v2/infrastructure/host-safety/host-clock.ts'
import * as importedGateFile from '../../src/v2/infrastructure/host-safety/gate-file.ts'
import * as importedLatch from '../../src/v2/infrastructure/host-safety/latch.ts'
import * as importedLock from '../../src/v2/infrastructure/host-safety/lock.ts'
import {
  BASE_SCENARIO,
  PRODUCTION_FORBIDDEN_SEAMS,
  SECRET_VALUE,
  bootId,
  createWorld,
  dockerLog,
  journalEvents,
  mutatingVerbs,
  operationJournalLines,
  runDeploy,
  runDeployFunction,
  withoutSeams,
} from '../fixtures/host-safety/fake-docker/harness.mjs'

// Namespace imports, then unwrap. This file runs under `node --test`, where native type
// stripping exposes named exports, but the same modules are imported by suites that run
// under `tsx` — which transpiles them to CommonJS under this package and puts the named
// exports behind `default`. One idiom everywhere means moving a case between the two
// files can never reintroduce the import-time failure of CI run 35446572591.
const clockModule = importedClock.hostMonotonicNowMs ? importedClock : importedClock.default
const gateModule = importedGateFile.writeGateFile ? importedGateFile : importedGateFile.default
const latchModule = importedLatch.readLatch ? importedLatch : importedLatch.default
const lockModule = importedLock.readLockOwner ? importedLock : importedLock.default
const { hostMonotonicNowMs } = clockModule
const { writeGateFile } = gateModule
const { readLatch } = latchModule
const { readLockOwner } = lockModule

// The real deploy script, driven by a `docker` that answers from a scenario and records
// every invocation (tests/fixtures/host-safety/fake-docker/docker).
//
// This file holds the cases that answer in a second or two: every refusal that happens
// before the fleet is touched, plus the host-side OOM rule exercised directly against
// the function the deploy calls. Anything that has to establish a preflight and walk the
// fleet costs tens of seconds even against a fake — one process per Docker call — so it
// lives in tests/v2/deploy-fake-docker.e2e.mjs with its own CI step, and `npm test`
// stays fast.
//
// There is no Docker on the machine this was written on; no container is ever started
// here. tests/v2/deploy-real-docker.e2e.mjs does that in CI.

test('plan performs no mutation at all', async (t) => {
  const world = await createWorld(t)
  const result = await runDeploy(world, ['plan'])
  assert.equal(result.status, 0, result.stderr)
  const entries = await dockerLog(world)
  assert.ok(entries.length > 0, 'the plan must actually interrogate Docker')
  for (const entry of entries) {
    assert.ok(
      ['inspect', 'image inspect', 'info', 'network'].includes(entry.verb),
      `plan used a non-read-only verb: ${entry.verb} (${entry.argv.join(' ')})`,
    )
  }
  // Nothing was written to the host state directory either: no lock, no journal.
  assert.deepEqual(await readdir(world.stateDir), [])
  await assert.rejects(() => readdir(world.appRoot), /ENOENT/)
  assert.match(result.stdout, /image id\s+sha256:1111/)
  assert.match(result.stdout, /image digests\s+apollo-video@sha256:2222/)
  assert.match(result.stdout, /Targets, in replacement order/)
  assert.match(result.stdout, /1\. acquire the operation lock/)
  assert.match(result.stdout, /zero PostgreSQL backends, rm, run with quotas, limit readback/)
  assert.match(result.stdout, /This plan performed no mutation/)
  // No environment value leaks into the plan, only the file's presence.
  assert.ok(!result.stdout.includes(SECRET_VALUE))
})

test('plan names the steps the shared profile blocks and why', async (t) => {
  const world = await createWorld(t)
  // `withoutSeams` because the shared profile refuses every test seam, plan included.
  const result = await runDeploy(
    world,
    ['plan'],
    withoutSeams({ APOLLO_RESOURCE_PROFILE: 'shared-production', APOLLO_RESOURCE_BUDGET_APPROVED_FILE: world.envFile }),
  )
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /docker load, docker pull, image decompression, image hashing and backups/)
  assert.match(result.stdout, /uncoveredHostWork/)
  const local = await runDeploy(world, ['plan'], { APOLLO_RESOURCE_PROFILE: 'local-dev' })
  assert.match(local.stdout, /nothing: this profile is a disposable host/)
})

test('plan --with-budget resolves the real budget in one --rm container and still mutates nothing', async (t) => {
  const world = await createWorld(t)
  const result = await runDeploy(world, ['plan', '--with-budget'])
  assert.equal(result.status, 0, result.stderr)
  const entries = await dockerLog(world)
  const runs = entries.filter((entry) => entry.verb.startsWith('run'))
  assert.equal(runs.length, 1)
  assert.equal(runs[0].delegated, 'scripts/ops/resource-budget.mjs')
  assert.equal(mutatingVerbs(entries).length, 0)
  // The numbers come from config/resource-budget.json through the real CLI.
  assert.match(result.stdout, /app\s+0\.5 cpus \/ 805306368 bytes \/ 256 pids/)
  assert.match(result.stdout, /monitor\s+0\.1 cpus \/ 134217728 bytes \/ 32 pids \(auxiliary\)/)
  assert.match(result.stdout, /localization-translation-worker\s+disabled by configuration/)
  assert.deepEqual(await readdir(world.stateDir), [])
})

test('a second invocation is refused by the lock with the holder identity', async (t) => {
  const world = await createWorld(t)
  await mkdir(join(world.stateDir, 'lock'))
  await writeFile(
    join(world.stateDir, 'lock', 'owner.json'),
    JSON.stringify({
      schemaVersion: 'apollo-ops-lock/v1',
      runId: 'deploy-already-running',
      pid: process.pid,
      startedAtIso: new Date().toISOString(),
      bootId,
      command: 'deploy',
      hostname: 'test-host',
    }),
    'utf8',
  )
  const result = await runDeploy(world, ['deploy'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /another operation holds the lock: run deploy-already-running/)
  assert.match(result.stderr, new RegExp(`pid ${process.pid}`))
  assert.equal(mutatingVerbs(await dockerLog(world)).length, 0)
})

test('a lock whose owner is still being written is held, never taken over', async (t) => {
  const world = await createWorld(t)
  await mkdir(join(world.stateDir, 'lock'))
  // Exactly what the loser of a `mkdir` race sees for a few milliseconds: the directory
  // exists and the owner file is not complete yet. Reading an empty bootId out of it and
  // calling it "another boot" is how two deploys once both believed they held the lock.
  await writeFile(join(world.stateDir, 'lock', 'owner.json'), '{\n  "schemaVersion": "apollo-ops-lock/v1",\n  "runId": "deploy-2026', 'utf8')
  const refused = await runDeployFunction(world, 'apollo_state_prepare && apollo_lock_acquire deploy')
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /is held and its owner\.json is missing, empty or still being written/)
  assert.match(refused.stderr, /never treated as an orphan/)
  // Nothing was archived and the holder's file was not replaced.
  await assert.rejects(() => readdir(join(world.stateDir, 'journal')).then((entries) => {
    if (entries.some((entry) => entry.includes('orphaned'))) return entries
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }), /ENOENT/)
  assert.match(await readFile(join(world.stateDir, 'lock', 'owner.json'), 'utf8'), /"runId": "deploy-2026$/)

  // The deploy itself refuses for the same reason, before touching Docker.
  const deploy = await runDeploy(world, ['deploy'])
  assert.notEqual(deploy.status, 0)
  assert.match(deploy.stderr, /still being written/)
  assert.equal(mutatingVerbs(await dockerLog(world)).length, 0)

  // An owner written the way the script writes it is complete when it appears, so the
  // normal refusal still names the holder.
  await writeFile(
    join(world.stateDir, 'lock', 'owner.json'),
    JSON.stringify({
      schemaVersion: 'apollo-ops-lock/v1',
      runId: 'deploy-already-running',
      pid: process.pid,
      startedAtIso: new Date().toISOString(),
      bootId,
      command: 'deploy',
      hostname: 'test-host',
    }),
    'utf8',
  )
  const named = await runDeploy(world, ['deploy'])
  assert.match(named.stderr, /another operation holds the lock: run deploy-already-running/)
})

test('an engaged latch refuses the deploy before anything is interrogated', async (t) => {
  const world = await createWorld(t)
  await writeFile(
    join(world.stateDir, 'latch.json'),
    JSON.stringify({
      schemaVersion: 'apollo-ops-latch/v1',
      engagedAtIso: new Date().toISOString(),
      runId: 'earlier-run',
      reason: 'stop-timeout',
      detail: 'an earlier run left this',
      evidence: { journal: 'journal/earlier-run.ndjson', lastSampleSeq: 3 },
    }),
    'utf8',
  )
  const result = await runDeploy(world, ['deploy'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /an incident latch is engaged/)
  assert.equal(mutatingVerbs(await dockerLog(world)).length, 0)
  // The refusal did not clear the latch and released the lock it took.
  assert.equal((await readLatch(world.stateDir)).engaged, true)
  assert.equal((await readLockOwner(world.stateDir)).held, false)
})

test('a refused budget aborts before the first mutation', async (t) => {
  const world = await createWorld(t)
  const approved = join(world.directory, 'approved.json')
  // A document that names no approver: the budget refuses it with exit 2.
  await writeFile(approved, JSON.stringify({ schemaVersion: 'apollo-resource-budget-approval/v1', profile: 'shared-production' }), 'utf8')
  const result = await runDeploy(
    world,
    ['deploy'],
    withoutSeams({ APOLLO_RESOURCE_PROFILE: 'shared-production', APOLLO_RESOURCE_BUDGET_APPROVED_FILE: approved }),
  )
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /aggregate resource budget was refused/)
  const entries = await dockerLog(world)
  assert.equal(mutatingVerbs(entries).length, 0, 'not one container may be started when the budget does not resolve')
  await assert.rejects(() => readdir(world.appRoot), /ENOENT/, 'not even a directory may be created')
  assert.ok((await journalEvents(world)).includes('budget-rejected'))
  assert.equal((await readLockOwner(world.stateDir)).held, false)
})

test('a container the daemon OOM killed recently closes the gate before the monitor starts', async (t) => {
  const killedContainer = (finishedAt) => ({
    ...BASE_SCENARIO,
    containers: {
      'apollo-video-render-worker': {
        id: 'old-render',
        labels: { 'apollo.managed': 'true', 'apollo.role': 'render-worker' },
        status: 'exited',
        pid: 0,
        oomKilled: true,
        finishedAt,
      },
    },
  })

  // The collector alone cannot see this: `oom_kill` is a cumulative counter, so a kill
  // that happened before the run's first sample leaves no increase to observe. The
  // daemon remembers per container, which is why the check is on the host side, and why
  // it runs before the monitor is even started.
  const recent = await createWorld(t, { scenario: killedContainer(new Date(Date.now() - 60_000).toISOString()) })
  const refused = await runDeployFunction(recent, 'apollo_preflight_container_oom 600000')
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /apollo-video-render-worker was OOM killed \d+ms ago, inside the 600000ms recency window/)

  const old = await createWorld(t, { scenario: killedContainer(new Date(Date.now() - 3_600_000).toISOString()) })
  const admitted = await runDeployFunction(old, 'apollo_preflight_container_oom 600000')
  assert.equal(admitted.status, 0, admitted.stderr)

  // A kill the daemon cannot date is treated as recent, not as absent.
  const undated = await createWorld(t, { scenario: killedContainer('0001-01-01T00:00:00Z') })
  const undatedResult = await runDeployFunction(undated, 'apollo_preflight_container_oom 600000')
  assert.notEqual(undatedResult.status, 0)
  assert.match(undatedResult.stderr, /no usable timestamp/)

  // An unconfigured window cannot judge recency, so it refuses instead of assuming.
  const unconfigured = await runDeployFunction(recent, 'apollo_preflight_container_oom ""')
  assert.notEqual(unconfigured.status, 0)
  assert.match(unconfigured.stderr, /OOM recency window is not configured/)

  // A fleet with nothing OOM killed passes.
  const clean = await createWorld(t)
  assert.equal((await runDeployFunction(clean, 'apollo_preflight_container_oom 600000')).status, 0)
})

test('a test seam in the environment refuses a shared production operation', async (t) => {
  const world = await createWorld(t)
  const approved = join(world.directory, 'approved.json')
  await writeFile(approved, JSON.stringify({ schemaVersion: 'apollo-resource-budget-approval/v1', profile: 'shared-production' }), 'utf8')
  const shared = {
    APOLLO_RESOURCE_PROFILE: 'shared-production',
    APOLLO_RESOURCE_BUDGET_APPROVED_FILE: approved,
  }

  // Every seam, in one shell: each shortens a window, weakens a wait, replaces the
  // policy, lowers a quota or skips a step, and each must name itself in the refusal.
  // The shell's own list is printed back, so a seam added there and forgotten in this
  // test — or the reverse — fails instead of passing quietly.
  const sweep = await runDeployFunction(
    world,
    [
      'printf "declared:%s\\n" "${APOLLO_PRODUCTION_FORBIDDEN_SEAMS[*]}"',
      'for seam in "${APOLLO_PRODUCTION_FORBIDDEN_SEAMS[@]}"; do',
      '  outcome="$(export "${seam}=1"; apollo_refuse_production_seams shared-production >/dev/null 2>&1; printf "%s" "$?")"',
      '  printf "%s=%s\\n" "${seam}" "${outcome}"',
      '  empty="$(export "${seam}="; apollo_refuse_production_seams shared-production >/dev/null 2>&1; printf "%s" "$?")"',
      '  printf "%s(empty)=%s\\n" "${seam}" "${empty}"',
      'done',
      'apollo_refuse_production_seams isolated-ci && printf "isolated-ci=accepted\\n"',
      'apollo_refuse_production_seams local-dev && printf "local-dev=accepted\\n"',
    ].join('\n'),
    withoutSeams(),
  )
  assert.equal(sweep.status, 0, sweep.stderr)
  const declared = /declared:(.*)/.exec(sweep.stdout)[1].trim().split(/\s+/)
  assert.deepEqual(declared, PRODUCTION_FORBIDDEN_SEAMS, 'the shell list and this test must name the same seams')
  for (const seam of declared) {
    assert.match(sweep.stdout, new RegExp(`^${seam}=1$`, 'm'), `${seam} was accepted on shared-production`)
    // Set but empty is still set: an exported empty value is an operator reaching for a
    // seam, and no rule should have to guess what an empty seam means.
    assert.match(sweep.stdout, new RegExp(`^${seam}\\(empty\\)=1$`, 'm'), `${seam}= was accepted on shared-production`)
  }
  assert.match(sweep.stdout, /^isolated-ci=accepted$/m)
  assert.match(sweep.stdout, /^local-dev=accepted$/m)

  // And through the whole script: a seam refuses the deploy by name.
  const refused = await runDeploy(world, ['deploy'], withoutSeams({ ...shared, APOLLO_OPS_POLL_SLEEP_S: '1' }))
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /APOLLO_OPS_POLL_SLEEP_S is set and APOLLO_RESOURCE_PROFILE is shared-production/)
  assert.match(refused.stderr, /accepted on isolated-ci and local-dev only/)
  // The refusal happens before anything is read: not even `plan` proceeds.
  const plan = await runDeploy(world, ['plan'], withoutSeams({ ...shared, APOLLO_OPS_POLICY_CATALOG: world.catalogPath }))
  assert.notEqual(plan.status, 0)
  assert.equal((await dockerLog(world)).length, 0, 'a refused seam interrogates nothing')

  // With no seam set, the shared profile gets as far as the budget it cannot resolve.
  const clean = await runDeploy(world, ['deploy'], withoutSeams(shared))
  assert.match(clean.stderr, /aggregate resource budget was refused/)

  // And the same seams are accepted on a disposable profile.
  const isolated = await createWorld(t)
  const accepted = await runDeploy(isolated, ['plan'])
  assert.equal(accepted.status, 0, accepted.stderr)
})

test('a run monitor that will not stop leaves the deploy non-zero and journalled', async (t) => {
  const world = await createWorld(t)
  const monitor = `apollo-ops-monitor-${world.runId}`
  // The monitor is this run's own container, so stopping it is allowed — but the claim
  // that it stopped is confirmed like every other stop. One that stays up would keep
  // republishing gate.json for a run that is over.
  const hanging = await createWorld(t, {
    scenario: {
      ...BASE_SCENARIO,
      containers: { [monitor]: { id: 'monitor-1', labels: { 'apollo.managed': 'true', 'apollo.role': 'monitor' }, status: 'running', pid: 900 } },
      behaviour: { stopHangs: [monitor] },
    },
  })
  hanging.runId = world.runId
  const refused = await runDeployFunction(hanging, 'apollo_state_prepare && apollo_monitor_stop', { APOLLO_JOURNAL_ENABLED: '1' })
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, new RegExp(`the run monitor ${monitor} is still running after docker stop`))
  const lines = await operationJournalLines(hanging)
  const inconclusive = lines.find((line) => line.event === 'monitor-stop-inconclusive')
  assert.equal(inconclusive.data.reason, 'not-terminal')
  assert.equal(inconclusive.data.verify.status, 'running')
  const entries = await dockerLog(hanging)
  assert.ok(!entries.some((entry) => entry.verb === 'rm'), 'a monitor that did not stop is not removed')

  // A monitor that stops but refuses removal is journalled and not fatal: an exited
  // container publishes nothing and its name carries this run's id.
  const stubborn = await createWorld(t, {
    scenario: {
      ...BASE_SCENARIO,
      containers: { [monitor]: { id: 'monitor-2', labels: { 'apollo.role': 'monitor' }, status: 'running', pid: 901 } },
      behaviour: { rmFails: [monitor] },
    },
  })
  stubborn.runId = world.runId
  const tolerated = await runDeployFunction(stubborn, 'apollo_state_prepare && apollo_monitor_stop', { APOLLO_JOURNAL_ENABLED: '1' })
  assert.equal(tolerated.status, 0, tolerated.stderr)
  assert.ok((await journalEvents(stubborn)).includes('monitor-remove-inconclusive'))

  // The happy path confirms the terminal state before calling the monitor stopped.
  const clean = await createWorld(t, {
    scenario: {
      ...BASE_SCENARIO,
      containers: { [monitor]: { id: 'monitor-3', labels: { 'apollo.role': 'monitor' }, status: 'running', pid: 902 } },
    },
  })
  clean.runId = world.runId
  const stopped = await runDeployFunction(clean, 'apollo_state_prepare && apollo_monitor_stop', { APOLLO_JOURNAL_ENABLED: '1' })
  assert.equal(stopped.status, 0, stopped.stderr)
  const stoppedLine = (await operationJournalLines(clean)).find((line) => line.event === 'monitor-stopped')
  assert.equal(stoppedLine.data.verify.status, 'exited')
})

test('the state the shell writes is exactly what the TypeScript readers accept', async (t) => {
  const world = await createWorld(t)
  const status = await runDeploy(world, ['status'])
  assert.equal(status.status, 0, status.stderr)
  assert.match(status.stdout, /^lock {3}free/m)
  assert.match(status.stdout, /^latch {2}clear/m)
  assert.match(status.stdout, /^gate {3}absent \(open\)/m)

  await writeFile(
    join(world.stateDir, 'latch.json'),
    JSON.stringify({
      schemaVersion: 'apollo-ops-latch/v1',
      engagedAtIso: '2026-09-19T01:02:03.000Z',
      runId: 'earlier-run',
      reason: 'stop-timeout',
      detail: 'left by an earlier run',
      evidence: { journal: 'journal/earlier-run.ndjson', lastSampleSeq: 7 },
    }),
    'utf8',
  )
  assert.equal((await readLatch(world.stateDir)).engaged, true)
  const withoutReason = await runDeploy(world, ['latch', 'release'])
  assert.notEqual(withoutReason.status, 0)
  assert.match(withoutReason.stderr, /requires --reason/)
  const released = await runDeploy(world, ['latch', 'release', '--reason', 'owner authorised the resume'])
  assert.equal(released.status, 0, released.stderr)
  assert.equal((await readLatch(world.stateDir)).engaged, false)
  const archived = await readdir(join(world.stateDir, 'journal'))
  assert.ok(archived.some((entry) => entry.endsWith('.released.json')))
  assert.ok(archived.some((entry) => entry.endsWith('.released.json.source')), 'the original latch document is kept')

  // A lock directory with no readable owner is held, not broken.
  await mkdir(join(world.stateDir, 'lock'), { recursive: true })
  const blocked = await runDeploy(world, ['gate', 'open', '--reason', 'monitor died without a postflight'])
  assert.notEqual(blocked.status, 0)
  assert.match(blocked.stderr, /is held and its owner\.json is missing, empty or still being written/)
  await rm(join(world.stateDir, 'lock'), { recursive: true, force: true })

  await writeGateFile({
    stateDir: world.stateDir,
    state: 'closed',
    reasons: ['sample-missing'],
    seq: 9,
    issuedAtIso: new Date().toISOString(),
    issuedAtMonotonicMs: hostMonotonicNowMs(),
    ttlMs: 30_000,
    owner: { runId: 'dead-monitor', kind: 'monitor', pid: 4242 },
  })
  const reopened = await runDeploy(world, ['gate', 'open', '--reason', 'monitor died without a postflight'])
  assert.equal(reopened.status, 0, reopened.stderr)
  assert.ok(!(await readdir(world.stateDir)).includes('gate.json'))
  const lines = await operationJournalLines(world)
  const opened = lines.find((line) => line.event === 'gate-opened')
  assert.equal(opened.data.reason, 'monitor died without a postflight')
  assert.equal(lines.filter((line) => line.event === 'lock-acquired').length, 2, 'both operator commands took the lock')
  // Nothing the shell wrote leaked a configured value.
  for (const file of await readdir(join(world.stateDir, 'journal'))) {
    const content = await readFile(join(world.stateDir, 'journal', file), 'utf8')
    assert.ok(!content.includes(SECRET_VALUE), `${file} contains a secret value`)
  }
})

test('the deploy refuses an unusable request before it touches anything', async (t) => {
  const world = await createWorld(t)
  const withoutProfile = await runDeploy(world, ['deploy'], { APOLLO_RESOURCE_PROFILE: '' })
  assert.notEqual(withoutProfile.status, 0)
  assert.match(withoutProfile.stderr, /APOLLO_RESOURCE_PROFILE is required/)
  const wrongProfile = await runDeploy(world, ['deploy'], { APOLLO_RESOURCE_PROFILE: 'production' })
  assert.match(wrongProfile.stderr, /must be isolated-ci, local-dev or shared-production/)
  const withoutState = await runDeploy(world, ['deploy'], { APOLLO_OPS_STATE_DIR: '' })
  assert.match(withoutState.stderr, /APOLLO_OPS_STATE_DIR is required/)
  const withoutHealth = await runDeploy(world, ['deploy'], { APOLLO_OPS_HEALTH_URL: '' })
  assert.match(withoutHealth.stderr, /APOLLO_OPS_HEALTH_URL is required/)
  const sharedWithoutApproval = await runDeploy(world, ['deploy'], withoutSeams({ APOLLO_RESOURCE_PROFILE: 'shared-production' }))
  assert.match(sharedWithoutApproval.stderr, /APOLLO_RESOURCE_BUDGET_APPROVED_FILE is required/)
  const unknownCommand = await runDeploy(world, ['restart'])
  assert.match(unknownCommand.stderr, /unknown command 'restart'/)
  const externalMonitorOffCi = await runDeploy(world, ['deploy'], { APOLLO_OPS_MONITOR_MODE: 'external', APOLLO_RESOURCE_PROFILE: 'local-dev' })
  assert.match(externalMonitorOffCi.stderr, /only accepted with APOLLO_RESOURCE_PROFILE=isolated-ci/)
  assert.equal(mutatingVerbs(await dockerLog(world)).length, 0)
})

test('a missing image names the blocked import step instead of importing it', async (t) => {
  const world = await createWorld(t, { scenario: { ...BASE_SCENARIO, image: null } })
  const result = await runDeploy(world, ['deploy'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /image apollo-video:test is not present on this host/)
  assert.match(result.stderr, /docker load, docker pull/)
  assert.match(result.stderr, /uncoveredHostWork/)
  const entries = await dockerLog(world)
  assert.equal(entries.filter((entry) => entry.verb.startsWith('run')).length, 0)
})
