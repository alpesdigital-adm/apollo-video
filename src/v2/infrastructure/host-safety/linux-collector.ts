/**
 * Linux adapter that turns one host into the samples `policy.ts` judges.
 *
 * Everything it reads is cheap and read-only: four files under `/proc`, one
 * bounded HTTP GET, and three statements on a single observation connection that
 * belongs to the run. `AGENTS.md` line 204 requires the collection itself to be
 * light, under the same owner, and to start no browser, worker or pool — so this
 * module owns no client, opens no pool and spawns no process: the HTTP and
 * PostgreSQL seams are injected and the caller decides their lifetime.
 *
 * ### Why `/proc` and not `os` helpers
 *
 * Inside a container `/proc/stat`, `/proc/loadavg`, `/proc/meminfo` and
 * `/proc/vmstat` are NOT namespaced: they describe the HOST. That is exactly
 * what the policy needs — the owner shares this machine with other services, and
 * a container-scoped number would describe Apollo's own slice and hide the
 * neighbour. For the same reason the CPU count comes from counting `cpuN` lines
 * of `/proc/stat` rather than from `os.cpus().length` (which happens to be the
 * host count too, but is not the file the ratio is derived from) and never from
 * the container's CPU quota.
 *
 * ### The arithmetic (the authoritative definition lives in `policy.ts`)
 *
 * From the delta of the aggregate `cpu` line between two reads:
 * `total = user + nice + system + idle + iowait + irq + softirq + steal`;
 * `busy = (user + nice + system + irq + softirq) / total`;
 * `steal = steal / total`; `iowait = iowait / total`.
 * `guest`/`guest_nice` are excluded because the kernel already counts them
 * inside `user`/`nice`. Steal sits in the denominator but outside `busy`, so CPU
 * used and steal are reported separately as `AGENTS.md` line 175 demands.
 *
 * A first call has no previous read and therefore no delta: it primes and
 * answers `null`. Two reads that produced no jiffies at all also answer `null`
 * rather than a fabricated 0%.
 */

import type {
  HostHealthObservation,
  HostPostgresObservation,
  HostSample,
} from './policy.ts'

export interface ProcStatSnapshot {
  readonly user: number
  readonly nice: number
  readonly system: number
  readonly idle: number
  readonly iowait: number
  readonly irq: number
  readonly softirq: number
  readonly steal: number
  /** Number of `cpuN` lines: the host's CPU count. */
  readonly cpuCount: number
}

export interface CpuDeltaRatios {
  readonly busy: number
  readonly steal: number
  readonly iowait: number
  readonly totalJiffies: number
}

const STAT_FIELDS = ['user', 'nice', 'system', 'idle', 'iowait', 'irq', 'softirq', 'steal'] as const

/** Parses `/proc/stat`. Throws only when the aggregate line is absent or unusable. */
export function parseProcStat(content: string): ProcStatSnapshot {
  let aggregate: number[] | null = null
  let cpuCount = 0
  for (const line of content.split('\n')) {
    if (line.startsWith('cpu ')) {
      const fields = line.trim().split(/\s+/).slice(1).map(Number)
      if (fields.length < STAT_FIELDS.length || fields.some((value) => !Number.isFinite(value) || value < 0)) {
        throw new Error('/proc/stat aggregate cpu line is not a list of counters')
      }
      aggregate = fields
      continue
    }
    if (/^cpu\d+\s/.test(line)) cpuCount += 1
  }
  if (!aggregate) throw new Error('/proc/stat has no aggregate cpu line')
  if (cpuCount < 1) throw new Error('/proc/stat has no per-CPU lines to count')
  const [user, nice, system, idle, iowait, irq, softirq, steal] = aggregate
  return { user, nice, system, idle, iowait, irq, softirq, steal, cpuCount }
}

/**
 * Ratios of the delta between two `/proc/stat` reads, or `null` when no jiffies
 * elapsed (identical reads) or a counter went backwards (a reset we will not
 * average over).
 */
