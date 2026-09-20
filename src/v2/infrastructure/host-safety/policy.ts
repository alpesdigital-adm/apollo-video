/**
 * Host safety policy for the shared production VPS.
 *
 * `AGENTS.md` lines 200-216 describe an admission gate in prose: preflight of
 * 60 s sampling every 10 s, monitoring every 10 s during the work, postflight of
 * 60 s, and a list of thresholds that block or interrupt. Until this module
 * existed that section said in so many words that no runtime monitor
 * implemented it. This is the decision half of it: a pure function over samples
 * and a clock, so every boundary can be proven without generating load on any
 * host.
 *
 * Two properties matter more than the arithmetic:
 *
 * 1. **Absence of evidence closes the gate.** A missing sample, a stale sample,
 *    a malformed sample, a sample out of order, a clock that moved backwards, a
 *    window that is not really 60 s long, a threshold the configuration never
 *    declared — each one is a reason to refuse, never a reason to proceed. A
 *    health check answering 200 is one input among many and never proof that the
 *    host is healthy.
 * 2. **Elapsed time is measured, not counted.** Three samples taken one second
 *    apart are three samples and twelve seconds of coverage; they are not a
 *    30 s sustained observation and they are not a 60 s preflight. Coverage is
 *    computed from a monotonic clock, so a wall-clock correction (NTP, a
 *    container restart) cannot forge a window.
 *
 * ### The CPU formula (why steal is neither double-counted nor hidden)
 *
 * The collector reads `/proc/stat` twice and works on the delta of the aggregate
 * `cpu` line, whose fields are, in order: user, nice, system, idle, iowait, irq,
 * softirq, steal, guest, guest_nice.
 *
 * ```
 * total   = user + nice + system + idle + iowait + irq + softirq + steal
 * busy    = (user + nice + system + irq + softirq) / total
 * steal   = steal / total
 * iowait  = iowait / total
 * ```
 *
 * `guest` and `guest_nice` are NOT added to the total: the kernel already counts
 * guest time inside `user` and guest_nice inside `nice`, so adding them again
 * would inflate the denominator and understate every ratio. `steal` is part of
 * the denominator — it is real host time the hypervisor took away — but it is
 * deliberately outside `busy`, because `AGENTS.md` line 175 requires CPU used
 * and steal to be measured separately: a 92% steal event must not appear as 92%
 * of Apollo's own CPU usage, and low steal must never be read as headroom.
 * `iowait` is likewise reported on its own rather than folded into `busy`.
 *
 * The CPU count is the number of `cpuN` lines of `/proc/stat`, which inside a
 * container still reflects the HOST (procfs is not namespaced for these files).
 * It is never the container's CPU quota: `load1 / hostCpus` is a statement about
 * the machine the owner shares with other services, not about Apollo's share.
 *
 * Nothing in this module is product state. No project, version, job or artifact
 * appears here; the only subject is the health of one host.
 */

export const HOST_SAFETY_POLICY_SCHEMA_VERSION = 'apollo-host-safety-policy/v1'

/** Phases of one authorized operation, in the order `AGENTS.md` mandates them. */
export type HostSafetyPhase = 'preflight' | 'during' | 'postflight' | 'stability'

/**
 * Stable reason codes. They are written to the journal and to `gate.json`, read
 * by the deploy and by the workers, and asserted by the tests, so a code is an
 * interface: rename one and you break the evidence trail.
 */
export type HostSafetyReason =
  | 'cpu-busy-sustained'
  | 'cpu-busy-peak'
  | 'load-ratio'
  | 'steal'
  | 'memory-available'
  | 'oom-recent'
  | 'pg-connections'
  | 'health-latency'
  | 'health-error'
  | 'sample-missing'
  | 'sample-stale'
  | 'sample-malformed'
  | 'sample-out-of-order'
  | 'clock-reset'
  | 'window-incomplete'
  | 'policy-unconfigured'
  | 'latch-engaged'

export const HOST_SAFETY_REASONS: readonly HostSafetyReason[] = Object.freeze([
  'cpu-busy-sustained',
  'cpu-busy-peak',
  'load-ratio',
  'steal',
  'memory-available',
  'oom-recent',
  'pg-connections',
  'health-latency',
  'health-error',
  'sample-missing',
  'sample-stale',
  'sample-malformed',
  'sample-out-of-order',
  'clock-reset',
  'window-incomplete',
  'policy-unconfigured',
  'latch-engaged',
])

