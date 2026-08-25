import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { STORY_GOLDEN_FIXTURES, validateStoryPlan } from '../../src/v2/domain/story-plan.ts'
import { createStoryPlanService, readStoryPlanService } from '../../src/v2/application/story-plans.ts'
import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { parseCreateStoryPlanBody } from '../../src/v2/public-api/story-plan-contract.ts'

function hybridPlan() {
  const base = STORY_GOLDEN_FIXTURES.linear
  const sourceKinds = ['real', 'synthetic', 'proof', 'voiceover']
  const presentations = ['source-video', 'synthetic-avatar', 'proof-insert', 'voiceover']
  const brollBlock = {
    id: 'broll', actId: 'development', role: 'context', intent: 'Illustrate the proof with approved B-roll',
    dependencies: ['proof'], sourceCandidateIds: ['source-broll'],
    durationTargetMs: { min: 1000, ideal: 1500, max: 2500 },
    content: { claimIds: [], qualifierIds: [], proofIds: [] }, presentation: 'b-roll',
  }
  return {
    ...base,
    schemaVersion: 4,
    productionMode: 'hybrid',
    acts: base.acts.map((act) => act.id === 'development' ? { ...act, blockIds: [...act.blockIds, 'broll'] } : act),
    blocks: [...base.blocks.map((block, index) => ({ ...block, presentation: presentations[index] })), brollBlock],
    sourceRanges: [...base.sourceRanges.map((range, index) => ({
      ...range,
      rightsRef: `rights-${index + 1}`,
      sourceKind: sourceKinds[index],
      ...(index !== 2 ? {
        consentRef: `consent-${index + 1}`,
        identityRef: 'identity-ana',
        audioContinuityRef: 'audio-ana-ptbr',
      } : {}),
      ...(index < 2 ? { sceneContinuityRef: 'scene-studio' } : {}),
      ...(index === 1 ? { disclosure: 'Avatar gerado por IA' } : {}),
    })), { id: 'range-broll', artifactId: 'artifact-broll', startMs: 0, endMs: 1500, rightsRef: 'rights-5', sourceKind: 'b-roll' }],
    sourceCandidates: [...base.sourceCandidates, { id: 'source-broll', sourceRangeId: 'range-broll', purpose: 'context', rank: 1 }],
  }
}

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

test('T-FR-093 validates real, avatar, proof, B-roll and voiceover in one rights-aware StoryPlan', async () => {
  const plan = hybridPlan()
  const validated = validateStoryPlan(plan)
  assert.equal(validated.readyForEditPlan, true)
  assert.deepEqual(validated.plan.blocks.map((block) => block.presentation), [
    'source-video', 'synthetic-avatar', 'proof-insert', 'voiceover', 'b-roll',
  ])
  assert.equal(new Set(validated.plan.sourceRanges.map((range) => range.rightsRef)).size, 5)
  assert.equal(new Set(validated.plan.sourceRanges.filter((range) => range.consentRef).map((range) => range.consentRef)).size, 3)

  const records = new Map()
  const repository = {
    async findIdempotent(input) { return [...records.values()].find((record) => record.plan.workspaceId === input.workspaceId && record.idempotencyKey === input.idempotencyKey) ?? null },
    async persist(value) { records.set(value.plan.id, value); return { value, replayed: false } },
    async read(input) { return records.get(input.storyPlanId) ?? null },
  }
  const auditContext = createExternalAuditContext({ clientId: 'api-client-hybrid', credentialId: 'credential-hybrid', workspaceId: 'workspace-hybrid', environment: 'production' })
  const actor = { ...auditContext, scopes: new Set(['projects:write']), authenticationKind: 'bearer', clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false, clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext }
  const { schemaVersion: _schema, ...requestPlan } = plan
  const result = await createStoryPlanService({ repository, createId: () => 'story-plan-hybrid', clock: () => new Date('2026-08-25T02:00:00.000Z') })({ workspaceId: 'workspace-hybrid', projectId: 'project-hybrid', projectVersionId: 'project-version-hybrid', plan: requestPlan, actor, idempotencyKey: 'hybrid-story-key-001' })
  assert.equal(result.value.plan.schemaVersion, 4)
  assert.equal(result.value.plan.productionMode, 'hybrid')

  assert.throws(() => validateStoryPlan({ ...plan, sourceRanges: plan.sourceRanges.map((range, index) => index === 1 ? { ...range, identityRef: 'identity-other' } : range) }), /identity changes/)
  assert.throws(() => validateStoryPlan({ ...plan, sourceRanges: plan.sourceRanges.map((range, index) => index === 1 ? { ...range, disclosure: undefined } : range) }), /requires disclosure/)
  assert.throws(() => validateStoryPlan({ ...plan, sourceRanges: plan.sourceRanges.map((range, index) => index === 3 ? { ...range, consentRef: undefined } : range) }), /requires consent lineage/)
})

test('T-FR-061 migration binds StoryPlan to the exact tenant-scoped project version', () => {
  const migration = readFileSync(new URL(
    '../../prisma/v2/migrations/20260813010000_story_plans/migration.sql',
    import.meta.url,
  ), 'utf8')

  assert.match(
    migration,
    /FOREIGN KEY \("projectVersionId", "projectId", "workspaceId"\) REFERENCES "project_versions"\("id", "projectId", "workspaceId"\)/,
  )
  assert.doesNotMatch(
    migration,
    /FOREIGN KEY \("projectVersionId", "projectId"\) REFERENCES "project_versions"\("id", "projectId"\)/,
  )
})
