import test from 'node:test'
import assert from 'node:assert/strict'
import { DIRECTOR_TOOL_DESCRIPTORS, runDirectorToolCalls } from '../../src/v2/agent/director-tools.ts'

const context = { workspaceId: 'ws', projectId: 'p', baseVersion: 3, budgetRemaining: 5, eligibleAssetIds: ['asset-ok'] }
const call = (id, name, args, overrides = {}) => ({ id, name, arguments: args, scope: { workspaceId: 'ws', projectId: 'p' }, baseVersion: 3, estimatedCost: 1, ...overrides })
const services = () => { const calls = []; const handler = async (value) => (calls.push(value), { proposed: true }); return { calls, searchMedia: handler, createStoryPlan: handler, proposeAsset: handler, evaluateCandidate: handler, proposePatch: handler } }

test('T-FR-064 fake model invokes five typed tools through application services only', async () => {
  const fakeModelCalls = [call('1', 'search-media', { query: 'prova' }), call('2', 'create-story-plan', { blocks: [] }), call('3', 'propose-asset', { assetId: 'asset-ok', planNodeId: 'node' }), call('4', 'evaluate-candidate', { candidateId: 'c1' }), call('5', 'propose-patch', { operations: [] })]
  const fake = services(); const result = await runDirectorToolCalls(fakeModelCalls, context, fake)
  assert.equal(DIRECTOR_TOOL_DESCRIPTORS.length, 5); assert.equal(result.results.length, 5); assert.equal(result.budgetRemaining, 0); assert.equal(fake.calls.length, 5)
})
test('T-FR-064 rejects invalid args, scope, rights, budget and base version before a service can mutate', async () => {
  const invalid = [call('a', 'search-media', {}), call('b', 'search-media', { query: 'x' }, { scope: { workspaceId: 'other', projectId: 'p' } }), call('c', 'propose-asset', { assetId: 'blocked', planNodeId: 'n' }), call('d', 'search-media', { query: 'x' }, { estimatedCost: 6 }), call('e', 'search-media', { query: 'x' }, { baseVersion: 2 })]
  for (const item of invalid) { const fake = services(); await assert.rejects(() => runDirectorToolCalls([item], context, fake)); assert.equal(fake.calls.length, 0) }
})