export function cpuDeltaRatios(previous: ProcStatSnapshot, current: ProcStatSnapshot): CpuDeltaRatios | null {
  const delta: Record<string, number> = {}
  for (const field of STAT_FIELDS) {
    const value = current[field] - previous[field]
    if (value < 0) return null
    delta[field] = value
  }
  const total = STAT_FIELDS.reduce((sum, field) => sum + delta[field], 0)
  if (total <= 0) return null
  const busy = delta.user + delta.nice + delta.system + delta.irq + delta.softirq
  return {
    busy: busy / total,
    steal: delta.steal / total,
    iowait: delta.iowait / total,
    totalJiffies: total,
  }
}

/** Parses `load1` out of `/proc/loadavg`. */
export function parseLoadAverage(content: string): number {
  const load1 = Number(content.trim().split(/\s+/)[0])
  if (!Number.isFinite(load1) || load1 < 0) throw new Error('/proc/loadavg does not start with load1')
  return load1
}

/** Parses `MemAvailable` out of `/proc/meminfo`, in bytes. */
export function parseMemoryAvailableBytes(content: string): number {
  for (const line of content.split('\n')) {
    const match = /^MemAvailable:\s+(\d+)\s+kB$/.exec(line.trim())
    if (match) return Number(match[1]) * 1024
  }
  throw new Error('/proc/meminfo has no MemAvailable line')
}

/**
 * Parses the cumulative global `oom_kill` counter out of `/proc/vmstat`.
 *
 * Its absence is a collector failure, not a zero: a host whose kernel cannot
 * report OOM kills cannot satisfy the "no recent OOM" precondition, and
 * answering 0 would turn an unobservable metric into a green light.
 */
export function parseOomKillTotal(content: string): number {
  for (const line of content.split('\n')) {
    const match = /^oom_kill\s+(\d+)$/.exec(line.trim())
    if (match) return Number(match[1])
  }
  throw new Error('/proc/vmstat has no oom_kill counter')
}

export interface HostHealthProbeInput {
  readonly url: string
  readonly timeoutMs: number
}

export interface LinuxHostSamplerInput {
  /** Reads one absolute path as UTF-8; injected so fixtures can stand in for `/proc`. */
  readonly readFile: (path: string) => Promise<string>
  /** Monotonic milliseconds; never a wall clock. */
  readonly monotonicNow: () => number
  /** Wall clock, for the human-readable timestamp only. */
  readonly now: () => Date
  /** `fetch`-shaped seam for the single bounded health GET. */
  readonly fetchHealth: (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>
  /**
   * Runs one statement on the run's single observation connection. The caller
   * owns that connection: this module never creates or closes one.
   */
  readonly queryPostgres: (sql: string) => Promise<readonly Record<string, unknown>[]>
  readonly healthUrl: string
  /** Bounded by contract: `AGENTS.md` forbids a heavy probe. Must be <= 2000 ms. */
  readonly healthTimeoutMs?: number
  readonly procRoot?: string
}

export interface LinuxHostSampler {
  /** One observation, or `null` while there is no usable CPU delta yet. */
  readonly sample: () => Promise<HostSample | null>
}

export const HOST_HEALTH_TIMEOUT_LIMIT_MS = 2_000

/** The three statements the deploy and the policy depend on, in one place. */
export const POSTGRES_OBSERVATION_STATEMENTS = Object.freeze({
  connections: 'select count(*) from pg_stat_activity',
  maxConnections: 'show max_connections',
  backends: 'select application_name, count(*) from pg_stat_activity group by 1',
})

function firstNumber(rows: readonly Record<string, unknown>[], keys: readonly string[]): number | null {
  const row = rows[0]
  if (!row) return null
  for (const key of keys) {
    if (key in row) {
      const value = Number(row[key])
      if (Number.isFinite(value)) return value
    }
  }
  for (const value of Object.values(row)) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric
  }
  return null
}

/**
 * Builds the sampler. Every effect is injected, so the unit tests prove the
 * arithmetic against fixture files and the Linux e2e proves the same code against
 * a real `/proc` on a CI runner.
 */
