// The whole fleet, one container at a time, against the fake Docker.
//
// Separated from tests/v2/deploy-fake-docker.test.mjs for one measured reason: every
// Docker call is a process, every gate re-read is a Node process, and replacing ten
// containers costs tens of seconds even with nothing real behind it. `npm test` keeps
// the refusals that answer in a second; this suite keeps the sequence, and it needs its
// own CI step.
//
// What it proves: the exact mutation order, the labels, quotas and mounts each container
// is given, the readback that catches a quota the daemon dropped, the adoption path for
// an unlabelled container, and that a gate closing mid-sequence stops the run instead of
// finishing the fleet. What it does not prove: anything about real containers, real
// cgroups or real time — tests/v2/deploy-real-docker.e2e.mjs and the policy unit tests
// own those.
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import * as importedLatch from '../../src/v2/infrastructure/host-safety/latch.ts'
import * as importedLock from '../../src/v2/infrastructure/host-safety/lock.ts'
import {
  APP_ROLES,
  BASE_SCENARIO,
  SECRET_VALUE,
  createWorld,
  dockerLog,
  journalEvents,
  operationJournalLines,
  runDeploy,
  startOpsSimulator,
} from '../fixtures/host-safety/fake-docker/harness.mjs'

// This suite runs under `tsx`, which transpiles the TypeScript modules to CommonJS
// under this package, so a named import of a `.ts` file fails at import time. Namespace
// import, then unwrap — the idiom the worker scripts use for the same reason.
const latchModule = importedLatch.readLatch ? importedLatch : importedLatch.default
const lockModule = importedLock.readLockOwner ? importedLock : importedLock.default
const { readLatch } = latchModule
const { readLockOwner } = lockModule

const RUN = process.env.APOLLO_DEPLOY_FAKE_DOCKER_E2E === '1'

