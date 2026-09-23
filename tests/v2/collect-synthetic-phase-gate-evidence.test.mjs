import assert from 'node:assert/strict'
import test from 'node:test'

import { collectSyntheticPhaseGateEvidence } from '../../src/v2/application/collect-synthetic-phase-gate-evidence.ts'
import { evaluateSyntheticPhaseGate } from '../../src/v2/domain/synthetic-phase-gate.ts'

const hash = (character) => character.repeat(64)
const ref = (type, id, character) => ({ type, id, hash: hash(character) })

function sources() {
  return {
    projectVersionId: 'version-collector',
    projectVersionHash: hash('a'),
    providerExecutions: [{
      kind: 'elevenlabs-audio-alignment',
      runtimeClass: 'controlled',
      passed: true,
      references: [
        ref('provider-job', 'job-controlled', '1'),
        ref('provider-result-artifact', 'result-controlled', '2'),
        ref('alignment-artifact', 'alignment-controlled', '3'),
      ],
    }],
    catalogues: [{
      master: ref('synthetic-master', 'master-approved', '4'),
      segments: [ref('speech-segment', 'segment-approved', '5')],
      currentAuthorityValid: true,
    }],
    reuses: [],
    transformations: [{
      ledger: ref('transformation-fallback-ledger', 'fallback-ledger', '6'),
      rejectedReport: ref('transformation-critic-report', 'critic-rejected', '7'),
      approvedResult: ref('provider-result-artifact', 'fallback-result', '8'),
      rejectedBeforeFallback: true,
      fallbackApproved: true,
    }],
    swaps: [],
  }
}

test('T-F3-GATE collector exposes controlled non-live proof but keeps live checks missing', () => {
  const evidence = collectSyntheticPhaseGateEvidence(sources())
  assert.equal(evidence.some(({ criterion }) => criterion === 'F3-GATE-001'), false)
  const report = evaluateSyntheticPhaseGate({
    workspaceId: 'workspace-collector',
    projectId: 'project-collector',
    projectVersionId: 'version-collector',
    projectVersionHash: hash('a'),
    evidence,
    evaluatedAt: '2026-09-23T12:00:00.000Z',
  })
  assert.equal(report.approved, false)
  assert.deepEqual(report.missing, ['F3-GATE-001', 'F3-GATE-004'])
  assert.deepEqual(
    report.evidence.find(({ criterion }) => criterion === 'F3-GATE-002').missingChecks,
    ['cross-project-reuse-with-zero-provider-work'],
  )
  assert.equal(
    report.evidence.find(({ criterion }) => criterion === 'F3-GATE-003').passed,
    true,
  )
})

test('T-F3-GATE collector accepts live checks only from live receipts and exact required refs', () => {
  const input = sources()
  input.providerExecutions.push({
    kind: 'elevenlabs-audio-alignment',
    runtimeClass: 'live',
    passed: true,
    references: [
      ref('provider-job', 'job-live', '1'),
      ref('provider-result-artifact', 'result-live', '2'),
      ref('alignment-artifact', 'alignment-live', '3'),
    ],
  })
  const evidence = collectSyntheticPhaseGateEvidence(input)
  const live = evidence.find(({ criterion }) => criterion === 'F3-GATE-001')
  assert.deepEqual(live.checks.map(({ code }) => code), ['elevenlabs-audio-alignment-live'])
  assert.equal(live.checks[0].references.some(({ id }) => id === 'job-controlled'), false)
})

test('T-F3-GATE collector preserves complete negative reuse and swap proof', () => {
  const input = sources()
  input.reuses.push({
    decision: ref('cache-decision', 'reuse-decision', '1'),
    master: ref('synthetic-master', 'reuse-master', '2'),
    consumerProject: ref('project', 'consumer-project', '3'),
    sourceProjectId: 'source-project',
    consumerProjectId: 'consumer-project',
    providerWorkCount: 1,
    consumedByProduction: true,
  })
  input.swaps.push({
    editPlan: ref('edit-plan', 'edit-plan', '4'),
    renderManifest: ref('render-manifest', 'manifest', '5'),
    buildAttestation: ref('build-attestation', 'attestation', '6'),
    runtimeIdentityMatches: false,
    assetsMatch: true,
    propsHashMatches: true,
    providerNeutral: true,
  })
  const evidence = collectSyntheticPhaseGateEvidence(input)
  const reuse = evidence.find(({ criterion }) => criterion === 'F3-GATE-002')
    .checks.find(({ code }) => code === 'cross-project-reuse-with-zero-provider-work')
  assert.equal(reuse.passed, false)
  const swap = evidence.find(({ criterion }) => criterion === 'F3-GATE-004')
  assert.equal(swap.checks[0].passed, false)
})
