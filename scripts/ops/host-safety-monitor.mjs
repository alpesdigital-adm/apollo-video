#!/usr/bin/env node
// Single-owner host safety monitor.
//
//   ./node_modules/.bin/tsx scripts/ops/host-safety-monitor.mjs \
//     --run-id deploy-20260918T2359Z-ab12 --profile isolated-ci \
//     [--state-dir /app/ops-state] [--max-duration-ms 3600000]
//
// It samples the HOST every `sampleIntervalMs` of the resolved policy, appends
// each sample to `journal/<runId>.monitor.ndjson` and republishes `gate.json`.
// `AGENTS.md` line 204 requires the collection to be light, under one owner, and
// to start no browser, worker or pool: this process reads four files under
// `/proc`, performs one bounded health GET, and keeps ONE PostgreSQL observation
// connection for the whole run (`connection_limit=1`,
// `application_name=apollo-ops-monitor-<runId>`), never one per sample.
//
// Failure of the monitor closes the gate (`AGENTS.md` line 205): any error writes
// a closed decision first and only then exits non-zero. SIGTERM stops sampling,
// publishes a last decision, disconnects PostgreSQL and exits 0 — the deploy stops
// this container itself at the end of a green postflight.
//
// No environment value is ever printed or journalled; the only configuration read
// here is the policy catalog and `V2_DATABASE_URL`, which is used to connect and
// never echoed.
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import * as importedPolicy from '../../src/v2/infrastructure/host-safety/policy.ts'
import * as importedCollector from '../../src/v2/infrastructure/host-safety/linux-collector.ts'
import * as importedGateFile from '../../src/v2/infrastructure/host-safety/gate-file.ts'
import * as importedJournal from '../../src/v2/infrastructure/host-safety/journal.ts'
import * as importedLatch from '../../src/v2/infrastructure/host-safety/latch.ts'
import * as importedClock from '../../src/v2/infrastructure/host-safety/host-clock.ts'
import * as importedPrismaClient from '../../src/v2/infrastructure/prisma-postgres/client.ts'

// tsx transpiles TypeScript to CommonJS under this package (no `"type": "module"`),
// so a named export may sit behind `default`; Node's own type stripping exposes it
// directly. Same unwrapping as the worker scripts and the budget CLI.
const policyModule = importedPolicy.evaluateHostSafety ? importedPolicy : importedPolicy.default
const collectorModule = importedCollector.createLinuxHostSampler ? importedCollector : importedCollector.default
const gateModule = importedGateFile.writeGateFile ? importedGateFile : importedGateFile.default
const journalModule = importedJournal.createOperationJournal ? importedJournal : importedJournal.default
const latchModule = importedLatch.readLatch ? importedLatch : importedLatch.default
const clockModule = importedClock.hostMonotonicNowMs ? importedClock : importedClock.default
const prismaModule = importedPrismaClient.createV2PostgresClient ? importedPrismaClient : importedPrismaClient.default

const { evaluateHostSafety, resolveHostSafetyPolicy, selectPhaseWindowSamples } = policyModule
const { createLinuxHostSampler } = collectorModule
const { writeGateFile } = gateModule
const { createOperationJournal } = journalModule
const { readLatch } = latchModule
const { hostMonotonicNowMs } = clockModule
const { createV2PostgresClient } = prismaModule

const SHIPPED_CATALOG = 'config/host-safety-policy.json'
const root = resolve(import.meta.dirname, '..', '..')
const MAXIMUM_DURATION_LIMIT_MS = 6 * 60 * 60 * 1000

function parseArguments(argv) {
  const options = {
    runId: null,
    profile: null,
    stateDir: process.env.APOLLO_OPS_STATE_DIR ?? null,
    healthUrl: process.env.APOLLO_OPS_HEALTH_URL ?? null,
    catalog: SHIPPED_CATALOG,
    maxDurationMs: 3_600_000,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`${argument} requires a value`)
      index += 1
      return next
    }
    switch (argument) {
      case '--run-id':
        options.runId = value()
        break
      case '--profile':
        options.profile = value()
        break
      case '--state-dir':
        options.stateDir = value()
        break
      case '--health-url':
        options.healthUrl = value()
        break
      case '--catalog':
        options.catalog = value()
        break
      case '--max-duration-ms':
        options.maxDurationMs = Number(value())
        break
      default:
        throw new Error(`unknown argument ${argument}`)
    }
  }
  if (!options.runId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(options.runId)) {
    throw new Error('--run-id is required and must be a short identifier')
  }
  if (!options.profile) throw new Error('--profile is required')
  if (!options.stateDir) throw new Error('--state-dir or APOLLO_OPS_STATE_DIR is required')
  if (!options.healthUrl) throw new Error('--health-url or APOLLO_OPS_HEALTH_URL is required')
  // Belt and braces with the shell's seam refusal: even if something managed to pass a
  // substituted catalog here, the shared production host is judged by the policy that
  // shipped in the image and by nothing else.
  if (options.profile === 'shared-production' && options.catalog !== SHIPPED_CATALOG) {
    throw new Error(`--catalog must be ${SHIPPED_CATALOG} when --profile is shared-production`)
  }
  if (!Number.isFinite(options.maxDurationMs) || options.maxDurationMs <= 0 || options.maxDurationMs > MAXIMUM_DURATION_LIMIT_MS) {
    throw new Error(`--max-duration-ms must be in (0, ${MAXIMUM_DURATION_LIMIT_MS}]`)
  }
  return options
}

