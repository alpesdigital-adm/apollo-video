// The Linux adapter against a REAL `/proc`, in an isolated environment.
//
// Everything else about the host-safety gate is proven with fixtures and a
// controlled clock, which is the only way to test a 30 s sustained threshold
// without producing 30 s of load. What fixtures cannot prove is that the parser
// matches the files an actual kernel writes: field order, the `kB` suffix, the
// number of `cpuN` lines, the presence of `oom_kill`. This suite reads the real
// files of the CI runner and checks plausibility, never a number — a runner's load
// is not a fact about production.
//
// It is read-only and bounded: four small files, twice, one second apart. It
// generates no load, starts no container, touches no database and asserts nothing
// about the shared production VPS.
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { platform } from 'node:os'
import { test } from 'node:test'

import * as importedCollector from '../../src/v2/infrastructure/host-safety/linux-collector.ts'
import * as importedClock from '../../src/v2/infrastructure/host-safety/host-clock.ts'

// This suite runs under `tsx`, which transpiles the TypeScript modules to CommonJS
// under this package, so a named import of a `.ts` file fails at import time. Namespace
// import, then unwrap — the idiom the worker scripts use for the same reason.
const collectorModule = importedCollector.createLinuxHostSampler ? importedCollector : importedCollector.default
const clockModule = importedClock.hostMonotonicNowMs ? importedClock : importedClock.default
const { cpuDeltaRatios, createLinuxHostSampler, parseLoadAverage, parseMemoryAvailableBytes, parseOomKillTotal, parseProcStat } =
  collectorModule
const { hostMonotonicNowMs } = clockModule

const RUN = process.env.APOLLO_HOST_SAFETY_LINUX_E2E === '1'
const LINUX = platform() === 'linux'

test('the collector reads the real /proc of this Linux host', { skip: !RUN || !LINUX }, async () => {
  const [statContent, loadContent, memoryContent, vmstatContent] = await Promise.all([
    readFile('/proc/stat', 'utf8'),
    readFile('/proc/loadavg', 'utf8'),
    readFile('/proc/meminfo', 'utf8'),
    readFile('/proc/vmstat', 'utf8'),
  ])
  const snapshot = parseProcStat(statContent)
  assert.ok(snapshot.cpuCount >= 1, 'a host has at least one CPU line')
  assert.ok(Number.isSafeInteger(snapshot.cpuCount))
  for (const field of ['user', 'nice', 'system', 'idle', 'iowait', 'irq', 'softirq', 'steal']) {
    assert.ok(Number.isFinite(snapshot[field]) && snapshot[field] >= 0, `${field} must be a counter`)
  }
  assert.ok(parseLoadAverage(loadContent) >= 0)
  assert.ok(parseMemoryAvailableBytes(memoryContent) > 0, 'MemAvailable must be present and positive')
  assert.ok(parseOomKillTotal(vmstatContent) >= 0, 'oom_kill must exist on a supported kernel')

  // `/sys/fs/cgroup` tells us whether the container quota differs from the host:
  // the ratios above are deliberately about the HOST either way.
  const cgroupCpuMax = await stat('/sys/fs/cgroup/cpu.max').then(
    () => readFile('/sys/fs/cgroup/cpu.max', 'utf8'),
    () => null,
  )
  if (cgroupCpuMax) assert.match(cgroupCpuMax.trim(), /^(max|\d+) \d+$/)
})

test('two real samples one second apart give ratios inside [0, 1]', { skip: !RUN || !LINUX }, async () => {
  const first = parseProcStat(await readFile('/proc/stat', 'utf8'))
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_000))
  const second = parseProcStat(await readFile('/proc/stat', 'utf8'))
  const ratios = cpuDeltaRatios(first, second)
  assert.ok(ratios, 'one second of a live host must produce jiffies')
  for (const key of ['busy', 'steal', 'iowait']) {
    assert.ok(ratios[key] >= 0 && ratios[key] <= 1, `${key} must be a ratio, observed ${ratios[key]}`)
  }
  assert.ok(ratios.busy + ratios.steal + ratios.iowait <= 1 + 1e-9, 'busy, steal and iowait never overlap')
  assert.ok(ratios.totalJiffies > 0)
})

test('the sampler produces one complete sample from the real host', { skip: !RUN || !LINUX }, async () => {
  // The HTTP and PostgreSQL seams are stubbed on purpose: this suite is the proof
  // of the /proc adapter. The application and database halves are proven by the
  // unit tests and by the deploy e2e, which have something real to talk to.
  const sampler = createLinuxHostSampler({
    readFile: (path) => readFile(path, 'utf8'),
    monotonicNow: hostMonotonicNowMs,
    now: () => new Date(),
    fetchHealth: async () => ({ ok: true, status: 200 }),
    queryPostgres: async (sql) => {
      if (sql.includes('max_connections')) return [{ max_connections: '100' }]
      if (sql.includes('group by')) return []
      return [{ count: 1 }]
    },
    healthUrl: 'http://127.0.0.1:3333/v1/health',
  })
  assert.equal(await sampler.sample(), null, 'the first read only primes the CPU delta')
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_000))
  const sample = await sampler.sample()
  assert.ok(sample, 'the second read must produce a sample')
  assert.equal(sample.seq, 1)
  assert.ok(sample.hostCpus >= 1)
  assert.ok(sample.load1 >= 0)
  assert.ok(sample.memoryAvailableBytes > 0)
  assert.ok(sample.cpu.busy >= 0 && sample.cpu.busy <= 1)
  assert.ok(sample.cpu.steal >= 0 && sample.cpu.steal <= 1)
  assert.equal(sample.oom.sinceRunStart, 0, 'a one-second window must not contain an OOM of this run')
  assert.equal(sample.postgres.maxConnections, 100)
  assert.equal(sample.health.ok, true)
  assert.ok(sample.monotonicMs > 0, 'CLOCK_MONOTONIC is measured since boot, so it is always positive')
})
