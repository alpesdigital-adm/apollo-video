import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const ffprobePath = require('ffprobe-static').path

const workspaceId = 'provider-journey-e2e-workspace'
const clientId = 'provider-journey-e2e-client'
const credentialId = 'provider-journey-e2e-credential'
const hash = (character) => character.repeat(64)
const at = (second) => new Date(Date.parse('2029-01-01T00:00:00.000Z') + second * 1_000).toISOString()

const SCRIPT = 'Olá mundo'
const SCRIPT_HASH = createHash('sha256').update(SCRIPT, 'utf8').digest('hex')
const storageDriver = (process.env.APOLLO_V2_ARTIFACT_STORAGE_DRIVER ?? 'local').trim().toLowerCase()

function ttsAlignment() {
  const characters = [...SCRIPT]
  return {
    characters,
    character_start_times_seconds: characters.map((_, index) => index * 0.22),
    character_end_times_seconds: characters.map((_, index) => (index + 1) * 0.22),
  }
}

test('T-FR-101 durable TTS-to-avatar production journey survives worker restarts on real PostgreSQL and storage', {
  skip: !process.env.V2_DATABASE_URL && 'V2_DATABASE_URL is required',
  timeout: 480_000,
}, async () => {
  const client = new PrismaClient({ datasources: { db: { url: process.env.V2_DATABASE_URL } } })
  const root = await mkdtemp(join(tmpdir(), 'apollo-provider-journey-'))
  const artifactRoot = join(root, 'artifacts')
  const workRoot = join(root, 'work')
  await mkdir(artifactRoot, { recursive: true })
  await mkdir(workRoot, { recursive: true })

  let objectStore = null

  const cleanup = async () => {
    await client.v2ProviderResultArtifact.deleteMany({ where: { workspaceId } })
    await client.v2ProviderJobTransition.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticAudioMaster.deleteMany({ where: { workspaceId } })
    await client.v2ProviderJob.deleteMany({ where: { workspaceId } })
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
    const { LocalArtifactSourceMaterializer, LocalMediaUploadStorage } = await import('../../src/v2/infrastructure/media/local-media-upload-storage.ts')
    const { S3ArtifactSourceMaterializer, S3VerifiedMediaStorage, createArtifactS3ClientFromEnvironment } = await import('../../src/v2/infrastructure/media/s3-artifact-storage.ts')
    const { probeAudioDurationSeconds, probeVideo } = await import('../../src/v2/infrastructure/media/video-probe.ts')
    const { ElevenLabsTtsProviderAdapter } = await import('../../src/v2/infrastructure/elevenlabs-tts-provider.ts')
    const { HeyGenV3AsyncMediaProviderAdapter } = await import('../../src/v2/infrastructure/heygen-v3-provider.ts')
    const { AuthorizedProviderSubmissionInputMaterializer } = await import('../../src/v2/infrastructure/provider-submission-input-materializer.ts')
    const {
      PersistedProviderResultCritic,
      PersistedTtsResultCritic,
      VerifiedProviderResultIngestor,
      VerifiedTtsResultIngestor,
    } = await import('../../src/v2/infrastructure/provider-result-ingestion.ts')
    const { calculateFileSha256 } = await import('../../src/v2/infrastructure/media/local-artifact-manifest.ts')

    // Real media fixtures produced by real FFmpeg: the "provider" outputs.
    const ttsAudioPath = join(root, 'tts-speech.mp3')
    execFileSync(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=44100:duration=2', '-c:a', 'libmp3lame', '-b:a', '128k', ttsAudioPath], { windowsHide: true })
    const ttsAudioBytes = await readFile(ttsAudioPath)
    const avatarVideoPath = join(root, 'avatar-result.mp4')
    execFileSync(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x1AA36F:s=540x960:r=30:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', avatarVideoPath], { windowsHide: true })

    await new PrismaWorkspaceRepository(client).create(createWorkspace({
      id: workspaceId, slug: workspaceId, name: 'Provider Journey E2E', status: 'active', createdAt: at(0),
    }))
    const issued = await createApiClientService({
      repository: new PrismaApiClientRepository(client), credentialCrypto: nodeApiCredentialCrypto, clock: () => new Date(at(0)),
    })({ id: clientId, credentialId, workspaceId, name: 'Provider journey client', environment: 'production', scopes: ['projects:read', 'projects:write'] })
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
      createId: (kind) => `${kind}-provider-journey-${++entity}`,
      createEventId: () => `00000000-0000-4000-8000-${String(900_000 + ++event).padStart(12, '0')}`,
    })({ workspaceId, name: 'Jornada TTS para avatar', objective: 'awareness', format: '9:16', actor, idempotency: { clientId, key: 'provider-journey-project' } })

    await client.v2MediaArtifact.create({
      data: {
        id: 'journey-consent-evidence', workspaceId, artifactKey: 'provider-journey/consent.json',
        sha256: hash('a'), byteSize: 512n, mediaType: 'data', container: 'json', status: 'available', createdAt: new Date(at(0)),
      },
    })
    const artifactRepository = new PrismaMediaArtifactRepository(client)
    const syntheticRepository = new PrismaSyntheticProductionRepository(client)
    const registerProfile = registerSyntheticPresenterProfileService({
      repository: syntheticRepository, artifacts: artifactRepository, clock: () => new Date(at(0)),
    })
    const registered = await registerProfile({
      workspaceId, profileId: 'journey-presenter', version: 1, actorIdentityId: 'journey-identity',
      avatar: { adapterId: 'heygen-v3', adapterVersion: '3.0.0', identityRef: 'avatar_journey_123' },
      voice: { id: 'voice_journey_123', version: 1, adapterId: 'elevenlabs-tts', adapterVersion: '1.0.0' },
      defaultLocale: 'pt-BR', status: 'active', disclosure: 'Conteúdo gerado com IA',
      consent: {
        id: 'journey-consent', evidenceArtifactId: 'journey-consent-evidence', granted: true,
        allowedUses: ['ads'], allowedMarkets: ['BRA'], allowedLocales: ['pt-BR'],
        allowedOperations: ['tts', 'audio-avatar'], expiresAt: '2030-01-01T00:00:00.000Z',
      },
      actor, idempotencyKey: 'journey-profile-key',
    })

    // Controlled ElevenLabs HTTP boundary: real adapter code, stubbed network.
    const elevenLabsRequests = []
    const elevenLabsAdapter = new ElevenLabsTtsProviderAdapter({
      apiKey: 'journey-elevenlabs-secret', costMinorUnitsPerThousandCharacters: 30,
      clock: () => new Date(at(3)),
      fetch: async (url, init) => {
        elevenLabsRequests.push({ url: String(url), body: init.body })
        assert.equal(new Headers(init.headers).get('xi-api-key'), 'journey-elevenlabs-secret')
        return new Response(JSON.stringify({ audio_base64: ttsAudioBytes.toString('base64'), alignment: ttsAlignment() }), {
          status: 200, headers: { 'content-type': 'application/json', 'request-id': 'elevenlabs_journey_req_1' },
        })
      },
    })
    // Controlled HeyGen HTTP boundary: real adapter code, stubbed network.
    const heygenRequests = []
    const heygenStatuses = ['pending', 'processing', 'completed', 'completed']
    const heygenAdapter = new HeyGenV3AsyncMediaProviderAdapter({
      apiKey: 'journey-heygen-secret', costMinorUnitsPerMinute: 150, clock: () => new Date(at(3)),
      fetch: async (url, init) => {
        heygenRequests.push({ url: String(url), method: init.method })
        if (String(url).endsWith('/v3/assets')) return new Response(JSON.stringify({ data: { asset_id: 'journey_asset_1' } }), { status: 200, headers: { 'content-type': 'application/json' } })
        if (init.method === 'POST') return new Response(JSON.stringify({ data: { video_id: 'journey_video_1', status: 'pending' } }), { status: 200, headers: { 'content-type': 'application/json' } })
        const status = heygenStatuses.shift()
        return new Response(JSON.stringify({ data: { id: 'journey_video_1', status, ...(status === 'completed' ? { video_url: 'https://files.heygen.ai/journey/result.mp4' } : {}) } }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })
    const registry = {
      get: ({ adapterId, adapterVersion }) => {
        if (adapterId === 'elevenlabs-tts' && adapterVersion === '1.0.0') return elevenLabsAdapter
        if (adapterId === 'heygen-v3' && adapterVersion === '3.0.0') return heygenAdapter
        return null
      },
    }

    // Storage of record: the content-addressed local root by default, or real
    // versioned MinIO/S3 when the runtime driver env selects it (CI Compose).
    assert.ok(['local', 's3'].includes(storageDriver), `unknown artifact storage driver: ${storageDriver}`)
    if (storageDriver === 's3') {
      const aws = await import('@aws-sdk/client-s3')
      const { bucket, client: s3Client } = createArtifactS3ClientFromEnvironment()
      // Exclusive clean bucket per run: creating it must succeed — an existing
      // bucket would mean shared or inherited state, which is forbidden here.
      await s3Client.send(new aws.CreateBucketCommand({ Bucket: bucket }))
      await s3Client.send(new aws.PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: 'Enabled' } }))
      objectStore = { aws, bucket, client: s3Client }
    }
    const localStaging = new LocalMediaUploadStorage(artifactRoot)
    const storage = objectStore
      ? new S3VerifiedMediaStorage(localStaging, { bucket: objectStore.bucket, client: objectStore.client })
      : localStaging
    const materializeRoot = join(root, 'materialize')
    await mkdir(materializeRoot, { recursive: true })
    const sourceMaterializer = objectStore
      ? new S3ArtifactSourceMaterializer(materializeRoot, { bucket: objectStore.bucket, client: objectStore.client })
      : new LocalArtifactSourceMaterializer(artifactRoot)
    const readbackRoot = join(root, 'readback')
    await mkdir(readbackRoot, { recursive: true })
    let readbackSequence = 0
    // Local path whose bytes ARE the stored artifact: a version-bound GET from
    // MinIO in s3 mode, or the content-addressed path in local mode.
    const storedArtifactPath = async (artifactKey) => {
      if (!objectStore) return join(artifactRoot, ...artifactKey.split('/'))
      const head = await objectStore.client.send(new objectStore.aws.HeadObjectCommand({ Bucket: objectStore.bucket, Key: artifactKey }))
      assert.ok(head.VersionId && head.VersionId !== 'null', 'stored artifact object must be version-bound')
      const object = await objectStore.client.send(new objectStore.aws.GetObjectCommand({ Bucket: objectStore.bucket, Key: artifactKey, VersionId: head.VersionId }))
      const target = join(readbackRoot, `${readbackSequence += 1}-${artifactKey.split('/').at(-1)}`)
      await writeFile(target, Buffer.from(await object.Body.transformToByteArray()))
      return target
    }
    const providerRepository = new PrismaProviderJobRepository(client)
    const resultArtifactRepository = new PrismaProviderResultArtifactRepository(client)
    const rightsRepository = new PrismaAssetRightsRepository(client)
    const projectsQuery = new PrismaProjectWorkspaceQueryRepository(client)
    const audioMasterRepository = new PrismaSyntheticAudioMasterRepository(client)
    let providerTransition = 0
    const enqueue = enqueueProviderJobService({
      jobs: providerRepository, adapters: registry, profiles: syntheticRepository,
      audioMasters: audioMasterRepository, projects: projectsQuery, artifacts: artifactRepository,
      rights: rightsRepository, clock: () => new Date(at(1)),
      createJobId: () => `journey-job-${entity += 1}`,
      createTransitionId: () => `journey-transition-${++providerTransition}`,
    })

    const enqueueTtsRequest = {
      workspaceId, projectId: project.project.id, projectVersionId: project.version.id,
      profileSnapshotId: registered.profile.snapshot.id, operation: 'tts',
      adapterId: 'elevenlabs-tts', adapterVersion: '1.0.0',
      providerInput: { text: SCRIPT, scriptHash: SCRIPT_HASH, locale: 'pt-BR', outputFormat: 'mp3' },
      sourceArtifactIds: [], use: 'ads', market: 'BRA', locale: 'pt-BR', actor,
      idempotencyKey: 'journey-tts-key',
    }
    const ttsEnqueued = await enqueue(enqueueTtsRequest)
    assert.equal(ttsEnqueued.replayed, false)
    assert.equal(ttsEnqueued.persisted.job.status, 'planned')
    const ttsJobId = ttsEnqueued.persisted.job.id

    const materializer = new AuthorizedProviderSubmissionInputMaterializer({
      profiles: syntheticRepository, artifacts: artifactRepository,
      sources: sourceMaterializer, clock: () => new Date(at(2)),
    })
    const ttsIngestor = new VerifiedTtsResultIngestor({
      workRoot, storage, artifacts: artifactRepository, artifactQuery: artifactRepository,
      resultArtifacts: resultArtifactRepository,
      audioProber: { probeDurationSeconds: (path, options) => probeAudioDurationSeconds(path, options) },
      clock: () => new Date(at(3)),
    })
    const ttsCritic = new PersistedTtsResultCritic(artifactRepository, resultArtifactRepository)

    // Each tick constructs a brand-new worker instance with a new identity:
    // exactly what a process restart between steps looks like. All state that
    // carries the journey forward lives in PostgreSQL.
    let tick = 0
    const runFreshTtsWorkerOnce = () => {
      tick += 1
      return runProviderJobWorkerOnce({
        jobs: providerRepository, adapters: registry, materializer,
        ingestor: ttsIngestor, critic: ttsCritic,
        clock: () => new Date(at(tick + 2)),
        createLeaseToken: () => `journey-tts-lease-${tick}`,
        createTransitionId: () => `journey-transition-${++providerTransition}`,
      })(`journey-tts-worker-${tick}`)
    }
    for (let stage = 0; stage < 5; stage += 1) await runFreshTtsWorkerOnce()
    const ttsDone = await providerRepository.read({ workspaceId, projectId: project.project.id, jobId: ttsJobId })
    assert.equal(ttsDone.job.status, 'approved', `TTS job ended ${ttsDone.job.status}: ${JSON.stringify(ttsDone.job.normalizedError)}`)
    assert.equal(ttsDone.job.providerJobId, 'elevenlabs_journey_req_1')
    assert.equal(ttsDone.job.providerStatus, 'completed')
    assert.equal(elevenLabsRequests.length, 1, 'exactly one controlled TTS call — never a paid one')
    // A restarted worker after approval finds nothing to do.
    assert.equal(await runFreshTtsWorkerOnce(), null)

    const ledger = await resultArtifactRepository.listByJob({ workspaceId, projectId: project.project.id, jobId: ttsJobId })
    assert.deepEqual(ledger.map(({ role }) => role), ['alignment-evidence', 'primary-audio'])
    const audioEntry = ledger.find((entry) => entry.role === 'primary-audio')
    const alignmentEntry = ledger.find((entry) => entry.role === 'alignment-evidence')
    assert.equal(audioEntry.scriptHash, SCRIPT_HASH)
    assert.equal(audioEntry.providerJobRef, 'elevenlabs_journey_req_1')
    const audioRow = await artifactRepository.findById(workspaceId, audioEntry.artifactId)
    const storedAudioPath = await storedArtifactPath(audioRow.artifactKey)
    assert.equal(await calculateFileSha256(storedAudioPath), audioEntry.artifactSha256)
    assert.equal((await stat(storedAudioPath)).size, Number(audioEntry.byteSize))
    const audioProbe = JSON.parse(execFileSync(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name', '-of', 'json', storedAudioPath], { encoding: 'utf8', windowsHide: true }))
    assert.equal(audioProbe.streams[0].codec_name, 'mp3')
    assert.ok(Math.abs(Number(audioProbe.format.duration) - 2) <= 0.2)
    const alignmentRow = await artifactRepository.findById(workspaceId, alignmentEntry.artifactId)
    const storedAlignment = JSON.parse(await readFile(await storedArtifactPath(alignmentRow.artifactKey), 'utf8'))
    assert.equal(storedAlignment.characters.join(''), SCRIPT)
    assert.equal(storedAlignment.audioSha256, audioEntry.artifactSha256)

    // Replay is byte-identical and charges nothing new.
    const ttsReplayed = await enqueue(enqueueTtsRequest)
    assert.equal(ttsReplayed.replayed, true)
    assert.equal(elevenLabsRequests.length, 1)
    assert.equal(await client.v2ProviderResultArtifact.count({ where: { workspaceId } }), 2)
    assert.equal(await calculateFileSha256(await storedArtifactPath(audioRow.artifactKey)), audioEntry.artifactSha256)

    // Rights for the produced artifacts before they may feed the audio master.
    for (const [index, artifactId] of [audioEntry.artifactId, alignmentEntry.artifactId].entries()) {
      const snapshot = createAssetRightsSnapshot({
        id: `journey-rights-${index + 1}`, workspaceId, artifactId, sequence: 1,
        draft: {
          status: 'approved', allowedUses: ['ads'], prohibitedUses: [], allowedMarkets: ['BRA'], allowedLocales: ['pt-BR'],
          allowedSyntheticOperations: ['tts', 'audio-avatar'], expiresAt: '2030-01-01T00:00:00.000Z',
          consent: { status: 'not-required', allowedUses: [] },
        },
        createdBy: { type: 'api-client', id: clientId }, createdAt: at(9),
      })
      await rightsRepository.setCurrent(snapshot, assetRightsRevision(artifactId, 0), createAssetRightsChangeIntent({
        workspaceId, artifactId, snapshotHash: snapshot.snapshotHash, baseRevision: assetRightsRevision(artifactId, 0),
        actor: { kind: 'internal', actorType: 'api-client', actorId: clientId }, changedAt: at(9),
      }))
    }

    const createAudioMaster = createSyntheticAudioMasterService({
      repository: audioMasterRepository, projects: projectsQuery, profiles: syntheticRepository,
      providerJobs: providerRepository, artifacts: artifactRepository, rights: rightsRepository,
      clock: () => new Date(at(10)), createId: () => 'journey-audio-master',
    })
    const audioMasterRequest = {
      workspaceId, projectId: project.project.id, projectVersionId: project.version.id,
      profileSnapshotId: registered.profile.snapshot.id,
      source: { kind: 'tts', text: SCRIPT, providerJobId: ttsJobId },
      audioArtifactId: audioEntry.artifactId, alignmentEvidenceArtifactId: alignmentEntry.artifactId,
      durationMs: 2_000, locale: 'pt-BR',
      words: [
        { word: 'Olá', startMs: 0, endMs: 1_000, confidence: 0.99 },
        { word: 'mundo', startMs: 1_000, endMs: 2_000, confidence: 0.98 },
      ],
      approvedAt: at(8), approvalCriticHash: ttsDone.job.criticResultHash,
      use: 'ads', market: 'BRA', actor, idempotencyKey: 'journey-audio-master-key',
    }
    const masterCreated = await createAudioMaster(audioMasterRequest)
    assert.equal(masterCreated.replayed, false)
    const masterReplayed = await createAudioMaster(audioMasterRequest)
    assert.equal(masterReplayed.replayed, true)
    assert.equal(await client.v2SyntheticAudioMaster.count({ where: { workspaceId } }), 1)

    // Avatar leg: the approved master's exact audio is the only allowed input.
    const avatarEnqueued = await enqueue({
      workspaceId, projectId: project.project.id, projectVersionId: project.version.id,
      profileSnapshotId: registered.profile.snapshot.id, operation: 'audio-avatar',
      adapterId: 'heygen-v3', adapterVersion: '3.0.0',
      providerInput: { aspectRatio: '9:16' },
      sourceArtifactIds: [audioEntry.artifactId],
      audioMasterId: masterCreated.value.master.id,
      audioRange: { startWordIndex: 0, endWordIndex: 2 },
      use: 'ads', market: 'BRA', locale: 'pt-BR', actor, idempotencyKey: 'journey-avatar-key',
    })
    assert.equal(avatarEnqueued.persisted.job.status, 'planned')
    const avatarJobId = avatarEnqueued.persisted.job.id

    let downloaderCleanups = 0
    const avatarIngestor = new VerifiedProviderResultIngestor({
      downloader: {
        async download(input) {
          // Controlled stand-in for the provider file host: the URL the real
          // adapter surfaced is honored, the bytes are a real MP4.
          assert.equal(input.url, 'https://files.heygen.ai/journey/result.mp4')
          const target = join(workRoot, `downloaded-${input.operationId}.mp4`)
          await copyFile(avatarVideoPath, target)
          const bytes = await readFile(target)
          return { path: target, sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.byteLength }
        },
        async cleanup(operationId) {
          downloaderCleanups += 1
          await rm(join(workRoot, `downloaded-${operationId}.mp4`), { force: true })
        },
      },
      storage, artifacts: artifactRepository, artifactQuery: artifactRepository,
      prober: { probe: (path, options) => probeVideo(path, { ...options, requireAudio: true }) },
      clock: () => new Date(at(12)),
    })
    const avatarCritic = new PersistedProviderResultCritic(artifactRepository)
    const runFreshAvatarWorkerOnce = () => {
      tick += 1
      return runProviderJobWorkerOnce({
        jobs: providerRepository, adapters: registry, materializer,
        ingestor: avatarIngestor, critic: avatarCritic,
        clock: () => new Date(at(tick + 2)),
        createLeaseToken: () => `journey-avatar-lease-${tick}`,
        createTransitionId: () => `journey-transition-${++providerTransition}`,
      })(`journey-avatar-worker-${tick}`)
    }
    for (let stage = 0; stage < 7; stage += 1) await runFreshAvatarWorkerOnce()
    const avatarDone = await providerRepository.read({ workspaceId, projectId: project.project.id, jobId: avatarJobId })
    assert.equal(avatarDone.job.status, 'approved')
    assert.equal(avatarDone.job.providerJobId, 'journey_video_1')
    assert.equal(downloaderCleanups, 1)
    assert.deepEqual(heygenRequests.map(({ method }) => method), ['POST', 'POST', 'GET', 'GET', 'GET', 'GET'])

    const avatarRow = await artifactRepository.findById(workspaceId, avatarDone.job.resultArtifact.artifactId)
    const storedAvatarPath = await storedArtifactPath(avatarRow.artifactKey)
    assert.equal(await calculateFileSha256(storedAvatarPath), avatarDone.job.resultArtifact.artifactSha256)
    assert.equal((await stat(storedAvatarPath)).size, Number(avatarRow.byteSize))
    const videoProbe = JSON.parse(execFileSync(ffprobePath, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'json', storedAvatarPath], { encoding: 'utf8', windowsHide: true }))
    const videoStream = videoProbe.streams.find((stream) => stream.codec_type === 'video')
    assert.deepEqual([videoStream.codec_name, videoStream.width, videoStream.height], ['h264', 540, 960])
    assert.ok(videoProbe.streams.some((stream) => stream.codec_type === 'audio'))

    if (objectStore) {
      // MinIO is the storage of record: the bucket holds exactly the three
      // promoted artifacts and the local staging root kept none of their bytes.
      const listing = await objectStore.client.send(new objectStore.aws.ListObjectVersionsCommand({ Bucket: objectStore.bucket }))
      assert.equal(listing.IsTruncated ?? false, false)
      assert.equal((listing.DeleteMarkers ?? []).length, 0)
      assert.deepEqual(
        (listing.Versions ?? []).map(({ Key }) => Key).sort(),
        [alignmentRow.artifactKey, audioRow.artifactKey, avatarRow.artifactKey].sort(),
      )
      assert.deepEqual(await readdir(artifactRoot), [], 'local staging root must hold no promoted bytes in s3 mode')
    }

    // Tampering with the immutable master fails closed on the next read.
    const originalMasterHash = (await client.v2SyntheticAudioMaster.findUniqueOrThrow({ where: { id: masterCreated.value.master.id }, select: { masterHash: true } })).masterHash
    await client.v2SyntheticAudioMaster.update({ where: { id: masterCreated.value.master.id }, data: { masterHash: hash('9') } })
    await assert.rejects(
      audioMasterRepository.read({ workspaceId, projectId: project.project.id, audioMasterId: masterCreated.value.master.id }),
      (error) => /hash|integrity/i.test(String(error.message)),
    )
    await client.v2SyntheticAudioMaster.update({ where: { id: masterCreated.value.master.id }, data: { masterHash: originalMasterHash } })

    // Workspace isolation: another workspace sees nothing.
    assert.equal(await providerRepository.read({ workspaceId: 'other-workspace', projectId: project.project.id, jobId: ttsJobId }), null)
    assert.equal(await audioMasterRepository.read({ workspaceId: 'other-workspace', projectId: project.project.id, audioMasterId: masterCreated.value.master.id }), null)

    // Revoked consent blocks any new provider effect for that profile.
    const revoked = await registerProfile({
      workspaceId, profileId: 'journey-presenter-revoked', version: 1, actorIdentityId: 'journey-identity-revoked',
      avatar: { adapterId: 'heygen-v3', adapterVersion: '3.0.0', identityRef: 'avatar_revoked_123' },
      voice: { id: 'voice_revoked_123', version: 1, adapterId: 'elevenlabs-tts', adapterVersion: '1.0.0' },
      defaultLocale: 'pt-BR', status: 'active', disclosure: 'Conteúdo gerado com IA',
      consent: {
        id: 'journey-consent-revoked', evidenceArtifactId: 'journey-consent-evidence', granted: true,
        allowedUses: ['ads'], allowedMarkets: ['BRA'], allowedLocales: ['pt-BR'],
        allowedOperations: ['tts', 'audio-avatar'], expiresAt: '2030-01-01T00:00:00.000Z',
        revokedAt: '2029-06-01T00:00:00.000Z',
      },
      actor, idempotencyKey: 'journey-profile-revoked-key',
    })
    await assert.rejects(
      enqueue({ ...enqueueTtsRequest, profileSnapshotId: revoked.profile.snapshot.id, idempotencyKey: 'journey-tts-revoked-key' }),
      (error) => error.code === 'ASSET_RIGHTS_BLOCKED',
    )
  } finally {
    await cleanup()
    await client.$disconnect()
    if (objectStore) {
      // Zero orphan objects: delete every version, prove the empty listing,
      // then remove the run-exclusive bucket itself.
      const versions = await objectStore.client.send(new objectStore.aws.ListObjectVersionsCommand({ Bucket: objectStore.bucket }))
      const stored = [...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])].map(({ Key, VersionId }) => ({ Key, VersionId }))
      if (stored.length > 0) {
        await objectStore.client.send(new objectStore.aws.DeleteObjectsCommand({ Bucket: objectStore.bucket, Delete: { Objects: stored, Quiet: true } }))
      }
      const after = await objectStore.client.send(new objectStore.aws.ListObjectVersionsCommand({ Bucket: objectStore.bucket }))
      assert.deepEqual([...(after.Versions ?? []), ...(after.DeleteMarkers ?? [])], [], 'object storage must hold zero orphan objects after cleanup')
      await objectStore.client.send(new objectStore.aws.DeleteBucketCommand({ Bucket: objectStore.bucket }))
      objectStore.client.destroy()
    }
    // Zero orphans: every provider-side scratch root must be empty afterwards.
    const leftoverWork = await readdir(workRoot).catch(() => [])
    assert.deepEqual(leftoverWork, [], 'provider work root must not keep orphan files')
    const leftoverMaterialize = await readdir(join(root, 'materialize')).catch(() => [])
    assert.deepEqual(leftoverMaterialize, [], 'artifact materialization root must not keep orphan files')
    await rm(root, { recursive: true, force: true })
  }
})
