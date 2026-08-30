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
const ffprobePath = require('ffprobe-static').path

const workspaceId = 'block-compile-int-workspace'
const clientId = 'block-compile-int-client'
const credentialId = 'block-compile-int-credential'
const hash = (character) => character.repeat(64)
const at = (second) => new Date(Date.parse('2029-04-01T00:00:00.000Z') + second * 1_000).toISOString()

test('T-FR-102 approved block audio concatenates into a consolidated audio master on PostgreSQL', {
  skip: !process.env.V2_DATABASE_URL && 'V2_DATABASE_URL is required',
  timeout: 480_000,
}, async () => {
  const client = new PrismaClient({ datasources: { db: { url: process.env.V2_DATABASE_URL } } })
  const root = await mkdtemp(join(tmpdir(), 'apollo-block-compile-'))
  const artifactRoot = join(root, 'artifacts')
  const workRoot = join(root, 'work')
  const compileWorkRoot = join(root, 'compile-work')
  await mkdir(artifactRoot, { recursive: true })
  await mkdir(workRoot, { recursive: true })
  await mkdir(compileWorkRoot, { recursive: true })

  const cleanup = async () => {
    await client.v2SyntheticScriptPlan.updateMany({ where: { workspaceId }, data: { currentVersionId: null } })
    await client.v2SyntheticBlockConcatenation.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticBlockGeneration.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticScriptBlock.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticScriptPlanVersion.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticScriptPlan.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticAudioMaster.deleteMany({ where: { workspaceId } })
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
    const { createSyntheticScriptPlanService, mutateSyntheticScriptPlanService } = await import('../../src/v2/application/synthetic-script-plans.ts')
    const { ensureSyntheticBlockGenerationsService, settleSyntheticBlockGenerationsService } = await import('../../src/v2/application/synthetic-block-generations.ts')
    const { compileSyntheticBlockAudioService } = await import('../../src/v2/application/synthetic-block-audio-compilation.ts')
    const { createSyntheticAudioMasterService } = await import('../../src/v2/application/synthetic-audio-masters.ts')
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
    const { PrismaSyntheticBlockConcatenationRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-block-concatenation-repository.ts')
    const { LocalArtifactSourceMaterializer, LocalMediaUploadStorage } = await import('../../src/v2/infrastructure/media/local-media-upload-storage.ts')
    const { probeAudioDurationSeconds } = await import('../../src/v2/infrastructure/media/video-probe.ts')
    const { concatenateBlockAudio } = await import('../../src/v2/infrastructure/media/audio-concatenation.ts')
    const { ElevenLabsTtsProviderAdapter } = await import('../../src/v2/infrastructure/elevenlabs-tts-provider.ts')
    const { AuthorizedProviderSubmissionInputMaterializer } = await import('../../src/v2/infrastructure/provider-submission-input-materializer.ts')
    const { PersistedTtsResultCritic, VerifiedTtsResultIngestor } = await import('../../src/v2/infrastructure/provider-result-ingestion.ts')

    const audioByKey = new Map()
    const ttsAudioBytesFor = async (key) => {
      if (!audioByKey.has(key)) {
        const index = audioByKey.size
        const path = join(root, `tts-${index}.mp3`)
        execFileSync(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${250 + index * 41}:sample_rate=44100:duration=2`, '-c:a', 'libmp3lame', '-b:a', '128k', path], { windowsHide: true })
        audioByKey.set(key, await readFile(path))
      }
      return audioByKey.get(key)
    }

    await new PrismaWorkspaceRepository(client).create(createWorkspace({
      id: workspaceId, slug: workspaceId, name: 'Block compile integration', status: 'active', createdAt: at(0),
    }))
    const issued = await createApiClientService({
      repository: new PrismaApiClientRepository(client), credentialCrypto: nodeApiCredentialCrypto, clock: () => new Date(at(0)),
    })({ id: clientId, credentialId, workspaceId, name: 'Block compile client', environment: 'production', scopes: ['projects:read', 'projects:write'] })
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
      createId: (kind) => `${kind}-compile-${++entity}`,
      createEventId: () => `00000000-0000-4000-8000-${String(500_000 + ++event).padStart(12, '0')}`,
    })({ workspaceId, name: 'Compilação de blocos', objective: 'awareness', format: '9:16', actor, idempotency: { clientId, key: 'compile-project' } })
    const projectId = project.project.id
    const projectVersionId = project.version.id

    await client.v2MediaArtifact.create({
      data: {
        id: 'compile-consent-evidence', workspaceId, artifactKey: 'compile/consent.json',
        sha256: hash('a'), byteSize: 512n, mediaType: 'data', container: 'json', status: 'available', createdAt: new Date(at(0)),
      },
    })
    const syntheticRepository = new PrismaSyntheticProductionRepository(client)
    const artifactRepository = new PrismaMediaArtifactRepository(client)
    const registerProfile = registerSyntheticPresenterProfileService({
      repository: syntheticRepository, artifacts: artifactRepository, clock: () => new Date(at(0)),
    })
    const profile = await registerProfile({
      workspaceId, profileId: 'compile-presenter', version: 1, actorIdentityId: 'compile-identity',
      avatar: { adapterId: 'heygen-v3', adapterVersion: '3.0.0', identityRef: 'avatar_compile' },
      voice: { id: 'voice_compile', version: 1, adapterId: 'elevenlabs-tts', adapterVersion: '1.0.0' },
      defaultLocale: 'pt-BR', status: 'active', disclosure: 'Conteúdo gerado com IA',
      consent: {
        id: 'compile-consent', evidenceArtifactId: 'compile-consent-evidence', granted: true,
        allowedUses: ['ads'], allowedMarkets: ['BRA'], allowedLocales: ['pt-BR'],
        allowedOperations: ['tts', 'audio-avatar'], expiresAt: '2030-01-01T00:00:00.000Z',
      },
      actor, idempotencyKey: 'compile-profile',
    })

    let requestSequence = 0
    const elevenLabsAdapter = new ElevenLabsTtsProviderAdapter({
      apiKey: 'compile-elevenlabs-secret', costMinorUnitsPerThousandCharacters: 30,
      clock: () => new Date(at(3)),
      fetch: async (url, init) => {
        const body = JSON.parse(String(init.body))
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
        }), { status: 200, headers: { 'content-type': 'application/json', 'request-id': `compile_req_${requestSequence}` } })
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
    const concatenations = new PrismaSyntheticBlockConcatenationRepository(client)
    const audioMasterRepository = new PrismaSyntheticAudioMasterRepository(client)
    let providerTransition = 0
    let second = 0
    const tick = () => new Date(at((second += 1) + 4))
    const enqueue = enqueueProviderJobService({
      jobs: providerRepository, adapters: registry, profiles: syntheticRepository,
      audioMasters: audioMasterRepository, projects, artifacts: artifactRepository,
      rights: rightsRepository, clock: () => new Date(at(2)),
      createJobId: () => `compile-job-${++entity}`,
      createTransitionId: () => `compile-transition-${++providerTransition}`,
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
          createLeaseToken: () => `compile-lease-${second}`,
          createTransitionId: () => `compile-transition-${++providerTransition}`,
        })(`compile-worker-${second}`)
        if (worked === null) quiet += 1
        else quiet = 0
      }
    }

    const planDependencies = {
      plans, projects, profiles: syntheticRepository, clock: () => new Date(at(1)),
      createId: (kind) => `${kind}-cp-${++entity}`,
    }
    const createPlan = createSyntheticScriptPlanService(planDependencies)
    const mutatePlan = mutateSyntheticScriptPlanService(planDependencies)
    const ensure = ensureSyntheticBlockGenerationsService({
      plans, generations, profiles: syntheticRepository, artifacts: artifactRepository,
      rights: rightsRepository, enqueueProviderJob: enqueue, clock: () => new Date(at(2)),
    })
    const settle = settleSyntheticBlockGenerationsService({
      generations, providerJobs: providerRepository, resultArtifacts: resultArtifactRepository,
      clock: () => new Date(at(9)),
    })
    const createAudioMaster = createSyntheticAudioMasterService({
      repository: audioMasterRepository, projects, profiles: syntheticRepository,
      providerJobs: providerRepository, artifacts: artifactRepository, rights: rightsRepository,
      clock: () => new Date(at(20)), createId: () => `compile-master-${++entity}`,
    })
    const compile = compileSyntheticBlockAudioService({
      plans, generations, profiles: syntheticRepository,
      artifacts: artifactRepository, artifactPersistence: artifactRepository,
      rights: rightsRepository, concatenations,
      sources: new LocalArtifactSourceMaterializer(artifactRoot),
      storage,
      mutatePlan,
      createAudioMaster,
      concatenate: (input) => concatenateBlockAudio({ ...input, ffmpegPath, ffprobePath }),
      workRoot: compileWorkRoot,
      clock: () => new Date(at(20)),
    })

    const created = await createPlan({
      workspaceId, projectId, projectVersionId,
      profileSnapshotId: profile.profile.profileSnapshotId, locale: 'pt-BR',
      scriptText: 'Primeira frase do roteiro. Segunda frase do roteiro. Terceira frase do roteiro.',
      actor, idempotencyKey: 'compile-plan',
    })
    const planId = created.plan.head.id

    // A compile before every block is approved must fail closed.
    await assert.rejects(
      compile({
        workspaceId, projectId, projectVersionId, planId, baseVersionId: created.plan.version.id, baseHash: created.plan.version.planVersionHash,
        settings: { gapMs: 200, outputFormat: 'mp3' }, use: 'ads', market: 'BRA', actor,
        idempotencyKey: 'compile-early',
      }),
      (error) => error.code === 'PRECONDITION_REQUIRED' && /without an approved/.test(error.message),
    )

    await ensure({ workspaceId, projectId, projectVersionId, planId, use: 'ads', market: 'BRA', actor })
    await drainWorkers()
    await settle({ workspaceId, projectId, planId, actor })
    const currentPlan = await plans.readPlan({ workspaceId, projectId, planId })

    const compiled = await compile({
      workspaceId, projectId, projectVersionId, planId, baseVersionId: currentPlan.version.id, baseHash: currentPlan.version.planVersionHash,
      settings: { gapMs: 200, outputFormat: 'mp3' }, use: 'ads', market: 'BRA', actor,
      idempotencyKey: 'compile-final',
    })
    assert.equal(compiled.replayed, false)
    assert.equal(compiled.concatenation.entries.length, 3)
    assert.equal(compiled.concatenation.audioMasterId, compiled.audioMasterId)
    // Every entry maps a block to its real window in the consolidated audio.
    let cursor = 0
    for (const entry of compiled.concatenation.entries) {
      assert.equal(entry.outputInMs, cursor)
      cursor = entry.outputOutMs + entry.gapAfterMs
    }
    assert.equal(compiled.concatenation.durationMs, cursor)

    // The consolidated master carries the shifted words inside the audio.
    const master = await audioMasterRepository.read({ workspaceId, projectId, audioMasterId: compiled.audioMasterId })
    assert.equal(master.master.source.kind, 'concatenated')
    assert.equal(master.master.source.concatenationId, compiled.concatenation.id)
    assert.equal(master.master.audio.durationMs, compiled.concatenation.durationMs)
    assert.ok(master.master.words.length >= 12)
    assert.ok(master.master.words.at(-1).endMs <= master.master.audio.durationMs)

    // The stored concatenated audio is real and probe-verified.
    const audioRow = await artifactRepository.findById(workspaceId, compiled.concatenation.audioArtifactId)
    const storedAudioPath = join(artifactRoot, ...audioRow.artifactKey.split('/'))
    const probe = JSON.parse(execFileSync(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,sample_rate,channels', '-of', 'json', storedAudioPath], { encoding: 'utf8', windowsHide: true }))
    assert.equal(probe.streams[0].codec_name, 'mp3')
    assert.equal(Number(probe.streams[0].sample_rate), 44100)
    assert.ok(Math.abs(Number(probe.format.duration) * 1_000 - compiled.concatenation.durationMs) <= 120)

    // The compile is idempotent: same key replays byte-identically.
    const replayed = await compile({
      workspaceId, projectId, projectVersionId, planId, baseVersionId: currentPlan.version.id, baseHash: currentPlan.version.planVersionHash,
      settings: { gapMs: 200, outputFormat: 'mp3' }, use: 'ads', market: 'BRA', actor,
      idempotencyKey: 'compile-final',
    })
    assert.equal(replayed.replayed, true)
    assert.equal(replayed.concatenation.finalAudioSha256, compiled.concatenation.finalAudioSha256)
    assert.equal(await client.v2SyntheticBlockConcatenation.count({ where: { workspaceId } }), 1)
    assert.equal(await client.v2SyntheticAudioMaster.count({ where: { workspaceId } }), 1)

    // The compile appended an immutable plan version recording the command.
    const afterCompile = await plans.readPlan({ workspaceId, projectId, planId })
    assert.equal(afterCompile.version.commandType, 'compile-audio')
    assert.equal(afterCompile.version.impact.renderSemantics, 'no-render')
  } finally {
    await cleanup()
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})
