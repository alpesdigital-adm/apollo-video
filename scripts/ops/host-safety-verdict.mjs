#!/usr/bin/env node
// Evaluates one phase of a supervised operation and answers with an exit code.
//
//   ./node_modules/.bin/tsx scripts/ops/host-safety-verdict.mjs \
//     --run-id <run> --profile <profile> --phase preflight|during|postflight|stability \
//     [--state-dir DIR] [--format shell|json] [--last-seen-seq N] [--max-decision-age-ms 20000]
//
// Exit 0 = admit, 1 = refuse (the reasons are printed), 2 = the request itself was
// unusable. Decisions stay in Node and effects stay in bash: this script reads the
// monitor's journal, the latch and `gate.json`, and writes nothing.
//
// The freshness check is deliberately not "the file was touched recently": a
// monitor that hung keeps a recent mtime and a frozen `seq`, so the caller passes
// the highest `seq` it has already acted on and a decision that did not advance is
// refused.
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import * as importedPolicy from '../../src/v2/infrastructure/host-safety/policy.ts'
import * as importedGateFile from '../../src/v2/infrastructure/host-safety/gate-file.ts'
import * as importedJournal from '../../src/v2/infrastructure/host-safety/journal.ts'
import * as importedLatch from '../../src/v2/infrastructure/host-safety/latch.ts'
import * as importedClock from '../../src/v2/infrastructure/host-safety/host-clock.ts'

// tsx transpiles TypeScript to CommonJS under this package, so a named export may
// sit behind `default`; Node's own type stripping exposes it directly.
const policyModule = importedPolicy.evaluateHostSafety ? importedPolicy : importedPolicy.default
const gateModule = importedGateFile.readGateForDeploy ? importedGateFile : importedGateFile.default
const journalModule = importedJournal.readMonitorSamples ? importedJournal : importedJournal.default
const latchModule = importedLatch.readLatch ? importedLatch : importedLatch.default
const clockModule = importedClock.hostMonotonicNowMs ? importedClock : importedClock.default

const { evaluateHostSafety, resolveHostSafetyPolicy, selectPhaseWindowSamples } = policyModule
const { readGateForDeploy } = gateModule
const { readMonitorSamples } = journalModule
const { readLatch } = latchModule
const { hostMonotonicNowMs } = clockModule

const SHIPPED_CATALOG = 'config/host-safety-policy.json'
const root = resolve(import.meta.dirname, '..', '..')
const PHASES = ['preflight', 'during', 'postflight', 'stability']

function parseArguments(argv) {
  const options = {
    runId: null,
    profile: null,
    phase: null,
    stateDir: process.env.APOLLO_OPS_STATE_DIR ?? null,
    catalog: SHIPPED_CATALOG,
    format: 'shell',
    lastSeenSeq: undefined,
    maxDecisionAgeMs: 20_000,
    requireGate: true,
    requireZeroBackends: null,
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
      case '--phase':
        options.phase = value()
        break
      case '--state-dir':
        options.stateDir = value()
        break
      case '--catalog':
        options.catalog = value()
        break
      case '--format':
        options.format = value()
        break
      case '--last-seen-seq':
        options.lastSeenSeq = Number(value())
        break
      case '--max-decision-age-ms':
        options.maxDecisionAgeMs = Number(value())
        break
      case '--no-require-gate':
        options.requireGate = false
        break
      case '--require-zero-backends':
        options.requireZeroBackends = value()
        break
      default:
        throw new Error(`unknown argument ${argument}`)
    }
  }
  if (!options.runId) throw new Error('--run-id is required')
  if (!options.profile) throw new Error('--profile is required')
  if (!PHASES.includes(options.phase)) throw new Error(`--phase must be one of ${PHASES.join('|')}`)
  if (!options.stateDir) throw new Error('--state-dir or APOLLO_OPS_STATE_DIR is required')
  if (!['shell', 'json'].includes(options.format)) throw new Error('--format must be shell or json')
  // Belt and braces with the shell's seam refusal: even if something managed to pass a
  // substituted catalog here, the shared production host is judged by the policy that
  // shipped in the image and by nothing else.
  if (options.profile === 'digitalocean-production' && options.catalog !== SHIPPED_CATALOG) {
    throw new Error(`--catalog must be ${SHIPPED_CATALOG} when --profile is digitalocean-production`)
  }
  if (options.lastSeenSeq !== undefined && !Number.isSafeInteger(options.lastSeenSeq)) {
    throw new Error('--last-seen-seq must be an integer')
  }
  if (!Number.isFinite(options.maxDecisionAgeMs) || options.maxDecisionAgeMs <= 0) {
    throw new Error('--max-decision-age-ms must be positive')
  }
  return options
}

