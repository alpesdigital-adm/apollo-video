import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'

import {
  HOST_SAFETY_POLICY_SCHEMA_VERSION,
  evaluateHostSafety,
  parseHostSample,
  resolveHostSafetyPolicy,
  selectPhaseWindowSamples,
} from '../../src/v2/infrastructure/host-safety/policy.ts'

// Every boundary below is exercised with a controlled clock and synthetic samples.
// Nothing here generates load: proving that 50% sustained for 30s closes the gate
// by actually pinning a CPU for 30 seconds would be the opposite of what the
// policy exists for.
const root = resolve(import.meta.dirname, '..', '..')
const catalog = JSON.parse(await readFile(resolve(root, 'config/host-safety-policy.json'), 'utf8'))
const GIB = 1024 ** 3
const BASE_MONOTONIC = 1_000_000

const POLICY = Object.freeze({
  profile: 'test',
  thresholds: {
    cpuBusySustainedRatio: 0.5,
    cpuBusySustainedMs: 30_000,
    cpuBusyPeakRatio: 0.7,
    loadPerCpuRatio: 0.75,
    stealRatio: 0.1,
    memoryAvailableMinimumBytes: 2 * GIB,
    postgresConnectionRatio: 0.5,
  },
  windows: { preflightMs: 60_000, postflightMs: 60_000, stabilityMs: 300_000 },
  observation: {
    sampleIntervalMs: 10_000,
    sampleFreshnessMs: 25_000,
    maxSampleGapMs: 25_000,
    healthLatencyMs: 2_000,
    oomRecentWindowMs: 600_000,
  },
})

function sample(index, overrides = {}) {
  const monotonicMs = overrides.monotonicMs ?? BASE_MONOTONIC + index * POLICY.observation.sampleIntervalMs
  return {
    seq: overrides.seq ?? index + 1,
    monotonicMs,
    capturedAtIso: new Date(Date.UTC(2026, 8, 18, 23, 0, index)).toISOString(),
    cpu: { busy: 0.1, steal: 0.01, iowait: 0.02, ...(overrides.cpu ?? {}) },
    hostCpus: overrides.hostCpus ?? 4,
    load1: overrides.load1 ?? 1,
    memoryAvailableBytes: overrides.memoryAvailableBytes ?? 3 * GIB,
    oom: { total: 7, sinceRunStart: 0, lastIncreaseMonotonicMs: null, ...(overrides.oom ?? {}) },
    postgres:
      overrides.postgres === null
        ? null
        : { connections: 10, maxConnections: 100, backendsByApplicationName: {}, ...(overrides.postgres ?? {}) },
    health:
      overrides.health === null ? null : { ok: true, statusCode: 200, latencyMs: 25, error: null, ...(overrides.health ?? {}) },
  }
}

function window(count, overrides = {}) {
  return Array.from({ length: count }, (unused, index) => sample(index, overrides))
}

function nowAfter(samples, ageMs = 1_000) {
  const last = samples[samples.length - 1]
  return (last && typeof last.monotonicMs === 'number' ? last.monotonicMs : BASE_MONOTONIC) + ageMs
}

function judge(samples, phase = 'preflight', extra = {}) {
  return evaluateHostSafety({
    samples,
    nowMonotonicMs: extra.nowMonotonicMs ?? nowAfter(samples),
    // `in`, not `??`: a test that passes `policy: null` must reach the policy
    // validation, not silently fall back to a valid policy.
    policy: 'policy' in extra ? extra.policy : POLICY,
    phase,
    latchEngaged: extra.latchEngaged,
  })
}

test('a complete quiet preflight window admits and a short one does not', () => {
  const complete = judge(window(6))
  assert.equal(complete.admit, true)
  assert.deepEqual(complete.reasons, [])
  assert.equal(complete.window.coveredMs, 60_000)
  assert.equal(complete.window.requiredSamples, 6)

  const short = judge(window(5))
  assert.equal(short.admit, false)
  assert.deepEqual(short.reasons, ['window-incomplete'])
  assert.equal(short.window.coveredMs, 50_000)

  const postflight = judge(window(6), 'postflight')
  assert.equal(postflight.admit, true)
  assert.equal(postflight.window.requiredMs, 60_000)
})

test('three fast samples are three samples, not a preflight', () => {
  const fast = [sample(0, { monotonicMs: BASE_MONOTONIC }), sample(1, { monotonicMs: BASE_MONOTONIC + 1_000 }), sample(2, { monotonicMs: BASE_MONOTONIC + 2_000 })]
  const preflight = judge(fast)
  assert.equal(preflight.admit, false)
  assert.deepEqual(preflight.reasons, ['window-incomplete'])
  assert.equal(preflight.window.coveredMs, 12_000)
  // The same samples during the work are judged one by one: the window rule is a
  // precondition to start, not a reason to interrupt a healthy run.
  assert.equal(judge(fast, 'during').admit, true)
})

