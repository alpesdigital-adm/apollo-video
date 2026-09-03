import assert from 'node:assert/strict'
import test from 'node:test'

import {
  evaluateSyntheticPhaseGate,
  SYNTHETIC_PHASE_GATE_CRITERIA,
  SYNTHETIC_PHASE_GATE_CRITERION_CHECKS,
} from '../../src/v2/domain/synthetic-phase-gate.ts'

const hash = (character) => character.repeat(64)

const evidenceByCheck = {
  'elevenlabs-audio-alignment-live': ['provider-job', 'provider-result-artifact', 'alignment-artifact'],
  'heygen-generated-audio-avatar-live': ['provider-job', 'synthetic-audio-master', 'provider-result-artifact'],
  'heygen-ready-audio-avatar-live': ['provider-job', 'synthetic-audio-master', 'provider-result-artifact'],
  'approved-blocks-catalogued': ['synthetic-master', 'speech-segment'],
  'cross-project-reuse-with-zero-provider-work': ['cache-decision', 'synthetic-master', 'project'],
  'transformation-rejected-before-fallback': ['transformation-fallback-ledger', 'transformation-critic-report'],
  'fallback-result-approved': ['transformation-fallback-ledger', 'provider-result-artifact'],
  'provider-swap-keeps-plan-and-renderer-contracts': ['edit-plan', 'render-manifest', 'build-attestation'],
}

function completeEvidence() {
  let reference = 0
  return SYNTHETIC_PHASE_GATE_CRITERIA.map((criterion) => ({
    criterion,
    checks: SYNTHETIC_PHASE_GATE_CRITERION_CHECKS[criterion].map((code) => ({
      code,
      passed: true,
      references: evidenceByCheck[code].map((type) => ({
        type,
        id: `${type}-${++reference}`,
        hash: hash(((reference % 9) + 1).toString()),
      })),
    })),
  }))
}

const base = {
  workspaceId: 'workspace-synthetic-gate',
  projectId: 'project-synthetic-gate',
  projectVersionId: 'version-synthetic-gate',
  projectVersionHash: hash('a'),
  evaluatedAt: '2026-09-03T12:00:00.000Z',
}

test('T-F3-GATE requires live provider, catalog reuse, fallback and provider-neutral evidence', () => {
  const first = evaluateSyntheticPhaseGate({ ...base, evidence: completeEvidence() })
  const second = evaluateSyntheticPhaseGate({ ...base, evidence: completeEvidence().reverse() })

  assert.equal(first.schemaVersion, 'synthetic-phase-gate-report/v1')
  assert.equal(first.gate, 'synthetic-phase/v1')
  assert.equal(first.approved, true)
  assert.equal(first.serverEvidenceOnly, true)
  assert.equal(first.covered, 4)
  assert.equal(first.passed, 4)
  assert.equal(first.total, 4)
  assert.deepEqual(first.missing, [])
  assert.deepEqual(first.failed, [])
  assert.equal(first.fingerprint, second.fingerprint)
  assert.ok(first.evidence.every((item) => item.source === 'server' && item.automatic))
})

test('T-F3-GATE fails closed for missing criteria, checks, evidence types and failed proof', () => {
  const missingCriterion = evaluateSyntheticPhaseGate({
    ...base,
    evidence: completeEvidence().slice(1),
  })
  assert.equal(missingCriterion.approved, false)
  assert.deepEqual(missingCriterion.missing, ['F3-GATE-001'])
  assert.equal(missingCriterion.covered, 3)

  const missingCheckEvidence = completeEvidence()
  missingCheckEvidence[0].checks[0].references = missingCheckEvidence[0].checks[0].references.slice(1)
  const incomplete = evaluateSyntheticPhaseGate({ ...base, evidence: missingCheckEvidence })
  assert.equal(incomplete.approved, false)
  assert.deepEqual(incomplete.failed, ['F3-GATE-001'])
  assert.equal(incomplete.covered, 3)
  assert.deepEqual(
    incomplete.evidence[0].checks[0].missingEvidenceTypes,
    ['provider-job'],
  )

  const failedEvidence = completeEvidence()
  failedEvidence[3].checks[0].passed = false
  const failed = evaluateSyntheticPhaseGate({ ...base, evidence: failedEvidence })
  assert.equal(failed.approved, false)
  assert.deepEqual(failed.failed, ['F3-GATE-004'])
  assert.equal(failed.covered, 4)
  assert.equal(failed.passed, 3)
})

test('T-F3-GATE rejects duplicate, foreign, malformed and untraceable evidence', () => {
  const evidence = completeEvidence()
  assert.throws(
    () => evaluateSyntheticPhaseGate({ ...base, evidence: [...evidence, evidence[0]] }),
    /evidence is invalid|duplicated/,
  )

  assert.throws(
    () => evaluateSyntheticPhaseGate({
      ...base,
      evidence: [{
        criterion: 'F3-GATE-001',
        checks: [{
          code: 'approved-blocks-catalogued',
          passed: true,
          references: [{ type: 'synthetic-master', id: 'master-foreign', hash: hash('1') }],
        }],
      }],
    }),
    /does not belong/,
  )

  const duplicatedReference = completeEvidence()
  duplicatedReference[0].checks[0].references.push(
    duplicatedReference[0].checks[0].references[0],
  )
  assert.throws(
    () => evaluateSyntheticPhaseGate({ ...base, evidence: duplicatedReference }),
    /duplicate references/,
  )

  const malformedHash = completeEvidence()
  malformedHash[0].checks[0].references[0].hash = 'not-a-hash'
  assert.throws(
    () => evaluateSyntheticPhaseGate({ ...base, evidence: malformedHash }),
    /must be SHA-256/,
  )
})

test('T-F3-GATE report and its nested evidence are immutable', () => {
  const report = evaluateSyntheticPhaseGate({ ...base, evidence: completeEvidence() })
  assert.equal(Object.isFrozen(report), true)
  assert.equal(Object.isFrozen(report.evidence), true)
  assert.equal(Object.isFrozen(report.evidence[0]), true)
  assert.equal(Object.isFrozen(report.evidence[0].checks), true)
  assert.equal(Object.isFrozen(report.evidence[0].checks[0].references), true)
  assert.throws(() => report.evidence[0].checks.push({}), TypeError)
})
