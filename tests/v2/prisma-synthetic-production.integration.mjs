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
  const { createSyntheticAudioMasterService } = await import('../../src/v2/application/synthetic-audio-masters.ts')
  const { createSyntheticScriptPlanService } = await import('../../src/v2/application/synthetic-script-plans.ts')
  const {
    assetRightsRevision,
    createAssetRightsSnapshot,
  } = await import('../../src/v2/domain/asset-rights.ts')
  const {
    createAssetRightsChangeIntent,
  } = await import('../../src/v2/domain/asset-rights-change.ts')
  const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
  const { STORY_GOLDEN_FIXTURES } = await import('../../src/v2/domain/story-plan.ts')
  const { createSyntheticCriticReport, SYNTHETIC_CRITIC_DIMENSIONS } = await import('../../src/v2/domain/synthetic-critic-report.ts')
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
  const { PrismaProviderExecutionProvenanceRepository } = await import(
    '../../src/v2/infrastructure/prisma/provider-execution-provenance-repository.ts'
  )
  const { PrismaSyntheticProductionRepository } = await import(
    '../../src/v2/infrastructure/prisma/synthetic-production-repository.ts'
  )
  const { PrismaSyntheticCriticReportRepository } = await import(
    '../../src/v2/infrastructure/prisma/synthetic-critic-report-repository.ts'
  )
  const { PrismaSyntheticAudioMasterRepository } = await import(
    '../../src/v2/infrastructure/prisma/synthetic-audio-master-repository.ts'
  )
  const { PrismaSyntheticScriptPlanRepository } = await import(
    '../../src/v2/infrastructure/prisma/synthetic-script-plan-repository.ts'
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
    await client.v2SyntheticCriticReport.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticScriptPlan.updateMany({ where: { workspaceId }, data: { currentVersionId: null } })
    await client.v2SyntheticScriptBlock.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticScriptPlanVersion.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticScriptPlan.deleteMany({ where: { workspaceId } })
    await client.v2ProviderExecutionReceipt.deleteMany({ where: { workspaceId } })
    await client.v2ProviderTransportEvidence.deleteMany({ where: { workspaceId } })
    await client.v2ProviderResultArtifact.deleteMany({ where: { workspaceId } })
    await client.v2ProviderJobTransition.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticAudioMaster.deleteMany({ where: { workspaceId } })
    await client.v2ProviderJob.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticProductionAsset.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticProductionRun.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticPresenterProfileHead.deleteMany({ where: { workspaceId } })
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
      ['synthetic-audio-alignment', 'data', 'json', '6'],
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
    assert.equal(registered.profile.profileSnapshotId, 'synthetic-presenter-integration:v1')
    assert.equal(
      (await client.v2SyntheticPresenterProfile.findUniqueOrThrow({
        where: { id: registered.profile.profileSnapshotId },
      })).id,
      'synthetic-presenter-integration:v1',
    )

    const rightsRepository = new PrismaAssetRightsRepository(client)
    for (const [index, artifactId] of [
      'synthetic-audio-master',
      'synthetic-audio-alignment',
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

    let scriptBlockOrdinal = 0
    const scriptPlan = await createSyntheticScriptPlanService({
      plans: new PrismaSyntheticScriptPlanRepository(client),
      projects: new PrismaProjectWorkspaceQueryRepository(client),
      profiles: syntheticRepository,
      clock: () => new Date(now),
      createId: (kind) => kind === 'script-block'
        ? `synthetic-block-${++scriptBlockOrdinal}`
        : `${kind}-synthetic-production-integration`,
    })({
      workspaceId, projectId: project.project.id, projectVersionId: project.version.id,
      profileSnapshotId: registered.profile.profileSnapshotId, locale: 'pt-BR',
      scriptText: 'Olá. Mundo.', actor, idempotencyKey: 'synthetic-production-script-plan',
    })
    assert.equal(scriptPlan.plan.blocks.length, 2)
    const criticReports = new PrismaSyntheticCriticReportRepository(client)
    const blockInputs = scriptPlan.plan.blocks.map((block, index) => ({
      id: block.id, text: block.exactText,
      artifactId: index === 0 ? 'synthetic-avatar-block-one' : 'synthetic-avatar-block-two',
      artifactSha256: index === 0 ? hash('c') : hash('d'),
      reportId: index === 0 ? 'synthetic-critic-one' : 'synthetic-critic-two',
      rangeMs: index === 0 ? [0, 1_000] : [1_000, 2_000],
      jobId: index === 0 ? 'synthetic-provider-job-one' : 'synthetic-provider-job-two',
    }))
    const measured = new Set(['temporal-integrity', 'audiovisual-integrity'])
    const persistedReports = []
    for (const [index, block] of blockInputs.entries()) {
      const scriptHash = (await import('node:crypto')).createHash('sha256').update(block.text, 'utf8').digest('hex')
      const report = createSyntheticCriticReport({
        id: block.reportId, workspaceId, projectId: project.project.id, blockId: block.id,
        capability: 'audio-avatar', adapterId: 'controlled-avatar', adapterVersion: 'version-1',
        artifactId: block.artifactId, artifactSha256: block.artifactSha256,
        audioArtifactId: null, alignmentArtifactId: null, scriptHash,
        profileSnapshotId: registered.profile.profileSnapshotId, expectedIdentityRef: 'identity-ref-integration', expectationHash: hash('9'),
        evaluationContextHash: (await import('node:crypto')).createHash('sha256')
          .update(`synthetic-production-context:${block.id}:${block.artifactId}:${block.artifactSha256}`)
          .digest('hex'),
        evaluators: [{ id: 'synthetic-production-controlled', version: '1.0.0', kind: 'controlled', scope: 'controlled PostgreSQL fixture only; no live provider claim' }],
        measurements: SYNTHETIC_CRITIC_DIMENSIONS.map((dimension) => measured.has(dimension)
          ? { dimension, status: 'measured', evaluatorId: 'synthetic-production-controlled', value: 0, unit: 'fixture-score', threshold: 0, confidence: 1, evidenceRefs: [`artifact://${block.artifactId}`], range: null, note: null }
          : { dimension, status: 'not-applicable', evaluatorId: null, value: null, unit: null, threshold: null, confidence: null, evidenceRefs: [], range: null, note: 'controlled fixture does not claim an independent visual evaluator' }),
        issues: [], decision: 'approved', recommendedAction: 'none',
        thresholdsVersion: 'synthetic-critic-thresholds/audio-avatar/v1', decidedAt: now,
      })
      persistedReports.push((await criticReports.record({ report })).value)
      block.scriptHash = scriptHash
      block.reportHash = report.reportHash
      block.index = index
    }
    const productionProviderJobs = {
      async readById({ workspaceId: requestedWorkspaceId, jobId }) {
        const block = blockInputs.find((entry) => entry.jobId === jobId)
        if (requestedWorkspaceId !== workspaceId || !block) return null
        return { job: {
          id: jobId, workspaceId, projectId: project.project.id, status: 'approved', operation: 'audio-avatar',
          criticResultHash: block.reportHash,
          resultArtifact: { artifactId: block.artifactId, artifactSha256: block.artifactSha256 },
          authorization: { profileSnapshotId: registered.profile.profileSnapshotId },
          input: {
            audioArtifactId: 'synthetic-audio-master', audioRange: { startMs: block.rangeMs[0], endMs: block.rangeMs[1] },
            criticBinding: { blockId: block.id, scriptText: block.text, scriptHash: block.scriptHash, profileSnapshotId: registered.profile.profileSnapshotId },
          },
        } }
      },
    }
    const execute = createSyntheticProductionRunService({
      repository: syntheticRepository,
      projects: new PrismaProjectWorkspaceQueryRepository(client),
      artifacts: artifactRepository,
      rights: rightsRepository,
      criticReports,
      providerJobs: productionProviderJobs,
      clock: () => new Date(now),
      createRunId: () => 'synthetic-run-integration',
      createSnapshotId: () => 'synthetic-edit-plan-snapshot-integration',
    })
    const request = {
      workspaceId,
      projectId: project.project.id,
      projectVersionId: project.version.id,
      profileSnapshotId: registered.profile.profileSnapshotId,
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
        { id: blockInputs[0].id, text: blockInputs[0].text, rangeMs: [0, 1_000], cacheKey: hash('f'), providerJobId: 'synthetic-provider-job-one', audioSha256: hash('b'), artifactId: 'synthetic-avatar-block-one', critic: { id: 'synthetic-critic-one', resultHash: persistedReports[0].reportHash, status: 'approved' } },
        { id: blockInputs[1].id, text: blockInputs[1].text, rangeMs: [1_000, 2_000], cacheKey: hash('2'), providerJobId: 'synthetic-provider-job-two', audioSha256: hash('b'), artifactId: 'synthetic-avatar-block-two', critic: { id: 'synthetic-critic-two', resultHash: persistedReports[1].reportHash, status: 'approved' } },
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
    const provenanceRepository = new PrismaProviderExecutionProvenanceRepository(client)
    const audioMasterRepository = new PrismaSyntheticAudioMasterRepository(client)
    const audioMasterResult = await createSyntheticAudioMasterService({
      repository: audioMasterRepository,
      projects: new PrismaProjectWorkspaceQueryRepository(client),
      profiles: syntheticRepository,
      providerJobs: providerRepository,
      artifacts: artifactRepository,
      rights: rightsRepository,
      clock: () => new Date(now),
      createId: () => 'synthetic-approved-audio-master-integration',
    })({
      workspaceId,
      projectId: project.project.id,
      projectVersionId: project.version.id,
      profileSnapshotId: registered.profile.profileSnapshotId,
      source: { kind: 'uploaded' },
      audioArtifactId: 'synthetic-audio-master',
      alignmentEvidenceArtifactId: 'synthetic-audio-alignment',
      durationMs: 2_000,
      locale: 'pt-BR',
      words: [
        { word: 'Olá', startMs: 0, endMs: 1_000, confidence: 0.99 },
        { word: 'mundo', startMs: 1_000, endMs: 2_000, confidence: 0.98 },
      ],
      approvedAt: now,
      approvalCriticHash: hash('7'),
      use: 'ads',
      market: 'BRA',
      actor,
      idempotencyKey: 'synthetic-audio-master-integration-key',
    })
    assert.equal(audioMasterResult.replayed, false)
    assert.equal(audioMasterResult.value.master.audio.durationMs, 2_000)
    assert.equal(audioMasterResult.value.master.profileSnapshotId, registered.profile.profileSnapshotId)
    const persistedMasterRow = await client.v2SyntheticAudioMaster.findUniqueOrThrow({
      where: { id: audioMasterResult.value.master.id },
    })
    assert.equal(persistedMasterRow.profileSnapshotId, 'synthetic-presenter-integration:v1')
    assert.equal(await client.v2SyntheticAudioMaster.count({ where: { workspaceId } }), 1)
    assert.equal((await audioMasterRepository.read({ workspaceId, projectId: project.project.id, audioMasterId: audioMasterResult.value.master.id }))?.master.masterHash, audioMasterResult.value.master.masterHash)
    let providerTransition = 0
    const enqueued = await enqueueProviderJobService({
      jobs: providerRepository,
      adapters: { get: ({ adapterId, adapterVersion }) => adapterId === 'controlled-avatar' && adapterVersion === 'version-1' ? {} : null },
      profiles: syntheticRepository,
      audioMasters: audioMasterRepository,
      projects: new PrismaProjectWorkspaceQueryRepository(client),
      artifacts: artifactRepository,
      rights: rightsRepository,
      clock: () => new Date(now),
      createJobId: () => 'synthetic-provider-job-integration',
      createTransitionId: () => `synthetic-provider-transition-${++providerTransition}`,
      resolveAvatarCriticBinding: async ({ profileSnapshotId, audioRange, use, market, locale }) => ({
        blockId: blockInputs[0].id, scriptText: blockInputs[0].text,
        scriptHash: (await import('node:crypto')).createHash('sha256').update(blockInputs[0].text, 'utf8').digest('hex'),
        profileSnapshotId, expectedDurationMs: audioRange.durationMs, alignmentArtifactId: null,
        use, market, locale,
      }),
    })({
      workspaceId,
      projectId: project.project.id,
      projectVersionId: project.version.id,
      profileSnapshotId: registered.profile.profileSnapshotId,
      operation: 'audio-avatar',
      adapterId: 'controlled-avatar',
      adapterVersion: 'version-1',
      providerInput: { aspectRatio: '9:16' },
      sourceArtifactIds: ['synthetic-audio-master'],
      audioMasterId: audioMasterResult.value.master.id,
      audioRange: { startWordIndex: 0, endWordIndex: 2 },
      use: 'ads',
      market: 'BRA',
      locale: 'pt-BR',
      actor,
      idempotencyKey: 'synthetic-provider-job-integration-key',
    })
    assert.equal(enqueued.persisted.job.status, 'planned')
    assert.equal(enqueued.persisted.job.authorization.profileSnapshotId, registered.profile.profileSnapshotId)
    assert.equal(enqueued.persisted.job.authorization.profileSnapshotHash, registered.profile.snapshot.snapshotHash)
    const adapter = new ControlledAsyncMediaProviderAdapter('controlled-avatar', 'version-1', {
      capabilities: {
        operations: ['audio-avatar'], inputFormats: ['wav'], outputFormats: ['mp4'], locales: ['pt-BR'],
        duration: { minSeconds: 1, maxSeconds: 60 }, identityReference: 'profile-id', supportsSeed: true,
        supportsIdempotency: true, supportsCancellation: false, completion: 'polling', fetchedAt: now, expiresAt: '2030-01-01T00:00:00.000Z',
      },
      estimate: { currency: 'USD', costMinorUnits: 12, estimatedLatencyMs: 3_000 },
      statuses: ['queued', 'processing', 'completed'],
      result: { controlledBytes: 'video-result' },
    })
    const { PrismaProviderResultArtifactRepository } = await import(
      '../../src/v2/infrastructure/prisma/provider-result-artifact-repository.ts'
    )
    const resultArtifactRepository = new PrismaProviderResultArtifactRepository(client)
    let ledgerRecords
    let ledgerFirst
    let providerTick = 0
    const runProviderOnce = runProviderJobWorkerOnce({
      jobs: providerRepository,
      provenance: provenanceRepository,
      resultArtifacts: resultArtifactRepository,
      adapters: { get: ({ adapterId, adapterVersion }) => adapterId === adapter.id && adapterVersion === adapter.adapterVersion ? adapter : null },
      materializer: { async materialize({ job }) { return job.input } },
      ingestor: {
        async ingest({ job }) {
          await client.v2MediaArtifact.create({
            data: {
              id: 'synthetic-provider-output', workspaceId,
              artifactKey: 'synthetic-integration/provider-output.mp4', sha256: hash('8'), byteSize: 8_192n,
              mediaType: 'video', container: 'mp4', status: 'available', createdAt: new Date(now),
            },
          })
          const ledgerBase = {
            workspaceId,
            projectId: project.project.id,
            jobId: job.id,
            schemaVersion: 'provider-result-artifact/v1',
            providerJobRef: job.providerJobId,
            adapterId: 'controlled-avatar',
            adapterVersion: 'version-1',
            adapterConfigHash: adapter.configHash,
            inputHash: job.inputHash,
            authorizationHash: job.authorization.authorizationHash,
            completedAt: now,
            createdAt: now,
          }
          ledgerRecords = [
            { ...ledgerBase, id: 'provider-result-ledger-video', role: 'primary-video', artifactId: 'synthetic-provider-output', artifactSha256: hash('8'), byteSize: 8_192, mediaType: 'video', container: 'mp4', observedCost: { currency: 'USD', costMinorUnits: 12 } },
            { ...ledgerBase, id: 'provider-result-ledger-alignment', role: 'alignment-evidence', artifactId: 'synthetic-audio-alignment', artifactSha256: hash('6'), byteSize: 512, mediaType: 'data', container: 'json' },
          ]
          ledgerFirst = await resultArtifactRepository.persistOrReplay({ records: ledgerRecords })
          return { artifactId: 'synthetic-provider-output', artifactSha256: hash('8'), mediaType: 'video', byteSize: 8_192 }
        },
      },
      critic: { async evaluate() { return { approved: true, resultHash: hash('7') } } },
      clock: () => new Date(Date.parse(now) + (++providerTick * 1_000)),
      createLeaseToken: () => `synthetic-provider-lease-${providerTick}`,
      createTransitionId: () => `synthetic-provider-transition-${++providerTransition}`,
    })
    for (let stage = 0; stage < 8; stage += 1) await runProviderOnce('synthetic-provider-worker')
    const completedProvider = await providerRepository.read({
      workspaceId, projectId: project.project.id, jobId: enqueued.persisted.job.id,
    })
    assert.equal(
      completedProvider?.job.status,
      'approved',
      `provider job failed: ${JSON.stringify(completedProvider?.job.normalizedError ?? null)}`,
    )
    assert.equal(completedProvider?.job.resultArtifact?.artifactId, 'synthetic-provider-output')
    assert.equal(await client.v2ProviderJobTransition.count({ where: { workspaceId } }), 10)
    assert.deepEqual(adapter.calls, ['capabilities', 'estimate', 'submit', 'status', 'status', 'status', 'retrieve', 'capabilities'])

    assert.ok(ledgerFirst)
    assert.ok(ledgerRecords)
    assert.equal(ledgerFirst.replayed, false)
    assert.equal(ledgerFirst.records.length, 2)
    const ledgerReplay = await resultArtifactRepository.persistOrReplay({ records: ledgerRecords })
    assert.equal(ledgerReplay.replayed, true)
    assert.equal(await client.v2ProviderResultArtifact.count({ where: { workspaceId } }), 2)
    await assert.rejects(
      resultArtifactRepository.persistOrReplay({
        records: [{ ...ledgerRecords[0], artifactSha256: hash('9') }, ledgerRecords[1]],
      }),
      (error) => error.code === 'PERSISTENCE_CONFLICT',
    )
    const ledgerRows = await resultArtifactRepository.listByJob({ workspaceId, projectId: project.project.id, jobId: enqueued.persisted.job.id })
    assert.deepEqual(ledgerRows.map(({ role }) => role), ['alignment-evidence', 'primary-video'])
    assert.equal(ledgerRows[1].observedCost.costMinorUnits, 12)
    assert.equal(ledgerRows[1].providerJobRef, completedProvider.job.providerJobId)

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