test('sustained busy needs the ratio AND thirty seconds of real coverage', () => {
  const justUnder = judge(window(6, { cpu: { busy: 0.4999 } }))
  assert.equal(justUnder.admit, true)

  const atThreshold = judge(window(6, { cpu: { busy: 0.5 } }))
  assert.equal(atThreshold.admit, false)
  assert.deepEqual(atThreshold.reasons, ['cpu-busy-sustained'])
  assert.equal(atThreshold.window.sustainedBusyMs, 60_000)

  // Two samples at 60% cover 20s: over the ratio, under the duration.
  const tooBrief = [sample(0), sample(1), sample(2), sample(3, { cpu: { busy: 0.6 } }), sample(4, { cpu: { busy: 0.6 } })]
  const brief = judge(tooBrief, 'during')
  assert.equal(brief.admit, true)
  assert.equal(brief.window.sustainedBusyMs, 20_000)

  // Three consecutive samples at the cadence cover exactly 30s.
  const exactly = [sample(0), sample(1), sample(2), sample(3, { cpu: { busy: 0.5 } }), sample(4, { cpu: { busy: 0.5 } }), sample(5, { cpu: { busy: 0.5 } })]
  const sustained = judge(exactly, 'during')
  assert.equal(sustained.window.sustainedBusyMs, 30_000)
  assert.deepEqual(sustained.reasons, ['cpu-busy-sustained'])

  // A single dip inside the trailing run breaks it: "all samples in the window".
  const dipped = [sample(0, { cpu: { busy: 0.5 } }), sample(1, { cpu: { busy: 0.2 } }), sample(2, { cpu: { busy: 0.5 } }), sample(3, { cpu: { busy: 0.5 } })]
  assert.equal(judge(dipped, 'during').admit, true)
})

test('a single peak sample closes the gate at seventy percent', () => {
  const justUnder = judge([sample(0), sample(1), sample(2), sample(3), sample(4), sample(5, { cpu: { busy: 0.6999 } })])
  assert.equal(justUnder.admit, true)

  const atPeak = judge([sample(0), sample(1), sample(2), sample(3), sample(4), sample(5, { cpu: { busy: 0.7 } })])
  assert.equal(atPeak.admit, false)
  assert.deepEqual(atPeak.reasons, ['cpu-busy-peak'])
})

test('load per CPU closes at three quarters', () => {
  assert.equal(judge(window(6, { load1: 2.9996, hostCpus: 4 })).admit, true)
  const blocked = judge(window(6, { load1: 3, hostCpus: 4 }))
  assert.deepEqual(blocked.reasons, ['load-ratio'])
})

test('steal is judged on its own, never folded into busy', () => {
  assert.equal(judge(window(6, { cpu: { steal: 0.0999 } })).admit, true)
  const blocked = judge(window(6, { cpu: { steal: 0.1 } }))
  assert.deepEqual(blocked.reasons, ['steal'])

  // The 12 September 2026 shape: almost no CPU of our own, the hypervisor taking
  // everything. Low busy must not read as headroom.
  const hypervisor = judge(window(6, { cpu: { busy: 0.05, steal: 0.93 } }))
  assert.deepEqual(hypervisor.reasons, ['steal'])
})

test('available memory closes one byte below two gibibytes', () => {
  assert.equal(judge(window(6, { memoryAvailableBytes: 2 * GIB })).admit, true)
  const blocked = judge(window(6, { memoryAvailableBytes: 2 * GIB - 1 }))
  assert.deepEqual(blocked.reasons, ['memory-available'])
})

test('a recent OOM closes the gate and an old one does not', () => {
  // The kill happened before this run started, so the samples stay fresh while the
  // OOM ages out: the freshness rule and the OOM window are independent.
  const now = BASE_MONOTONIC + 50_000 + 1_000
  const recent = judge(window(6, { oom: { total: 9, sinceRunStart: 2, lastIncreaseMonotonicMs: now - 600_000 } }))
  assert.deepEqual(recent.reasons, ['oom-recent'])

  const expired = judge(window(6, { oom: { total: 9, sinceRunStart: 2, lastIncreaseMonotonicMs: now - 600_001 } }))
  assert.equal(expired.admit, true)
})

test('PostgreSQL connections close above half of max_connections, and an unobtainable count closes too', () => {
  assert.equal(judge(window(6, { postgres: { connections: 50, maxConnections: 100 } })).admit, true)
  assert.deepEqual(judge(window(6, { postgres: { connections: 51, maxConnections: 100 } })).reasons, ['pg-connections'])
  assert.deepEqual(judge(window(6, { postgres: null })).reasons, ['pg-connections'])
})

