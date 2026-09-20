import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'

import {
  HOST_HEALTH_TIMEOUT_LIMIT_MS,
  POSTGRES_OBSERVATION_STATEMENTS,
  cpuDeltaRatios,
  createLinuxHostSampler,
  parseLoadAverage,
  parseMemoryAvailableBytes,
  parseOomKillTotal,
  parseProcStat,
} from '../../src/v2/infrastructure/host-safety/linux-collector.ts'

const fixtures = resolve(import.meta.dirname, '..', 'fixtures', 'host-safety')
const read = (name) => readFile(resolve(fixtures, name), 'utf8')

const [statFirst, statSecond, loadavg, meminfo, vmstat, vmstatAfterOom, vmstatWithoutCounter] = await Promise.all([
  read('proc-stat-first.txt'),
  read('proc-stat-second.txt'),
  read('proc-loadavg.txt'),
  read('proc-meminfo.txt'),
  read('proc-vmstat.txt'),
  read('proc-vmstat-after-oom.txt'),
  read('proc-vmstat-without-oom-counter.txt'),
])

test('the aggregate cpu line and the host CPU count come from /proc/stat', () => {
  const snapshot = parseProcStat(statFirst)
  assert.deepEqual(snapshot, {
    user: 1000,
    nice: 100,
    system: 500,
    idle: 8000,
    iowait: 200,
    irq: 50,
    softirq: 50,
    steal: 100,
    cpuCount: 4,
  })
  assert.equal(parseProcStat(statSecond).cpuCount, 4)
  assert.throws(() => parseProcStat('intr 1\nctxt 2\n'), /no aggregate cpu line/)
  assert.throws(() => parseProcStat('cpu  1 2 3 4 5 6 7 8\n'), /no per-CPU lines/)
  assert.throws(() => parseProcStat('cpu  1 2 3\ncpu0 1 2 3\n'), /not a list of counters/)
})

test('two /proc/stat snapshots give busy, steal and iowait to the last digit', () => {
  const ratios = cpuDeltaRatios(parseProcStat(statFirst), parseProcStat(statSecond))
  // Deltas: user 300, nice 20, system 150, idle 300, iowait 80, irq 25, softirq 25,
  // steal 100 — a total of exactly 1000 jiffies.
  assert.equal(ratios.totalJiffies, 1_000)
  assert.equal(ratios.busy, 0.52)
  assert.equal(ratios.steal, 0.1)
  assert.equal(ratios.iowait, 0.08)
  // guest went 10 -> 60 and guest_nice 5 -> 25 in the same fixtures. The kernel
  // already counts them inside user and nice: adding them would make the total
  // 1070 and busy 0.4859, so these exact numbers are the proof they are excluded.
  assert.notEqual(ratios.totalJiffies, 1_070)
  assert.equal(ratios.busy + ratios.steal + ratios.iowait + 300 / 1_000, 1)
})

test('a counter that went backwards or did not move yields no ratios at all', () => {
  const first = parseProcStat(statFirst)
  const second = parseProcStat(statSecond)
  assert.equal(cpuDeltaRatios(second, first), null)
  assert.equal(cpuDeltaRatios(first, first), null)
})

test('loadavg, MemAvailable and the oom_kill counter are parsed or refused', () => {
  assert.equal(parseLoadAverage(loadavg), 1.25)
  assert.throws(() => parseLoadAverage('nothing here'), /load1/)
  assert.equal(parseMemoryAvailableBytes(meminfo), 3_145_728 * 1024)
  assert.throws(() => parseMemoryAvailableBytes('MemTotal: 1 kB\n'), /MemAvailable/)
  assert.equal(parseOomKillTotal(vmstat), 7)
  assert.equal(parseOomKillTotal(vmstatAfterOom), 9)
  // A kernel that cannot report OOM kills cannot satisfy "no recent OOM"; the
  // absence is an error, never a zero.
  assert.throws(() => parseOomKillTotal(vmstatWithoutCounter), /oom_kill/)
})

function createHarness(options = {}) {
  const calls = { readFile: [], fetchHealth: [], queryPostgres: [] }
  const state = { stat: statFirst, vmstat, monotonic: 1_000_000 }
  const sampler = createLinuxHostSampler({
    readFile: async (path) => {
      calls.readFile.push(path)
      if (path.endsWith('/stat')) return state.stat
      if (path.endsWith('/loadavg')) return loadavg
      if (path.endsWith('/meminfo')) return meminfo
      if (path.endsWith('/vmstat')) return state.vmstat
      throw new Error(`unexpected read of ${path}`)
    },
    monotonicNow: () => state.monotonic,
    now: () => new Date('2026-09-18T23:59:00.000Z'),
    fetchHealth: async (url, init) => {
      calls.fetchHealth.push({ url, hasSignal: init.signal instanceof AbortSignal })
      if (options.health === 'reject') throw new Error('connect ECONNREFUSED')
      if (options.health === 'error') return { ok: false, status: 503 }
      state.monotonic += options.healthLatencyMs ?? 0
      return { ok: true, status: 200 }
    },
    queryPostgres: async (sql) => {
      calls.queryPostgres.push(sql)
      if (options.postgres === 'throw') throw new Error('too many clients already')
      if (sql === POSTGRES_OBSERVATION_STATEMENTS.connections) return [{ count: 37n }]
      if (sql === POSTGRES_OBSERVATION_STATEMENTS.maxConnections) return [{ max_connections: '100' }]
      return [
        { application_name: 'apollo-video-render-worker', count: 3n },
        { application_name: 'apollo-ops-monitor-run-1', count: 1n },
      ]
    },
    healthUrl: 'http://127.0.0.1:3333/v1/health',
    procRoot: '/proc',
    healthTimeoutMs: options.healthTimeoutMs,
  })
  return { sampler, calls, state }
}

