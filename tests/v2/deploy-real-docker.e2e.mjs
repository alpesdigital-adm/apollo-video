// The deploy's container rules against a REAL Docker daemon.
//
// Everything else about this wave is proven with fakes and a controlled clock, which is
// the only way to test a 30 s sustained threshold without producing 30 s of load. What a
// fake cannot prove is that the daemon behaves the way the script assumes: that `docker
// stop` returns before the container is terminal, that `.State.Pid` really reaches 0,
// that a quota accepted on the command line actually appears in the container's cgroup,
// and that an identity check is the only thing standing between this script and someone
// else's container.
//
// It runs only in the isolated Compose CI job, gated by APOLLO_DEPLOY_DOCKER_E2E=1, and
// it is deliberately small: a handful of `sleep` containers, a few hundred megabytes of
// limits, no stress, no OOM, nothing that would make this the load it is meant to detect.
// Every container it creates carries a unique run label and is removed in `finally`; the
// postflight asserts that zero containers with that label remain.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'

import * as importedClock from '../../src/v2/infrastructure/host-safety/host-clock.ts'
import * as importedGateFile from '../../src/v2/infrastructure/host-safety/gate-file.ts'
import * as importedJournal from '../../src/v2/infrastructure/host-safety/journal.ts'
import * as importedLatch from '../../src/v2/infrastructure/host-safety/latch.ts'
import * as importedLock from '../../src/v2/infrastructure/host-safety/lock.ts'

// This suite runs under `tsx`, which transpiles the TypeScript modules to CommonJS
// under this package, so a named import of a `.ts` file fails at import time. Namespace
// import, then unwrap — the idiom the worker scripts use for the same reason.
const clockModule = importedClock.hostMonotonicNowMs ? importedClock : importedClock.default
const gateModule = importedGateFile.writeGateFile ? importedGateFile : importedGateFile.default
const journalModule = importedJournal.createOperationJournal ? importedJournal : importedJournal.default
const latchModule = importedLatch.readLatch ? importedLatch : importedLatch.default
const lockModule = importedLock.readLockOwner ? importedLock : importedLock.default
const { hostMonotonicNowMs } = clockModule
const { writeGateFile } = gateModule
const { createOperationJournal } = journalModule
const { readLatch } = latchModule
const { readLockOwner } = lockModule

const RUN = process.env.APOLLO_DEPLOY_DOCKER_E2E === '1'
const IMAGE = process.env.APOLLO_DEPLOY_E2E_IMAGE ?? 'apollo-video-local:compose-ci'
const repositoryRoot = resolve(import.meta.dirname, '..', '..')
const runId = `e2e-${randomUUID().slice(0, 8)}`
const RUN_LABEL = `apollo.e2e.run=${runId}`

function docker(...args) {
  return spawnSync('docker', args, { encoding: 'utf8' })
}

