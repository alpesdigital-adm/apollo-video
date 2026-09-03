import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

const workspaceId = 'cache-decision-int-workspace'
const foreignWorkspaceId = 'cache-decision-int-foreign'
const hash = (character) => character.repeat(64)
const at = (second) => new Date(Date.parse('2029-05-01T00:00:00.000Z') + second * 1_000).toISOString()

test('T-FR-105 synthetic cache decisions persist idempotently, summarize by outcome and fail closed on PostgreSQL', {
  skip: !process.env.V2_DATABASE_URL && 'V2_DATABASE_URL is required',
  timeout: 300_000,
}, async () => {
  const client = new PrismaClient({ datasources: { db: { url: process.env.V2_DATABASE_URL } } })

  const cleanupWorkspace = async (id) => {
    await client.v2SyntheticScriptPlan.updateMany({ where: { workspaceId: id }, data: { currentVersionId: null } })
    await client.v2SyntheticCacheDecision.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticBlockGeneration.deleteMany({ where: { workspaceId: id } })
    await client.v2ProviderResultArtifact.deleteMany({ where: { workspaceId: id } })
    await client.v2ProviderJobTransition.deleteMany({ where: { workspaceId: id } })
    await client.v2ProviderJob.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticScriptBlock.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticScriptPlanVersion.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticScriptPlan.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticPresenterProfileHead.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticPresenterProfile.deleteMany({ where: { workspaceId: id } })
    await client.v2MediaArtifactManifest.deleteMany({ where: { workspaceId: id } })
    await client.v2MediaArtifact.deleteMany({ where: { workspaceId: id } })
    await client.v2PublicEventOutbox.deleteMany({ where: { workspaceId: id } })
    await client.v2IdempotencyRecord.deleteMany({ where: { workspaceId: id } })
    await client.v2ProjectCreationCommand.deleteMany({ where: { workspaceId: id } })
    await client.v2Project.deleteMany({ where: { workspaceId: id } })
    await client.v2ApiClient.deleteMany({ where: { workspaceId: id } })
    await client.v2Workspace.deleteMany({ where: { id } })
  }
  const cleanup = async () => {
    await cleanupWorkspace(workspaceId)
    await cleanupWorkspace(foreignWorkspaceId)
  }

  try {
    await cleanup()
    const { createProjectService } = await import('../../src/v2/application/create-project.ts')
    const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
    const { createExternalAuditContext } = await import('../../src/v2/application/authenticate-api-client.ts')
    const { registerSyntheticPresenterProfileService } = await import('../../src/v2/application/synthetic-production.ts')
    const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
    const { createSyntheticCacheDecision } = await import('../../src/v2/domain/synthetic-cache-decision.ts')
    const {
      calculateSyntheticCacheKey,
      createSyntheticVoiceIdentity,
    } = await import('../../src/v2/domain/synthetic-cache-identity.ts')
    const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
    const { PrismaWorkspaceRepository } = await import('../../src/v2/infrastructure/prisma/workspace-repository.ts')
    const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
    const { PrismaMediaArtifactRepository } = await import('../../src/v2/infrastructure/prisma/media-artifact-repository.ts')
    const { PrismaProjectCreationRepository } = await import('../../src/v2/infrastructure/prisma/project-creation-repository.ts')
    const { PrismaSyntheticProductionRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-production-repository.ts')
    const { PrismaSyntheticCacheDecisionRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-cache-decision-repository.ts')

    const workspaces = new PrismaWorkspaceRepository(client)
    for (const id of [workspaceId, foreignWorkspaceId]) {
      await workspaces.create(createWorkspace({ id, slug: id, name: id, status: 'active', createdAt: at(0) }))
    }

    const clients = new PrismaApiClientRepository(client)
    const provision = async (id, ownerWorkspaceId) => {
      const issued = await createApiClientService({
        repository: clients, credentialCrypto: nodeApiCredentialCrypto, clock: () => new Date(at(0)),
      })({
        id, credentialId: `${id}-credential`, workspaceId: ownerWorkspaceId, name: id,
        environment: 'production', scopes: ['projects:read', 'projects:write'],
      })
      const audit = createExternalAuditContext({
        clientId: id, credentialId: issued.credential.id, workspaceId: ownerWorkspaceId, environment: 'production',
      })
      return Object.freeze({
        ...audit, scopes: new Set(['projects:read', 'projects:write']), authenticationKind: 'bearer',
        clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
        clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext: audit,
      })
    }
    const actor = await provision('cache-decision-client', workspaceId)
    const foreignActor = await provision('cache-decision-foreign-client', foreignWorkspaceId)

    let entity = 0
    let event = 0
    const createProject = createProjectService({
      repository: new PrismaProjectCreationRepository(client), clock: () => new Date(at(0)),
      createId: (kind) => `${kind}-cache-decision-${++entity}`,
      createEventId: () => `00000000-0000-4000-8000-${String(810_000 + ++event).padStart(12, '0')}`,
    })
    const project = await createProject({
      workspaceId, name: 'Ledger de cache', objective: 'awareness', format: '9:16',
      actor, idempotency: { clientId: actor.clientId, key: 'cache-decision-project' },
    })
    const projectId = project.project.id
    const projectVersionId = project.version.id
    const foreignProject = await createProject({
      workspaceId: foreignWorkspaceId, name: 'Ledger alheio', objective: 'awareness', format: '9:16',
      actor: foreignActor, idempotency: { clientId: foreignActor.clientId, key: 'cache-decision-foreign-project' },
    })

    // The reuse candidate the ledger points at has to exist for real: the
    // decision row is bound to it by a workspace-safe foreign key.
    await client.v2MediaArtifact.create({
      data: {
        id: 'cache-decision-consent', workspaceId, artifactKey: 'cache-decision/consent.json', sha256: hash('e'),
        byteSize: 512n, mediaType: 'data', container: 'json', status: 'available', createdAt: new Date(at(0)),
      },
    })
    const profile = await registerSyntheticPresenterProfileService({
      repository: new PrismaSyntheticProductionRepository(client),
      artifacts: new PrismaMediaArtifactRepository(client),
      clock: () => new Date(at(0)),
    })({
      workspaceId, profileId: 'cache-decision-presenter', version: 1, actorIdentityId: 'cache-decision-identity',
      avatar: { adapterId: 'heygen-v3', adapterVersion: '3.1.0', identityRef: 'avatar_ledger' },
      voice: { id: 'voice_ledger', version: 1, adapterId: 'elevenlabs-tts', adapterVersion: '1.0.0' },
      defaultLocale: 'pt-BR', status: 'active', disclosure: 'Conteúdo gerado com IA',
      consent: {
        id: 'cache-decision-consent-v1', evidenceArtifactId: 'cache-decision-consent', granted: true,
        allowedUses: ['ads'], allowedMarkets: ['BRA'], allowedLocales: ['pt-BR'],
        allowedOperations: ['tts', 'audio-avatar'], expiresAt: '2030-01-01T00:00:00.000Z',
      },
      actor, idempotencyKey: 'cache-decision-profile-v1',
    })
    const profileSnapshotId = profile.profile.profileSnapshotId

    const planId = 'cache-decision-plan'
    const planVersionId = 'cache-decision-plan-version'
    const blockId = 'cache-decision-block'
    const candidateId = 'sbg-cache-decision-candidate'
    const exactText = 'Primeira ideia do roteiro do ledger.'
    const voice = createSyntheticVoiceIdentity({
      adapterId: 'elevenlabs-tts', adapterVersion: '1.0.0', voiceId: 'voice_ledger', voiceVersion: 1,
      modelRef: null, outputFormat: 'mp3', synthesisConfig: { outputFormat: 'mp3' },
    })
    const subject = Object.freeze({ operation: 'tts', exactText, locale: 'pt-BR', voice })
    const otherSubject = Object.freeze({ operation: 'tts', exactText: 'Outra ideia inteiramente diferente.', locale: 'pt-BR', voice })
    const cacheKey = calculateSyntheticCacheKey(subject)

    await client.v2SyntheticScriptPlan.create({
      data: {
        id: planId, workspaceId, projectId, schemaVersion: 'synthetic-script-plan/v1',
        requestFingerprint: hash('1'), idempotencyKey: 'cache-decision-plan-key',
        createdByClientId: actor.clientId, createdAt: new Date(at(0)), updatedAt: new Date(at(0)),
      },
    })
    await client.v2SyntheticScriptPlanVersion.create({
      data: {
        id: planVersionId, planId, workspaceId, projectId, sequence: 1, projectVersionId, profileSnapshotId,
        schemaVersion: 'synthetic-script-plan-version/v1', locale: 'pt-BR',
        segmentationVersion: 'synthetic-script-segmentation/v1', scriptHash: hash('2'),
        commandType: 'create-plan', blockSequenceJson: JSON.stringify([blockId]), impactJson: '{}',
        commandImpactHash: hash('3'), planVersionHash: hash('4'), requestFingerprint: hash('1'),
        idempotencyKey: 'cache-decision-plan-version-key', createdByClientId: actor.clientId,
        createdAt: new Date(at(0)),
      },
    })
    await client.v2SyntheticScriptPlan.update({ where: { id: planId }, data: { currentVersionId: planVersionId } })
    await client.v2SyntheticScriptBlock.create({
      data: {
        id: blockId, workspaceId, projectId, planId, schemaVersion: 'synthetic-script-block/v1',
        exactText, normalizedTextHash: hash('5'), locale: 'pt-BR', occurrence: 1,
        createdInVersionId: planVersionId, originKind: 'initial-segmentation', blockHash: hash('6'),
        createdAt: new Date(at(0)),
      },
    })
    for (const [id, mediaType, container] of [
      ['cache-decision-audio', 'audio', 'mp3'],
      ['cache-decision-alignment', 'data', 'json'],
    ]) {
      await client.v2MediaArtifact.create({
        data: {
          id, workspaceId, artifactKey: `cache-decision/${id}.${container}`,
          sha256: hash(id === 'cache-decision-audio' ? 'a' : 'b'), byteSize: 2_048n,
          mediaType, container, status: 'available', createdAt: new Date(at(0)),
        },
      })
    }
    await client.v2ProviderJob.create({
      data: {
        id: 'cache-decision-job', workspaceId, projectId, originProjectVersionId: projectVersionId,
        schemaVersion: 'provider-job/v1', operation: 'tts', adapterId: 'elevenlabs-tts', adapterVersion: '1.0.0',
        providerJobId: 'elevenlabs_job_ledger', inputJson: '{}', inputHash: hash('c'),
        authorizationJson: '{}', authorizationHash: hash('d'), status: 'approved',
        resultArtifactId: 'cache-decision-audio', resultArtifactSha256: hash('a'),
        criticResultHash: hash('8'), jobJson: '{}', jobHash: hash('9'), requestFingerprint: hash('1'),
        idempotencyKey: 'cache-decision-job-key', createdByClientId: actor.clientId,
        createdAt: new Date(at(1)), updatedAt: new Date(at(2)), completedAt: new Date(at(2)),
      },
    })
    await client.v2SyntheticBlockGeneration.create({
      data: {
        id: candidateId, workspaceId, projectId, planId, blockId, attempt: 1,
        schemaVersion: 'synthetic-block-generation/v1', status: 'approved', cacheKey,
        cacheDecision: 'miss-generate', decisionReason: 'first generation of this cache key',
        providerJobId: 'cache-decision-job', profileSnapshotId,
        voiceAdapterId: 'elevenlabs-tts', voiceAdapterVersion: '1.0.0',
        voiceId: 'voice_ledger', voiceVersion: 1, outputFormat: 'mp3',
        synthesisConfigHash: voice.synthesisConfigHash, scriptHash: hash('7'),
        audioArtifactId: 'cache-decision-audio', alignmentArtifactId: 'cache-decision-alignment',
        attemptBudget: 3, deadlineAt: new Date(at(3_600)), createdAt: new Date(at(1)), updatedAt: new Date(at(1)),
      },
    })

    const repository = new PrismaSyntheticCacheDecisionRepository(client)
    const decide = (overrides) => createSyntheticCacheDecision({
      workspaceId, projectId, subject, policyVersion: 'synthetic-presenter-eligibility-policy/v1',
      currency: 'USD', estimatedSavingMinorUnits: 0, avoidedCostMinorUnits: 0, decidedAt: at(10),
      ...overrides,
    })
    const hit = decide({
      id: 'scd-hit-1', outcome: 'hit', reasonCode: 'CACHE_HIT_ELIGIBLE',
      reason: 'the approved twin proved blob, rights and consent',
      candidateGenerationId: candidateId, criticReportHash: hash('8'),
      estimatedSavingMinorUnits: 30, avoidedCostMinorUnits: 30,
    })

    // 1. The ledger accepts the decision and gives it back byte-identical.
    const recorded = await repository.record(hit)
    assert.equal(recorded.recorded, true)
    assert.deepEqual(recorded.decision, hit)
    assert.equal(await client.v2SyntheticCacheDecision.count({ where: { workspaceId } }), 1)

    // 2. A replay of the very same decision never books its economy twice.
    const replay = await repository.record(hit)
    assert.equal(replay.recorded, false)
    assert.deepEqual(replay.decision, hit)
    assert.equal(await client.v2SyntheticCacheDecision.count({ where: { workspaceId } }), 1)
    // The economy stays booked exactly once across the replay.
    assert.equal((await repository.summarize({ workspaceId })).byCurrency[0].avoidedCostMinorUnits, 30)
    await repository.record(hit)
    assert.equal((await repository.summarize({ workspaceId })).byCurrency[0].avoidedCostMinorUnits, 30)

    // 3. The other decision paths land in the same ledger.
    await repository.record(decide({
      id: 'scd-miss-1', outcome: 'miss', reasonCode: 'CACHE_MISS_NO_CANDIDATE',
      subject: otherSubject, reason: 'no approved generation carries this exact cache key', decidedAt: at(11),
    }))
    await repository.record(decide({
      id: 'scd-miss-2', outcome: 'miss', reasonCode: 'CANDIDATE_RIGHTS_BLOCKED',
      reason: 'every approved generation sharing this cache key was rejected by rights',
      candidateGenerationId: candidateId, decidedAt: at(12),
    }))
    await repository.record(decide({
      id: 'scd-forced-1', outcome: 'forced-regenerate', reasonCode: 'MUST_REGENERATE',
      reason: 'explicit regenerate command bypassed the cache for this block', decidedAt: at(13),
    }))
    await repository.record(decide({
      id: 'scd-blocked-1', outcome: 'blocked', reasonCode: 'CONSENT_REVOKED',
      reason: 'presenter policy refused this operation before any cache lookup', decidedAt: at(14),
    }))
    await repository.record(decide({
      id: 'scd-blocked-2', outcome: 'blocked', reasonCode: 'IN_FLIGHT_TWIN',
      reason: 'an in-flight generation already carries this exact cache key',
      estimatedSavingMinorUnits: 30, decidedAt: at(15),
    }))

    const summary = await repository.summarize({ workspaceId })
    assert.deepEqual(summary.byOutcome, { hit: 1, miss: 2, 'forced-regenerate': 1, blocked: 2 })
    assert.deepEqual([...summary.byCurrency], [
      { currency: 'USD', decisions: 6, avoidedCostMinorUnits: 30, estimatedSavingMinorUnits: 60 },
    ])
    assert.deepEqual(
      (await repository.summarize({ workspaceId, projectId })).byOutcome,
      { hit: 1, miss: 2, 'forced-regenerate': 1, blocked: 2 },
    )

    // 4. Reads are addressed by cache key and by project, newest first.
    const byKey = await repository.listByCacheKey({ workspaceId, cacheKey, limit: 10 })
    assert.deepEqual(byKey.map((entry) => entry.id), ['scd-blocked-2', 'scd-blocked-1', 'scd-forced-1', 'scd-miss-2', 'scd-hit-1'])
    assert.equal((await repository.listByCacheKey({ workspaceId, cacheKey: hash('f'), limit: 10 })).length, 0)
    assert.equal((await repository.listByProject({ workspaceId, projectId, limit: 10 })).length, 6)
    assert.equal((await repository.listByProject({ workspaceId, projectId, limit: 2 })).length, 2)

    // 5. Cross-workspace invisibility: a neighbour's economy is never yours.
    await repository.record(createSyntheticCacheDecision({
      id: 'scd-foreign-1', workspaceId: foreignWorkspaceId, projectId: foreignProject.project.id, subject,
      outcome: 'miss', reasonCode: 'CACHE_MISS_NO_CANDIDATE',
      reason: 'no approved generation carries this exact cache key',
      policyVersion: 'synthetic-presenter-eligibility-policy/v1', currency: 'USD',
      estimatedSavingMinorUnits: 0, avoidedCostMinorUnits: 0, decidedAt: at(10),
    }))
    assert.equal((await repository.listByCacheKey({ workspaceId: foreignWorkspaceId, cacheKey, limit: 10 })).length, 1)
    assert.equal((await repository.listByProject({ workspaceId: foreignWorkspaceId, projectId, limit: 10 })).length, 0)
    const foreignSummary = await repository.summarize({ workspaceId: foreignWorkspaceId })
    assert.deepEqual(foreignSummary.byOutcome, { hit: 0, miss: 1, 'forced-regenerate': 0, blocked: 0 })
    assert.deepEqual([...foreignSummary.byCurrency], [
      { currency: 'USD', decisions: 1, avoidedCostMinorUnits: 0, estimatedSavingMinorUnits: 0 },
    ])
    // The ledger stays balanced for the original workspace.
    assert.equal((await repository.summarize({ workspaceId })).byCurrency[0].decisions, 6)

    // 6. A row edited behind the application stops being served as evidence.
    await client.v2SyntheticCacheDecision.update({
      where: { id: 'scd-hit-1' }, data: { estimatedSavingMinorUnits: 4_000 },
    })
    await assert.rejects(
      repository.listByCacheKey({ workspaceId, cacheKey, limit: 10 }),
      /hash does not match its stored content/,
    )
    await client.v2SyntheticCacheDecision.update({
      where: { id: 'scd-hit-1' }, data: { estimatedSavingMinorUnits: 30 },
    })
    assert.equal((await repository.listByCacheKey({ workspaceId, cacheKey, limit: 10 })).length, 5)

    await client.v2SyntheticCacheDecision.update({
      where: { id: 'scd-miss-1' }, data: { reason: 'a reason nobody decided' },
    })
    await assert.rejects(
      repository.listByProject({ workspaceId, projectId, limit: 10 }),
      /hash does not match its stored content/,
    )
    await client.v2SyntheticCacheDecision.update({
      where: { id: 'scd-miss-1' }, data: { reason: 'no approved generation carries this exact cache key' },
    })
    assert.equal((await repository.listByProject({ workspaceId, projectId, limit: 10 })).length, 6)

    // 7. PostgreSQL refuses an entry the domain would refuse, even written raw.
    await assert.rejects(
      client.v2SyntheticCacheDecision.create({
        data: {
          id: 'scd-invalid-1', workspaceId, projectId, schemaVersion: 'synthetic-cache-decision/v1',
          operation: 'tts', cacheKey, cacheKeyVersion: 'synthetic-block-cache-key/v1',
          outcome: 'hit', reasonCode: 'CACHE_HIT_ELIGIBLE', reason: 'a hit that avoided nothing',
          candidateGenerationId: candidateId, policyVersion: 'synthetic-presenter-eligibility-policy/v1',
          estimatedSavingMinorUnits: 0, avoidedCostMinorUnits: 0, currency: 'USD',
          subjectHash: hash('9'), decisionHash: hash('a'), decidedAt: new Date(at(20)),
        },
      }),
      /synthetic_cache_decisions_hit_check/,
    )
    await assert.rejects(
      client.v2SyntheticCacheDecision.create({
        data: {
          id: 'scd-invalid-2', workspaceId, projectId, schemaVersion: 'synthetic-cache-decision/v1',
          operation: 'tts', cacheKey, cacheKeyVersion: 'synthetic-block-cache-key/v1',
          outcome: 'blocked', reasonCode: 'CONSENT_REVOKED', reason: 'a block that kept a candidate',
          candidateGenerationId: candidateId, policyVersion: 'synthetic-presenter-eligibility-policy/v1',
          estimatedSavingMinorUnits: 0, avoidedCostMinorUnits: 0, currency: 'USD',
          subjectHash: hash('9'), decisionHash: hash('b'), decidedAt: new Date(at(21)),
        },
      }),
      /synthetic_cache_decisions_blocked_check/,
    )
    assert.equal(await client.v2SyntheticCacheDecision.count({ where: { workspaceId } }), 6)
  } finally {
    await cleanup()
    await client.$disconnect()
  }
})
