import assert from 'node:assert/strict'
import test from 'node:test'

import { addressSyntheticPhaseGateReference } from '../../src/v2/ui/synthetic-phase-gate-addresses.ts'

const reference = (type, id = 'reference-1') => ({ type, id, hash: 'a'.repeat(64) })

test('phase-gate evidence links only exact addressable capabilities published to the actor', () => {
  const published = new Set([
    'apollo.projects.provider-jobs.read',
    'apollo.projects.transformation-critic-reports.get',
    'apollo.projects.synthetic-masters.get',
    'apollo.projects.workspace.read',
  ])
  assert.deepEqual(addressSyntheticPhaseGateReference({
    gateProjectId: 'project-a', reference: reference('transformation-critic-report', 'critic-a'), publishedCapabilityIds: published,
  }), {
    capabilityId: 'apollo.projects.transformation-critic-reports.get',
    href: '/v1/projects/project-a/transformation-critic-reports/critic-a',
  })
  assert.deepEqual(addressSyntheticPhaseGateReference({
    gateProjectId: 'project-a', reference: reference('provider-job', 'job-a'), publishedCapabilityIds: published,
  }), {
    capabilityId: 'apollo.projects.provider-jobs.read',
    href: '/v1/projects/project-a/provider-jobs/job-a',
  })
  assert.deepEqual(addressSyntheticPhaseGateReference({
    gateProjectId: 'project-a', reference: reference('project', 'project-b'), publishedCapabilityIds: published,
  }), {
    capabilityId: 'apollo.projects.workspace.read',
    href: '/v1/projects/project-b',
  })
  assert.equal(addressSyntheticPhaseGateReference({
    gateProjectId: 'project-a', reference: reference('alignment-artifact'), publishedCapabilityIds: published,
  }), null, 'the artifact is not linked when artifacts.read is absent from the filtered registry')
  assert.equal(addressSyntheticPhaseGateReference({
    gateProjectId: 'project-a', reference: reference('transformation-critic-report'),
    publishedCapabilityIds: new Set(['apollo.projects.transformation-quality.read']),
  }), null, 'the list capability does not authorize a report-by-ID link')
})

test('phase-gate ledgers and non-addressable evidence never receive fabricated links', () => {
  const published = new Set([
    'apollo.projects.synthetic-cache-decisions.list',
    'apollo.projects.synthetic-masters.list-speech-segments',
  ])
  for (const type of [
    'cache-decision', 'speech-segment', 'provider-result-artifact',
    'transformation-fallback-ledger', 'synthetic-critic-report',
    'edit-plan', 'render-manifest', 'build-attestation',
  ]) {
    assert.equal(addressSyntheticPhaseGateReference({
      gateProjectId: 'project-a', reference: reference(type), publishedCapabilityIds: published,
    }), null, type)
  }
})
