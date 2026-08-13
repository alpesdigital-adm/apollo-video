import assert from 'node:assert/strict'
import test from 'node:test'

import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import { parseCreateMontageAlternativeBody, presentMontageAlternativeRun } from '../../src/v2/public-api/montage-alternative-contract.ts'

function body() {
  return { policyVersion: 'montage-alternatives-2026-08-v1', storyPlanRef: { id: 'story-plan-api', hash: 'a'.repeat(64) }, seeds: [{ id: 'candidate-api', seed: 'seed-api', mode: 'cold-open', hook: { id: 'hook-api', selfContained: true }, blockOrder: ['block-api'], permittedBlockOrders: [['block-api']], assets: [], patternBreaks: [], maximumPatternBreaks: 0, confidence: 0.8, rubricSignals: { narrative: 0.8, objective: 0.8, continuity: 0.8, evidence: 0.8 } }] }
}

test('T-FR-062 public request parser binds every seed to the exact StoryPlan contract', () => {
  const parsed = parseCreateMontageAlternativeBody(body())
  assert.equal(parsed.seeds[0].storyPlanRef, parsed.storyPlanRef)
  assert.equal(parsed.storyPlanRef.hash, 'a'.repeat(64))
})

test('T-FR-062 public request parser fails closed on undeclared input', () => {
  assert.throws(() => parseCreateMontageAlternativeBody({ ...body(), score: 1 }), /unsupported field/)
  const mutated = body()
  mutated.seeds[0].estimatedCost = 0
  assert.throws(() => parseCreateMontageAlternativeBody(mutated), /unsupported field/)
})

test('T-FR-062 publishes create and scoped read capabilities', () => {
  const create = FOUNDATION_CAPABILITIES.find(({ id }) => id === 'apollo.projects.montage-alternatives.create')
  const read = FOUNDATION_CAPABILITIES.find(({ id }) => id === 'apollo.projects.montage-alternatives.read')
  assert.deepEqual({ method: create.endpoint.method, scope: create.requiredScopes[0], idempotency: create.idempotency }, { method: 'POST', scope: 'projects:write', idempotency: 'required' })
  assert.deepEqual({ method: read.endpoint.method, scope: read.requiredScopes[0] }, { method: 'GET', scope: 'projects:read' })
})

test('T-FR-062 public presentation never exposes idempotency internals', () => {
  const presented = presentMontageAlternativeRun({
    schemaVersion: 'montage-alternative-run/v1', id: 'montage-run-api', workspaceId: 'workspace-api', projectId: 'project-api',
    policyVersion: 'montage-alternatives-2026-08-v1', storyPlanRef: { id: 'story-plan-api', hash: 'a'.repeat(64) },
    selection: {}, createdByClientId: 'client-api', createdAt: '2026-08-13T13:00:00.000Z', runHash: 'b'.repeat(64),
    requestFingerprint: 'c'.repeat(64), idempotencyKey: 'montage-key-api',
  })
  assert.equal('requestFingerprint' in presented, false)
  assert.equal('idempotencyKey' in presented, false)
})