let options
try {
  options = parseArguments(process.argv.slice(2))
} catch (error) {
  console.error(`host-safety-monitor: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}

const catalog = JSON.parse(await readFile(resolve(root, options.catalog), 'utf8'))
const resolution = resolveHostSafetyPolicy({ catalog, profile: options.profile })

const journal = await createOperationJournal({
  stateDir: options.stateDir,
  runId: options.runId,
  stream: 'monitor',
  now: () => new Date(),
  monotonicNow: hostMonotonicNowMs,
})

let seq = 0
async function publishGate(state, reasons, ttlMs) {
  seq += 1
  await writeGateFile({
    stateDir: options.stateDir,
    state,
    reasons,
    seq,
    issuedAtIso: new Date().toISOString(),
    issuedAtMonotonicMs: hostMonotonicNowMs(),
    ttlMs,
    owner: { runId: options.runId, kind: 'monitor', pid: process.pid },
  })
}

if (!resolution.ok) {
  // An unconfigured policy cannot judge anything, so it judges nothing open.
  await publishGate('closed', ['policy-unconfigured'], 30_000)
  await journal.append('monitor-stopped', { reason: 'policy-unconfigured', errors: resolution.errors })
  for (const error of resolution.errors) console.error(`host-safety-monitor: ${error}`)
  process.exit(2)
}

const policy = resolution.policy
const ttlMs = policy.observation.sampleIntervalMs * 3
const client = createV2PostgresClient(observationDatabaseUrl(process.env.V2_DATABASE_URL, options.runId))

function observationDatabaseUrl(databaseUrl, runId) {
  if (typeof databaseUrl !== 'string' || databaseUrl.length === 0) return databaseUrl
  let url
  try {
    url = new URL(databaseUrl)
  } catch {
    return databaseUrl
  }
  // One connection for the whole run, named so a leak is attributable and so the
  // deploy can tell the monitor's own backend apart from a container's.
  url.searchParams.set('application_name', `apollo-ops-monitor-${runId}`)
  url.searchParams.set('connection_limit', '1')
  url.searchParams.set('pool_timeout', '10')
  url.searchParams.set('connect_timeout', '10')
  return url.toString()
}

const sampler = createLinuxHostSampler({
  readFile: (path) => readFile(path, 'utf8'),
  monotonicNow: hostMonotonicNowMs,
  now: () => new Date(),
  fetchHealth: (url, init) => fetch(url, { ...init, method: 'GET', cache: 'no-store' }),
  queryPostgres: (sql) => client.$queryRawUnsafe(sql),
  healthUrl: options.healthUrl,
  healthTimeoutMs: 2_000,
  procRoot: process.env.APOLLO_OPS_PROC_ROOT ?? '/proc',
})

const controller = new AbortController()
process.once('SIGINT', () => controller.abort())
process.once('SIGTERM', () => controller.abort())

function waitForNextSample(intervalMs) {
  return new Promise((resolveWait) => {
    const finish = () => {
      clearTimeout(timeout)
      controller.signal.removeEventListener('abort', finish)
      resolveWait()
    }
    const timeout = setTimeout(finish, intervalMs)
    controller.signal.addEventListener('abort', finish, { once: true })
  })
}

const startedAtMonotonicMs = hostMonotonicNowMs()
const samples = []
let exitCode = 0
await journal.append('monitor-started', {
  profile: policy.profile,
  sampleIntervalMs: policy.observation.sampleIntervalMs,
  maxDurationMs: options.maxDurationMs,
  pid: process.pid,
})

try {
  // Prime the CPU delta: the first read has no previous snapshot, so it yields no
  // sample rather than a fabricated 0%.
  await sampler.sample()
  while (!controller.signal.aborted) {
    await waitForNextSample(policy.observation.sampleIntervalMs)
    if (controller.signal.aborted) break
    const sample = await sampler.sample()
    if (sample) {
      samples.push(sample)
      await journal.append('host-sample', sample)
    }
    const latch = await readLatch(options.stateDir)
    const verdict = evaluateHostSafety({
      samples: selectPhaseWindowSamples({ samples, phase: 'during', policy }),
      nowMonotonicMs: hostMonotonicNowMs(),
      policy,
      phase: 'during',
      latchEngaged: latch.engaged,
    })
    await publishGate(verdict.admit ? 'open' : 'closed', verdict.reasons, ttlMs)
    if (hostMonotonicNowMs() - startedAtMonotonicMs > options.maxDurationMs) {
      await journal.append('monitor-stopped', { reason: 'max-duration-reached' })
      throw new Error('monitor reached its maximum duration without being stopped')
    }
  }
  await publishGate('closed', ['sample-missing'], ttlMs)
  await journal.append('monitor-stopped', { reason: 'signal', sampleCount: samples.length })
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  try {
    await publishGate('closed', ['sample-missing'], ttlMs)
    await journal.append('monitor-stopped', { reason: 'failure', message })
  } catch (writeError) {
    console.error(`host-safety-monitor: could not publish the closed gate: ${String(writeError)}`)
  }
  console.error(`host-safety-monitor: ${message}`)
  exitCode = 1
} finally {
  await client.$disconnect()
}

process.exit(exitCode)