test('a deploy mutates one container at a time, in order, and confirms each one', { skip: !RUN }, async (t) => {
  const world = await createWorld(t, {
    scenario: {
      ...BASE_SCENARIO,
      containers: {
        'apollo-video': { id: 'old-app', labels: { 'apollo.managed': 'true', 'apollo.role': 'app' }, status: 'running', pid: 700 },
        'apollo-video-render-worker': {
          id: 'old-render',
          labels: { 'apollo.managed': 'true', 'apollo.role': 'render-worker' },
          status: 'running',
          pid: 701,
        },
      },
    },
  })
  await startOpsSimulator(t, world)
  const result = await runDeploy(world, ['deploy'])
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  const entries = await dockerLog(world)

  // The budget comes before the monitor, the monitor before the first verdict, and the
  // first verdict before the first mutation.
  const verbs = entries.map((entry) => entry.delegated ?? `${entry.verb}:${entry.name ?? ''}`)
  const budgetAt = verbs.indexOf('scripts/ops/resource-budget.mjs')
  const monitorAt = verbs.findIndex((value) => value.startsWith('run -d:apollo-ops-monitor-'))
  const firstVerdictAt = verbs.indexOf('scripts/ops/host-safety-verdict.mjs')
  const firstMutation = verbs.findIndex((value) => /^(stop|rm):|^run -d:apollo-video/.test(value))
  assert.ok(budgetAt >= 0 && monitorAt > budgetAt, 'the budget is resolved before the monitor starts')
  assert.ok(firstVerdictAt >= 0 && firstMutation > firstVerdictAt, 'no container is touched before a verdict')
  assert.ok(monitorAt < firstMutation, 'the monitor exists before the first mutation')

  const fleetMutations = entries
    .filter((entry) => ['stop', 'rm', 'run -d'].includes(entry.verb) && String(entry.name ?? '').startsWith('apollo-video'))
    .map((entry) => `${entry.verb} ${entry.name}`)
  assert.deepEqual(fleetMutations, [
    'stop apollo-video',
    'rm apollo-video',
    'run -d apollo-video',
    'run -d apollo-video-ingest-worker',
    'stop apollo-video-render-worker',
    'rm apollo-video-render-worker',
    'run -d apollo-video-render-worker',
    'run -d apollo-video-webhook-worker',
    'run -d apollo-video-long-form-worker',
    'run -d apollo-video-provider-worker',
    'run -d apollo-video-capture-sync-worker',
    'run -d apollo-video-music-analysis-worker',
    'run -d apollo-video-localization-media-worker',
  ])

  // Every started container carries its identity, the budget's quotas and a read-only
  // view of the gate.
  const created = new Map(entries.filter((entry) => entry.verb === 'run -d').map((entry) => [entry.name, entry]))
  for (const role of APP_ROLES) {
    const name = role === 'app' ? 'apollo-video' : `apollo-video-${role}`
    const entry = created.get(name)
    assert.ok(entry, `${name} was never started`)
    assert.ok(entry.labels.includes('apollo.managed=true'), `${name} has no apollo.managed label`)
    assert.ok(entry.labels.includes(`apollo.role=${role}`), `${name} has no apollo.role label`)
    assert.ok(entry.labels.some((label) => label.startsWith('apollo.deployment=')), `${name} has no deployment label`)
    assert.equal(entry.limits.memory, entry.limits.memorySwap, `${name} may not swap past its memory limit`)
    assert.ok(Number(entry.limits.pids) > 0, `${name} has no pids limit`)
    assert.ok(entry.envs.includes(`APOLLO_PROCESS_ROLE=${role}`), `${name} must name itself in pg_stat_activity`)
    assert.ok(entry.argv.join(' ').includes(`${world.stateDir}:/app/ops-state:ro`), `${name} must read the gate, never write it`)
  }
  assert.ok(created.get('apollo-video').argv.join(' ').includes('traefik.enable=true'), 'the app keeps its Traefik labels')
  assert.ok(created.get('apollo-video').argv.join(' ').includes('--health-cmd'), 'the app keeps its healthcheck')
  for (const worker of ['apollo-video-ingest-worker', 'apollo-video-render-worker']) {
    const argv = created.get(worker).argv.join(' ')
    assert.ok(argv.includes('--restart unless-stopped'), `${worker} keeps its restart policy`)
    assert.ok(argv.includes('--init'), `${worker} keeps its init process`)
  }
  assert.ok(!created.has('apollo-video-localization-translation-worker'), 'the paid worker stays off while the flag is false')

  // The run finished: gate.json removed, monitor stopped, lock released, journal complete.
  const stateEntries = await readdir(world.stateDir)
  assert.ok(!stateEntries.includes('gate.json'), 'the absence of gate.json is the open state')
  assert.ok(!stateEntries.includes('latch.json'))
  assert.equal((await readLockOwner(world.stateDir)).held, false)
  assert.ok(entries.some((entry) => entry.verb === 'stop' && String(entry.name).startsWith('apollo-ops-monitor-')))
  const events = await journalEvents(world)
  for (const event of [
    'lock-acquired',
    'budget-resolved',
    'cgroup-capability',
    'monitor-started',
    'preflight-verdict',
    'step-verify',
    'postflight-verdict',
    'gate-opened',
    'lock-released',
  ]) {
    assert.ok(events.includes(event), `the journal has no ${event} event`)
  }
  assert.deepEqual((await readdir(world.appRoot)).sort(), ['artifacts', 'render-outputs', 'tmp'])
  assert.deepEqual(await readdir(join(world.appRoot, 'tmp')), ['provider-results'])

  // No value from the environment file reaches any journal on the host.
  for (const file of await readdir(join(world.stateDir, 'journal'))) {
    const content = await readFile(join(world.stateDir, 'journal', file), 'utf8')
    assert.ok(!content.includes(SECRET_VALUE), `${file} contains a secret value`)
  }
})

test('a stop that leaves the container running engages the latch and touches nothing else', { skip: !RUN }, async (t) => {
  const world = await createWorld(t, {
    scenario: {
      ...BASE_SCENARIO,
      containers: {
        'apollo-video': { id: 'old-app', labels: { 'apollo.managed': 'true', 'apollo.role': 'app' }, status: 'running', pid: 700 },
      },
      behaviour: { stopHangs: ['apollo-video'] },
    },
  })
  await startOpsSimulator(t, world)
  const result = await runDeploy(world, ['deploy'])
  assert.notEqual(result.status, 0)
  const entries = await dockerLog(world)
  assert.deepEqual(
    entries
      .filter((entry) => ['stop', 'rm'].includes(entry.verb) && String(entry.name).startsWith('apollo-video'))
      .map((entry) => `${entry.verb} ${entry.name}`),
    ['stop apollo-video'],
    'after an unconfirmed stop there is no rm, no retry and no second container',
  )
  assert.ok(!entries.some((entry) => entry.verb === 'run -d' && String(entry.name).startsWith('apollo-video')))
  const latch = await readLatch(world.stateDir)
  assert.equal(latch.engaged, true)
  assert.equal(latch.document.reason, 'step-inconclusive')
  assert.equal(latch.document.runId, world.runId)
  const events = await journalEvents(world)
  assert.ok(events.includes('step-inconclusive'))
  assert.ok(events.includes('latch-engaged'))
  // The lock is released so the operator can read status and release the latch.
  assert.equal((await readLockOwner(world.stateDir)).held, false)
  assert.ok(entries.some((entry) => entry.verb === 'stop' && String(entry.name).startsWith('apollo-ops-monitor-')))
})

