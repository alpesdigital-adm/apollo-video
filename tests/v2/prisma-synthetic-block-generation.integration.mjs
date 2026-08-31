import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')

const workspaceId = 'block-generation-int-workspace'
const clientId = 'block-generation-int-client'
const credentialId = 'block-generation-int-credential'
const hash = (character) => character.repeat(64)
const at = (second) => new Date(Date.parse('2029-03-01T00:00:00.000Z') + second * 1_000).toISOString()

test('T-FR-102 per-block provider jobs cache, retry and supersede in isolation on PostgreSQL', {
  skip: !process.env.V2_DATABASE_URL && 'V2_DATABASE_URL is required',
  timeout: 480_000,
}, async () => {
  const client = new PrismaClient({ datasources: { db: { url: process.env.V2_DATABASE_URL } } })
  const root = await mkdtemp(join(tmpdir(), 'apollo-block-generation-'))
  const artifactRoot = join(root, 'artifacts')
  const workRoot = join(root, 'work')
  await mkdir(artifactRoot, { recursive: true })
  await mkdir(workRoot, { recursive: true })

  const cleanup = async () => {
    await client.v2SyntheticScriptPlan.updateMany({ where: { workspaceId }, data: { currentVersionId: null } })
    await client.v2SyntheticCacheDecision.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticBlockGeneration.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticScriptBlock.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticScriptPlanVersion.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticScriptPlan.deleteMany({ where: { workspaceId } })
    await client.v2ProviderResultArtifact.deleteMany({ where: { workspaceId } })
    await client.v2ProviderJobTransition.deleteMany({ where: { workspaceId } })
    await client.v2ProviderJob.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticPresenterProfileHead.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticPresenterProfile.deleteMany({ where: { workspaceId } })
    await client.v2MediaArtifact.updateMany({ where: { workspaceId }, data: { currentRightsSnapshotId: null, rightsRevision: 0 } })
    await client.v2AssetRightsChange.deleteMany({ where: { workspaceId } })
    await client.v2AssetRightsSnapshot.deleteMany({ where: { workspaceId } })
    await client.v2MediaArtifactLineage.deleteMany({ where: { workspaceId } })
    await client.v2MediaArtifactManifest.deleteMany({ where: { workspaceId } })
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
    const { enqueueProviderJobService, runProviderJobWorkerOnce } = await import('../../src/v2/application/provider-jobs.ts')
    const {
      createSyntheticScriptPlanService,
      mutateSyntheticScriptPlanService,
    } = await import('../../src/v2/application/synthetic-script-plans.ts')
    const {
      ensureSyntheticBlockGenerationsService,
      settleSyntheticBlockGenerationsService,
    } = await import('../../src/v2/application/synthetic-block-generations.ts')
    const { assetRightsRevision, createAssetRightsSnapshot } = await import('../../src/v2/domain/asset-rights.ts')
    const { createAssetRightsChangeIntent } = await import('../../src/v2/domain/asset-rights-change.ts')
    const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
    const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
    const { PrismaWorkspaceRepository } = await import('../../src/v2/infrastructure/prisma/workspace-repository.ts')
    const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
    const { PrismaAssetRightsRepository } = await import('../../src/v2/infrastructure/prisma/asset-rights-repository.ts')
    const { PrismaMediaArtifactRepository } = await import('../../src/v2/infrastructure/prisma/media-artifact-repository.ts')
    const { PrismaProjectCreationRepository } = await import('../../src/v2/infrastructure/prisma/project-creation-repository.ts')
    const { PrismaProjectWorkspaceQueryRepository } = await import('../../src/v2/infrastructure/prisma/project-workspace-query-repository.ts')
    const { PrismaProviderJobRepository } = await import('../../src/v2/infrastructure/prisma/provider-job-repository.ts')
    const { PrismaProviderResultArtifactRepository } = await import('../../src/v2/infrastructure/prisma/provider-result-artifact-repository.ts')
    const { PrismaSyntheticProductionRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-production-repository.ts')
    const { PrismaSyntheticAudioMasterRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-audio-master-repository.ts')
    const { PrismaSyntheticScriptPlanRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-script-plan-repository.ts')
    const { PrismaSyntheticBlockGenerationRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-block-generation-repository.ts')
    const { PrismaSyntheticCacheDecisionRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-cache-decision-repository.ts')
    const { LocalArtifactSourceMaterializer, LocalMediaUploadStorage } = await import('../../src/v2/infrastructure/media/local-media-upload-storage.ts')
    const { probeAudioDurationSeconds } = await import('../../src/v2/infrastructure/media/video-probe.ts')
    const { ElevenLabsTtsProviderAdapter } = await import('../../src/v2/infrastructure/elevenlabs-tts-provider.ts')
    const { AuthorizedProviderSubmissionInputMaterializer } = await import('../../src/v2/infrastructure/provider-submission-input-materializer.ts')
    const { PersistedTtsResultCritic, VerifiedTtsResultIngestor } = await import('../../src/v2/infrastructure/provider-result-ingestion.ts')

    // Real 2s MP3 per distinct text: different sentences must yield different
    // bytes, exactly like a real TTS provider — identical bytes for different
    // jobs would (correctly) fail the content-addressed manifest closed.
    const audioByText = new Map()
    const ttsAudioBytesFor = async (text) => {
      if (!audioByText.has(text)) {
        const index = audioByText.size
        const path = join(root, `tts-speech-${index}.mp3`)
        execFileSync(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${240 + index * 37}:sample_rate=44100:duration=2`, '-c:a', 'libmp3lame', '-b:a', '128k', path], { windowsHide: true })
        audioByText.set(text, await readFile(path))
      }
      return audioByText.get(text)
    }

    await new PrismaWorkspaceRepository(client).create(createWorkspace({
      id: workspaceId, slug: workspaceId, name: 'Block generation integration', status: 'active', createdAt: at(0),
    }))
    const issued = await createApiClientService({
      repository: new PrismaApiClientRepository(client), credentialCrypto: nodeApiCredentialCrypto, clock: () => new Date(at(0)),
    })({ id: clientId, credentialId, workspaceId, name: 'Block generation client', environment: 'production', scopes: ['projects:read', 'projects:write'] })
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
      createId: (kind) => `${kind}-blockgen-${++entity}`,
      createEventId: () => `00000000-0000-4000-8000-${String(600_000 + ++event).padStart(12, '0')}`,
    })({ workspaceId, name: 'Blocos incrementais', objective: 'awareness', format: '9:16', actor, idempotency: { clientId, key: 'blockgen-project' } })
    const projectId = project.project.id
    const projectVersionId = project.version.id

    await client.v2MediaArtifact.create({
      data: {
        id: 'blockgen-consent-evidence', workspaceId, artifactKey: 'blockgen/consent.json',
        sha256: hash('a'), byteSize: 512n, mediaType: 'data', container: 'json', status: 'available', createdAt: new Date(at(0)),
      },
    })
    const syntheticRepository = new PrismaSyntheticProductionRepository(client)
    const artifactRepository = new PrismaMediaArtifactRepository(client)
    const registerProfile = registerSyntheticPresenterProfileService({
      repository: syntheticRepository, artifacts: artifactRepository, clock: () => new Date(at(0)),
    })
    const profileInput = (version, voiceId, key, extra = {}) => ({
      workspaceId, profileId: 'blockgen-presenter', version, actorIdentityId: 'blockgen-identity',
      avatar: { adapterId: 'heygen-v3', adapterVersion: '3.0.0', identityRef: 'avatar_blockgen' },
      voice: { id: voiceId, version: 1, adapterId: 'elevenlabs-tts', adapterVersion: '1.0.0' },
      defaultLocale: 'pt-BR', status: 'active', disclosure: 'Conteúdo gerado com IA',
      consent: {
        id: `blockgen-consent-v${version}`, evidenceArtifactId: 'blockgen-consent-evidence', granted: true,
        allowedUses: ['ads'], allowedMarkets: ['BRA'], allowedLocales: ['pt-BR'],
        allowedOperations: ['tts', 'audio-avatar'], expiresAt: '2030-01-01T00:00:00.000Z',
        ...extra,
      },
      actor, idempotencyKey: key,
    })
    const profileV1 = await registerProfile(profileInput(1, 'voice_block_a', 'blockgen-profile-v1'))

    // Controlled ElevenLabs boundary: real adapter, per-call alignment built
    // from the exact requested text, failures injected by text marker.
    const providerCalls = []
    let requestSequence = 0
    const elevenLabsAdapter = new ElevenLabsTtsProviderAdapter({
      apiKey: 'blockgen-elevenlabs-secret', costMinorUnitsPerThousandCharacters: 30,
      clock: () => new Date(at(3)),
      fetch: async (url, init) => {
        const body = JSON.parse(String(init.body))
        providerCalls.push(body.text)
        if (body.text.includes('FALHE')) {
          return new Response(JSON.stringify({ detail: { status: 'error' } }), { status: 500, headers: { 'content-type': 'application/json' } })
        }
        // Real TTS is stochastic: every paid call yields distinct bytes.
        requestSequence += 1
        const characters = [...body.text]
        const step = 2 / characters.length
        return new Response(JSON.stringify({
          audio_base64: (await ttsAudioBytesFor(`call-${requestSequence}`)).toString('base64'),
          alignment: {
            characters,
            character_start_times_seconds: characters.map((_, index) => index * step),
            character_end_times_seconds: characters.map((_, index) => (index + 1) * step),
          },
        }), { status: 200, headers: { 'content-type': 'application/json', 'request-id': `blockgen_req_${requestSequence}` } })
      },
    })
    const registry = {
      get: ({ adapterId, adapterVersion }) =>
        adapterId === 'elevenlabs-tts' && adapterVersion === '1.0.0' ? elevenLabsAdapter : null,
    }

    const storage = new LocalMediaUploadStorage(artifactRoot)
    const providerRepository = new PrismaProviderJobRepository(client)
    const resultArtifactRepository = new PrismaProviderResultArtifactRepository(client)
    const rightsRepository = new PrismaAssetRightsRepository(client)
    const projects = new PrismaProjectWorkspaceQueryRepository(client)
    const plans = new PrismaSyntheticScriptPlanRepository(client)
    const generations = new PrismaSyntheticBlockGenerationRepository(client)
    let providerTransition = 0
    let second = 0
    const tick = () => new Date(at((second += 1) + 4))
    const enqueue = enqueueProviderJobService({
      jobs: providerRepository, adapters: registry, profiles: syntheticRepository,
      audioMasters: new PrismaSyntheticAudioMasterRepository(client), projects, artifacts: artifactRepository,
      rights: rightsRepository, clock: () => new Date(at(2)),
      createJobId: () => `blockgen-job-${++entity}`,
      createTransitionId: () => `blockgen-transition-${++providerTransition}`,
    })
    const materializer = new AuthorizedProviderSubmissionInputMaterializer({
      profiles: syntheticRepository, artifacts: artifactRepository,
      sources: new LocalArtifactSourceMaterializer(artifactRoot), clock: () => new Date(at(2)),
    })
    const ttsIngestor = new VerifiedTtsResultIngestor({
      workRoot, storage, artifacts: artifactRepository, artifactQuery: artifactRepository,
      resultArtifacts: resultArtifactRepository,
      audioProber: { probeDurationSeconds: (path, options) => probeAudioDurationSeconds(path, options) },
      clock: () => new Date(at(3)),
    })
    const ttsCritic = new PersistedTtsResultCritic(artifactRepository, resultArtifactRepository)
    const drainWorkers = async () => {
      for (let quiet = 0; quiet < 2;) {
        const worked = await runProviderJobWorkerOnce({
          jobs: providerRepository, adapters: registry, materializer,
          ingestor: ttsIngestor, critic: ttsCritic,
          clock: tick,
          createLeaseToken: () => `blockgen-lease-${second}`,
          createTransitionId: () => `blockgen-transition-${++providerTransition}`,
        })(`blockgen-worker-${second}`)
        if (worked === null) quiet += 1
        else quiet = 0
      }
    }

    const planDependencies = {
      plans, projects, profiles: syntheticRepository, clock: () => new Date(at(1)),
      createId: (kind) => `${kind}-bg-${++entity}`,
    }
    const createPlan = createSyntheticScriptPlanService(planDependencies)
    const mutatePlan = mutateSyntheticScriptPlanService(planDependencies)
    const cacheDecisions = new PrismaSyntheticCacheDecisionRepository(client)
    const ensure = ensureSyntheticBlockGenerationsService({
      plans, generations, profiles: syntheticRepository, artifacts: artifactRepository,
      rights: rightsRepository, cacheDecisions, providerJobs: providerRepository,
      enqueueProviderJob: enqueue, clock: () => new Date(at(2)),
    })
    const settle = settleSyntheticBlockGenerationsService({
      generations, providerJobs: providerRepository, resultArtifacts: resultArtifactRepository,
      clock: () => new Date(at(9)),
    })
    const grantRightsForApprovedAudio = async () => {
      const approved = await generations.listByPlan({ workspaceId, planId, statuses: ['approved'] })
      for (const generation of approved) {
        const artifactId = generation.audioArtifactId
        const revision = await client.v2MediaArtifact.findUniqueOrThrow({ where: { id: artifactId }, select: { rightsRevision: true } })
        if (revision.rightsRevision > 0) continue
        const snapshot = createAssetRightsSnapshot({
          id: `blockgen-rights-${artifactId}`, workspaceId, artifactId, sequence: 1,
          draft: {
            status: 'approved', allowedUses: ['ads'], prohibitedUses: [], allowedMarkets: ['BRA'], allowedLocales: ['pt-BR'],
            allowedSyntheticOperations: ['tts', 'audio-avatar'], expiresAt: '2030-01-01T00:00:00.000Z',
            consent: { status: 'not-required', allowedUses: [] },
          },
          createdBy: { type: 'api-client', id: clientId }, createdAt: at(8),
        })
        await rightsRepository.setCurrent(snapshot, assetRightsRevision(artifactId, 0), createAssetRightsChangeIntent({
          workspaceId, artifactId, snapshotHash: snapshot.snapshotHash, baseRevision: assetRightsRevision(artifactId, 0),
          actor: { kind: 'internal', actorType: 'api-client', actorId: clientId }, changedAt: at(8),
        }))
      }
    }

    // 1. Initial plan: three blocks, three provider calls, nothing more.
    const created = await createPlan({
      workspaceId, projectId, projectVersionId,
      profileSnapshotId: profileV1.profile.profileSnapshotId, locale: 'pt-BR',
      scriptText: 'Primeira ideia do roteiro. Segunda ideia bem diferente. Terceira ideia para fechar.',
      actor, idempotencyKey: 'blockgen-plan-create',
    })
    const planId = created.plan.head.id
    let head = created.plan
    const ensureArguments = () => ({
      workspaceId, projectId, projectVersionId, planId, use: 'ads', market: 'BRA', actor,
    })
    const first = await ensure(ensureArguments())
    assert.deepEqual(first.map(({ action }) => action), ['enqueued', 'enqueued', 'enqueued'])
    assert.equal(providerCalls.length, 0, 'enqueue must not call the provider — only the worker does')
    await drainWorkers()
    const firstSettle = await settle({ workspaceId, projectId, planId, actor })
    assert.deepEqual(firstSettle.map(({ outcome }) => outcome), ['approved', 'approved', 'approved'])
    assert.equal(providerCalls.length, 3)

    // Idempotent ensure: nothing new is enqueued and nothing is charged.
    const second1 = await ensure(ensureArguments())
    assert.deepEqual(second1.map(({ action }) => action), ['up-to-date', 'up-to-date', 'up-to-date'])
    assert.equal(providerCalls.length, 3)

    // 2. Editing one block regenerates exactly that block.
    const editedTarget = head.version.blockSequence[1]
    head = (await mutatePlan({
      workspaceId, projectId, projectVersionId, planId, baseVersionId: head.version.id, baseHash: head.version.planVersionHash,
      mutation: { kind: 'update-block', blockId: editedTarget, text: 'Segunda ideia totalmente reescrita.' },
      actor, idempotencyKey: 'blockgen-update',
    })).plan
    const afterEdit = await ensure(ensureArguments())
    assert.deepEqual(afterEdit.map(({ action }) => action).toSorted(), ['enqueued', 'up-to-date', 'up-to-date'])
    await drainWorkers()
    await settle({ workspaceId, projectId, planId, actor })
    assert.equal(providerCalls.length, 4)

    // 3. Inserting a sentence identical to an approved one reuses its audio
    //    only after rights and consent hold — zero new provider calls.
    await grantRightsForApprovedAudio()
    head = (await mutatePlan({
      workspaceId, projectId, projectVersionId, planId, baseVersionId: head.version.id, baseHash: head.version.planVersionHash,
      mutation: { kind: 'insert-block', position: 3, text: 'Primeira ideia do roteiro.' },
      actor, idempotencyKey: 'blockgen-insert-dup',
    })).plan
    const afterInsert = await ensure(ensureArguments())
    const reusedOutcome = afterInsert.find(({ action }) => action === 'reused')
    assert.ok(reusedOutcome, 'duplicated sentence must reuse the approved cached generation')
    assert.equal(providerCalls.length, 4)
    const reusedGeneration = await generations.findEffective({ workspaceId, blockId: reusedOutcome.blockId })
    assert.equal(reusedGeneration.cacheDecision, 'hit-reuse')
    assert.ok(reusedGeneration.sourceGenerationId)
    const sourceGeneration = await generations.listByPlan({ workspaceId, planId, statuses: ['approved'] })
    assert.ok(sourceGeneration.some(({ id, audioArtifactId }) => id === reusedGeneration.sourceGenerationId && audioArtifactId === reusedGeneration.audioArtifactId))

    // 4. A profile version with a NEW voice regenerates every block; another
    //    profile version keeping the SAME voice regenerates none.
    const profileV2 = await registerProfile(profileInput(2, 'voice_block_b', 'blockgen-profile-v2'))
    head = (await mutatePlan({
      workspaceId, projectId, projectVersionId, planId, baseVersionId: head.version.id, baseHash: head.version.planVersionHash,
      mutation: { kind: 'set-profile', profileSnapshotId: profileV2.profile.profileSnapshotId },
      actor, idempotencyKey: 'blockgen-profile-b',
    })).plan
    // The duplicated sentence must NOT pay a second in-flight call: it defers
    // until its twin settles, then reuses it through the cache.
    const afterVoiceChange = await ensure(ensureArguments())
    assert.deepEqual(afterVoiceChange.map(({ action }) => action), ['enqueued', 'enqueued', 'enqueued', 'deferred-duplicate'])
    await drainWorkers()
    await settle({ workspaceId, projectId, planId, actor })
    assert.equal(providerCalls.length, 7)
    await grantRightsForApprovedAudio()
    const afterTwinSettled = await ensure(ensureArguments())
    assert.deepEqual(afterTwinSettled.map(({ action }) => action), ['up-to-date', 'up-to-date', 'up-to-date', 'reused'])
    assert.equal(providerCalls.length, 7)
    const profileV3 = await registerProfile(profileInput(3, 'voice_block_b', 'blockgen-profile-v3'))
    head = (await mutatePlan({
      workspaceId, projectId, projectVersionId, planId, baseVersionId: head.version.id, baseHash: head.version.planVersionHash,
      mutation: { kind: 'set-profile', profileSnapshotId: profileV3.profile.profileSnapshotId },
      actor, idempotencyKey: 'blockgen-profile-same-voice',
    })).plan
    const afterSameVoice = await ensure(ensureArguments())
    assert.deepEqual(afterSameVoice.map(({ action }) => action), ['up-to-date', 'up-to-date', 'up-to-date', 'up-to-date'])
    assert.equal(providerCalls.length, 7, 'a profile change that keeps the voice must not regenerate audio')

    // 5. Forced regeneration supersedes only the targeted block's attempt.
    const forcedTarget = head.version.blockSequence[0]
    const beforeForce = await generations.findEffective({ workspaceId, blockId: forcedTarget })
    head = (await mutatePlan({
      workspaceId, projectId, projectVersionId, planId, baseVersionId: head.version.id, baseHash: head.version.planVersionHash,
      mutation: { kind: 'regenerate-block', blockId: forcedTarget },
      actor, idempotencyKey: 'blockgen-force',
    })).plan
    const afterForce = await ensure({ ...ensureArguments(), forceBlockIds: [forcedTarget] })
    assert.equal(afterForce.find(({ blockId }) => blockId === forcedTarget)?.action, 'enqueued')
    assert.equal(afterForce.filter(({ action }) => action === 'enqueued').length, 1)
    await drainWorkers()
    await settle({ workspaceId, projectId, planId, actor })
    assert.equal(providerCalls.length, 8)

    // Every path the ensure pass took is written down: the reuse, the misses
    // that paid, the deliberate regeneration and the duplicate that waited.
    const ledger = await cacheDecisions.summarize({ workspaceId, projectId })
    assert.ok(ledger.byOutcome.hit >= 1, 'every reuse must be booked as a hit')
    assert.equal(ledger.byOutcome['forced-regenerate'], 1)
    assert.equal(ledger.byOutcome.blocked, 1)
    assert.ok(ledger.byOutcome.miss >= 1, 'the paid generations must be booked as misses')
    const decisions = await cacheDecisions.listByProject({ workspaceId, projectId, limit: 200 })
    assert.equal(
      decisions.length,
      ledger.byOutcome.hit + ledger.byOutcome.miss + ledger.byOutcome['forced-regenerate'] + ledger.byOutcome.blocked,
    )
    const hits = decisions.filter(({ outcome }) => outcome === 'hit')
    // The reuse is priced by the estimate the paying job persisted, not by a
    // number this pass invented, and only the reuse claims avoided money.
    for (const entry of hits) {
      assert.equal(entry.reasonCode, 'CACHE_HIT_ELIGIBLE')
      assert.ok(entry.avoidedCostMinorUnits > 0)
      assert.equal(entry.estimatedSavingMinorUnits, entry.avoidedCostMinorUnits)
      assert.equal(entry.currency, 'USD')
      assert.ok(entry.candidateGenerationId)
    }
    assert.equal(
      ledger.byCurrency.reduce((total, entry) => total + entry.avoidedCostMinorUnits, 0),
      hits.reduce((total, entry) => total + entry.avoidedCostMinorUnits, 0),
    )
    assert.deepEqual(
      decisions.filter(({ outcome }) => outcome !== 'hit').map(({ avoidedCostMinorUnits }) => avoidedCostMinorUnits),
      decisions.filter(({ outcome }) => outcome !== 'hit').map(() => 0),
    )
    assert.deepEqual(
      decisions.filter(({ outcome }) => outcome === 'blocked').map(({ reasonCode }) => reasonCode),
      ['IN_FLIGHT_TWIN'],
    )
    // The ledger never leaks the script it decided about.
    assert.doesNotMatch(JSON.stringify(decisions), /Primeira/)
    // Replaying an ensure pass that changes nothing books no new economy.
    const beforeReplay = await cacheDecisions.summarize({ workspaceId, projectId })
    await ensure(ensureArguments())
    assert.deepEqual(await cacheDecisions.summarize({ workspaceId, projectId }), beforeReplay)

    const supersededRow = await client.v2SyntheticBlockGeneration.findUniqueOrThrow({ where: { id: beforeForce.id } })
    assert.equal(supersededRow.status, 'superseded')
    assert.ok(supersededRow.supersededByGenerationId)
    // A late outcome for the superseded attempt is discarded, never applied.
    assert.equal(await generations.settle({
      workspaceId, generationId: beforeForce.id, status: 'failed', failureReason: 'late result', updatedAt: at(30),
    }), null)

    // 6. A failing block fails alone; an explicit retry touches only it.
    head = (await mutatePlan({
      workspaceId, projectId, projectVersionId, planId, baseVersionId: head.version.id, baseHash: head.version.planVersionHash,
      mutation: { kind: 'update-block', blockId: head.version.blockSequence[2], text: 'Bloco que FALHE de propósito.' },
      actor, idempotencyKey: 'blockgen-fail-edit',
    })).plan
    const failingBlockId = head.version.impact.createdBlockIds[0]
    const afterFailingEdit = await ensure(ensureArguments())
    assert.equal(afterFailingEdit.filter(({ action }) => action === 'enqueued').length, 1)
    await drainWorkers()
    const failSettle = await settle({ workspaceId, projectId, planId, actor })
    assert.deepEqual(failSettle.map(({ outcome }) => outcome), ['failed'])
    assert.equal(providerCalls.length, 9)
    const failed = await generations.findEffective({ workspaceId, blockId: failingBlockId })
    assert.equal(failed.status, 'failed')
    assert.ok(failed.failureReason)
    // Without an explicit retry the failed block stays put — zero new calls.
    const afterFailure = await ensure(ensureArguments())
    assert.equal(afterFailure.find(({ blockId }) => blockId === failingBlockId)?.action, 'failed-awaiting-retry')
    assert.equal(providerCalls.length, 9)
    // The explicit retry regenerates only the failed block.
    const retry = await ensure({ ...ensureArguments(), forceBlockIds: [failingBlockId] })
    assert.equal(retry.filter(({ action }) => action === 'enqueued').length, 1)
    await drainWorkers()
    await settle({ workspaceId, projectId, planId, actor })
    assert.equal(providerCalls.length, 10)
    assert.equal((await generations.findEffective({ workspaceId, blockId: failingBlockId })).status, 'failed')
    // The persisted attempt budget eventually exhausts for that block only.
    await ensure({ ...ensureArguments(), forceBlockIds: [failingBlockId] })
    await drainWorkers()
    await settle({ workspaceId, projectId, planId, actor })
    const exhausted = await ensure({ ...ensureArguments(), forceBlockIds: [failingBlockId] })
    assert.equal(exhausted.find(({ blockId }) => blockId === failingBlockId)?.action, 'budget-exhausted')
    assert.equal(providerCalls.length, 11)

    // 7. Revoked consent blocks generation BEFORE cache and cost.
    const generationsBefore = await client.v2SyntheticBlockGeneration.count({ where: { workspaceId } })
    const profileV4 = await registerProfile(profileInput(4, 'voice_block_b', 'blockgen-profile-v4', { revokedAt: '2029-01-01T00:00:00.000Z' }))
    head = (await mutatePlan({
      workspaceId, projectId, projectVersionId, planId, baseVersionId: head.version.id, baseHash: head.version.planVersionHash,
      mutation: { kind: 'set-profile', profileSnapshotId: profileV4.profile.profileSnapshotId },
      actor, idempotencyKey: 'blockgen-profile-revoked',
    })).plan
    await assert.rejects(
      ensure(ensureArguments()),
      (error) => error.code === 'ASSET_RIGHTS_BLOCKED',
    )
    assert.equal(providerCalls.length, 11, 'revoked consent must cause zero provider calls')
    assert.equal(await client.v2SyntheticBlockGeneration.count({ where: { workspaceId } }), generationsBefore, 'revoked consent must cause zero cache hits or new generations')
  } finally {
    await cleanup()
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})
