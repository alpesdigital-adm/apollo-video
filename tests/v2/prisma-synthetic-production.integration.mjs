import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

const workspaceId = 'synthetic-production-integration-workspace'
const now = '2029-01-01T00:00:00.000Z'
const hash = (character) => character.repeat(64)

test('T-FR-092 persists one consent-bound synthetic EditPlan atomically in PostgreSQL', {
  skip: !process.env.V2_DATABASE_URL && 'V2_DATABASE_URL is required',
}, async () => {
  const { createProjectService } = await import('../../src/v2/application/create-project.ts')
  const { createStoryPlanService, readStoryPlanService } = await import('../../src/v2/application/story-plans.ts')
  const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
  const {
    createExternalAuditContext,
  } = await import('../../src/v2/application/authenticate-api-client.ts')
  const {
    createSyntheticProductionRunService,
    registerSyntheticPresenterProfileService,
  } = await import('../../src/v2/application/synthetic-production.ts')
  const {
    enqueueProviderJobService,
    runProviderJobWorkerOnce,
  } = await import('../../src/v2/application/provider-jobs.ts')
  const {
    assetRightsRevision,
    createAssetRightsSnapshot,
  } = await import('../../src/v2/domain/asset-rights.ts')
  const {
    createAssetRightsChangeIntent,
  } = await import('../../src/v2/domain/asset-rights-change.ts')
  const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
  const { STORY_GOLDEN_FIXTURES } = await import('../../src/v2/domain/story-plan.ts')
  const { PrismaApiClientRepository } = await import(
    '../../src/v2/infrastructure/prisma/api-client-repository.ts'
  )
  const { PrismaAssetRightsRepository } = await import(
    '../../src/v2/infrastructure/prisma/asset-rights-repository.ts'
  )
  const { PrismaMediaArtifactRepository } = await import(
    '../../src/v2/infrastructure/prisma/media-artifact-repository.ts'
  )
  const { PrismaProjectCreationRepository } = await import(
    '../../src/v2/infrastructure/prisma/project-creation-repository.ts'
  )
  const { PrismaProjectWorkspaceQueryRepository } = await import(
    '../../src/v2/infrastructure/prisma/project-workspace-query-repository.ts'
  )
  const { PrismaProviderJobRepository } = await import(
    '../../src/v2/infrastructure/prisma/provider-job-repository.ts'
  )
  const { PrismaSyntheticProductionRepository } = await import(
    '../../src/v2/infrastructure/prisma/synthetic-production-repository.ts'
  )
  const { PrismaStoryPlanRepository } = await import(
    '../../src/v2/infrastructure/prisma/story-plan-repository.ts'
  )
  const { PrismaWorkspaceRepository } = await import(
    '../../src/v2/infrastructure/prisma/workspace-repository.ts'
  )
  const { nodeApiCredentialCrypto } = await import(
    '../../src/v2/infrastructure/security/api-credential.ts'
  )
  const { ControlledAsyncMediaProviderAdapter } = await import(
    '../../src/v2/infrastructure/controlled-async-media-provider.ts'
  )

  const client = new PrismaClient()
  const clientId = 'synthetic-production-integration-client'
  const credentialId = 'synthetic-production-integration-credential'

  const cleanup = async () => {
    await client.v2ProviderJobTransition.deleteMany({ where: { workspaceId } })
    await client.v2ProviderJob.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticProductionAsset.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticProductionRun.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticPresenterProfile.deleteMany({ where: { workspaceId } })
    await client.v2MediaArtifact.updateMany({
      where: { workspaceId },
      data: { currentRightsSnapshotId: null, rightsRevision: 0 },
    })
    await client.v2AssetRightsChange.deleteMany({ where: { workspaceId } })
    await client.v2AssetRightsSnapshot.deleteMany({ where: { workspaceId } })
    await client.v2MediaArtifact.deleteMany({ where: { workspaceId } })
    await client.v2PublicEventOutbox.deleteMany({ where: { workspaceId } })
    await client.v2IdempotencyRecord.deleteMany({ where: { workspaceId } })
    await client.v2ProjectCreationCommand.deleteMany({ where: { workspaceId } })
    await client.v2StoryPlan.deleteMany({ where: { workspaceId } })
    await client.v2Project.deleteMany({ where: { workspaceId } })
    await client.v2ApiClient.deleteMany({ where: { workspaceId } })
    await client.v2Workspace.deleteMany({ where: { id: workspaceId } })
  }

  try {
    await cleanup()
    await new PrismaWorkspaceRepository(client).create(createWorkspace({
      id: workspaceId,
      slug: workspaceId,
      name: 'Synthetic Production Integration',
      status: 'active',
      createdAt: now,
    }))
    const issued = await createApiClientService({
      repository: new PrismaApiClientRepository(client),
      credentialCrypto: nodeApiCredentialCrypto,
      clock: () => new Date(now),
    })({
      id: clientId,
      credentialId,
      workspaceId,
      name: 'Synthetic production integration client',
      environment: 'production',
      scopes: ['projects:read', 'projects:write'],
    })
    const auditContext = createExternalAuditContext({
      clientId,
      credentialId: issued.credential.id,
      workspaceId,
      environment: 'production',
    })
    const actor = Object.freeze({
      ...auditContext,
      scopes: new Set(['projects:read', 'projects:write']),
      authenticationKind: 'bearer',
      clientKillSwitchEngaged: false,
      workspaceKillSwitchEngaged: false,
      clientAccessStatus: 'active',
      workspaceAccessStatus: 'active',
      auditContext,
    })
    let entity = 0
    let event = 0
    const project = await createProjectService({
      repository: new PrismaProjectCreationRepository(client),
      clock: () => new Date(now),
      createId: (kind) => `${kind}-synthetic-integration-${++entity}`,
      createEventId: () => `00000000-0000-4000-8000-${String(++event).padStart(12, '0')}`,
    })({
      workspaceId,
      name: 'Apresentador sintético sem pessoa real',
      objective: 'awareness',
      format: '9:16',
      actor,
      idempotency: { clientId, key: 'synthetic-integration-create-project' },
    })

    const baseStory = STORY_GOLDEN_FIXTURES.linear
    const sourceKinds = ['real', 'synthetic', 'proof', 'voiceover']
    const presentations = ['source-video', 'synthetic-avatar', 'proof-insert', 'voiceover']
    const brollBlock = {
      id: 'broll', actId: 'development', role: 'context', intent: 'Illustrate the proof with approved B-roll',
      dependencies: ['proof'], sourceCandidateIds: ['source-broll'], durationTargetMs: { min: 1000, ideal: 1500, max: 2500 },
      content: { claimIds: [], qualifierIds: [], proofIds: [] }, presentation: 'b-roll',
    }
    const hybridStoryInput = {
      productionMode: 'hybrid',
      objective: baseStory.objective,
      desiredActionRef: baseStory.desiredActionRef,
      treatmentPlanRef: baseStory.treatmentPlanRef,
      targetDurationMs: baseStory.targetDurationMs,
      acts: baseStory.acts.map((act) => act.id === 'development' ? { ...act, blockIds: [...act.blockIds, 'broll'] } : act),
      blocks: [...baseStory.blocks.map((block, index) => ({ ...block, presentation: presentations[index] })), brollBlock],
      sourceRanges: [...baseStory.sourceRanges.map((range, index) => ({
        ...range,
        rightsRef: `hybrid-rights-${index + 1}`,
        sourceKind: sourceKinds[index],
        ...(index !== 2 ? { consentRef: `hybrid-consent-${index + 1}`, identityRef: 'hybrid-identity-ana', audioContinuityRef: 'hybrid-audio-ana' } : {}),
        ...(index < 2 ? { sceneContinuityRef: 'hybrid-scene-studio' } : {}),
        ...(index === 1 ? { disclosure: 'Avatar gerado por IA' } : {}),
      })), { id: 'range-broll', artifactId: 'artifact-broll', startMs: 0, endMs: 1500, rightsRef: 'hybrid-rights-5', sourceKind: 'b-roll' }],
      sourceCandidates: [...baseStory.sourceCandidates, { id: 'source-broll', sourceRangeId: 'range-broll', purpose: 'context', rank: 1 }],
      qualifiers: baseStory.qualifiers,
      claims: baseStory.claims,
      proofContexts: baseStory.proofContexts,
    }
    const storyRepository = new PrismaStoryPlanRepository(client)
    const hybridStory = await createStoryPlanService({
      repository: storyRepository,
      createId: () => 'hybrid-story-plan-integration',
      clock: () => new Date(now),
    })({
      workspaceId,
      projectId: project.project.id,
      projectVersionId: project.version.id,
      plan: hybridStoryInput,
      actor,
      idempotencyKey: 'hybrid-story-plan-integration-key',
    })
    assert.equal(hybridStory.value.plan.schemaVersion, 4)
    assert.equal(hybridStory.value.plan.productionMode, 'hybrid')
    assert.equal((await client.v2StoryPlan.findUniqueOrThrow({ where: { id: hybridStory.value.plan.id } })).schemaVersion, 4)
    const readHybrid = await readStoryPlanService({ repository: storyRepository })({ workspaceId, projectId: project.project.id, storyPlanId: hybridStory.value.plan.id })
    assert.equal(readHybrid.plan.storyHash, hybridStory.value.plan.storyHash)

    const artifacts = [
      ['synthetic-consent-evidence', 'data', 'json', 'a'],
      ['synthetic-audio-master', 'audio', 'wav', 'b'],
      ['synthetic-avatar-block-one', 'video', 'mp4', 'c'],
      ['synthetic-avatar-block-two', 'video', 'mp4', 'd'],
    ]
    for (const [id, mediaType, container, digest] of artifacts) {
      await client.v2MediaArtifact.create({
        data: {
          id,
          workspaceId,
          artifactKey: `synthetic-integration/${id}.${container}`,
          sha256: hash(digest),
          byteSize: 4_096n,
          mediaType,
          container,
          status: 'available',
          createdAt: new Date(now),
        },
      })
    }

    const artifactRepository = new PrismaMediaArtifactRepository(client)
    const syntheticRepository = new PrismaSyntheticProductionRepository(client)
    const registered = await registerSyntheticPresenterProfileService({
      repository: syntheticRepository,
      artifacts: artifactRepository,
      clock: () => new Date(now),
    })({
      workspaceId,
      profileId: 'synthetic-presenter-integration',
      version: 1,
      actorIdentityId: 'synthetic-identity-integration',
      avatar: {
        adapterId: 'controlled-avatar',
        adapterVersion: 'version-1',
        identityRef: 'identity-ref-integration',
      },
      voice: {
        id: 'synthetic-voice-integration',
        version: 1,
        adapterId: 'controlled-tts',
        adapterVersion: 'version-1',
      },
      defaultLocale: 'pt-BR',
      status: 'active',
      disclosure: 'Conteúdo gerado com IA',
      consent: {
        id: 'synthetic-consent-integration',
        evidenceArtifactId: 'synthetic-consent-evidence',
        granted: true,
        allowedUses: ['ads'],
        allowedMarkets: ['BRA'],
        allowedLocales: ['pt-BR'],
        allowedOperations: ['tts', 'audio-avatar'],
        expiresAt: '2030-01-01T00:00:00.000Z',
      },
      actor,
      idempotencyKey: 'synthetic-integration-profile-key',
    })
    assert.equal(registered.profile.snapshot.consent.evidenceSha256, hash('a'))

    const rightsRepository = new PrismaAssetRightsRepository(client)
    for (const [index, artifactId] of [
      'synthetic-audio-master',
      'synthetic-avatar-block-one',
      'synthetic-avatar-block-two',
    ].entries()) {
      const snapshot = createAssetRightsSnapshot({
        id: `synthetic-rights-${index + 1}`,
        workspaceId,
        artifactId,
        sequence: 1,
        draft: {
          status: 'approved',
          allowedUses: ['ads'],
          prohibitedUses: [],
          allowedMarkets: ['BRA'],
          allowedLocales: ['pt-BR'],
          allowedSyntheticOperations: ['tts', 'audio-avatar'],
          expiresAt: '2030-01-01T00:00:00.000Z',
          consent: { status: 'not-required', allowedUses: [] },
        },
        createdBy: { type: 'api-client', id: clientId },
        createdAt: now,
      })
      await rightsRepository.setCurrent(
        snapshot,
        assetRightsRevision(artifactId, 0),
        createAssetRightsChangeIntent({
          workspaceId,
          artifactId,
          snapshotHash: snapshot.snapshotHash,
          baseRevision: assetRightsRevision(artifactId, 0),
          actor: { kind: 'internal', actorType: 'api-client', actorId: clientId },
          changedAt: now,
        }),
      )
    }

    const execute = createSyntheticProductionRunService({
      repository: syntheticRepository,
      projects: new PrismaProjectWorkspaceQueryRepository(client),
      artifacts: artifactRepository,
      rights: rightsRepository,
      clock: () => new Date(now),
      createRunId: () => 'synthetic-run-integration',
      createSnapshotId: () => 'synthetic-edit-plan-snapshot-integration',
    })
    const request = {
      workspaceId,
      projectId: project.project.id,
      projectVersionId: project.version.id,
      profileSnapshotId: registered.profile.snapshot.id,
      audio: {
        artifactId: 'synthetic-audio-master',
        durationMs: 2_000,
        locale: 'pt-BR',
        scriptHash: hash('e'),
        alignment: [
          { text: 'Olá', startMs: 0, endMs: 1_000 },
          { text: 'mundo', startMs: 1_000, endMs: 2_000 },
        ],
      },
      blocks: [
        { id: 'synthetic-block-one', text: 'Olá', rangeMs: [0, 1_000], cacheKey: hash('f'), providerJobId: 'synthetic-provider-job-one', audioSha256: hash('b'), artifactId: 'synthetic-avatar-block-one', critic: { id: 'synthetic-critic-one', resultHash: hash('1'), status: 'approved' } },
        { id: 'synthetic-block-two', text: 'mundo', rangeMs: [1_000, 2_000], cacheKey: hash('2'), providerJobId: 'synthetic-provider-job-two', audioSha256: hash('b'), artifactId: 'synthetic-avatar-block-two', critic: { id: 'synthetic-critic-two', resultHash: hash('3'), status: 'approved' } },
      ],
      captions: true,
      use: 'ads',
      market: 'BRA',
      actor,
      idempotencyKey: 'synthetic-integration-run-key',
    }
    const created = await execute(request)
    const replay = await execute(request)
    assert.equal(created.replayed, false)
    assert.equal(replay.replayed, true)
    assert.equal(created.run.plan.hasRealPerson, false)
    assert.equal(created.run.plan.blocks.length, 2)
    assert.equal(created.run.plan.authorization.decisions.length, 3)
    assert.equal(await client.v2SyntheticProductionRun.count({ where: { workspaceId } }), 1)
    assert.equal(await client.v2SyntheticProductionAsset.count({ where: { workspaceId } }), 3)
    assert.equal(await client.v2ProjectSnapshot.count({
      where: { workspaceId, kind: 'edit-plan', id: 'synthetic-edit-plan-snapshot-integration' },
    }), 1)

    const providerRepository = new PrismaProviderJobRepository(client)
    let providerTransition = 0
    const enqueued = await enqueueProviderJobService({
      jobs: providerRepository,
      adapters: { get: ({ adapterId, adapterVersion }) => adapterId === 'controlled-avatar' && adapterVersion === 'version-1' ? {} : null },
      profiles: syntheticRepository,
      projects: new PrismaProjectWorkspaceQueryRepository(client),
      artifacts: artifactRepository,
      rights: rightsRepository,
      clock: () => new Date(now),
      createJobId: () => 'synthetic-provider-job-integration',
      createTransitionId: () => `synthetic-provider-transition-${++providerTransition}`,
    })({
      workspaceId,
      projectId: project.project.id,
      projectVersionId: project.version.id,
      profileSnapshotId: registered.profile.snapshot.id,
      operation: 'audio-avatar',
      adapterId: 'controlled-avatar',
      adapterVersion: 'version-1',
      providerInput: { audioArtifactId: 'synthetic-audio-master', durationMs: 2_000, locale: 'pt-BR' },
      sourceArtifactIds: ['synthetic-audio-master'],
      use: 'ads',
      market: 'BRA',
      locale: 'pt-BR',
      actor,
      idempotencyKey: 'synthetic-provider-job-integration-key',
    })
    assert.equal(enqueued.persisted.job.status, 'planned')
    const adapter = new ControlledAsyncMediaProviderAdapter('controlled-avatar', 'version-1', {
      capabilities: {
        operations: ['audio-avatar'], inputFormats: ['wav'], outputFormats: ['mp4'], locales: ['pt-BR'],
        duration: { minSeconds: 1, maxSeconds: 60 }, identityReference: 'profile-id', supportsSeed: true,
        supportsIdempotency: true, completion: 'polling', fetchedAt: now, expiresAt: '2030-01-01T00:00:00.000Z',
      },
      estimate: { currency: 'USD', costMinorUnits: 12, estimatedLatencyMs: 3_000 },
      statuses: ['queued', 'processing', 'completed'],
      result: { controlledBytes: 'video-result' },
    })
    let providerTick = 0
    const runProviderOnce = runProviderJobWorkerOnce({
      jobs: providerRepository,
      adapters: { get: ({ adapterId, adapterVersion }) => adapterId === adapter.id && adapterVersion === adapter.adapterVersion ? adapter : null },
      materializer: { async materialize({ job }) { return job.input } },
      ingestor: {
        async ingest() {
          await client.v2MediaArtifact.create({
            data: {
              id: 'synthetic-provider-output', workspaceId,
              artifactKey: 'synthetic-integration/provider-output.mp4', sha256: hash('8'), byteSize: 8_192n,
              mediaType: 'video', container: 'mp4', status: 'available', createdAt: new Date(now),
            },
          })
          return { artifactId: 'synthetic-provider-output', artifactSha256: hash('8'), mediaType: 'video', byteSize: 8_192 }
        },
      },
      critic: { async evaluate() { return { approved: true, resultHash: hash('7') } } },
      clock: () => new Date(Date.parse(now) + (++providerTick * 1_000)),
      createLeaseToken: () => `synthetic-provider-lease-${providerTick}`,
      createTransitionId: () => `synthetic-provider-transition-${++providerTransition}`,
    })
    for (let stage = 0; stage < 7; stage += 1) await runProviderOnce('synthetic-provider-worker')
    const completedProvider = await providerRepository.read({
      workspaceId, projectId: project.project.id, jobId: enqueued.persisted.job.id,
    })
    assert.equal(completedProvider?.job.status, 'approved')
    assert.equal(completedProvider?.job.resultArtifact?.artifactId, 'synthetic-provider-output')
    assert.equal(await client.v2ProviderJobTransition.count({ where: { workspaceId } }), 8)
    assert.deepEqual(adapter.calls, ['capabilities', 'estimate', 'submit', 'status', 'status', 'status', 'retrieve'])

    const original = await client.v2SyntheticProductionRun.findUniqueOrThrow({
      where: { id: created.run.plan.id },
      select: { planHash: true },
    })
    await client.v2SyntheticProductionRun.update({
      where: { id: created.run.plan.id },
      data: { planHash: hash('9') },
    })
    await assert.rejects(
      syntheticRepository.readRun({
        workspaceId,
        projectId: project.project.id,
        runId: created.run.plan.id,
      }),
      /failed integrity validation/,
    )
    await client.v2SyntheticProductionRun.update({
      where: { id: created.run.plan.id },
      data: { planHash: original.planHash },
    })
  } finally {
    await cleanup()
    await client.$disconnect()
  }
})
