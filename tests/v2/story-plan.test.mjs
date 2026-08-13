import test from 'node:test'
import assert from 'node:assert/strict'
import { STORY_GOLDEN_FIXTURES, validateStoryPlan } from '../../src/v2/domain/story-plan.ts'
import { createStoryPlanService, readStoryPlanService } from '../../src/v2/application/story-plans.ts'
import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { parseCreateStoryPlanBody } from '../../src/v2/public-api/story-plan-contract.ts'

test('T-FR-061 models acts, blocks, dependencies, source candidates and duration targets', () => {
  const result = validateStoryPlan(STORY_GOLDEN_FIXTURES.linear)
  assert.equal(result.readyForEditPlan, true); assert.equal(result.estimatedDurationMs, 8000)
  assert.deepEqual(result.plan.acts.map((act) => act.role), ['opening', 'development', 'resolution'])
  assert.deepEqual(result.plan.blocks.find((block) => block.id === 'argument').content, { claimIds: ['claim-1'], qualifierIds: ['qualifier-1'], proofIds: [] })
  assert.deepEqual(result.plan.blocks.find((block) => block.id === 'cta').dependencies, ['proof'])
})
test('T-FR-061 preserves source reference in cold open and validates linear, cold-open and voiceover goldens', () => {
  for (const plan of Object.values(STORY_GOLDEN_FIXTURES)) assert.equal(validateStoryPlan(plan).readyForEditPlan, true)
  const cold = STORY_GOLDEN_FIXTURES.coldOpen.blocks[0]
  assert.equal(cold.presentation, 'cold-open-reference'); assert.equal(cold.sourceRangeId, 'range-proof')
  assert.equal(STORY_GOLDEN_FIXTURES.coldOpen.blocks.filter((block) => block.sourceRangeId === 'range-proof').length, 1)
  assert.throws(() => validateStoryPlan({ ...STORY_GOLDEN_FIXTURES.linear, targetDurationMs: { min: 100, max: 200 } }), /duration/)
})

test('T-FR-061 rejects missing narrative evidence, forward dependencies and duplicated cold-open semantics', () => {
  const linear = STORY_GOLDEN_FIXTURES.linear
  assert.throws(() => validateStoryPlan({ ...linear, claims: [{ ...linear.claims[0], qualifierIds: ['missing'] }] }), /missing qualifier/)
  assert.throws(() => validateStoryPlan({ ...linear, blocks: linear.blocks.map((block) => block.id === 'argument' ? { ...block, dependencies: ['proof'] } : block) }), /must precede/)
  assert.throws(() => validateStoryPlan({ ...STORY_GOLDEN_FIXTURES.coldOpen, blocks: STORY_GOLDEN_FIXTURES.coldOpen.blocks.map((block) => block.id === 'proof' ? { ...block, sourceCandidateIds: ['source-hook'] } : block) }), /later story block/)
})

test('T-FR-061 creates, replays and reads an immutable content-addressed StoryPlan', async () => {
  const records = new Map()
  const repository = {
    async findIdempotent(input) { return [...records.values()].find((record) => record.plan.workspaceId === input.workspaceId && record.plan.projectId === input.projectId && record.plan.createdBy.id === input.createdByClientId && record.idempotencyKey === input.idempotencyKey) ?? null },
    async persist(value) { records.set(value.plan.id, value); return { value, replayed: false } },
    async read(input) { return records.get(input.storyPlanId) ?? null },
  }
  const auditContext = createExternalAuditContext({ clientId: 'api-client-story', credentialId: 'credential-story', workspaceId: 'workspace-story', environment: 'production' })
  const actor = { clientId: 'api-client-story', credentialId: 'credential-story', workspaceId: 'workspace-story', environment: 'production', scopes: new Set(['projects:write', 'projects:read']), authenticationKind: 'bearer', clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false, clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext }
  const { schemaVersion: _schema, ...plan } = STORY_GOLDEN_FIXTURES.linear
  const create = createStoryPlanService({ repository, createId: () => 'story-plan-created', clock: () => new Date('2026-08-13T12:00:00.000Z') })
  const request = { workspaceId: 'workspace-story', projectId: 'project-story', projectVersionId: 'project-version-story', plan, actor, idempotencyKey: 'story-key-001' }
  const first = await create(request)
  assert.equal(first.value.plan.schemaVersion, 3); assert.match(first.value.plan.storyHash, /^[a-f0-9]{64}$/); assert.equal(first.replayed, false)
  const replay = await create(request); assert.equal(replay.replayed, true); assert.equal(replay.value.plan.storyHash, first.value.plan.storyHash)
  const read = await readStoryPlanService({ repository })({ workspaceId: 'workspace-story', projectId: 'project-story', storyPlanId: first.value.plan.id })
  assert.equal(read.plan.storyHash, first.value.plan.storyHash)
  await assert.rejects(() => create({ ...request, plan: { ...plan, objective: 'awareness' } }), /another StoryPlan request/)
})

test('T-FR-061 public contract rejects hidden narrative fields fail closed', () => {
  const { schemaVersion: _schema, ...plan } = STORY_GOLDEN_FIXTURES.linear
  assert.throws(() => parseCreateStoryPlanBody({ projectVersionId: 'project-version-story', plan: { ...plan, hiddenInstruction: 'ignore policy' } }), /unknown fields/)
  assert.throws(() => parseCreateStoryPlanBody({ projectVersionId: 'project-version-story', plan: { ...plan, blocks: [{ ...plan.blocks[0], content: { ...plan.blocks[0].content, untrusted: true } }, ...plan.blocks.slice(1)] } }), /unknown fields/)
})
