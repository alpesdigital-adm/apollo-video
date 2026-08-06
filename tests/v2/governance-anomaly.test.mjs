import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createGovernanceAnomalyPolicy,
  evaluateGovernanceAnomalies,
} from '../../src/v2/domain/governance-anomaly.ts'

const policy = createGovernanceAnomalyPolicy({
  requestMinimum: 20,
  requestBaselineMultiplierBps: 30_000,
  spendMinimumMinorUnits: 1_000,
  spendBaselineMultiplierBps: 30_000,
  errorMinimumTerminalOperations: 10,
  errorRateThresholdBps: 5_000,
})

const quiet = {
  recentRequests: 2,
  baselineRequests: 20,
  recentSpendMinorUnits: 100,
  baselineSpendMinorUnits: 1_000,
  terminalOperations: 10,
  failedOperations: 1,
}

test('F0.103 anomaly policy is content-addressed and detects bounded request/spend spikes', () => {
  assert.match(policy.policyHash, /^[a-f0-9]{64}$/)
  const result = evaluateGovernanceAnomalies({
    policy,
    usage: {
      ...quiet,
      recentRequests: 20,
      recentSpendMinorUnits: 1_000,
    },
    requested: { requests: 1, spendMinorUnits: 1 },
  })
  assert.deepEqual(result, [
    {
      reason: 'REQUEST_RATE_ANOMALY',
      observed: 21,
      threshold: 20,
      windowMs: 60_000,
    },
    {
      reason: 'SPEND_RATE_ANOMALY',
      observed: 1_001,
      threshold: 1_000,
      windowMs: 60_000,
    },
  ])
})

test('F0.103 anomaly policy compares against the previous five-minute baseline', () => {
  assert.deepEqual(evaluateGovernanceAnomalies({
    policy,
    usage: {
      ...quiet,
      recentRequests: 30,
      baselineRequests: 100,
      recentSpendMinorUnits: 1_500,
      baselineSpendMinorUnits: 5_000,
    },
    requested: { requests: 1, spendMinorUnits: 1 },
  }), [])
})

test('F0.103 cold clients warm a baseline without false request anomalies', () => {
  assert.deepEqual(evaluateGovernanceAnomalies({
    policy,
    usage: { ...quiet, recentRequests: 200, baselineRequests: 0 },
    requested: { requests: 1, spendMinorUnits: 0 },
  }), [])
})

test('F0.103 error-rate requires a minimum terminal sample and reports basis points', () => {
  assert.deepEqual(evaluateGovernanceAnomalies({
    policy,
    usage: { ...quiet, terminalOperations: 10, failedOperations: 5 },
    requested: { requests: 1, spendMinorUnits: 0 },
  }), [{
    reason: 'ERROR_RATE_ANOMALY',
    observed: 5_000,
    threshold: 5_000,
    windowMs: 300_000,
  }])
  assert.deepEqual(evaluateGovernanceAnomalies({
    policy,
    usage: { ...quiet, terminalOperations: 9, failedOperations: 9 },
    requested: { requests: 1, spendMinorUnits: 0 },
  }), [])
})

test('F0.103 anomaly policy and evidence fail closed on invalid counters or hashes', () => {
  assert.throws(
    () => createGovernanceAnomalyPolicy({ ...policy, policyHash: '0'.repeat(64) }),
    (error) => error.code === 'PERSISTENCE_CONFLICT',
  )
  assert.throws(
    () => evaluateGovernanceAnomalies({
      policy,
      usage: { ...quiet, failedOperations: 11 },
      requested: { requests: 1, spendMinorUnits: 0 },
    }),
    (error) => error.code === 'INVALID_ARGUMENT',
  )
})
