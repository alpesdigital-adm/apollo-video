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

const workspaceId = 'cache-invalidation-int-workspace'
const clientId = 'cache-invalidation-int-client'
const credentialId = 'cache-invalidation-int-credential'
const hash = (character) => character.repeat(64)
const at = (second) => new Date(Date.parse('2029-05-01T00:00:00.000Z') + second * 1_000).toISOString()

test('T-FR-105 eligible reuse and precise invalidation on PostgreSQL', {
  skip: !process.env.V2_DATABASE_URL && 'V2_DATABASE_URL is required',
  timeout: 600_000,
}, async () => {
  const client = new PrismaClient({ datasources: { db: { url: process.env.V2_DATABASE_URL } } })
  const root = await mkdtemp(join(tmpdir(), 'apollo-cache-invalidation-'))
  const artifactRoot = join(root, 'artifacts')
  const workRoot = join(root, 'work')
  await mkdir(artifactRoot, { recursive: true })
  await mkdir(workRoot, { recursive: true })

  const cleanup = async () => {
    await client.v2SyntheticScriptPlan.updateMany({ where: { workspaceId }, data: { currentVersionId: null } })
    await client.v2SyntheticCacheSubmissionClaim.deleteMany({ where: { workspaceId } })
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
    const { PrismaSyntheticCacheSubmissionClaimRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-cache-submission-claim-repository.ts')
    const { PrismaSyntheticCriticReportRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-critic-report-repository.ts')
    const { LocalArtifactSourceMaterializer, LocalMediaUploadStorage } = await import('../../src/v2/infrastructure/media/local-media-upload-storage.ts')
    const { probeAudioDurationSeconds } = await import('../../src/v2/infrastructure/media/video-probe.ts')
    const { ElevenLabsTtsProviderAdapter } = await import('../../src/v2/infrastructure/elevenlabs-tts-provider.ts')
    const { AuthorizedProviderSubmissionInputMaterializer } = await import('../../src/v2/infrastructure/provider-submission-input-materializer.ts')
    const { PersistedTtsResultCritic, VerifiedTtsResultIngestor } = await import('../../src/v2/infrastructure/provider-result-ingestion.ts')

    const audioByText = new Map()
    const ttsAudioBytesFor = async (text) => {
      if (!audioByText.has(text)) {
        const index = audioByText.size
        const path = join(root, `tts-speech-${index}.mp3`)
        execFileSync(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${210 + index * 29}:sample_rate=44100:duration=2`, '-c:a', 'libmp3lame', '-b:a', '128k', path], { windowsHide: true })
        audioByText.set(text, await readFile(path))
      }
      return audioByText.get(text)
    }

    await new PrismaWorkspaceRepository(client).create(createWorkspace({
      id: workspaceId, slug: workspaceId, name: 'Cache invalidation integration', status: 'active', createdAt: at(0),
    }))
    const issued = await createApiClientService({
      repository: new PrismaApiClientRepository(client), credentialCrypto: nodeApiCredentialCrypto, clock: () => new Date(at(0)),
    })({ id: clientId, credentialId, workspaceId, name: 'Cache invalidation client', environment: 'production', scopes: ['projects:read', 'projects:write'] })
    const auditContext = createExternalAuditContext({ clientId, credentialId: issued.credential.id, workspaceId, environment: 'production' })
    const actor = Object.freeze({
      ...auditContext, scopes: new Set(['projects:read', 'projects:write']), authenticationKind: 'bearer',
      clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
      clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext,
    })
    let entity = 0
    let event = 0
    const createProject = createProjectService({
      repository: new PrismaProjectCreationRepository(client), clock: () => new Date(at(0)),
      createId: (kind) => `${kind}-cacheinv-${++entity}`,
      createEventId: () => `00000000-0000-4000-8000-${String(700_000 + ++event).padStart(12, '0')}`,
    })
    const main = await createProject({
      workspaceId, name: 'Invalidação precisa', objective: 'awareness', format: '9:16', actor,
      idempotency: { clientId, key: 'cacheinv-project-main' },
    })
    // A second project in the same workspace: the cache address is workspace
    // wide, so this is where two independent requests can collide on one key.
    const twin = await createProject({
      workspaceId, name: 'Projeto gêmeo', objective: 'awareness', format: '9:16', actor,
      idempotency: { clientId, key: 'cacheinv-project-twin' },
    })

    await client.v2MediaArtifact.create({
      data: {
        id: 'cacheinv-consent-evidence', workspaceId, artifactKey: 'cacheinv/consent.json',
        sha256: hash('b'), byteSize: 512n, mediaType: 'data', container: 'json', status: 'available', createdAt: new Date(at(0)),
      },
    })
    const syntheticRepository = new PrismaSyntheticProductionRepository(client)
    const artifactRepository = new PrismaMediaArtifactRepository(client)
    const registerProfile = registerSyntheticPresenterProfileService({
      repository: syntheticRepository, artifacts: artifactRepository, clock: () => new Date(at(0)),
    })
    const profileInput = (version, key, extra = {}) => ({
      workspaceId, profileId: 'cacheinv-presenter', version, actorIdentityId: 'cacheinv-identity',
      avatar: { adapterId: 'heygen-v3', adapterVersion: '3.0.0', identityRef: 'avatar_cacheinv' },
      voice: { id: 'voice_cacheinv', version: 1, adapterId: 'elevenlabs-tts', adapterVersion: '1.0.0' },
      defaultLocale: 'pt-BR', status: 'active', disclosure: 'Conteúdo gerado com IA',
      consent: {
        id: `cacheinv-consent-v${version}`, evidenceArtifactId: 'cacheinv-consent-evidence', granted: true,
        allowedUses: ['ads'], allowedMarkets: ['BRA'], allowedLocales: ['pt-BR'],
        allowedOperations: ['tts', 'audio-avatar'], expiresAt: '2030-01-01T00:00:00.000Z',
        ...extra,
      },
      actor, idempotencyKey: key,
    })
    const profileV1 = await registerProfile(profileInput(1, 'cacheinv-profile-v1'))

    // Controlled provider boundary: every paid call is counted here, so the
    // assertions below measure real HTTP traffic, not intentions.
    const providerCalls = []
    let requestSequence = 0
    const elevenLabsAdapter = new ElevenLabsTtsProviderAdapter({
      apiKey: 'cacheinv-elevenlabs-secret', costMinorUnitsPerThousandCharacters: 30,
      clock: () => new Date(at(3)),
      fetch: async (url, init) => {
        const body = JSON.parse(String(init.body))
        providerCalls.push(body.text)
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
        }), { status: 200, headers: { 'content-type': 'application/json', 'request-id': `cacheinv_req_${requestSequence}` } })
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
    const cacheDecisions = new PrismaSyntheticCacheDecisionRepository(client)
    let providerTransition = 0
    let second = 0
    const tick = () => new Date(at((second += 1) + 4))
    const enqueue = enqueueProviderJobService({
      jobs: providerRepository, adapters: registry, profiles: syntheticRepository,
      audioMasters: new PrismaSyntheticAudioMasterRepository(client), projects, artifacts: artifactRepository,
      rights: rightsRepository, clock: () => new Date(at(2)),
      createJobId: () => `cacheinv-job-${++entity}`,
      createTransitionId: () => `cacheinv-transition-${++providerTransition}`,
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
          createLeaseToken: () => `cacheinv-lease-${second}`,
          createTransitionId: () => `cacheinv-transition-${++providerTransition}`,
        })(`cacheinv-worker-${second}`)
        if (worked === null) quiet += 1
        else quiet = 0
      }
    }

    // Each ensure pass decides at its own instant, exactly as production does;
    // freezing it is reserved for the replay proof at the end.
    let ensureSecond = 40
    let ensureFrozen = false
    const ensureClock = () => new Date(at(ensureFrozen ? ensureSecond : (ensureSecond += 1)))
    const planDependencies = {
      plans, projects, profiles: syntheticRepository, clock: () => new Date(at(1)),
      createId: (kind) => `${kind}-ci-${++entity}`,
    }
    const createPlan = createSyntheticScriptPlanService(planDependencies)
    const mutatePlan = mutateSyntheticScriptPlanService(planDependencies)
    const ensure = ensureSyntheticBlockGenerationsService({
      plans, generations, profiles: syntheticRepository, artifacts: artifactRepository,
      rights: rightsRepository, cacheDecisions, providerJobs: providerRepository,
      resultArtifacts: resultArtifactRepository,
      criticReports: new PrismaSyntheticCriticReportRepository(client),
      submissionClaims: new PrismaSyntheticCacheSubmissionClaimRepository(client),
      enqueueProviderJob: enqueue, clock: ensureClock,
    })
    const settle = settleSyntheticBlockGenerationsService({
      generations, providerJobs: providerRepository, resultArtifacts: resultArtifactRepository,
      clock: () => new Date(at(9)),
    })

    const grantRights = async (planId, markets = ['BRA']) => {
      const approved = await generations.listByPlan({ workspaceId, planId, statuses: ['approved'] })
      for (const generation of approved) {
        const artifactId = generation.audioArtifactId
        const row = await client.v2MediaArtifact.findUniqueOrThrow({ where: { id: artifactId }, select: { rightsRevision: true } })
        if (row.rightsRevision > 0) continue
        const snapshot = createAssetRightsSnapshot({
          id: `cacheinv-rights-${artifactId}`, workspaceId, artifactId, sequence: 1,
          draft: {
            status: 'approved', allowedUses: ['ads'], prohibitedUses: [], allowedMarkets: markets, allowedLocales: ['pt-BR'],
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

    const ledgerCount = async () => client.v2SyntheticCacheDecision.count({ where: { workspaceId } })
    const jobCount = async () => client.v2ProviderJob.count({ where: { workspaceId } })
    // Ledger entries are compared by identity, not by ordering: every decision
    // in one pass shares an instant, so "the newest rows" is not a thing the
    // database can answer. What is exactly answerable is which ids are new.
    let knownDecisionIds = new Set()
    const markLedger = async () => {
      knownDecisionIds = new Set(
        (await client.v2SyntheticCacheDecision.findMany({ where: { workspaceId }, select: { id: true } })).map(({ id }) => id),
      )
      return knownDecisionIds.size
    }
    const decisionsSince = async () =>
      (await client.v2SyntheticCacheDecision.findMany({ where: { workspaceId } }))
        .filter(({ id }) => !knownDecisionIds.has(id))

    const created = await createPlan({
      workspaceId, projectId: main.project.id, projectVersionId: main.version.id,
      profileSnapshotId: profileV1.profile.profileSnapshotId, locale: 'pt-BR',
      scriptText: 'Alfa primeira frase. Beta segunda frase. Gama terceira frase. Delta quarta frase.',
      actor, idempotencyKey: 'cacheinv-plan-create',
    })
    const planId = created.plan.head.id
    let head = created.plan
    const mainArguments = () => ({
      workspaceId, projectId: main.project.id, projectVersionId: main.version.id,
      planId, use: 'ads', market: 'BRA', actor,
    })
    const mutate = async (mutation, idempotencyKey) => {
      head = (await mutatePlan({
        workspaceId, projectId: main.project.id, projectVersionId: main.version.id, planId,
        baseVersionId: head.version.id, baseHash: head.version.planVersionHash,
        mutation, actor, idempotencyKey,
      })).plan
      return head
    }

    // 0. Four blocks, four paid calls, four approved generations.
    const first = await ensure(mainArguments())
    assert.deepEqual(first.map(({ action }) => action), ['enqueued', 'enqueued', 'enqueued', 'enqueued'])
    // Enqueueing reserves cost and submits a durable job; it never waits on the
    // provider, so no HTTP traffic exists before a worker leases the job.
    assert.equal(providerCalls.length, 0, 'ensure must not call the provider inside its own work')
    await drainWorkers()
    assert.deepEqual((await settle({ workspaceId, projectId: main.project.id, planId, actor })).map(({ outcome }) => outcome), ['approved', 'approved', 'approved', 'approved'])
    assert.equal(providerCalls.length, 4)
    await grantRights(planId)
    const blocks = head.version.blockSequence
    const approvedByBlock = new Map()
    for (const blockId of blocks) approvedByBlock.set(blockId, await generations.findEffective({ workspaceId, blockId }))

    // ------------------------------------------------------------------
    // Case 3 — a purely editorial or positional change keeps every hit.
    // ------------------------------------------------------------------
    let marker = await markLedger()
    let jobsBefore = await jobCount()
    await mutate({ kind: 'reorder-blocks', order: [blocks[1], blocks[0], blocks[3], blocks[2]] }, 'cacheinv-reorder')
    const afterReorder = await ensure(mainArguments())
    assert.deepEqual(afterReorder.map(({ action }) => action), ['up-to-date', 'up-to-date', 'up-to-date', 'up-to-date'])
    assert.equal(providerCalls.length, 4, 'reordering blocks must not pay for a single call')
    assert.equal(await jobCount(), jobsBefore, 'reordering blocks must not create a provider job')
    assert.equal(await ledgerCount(), marker, 'reordering blocks is not a cache decision at all')

    // ------------------------------------------------------------------
    // Case 1 — a change that alters the bytes yields a new cache address,
    // so the miss is legitimate and the previous master is left alone.
    // ------------------------------------------------------------------
    marker = await markLedger()
    jobsBefore = await jobCount()
    const rewrittenOrigin = blocks[1]
    const beforeRewrite = approvedByBlock.get(rewrittenOrigin)
    await mutate({ kind: 'update-block', blockId: rewrittenOrigin, text: 'Beta segunda frase completamente reescrita.' }, 'cacheinv-rewrite')
    const afterRewrite = await ensure(mainArguments())
    assert.equal(afterRewrite.filter(({ action }) => action === 'enqueued').length, 1)
    assert.equal(afterRewrite.filter(({ action }) => action === 'up-to-date').length, 3)
    let added = await decisionsSince()
    assert.deepEqual(added.map(({ outcome }) => outcome), ['miss'])
    assert.deepEqual(added.map(({ reasonCode }) => reasonCode), ['CACHE_MISS_NO_CANDIDATE'])
    assert.notEqual(added[0].cacheKey, beforeRewrite.cacheKey, 'changed bytes must land on a different cache address')
    await drainWorkers()
    await settle({ workspaceId, projectId: main.project.id, planId, actor })
    assert.equal(providerCalls.length, 5)
    assert.equal(await jobCount(), jobsBefore + 1)
    // Nothing was destroyed to invalidate: the previous attempt keeps its
    // approved status and its master stays exactly where it was. The old cache
    // address simply stopped being asked for.
    assert.equal(
      (await client.v2SyntheticBlockGeneration.findUniqueOrThrow({ where: { id: beforeRewrite.id } })).status,
      'approved',
    )
    assert.equal(
      (await client.v2MediaArtifact.findUniqueOrThrow({ where: { id: beforeRewrite.audioArtifactId } })).status,
      'available',
      'invalidating a cache entry must never delete the master it addressed',
    )

    // ------------------------------------------------------------------
    // Baseline — an identical sentence reuses the approved generation.
    // ------------------------------------------------------------------
    marker = await markLedger()
    jobsBefore = await jobCount()
    await mutate({ kind: 'insert-block', position: 4, text: 'Alfa primeira frase.' }, 'cacheinv-dup-alfa')
    const afterDuplicate = await ensure(mainArguments())
    assert.equal(afterDuplicate.filter(({ action }) => action === 'reused').length, 1)
    assert.equal(providerCalls.length, 5, 'a genuine hit pays nothing')
    assert.equal(await jobCount(), jobsBefore, 'a genuine hit creates no provider job')
    added = await decisionsSince()
    assert.deepEqual(added.map(({ outcome }) => outcome), ['hit'])
    assert.deepEqual(added.map(({ reasonCode }) => reasonCode), ['CACHE_HIT_ELIGIBLE'])
    assert.ok(added[0].avoidedCostMinorUnits > 0, 'a hit is priced by the estimate the paying job persisted')

    // ------------------------------------------------------------------
    // Case 4 — corruption: the blob is still "available" but no longer
    // holds the bytes the paying job registered. The candidate becomes
    // ineligible and the artifact is preserved, not erased.
    // ------------------------------------------------------------------
    marker = await markLedger()
    jobsBefore = await jobCount()
    const driftedGeneration = approvedByBlock.get(blocks[2])
    const driftedArtifactId = driftedGeneration.audioArtifactId
    const driftedBefore = await client.v2MediaArtifact.findUniqueOrThrow({ where: { id: driftedArtifactId } })
    await client.v2MediaArtifact.update({ where: { id: driftedArtifactId }, data: { sha256: hash('c') } })
    await mutate({ kind: 'insert-block', position: 5, text: 'Gama terceira frase.' }, 'cacheinv-dup-gama')
    const afterDrift = await ensure(mainArguments())
    assert.equal(afterDrift.filter(({ action }) => action === 'enqueued').length, 1)
    assert.equal(afterDrift.filter(({ action }) => action === 'reused').length, 0, 'a drifted blob must never be reused')
    added = await decisionsSince()
    assert.deepEqual(added.map(({ outcome }) => outcome), ['miss'])
    assert.deepEqual(added.map(({ reasonCode }) => reasonCode), ['CANDIDATE_CHECKSUM_DRIFT'])
    assert.equal(added[0].candidateGenerationId, driftedGeneration.id, 'the ledger names the candidate it refused')
    // The artifact row and the provider result ledger that proved the drift are
    // both still there: eligibility changed, history did not.
    assert.equal((await client.v2MediaArtifact.findUniqueOrThrow({ where: { id: driftedArtifactId } })).status, 'available')
    assert.equal(
      (await resultArtifactRepository.listByJob({ workspaceId, projectId: main.project.id, jobId: driftedGeneration.providerJobId }))
        .find(({ role }) => role === 'primary-audio').artifactSha256,
      driftedBefore.sha256,
      'the registered checksum is the evidence and is never rewritten',
    )
    assert.equal((await client.v2SyntheticBlockGeneration.findUniqueOrThrow({ where: { id: driftedGeneration.id } })).status, 'approved')
    await drainWorkers()
    await settle({ workspaceId, projectId: main.project.id, planId, actor })
    assert.equal(providerCalls.length, 6)
    assert.equal(await jobCount(), jobsBefore + 1)
    await client.v2MediaArtifact.update({ where: { id: driftedArtifactId }, data: { sha256: driftedBefore.sha256 } })

    // ------------------------------------------------------------------
    // Case 4b — the bytes are intact but no longer satisfy the output the
    // caller is asking for now: a miss, never a silent wrong-format hit.
    // ------------------------------------------------------------------
    marker = await markLedger()
    jobsBefore = await jobCount()
    const mismatchedGeneration = approvedByBlock.get(blocks[3])
    const mismatchedArtifactId = mismatchedGeneration.audioArtifactId
    // The stored row is made to disagree with its own cache address: it still
    // answers to the mp3 key while claiming to hold wav. Reusing it would hand
    // the caller a container nobody asked for.
    await client.v2SyntheticBlockGeneration.update({ where: { id: mismatchedGeneration.id }, data: { outputFormat: 'wav' } })
    await mutate({ kind: 'insert-block', position: 6, text: 'Delta quarta frase.' }, 'cacheinv-dup-delta')
    const afterMismatch = await ensure(mainArguments())
    assert.equal(afterMismatch.filter(({ action }) => action === 'enqueued').length, 1)
    added = await decisionsSince()
    assert.deepEqual(added.map(({ outcome }) => outcome), ['miss'])
    assert.deepEqual(added.map(({ reasonCode }) => reasonCode), ['CANDIDATE_OUTPUT_MISMATCH'])
    assert.equal((await client.v2MediaArtifact.findUniqueOrThrow({ where: { id: mismatchedArtifactId } })).status, 'available')
    await drainWorkers()
    await settle({ workspaceId, projectId: main.project.id, planId, actor })
    assert.equal(providerCalls.length, 7)
    assert.equal(await jobCount(), jobsBefore + 1)
    await client.v2SyntheticBlockGeneration.update({ where: { id: mismatchedGeneration.id }, data: { outputFormat: 'mp3' } })

    // ------------------------------------------------------------------
    // Case 2 — an eligibility change (the rights no longer cover this
    // market) blocks reuse without touching the artifact at all.
    // ------------------------------------------------------------------
    marker = await markLedger()
    jobsBefore = await jobCount()
    const rightsTarget = approvedByBlock.get(blocks[0])
    const rightsArtifactId = rightsTarget.audioArtifactId
    const narrowed = createAssetRightsSnapshot({
      id: `cacheinv-rights-narrowed-${rightsArtifactId}`, workspaceId, artifactId: rightsArtifactId, sequence: 2,
      draft: {
        status: 'approved', allowedUses: ['ads'], prohibitedUses: [], allowedMarkets: ['USA'], allowedLocales: ['pt-BR'],
        allowedSyntheticOperations: ['tts', 'audio-avatar'], expiresAt: '2030-01-01T00:00:00.000Z',
        consent: { status: 'not-required', allowedUses: [] },
      },
      createdBy: { type: 'api-client', id: clientId }, createdAt: at(10),
    })
    await rightsRepository.setCurrent(narrowed, assetRightsRevision(rightsArtifactId, 1), createAssetRightsChangeIntent({
      workspaceId, artifactId: rightsArtifactId, snapshotHash: narrowed.snapshotHash,
      baseRevision: assetRightsRevision(rightsArtifactId, 1),
      actor: { kind: 'internal', actorType: 'api-client', actorId: clientId }, changedAt: at(10),
    }))
    await mutate({ kind: 'insert-block', position: 7, text: 'Alfa primeira frase.' }, 'cacheinv-dup-alfa-blocked')
    const afterRightsChange = await ensure(mainArguments())
    assert.equal(afterRightsChange.filter(({ action }) => action === 'enqueued').length, 1)
    assert.equal(afterRightsChange.filter(({ action }) => action === 'reused').length, 0)
    added = await decisionsSince()
    assert.deepEqual(added.map(({ outcome }) => outcome), ['miss'])
    assert.deepEqual(added.map(({ reasonCode }) => reasonCode), ['CANDIDATE_RIGHTS_BLOCKED'])
    assert.equal(
      (await client.v2MediaArtifact.findUniqueOrThrow({ where: { id: rightsArtifactId } })).status,
      'available',
      'blocking reuse must never delete the artifact whose rights changed',
    )
    await drainWorkers()
    await settle({ workspaceId, projectId: main.project.id, planId, actor })
    assert.equal(providerCalls.length, 8)
    assert.equal(await jobCount(), jobsBefore + 1)

    // ------------------------------------------------------------------
    // Case 5 — a forced regeneration is an audited, motivated order, and
    // an unmotivated one fails closed: nothing paid, nothing written.
    // ------------------------------------------------------------------
    // A block of its own, generated once, so the force below is measured
    // against a known attempt count instead of an accumulated one.
    await mutate({ kind: 'insert-block', position: 8, text: 'Ômega frase para forçar.' }, 'cacheinv-force-target')
    const forcedTarget = head.version.impact.createdBlockIds[0]
    assert.equal((await ensure(mainArguments())).filter(({ action }) => action === 'enqueued').length, 1)
    await drainWorkers()
    await settle({ workspaceId, projectId: main.project.id, planId, actor })
    assert.equal(providerCalls.length, 9)

    marker = await markLedger()
    jobsBefore = await jobCount()
    for (const malformed of [
      { blockIds: [forcedTarget], reason: 'oops' },
      { blockIds: [forcedTarget], reason: '   ' },
      { blockIds: [], reason: 'a perfectly good motive with no target at all' },
      { blockIds: ['script-block-that-does-not-exist'], reason: 'a perfectly good motive on a stranger block' },
    ]) {
      await assert.rejects(
        ensure({ ...mainArguments(), mustRegenerate: malformed }),
        (error) => error.code === 'INVALID_ARGUMENT',
      )
    }
    assert.equal(providerCalls.length, 9, 'an unauthorized force must pay nothing')
    assert.equal(await jobCount(), jobsBefore, 'an unauthorized force must create no provider job')
    assert.equal(await ledgerCount(), marker, 'an unauthorized force must write no ledger entry')

    const motive = 'operator heard a mispronunciation in the approved take and ordered a fresh one'
    const forced = await ensure({ ...mainArguments(), mustRegenerate: { blockIds: [forcedTarget], reason: motive } })
    assert.equal(forced.find(({ blockId }) => blockId === forcedTarget)?.action, 'enqueued')
    assert.equal(forced.filter(({ action }) => action === 'enqueued').length, 1, 'a force touches only the blocks it names')
    added = await decisionsSince()
    assert.deepEqual(added.map(({ outcome }) => outcome), ['forced-regenerate'])
    assert.deepEqual(added.map(({ reasonCode }) => reasonCode), ['MUST_REGENERATE'])
    assert.match(added[0].reason, new RegExp(motive.slice(0, 40)), 'the ledger records the operator motive verbatim')
    assert.match(added[0].reason, new RegExp(clientId), 'the ledger records who authorized the spend')
    assert.equal(added[0].avoidedCostMinorUnits, 0, 'a forced regeneration avoids nothing')
    await drainWorkers()
    await settle({ workspaceId, projectId: main.project.id, planId, actor })
    assert.equal(providerCalls.length, 10)
    assert.equal(await jobCount(), jobsBefore + 1)

    // ------------------------------------------------------------------
    // Concurrency — two independent requests, one cache address. Exactly
    // one submission happens; the other waits instead of paying twice.
    // ------------------------------------------------------------------
    const twinPlan = await createPlan({
      workspaceId, projectId: twin.project.id, projectVersionId: twin.version.id,
      profileSnapshotId: profileV1.profile.profileSnapshotId, locale: 'pt-BR',
      scriptText: 'Zeta frase disputada.',
      actor, idempotencyKey: 'cacheinv-twin-plan',
    })
    await mutate({ kind: 'insert-block', position: 9, text: 'Zeta frase disputada.' }, 'cacheinv-contended')
    const contendedBlock = head.version.impact.createdBlockIds[0]

    marker = await markLedger()
    jobsBefore = await jobCount()
    const callsBefore = providerCalls.length
    const [mainPass, twinPass] = await Promise.all([
      ensure(mainArguments()),
      ensure({
        workspaceId, projectId: twin.project.id, projectVersionId: twin.version.id,
        planId: twinPlan.plan.head.id, use: 'ads', market: 'BRA', actor,
      }),
    ])
    const contendedOutcomes = [
      mainPass.find(({ blockId }) => blockId === contendedBlock),
      twinPass.find(({ blockId }) => blockId === twinPlan.plan.version.blockSequence[0]),
    ]
    assert.deepEqual(
      contendedOutcomes.map(({ action }) => action).toSorted(),
      ['deferred-duplicate', 'enqueued'],
      'concurrent requests for one cache address submit exactly once',
    )
    assert.equal(await jobCount(), jobsBefore + 1, 'exactly one provider job is created for the contended address')
    added = await decisionsSince()
    assert.deepEqual(
      added.map(({ outcome }) => outcome).toSorted(),
      ['blocked', 'miss'],
      'the deferral is booked as a block, the submission as a miss',
    )
    assert.ok(added.some(({ reasonCode }) => reasonCode === 'IN_FLIGHT_TWIN'))
    assert.equal(providerCalls.length, callsBefore, 'neither concurrent pass waited on the provider')
    await drainWorkers()
    assert.equal(providerCalls.length, callsBefore + 1, 'the contended address is paid for exactly once')

    // The loser reuses the winner's work once it settles, still for free.
    await settle({ workspaceId, projectId: main.project.id, planId, actor })
    await settle({ workspaceId, projectId: twin.project.id, planId: twinPlan.plan.head.id, actor })
    await grantRights(twinPlan.plan.head.id)
    await grantRights(planId)
    const afterTwinSettled = await ensure(mainArguments())
    assert.equal(afterTwinSettled.find(({ blockId }) => blockId === contendedBlock)?.action, 'reused')
    assert.equal(providerCalls.length, callsBefore + 1, 'the deferred duplicate reuses instead of paying')

    // The ledger never carries the script it decided about.
    const everyDecision = await cacheDecisions.listByProject({ workspaceId, projectId: main.project.id, limit: 500 })
    assert.doesNotMatch(JSON.stringify(everyDecision), /Alfa|Beta|Gama|Delta|Zeta/)
    // Replaying a pass that changes nothing books no new economy.
    const beforeReplay = await cacheDecisions.summarize({ workspaceId, projectId: main.project.id })
    await ensure(mainArguments())
    assert.deepEqual(await cacheDecisions.summarize({ workspaceId, projectId: main.project.id }), beforeReplay)
  } finally {
    await cleanup()
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})
