// Shared world for the suites that drive the real deploy script against the fake
// Docker of this directory.
//
// It lives under `tests/fixtures/` rather than in one of the suites because two
// suites need it: the fast one that runs inside `npm test`, and the slower one that
// walks the whole fleet and therefore has its own CI step. Duplicating it would mean
// the two halves of the same proof could drift apart.
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { hostMonotonicNowMs } from '../../../../src/v2/infrastructure/host-safety/host-clock.ts'
import { writeGateFile } from '../../../../src/v2/infrastructure/host-safety/gate-file.ts'
import { createOperationJournal, readJournalLines } from '../../../../src/v2/infrastructure/host-safety/journal.ts'

export const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', '..', '..')
export const deployScript = join(repositoryRoot, 'infra', 'deploy', 'apollo-vps.sh')
export const fakeDockerDirectory = join(repositoryRoot, 'tests', 'fixtures', 'host-safety', 'fake-docker')

/** A value that must never appear in any journal the deploy writes. */
export const SECRET_VALUE = 'fake-signing-secret-that-is-long-enough-1234567890'

export const APP_ROLES = [
  'app',
  'ingest-worker',
  'render-worker',
  'webhook-worker',
  'long-form-worker',
  'provider-worker',
  'capture-sync-worker',
  'music-analysis-worker',
  'localization-media-worker',
]

/** The boot id the deploy's own helper reports on this machine. */
export const bootId = spawnSync('bash', ['-c', `. '${join(repositoryRoot, 'infra/deploy/lib/common.sh')}'; apollo_boot_id`], {
  encoding: 'utf8',
}).stdout.trim()

// Thresholds are the shipped ones; only the cadence and the window lengths change, so
// the policy being exercised is the production policy. The 60 s preflight and the 5 min
// stability window are proven by tests/v2/host-safety-policy.test.mjs, which also
// asserts that the shipped catalog declares exactly those numbers.
export const TEST_CATALOG = {
  schemaVersion: 'apollo-host-safety-policy/v1',
  thresholds: {
    cpuBusySustainedRatio: 0.5,
    cpuBusySustainedMs: 600,
    cpuBusyPeakRatio: 0.7,
    loadPerCpuRatio: 0.75,
    stealRatio: 0.1,
    memoryAvailableMinimumBytes: 2 * 1024 ** 3,
    postgresConnectionRatio: 0.5,
  },
  windows: { preflightMs: 1_200, postflightMs: 1_200, stabilityMs: 6_000 },
  profiles: {
    'isolated-ci': {
      sampleIntervalMs: 200,
      sampleFreshnessMs: 8_000,
      maxSampleGapMs: 8_000,
      healthLatencyMs: 2_000,
      oomRecentWindowMs: 600_000,
    },
    'local-dev': {
      sampleIntervalMs: 200,
      sampleFreshnessMs: 8_000,
      maxSampleGapMs: 8_000,
      healthLatencyMs: 2_000,
      oomRecentWindowMs: 600_000,
    },
    'shared-production': { sampleIntervalMs: 200, maxSampleGapMs: 8_000 },
  },
}

export const BASE_SCENARIO = {
  cgroupVersion: '2',
  cgroupDriver: 'systemd',
  infoWarnings: [],
  networks: ['easypanel'],
  appContainer: 'apollo-video',
  image: { reference: 'apollo-video:test', id: 'sha256:1111', repoDigests: ['apollo-video@sha256:2222'] },
  configCheckOutput: 'false|300000',
  containers: {},
  behaviour: {},
}

export async function createWorld(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'apollo-deploy-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const stateDir = join(directory, 'ops-state')
  const appRoot = join(directory, 'app-root')
  await mkdir(stateDir, { recursive: true })
  const envFile = join(directory, 'env')
  await writeFile(
    envFile,
    [
      `APOLLO_MEDIA_UPLOAD_SIGNING_SECRET=${SECRET_VALUE}`,
      'APOLLO_MEDIA_UPLOAD_BASE_URL=https://media.example.com',
      'APOLLO_LOCALIZATION_WORKER_ENABLED=false',
      'V2_DATABASE_URL=postgresql://apollo:apollo@postgres:5432/apollo_v2',
    ].join('\n'),
    'utf8',
  )
  const catalogPath = join(directory, 'host-safety-policy.json')
  await writeFile(catalogPath, JSON.stringify({ ...TEST_CATALOG, ...(overrides.catalog ?? {}) }), 'utf8')
  const scenarioPath = join(directory, 'scenario.json')
  await writeFile(scenarioPath, JSON.stringify({ ...BASE_SCENARIO, ...(overrides.scenario ?? {}) }), 'utf8')
  return {
    directory,
    stateDir,
    appRoot,
    envFile,
    catalogPath,
    scenarioPath,
    logPath: join(directory, 'docker.ndjson'),
    dockerStatePath: join(directory, 'docker-state.json'),
    runId: `deploy-test-${Math.random().toString(16).slice(2, 8)}`,
  }
}

