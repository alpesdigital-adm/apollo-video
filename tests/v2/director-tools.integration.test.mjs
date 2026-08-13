import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  runDirectorToolModel,
} from '../../src/v2/agent/director-tools.ts'
import {
  createDirectorToolContextResolver,
  discoverDirectorToolsService,
  executeDirectorToolsService,
} from '../../src/v2/application/execute-director-tools.ts'
import { createAssetRightsSnapshot } from '../../src/v2/domain/asset-rights.ts'
import {
  DIRECTOR_TOOL_DESCRIPTORS,
  DIRECTOR_TOOL_NAMES,
} from '../../src/v2/domain/director-tools.ts'
import { STORY_GOLDEN_FIXTURES } from '../../src/v2/domain/story-plan.ts'
import { createMontageCandidateSeed, MONTAGE_RUBRIC } from '../../src/v2/domain/montage-candidate.ts'
import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'

const workspaceId = 'workspace-director-tools'
const projectId = 'project-director-tools'
const baseVersionId = 'project-version-director-tools-7'
const rightsHash = 'a'.repeat(64)

const context = (overrides = {}) => ({
  workspaceId,
  projectId,
  baseVersionId,
  budgetRemaining: 5,
  eligibleAssetRights: new Map([['asset-eligible', rightsHash]]),
  ...overrides,
})

const rights = (assetIds = []) => assetIds.map((assetId) => ({ assetId, snapshotHash: rightsHash }))
const call = (id, name, argumentsValue, estimatedCost, assetIds = [], overrides = {}) => ({
  id,
  name,
  arguments: argumentsValue,
  scope: { workspaceId, projectId },
  baseVersionId,
  estimatedCost,
  rights: rights(assetIds),
  ...overrides,
})

const candidate = createMontageCandidateSeed({
  id: 'candidate-director-1',
  seed: 'seed-director-1',
  storyPlanRef: { id: 'story-plan-director-1', hash: 'b'.repeat(64) },
  mode: 'chronological',
  hook: { id: 'hook-director-1', selfContained: true },
  blockOrder: ['hook', 'argument', 'proof', 'cta'],
  permittedBlockOrders: [['hook', 'argument', 'proof', 'cta']],
  assets: [{ id: 'asset-eligible', rightsApproved: true }],
  patternBreaks: [{ id: 'pattern-break-1', atMs: 1000, group: 'group-hook' }],
  maximumPatternBreaks: 3,
  confidence: 0.91,
  rubricSignals: { narrative: 0.9, objective: 0.8, continuity: 0.8, evidence: 0.85 },
})

const validCalls = () => [
  call('director-call-search', 'search-media', { query: 'proof document', limit: 10 }, 0.5),
  call('director-call-plan', 'create-story-plan', { plan: STORY_GOLDEN_FIXTURES.linear, assetIds: ['asset-eligible'] }, 1, ['asset-eligible']),
  call('director-call-asset', 'propose-asset', { assetId: 'asset-eligible', planNodeId: 'proof-node-1', purpose: 'Support the claim' }, 0.25, ['asset-eligible']),
  call('director-call-evaluate', 'evaluate-candidate', { candidates: [candidate], rubric: { id: MONTAGE_RUBRIC.id, weights: MONTAGE_RUBRIC.weights }, minimumConfidence: MONTAGE_RUBRIC.minimumConfidence }, 0.75, ['asset-eligible']),
  call('director-call-patch', 'propose-patch', { operations: [{ operation: 'replace', path: '/blocks/proof/assetId', value: 'asset-eligible' }], assetIds: ['asset-eligible'], rationale: 'Use the strongest eligible proof.' }, 1, ['asset-eligible']),
]

function services() {
  const invocations = []
  const handler = (name) => async (input) => {
    invocations.push({ name, input })
    return { kind: `${name}-result`, callId: input.callId }
  }
  return {
    invocations,
    searchMedia: handler('search-media'),
    createStoryPlan: handler('create-story-plan'),
    proposeAsset: handler('propose-asset'),
    evaluateCandidate: handler('evaluate-candidate'),
    proposePatch: handler('propose-patch'),
  }
}