test('health is one input: 200 never proves the host is healthy and silence is an error', () => {
  assert.equal(judge(window(6, { health: { latencyMs: 2_000 } })).admit, true)
  assert.deepEqual(judge(window(6, { health: { latencyMs: 2_001 } })).reasons, ['health-latency'])
  assert.deepEqual(judge(window(6, { health: { ok: false, statusCode: 503, error: 'health responded 503' } })).reasons, ['health-error'])
  assert.deepEqual(judge(window(6, { health: null })).reasons, ['health-error'])
  assert.deepEqual(judge(window(6, { health: { latencyMs: null } })).reasons, ['health-error'])
  // A perfect health check alongside a hostile host still refuses.
  const contradiction = judge(window(6, { cpu: { busy: 0.9 }, health: { latencyMs: 5 } }))
  assert.deepEqual(contradiction.reasons, ['cpu-busy-sustained', 'cpu-busy-peak'])
})

test('missing, stale, malformed, out-of-order and backwards samples all close the gate', () => {
  const empty = judge([])
  assert.deepEqual(empty.reasons, ['sample-missing'])

  const samples = window(6)
  assert.equal(judge(samples, 'preflight', { nowMonotonicMs: nowAfter(samples, 25_000) }).admit, true)
  assert.deepEqual(judge(samples, 'preflight', { nowMonotonicMs: nowAfter(samples, 25_001) }).reasons, ['sample-stale'])

  const malformed = judge([...window(5), { seq: 6, monotonicMs: 'soon' }])
  assert.ok(malformed.reasons.includes('sample-malformed'))
  assert.equal(malformed.window.sampleCount, 6)
  assert.equal(malformed.window.validSampleCount, 5)

  const repeatedSeq = [...window(5), sample(5, { seq: 5 })]
  assert.ok(judge(repeatedSeq).reasons.includes('sample-out-of-order'))

  const frozenClock = [...window(5), sample(5, { monotonicMs: BASE_MONOTONIC + 4 * 10_000 })]
  assert.ok(judge(frozenClock).reasons.includes('sample-out-of-order'))

  const backwards = [...window(5), sample(5, { monotonicMs: BASE_MONOTONIC })]
  assert.ok(judge(backwards).reasons.includes('clock-reset'))

  const nowBeforeSample = judge(window(6), 'preflight', { nowMonotonicMs: BASE_MONOTONIC - 1 })
  assert.ok(nowBeforeSample.reasons.includes('clock-reset'))
})

test('a hole in the cadence is a missing sample even when the window is long enough', () => {
  const withGap = [
    sample(0, { monotonicMs: BASE_MONOTONIC }),
    sample(1, { monotonicMs: BASE_MONOTONIC + 10_000 }),
    sample(2, { monotonicMs: BASE_MONOTONIC + 20_000 }),
    sample(3, { monotonicMs: BASE_MONOTONIC + 55_100 }),
    sample(4, { monotonicMs: BASE_MONOTONIC + 65_100 }),
    sample(5, { monotonicMs: BASE_MONOTONIC + 75_100 }),
  ]
  const verdict = judge(withGap)
  assert.deepEqual(verdict.reasons, ['sample-missing'])
  assert.equal(verdict.window.largestGapMs, 35_100)
  assert.ok(verdict.window.coveredMs > 60_000)
})

test('an unconfigured threshold refuses instead of guessing a default', () => {
  for (const missing of ['healthLatencyMs', 'oomRecentWindowMs', 'sampleFreshnessMs', 'maxSampleGapMs', 'sampleIntervalMs']) {
    const observation = { ...POLICY.observation }
    delete observation[missing]
    const verdict = judge(window(6), 'preflight', { policy: { ...POLICY, observation } })
    assert.deepEqual(verdict.reasons, ['policy-unconfigured'], `${missing} must not have a code default`)
    assert.equal(verdict.admit, false)
  }
  assert.deepEqual(judge(window(6), 'preflight', { policy: null }).reasons, ['policy-unconfigured'])
  assert.deepEqual(judge(window(6), 'preflight', { policy: { ...POLICY, thresholds: { ...POLICY.thresholds, stealRatio: 0 } } }).reasons, [
    'policy-unconfigured',
  ])
})

test('an engaged latch closes every phase regardless of the metrics', () => {
  const verdict = judge(window(6), 'preflight', { latchEngaged: true })
  assert.equal(verdict.admit, false)
  assert.deepEqual(verdict.reasons, ['latch-engaged'])
  assert.deepEqual(judge(window(30), 'stability', { latchEngaged: true }).reasons, ['latch-engaged'])
})