export interface HostSafetyThresholds {
  /** Busy ratio that blocks when held for `cpuBusySustainedMs` (>=). */
  readonly cpuBusySustainedRatio: number
  readonly cpuBusySustainedMs: number
  /** Busy ratio that blocks on a single sample (>=). */
  readonly cpuBusyPeakRatio: number
  /** `load1 / hostCpus` that blocks (>=). */
  readonly loadPerCpuRatio: number
  /** Steal ratio that blocks (>=). */
  readonly stealRatio: number
  /** Available memory below which work is refused (<). */
  readonly memoryAvailableMinimumBytes: number
  /** Share of `max_connections` above which work is refused (>). */
  readonly postgresConnectionRatio: number
}

export interface HostSafetyWindows {
  readonly preflightMs: number
  readonly postflightMs: number
  readonly stabilityMs: number
}

export interface HostSafetyObservation {
  /** Declared cadence; also the coverage one sample is credited with. */
  readonly sampleIntervalMs: number
  /** How old the newest sample may be before the gate closes. No code default. */
  readonly sampleFreshnessMs: number
  /** Largest tolerated hole between two consecutive samples. */
  readonly maxSampleGapMs: number
  /** Health latency above which the application counts as abnormal. No code default. */
  readonly healthLatencyMs: number
  /** How long an observed OOM kill keeps the gate closed. No code default. */
  readonly oomRecentWindowMs: number
}

export interface HostSafetyPolicy {
  readonly profile: string
  readonly thresholds: HostSafetyThresholds
  readonly windows: HostSafetyWindows
  readonly observation: HostSafetyObservation
}

/** Ratios of one `/proc/stat` delta; see the CPU formula above. */
export interface HostCpuRatios {
  readonly busy: number
  readonly steal: number
  readonly iowait: number
}

export interface HostOomObservation {
  /** `/proc/vmstat` `oom_kill`, a cumulative global counter. */
  readonly total: number
  /** `total` minus the value observed in the run's first sample. */
  readonly sinceRunStart: number
  /** Monotonic time at which the counter was last seen to increase, if ever. */
  readonly lastIncreaseMonotonicMs: number | null
}

export interface HostPostgresObservation {
  readonly connections: number
  readonly maxConnections: number
  /** `application_name` → backend count; how a stopped container is confirmed gone. */
  readonly backendsByApplicationName: Readonly<Record<string, number>>
}

export interface HostHealthObservation {
  readonly ok: boolean
  readonly statusCode: number | null
  readonly latencyMs: number | null
  readonly error: string | null
}

export interface HostSample {
  readonly seq: number
  readonly monotonicMs: number
  readonly capturedAtIso: string
  readonly cpu: HostCpuRatios
  readonly hostCpus: number
  readonly load1: number
  readonly memoryAvailableBytes: number
  readonly oom: HostOomObservation
  /** `null` when the observation connection could not answer: inconclusive, so closed. */
  readonly postgres: HostPostgresObservation | null
  /** `null` when the health probe never answered: an error, so closed. */
  readonly health: HostHealthObservation | null
}

export interface HostSafetyWindowReport {
  readonly phase: HostSafetyPhase
  readonly requiredMs: number
  readonly requiredSamples: number
  readonly sampleCount: number
  readonly validSampleCount: number
  readonly coveredMs: number
  readonly firstMonotonicMs: number | null
  readonly lastMonotonicMs: number | null
  /** `nowMonotonicMs` minus the newest sample; negative means the clock moved back. */
  readonly ageMs: number | null
  readonly largestGapMs: number | null
  /** Coverage of the trailing run of samples at or above the sustained busy ratio. */
  readonly sustainedBusyMs: number
}

export interface HostSafetyVerdict {
  readonly admit: boolean
  readonly reasons: readonly HostSafetyReason[]
  readonly window: HostSafetyWindowReport
}