test('T-FR-064 fake model discovers and executes exactly five typed tools through application services', async () => {
  const fake = services()
  let modelInput
  const model = {
    async generateToolCalls(input) {
      modelInput = input
      return validCalls()
    },
  }
  const result = await runDirectorToolModel({ model, context: context(), services: fake })
  assert.deepEqual(DIRECTOR_TOOL_NAMES, ['search-media', 'create-story-plan', 'propose-asset', 'evaluate-candidate', 'propose-patch'])
  assert.equal(DIRECTOR_TOOL_DESCRIPTORS.length, 5)
  assert.equal(modelInput.tools, DIRECTOR_TOOL_DESCRIPTORS)
  assert.deepEqual(fake.invocations.map((item) => item.name), DIRECTOR_TOOL_NAMES)
  assert.equal(result.results.length, 5)
  assert.equal(result.budgetRemaining, 1.5)
  assert.ok(fake.invocations.every((item) => item.input.scope.workspaceId === workspaceId && item.input.baseVersionId === baseVersionId))
})

test('T-FR-064 rejects arguments, scope, rights, budget and base version before any handler side effect', async (t) => {
  const invalidCases = [
    ['arguments', call('invalid-arguments', 'search-media', {}, 0.5)],
    ['scope', call('invalid-scope', 'search-media', { query: 'proof' }, 0.5, [], { scope: { workspaceId: 'workspace-other', projectId } })],
    ['rights', call('invalid-rights', 'propose-asset', { assetId: 'asset-eligible', planNodeId: 'proof-node-1', purpose: 'proof' }, 0.25, ['asset-eligible'], { rights: [{ assetId: 'asset-eligible', snapshotHash: 'b'.repeat(64) }] })],
    ['budget', call('invalid-budget', 'search-media', { query: 'proof' }, 0.5)],
    ['base-version', call('invalid-version', 'search-media', { query: 'proof' }, 0.5, [], { baseVersionId: 'project-version-stale-1' })],
  ]
  for (const [label, invalid] of invalidCases) {
    await t.test(label, async () => {
      const fake = services()
      const executionContext = label === 'budget' ? context({ budgetRemaining: 0.49 }) : context()
      const earlierValidCall = call(`valid-before-${label}`, 'search-media', { query: 'safe' }, 0.5)
      const model = { async generateToolCalls() { return [earlierValidCall, invalid] } }
      await assert.rejects(() => runDirectorToolModel({ model, context: executionContext, services: fake }))
      assert.equal(fake.invocations.length, 0, `${label} must reject the entire batch before the first handler`)
    })
  }
})

test('T-FR-064 application execution resolves authoritative server context before dispatch', async () => {
  const fake = services()
  const resolutions = []
  const execute = executeDirectorToolsService({
    contexts: {
      async resolve(input) {
        resolutions.push(input)
        return context()
      },
    },
    services: fake,
  })
  const result = await execute({ workspaceId, projectId, calls: validCalls() })
  assert.equal(result.results.length, 5)
  assert.deepEqual(resolutions, [{ workspaceId, projectId, requestedAssetIds: ['asset-eligible'] }])
})

test('T-FR-064 canonical Wave 5 StoryPlan and montage hashes are mandatory at the tool boundary', async () => {
  const fake = services()
  const legacyPlan = structuredClone(STORY_GOLDEN_FIXTURES.linear)
  legacyPlan.schemaVersion = 2
  delete legacyPlan.treatmentPlanRef
  await assert.rejects(
    () => runDirectorToolModel({ model: { async generateToolCalls() { return [call('legacy-story-call', 'create-story-plan', { plan: legacyPlan, assetIds: ['asset-eligible'] }, 1, ['asset-eligible'])] } }, context: context(), services: fake }),
    /current StoryPlan v3/,
  )
  const staleCandidate = { ...candidate, seedHash: 'f'.repeat(64) }
  await assert.rejects(
    () => runDirectorToolModel({ model: { async generateToolCalls() { return [call('stale-montage-call', 'evaluate-candidate', { candidates: [staleCandidate], rubric: { id: MONTAGE_RUBRIC.id, weights: MONTAGE_RUBRIC.weights }, minimumConfidence: MONTAGE_RUBRIC.minimumConfidence }, 0.75, ['asset-eligible'])] } }, context: context(), services: fake }),
    /canonical hash/,
  )
  assert.equal(fake.invocations.length, 0)
})