let options
try {
  options = parseArguments(process.argv.slice(2))
} catch (error) {
  console.error(`host-safety-verdict: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}

const catalog = JSON.parse(await readFile(resolve(root, options.catalog), 'utf8'))
const resolution = resolveHostSafetyPolicy({ catalog, profile: options.profile })
if (!resolution.ok) {
  for (const error of resolution.errors) console.error(`host-safety-verdict: ${error}`)
  emit({ admit: false, reasons: ['policy-unconfigured'], gate: null, window: null, observation: null })
  process.exit(1)
}

const policy = resolution.policy
const latch = await readLatch(options.stateDir)
const allSamples = await readMonitorSamples({ stateDir: options.stateDir, runId: options.runId })
const verdict = evaluateHostSafety({
  samples: selectPhaseWindowSamples({ samples: allSamples, phase: options.phase, policy }),
  nowMonotonicMs: hostMonotonicNowMs(),
  policy,
  phase: options.phase,
  latchEngaged: latch.engaged,
})
const gate = await readGateForDeploy({
  stateDir: options.stateDir,
  nowMonotonicMs: hostMonotonicNowMs(),
  maximumDecisionAgeMs: options.maxDecisionAgeMs,
  lastSeenSeq: options.lastSeenSeq,
  requirePresent: options.requireGate,
})

const reasons = [...verdict.reasons, ...gate.reasons.filter((reason) => !verdict.reasons.includes(reason))]
// A container is only "stopped" once its backends are gone from the server, which
// is what the 29 July 2026 incident proved: the client that reconnects, not the
// exit status, is the fact that matters.
let backendsClear = true
if (options.requireZeroBackends !== null) {
  const newest = newestPostgresObservation(allSamples)
  if (!newest) {
    backendsClear = false
    reasons.push('pg-backends-unobserved')
  } else if ((newest[options.requireZeroBackends] ?? 0) > 0) {
    backendsClear = false
    reasons.push(`pg-backends-present:${options.requireZeroBackends}`)
  }
}
const admit = verdict.admit && gate.admit && backendsClear
emit({ admit, reasons, gate, window: verdict.window, observation: policy.observation })
process.exit(admit ? 0 : 1)

function newestPostgresObservation(candidates) {
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index]
    if (candidate && typeof candidate === 'object' && candidate.postgres && typeof candidate.postgres === 'object') {
      const backends = candidate.postgres.backendsByApplicationName
      if (backends && typeof backends === 'object') return backends
    }
  }
  return null
}

function emit(payload) {
  if (options.format === 'json') {
    process.stdout.write(`${JSON.stringify(payload)}\n`)
    return
  }
  const gateSeq = payload.gate && payload.gate.document ? payload.gate.document.seq : 0
  const gateAge = payload.gate && payload.gate.ageMs !== null ? Math.round(payload.gate.ageMs) : -1
  const window = payload.window ?? {}
  process.stdout.write(
    [
      `admit=${payload.admit ? 'true' : 'false'}`,
      `reasons=${payload.reasons.join(',')}`,
      `gateSeq=${gateSeq}`,
      `gateAgeMs=${gateAge}`,
      `sampleCount=${window.validSampleCount ?? 0}`,
      `coveredMs=${Math.round(window.coveredMs ?? 0)}`,
      `requiredMs=${Math.round(window.requiredMs ?? 0)}`,
      `sustainedBusyMs=${Math.round(window.sustainedBusyMs ?? 0)}`,
      // The bash side needs these two to perform the checks that live on the host:
      // the per-container OOM inspection and the decision freshness bound.
      `oomRecentWindowMs=${payload.observation?.oomRecentWindowMs ?? 0}`,
      `sampleFreshnessMs=${payload.observation?.sampleFreshnessMs ?? 0}`,
    ].join('\n') + '\n',
  )
}
