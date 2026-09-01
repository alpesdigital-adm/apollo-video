import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

const workspaceId = 'novelty-budget-int-workspace'
const clientId = 'novelty-budget-int-client'
const credentialId = 'novelty-budget-int-credential'
const at = (second) => new Date(Date.parse('2029-03-01T00:00:00.000Z') + second * 1_000).toISOString()

test('T-FR-114 persists a deterministic novelty verdict PostgreSQL itself refuses to contradict', {
  skip: !process.env.V2_DATABASE_URL && 'V2_DATABASE_URL is required',
  timeout: 240_000,
}, async () => {
  const client = new PrismaClient({ datasources: { db: { url: process.env.V2_DATABASE_URL } } })
  const cleanup = async () => {
    await client.v2NoveltyBudgetDecisionLine.deleteMany({ where: { workspaceId } })
    await client.v2NoveltyBudgetDecision.deleteMany({ where: { workspaceId } })
    await client.v2NoveltyBudgetPolicy.deleteMany({ where: { workspaceId } })
    await client.v2PublicEventOutbox.deleteMany({ where: { workspaceId } })
    await client.v2IdempotencyRecord.deleteMany({ where: { workspaceId } })
    await client.v2ProjectCreationCommand.deleteMany({ where: { workspaceId } })
    await client.v2Project.deleteMany({ where: { workspaceId } })
    await client.v2ApiClient.deleteMany({ where: { workspaceId } })
    await client.v2Workspace.deleteMany({ where: { id: workspaceId } })
  }

  try {
    await cleanup()
    const { createProjectService } = await import('../../src/v2/application/create-project.ts')
    const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
    const { createExternalAuditContext } = await import('../../src/v2/application/authenticate-api-client.ts')
    const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
    const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
    const { PrismaWorkspaceRepository } = await import('../../src/v2/infrastructure/prisma/workspace-repository.ts')
    const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
    const { PrismaProjectCreationRepository } = await import('../../src/v2/infrastructure/prisma/project-creation-repository.ts')
    const { PrismaNoveltyBudgetRepository } = await import('../../src/v2/infrastructure/prisma/novelty-budget-repository.ts')
    const {
      DEFAULT_NOVELTY_BUDGET_POLICY,
      createNoveltyBudgetDecision,
      createNoveltyBudgetPolicy,
    } = await import('../../src/v2/domain/novelty-budget.ts')

    await new PrismaWorkspaceRepository(client).create(createWorkspace({
      id: workspaceId, slug: workspaceId, name: 'Novelty budget integration', status: 'active', createdAt: at(0),
    }))
    const issued = await createApiClientService({
      repository: new PrismaApiClientRepository(client),
      credentialCrypto: nodeApiCredentialCrypto,
      clock: () => new Date(at(0)),
    })({ id: clientId, credentialId, workspaceId, name: 'Novelty client', environment: 'production', scopes: ['projects:read', 'projects:write'] })
    const auditContext = createExternalAuditContext({ clientId, credentialId: issued.credential.id, workspaceId, environment: 'production' })
    const actor = Object.freeze({
      ...auditContext, scopes: new Set(['projects:read', 'projects:write']), authenticationKind: 'bearer',
      clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
      clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext,
    })
    let entity = 0, event = 0
    const created = await createProjectService({
      repository: new PrismaProjectCreationRepository(client),
      clock: () => new Date(at(0)),
      createId: (kind) => `${kind}-novelty-${++entity}`,
      createEventId: () => `00000000-0000-4000-8000-${String(810_000 + ++event).padStart(12, '0')}`,
    })({ workspaceId, name: 'Novelty project', objective: 'awareness', format: '9:16', actor, idempotency: { clientId, key: 'novelty-project' } })

    const projectId = created.project.id
    const projectVersionId = created.project.currentVersionId
    const repository = new PrismaNoveltyBudgetRepository(client)

    const policy = createNoveltyBudgetPolicy({ ...DEFAULT_NOVELTY_BUDGET_POLICY, id: 'novelty-policy-integration' })
    const stored = await repository.persistPolicy({ policy, workspaceId, createdAt: at(1) })
    assert.equal(stored.replayed, false)
    assert.equal(stored.policy.policyHash, policy.policyHash)
    // The policy is keyed by its hash, so writing the same policy twice
    // converges instead of accumulating rows.
    assert.equal((await repository.persistPolicy({ policy, workspaceId, createdAt: at(2) })).replayed, true)

    const candidates = [
      { id: 'cand-world', briefId: 'transformation-brief-world', mode: 'background-replacement', intensityBps: 9_000, startFrame: 0, endFrame: 120, fps: 30, servedFromCache: false },
      { id: 'cand-camera', briefId: 'transformation-brief-camera', mode: 'camera-motion', intensityBps: 5_000, startFrame: 700, endFrame: 760, fps: 30, servedFromCache: false },
      { id: 'cand-crowd', briefId: 'transformation-brief-crowd', mode: 'background-replacement', intensityBps: 10_000, startFrame: 800, endFrame: 920, fps: 30, servedFromCache: false },
      { id: 'cand-reused', briefId: 'transformation-brief-reused', mode: 'stylization', intensityBps: 6_000, startFrame: 1_600, endFrame: 1_690, fps: 30, servedFromCache: true },
    ]
    const decision = createNoveltyBudgetDecision({
      workspaceId, projectId, projectVersionId,
      treatmentPlanId: 'treatment-plan-novelty', storyPlanId: 'story-plan-novelty',
      policy, candidates, evaluatedAt: at(10),
    })
    const persisted = await repository.persistDecision({ decision, createdAt: at(10) })
    assert.equal(persisted.replayed, false)

    // Content-addressed: the same candidates under the same policy converge on
    // the same row rather than piling up near-duplicates.
    assert.equal((await repository.persistDecision({ decision, createdAt: at(11) })).replayed, true)
    assert.equal(await client.v2NoveltyBudgetDecision.count({ where: { workspaceId } }), 1)

    // Rehydration reproduces the aggregate byte for byte, hash included.
    const read = await repository.readDecision({ workspaceId, projectId, decisionId: decision.id })
    assert.equal(read.decisionHash, decision.decisionHash)
    assert.deepEqual(read.lines.map((line) => line.candidateId), decision.lines.map((line) => line.candidateId))

    // The two amounts are genuinely different numbers. A cache hit pays nothing
    // and still occupies the screen; storing one column for both is how a video
    // ends up visually exhausting and technically under budget.
    const reusedLine = read.lines.find((line) => line.briefId === 'transformation-brief-reused')
    assert.equal(reusedLine.chargedUnits, 0)
    assert.ok(reusedLine.densityUnits > 0)

    // The submission gate's question, answered from the database.
    const cameraVerdict = await repository.findBriefVerdict({ workspaceId, projectId, projectVersionId, briefId: 'transformation-brief-camera' })
    assert.notEqual(cameraVerdict.outcome, 'blocked')
    assert.equal(cameraVerdict.decisionHash, decision.decisionHash)
    assert.equal(await repository.findBriefVerdict({ workspaceId, projectId, projectVersionId, briefId: 'transformation-brief-absent' }), null)

    // At least one candidate was refused, and the refusal carries a reason an
    // operator can act on.
    const blocked = read.lines.filter((line) => line.outcome === 'blocked')
    assert.ok(blocked.length >= 1, 'the pile-up must produce at least one refusal')
    for (const line of blocked) {
      assert.ok(line.blockedBecause, 'a refusal without a reason is indistinguishable from a bug')
      assert.equal(line.chargedUnits, 0)
      assert.equal(line.densityUnits, 0)
    }

    // PostgreSQL refuses to hold a contradiction, not merely the application.
    await assert.rejects(
      client.v2NoveltyBudgetDecisionLine.create({
        data: {
          id: 'forged-blocked-with-charge', workspaceId, decisionId: decision.id, sequence: 900,
          candidateId: 'forged', briefId: 'transformation-brief-forged', effectGroup: 'world',
          outcome: 'blocked', chargedUnits: 500, grossUnits: 500, penaltyUnits: 0,
          consumedBeforeUnits: 0, remainingUnits: 0, densityUnits: 0,
          reason: 'a refusal that somehow charged the budget', blockedBecause: 'cooldown-active',
        },
      }),
      /novelty_budget_decision_lines_outcome_check/,
    )
    await assert.rejects(
      client.v2NoveltyBudgetDecisionLine.create({
        data: {
          id: 'forged-blocked-without-reason', workspaceId, decisionId: decision.id, sequence: 901,
          candidateId: 'forged-2', briefId: 'transformation-brief-forged-2', effectGroup: 'world',
          outcome: 'blocked', chargedUnits: 0, grossUnits: 500, penaltyUnits: 0,
          consumedBeforeUnits: 0, remainingUnits: 0, densityUnits: 0,
          reason: 'a refusal with no reason', blockedBecause: null,
        },
      }),
      /novelty_budget_decision_lines_outcome_check/,
    )
    await assert.rejects(
      client.v2NoveltyBudgetPolicy.create({
        data: {
          id: 'forged-policy', workspaceId, schemaVersion: 'novelty-budget-policy/v1',
          totalUnits: 100, windowUnits: 500, windowFrames: 900, cooldownFrames: 0,
          minimumSeparationFrames: 0, maximumPerGroup: 1, diversityFloor: 0,
          baseUnitsJson: '{}', unitsPerSecond: 0, proximityPenaltyBps: 0, repetitionPenaltyBps: 0,
          policyHash: 'f'.repeat(64), createdAt: new Date(at(20)),
        },
      }),
      /novelty_budget_policies_units_check/,
    )

    // A stored policy whose columns were edited behind the aggregate's back is
    // refused on read. That is what storing the hash beside the fields is for.
    await client.v2NoveltyBudgetPolicy.update({
      where: { id_workspaceId: { id: policy.id, workspaceId } },
      data: { cooldownFrames: policy.cooldownFrames + 1 },
    })
    await assert.rejects(
      repository.persistPolicy({ policy, workspaceId, createdAt: at(30) }),
      /does not match its hash/,
    )
  } finally {
    await cleanup()
    await client.$disconnect()
  }
})
