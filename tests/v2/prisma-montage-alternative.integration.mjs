import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { seedSealedProject, testActor } from './helpers/pg-output-world.mjs'

test('T-FR-062 persists and replays one immutable montage selection in PostgreSQL', {
  skip: process.env.APOLLO_MONTAGE_ALTERNATIVE_E2E !== '1' && 'set APOLLO_MONTAGE_ALTERNATIVE_E2E=1 and use an isolated V2 database',
  timeout: 60_000,
}, async () => {
  assert.ok(process.env.V2_DATABASE_URL, 'V2_DATABASE_URL must point to an isolated PostgreSQL database')
  assert.match(new URL(process.env.V2_DATABASE_URL).pathname.slice(1), /(?:^|_)e2e(?:_|$)/, 'destructive E2E setup requires an explicitly isolated database')
  const [{ createMontageAlternativeRunService }, { PrismaMontageAlternativeRepository }, { createStoryPlanService }, { PrismaStoryPlanRepository }, { STORY_GOLDEN_FIXTURES }] = await Promise.all([
    import('../../src/v2/application/select-montage-candidate.ts'),
    import('../../src/v2/infrastructure/prisma/montage-alternative-repository.ts'),
    import('../../src/v2/application/story-plans.ts'),
    import('../../src/v2/infrastructure/prisma/story-plan-repository.ts'),
    import('../../src/v2/domain/story-plan.ts'),
  ])
  const client = new PrismaClient()
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `montage-workspace-${suffix}`
  const projectId = `montage-project-${suffix}`
  const clientId = `montage-client-${suffix}`
  const createdAt = new Date('2026-08-13T12:00:00.000Z')
  try {
    // The project is created the way the product creates it (creation Command, no output): the montage selection is a record of the
    // project, not of a Version. Identities are unique to the run, so the count below is scoped to this workspace and nothing is reset.
    const actor = testActor({ workspaceId, clientId, scopes: ['projects:read', 'projects:write'] })
    const sealed = await seedSealedProject(client, { workspaceId, actor, prefix: 'montage', ids: { project: projectId }, name: 'Montage alternatives E2E',
      objective: 'discovery', variant: false, at: () => createdAt })
    // The selection binds an exact persisted StoryPlan (id and hash): the service refuses a reference to a plan that was never stored.
    const baseStory = STORY_GOLDEN_FIXTURES.linear
    const storyPlan = (await createStoryPlanService({ repository: new PrismaStoryPlanRepository(client), createId: () => `story-plan-${suffix}`, clock: () => createdAt })({
      workspaceId, projectId, projectVersionId: sealed.head.version.id, actor, idempotencyKey: `story-plan-key-${suffix}`,
      plan: { objective: baseStory.objective, desiredActionRef: baseStory.desiredActionRef, treatmentPlanRef: baseStory.treatmentPlanRef, targetDurationMs: baseStory.targetDurationMs,
        acts: baseStory.acts, blocks: baseStory.blocks, sourceRanges: baseStory.sourceRanges, sourceCandidates: baseStory.sourceCandidates,
        qualifiers: baseStory.qualifiers, claims: baseStory.claims, proofContexts: baseStory.proofContexts },
    })).value.plan
    const storyPlanRef = { id: storyPlan.id, hash: storyPlan.storyHash }
    const request = {
      workspaceId, projectId, policyVersion: 'montage-alternatives-2026-08-v1', storyPlanRef, actor, idempotencyKey: `montage-key-${suffix}`,
      seeds: [{ id: `candidate-${suffix}`, seed: `seed-${suffix}`, storyPlanRef, mode: 'chronological', hook: { id: `hook-${suffix}`, selfContained: true }, blockOrder: [`block-${suffix}`], permittedBlockOrders: [[`block-${suffix}`]], assets: [], patternBreaks: [], maximumPatternBreaks: 1, confidence: 0.9, rubricSignals: { narrative: 0.9, objective: 0.8, continuity: 0.8, evidence: 0.8 } }],
    }
    const execute = createMontageAlternativeRunService({ repository: new PrismaMontageAlternativeRepository(client), clock: () => createdAt, createRunId: () => `montage-run-${suffix}` })
    const created = await execute(request)
    const replayed = await execute(request)
    assert.equal(created.replayed, false)
    assert.equal(replayed.replayed, true)
    assert.equal(replayed.run.runHash, created.run.runHash)
    assert.equal(await client.v2MontageAlternativeRun.count({ where: { workspaceId } }), 1)
    assert.equal(created.run.selection.status, 'selected')
  } finally {
    await client.$disconnect()
  }
})