test('T-FR-064 context resolver derives version, rights and budget from server-side ports', async () => {
  const snapshot = createAssetRightsSnapshot({
    id: 'rights-director-tools-1', workspaceId, artifactId: 'asset-eligible', sequence: 1,
    draft: {
      status: 'approved', allowedUses: ['editorial-reuse'], prohibitedUses: [],
      consent: { status: 'not-required', allowedUses: [] },
    },
    createdBy: { type: 'system', id: 'director-tool-test' },
    createdAt: '2026-08-13T12:00:00.000Z',
  })
  const resolver = createDirectorToolContextResolver({
    directorRuns: {
      async readContext(input) {
        assert.deepEqual(input, { workspaceId, projectId })
        return { project: { locale: 'pt-BR' }, currentVersion: { id: baseVersionId } }
      },
    },
    rights: {
      async findCurrentForArtifacts(receivedWorkspaceId, assetIds) {
        assert.equal(receivedWorkspaceId, workspaceId)
        assert.deepEqual(assetIds, ['asset-eligible', 'asset-revoked'])
        return new Map([['asset-eligible', snapshot], ['asset-revoked', null]])
      },
    },
    clock: () => new Date('2026-08-13T12:01:00.000Z'),
    budgetLimit: 4,
  })
  const resolved = await resolver.resolve({
    workspaceId, projectId,
    requestedAssetIds: ['asset-revoked', 'asset-eligible', 'asset-eligible'],
  })
  assert.equal(resolved.baseVersionId, baseVersionId)
  assert.equal(resolved.budgetRemaining, 4)
  assert.equal(resolved.eligibleAssetRights.get('asset-eligible'), snapshot.snapshotHash)
  assert.equal(resolved.eligibleAssetRights.has('asset-revoked'), false)
})

test('T-FR-064 publishes fixed discovery and execution capabilities without recursive agent-tool exposure', () => {
  const catalog = discoverDirectorToolsService()
  assert.equal(catalog.tools.length, 5)
  assert.equal(catalog.execution.semantics, 'preflight-entire-batch-before-first-handler')
  const capabilities = FOUNDATION_CAPABILITIES.filter((entry) => entry.id.startsWith('apollo.director-tools.'))
  assert.deepEqual(capabilities.map((entry) => `${entry.endpoint.method} ${entry.endpoint.path}`), ['GET /v1/director-tools', 'POST /v1/director-tools'])
  assert.ok(capabilities.every((entry) => entry.toolName === undefined))
  assert.deepEqual(capabilities[1].requiredScopes, ['projects:write'])
})

test('T-FR-064 model and application layers cannot import infrastructure, Prisma, database or storage adapters', async () => {
  const files = [
    'src/v2/agent/director-tools.ts',
    'src/v2/application/execute-director-tools.ts',
    'src/v2/domain/director-tools.ts',
  ]
  for (const file of files) {
    const source = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /from ['"].*infrastructure|PrismaClient|\.\$queryRaw|\.\$executeRaw|storage\./)
  }
  const route = await readFile(new URL('../../src/app/v1/director-tools/route.ts', import.meta.url), 'utf8')
  assert.match(route, /authenticateExternalRequest/)
  assert.match(route, /requireScope\(actor, 'projects:write'\)/)
  assert.match(route, /executeDirectorToolsService/)
})