function containersWithRunLabel() {
  const listed = docker('ps', '-aq', '--filter', `label=${RUN_LABEL}`)
  // `spawnSync` reports a missing binary in `error` and leaves `stdout` undefined rather
  // than throwing, so a host without Docker must not crash the cleanup hook.
  return (listed.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

after(() => {
  if (!RUN) return
  for (const id of containersWithRunLabel()) docker('rm', '-f', id)
})

/** Starts a bounded `sleep` container carrying the labels a case needs. */
function startContainer(name, labels, extra = []) {
  const labelArguments = Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`])
  const created = docker('run', '-d', '--name', name, '--label', RUN_LABEL, ...labelArguments, ...extra, IMAGE, 'sleep', '600')
  assert.equal(created.status, 0, `could not start ${name}: ${created.stderr}`)
  return created.stdout.trim()
}

function inspect(name, format) {
  return docker('inspect', '--format', format, name).stdout.trim()
}

/**
 * Writes a complete, fresh window of samples and an open gate.
 *
 * The values are fabricated, but the clock is not: `hostMonotonicNowMs` is
 * CLOCK_MONOTONIC, shared with every container on this host, so the verdict running
 * inside a real container reads these samples as genuinely recent.
 */
async function publishHealthyWindow(stateDir) {
  const journal = await createOperationJournal({
    stateDir,
    runId,
    stream: 'monitor',
    now: () => new Date(),
    monotonicNow: hostMonotonicNowMs,
  })
  const now = hostMonotonicNowMs()
  for (let index = 6; index >= 0; index -= 1) {
    await journal.append('host-sample', {
      seq: publishHealthyWindow.seq++,
      monotonicMs: now - index * 10_000,
      capturedAtIso: new Date().toISOString(),
      cpu: { busy: 0.05, steal: 0.01, iowait: 0.01 },
      hostCpus: 4,
      load1: 0.4,
      memoryAvailableBytes: 4 * 1024 ** 3,
      oom: { total: 0, sinceRunStart: 0, lastIncreaseMonotonicMs: null },
      postgres: { connections: 4, maxConnections: 100, backendsByApplicationName: {} },
      health: { ok: true, statusCode: 200, latencyMs: 8, error: null },
    })
  }
  await writeGateFile({
    stateDir,
    state: 'open',
    reasons: [],
    seq: publishHealthyWindow.gateSeq++,
    issuedAtIso: new Date().toISOString(),
    issuedAtMonotonicMs: hostMonotonicNowMs(),
    ttlMs: 60_000,
    owner: { runId, kind: 'monitor', pid: process.pid },
  })
}
publishHealthyWindow.seq = 1
publishHealthyWindow.gateSeq = 1

/** Runs a snippet against the deploy's own libraries, with the real Docker on PATH. */
function runDeployFunction(stateDir, snippet, overrides = {}) {
  const preamble = [
    `. '${join(repositoryRoot, 'infra/deploy/lib/common.sh')}'`,
    `. '${join(repositoryRoot, 'infra/deploy/lib/state.sh')}'`,
    `. '${join(repositoryRoot, 'infra/deploy/lib/docker.sh')}'`,
    `. '${join(repositoryRoot, 'infra/deploy/lib/ops.sh')}'`,
    // Overridable so the concurrency case can give its two racers different identities;
    // with one shared id a lock "held by us" would look like a win to both of them.
    `APOLLO_RUN_ID="\${APOLLO_RUN_ID_OVERRIDE:-${runId}}"`,
    // Honour an override instead of clearing it: the adopt flag is a global that the
    // main script's argument parser sets, and a preamble that hardcoded it empty made
    // the "adoption succeeds" leg silently take the blocked path (CI run 35453455143).
    'APOLLO_ADOPT_UNLABELLED="${APOLLO_ADOPT_UNLABELLED:-}"',
    'APOLLO_ROLES=(app)',
    'apollo_state_prepare',
    'apollo_container_for_role() { printf "%s" "$APOLLO_E2E_TARGET"; }',
  ].join('\n')
  return new Promise((resolveRun) => {
    const child = spawn('bash', ['-c', `${preamble}\n${snippet}`], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        APOLLO_OPS_STATE_DIR: stateDir,
        APOLLO_RESOURCE_PROFILE: 'isolated-ci',
        APOLLO_IMAGE: IMAGE,
        // The runner is not root, so it cannot chown the state directory to root:1000 the
        // way the VPS deploy does; the suite widened its own temp directory instead. The
        // seam is refused on shared-production, where the real grant is the only path.
        APOLLO_DEPLOY_SKIP_CHOWN: '1',
        APOLLO_OPS_BACKEND_WAIT_ATTEMPTS: '2',
        APOLLO_OPS_BACKEND_WAIT_SLEEP_S: '1',
        ...overrides,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (status) => resolveRun({ status, stdout, stderr }))
  })
}

async function stateDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'apollo-real-docker-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  // The runner creates this as its own user, and every container mounting it runs as the
  // image's `node` user (uid 1000). On the VPS the deploy grants that access itself, with
  // ownership it has as root; here the suite widens its own throwaway directory instead —
  // keeping the sticky bit, which is the half that actually protects the latch.
  await chmod(directory, 0o1777)
  return directory
}

test('a stop is a claim only after the daemon confirms a terminal state', { skip: !RUN }, async (t) => {
  const stateDir = await stateDirectory(t)
  const name = `apollo-e2e-app-${runId}`
  const id = startContainer(name, { 'apollo.managed': 'true', 'apollo.role': 'app', 'apollo.deployment': runId })
  assert.equal(inspect(name, '{{.State.Running}}'), 'true')
  assert.ok(Number(inspect(name, '{{.State.Pid}}')) > 0, 'a running container has a pid')

  await publishHealthyWindow(stateDir)
  const stopped = await runDeployFunction(stateDir, 'apollo_stop_confirmed "$APOLLO_E2E_TARGET" app', { APOLLO_E2E_TARGET: name })
  assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`)

  // The three facts the script refuses to assume.
  assert.ok(['exited', 'dead'].includes(inspect(name, '{{.State.Status}}')), 'the container reached a terminal state')
  assert.equal(inspect(name, '{{.State.Pid}}'), '0', 'the daemon reports no process left')
  assert.equal(inspect(name, '{{.Id}}'), id, 'it is the same container we started')
  // The backends check ran inside a real container of the image under test, reading the
  // mounted state directory: the verdict is the production code, not a stub. What it does
  // NOT prove is a real backend disappearing — these containers open no database
  // connection, so the samples say zero because zero is the truth about them. The rule
  // that a non-zero count blocks is proven against fabricated samples in the fake suite.
  const journal = await readFile(join(stateDir, 'journal', `${runId}.ndjson`), 'utf8')
  assert.match(journal, /"step":"stop"[\s\S]*"backends":0/)

  const removed = await runDeployFunction(stateDir, 'apollo_remove_confirmed "$APOLLO_E2E_TARGET"', { APOLLO_E2E_TARGET: name })
  assert.equal(removed.status, 0, removed.stderr)
  const gone = docker('inspect', name)
  assert.notEqual(gone.status, 0, 'the container is gone')
  assert.match(gone.stderr ?? '', /No such object|No such container/)
})