export function createLinuxHostSampler(input: LinuxHostSamplerInput): LinuxHostSampler {
  const procRoot = input.procRoot ?? '/proc'
  const healthTimeoutMs = input.healthTimeoutMs ?? HOST_HEALTH_TIMEOUT_LIMIT_MS
  if (!Number.isFinite(healthTimeoutMs) || healthTimeoutMs <= 0 || healthTimeoutMs > HOST_HEALTH_TIMEOUT_LIMIT_MS) {
    throw new Error(`healthTimeoutMs must be in (0, ${HOST_HEALTH_TIMEOUT_LIMIT_MS}]`)
  }

  let previousStat: ProcStatSnapshot | null = null
  let firstOomTotal: number | null = null
  let previousOomTotal: number | null = null
  let lastOomIncreaseMonotonicMs: number | null = null
  let seq = 0

  async function probeHealth(): Promise<HostHealthObservation> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), healthTimeoutMs)
    const startedAt = input.monotonicNow()
    try {
      const response = await input.fetchHealth(input.healthUrl, { signal: controller.signal })
      const latencyMs = Math.max(0, input.monotonicNow() - startedAt)
      return {
        ok: response.ok === true && response.status >= 200 && response.status < 300,
        statusCode: Number.isSafeInteger(response.status) ? response.status : null,
        latencyMs,
        error: response.ok === true ? null : `health responded ${String(response.status)}`,
      }
    } catch (error) {
      return {
        ok: false,
        statusCode: null,
        latencyMs: Math.max(0, input.monotonicNow() - startedAt),
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  async function observePostgres(): Promise<HostPostgresObservation | null> {
    try {
      const [connectionRows, maximumRows, backendRows] = await Promise.all([
        input.queryPostgres(POSTGRES_OBSERVATION_STATEMENTS.connections),
        input.queryPostgres(POSTGRES_OBSERVATION_STATEMENTS.maxConnections),
        input.queryPostgres(POSTGRES_OBSERVATION_STATEMENTS.backends),
      ])
      const connections = firstNumber(connectionRows, ['count'])
      const maxConnections = firstNumber(maximumRows, ['max_connections'])
      if (connections === null || maxConnections === null || maxConnections <= 0) return null
      const backendsByApplicationName: Record<string, number> = {}
      for (const row of backendRows) {
        const name = typeof row.application_name === 'string' ? row.application_name : ''
        const count = Number(row.count)
        if (!Number.isFinite(count)) continue
        backendsByApplicationName[name] = (backendsByApplicationName[name] ?? 0) + count
      }
      return { connections, maxConnections, backendsByApplicationName }
    } catch {
      // An unobtainable count is inconclusive; the policy closes on `null`.
      return null
    }
  }

  return {
    async sample(): Promise<HostSample | null> {
      const monotonicMs = input.monotonicNow()
      const [statContent, loadContent, memoryContent, vmstatContent] = await Promise.all([
        input.readFile(`${procRoot}/stat`),
        input.readFile(`${procRoot}/loadavg`),
        input.readFile(`${procRoot}/meminfo`),
        input.readFile(`${procRoot}/vmstat`),
      ])
      const stat = parseProcStat(statContent)
      const oomTotal = parseOomKillTotal(vmstatContent)
      if (firstOomTotal === null) firstOomTotal = oomTotal
      if (previousOomTotal !== null && oomTotal > previousOomTotal) lastOomIncreaseMonotonicMs = monotonicMs
      previousOomTotal = oomTotal

      const ratios = previousStat ? cpuDeltaRatios(previousStat, stat) : null
      previousStat = stat
      if (!ratios) return null

      const [health, postgres] = await Promise.all([probeHealth(), observePostgres()])
      seq += 1
      return {
        seq,
        monotonicMs,
        capturedAtIso: input.now().toISOString(),
        cpu: { busy: ratios.busy, steal: ratios.steal, iowait: ratios.iowait },
        hostCpus: stat.cpuCount,
        load1: parseLoadAverage(loadContent),
        memoryAvailableBytes: parseMemoryAvailableBytes(memoryContent),
        oom: {
          total: oomTotal,
          sinceRunStart: oomTotal - firstOomTotal,
          lastIncreaseMonotonicMs: lastOomIncreaseMonotonicMs,
        },
        postgres,
        health,
      }
    },
  }
}