test('stability after a latch release requires thirty samples covering five minutes', () => {
  const thirty = window(30)
  const verdict = judge(thirty, 'stability')
  assert.equal(verdict.admit, true)
  assert.equal(verdict.window.requiredMs, 300_000)
  assert.equal(verdict.window.requiredSamples, 30)
  assert.equal(verdict.window.coveredMs, 300_000)
  assert.deepEqual(judge(window(29), 'stability').reasons, ['window-incomplete'])
})

test('reasons accumulate in a stable order and never repeat', () => {
  const verdict = judge(
    window(6, {
      cpu: { busy: 0.8, steal: 0.5 },
      load1: 8,
      memoryAvailableBytes: 1,
      postgres: null,
      health: null,
    }),
  )
  assert.deepEqual(verdict.reasons, [
    'cpu-busy-sustained',
    'cpu-busy-peak',
    'load-ratio',
    'steal',
    'memory-available',
    'pg-connections',
    'health-error',
  ])
})

test('the window selector cuts by monotonic time, not by sample count', () => {
  const samples = window(20)
  const preflight = selectPhaseWindowSamples({ samples, phase: 'preflight', policy: POLICY })
  assert.equal(preflight.length, 6)
  const during = selectPhaseWindowSamples({ samples, phase: 'during', policy: POLICY })
  assert.equal(during.length, 3)
  const stability = selectPhaseWindowSamples({ samples, phase: 'stability', policy: POLICY })
  assert.equal(stability.length, 20)
  // Samples crowded into one second all belong to the same window.
  const crowded = [sample(0, { monotonicMs: BASE_MONOTONIC }), sample(1, { monotonicMs: BASE_MONOTONIC + 500 })]
  assert.equal(selectPhaseWindowSamples({ samples: crowded, phase: 'during', policy: POLICY }).length, 2)
})

test('parseHostSample refuses anything it cannot trust', () => {
  assert.ok(parseHostSample(sample(0)))
  assert.equal(parseHostSample(null), null)
  assert.equal(parseHostSample({ ...sample(0), seq: -1 }), null)
  assert.equal(parseHostSample({ ...sample(0), cpu: { busy: 1.5, steal: 0, iowait: 0 } }), null)
  assert.equal(parseHostSample({ ...sample(0), hostCpus: 0 }), null)
  assert.equal(parseHostSample({ ...sample(0), capturedAtIso: 'yesterday' }), null)
  // An absent `lastIncreaseMonotonicMs` is not the same statement as an explicit
  // "never observed", so only the explicit one is accepted.
  assert.equal(parseHostSample({ ...sample(0), oom: { total: 1, sinceRunStart: 0 } }), null)
  assert.equal(parseHostSample({ ...sample(0), oom: { total: 1, sinceRunStart: 0, lastIncreaseMonotonicMs: null } })?.oom.total, 1)
  assert.equal(parseHostSample({ ...sample(0), postgres: { connections: 1, maxConnections: 0, backendsByApplicationName: {} } }), null)
})

test('the shipped catalog reproduces the AGENTS.md thresholds and leaves production unconfigured', () => {
  assert.equal(catalog.schemaVersion, HOST_SAFETY_POLICY_SCHEMA_VERSION)
  assert.deepEqual(catalog.thresholds, {
    cpuBusySustainedRatio: 0.5,
    cpuBusySustainedMs: 30_000,
    cpuBusyPeakRatio: 0.7,
    loadPerCpuRatio: 0.75,
    stealRatio: 0.1,
    memoryAvailableMinimumBytes: 2 * GIB,
    postgresConnectionRatio: 0.5,
  })
  assert.deepEqual(catalog.windows, { preflightMs: 60_000, postflightMs: 60_000, stabilityMs: 300_000 })

  const isolated = resolveHostSafetyPolicy({ catalog, profile: 'isolated-ci' })
  assert.equal(isolated.ok, true)
  assert.equal(isolated.policy.observation.sampleIntervalMs, 10_000)
  assert.equal(isolated.policy.thresholds.cpuBusySustainedMs, 30_000)

  // Production deliberately ships without the three values that are the owner's
  // call; the resolution fails and the deploy therefore cannot start there yet.
  const production = resolveHostSafetyPolicy({ catalog, profile: 'digitalocean-production' })
  assert.equal(production.ok, false)
  for (const key of ['sampleFreshnessMs', 'healthLatencyMs', 'oomRecentWindowMs']) {
    assert.ok(
      production.errors.some((error) => error.includes(key)),
      `${key} must be reported as unconfigured for digitalocean-production`,
    )
  }
  assert.equal(resolveHostSafetyPolicy({ catalog, profile: 'nowhere' }).ok, false)
  assert.equal(resolveHostSafetyPolicy({ catalog: { schemaVersion: 'other' }, profile: 'isolated-ci' }).ok, false)
})
