import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

test('T-FR-062 persists and replays one immutable montage selection in PostgreSQL', {
  skip: process.env.APOLLO_MONTAGE_ALTERNATIVE_E2E !== '1' && 'set APOLLO_MONTAGE_ALTERNATIVE_E2E=1 and use an isolated V2 database',
  timeout: 60_000,
}, async () => {
  assert.ok(process.env.V2_DATABASE_URL, 'V2_DATABASE_URL must point to an isolated PostgreSQL database')
  assert.match(new URL(process.env.V2_DATABASE_URL).pathname.slice(1), /(?:^|_)e2e(?:_|$)/, 'destructive E2E setup requires an explicitly isolated database')
  const [{ createMontageAlternativeRunService }, { PrismaMontageAlternativeRepository }, { authenticatedActor }] = await Promise.all([
    import('../../src/v2/application/select-montage-candidate.ts'),
    import('../../src/v2/infrastructure/prisma/montage-alternative-repository.ts'),
    import('./helpers/authenticated-actor.mjs'),
  ])
  const client = new PrismaClient()
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `montage-workspace-${suffix}`
  const projectId = `montage-project-${suffix}`
  const clientId = `montage-client-${suffix}`
  const createdAt = new Date('2026-08-13T12:00:00.000Z')
  try {
    await client.$executeRawUnsafe('TRUNCATE TABLE "workspaces" CASCADE')
    await client.v2Workspace.create({ data: { id: workspaceId, slug: workspaceId, name: 'Montage alternatives E2E', status: 'active', createdAt, updatedAt: createdAt } })
    await client.v2ApiClient.create({ data: { id: clientId, workspaceId, name: 'Montage alternatives E2E', environment: 'development', status: 'active', scopes: ['projects:read', 'projects:write'], createdAt, updatedAt: createdAt } })
    await client.v2Project.create({ data: { id: projectId, workspaceId, name: 'Montage alternatives E2E', status: 'draft', objective: 'discovery', format: '9:16', locale: 'pt-BR', createdByType: 'api-client', createdById: clientId, createdAt, updatedAt: createdAt } })
    const actor = authenticatedActor({ clientId, workspaceId, scopes: ['projects:read', 'projects:write'] })
    const request = {
      workspaceId, projectId, policyVersion: 'montage-alternatives-2026-08-v1', storyPlanRef: { id: `story-plan-${suffix}`, hash: 'a'.repeat(64) }, actor, idempotencyKey: `montage-key-${suffix}`,
      seeds: [{ id: `candidate-${suffix}`, seed: `seed-${suffix}`, storyPlanRef: { id: `story-plan-${suffix}`, hash: 'a'.repeat(64) }, mode: 'chronological', hook: { id: `hook-${suffix}`, selfContained: true }, blockOrder: [`block-${suffix}`], permittedBlockOrders: [[`block-${suffix}`]], assets: [], patternBreaks: [], maximumPatternBreaks: 1, confidence: 0.9, rubricSignals: { narrative: 0.9, objective: 0.8, continuity: 0.8, evidence: 0.8 } }],
    }
    const execute = createMontageAlternativeRunService({ repository: new PrismaMontageAlternativeRepository(client), clock: () => createdAt, createRunId: () => `montage-run-${suffix}` })
    const created = await execute(request)
    const replayed = await execute(request)
    assert.equal(created.replayed, false)
    assert.equal(replayed.replayed, true)
    assert.equal(replayed.run.runHash, created.run.runHash)
    assert.equal(await client.v2MontageAlternativeRun.count(), 1)
    assert.equal(created.run.selection.status, 'selected')
  } finally {
    await client.$disconnect()
  }
})