test('a container that ignores SIGTERM is only terminal after the grace period', { skip: !RUN }, async (t) => {
  const stateDir = await stateDirectory(t)
  const name = `apollo-e2e-stubborn-${runId}`
  const created = docker(
    'run',
    '-d',
    '--name',
    name,
    '--label',
    RUN_LABEL,
    '--label',
    'apollo.managed=true',
    '--label',
    'apollo.role=app',
    IMAGE,
    'sh',
    '-c',
    'trap "" TERM; sleep 600',
  )
  assert.equal(created.status, 0, created.stderr)

  const startedAt = Date.now()
  const result = docker('stop', '--timeout', '2', name)
  const elapsed = Date.now() - startedAt
  assert.equal(result.status, 0)
  // The daemon honoured the grace period before killing: a script that assumed the
  // container was gone the moment it issued the command would have been wrong for
  // those seconds, which is exactly what the confirmation exists to catch.
  assert.ok(elapsed >= 2_000, `stop returned after ${elapsed}ms, expected at least the 2s grace period`)
  assert.ok(['exited', 'dead'].includes(inspect(name, '{{.State.Status}}')))
  assert.equal(inspect(name, '{{.State.Pid}}'), '0')

  // A stop that genuinely fails — the container is already gone — leaves the step
  // inconclusive, and the deploy's reaction is to latch and touch nothing else.
  await publishHealthyWindow(stateDir)
  docker('rm', '-f', name)
  const inconclusive = await runDeployFunction(
    stateDir,
    'apollo_stop_confirmed "$APOLLO_E2E_TARGET" app || apollo_latch_engage step-inconclusive "stop of $APOLLO_E2E_TARGET was not confirmed"',
    { APOLLO_E2E_TARGET: name },
  )
  assert.equal(inconclusive.status, 0, inconclusive.stderr)
  const latch = await readLatch(stateDir)
  assert.equal(latch.engaged, true)
  assert.equal(latch.document.reason, 'step-inconclusive')
  const journal = await readFile(join(stateDir, 'journal', `${runId}.ndjson`), 'utf8')
  assert.match(journal, /"event":"step-inconclusive"/)
  assert.ok(!/"event":"step-done","data":\{"step":"remove"/.test(journal), 'no removal followed the unconfirmed stop')
})

test('an unlabelled container is never touched, and a sentinel survives the run', { skip: !RUN }, async (t) => {
  const stateDir = await stateDirectory(t)
  const sentinel = `apollo-e2e-sentinel-${runId}`
  // Not Apollo-labelled: it stands for somebody else's container on the shared host.
  const sentinelId = startContainer(sentinel, {})
  const legacy = `apollo-e2e-legacy-${runId}`
  const legacyId = startContainer(legacy, { 'some.other.owner': 'true' })

  const blocked = await runDeployFunction(stateDir, 'apollo_require_identity "$APOLLO_E2E_TARGET" app', {
    APOLLO_E2E_TARGET: legacy,
    APOLLO_JOURNAL_ENABLED: '0',
  })
  assert.notEqual(blocked.status, 0)
  assert.match(blocked.stderr, /does not carry apollo\.managed=true and apollo\.role=app/)
  assert.match(blocked.stderr, /--adopt-unlabelled/)
  assert.equal(inspect(legacy, '{{.State.Running}}'), 'true', 'a blocked container is left running')
  assert.equal(inspect(legacy, '{{.Id}}'), legacyId)

  const adopted = await runDeployFunction(stateDir, 'apollo_require_identity "$APOLLO_E2E_TARGET" app', {
    APOLLO_E2E_TARGET: legacy,
    APOLLO_ADOPT_UNLABELLED: legacy,
  })
  assert.equal(adopted.status, 0, adopted.stderr)
  const journal = await readFile(join(stateDir, 'journal', `${runId}.ndjson`), 'utf8')
  const adoption = journal
    .split('\n')
    .filter((line) => line.includes('"event":"adopt-unlabelled"'))
    .map((line) => JSON.parse(line))
    .at(-1)
  assert.ok(adoption, 'the adoption must leave evidence')
  assert.equal(adoption.data.target.name, legacy)
  assert.equal(adoption.data.observed.image, IMAGE)
  // The evidence names whatever networks the daemon actually reports. It is NOT asserted
  // to be `easypanel`: these containers are started by this suite on the runner's default
  // bridge, and a fake that answered `easypanel` hid that difference.
  assert.match(adoption.data.observed.inspected, new RegExp(`^${IMAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\|\\S+`))

  // The sentinel was never a target and is untouched, same id, still running.
  assert.equal(inspect(sentinel, '{{.Id}}'), sentinelId)
  assert.equal(inspect(sentinel, '{{.State.Running}}'), 'true')
  assert.equal(inspect(sentinel, '{{.RestartCount}}'), '0')
})

test('a quota accepted on the command line is visible in the container cgroup', { skip: !RUN }, async (t) => {
  const stateDir = await stateDirectory(t)
  // The cgroup paths below are v2 only. The deploy refuses anything else, so a runner on
  // v1 must say so plainly rather than fail on a missing file.
  const cgroupVersion = docker('info', '--format', '{{.CgroupVersion}}').stdout.trim()
  assert.equal(cgroupVersion, '2', `this runner reports cgroup version ${cgroupVersion}; the budget requires v2`)
  const name = `apollo-e2e-limits-${runId}`
  const cpus = 0.5
  const memoryBytes = 268_435_456
  const pidsLimit = 64
  startContainer(name, { 'apollo.managed': 'true', 'apollo.role': 'app' }, [
    '--cpus',
    String(cpus),
    '--memory',
    `${memoryBytes}b`,
    '--memory-swap',
    `${memoryBytes}b`,
    '--pids-limit',
    String(pidsLimit),
  ])

  const readback = await runDeployFunction(
    stateDir,
    `apollo_readback_limits "$APOLLO_E2E_TARGET" ${cpus} ${memoryBytes} ${pidsLimit}`,
    { APOLLO_E2E_TARGET: name },
  )
  assert.equal(readback.status, 0, `${readback.stdout}\n${readback.stderr}`)

  // What the daemon reports, and what the kernel actually enforces, agree.
  assert.equal(
    inspect(name, '{{.HostConfig.NanoCpus}}|{{.HostConfig.Memory}}|{{.HostConfig.MemorySwap}}|{{.HostConfig.PidsLimit}}'),
    `${Math.round(cpus * 1e9)}|${memoryBytes}|${memoryBytes}|${pidsLimit}`,
  )
  const cpuMax = docker('exec', name, 'cat', '/sys/fs/cgroup/cpu.max').stdout.trim()
  const memoryMax = docker('exec', name, 'cat', '/sys/fs/cgroup/memory.max').stdout.trim()
  const pidsMax = docker('exec', name, 'cat', '/sys/fs/cgroup/pids.max').stdout.trim()
  const [quota, period] = cpuMax.split(/\s+/).map(Number)
  assert.equal(quota / period, cpus, `cpu.max ${cpuMax} does not express ${cpus} CPUs`)
  assert.equal(Number(memoryMax), memoryBytes, `memory.max is ${memoryMax}`)
  assert.equal(Number(pidsMax), pidsLimit, `pids.max is ${pidsMax}`)

  // And a quota the daemon did not apply is inconclusive rather than a warning.
  const mismatch = await runDeployFunction(
    stateDir,
    `apollo_readback_limits "$APOLLO_E2E_TARGET" 1 ${memoryBytes} ${pidsLimit}`,
    { APOLLO_E2E_TARGET: name },
  )
  assert.notEqual(mismatch.status, 0)
  const journal = await readFile(join(stateDir, 'journal', `${runId}.ndjson`), 'utf8')
  assert.match(journal, /"reason":"limit-readback-mismatch"/)
})

test("the monitor's uid can publish the gate and cannot touch the latch", { skip: !RUN }, async (t) => {
  const stateDir = await stateDirectory(t)
  // The same call the deploy makes immediately before starting the monitor container.
  const prepared = await runDeployFunction(stateDir, 'apollo_state_grant_monitor_access')
  assert.equal(prepared.status, 0, prepared.stderr)
  // The latch belongs to the host side, exactly as it would on the VPS.
  await writeFile(
    join(stateDir, 'latch.json'),
    JSON.stringify({
      schemaVersion: 'apollo-ops-latch/v1',
      engagedAtIso: new Date().toISOString(),
      runId: 'earlier-run',
      reason: 'stop-timeout',
      detail: 'written by the host side',
      evidence: { journal: 'journal/earlier-run.ndjson', lastSampleSeq: 1 },
    }),
    'utf8',
  )

  // One container, mounted the way the monitor is mounted, doing exactly what the
  // monitor does — and then trying what it must never be able to do.
  const probe = docker(
    'run',
    '--rm',
    '--label',
    RUN_LABEL,
    '-v',
    `${stateDir}:/app/ops-state`,
    IMAGE,
    'sh',
    '-c',
    [
      'printf "uid=%s gid=%s\\n" "$(id -u)" "$(id -g)"',
      'printf \'{"seq":1}\\n\' >> /app/ops-state/journal/probe.monitor.ndjson && echo journal=written',
      'printf \'{"state":"open"}\' > /app/ops-state/gate.json.tmp && mv /app/ops-state/gate.json.tmp /app/ops-state/gate.json && echo gate=published',
      'rm -f /app/ops-state/latch.json; echo latch-rm-exit=$?',
      'rm -rf /app/ops-state/lock; echo lock-rm-exit=$?',
    ].join('\n'),
  )
  assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`)
  assert.match(probe.stdout, /uid=1000 gid=1000/, 'the image must still run as the node user')
  // This is the EACCES that killed the first real run: without the grant, neither of
  // these lines can be printed.
  assert.match(probe.stdout, /journal=written/, 'the monitor could not append its journal')
  assert.match(probe.stdout, /gate=published/, 'the monitor could not publish gate.json atomically')
  assert.match(probe.stdout, /latch-rm-exit=[1-9]/, 'a container was able to delete the incident latch')
  assert.ok(existsSync(join(stateDir, 'latch.json')), 'the latch survived a container trying to remove it')
  assert.ok(existsSync(join(stateDir, 'journal', 'probe.monitor.ndjson')))
  assert.ok(existsSync(join(stateDir, 'gate.json')))
  // The workers mount the same directory read-only, so they can read what it published.
  const reader = docker('run', '--rm', '--label', RUN_LABEL, '-v', `${stateDir}:/app/ops-state:ro`, IMAGE, 'sh', '-c', 'cat /app/ops-state/gate.json')
  assert.equal(reader.status, 0, reader.stderr)
  assert.match(reader.stdout, /"state":"open"/)
})

test('two invocations cannot hold the operation lock at once', { skip: !RUN }, async (t) => {
  const stateDir = await stateDirectory(t)
  const acquire = (owner) =>
    runDeployFunction(stateDir, 'apollo_lock_acquire deploy && sleep 2', { APOLLO_RUN_ID_OVERRIDE: `${runId}-${owner}` })
  // Both invocations race for the same mkdir with DIFFERENT identities, so a loser that
  // took the lock over would be visible as a second winner and as a foreign owner.
  const [first, second] = await Promise.all([acquire('a'), acquire('b')])
  const winners = [first, second].filter((result) => result.status === 0)
  const losers = [first, second].filter((result) => result.status !== 0)
  assert.equal(winners.length, 1, `two winners: ${first.stderr}\n${second.stderr}`)
  assert.equal(losers.length, 1)
  // Either refusal is correct: the loser found a complete owner, or it arrived while the
  // winner's owner.json was still being written. What it may never do is take over.
  assert.match(losers[0].stderr, /another operation holds the lock|still being written/)
  assert.ok(!/orphan/i.test(losers[0].stderr), 'a live lock may never be declared an orphan')
  const holder = await readLockOwner(stateDir)
  assert.equal(holder.held, true)
  assert.ok([`${runId}-a`, `${runId}-b`].includes(holder.owner.runId), `unexpected holder ${holder.owner.runId}`)
  // And nothing was archived as an orphan.
  const journalEntries = await readdir(join(stateDir, 'journal')).catch(() => [])
  assert.deepEqual(journalEntries.filter((entry) => entry.includes('orphaned')), [])
})

test('every container this suite created is gone', { skip: !RUN }, async () => {
  for (const id of containersWithRunLabel()) docker('rm', '-f', id)
  assert.deepEqual(containersWithRunLabel(), [], 'the postflight must find no container with this run label')
  // The verdict containers the deploy library starts are not labelled by this suite —
  // they are `--rm` and carry the run id in their name, so their absence is checked too.
  const named = docker('ps', '-a', '--filter', `name=apollo-ops-verdict-${runId}`, '--format', '{{.Names}}').stdout ?? ''
  assert.deepEqual(
    named
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    [],
    'a verdict container outlived its --rm',
  )
})
