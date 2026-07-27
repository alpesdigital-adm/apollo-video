import test from 'node:test'
import assert from 'node:assert/strict'

import {
  evaluateMvpCoreGate,
  MVP_CORE_ACCEPTANCE_CRITERIA,
  MVP_CORE_CRITERION_CHECKS,
} from '../../src/v2/domain/mvp-core-gate.ts'

const reference = (criterion, code) => ({
  type: criterion === 'AC-001' ? 'workspace' : 'project',
  id: `${criterion.toLowerCase()}-${code}`,
})

function completeEvidence() {
  return MVP_CORE_ACCEPTANCE_CRITERIA.map((criterion) => ({
    criterion,
    checks: MVP_CORE_CRITERION_CHECKS[criterion].map((code) => ({
      code,
      passed: true,
      references: [reference(criterion, code)],
    })),
  }))
}

const base = {
  workspaceId: 'workspace-mvp',
  primaryProjectId: 'project-talking-head',
  companionProjectId: 'project-voiceover',
  evaluatedAt: '2026-07-27T00:00:00.000Z',
}

test('T-AC-001..016 requires every server check and creates a canonical report', () => {
  const first = evaluateMvpCoreGate({
    ...base,
    evidence: completeEvidence(),
  })
  const second = evaluateMvpCoreGate({
    ...base,
    evidence: [...completeEvidence()].reverse(),
  })

  assert.equal(first.schemaVersion, 'mvp-core-gate-report/v1')
  assert.equal(first.approved, true)
  assert.equal(first.serverEvidenceOnly, true)
  assert.equal(first.covered, 16)
  assert.equal(first.passed, 16)
  assert.equal(first.total, 16)
  assert.deepEqual(first.missing, [])
  assert.deepEqual(first.failed, [])
  assert.equal(first.evidence.length, 16)
  assert.ok(first.evidence.every((item) =>
    item.source === 'server' &&
    item.automatic === true &&
    item.passed === true))
  assert.equal(first.fingerprint, second.fingerprint)
})

test('MVP gate fails closed for missing criterion, check or failed proof', () => {
  const missingCriterion = completeEvidence().slice(1)
  const reportMissingCriterion = evaluateMvpCoreGate({
    ...base,
    evidence: missingCriterion,
  })
  assert.equal(reportMissingCriterion.approved, false)
  assert.deepEqual(reportMissingCriterion.missing, ['AC-001'])
  assert.equal(reportMissingCriterion.covered, 15)

  const missingCheck = completeEvidence()
  missingCheck[0] = {
    criterion: 'AC-001',
    checks: missingCheck[0].checks.slice(1),
  }
  const reportMissingCheck = evaluateMvpCoreGate({
    ...base,
    evidence: missingCheck,
  })
  assert.equal(reportMissingCheck.approved, false)
  assert.deepEqual(reportMissingCheck.failed, ['AC-001'])
  assert.deepEqual(
    reportMissingCheck.evidence[0].missingChecks,
    ['workspace-active'],
  )
  assert.equal(reportMissingCheck.covered, 15)

  const failedCheck = completeEvidence()
  failedCheck[15].checks[0].passed = false
  const reportFailedCheck = evaluateMvpCoreGate({
    ...base,
    evidence: failedCheck,
  })
  assert.equal(reportFailedCheck.approved, false)
  assert.deepEqual(reportFailedCheck.failed, ['AC-016'])
  assert.equal(reportFailedCheck.covered, 16)
  assert.equal(reportFailedCheck.passed, 15)
})

test('MVP gate rejects duplicate, foreign and untraceable evidence', () => {
  const evidence = completeEvidence()
  assert.throws(
    () => evaluateMvpCoreGate({
      ...base,
      evidence: [...evidence, evidence[0]],
    }),
    /evidence is invalid|duplicated/,
  )
  assert.throws(
    () => evaluateMvpCoreGate({
      ...base,
      evidence: [{
        criterion: 'AC-001',
        checks: [{
          code: 'objective-bound',
          passed: true,
          references: [{
            type: 'workspace',
            id: 'workspace-mvp',
          }],
        }],
      }],
    }),
    /does not belong/,
  )
  assert.throws(
    () => evaluateMvpCoreGate({
      ...base,
      evidence: [{
        criterion: 'AC-001',
        checks: [{
          code: 'workspace-active',
          passed: true,
          references: [],
        }],
      }],
    }),
    /server references/,
  )
})

