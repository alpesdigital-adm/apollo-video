import assert from 'node:assert/strict'
import test from 'node:test'

import { FOUNDATION_AGENT_TOOL_SAFETY } from '../../src/v2/public-api/agent-tool-safety.ts'
import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'
import {
  parseTransformationFallbackDispatch,
  presentTransformationFallbackDispatch,
} from '../../src/v2/public-api/transformation-quality-contract.ts'

const digest = (character) => character.repeat(64)

function ledger() {
  return Object.freeze({
    schemaVersion: 'transformation-fallback-ledger/v1',
    id: 'transformation-fallback-ledger-contract',
    workspaceId: 'workspace-fallback-contract',
    projectId: 'project-fallback-contract',
    projectVersionId: 'project-version-fallback-contract',
    briefId: 'transformation-brief-contract',
    briefHash: digest('a'),
    ladder: Object.freeze(['video-to-video', 'generated-cutaway', 'source-unchanged']),
    attempts: Object.freeze([Object.freeze({
      sequence: 0,
      rung: 'video-to-video',
      providerJobId: 'provider-job-rejected-contract',
      providerId: 'provider-contract',
      artifactId: 'artifact-rejected-contract',
      artifactSha256: digest('b'),
      outcome: 'rejected',
      intentScoreBps: 5_000,
      criticReportHash: digest('c'),
      violatesProtectedContent: false,
      estimatedCostMinorUnits: 100,
      observedCostMinorUnits: 100,
      costCurrency: 'USD',
      reason: 'critic rejected the first attempt',
    })]),
    currentRung: 'generated-cutaway',
    bestArtifactId: null,
    bestArtifactSha256: null,
    bestIntentScoreBps: null,
    incurredCostMinorUnits: 100,
    costCurrency: 'USD',
    reviewDecision: 'awaiting-review',
    sourceArtifactId: 'artifact-source-contract',
    sourceArtifactSha256: digest('d'),
    createdAt: '2029-08-01T10:00:00.000Z',
    updatedAt: '2029-08-01T10:01:00.000Z',
    ledgerHash: digest('e'),
  })
}

test('fallback dispatch public contract accepts only execution scope and exact ledger identity', () => {
  const body = {
    expectedLedgerHash: digest('e'),
    use: 'ads',
    market: 'BRA',
    locale: 'pt-BR',
  }
  assert.deepEqual(parseTransformationFallbackDispatch(body), body)
  for (const field of ['rung', 'operation', 'providerId', 'capabilityId', 'selectionId', 'policy', 'providerInput']) {
    assert.throws(
      () => parseTransformationFallbackDispatch({ ...body, [field]: 'caller-value' }),
      (error) => error?.code === 'INVALID_ARGUMENT',
    )
  }
  assert.throws(
    () => parseTransformationFallbackDispatch({ ...body, expectedLedgerHash: 'stale' }),
    (error) => error?.code === 'INVALID_ARGUMENT',
  )
})

test('fallback dispatch capability is paid, actor-gated and idempotent', () => {
  const capability = FOUNDATION_CAPABILITIES.find((entry) =>
    entry.id === 'apollo.projects.transformation-fallbacks.dispatch')
  assert.ok(capability)
  assert.equal(capability.endpoint.method, 'POST')
  assert.equal(capability.endpoint.path, '/v1/projects/{projectId}/transformation-fallback-ledgers/{ledgerId}/dispatches')
  assert.deepEqual([...capability.requiredScopes], ['projects:write'])
  assert.deepEqual([...capability.successStatuses], [200, 201])
  assert.equal(capability.idempotency, 'required')
  assert.equal(capability.costClass, 'variable')
  assert.equal(capability.confirmation, 'human-approval')
  assert.equal(FOUNDATION_AGENT_TOOL_SAFETY[capability.id].confirmation, 'human-approval')

  const request = getPublicSchema(capability.inputSchemaRef).schema
  assert.equal(request.additionalProperties, false)
  assert.deepEqual(request.required, ['expectedLedgerHash', 'use', 'market', 'locale'])
  assert.deepEqual(Object.keys(request.properties), request.required)
  const response = getPublicSchema(capability.outputSchemaRef).schema.properties.data
  assert.equal(response.additionalProperties, false)
  assert.deepEqual(response.required, ['outcome', 'ledger'])
  assert.equal(response.properties.ledger.additionalProperties, false)
})

test('fallback dispatch presenter withholds workspace and internal dispatch fingerprints', () => {
  const presented = presentTransformationFallbackDispatch({
    outcome: 'skipped',
    ledger: ledger(),
    reason: 'capability-unavailable',
  })
  assert.equal(presented.outcome, 'skipped')
  assert.equal(presented.reason, 'capability-unavailable')
  assert.equal(presented.ledger.id, ledger().id)
  assert.equal('workspaceId' in presented.ledger, false)
  assert.equal('idempotencyKey' in presented, false)
  assert.equal('dispatchRequestHash' in presented, false)
  assert.equal('job' in presented, false)
})