test('the first read primes the delta and the second produces one complete sample', async () => {
  const { sampler, calls, state } = createHarness()
  assert.equal(await sampler.sample(), null, 'a single /proc/stat read cannot produce a busy ratio')
  assert.equal(calls.fetchHealth.length, 0, 'priming must not touch the application')
  assert.equal(calls.queryPostgres.length, 0, 'priming must not touch PostgreSQL')

  state.stat = statSecond
  state.monotonic = 1_010_000
  const sample = await sampler.sample()
  assert.equal(sample.seq, 1)
  assert.equal(sample.monotonicMs, 1_010_000)
  assert.equal(sample.capturedAtIso, '2026-09-18T23:59:00.000Z')
  assert.deepEqual(sample.cpu, { busy: 0.52, steal: 0.1, iowait: 0.08 })
  assert.equal(sample.hostCpus, 4)
  assert.equal(sample.load1, 1.25)
  assert.equal(sample.memoryAvailableBytes, 3_145_728 * 1024)
  assert.deepEqual(sample.oom, { total: 7, sinceRunStart: 0, lastIncreaseMonotonicMs: null })
  assert.deepEqual(sample.postgres, {
    connections: 37,
    maxConnections: 100,
    backendsByApplicationName: { 'apollo-video-render-worker': 3, 'apollo-ops-monitor-run-1': 1 },
  })
  assert.deepEqual(sample.health, { ok: true, statusCode: 200, latencyMs: 0, error: null })

  // One bounded GET and exactly the three observation statements per sample: no
  // pool, no per-sample client, nothing the policy calls heavy.
  assert.equal(calls.fetchHealth.length, 1)
  assert.equal(calls.fetchHealth[0].hasSignal, true)
  assert.deepEqual(calls.queryPostgres, [
    POSTGRES_OBSERVATION_STATEMENTS.connections,
    POSTGRES_OBSERVATION_STATEMENTS.maxConnections,
    POSTGRES_OBSERVATION_STATEMENTS.backends,
  ])
  assert.deepEqual(calls.readFile.slice(0, 4), ['/proc/stat', '/proc/loadavg', '/proc/meminfo', '/proc/vmstat'])
})

test('health latency is measured on the monotonic clock and a failure is reported, not hidden', async () => {
  const slow = createHarness({ healthLatencyMs: 1_234 })
  await slow.sampler.sample()
  slow.state.stat = statSecond
  const timed = await slow.sampler.sample()
  assert.equal(timed.health.latencyMs, 1_234)

  const rejected = createHarness({ health: 'reject' })
  await rejected.sampler.sample()
  rejected.state.stat = statSecond
  const failed = await rejected.sampler.sample()
  assert.deepEqual(failed.health, { ok: false, statusCode: null, latencyMs: 0, error: 'connect ECONNREFUSED' })

  const refused = createHarness({ health: 'error' })
  await refused.sampler.sample()
  refused.state.stat = statSecond
  const unhealthy = await refused.sampler.sample()
  assert.equal(unhealthy.health.ok, false)
  assert.equal(unhealthy.health.statusCode, 503)
})

test('an unobtainable connection count becomes an explicit null, not a zero', async () => {
  const harness = createHarness({ postgres: 'throw' })
  await harness.sampler.sample()
  harness.state.stat = statSecond
  const sample = await harness.sampler.sample()
  assert.equal(sample.postgres, null)
})

test('an OOM kill between two samples is timestamped on the monotonic clock', async () => {
  const harness = createHarness()
  await harness.sampler.sample()
  harness.state.stat = statSecond
  harness.state.monotonic = 1_010_000
  const before = await harness.sampler.sample()
  assert.equal(before.oom.lastIncreaseMonotonicMs, null)

  harness.state.vmstat = vmstatAfterOom
  harness.state.monotonic = 1_020_000
  // /proc/stat has not moved, so there is no new CPU delta and therefore no
  // sample; the counter increase is still recorded and surfaces on the next one.
  assert.equal(await harness.sampler.sample(), null)
  harness.state.monotonic = 1_030_000
  const after = await harness.sampler.sample()
  assert.equal(after, null, 'identical /proc/stat reads produce no sample')

  const second = createHarness()
  await second.sampler.sample()
  second.state.stat = statSecond
  second.state.vmstat = vmstatAfterOom
  second.state.monotonic = 1_040_000
  const observed = await second.sampler.sample()
  assert.equal(observed.oom.total, 9)
  assert.equal(observed.oom.sinceRunStart, 2)
  assert.equal(observed.oom.lastIncreaseMonotonicMs, 1_040_000)
})

test('the health probe timeout is bounded by contract', () => {
  assert.equal(HOST_HEALTH_TIMEOUT_LIMIT_MS, 2_000)
  assert.throws(() => createHarness({ healthTimeoutMs: 2_001 }), /healthTimeoutMs/)
  assert.throws(() => createHarness({ healthTimeoutMs: 0 }), /healthTimeoutMs/)
})
