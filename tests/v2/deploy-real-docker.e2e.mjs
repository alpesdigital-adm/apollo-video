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
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'

import { hostMonotonicNowMs } from '../../src/v2/infrastructure/host-safety/host-clock.ts'
import { writeGateFile } from '../../src/v2/infrastructure/host-safety/gate-file.ts'
import { createOperationJournal } from '../../src/v2/infrastructure/host-safety/journal.ts'
import { readLatch } from '../../src/v2/infrastructure/host-safety/latch.ts'
import { readLockOwner } from '../../src/v2/infrastructure/host-safety/lock.ts'

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
  return listed.stdout
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
    `APOLLO_RUN_ID='${runId}'`,
    "APOLLO_ADOPT_UNLABELLED=''",
    'APOLLO_ROLES=(app)',
    'apollo_state_paths',
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
  // mounted state directory: the verdict is the production code, not a stub.
  const journal = await readFile(join(stateDir, 'journal', `${runId}.ndjson`), 'utf8')
  assert.match(journal, /"step":"stop"[\s\S]*"backends":0/)

  const removed = await runDeployFunction(stateDir, 'apollo_remove_confirmed "$APOLLO_E2E_TARGET"', { APOLLO_E2E_TARGET: name })
  assert.equal(removed.status, 0, removed.stderr)
  assert.equal(docker('inspect', name).status !== 0, true, 'the container is gone')
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
  assert.match(journal, /"event":"adopt-unlabelled"/)

  // The sentinel was never a target and is untouched, same id, still running.
  assert.equal(inspect(sentinel, '{{.Id}}'), sentinelId)
  assert.equal(inspect(sentinel, '{{.State.Running}}'), 'true')
  assert.equal(inspect(sentinel, '{{.RestartCount}}'), '0')
})

test('a quota accepted on the command line is visible in the container cgroup', { skip: !RUN }, async (t) => {
  const stateDir = await stateDirectory(t)
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

test('two invocations cannot hold the operation lock at once', { skip: !RUN }, async (t) => {
  const stateDir = await stateDirectory(t)
  const acquire = (owner) =>
    runDeployFunction(stateDir, 'apollo_lock_acquire deploy && sleep 2', { APOLLO_RUN_ID_OVERRIDE: owner })
  // Both invocations race for the same mkdir; exactly one may win.
  const [first, second] = await Promise.all([acquire('a'), acquire('b')])
  const winners = [first, second].filter((result) => result.status === 0)
  const losers = [first, second].filter((result) => result.status !== 0)
  assert.equal(winners.length, 1, `${first.stderr}\n${second.stderr}`)
  assert.equal(losers.length, 1)
  assert.match(losers[0].stderr, /another operation holds the lock/)
  const holder = await readLockOwner(stateDir)
  assert.equal(holder.held, true)
  assert.equal(holder.owner.runId, runId)
})

test('every container this suite created is gone', { skip: !RUN }, async () => {
  for (const id of containersWithRunLabel()) docker('rm', '-f', id)
  assert.deepEqual(containersWithRunLabel(), [], 'the postflight must find no container with this run label')
})