// One compile cache for every Node process this suite spawns — the fake `docker`, the
// budget CLI and the verdict all pay TypeScript type-stripping on every start, and the
// deploy starts dozens of them. It changes nothing about what is proven; it is the
// difference between a suite that fits in `npm test` and one that does not.
const compileCache = join(tmpdir(), 'apollo-deploy-suite-compile-cache')

export function environmentFor(world, overrides = {}) {
  return {
    ...process.env,
    NODE_COMPILE_CACHE: compileCache,
    PATH: `${fakeDockerDirectory}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
    APOLLO_OPS_STATE_DIR: world.stateDir,
    APOLLO_RESOURCE_PROFILE: 'isolated-ci',
    APOLLO_OPS_HEALTH_URL: 'http://127.0.0.1:3333/v1/health',
    APOLLO_ENV_FILE: world.envFile,
    APOLLO_IMAGE: 'apollo-video:test',
    APOLLO_APP_ROOT: world.appRoot,
    APOLLO_OPS_POLICY_CATALOG: world.catalogPath,
    APOLLO_DEPLOY_SKIP_CHOWN: '1',
    APOLLO_OPS_POLL_SLEEP_S: '1',
    APOLLO_OPS_BACKEND_WAIT_SLEEP_S: '1',
    APOLLO_OPS_BACKEND_WAIT_ATTEMPTS: '2',
    APOLLO_OPS_HEALTH_SLEEP_S: '1',
    APOLLO_OPS_PREFLIGHT_TIMEOUT_S: '20',
    APOLLO_OPS_POSTFLIGHT_TIMEOUT_S: '20',
    APOLLO_FAKE_DOCKER_LOG: world.logPath,
    APOLLO_FAKE_DOCKER_SCENARIO: world.scenarioPath,
    APOLLO_FAKE_DOCKER_STATE: world.dockerStatePath,
    APOLLO_FAKE_DOCKER_STATE_DIR: world.stateDir,
    APOLLO_FAKE_DOCKER_REPO: repositoryRoot,
    ...overrides,
  }
}

/**
 * Runs the deploy and resolves with its output.
 *
 * Asynchronous on purpose: `spawnSync` would block this process's event loop, and the
 * simulated monitor publishes from a timer in this process — with a synchronous spawn
 * the gate would go stale while the deploy waited for it, and every run would fail for
 * a reason that has nothing to do with the script.
 */
export function runDeploy(world, args, overrides = {}) {
  return new Promise((resolveRun) => {
    const child = spawn('bash', [deployScript, ...args, '--run-id', world.runId], {
      env: environmentFor(world, overrides),
      cwd: repositoryRoot,
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

/**
 * Runs one snippet against the deploy's own libraries, with the fake Docker on PATH.
 *
 * It exists so a single host-side rule can be exercised in half a second instead of
 * through a whole deploy: the rule is the same function the deploy calls, sourced from
 * the same file, with journalling switched off.
 */
export function runDeployFunction(world, snippet, overrides = {}) {
  const preamble = [
    `. '${join(repositoryRoot, 'infra/deploy/lib/common.sh')}'`,
    `. '${join(repositoryRoot, 'infra/deploy/lib/state.sh')}'`,
    `. '${join(repositoryRoot, 'infra/deploy/lib/docker.sh')}'`,
    `. '${join(repositoryRoot, 'infra/deploy/lib/ops.sh')}'`,
    'APOLLO_JOURNAL_ENABLED=0',
    `APOLLO_RUN_ID='${world.runId}'`,
    "APOLLO_ADOPT_UNLABELLED=''",
    'APOLLO_ROLES=(app render-worker)',
    'apollo_container_for_role() { case "$1" in app) printf apollo-video ;; *) printf "apollo-video-%s" "$1" ;; esac; }',
  ].join('\n')
  return new Promise((resolveRun) => {
    const child = spawn('bash', ['-c', `${preamble}\n${snippet}`], { env: environmentFor(world, overrides), cwd: repositoryRoot })
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

export function healthySample(seq, monotonicMs, backends = {}) {
  return {
    seq,
    monotonicMs,
    capturedAtIso: new Date().toISOString(),
    cpu: { busy: 0.08, steal: 0.01, iowait: 0.01 },
    hostCpus: 4,
    load1: 0.4,
    memoryAvailableBytes: 8 * 1024 ** 3,
    oom: { total: 0, sinceRunStart: 0, lastIncreaseMonotonicMs: null },
    postgres: { connections: 6, maxConnections: 100, backendsByApplicationName: backends },
    health: { ok: true, statusCode: 200, latencyMs: 9, error: null },
  }
}

/**
 * Stands in for the monitor container the fake Docker only pretends to start: it
 * appends samples and republishes gate.json with an advancing seq, which is what the
 * deploy checks between steps. `closeWhen` lets a test close the gate at a chosen
 * moment in the sequence.
 */
export async function startOpsSimulator(t, world, options = {}) {
  const journal = await createOperationJournal({
    stateDir: world.stateDir,
    runId: world.runId,
    stream: 'monitor',
    now: () => new Date(),
    monotonicNow: hostMonotonicNowMs,
  })
  const simulator = { seq: 0, gateSeq: 0, stopped: false, closed: false }
  const interval = TEST_CATALOG.profiles['isolated-ci'].sampleIntervalMs
  // The fabricated timeline advances one cadence at a time and catches up to real
  // time on every tick. A timer that simply appended one sample per tick would leave
  // holes whenever this process was busy spawning a verdict, and the policy would
  // answer window-incomplete — correctly, which is the point: coverage is measured, so
  // the simulator has to produce a dense timeline rather than a fast one.
  let lastMonotonicMs = hostMonotonicNowMs() - 12 * interval

  async function tick() {
    // The real monitor is stopped by the deploy once the postflight is established, so
    // the simulator stops publishing at the same moment. Without this it would rewrite
    // the gate.json the deploy had just removed and the run would look unfinished.
    const operationJournal = await readFile(join(world.stateDir, 'journal', `${world.runId}.ndjson`), 'utf8').catch(() => '')
    if (operationJournal.includes('"event":"postflight-verdict"')) {
      simulator.stopped = true
      return
    }
    const now = hostMonotonicNowMs()
    while (lastMonotonicMs + interval <= now) {
      lastMonotonicMs += interval
      simulator.seq += 1
      await journal.append('host-sample', healthySample(simulator.seq, lastMonotonicMs, options.backends ?? {}))
    }
    if (!simulator.closed && options.closeWhen && (await options.closeWhen(world))) simulator.closed = true
    simulator.gateSeq += 1
    await writeGateFile({
      stateDir: world.stateDir,
      state: simulator.closed ? 'closed' : 'open',
      reasons: simulator.closed ? ['cpu-busy-peak'] : [],
      seq: simulator.gateSeq,
      issuedAtIso: new Date().toISOString(),
      issuedAtMonotonicMs: hostMonotonicNowMs(),
      ttlMs: interval * 40,
      owner: { runId: world.runId, kind: 'monitor', pid: process.pid },
    })
  }

  // Prime a complete window so the deploy's preflight does not have to wait for it.
  await tick()
  const timer = setInterval(() => {
    if (simulator.stopped) return
    void tick().catch(() => {})
  }, interval)
  const stop = () => {
    simulator.stopped = true
    clearInterval(timer)
  }
  t.after(stop)
  return { simulator, stop }
}

export async function dockerLog(world) {
  const content = await readFile(world.logPath, 'utf8').catch(() => '')
  return content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

export function mutatingVerbs(entries) {
  return entries.filter((entry) => ['run -d', 'stop', 'rm'].includes(entry.verb))
}

export async function operationJournalLines(world) {
  return readJournalLines(join(world.stateDir, 'journal', `${world.runId}.ndjson`))
}

export async function journalEvents(world) {
  return (await operationJournalLines(world)).map((line) => line.event)
}