test('an unlabelled container blocks the deploy without engaging the latch', { skip: !RUN }, async (t) => {
  const world = await createWorld(t, {
    scenario: {
      ...BASE_SCENARIO,
      containers: { 'apollo-video': { id: 'legacy-app', labels: {}, status: 'running', pid: 700, image: 'apollo-video:legacy' } },
    },
  })
  await startOpsSimulator(t, world)
  const result = await runDeploy(world, ['deploy'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /does not carry apollo\.managed=true and apollo\.role=app/)
  assert.match(result.stderr, /--adopt-unlabelled apollo-video/)
  const entries = await dockerLog(world)
  assert.equal(entries.filter((entry) => ['stop', 'rm'].includes(entry.verb) && String(entry.name).startsWith('apollo-video')).length, 0)
  // Blocked before any mutation means no latch: nothing is half-done, the operator decides.
  assert.equal((await readLatch(world.stateDir)).engaged, false)
  assert.ok((await journalEvents(world)).includes('step-blocked'))
})

test('an unlabelled container can be adopted once, with evidence', { skip: !RUN }, async (t) => {
  const world = await createWorld(t, {
    scenario: {
      ...BASE_SCENARIO,
      containers: { 'apollo-video': { id: 'legacy-app', labels: {}, status: 'running', pid: 700, image: 'apollo-video:legacy' } },
    },
  })
  await startOpsSimulator(t, world)
  const accepted = await runDeploy(world, ['deploy', '--adopt-unlabelled', 'apollo-video'])
  assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`)
  const lines = await operationJournalLines(world)
  const adoption = lines.find((line) => line.event === 'adopt-unlabelled')
  assert.ok(adoption, 'the adoption must leave evidence')
  assert.equal(adoption.data.observed.image, 'apollo-video:legacy')
  assert.match(adoption.data.observed.inspected, /apollo-test-network/)
  // The adoption is for one named container only: it does not become a general licence.
  assert.equal(adoption.data.target.name, 'apollo-video')
})

test('a quota the daemon did not apply is inconclusive, not a warning', { skip: !RUN }, async (t) => {
  const world = await createWorld(t, {
    scenario: { ...BASE_SCENARIO, behaviour: { readbackMismatch: ['apollo-video-webhook-worker'] } },
  })
  await startOpsSimulator(t, world)
  const result = await runDeploy(world, ['deploy'])
  assert.notEqual(result.status, 0)
  const latch = await readLatch(world.stateDir)
  assert.equal(latch.engaged, true)
  assert.match(latch.document.detail, /webhook-worker/)
  const lines = await operationJournalLines(world)
  const inconclusive = lines.find((line) => line.event === 'step-inconclusive')
  assert.equal(inconclusive.data.reason, 'limit-readback-mismatch')
  // The roles after the failure were never started.
  const entries = await dockerLog(world)
  assert.ok(!entries.some((entry) => entry.verb === 'run -d' && entry.name === 'apollo-video-long-form-worker'))
})

test('a gate that closes between two steps stops the sequence', { skip: !RUN }, async (t) => {
  const world = await createWorld(t)
  // The gate closes as soon as the app container has been started.
  await startOpsSimulator(t, world, {
    closeWhen: async (currentWorld) => {
      const content = await readFile(join(currentWorld.stateDir, 'journal', `${currentWorld.runId}.ndjson`), 'utf8').catch(() => '')
      return content.includes('"name":"apollo-video"') && content.includes('"step":"run"')
    },
  })
  const result = await runDeploy(world, ['deploy'])
  assert.notEqual(result.status, 0)
  const latch = await readLatch(world.stateDir)
  assert.equal(latch.engaged, true)
  assert.equal(latch.document.reason, 'gate-closed')
  assert.match(latch.document.detail, /cpu-busy-peak/)
  const entries = await dockerLog(world)
  const started = entries.filter((entry) => entry.verb === 'run -d' && String(entry.name).startsWith('apollo-video')).map((entry) => entry.name)
  assert.ok(started.length >= 1, 'the app was already replaced when the gate closed')
  assert.ok(!started.includes('apollo-video-localization-media-worker'), 'the sequence stopped instead of finishing the fleet')
})