export interface EvaluateHostSafetyInput {
  /** The phase's samples, oldest first. Unknown on purpose: malformed closes. */
  readonly samples: readonly unknown[]
  readonly nowMonotonicMs: number
  /** A resolved profile; anything invalid answers `policy-unconfigured`. */
  readonly policy: unknown
  readonly phase: HostSafetyPhase
  /** Presence of an incident latch closes every phase regardless of metrics. */
  readonly latchEngaged?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function positiveNumber(value: unknown): value is number {
  return finiteNumber(value) && value > 0
}

function nonNegative(value: unknown): value is number {
  return finiteNumber(value) && value >= 0
}

function ratio(value: unknown): value is number {
  return finiteNumber(value) && value >= 0 && value <= 1
}

/** Reads one profile out of the catalog. Returns the reasons to refuse instead of throwing. */
export function resolveHostSafetyPolicy(input: { readonly catalog: unknown; readonly profile: string }):
  | { readonly ok: true; readonly policy: HostSafetyPolicy }
  | { readonly ok: false; readonly errors: readonly string[] } {
  const errors: string[] = []
  const { catalog, profile: profileName } = input
  if (!isRecord(catalog)) return { ok: false, errors: ['catalog: must be an object'] }
  if (catalog.schemaVersion !== HOST_SAFETY_POLICY_SCHEMA_VERSION) {
    return {
      ok: false,
      errors: [
        `catalog.schemaVersion: expected ${HOST_SAFETY_POLICY_SCHEMA_VERSION}, found ${JSON.stringify(catalog.schemaVersion)}`,
      ],
    }
  }
  const profiles = isRecord(catalog.profiles) ? catalog.profiles : null
  const profile = profiles && isRecord(profiles[profileName]) ? (profiles[profileName] as Record<string, unknown>) : null
  if (!profile) return { ok: false, errors: [`profiles.${profileName}: unknown profile`] }

  const thresholdSource = isRecord(catalog.thresholds) ? catalog.thresholds : {}
  const windowSource = isRecord(catalog.windows) ? catalog.windows : {}
  const requiredRatio = (source: Record<string, unknown>, path: string, key: string): number => {
    const value = source[key]
    if (!ratio(value) || value === 0) {
      errors.push(`${path}.${key}: must be a ratio in (0, 1]`)
      return Number.NaN
    }
    return value
  }
  const requiredPositive = (source: Record<string, unknown>, path: string, key: string): number => {
    const value = source[key]
    if (!positiveNumber(value)) {
      errors.push(`${path}.${key}: must be a positive number`)
      return Number.NaN
    }
    return value
  }

  const thresholds: HostSafetyThresholds = {
    cpuBusySustainedRatio: requiredRatio(thresholdSource, 'thresholds', 'cpuBusySustainedRatio'),
    cpuBusySustainedMs: requiredPositive(thresholdSource, 'thresholds', 'cpuBusySustainedMs'),
    cpuBusyPeakRatio: requiredRatio(thresholdSource, 'thresholds', 'cpuBusyPeakRatio'),
    loadPerCpuRatio: requiredPositive(thresholdSource, 'thresholds', 'loadPerCpuRatio'),
    stealRatio: requiredRatio(thresholdSource, 'thresholds', 'stealRatio'),
    memoryAvailableMinimumBytes: requiredPositive(thresholdSource, 'thresholds', 'memoryAvailableMinimumBytes'),
    postgresConnectionRatio: requiredRatio(thresholdSource, 'thresholds', 'postgresConnectionRatio'),
  }
  const windows: HostSafetyWindows = {
    preflightMs: requiredPositive(windowSource, 'windows', 'preflightMs'),
    postflightMs: requiredPositive(windowSource, 'windows', 'postflightMs'),
    stabilityMs: requiredPositive(windowSource, 'windows', 'stabilityMs'),
  }
  const observationPath = `profiles.${profileName}`
  const observation: HostSafetyObservation = {
    sampleIntervalMs: requiredPositive(profile, observationPath, 'sampleIntervalMs'),
    sampleFreshnessMs: requiredPositive(profile, observationPath, 'sampleFreshnessMs'),
    maxSampleGapMs: requiredPositive(profile, observationPath, 'maxSampleGapMs'),
    healthLatencyMs: requiredPositive(profile, observationPath, 'healthLatencyMs'),
    oomRecentWindowMs: requiredPositive(profile, observationPath, 'oomRecentWindowMs'),
  }
  if (errors.length > 0) return { ok: false, errors: Object.freeze([...errors]) }
  return { ok: true, policy: Object.freeze({ profile: profileName, thresholds, windows, observation }) }
}

function validPolicy(candidate: unknown): HostSafetyPolicy | null {
  if (!isRecord(candidate)) return null
  const { profile, thresholds, windows, observation } = candidate
  if (typeof profile !== 'string' || profile.length === 0) return null
  if (!isRecord(thresholds) || !isRecord(windows) || !isRecord(observation)) return null
  const ratios: (keyof HostSafetyThresholds)[] = ['cpuBusySustainedRatio', 'cpuBusyPeakRatio', 'stealRatio', 'postgresConnectionRatio']
  for (const key of ratios) {
    const value = thresholds[key]
    if (!ratio(value) || value === 0) return null
  }
  for (const key of ['cpuBusySustainedMs', 'loadPerCpuRatio', 'memoryAvailableMinimumBytes'] as const) {
    if (!positiveNumber(thresholds[key])) return null
  }
  for (const key of ['preflightMs', 'postflightMs', 'stabilityMs'] as const) {
    if (!positiveNumber(windows[key])) return null
  }
  for (const key of ['sampleIntervalMs', 'sampleFreshnessMs', 'maxSampleGapMs', 'healthLatencyMs', 'oomRecentWindowMs'] as const) {
    if (!positiveNumber(observation[key])) return null
  }
  return candidate as unknown as HostSafetyPolicy
}

/** Validates one journal sample. A sample that cannot be trusted is not a sample. */
export function parseHostSample(candidate: unknown): HostSample | null {
  if (!isRecord(candidate)) return null
  const { seq, monotonicMs, capturedAtIso, cpu, hostCpus, load1, memoryAvailableBytes, oom, postgres, health } = candidate
  if (!Number.isSafeInteger(seq) || (seq as number) < 0) return null
  if (!nonNegative(monotonicMs)) return null
  if (typeof capturedAtIso !== 'string' || Number.isNaN(Date.parse(capturedAtIso))) return null
  if (!isRecord(cpu) || !ratio(cpu.busy) || !ratio(cpu.steal) || !ratio(cpu.iowait)) return null
  if (!Number.isSafeInteger(hostCpus) || (hostCpus as number) < 1) return null
  if (!nonNegative(load1)) return null
  if (!nonNegative(memoryAvailableBytes)) return null
  if (!isRecord(oom) || !nonNegative(oom.total) || !nonNegative(oom.sinceRunStart)) return null
  if (oom.lastIncreaseMonotonicMs !== null && !nonNegative(oom.lastIncreaseMonotonicMs)) return null
  let parsedPostgres: HostPostgresObservation | null = null
  if (postgres !== null) {
    if (!isRecord(postgres) || !nonNegative(postgres.connections) || !positiveNumber(postgres.maxConnections)) return null
    const backends = isRecord(postgres.backendsByApplicationName) ? postgres.backendsByApplicationName : null
    if (!backends) return null
    for (const count of Object.values(backends)) {
      if (!nonNegative(count)) return null
    }
    parsedPostgres = {
      connections: postgres.connections,
      maxConnections: postgres.maxConnections,
      backendsByApplicationName: backends as Readonly<Record<string, number>>,
    }
  }
  let parsedHealth: HostHealthObservation | null = null
  if (health !== null) {
    if (!isRecord(health) || typeof health.ok !== 'boolean') return null
    if (health.statusCode !== null && !Number.isSafeInteger(health.statusCode)) return null
    if (health.latencyMs !== null && !nonNegative(health.latencyMs)) return null
    if (health.error !== null && typeof health.error !== 'string') return null
    parsedHealth = {
      ok: health.ok,
      statusCode: health.statusCode as number | null,
      latencyMs: health.latencyMs as number | null,
      error: health.error as string | null,
    }
  }
  return {
    seq: seq as number,
    monotonicMs: monotonicMs as number,
    capturedAtIso,
    cpu: { busy: cpu.busy as number, steal: cpu.steal as number, iowait: cpu.iowait as number },
    hostCpus: hostCpus as number,
    load1: load1 as number,
    memoryAvailableBytes: memoryAvailableBytes as number,
    oom: {
      total: oom.total as number,
      sinceRunStart: oom.sinceRunStart as number,
      lastIncreaseMonotonicMs: (oom.lastIncreaseMonotonicMs as number | null) ?? null,
    },
    postgres: parsedPostgres,
    health: parsedHealth,
  }
}

function requiredWindowMs(phase: HostSafetyPhase, windows: HostSafetyWindows): number {
  switch (phase) {
    case 'preflight':
      return windows.preflightMs
    case 'postflight':
      return windows.postflightMs
    case 'stability':
      return windows.stabilityMs
    case 'during':
      return 0
  }
}

/**
 * Coverage of a list of samples.
 *
 * One sample at the declared cadence stands for the interval it was taken in, so
 * N samples spaced `sampleIntervalMs` apart cover `(N - 1) * interval + interval`
 * = `N * interval`. That is why 30 samples 10 s apart are exactly the 300 s of
 * stability `AGENTS.md` asks for, and why samples crowded into one second cover
 * one second plus a cadence and can never add up to a window.
 */
function coverageMs(first: HostSample, last: HostSample, sampleIntervalMs: number): number {
  return last.monotonicMs - first.monotonicMs + sampleIntervalMs
}

/**
 * Decides whether an operation may be admitted (or continue) right now.
 *
 * Never throws: an unusable input is answered with `admit: false` and the reasons
 * that made it unusable, because a thrown exception in the middle of a deploy is
 * exactly the ambiguity this gate exists to remove.
 */
export function evaluateHostSafety(input: EvaluateHostSafetyInput): HostSafetyVerdict {
  const { samples, nowMonotonicMs, phase } = input
  const reasons = new Set<HostSafetyReason>()
  const policy = validPolicy(input.policy)
  if (input.latchEngaged === true) reasons.add('latch-engaged')
  if (!policy) {
    reasons.add('policy-unconfigured')
    return {
      admit: false,
      reasons: orderedReasons(reasons),
      window: {
        phase,
        requiredMs: 0,
        requiredSamples: 0,
        sampleCount: Array.isArray(samples) ? samples.length : 0,
        validSampleCount: 0,
        coveredMs: 0,
        firstMonotonicMs: null,
        lastMonotonicMs: null,
        ageMs: null,
        largestGapMs: null,
        sustainedBusyMs: 0,
      },
    }
  }

  const { thresholds, observation, windows } = policy
  const rawSamples = Array.isArray(samples) ? samples : []
  if (!Array.isArray(samples)) reasons.add('sample-malformed')
  const parsed: HostSample[] = []
  for (const candidate of rawSamples) {
    const sample = parseHostSample(candidate)
    if (!sample) {
      reasons.add('sample-malformed')
      continue
    }
    parsed.push(sample)
  }

  // Ordering is checked over the samples as delivered: a journal whose seq or
  // monotonic clock does not advance is not a timeline, and an interpolated
  // "fix" would be this gate inventing evidence.
  for (let index = 1; index < parsed.length; index += 1) {
    const previous = parsed[index - 1]
    const current = parsed[index]
    if (current.seq <= previous.seq) reasons.add('sample-out-of-order')
    if (current.monotonicMs < previous.monotonicMs) reasons.add('clock-reset')
    else if (current.monotonicMs === previous.monotonicMs) reasons.add('sample-out-of-order')
  }

  const first = parsed[0] ?? null
  const last = parsed[parsed.length - 1] ?? null
  const requiredMs = requiredWindowMs(phase, windows)
  const requiredSamples = requiredMs === 0 ? 1 : Math.ceil(requiredMs / observation.sampleIntervalMs)
  const covered = first && last ? coverageMs(first, last, observation.sampleIntervalMs) : 0
  const ageMs = last ? nowMonotonicMs - last.monotonicMs : null

  if (!last) reasons.add('sample-missing')
  if (ageMs !== null) {
    if (ageMs < 0) reasons.add('clock-reset')
    else if (ageMs > observation.sampleFreshnessMs) reasons.add('sample-stale')
  }

  let largestGapMs: number | null = null
  for (let index = 1; index < parsed.length; index += 1) {
    const gap = parsed[index].monotonicMs - parsed[index - 1].monotonicMs
    if (gap >= 0 && (largestGapMs === null || gap > largestGapMs)) largestGapMs = gap
  }
  if (largestGapMs !== null && largestGapMs > observation.maxSampleGapMs) reasons.add('sample-missing')

  if (parsed.length > 0 && (parsed.length < requiredSamples || covered < requiredMs)) {
    reasons.add('window-incomplete')
  }

  for (const sample of parsed) {
    if (sample.cpu.busy >= thresholds.cpuBusyPeakRatio) reasons.add('cpu-busy-peak')
    if (sample.cpu.steal >= thresholds.stealRatio) reasons.add('steal')
    if (sample.load1 / sample.hostCpus >= thresholds.loadPerCpuRatio) reasons.add('load-ratio')
    if (sample.memoryAvailableBytes < thresholds.memoryAvailableMinimumBytes) reasons.add('memory-available')
    if (
      sample.oom.lastIncreaseMonotonicMs !== null &&
      nowMonotonicMs - sample.oom.lastIncreaseMonotonicMs <= observation.oomRecentWindowMs
    ) {
      reasons.add('oom-recent')
    }
    // An unobtainable connection count is an inconclusive metric, and
    // `AGENTS.md` line 215 treats inconclusive exactly like over the limit.
    if (!sample.postgres) reasons.add('pg-connections')
    else if (sample.postgres.connections > sample.postgres.maxConnections * thresholds.postgresConnectionRatio) {
      reasons.add('pg-connections')
    }
    // A health probe that never answered is an application error, not silence.
    if (!sample.health || !sample.health.ok) reasons.add('health-error')
    else if (sample.health.latencyMs === null) reasons.add('health-error')
    else if (sample.health.latencyMs > observation.healthLatencyMs) reasons.add('health-latency')
  }

  let sustainedBusyMs = 0
  if (last) {
    let runStart = parsed.length
    for (let index = parsed.length - 1; index >= 0; index -= 1) {
      if (parsed[index].cpu.busy >= thresholds.cpuBusySustainedRatio) runStart = index
      else break
    }
    if (runStart < parsed.length) {
      sustainedBusyMs = coverageMs(parsed[runStart], last, observation.sampleIntervalMs)
      if (sustainedBusyMs >= thresholds.cpuBusySustainedMs) reasons.add('cpu-busy-sustained')
    }
  }

  return {
    admit: reasons.size === 0,
    reasons: orderedReasons(reasons),
    window: {
      phase,
      requiredMs,
      requiredSamples,
      sampleCount: rawSamples.length,
      validSampleCount: parsed.length,
      coveredMs: covered,
      firstMonotonicMs: first ? first.monotonicMs : null,
      lastMonotonicMs: last ? last.monotonicMs : null,
      ageMs,
      largestGapMs,
      sustainedBusyMs,
    },
  }
}

function orderedReasons(reasons: ReadonlySet<HostSafetyReason>): readonly HostSafetyReason[] {
  return Object.freeze(HOST_SAFETY_REASONS.filter((reason) => reasons.has(reason)))
}

/** How long a window a phase must cover, given a resolved policy. */
export function phaseWindowMs(phase: HostSafetyPhase, policy: HostSafetyPolicy): number {
  if (phase === 'during') return policy.thresholds.cpuBusySustainedMs
  return requiredWindowMs(phase, policy.windows)
}

/**
 * Trailing samples that belong to a phase's window.
 *
 * The cut is by monotonic time, never by count: taking "the last six" would
 * accept six samples crowded into a second as a 60 s preflight. Malformed entries
 * inside the resulting tail are kept — dropping them here would hide them from the
 * evaluation, which is the only place allowed to decide that an undecodable sample
 * closes the gate. Malformed entries older than the window are left behind with
 * the rest of the history: a torn line from an hour ago is not evidence about now.
 */
export function selectPhaseWindowSamples(input: {
  readonly samples: readonly unknown[]
  readonly phase: HostSafetyPhase
  readonly policy: HostSafetyPolicy
}): readonly unknown[] {
  const windowMs = phaseWindowMs(input.phase, input.policy)
  const parsed = input.samples.map((candidate) => parseHostSample(candidate))
  let newest: number | null = null
  for (let index = parsed.length - 1; index >= 0; index -= 1) {
    const sample = parsed[index]
    if (sample) {
      newest = sample.monotonicMs
      break
    }
  }
  if (newest === null) return input.samples
  const floor = newest - (windowMs - input.policy.observation.sampleIntervalMs)
  let startIndex = input.samples.length
  for (let index = 0; index < input.samples.length; index += 1) {
    const sample = parsed[index]
    if (sample !== null && sample.monotonicMs >= floor) {
      startIndex = index
      break
    }
  }
  return Object.freeze(input.samples.slice(startIndex))
}
