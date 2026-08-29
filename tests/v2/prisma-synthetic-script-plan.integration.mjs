import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

const workspaceId = 'script-plan-int-workspace'
const clientId = 'script-plan-int-client'
const credentialId = 'script-plan-int-credential'
const hash = (character) => character.repeat(64)
const at = (second) => new Date(Date.parse('2029-02-01T00:00:00.000Z') + second * 1_000).toISOString()

test('T-FR-102 synthetic script plan commands persist stable block identities on PostgreSQL', {
  skip: !process.env.V2_DATABASE_URL && 'V2_DATABASE_URL is required',
  timeout: 240_000,
}, async () => {
  const client = new PrismaClient({ datasources: { db: { url: process.env.V2_DATABASE_URL } } })

  const cleanup = async () => {
    await client.v2SyntheticScriptPlan.updateMany({ where: { workspaceId }, data: { currentVersionId: null } })
    await client.v2SyntheticScriptBlock.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticScriptPlanVersion.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticScriptPlan.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticPresenterProfile.deleteMany({ where: { workspaceId } })
    await client.v2MediaArtifact.deleteMany({ where: { workspaceId } })
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
    const { registerSyntheticPresenterProfileService } = await import('../../src/v2/application/synthetic-production.ts')
    const {
      createSyntheticScriptPlanService,
      mutateSyntheticScriptPlanService,
      readSyntheticScriptPlanService,
    } = await import('../../src/v2/application/synthetic-script-plans.ts')
    const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
    const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
    const { PrismaWorkspaceRepository } = await import('../../src/v2/infrastructure/prisma/workspace-repository.ts')
    const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
    const { PrismaMediaArtifactRepository } = await import('../../src/v2/infrastructure/prisma/media-artifact-repository.ts')
    const { PrismaProjectCreationRepository } = await import('../../src/v2/infrastructure/prisma/project-creation-repository.ts')
    const { PrismaProjectWorkspaceQueryRepository } = await import('../../src/v2/infrastructure/prisma/project-workspace-query-repository.ts')
    const { PrismaSyntheticProductionRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-production-repository.ts')
    const { PrismaSyntheticScriptPlanRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-script-plan-repository.ts')

    await new PrismaWorkspaceRepository(client).create(createWorkspace({
      id: workspaceId, slug: workspaceId, name: 'Script plan integration', status: 'active', createdAt: at(0),
    }))
    const issued = await createApiClientService({
      repository: new PrismaApiClientRepository(client), credentialCrypto: nodeApiCredentialCrypto, clock: () => new Date(at(0)),
    })({ id: clientId, credentialId, workspaceId, name: 'Script plan client', environment: 'production', scopes: ['projects:read', 'projects:write'] })
    const auditContext = createExternalAuditContext({ clientId, credentialId: issued.credential.id, workspaceId, environment: 'production' })
    const actor = Object.freeze({
      ...auditContext, scopes: new Set(['projects:read', 'projects:write']), authenticationKind: 'bearer',
      clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
      clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext,
    })
    let entity = 0
    let event = 0
    const project = await createProjectService({
      repository: new PrismaProjectCreationRepository(client), clock: () => new Date(at(0)),
      createId: (kind) => `${kind}-script-plan-${++entity}`,
      createEventId: () => `00000000-0000-4000-8000-${String(700_000 + ++event).padStart(12, '0')}`,
    })({ workspaceId, name: 'Plano de blocos', objective: 'awareness', format: '9:16', actor, idempotency: { clientId, key: 'script-plan-project' } })
    const projectId = project.project.id
    const projectVersionId = project.version.id

    await client.v2MediaArtifact.create({
      data: {
        id: 'script-plan-consent-evidence', workspaceId, artifactKey: 'script-plan/consent.json',
        sha256: hash('a'), byteSize: 512n, mediaType: 'data', container: 'json', status: 'available', createdAt: new Date(at(0)),
      },
    })
    const syntheticRepository = new PrismaSyntheticProductionRepository(client)
    const registerProfile = registerSyntheticPresenterProfileService({
      repository: syntheticRepository, artifacts: new PrismaMediaArtifactRepository(client), clock: () => new Date(at(0)),
    })
    const profileInput = (version, voiceId, key) => ({
      workspaceId, profileId: 'script-plan-presenter', version, actorIdentityId: 'script-plan-identity',
      avatar: { adapterId: 'heygen-v3', adapterVersion: '3.0.0', identityRef: 'avatar_plan_123' },
      voice: { id: voiceId, version: 1, adapterId: 'elevenlabs-tts', adapterVersion: '1.0.0' },
      defaultLocale: 'pt-BR', status: 'active', disclosure: 'Conteúdo gerado com IA',
      consent: {
        id: `script-plan-consent-v${version}`, evidenceArtifactId: 'script-plan-consent-evidence', granted: true,
        allowedUses: ['ads'], allowedMarkets: ['BRA'], allowedLocales: ['pt-BR'],
        allowedOperations: ['tts', 'audio-avatar'], expiresAt: '2030-01-01T00:00:00.000Z',
      },
      actor, idempotencyKey: key,
    })
    const profileV1 = await registerProfile(profileInput(1, 'voice_plan_a', 'script-plan-profile-v1'))

    const plans = new PrismaSyntheticScriptPlanRepository(client)
    const projects = new PrismaProjectWorkspaceQueryRepository(client)
    const dependencies = {
      plans, projects, profiles: syntheticRepository, clock: () => new Date(at(1)),
      createId: (kind) => `${kind}-${++entity}`,
    }
    const createPlan = createSyntheticScriptPlanService(dependencies)
    const mutatePlan = mutateSyntheticScriptPlanService(dependencies)
    const readPlan = readSyntheticScriptPlanService({ plans })

    // 1. create-plan segments the script and persists blocks in order.
    const createRequest = {
      workspaceId, projectId, projectVersionId,
      profileSnapshotId: profileV1.profile.profileSnapshotId,
      locale: 'pt-BR',
      scriptText: 'Primeira ideia completa. Segunda ideia forte! Terceira pergunta? Gastou e não converteu. Gastou e não converteu.',
      actor, idempotencyKey: 'plan-create-key',
    }
    const created = await createPlan(createRequest)
    assert.equal(created.replayed, false)
    const planId = created.plan.head.id
    assert.equal(created.plan.version.sequence, 1)
    assert.equal(created.plan.version.commandType, 'create-plan')
    assert.equal(created.plan.blocks.length, 5)
    assert.deepEqual(created.plan.blocks.map(({ exactText }) => exactText), [
      'Primeira ideia completa.', 'Segunda ideia forte!', 'Terceira pergunta?',
      'Gastou e não converteu.', 'Gastou e não converteu.',
    ])
    assert.deepEqual(created.plan.blocks.slice(3).map(({ occurrence }) => occurrence), [1, 2])
    assert.equal(created.plan.version.impact.createdBlockIds.length, 5)
    assert.ok(created.plan.version.impact.cacheDecisions.every(({ decision }) => decision === 'pending'))

    // Idempotent replay and payload-mismatch rejection.
    const replayed = await createPlan(createRequest)
    assert.equal(replayed.replayed, true)
    assert.equal(replayed.plan.head.id, planId)
    await assert.rejects(
      createPlan({ ...createRequest, scriptText: 'Outro texto.' }),
      (error) => error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
    )

    const v1 = created.plan.version.id
    const idsV1 = created.plan.version.blockSequence

    // 2. insert-block creates only the inserted block.
    const inserted = await mutatePlan({
      workspaceId, projectId, projectVersionId, planId, baseVersionId: v1, baseHash: created.plan.version.planVersionHash,
      mutation: { kind: 'insert-block', position: 1, text: 'Ideia inserida no meio.' },
      actor, idempotencyKey: 'plan-insert-key',
    })
    assert.equal(inserted.replayed, false)
    assert.equal(inserted.plan.version.commandType, 'insert-block')
    assert.equal(inserted.plan.version.impact.createdBlockIds.length, 1)
    assert.equal(inserted.plan.version.impact.retiredBlockIds.length, 0)
    assert.deepEqual(inserted.plan.version.impact.reusedBlockIds.length, 5)
    const v2 = inserted.plan.version.id
    const idsV2 = inserted.plan.version.blockSequence
    assert.equal(idsV2.length, 6)
    assert.deepEqual([idsV2[0], ...idsV2.slice(2)], [...idsV1])
    const insertedBlockId = idsV2[1]
    assert.equal(inserted.plan.blocks[1].origin.kind, 'inserted')

    // 3. update-block retires only the edited block and records lineage.
    const editedTarget = idsV1[0]
    const updated = await mutatePlan({
      workspaceId, projectId, projectVersionId, planId, baseVersionId: v2, baseHash: inserted.plan.version.planVersionHash,
      mutation: { kind: 'update-block', blockId: editedTarget, text: 'Primeira ideia reescrita do zero.' },
      actor, idempotencyKey: 'plan-update-key',
    })
    assert.equal(updated.plan.version.commandType, 'update-block')
    assert.deepEqual(updated.plan.version.impact.retiredBlockIds, [editedTarget])
    assert.equal(updated.plan.version.impact.createdBlockIds.length, 1)
    const editedBlock = updated.plan.blocks[0]
    assert.equal(editedBlock.origin.kind, 'edited')
    assert.equal(editedBlock.origin.originBlockId, editedTarget)
    const retiredRow = await client.v2SyntheticScriptBlock.findUniqueOrThrow({ where: { id: editedTarget } })
    assert.equal(retiredRow.retiredInVersionId, updated.plan.version.id)
    const v3 = updated.plan.version.id

    // 4. remove-block retires exactly the removed block.
    const removed = await mutatePlan({
      workspaceId, projectId, projectVersionId, planId, baseVersionId: v3, baseHash: updated.plan.version.planVersionHash,
      mutation: { kind: 'remove-block', blockId: insertedBlockId },
      actor, idempotencyKey: 'plan-remove-key',
    })
    assert.deepEqual(removed.plan.version.impact.retiredBlockIds, [insertedBlockId])
    assert.equal(removed.plan.version.impact.createdBlockIds.length, 0)
    assert.equal(removed.plan.version.blockSequence.length, 5)
    const v4 = removed.plan.version.id

    // 5. reorder-blocks permutes identities without creating or retiring any.
    const orderV4 = removed.plan.version.blockSequence
    const reorderedOrder = [orderV4[1], orderV4[0], ...orderV4.slice(2)]
    const reordered = await mutatePlan({
      workspaceId, projectId, projectVersionId, planId, baseVersionId: v4, baseHash: removed.plan.version.planVersionHash,
      mutation: { kind: 'reorder-blocks', order: reorderedOrder },
      actor, idempotencyKey: 'plan-reorder-key',
    })
    assert.deepEqual([...reordered.plan.version.blockSequence], reorderedOrder)
    assert.equal(reordered.plan.version.impact.createdBlockIds.length, 0)
    assert.equal(reordered.plan.version.impact.retiredBlockIds.length, 0)
    assert.equal(reordered.plan.version.impact.reusedBlockIds.length, 5)
    const v5 = reordered.plan.version.id

    // Optimistic concurrency: a stale base version is rejected.
    await assert.rejects(
      mutatePlan({
        workspaceId, projectId, projectVersionId, planId, baseVersionId: v4, baseHash: removed.plan.version.planVersionHash,
        mutation: { kind: 'remove-block', blockId: orderV4[2] },
        actor, idempotencyKey: 'plan-stale-key',
      }),
      (error) => error.code === 'VERSION_CONFLICT',
    )
    // A stale project version is rejected as well.
    await assert.rejects(
      mutatePlan({
        workspaceId, projectId, projectVersionId: 'project-version-inexistente', planId, baseVersionId: v5, baseHash: reordered.plan.version.planVersionHash,
        mutation: { kind: 'remove-block', blockId: orderV4[2] },
        actor, idempotencyKey: 'plan-stale-project-key',
      }),
      (error) => error.code === 'VERSION_CONFLICT',
    )

    // 6. set-profile switches the presenter snapshot and keeps every block.
    const profileV2 = await registerProfile(profileInput(2, 'voice_plan_b', 'script-plan-profile-v2'))
    const reprofiled = await mutatePlan({
      workspaceId, projectId, projectVersionId, planId, baseVersionId: v5, baseHash: reordered.plan.version.planVersionHash,
      mutation: { kind: 'set-profile', profileSnapshotId: profileV2.profile.profileSnapshotId },
      actor, idempotencyKey: 'plan-profile-key',
    })
    assert.equal(reprofiled.plan.version.commandType, 'set-profile')
    assert.equal(reprofiled.plan.version.profileSnapshotId, profileV2.profile.profileSnapshotId)
    assert.deepEqual([...reprofiled.plan.version.blockSequence], reorderedOrder)
    assert.equal(reprofiled.plan.version.impact.createdBlockIds.length, 0)

    // 7. Mutation replay returns the same persisted version, byte-identical.
    const mutationReplay = await mutatePlan({
      workspaceId, projectId, projectVersionId, planId, baseVersionId: v5, baseHash: reordered.plan.version.planVersionHash,
      mutation: { kind: 'set-profile', profileSnapshotId: profileV2.profile.profileSnapshotId },
      actor, idempotencyKey: 'plan-profile-key',
    })
    assert.equal(mutationReplay.replayed, true)
    assert.equal(mutationReplay.plan.version.id, reprofiled.plan.version.id)
    assert.equal(await client.v2SyntheticScriptPlanVersion.count({ where: { workspaceId, planId } }), 6)

    // 8. Full history remains readable version by version.
    const history = await plans.readVersion({ workspaceId, planId, versionId: v1 })
    assert.equal(history.version.sequence, 1)
    assert.equal(history.blocks.length, 5)
    assert.equal(history.blocks[0].id, editedTarget)

    // 9. Cross-workspace isolation.
    assert.equal(await plans.readPlan({ workspaceId: 'other-workspace', projectId, planId }), null)

    // 10. Tampered persistence fails closed on read.
    const finalPlan = await readPlan({ workspaceId, projectId, planId, actor })
    assert.equal(finalPlan.version.id, reprofiled.plan.version.id)
    await client.v2SyntheticScriptPlanVersion.update({
      where: { id: reprofiled.plan.version.id },
      data: { blockSequenceJson: JSON.stringify([...reorderedOrder].reverse()) },
    })
    await assert.rejects(
      readPlan({ workspaceId, projectId, planId, actor }),
      (error) => error.code === 'PERSISTENCE_CONFLICT',
    )
  } finally {
    await cleanup()
    await client.$disconnect()
  }
})
