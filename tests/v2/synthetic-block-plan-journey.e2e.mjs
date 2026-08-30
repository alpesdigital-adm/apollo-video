import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import http from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const ffprobePath = require('ffprobe-static').path

const workspaceId = 'block-plan-journey-workspace'
const hash = (character) => character.repeat(64)
const at = (second) => new Date(Date.parse('2029-05-01T00:00:00.000Z') + second * 1_000).toISOString()
const storageDriver = (process.env.APOLLO_V2_ARTIFACT_STORAGE_DRIVER ?? 'local').trim().toLowerCase()

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function waitForServer(baseUrl, server) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next server exited with ${server.exitCode}`)
    try {
      if ((await globalThis.fetch(`${baseUrl}/v1/health`)).ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Timed out waiting for Next server')
}

test('T-FR-102 block plan journey runs end to end through /v1, durable workers and real storage', {
  skip: !process.env.V2_DATABASE_URL && 'V2_DATABASE_URL is required',
  timeout: 900_000,
}, async () => {
  const client = new PrismaClient({ datasources: { db: { url: process.env.V2_DATABASE_URL } } })
  const root = await mkdtemp(join(tmpdir(), 'apollo-block-journey-'))
  const artifactRoot = join(root, 'artifacts')
  const workRoot = join(root, 'work')
  await mkdir(artifactRoot, { recursive: true })
  await mkdir(workRoot, { recursive: true })
  let objectStore = null
  let stub = null
  let server = null
  let worker = null
  let serverLogs = ''
  let workerLogs = ''

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
    const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
    const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
    const { PrismaWorkspaceRepository } = await import('../../src/v2/infrastructure/prisma/workspace-repository.ts')
    const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
    const { PrismaMediaArtifactRepository } = await import('../../src/v2/infrastructure/prisma/media-artifact-repository.ts')
    const { PrismaProjectCreationRepository } = await import('../../src/v2/infrastructure/prisma/project-creation-repository.ts')
    const { PrismaSyntheticProductionRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-production-repository.ts')
    const { calculateFileSha256 } = await import('../../src/v2/infrastructure/media/local-artifact-manifest.ts')

    if (storageDriver === 's3') {
      const aws = await import('@aws-sdk/client-s3')
      const { createArtifactS3ClientFromEnvironment } = await import('../../src/v2/infrastructure/media/s3-artifact-storage.ts')
      const { bucket, client: s3Client } = createArtifactS3ClientFromEnvironment()
      await s3Client.send(new aws.CreateBucketCommand({ Bucket: bucket }))
      await s3Client.send(new aws.PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: 'Enabled' } }))
      objectStore = { aws, bucket, client: s3Client }
    }

    // Controlled ElevenLabs HTTP boundary: a real loopback server the REAL
    // adapter inside the app/worker processes calls. Every paid call yields
    // unique audio bytes; a marker text fails deterministically.
    const providerCalls = []
    let requestSequence = 0
    const audioByCall = new Map()
    const audioBytesFor = async (key) => {
      if (!audioByCall.has(key)) {
        const index = audioByCall.size
        const path = join(root, `tts-${index}.mp3`)
        execFileSync(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${230 + index * 29}:sample_rate=44100:duration=2`, '-c:a', 'libmp3lame', '-b:a', '128k', path], { windowsHide: true })
        audioByCall.set(key, await readFile(path))
      }
      return audioByCall.get(key)
    }
    stub = http.createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => { body += chunk })
      request.on('end', async () => {
        try {
          const payload = JSON.parse(body)
          providerCalls.push(payload.text)
          if (payload.text.includes('FALHE')) {
            response.writeHead(500, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ detail: { status: 'error' } }))
            return
          }
          requestSequence += 1
          const characters = [...payload.text]
          const step = 2 / characters.length
          const bytes = await audioBytesFor(`call-${requestSequence}`)
          response.writeHead(200, { 'content-type': 'application/json', 'request-id': `journey_req_${requestSequence}` })
          response.end(JSON.stringify({
            audio_base64: bytes.toString('base64'),
            alignment: {
              characters,
              character_start_times_seconds: characters.map((_, index) => index * step),
              character_end_times_seconds: characters.map((_, index) => (index + 1) * step),
            },
          }))
        } catch (error) {
          response.writeHead(500, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ detail: String(error) }))
        }
      })
    })
    const stubPort = await freePort()
    await new Promise((resolve) => stub.listen(stubPort, '127.0.0.1', resolve))

    await new PrismaWorkspaceRepository(client).create(createWorkspace({
      id: workspaceId, slug: workspaceId, name: 'Block plan journey', status: 'active', createdAt: at(0),
    }))
    const issued = await createApiClientService({
      repository: new PrismaApiClientRepository(client), credentialCrypto: nodeApiCredentialCrypto, clock: () => new Date(at(0)),
    })({ id: 'block-journey-client', workspaceId, name: 'Block journey', environment: 'production', scopes: ['projects:read', 'projects:write'] })
    const auditContext = createExternalAuditContext({
      clientId: issued.client.id, credentialId: issued.credential.id, workspaceId, environment: 'production',
    })
    const actor = Object.freeze({
      ...auditContext, scopes: new Set(['projects:read', 'projects:write']), authenticationKind: 'bearer',
      clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
      clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext,
    })
    let entity = 0
    let event = 0
    const project = await createProjectService({
      repository: new PrismaProjectCreationRepository(client), clock: () => new Date(at(0)),
      createId: (kind) => `${kind}-block-journey-${++entity}`,
      createEventId: () => `00000000-0000-4000-8000-${String(400_000 + ++event).padStart(12, '0')}`,
    })({ workspaceId, name: 'Jornada de blocos', objective: 'awareness', format: '9:16', actor, idempotency: { clientId: issued.client.id, key: 'block-journey-project' } })
    const projectId = project.project.id
    const projectVersionId = project.version.id

    await client.v2MediaArtifact.create({
      data: {
        id: 'block-journey-consent', workspaceId, artifactKey: 'block-journey/consent.json',
        sha256: hash('a'), byteSize: 512n, mediaType: 'data', container: 'json', status: 'available', createdAt: new Date(at(0)),
      },
    })
    const registerProfile = registerSyntheticPresenterProfileService({
      repository: new PrismaSyntheticProductionRepository(client),
      artifacts: new PrismaMediaArtifactRepository(client),
      clock: () => new Date(at(0)),
    })
    const profileInput = (version, voiceId, avatarRef, key, extra = {}) => ({
      workspaceId, profileId: 'block-journey-presenter', version, actorIdentityId: 'block-journey-identity',
      avatar: { adapterId: 'heygen-v3', adapterVersion: '3.0.0', identityRef: avatarRef },
      voice: { id: voiceId, version: 1, adapterId: 'elevenlabs-tts', adapterVersion: '1.0.0' },
      defaultLocale: 'pt-BR', status: 'active', disclosure: 'Conteúdo gerado com IA',
      consent: {
        id: `block-journey-consent-v${version}`, evidenceArtifactId: 'block-journey-consent', granted: true,
        allowedUses: ['ads'], allowedMarkets: ['BRA'], allowedLocales: ['pt-BR'],
        allowedOperations: ['tts', 'audio-avatar'], expiresAt: '2030-01-01T00:00:00.000Z',
        ...extra,
      },
      actor, idempotencyKey: key,
    })
    const profileV1 = await registerProfile(profileInput(1, 'voice_journey_a', 'avatar_journey_1', 'block-journey-profile-v1'))
    const profileV2 = await registerProfile(profileInput(2, 'voice_journey_b', 'avatar_journey_1', 'block-journey-profile-v2'))
    const profileV3 = await registerProfile(profileInput(3, 'voice_journey_b', 'avatar_journey_2', 'block-journey-profile-v3'))

    const port = await freePort()
    const baseUrl = `http://127.0.0.1:${port}`
    const runtimeEnv = {
      ...process.env,
      NODE_ENV: 'development',
      __NEXT_PROCESSED_ENV: 'true',
      APOLLO_API_ENVIRONMENT: 'production',
      APOLLO_GOVERNANCE_ANOMALY_REQUEST_MINIMUM: '400',
      APOLLO_V2_PERSISTENCE: 'postgres',
      APOLLO_V2_ARTIFACT_ROOT: artifactRoot,
      APOLLO_V2_RENDER_WORK_ROOT: workRoot,
      APOLLO_V2_PROVIDER_WORK_ROOT: join(workRoot, 'provider'),
      APOLLO_PROTECTED_PAYLOAD_KEY_ID: 'block-journey-protected-payload',
      APOLLO_PROTECTED_PAYLOAD_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      FFMPEG_PATH: ffmpegPath,
      FFPROBE_PATH: ffprobePath,
      APOLLO_V2_ELEVENLABS_API_KEY: 'block-journey-stub-secret',
      APOLLO_V2_ELEVENLABS_BASE_URL: `http://127.0.0.1:${stubPort}`,
      APOLLO_V2_ELEVENLABS_COST_MINOR_UNITS_PER_THOUSAND_CHARACTERS: '30',
      APOLLO_V2_PROVIDER_POLL_MS: '200',
    }
    server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--webpack', '-p', String(port)], {
      cwd: process.cwd(), env: runtimeEnv, stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.stdout.on('data', (chunk) => { serverLogs += String(chunk) })
    server.stderr.on('data', (chunk) => { serverLogs += String(chunk) })
    await waitForServer(baseUrl, server)

    // The provider worker is a REAL separate process; it is killed and
    // relaunched mid-journey, so every stage survives a worker restart.
    const startWorker = () => {
      const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/run-v2-provider-worker.mjs'], {
        cwd: process.cwd(), env: runtimeEnv, stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout.on('data', (chunk) => { workerLogs += String(chunk) })
      child.stderr.on('data', (chunk) => { workerLogs += String(chunk) })
      return child
    }
    const stopWorker = async (child) => {
      if (!child || child.exitCode !== null) return
      child.kill('SIGTERM')
      await new Promise((resolve) => {
        const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 10_000)
        child.once('exit', () => { clearTimeout(timeout); resolve() })
      })
    }
    worker = startWorker()

    const headers = {
      authorization: `Bearer ${issued.token}`,
      'content-type': 'application/json',
    }
    const api = async (method, path, key, payload) => {
      // A 404 with a null body is the dev server still lazily compiling the
      // route (a real 404 carries the {error} envelope); replaying is safe
      // because every mutation carries an idempotency key.
      const deadline = Date.now() + 30_000
      for (;;) {
        const response = await globalThis.fetch(`${baseUrl}${path}`, {
          method,
          headers: key ? { ...headers, 'idempotency-key': key } : headers,
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        })
        const parsed = await response.json().catch(() => null)
        if (response.status === 404 && parsed === null && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 500))
          continue
        }
        return { status: response.status, payload: parsed }
      }
    }
    const planPath = (suffix = '') => `/v1/projects/${projectId}/synthetic-script-plans${suffix}`
    const getPlan = async (planId) => {
      const read = await api('GET', planPath(`/${planId}`))
      assert.equal(read.status, 200, JSON.stringify(read.payload))
      return read.payload.data
    }
    const waitForGenerations = async (planId, predicate, label) => {
      const deadline = Date.now() + 180_000
      for (;;) {
        if (worker.exitCode !== null) {
          throw new Error(`provider worker exited with ${worker.exitCode} while waiting for ${label}\nworker: ${workerLogs.slice(-3000)}`)
        }
        const data = await getPlan(planId)
        if (predicate(data)) return data
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${label}: ${JSON.stringify(data.generations.map(({ blockId, status }) => ({ blockId, status })))}\nworker: ${workerLogs.slice(-2000)}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
    const effectiveByBlock = (data) => {
      const byBlock = new Map()
      for (const generation of data.generations) {
        const current = byBlock.get(generation.blockId)
        if (!current || generation.attempt > current.attempt) byBlock.set(generation.blockId, generation)
      }
      return byBlock
    }
    const allApproved = (data) => data.plan.version.blockSequence.every((blockId) => effectiveByBlock(data).get(blockId)?.status === 'approved')
    const context = (data) => ({
      projectVersionId,
      baseVersionId: data.plan.version.id,
      baseHash: data.plan.version.planVersionHash,
      use: 'ads',
      market: 'BRA',
    })

    // 1. Create: five sentences, five paid calls, all durable and approved.
    const created = await api('POST', planPath(), 'bj-create', {
      projectVersionId,
      profileSnapshotId: profileV1.profile.profileSnapshotId,
      locale: 'pt-BR',
      scriptText: 'Primeira ideia do roteiro. Segunda ideia bem forte! Terceira pergunta direta? Quarta reflexão calma. Quinta frase final.',
      use: 'ads', market: 'BRA',
    })
    assert.equal(created.status, 201, JSON.stringify(created.payload))
    const planId = created.payload.data.plan.head.id
    assert.equal(created.payload.data.plan.blocks.length, 5)
    assert.deepEqual(created.payload.data.generations.map(({ action }) => action), ['enqueued', 'enqueued', 'enqueued', 'enqueued', 'enqueued'])
    let state = await waitForGenerations(planId, allApproved, 'initial five blocks')
    assert.equal(providerCalls.length, 5)

    // 2. Real worker process restart between stages.
    const firstWorkerPid = worker.pid
    await stopWorker(worker)
    worker = startWorker()
    assert.notEqual(worker.pid, firstWorkerPid)

    // 3. Insert a sixth block: exactly one new paid call.
    const inserted = await api('POST', planPath(`/${planId}/blocks`), 'bj-insert', {
      ...context(state), position: 2, text: 'Sexta ideia inserida no meio.',
    })
    assert.equal(inserted.status, 201, JSON.stringify(inserted.payload))
    assert.equal(inserted.payload.data.generations.filter(({ action }) => action === 'enqueued').length, 1)
    state = await waitForGenerations(planId, allApproved, 'inserted block')
    assert.equal(providerCalls.length, 6)

    // 4. Removing a block costs nothing.
    const blockToRemove = state.plan.version.blockSequence[4]
    const removed = await api('DELETE', planPath(`/${planId}/blocks/${blockToRemove}`), 'bj-remove', { ...context(state) })
    assert.equal(removed.status, 200, JSON.stringify(removed.payload))
    assert.equal(removed.payload.data.plan.version.blockSequence.length, 5)
    assert.equal(providerCalls.length, 6)
    state = await getPlan(planId)

    // 5. Reordering costs nothing and keeps identities.
    const reorderTarget = [...state.plan.version.blockSequence].reverse()
    const reordered = await api('POST', planPath(`/${planId}/block-order`), 'bj-reorder', {
      ...context(state), order: reorderTarget,
    })
    assert.equal(reordered.status, 200, JSON.stringify(reordered.payload))
    assert.deepEqual(reordered.payload.data.plan.version.blockSequence, reorderTarget)
    assert.equal(providerCalls.length, 6)
    state = await getPlan(planId)

    // 6. Editing one block regenerates exactly that block.
    const editTarget = state.plan.version.blockSequence[1]
    const edited = await api('POST', planPath(`/${planId}/blocks/${editTarget}/edits`), 'bj-edit-key', {
      ...context(state), text: 'Segunda ideia totalmente reescrita agora.',
    })
    assert.equal(edited.status, 201, JSON.stringify(edited.payload))
    assert.equal(edited.payload.data.generations.filter(({ action }) => action === 'enqueued').length, 1)
    state = await waitForGenerations(planId, allApproved, 'edited block')
    assert.equal(providerCalls.length, 7)

    // 7. A failing block fails alone; retry touches only it.
    const failTarget = state.plan.version.blockSequence[2]
    const failEdit = await api('POST', planPath(`/${planId}/blocks/${failTarget}/edits`), 'bj-fail-edit', {
      ...context(state), text: 'Frase que FALHE de propósito.',
    })
    assert.equal(failEdit.status, 201, JSON.stringify(failEdit.payload))
    const failingBlockId = failEdit.payload.data.plan.version.impact.createdBlockIds[0]
    state = await waitForGenerations(planId, (data) => effectiveByBlock(data).get(failingBlockId)?.status === 'failed', 'failing block')
    assert.equal(providerCalls.length, 8)
    for (const [blockId, generation] of effectiveByBlock(state)) {
      if (blockId !== failingBlockId) assert.equal(generation.status, 'approved', `${blockId} must stay approved`)
    }
    // Explicit retry regenerates only the failed block (and fails again).
    const retried = await api('POST', planPath(`/${planId}/blocks/${failingBlockId}/regenerations`), 'bj-retry', { ...context(state) })
    assert.equal(retried.status, 201, JSON.stringify(retried.payload))
    assert.equal(retried.payload.data.generations.filter(({ action }) => action === 'enqueued').length, 1)
    state = await waitForGenerations(planId, (data) => effectiveByBlock(data).get(failingBlockId)?.attempt === 2 && effectiveByBlock(data).get(failingBlockId)?.status === 'failed', 'failed retry')
    assert.equal(providerCalls.length, 9)
    // Fixing the text approves the replacement block.
    const fixed = await api('POST', planPath(`/${planId}/blocks/${failingBlockId}/edits`), 'bj-fix-edit', {
      ...context(state), text: 'Frase consertada e definitiva.',
    })
    assert.equal(fixed.status, 201, JSON.stringify(fixed.payload))
    state = await waitForGenerations(planId, allApproved, 'fixed block')
    assert.equal(providerCalls.length, 10)

    // 8. A new voice regenerates every block; keeping the voice regenerates none.
    const voiceChanged = await api('POST', planPath(`/${planId}/presenter-profile`), 'bj-voice-b', {
      ...context(state), profileSnapshotId: profileV2.profile.profileSnapshotId,
    })
    assert.equal(voiceChanged.status, 200, JSON.stringify(voiceChanged.payload))
    assert.equal(voiceChanged.payload.data.generations.filter(({ action }) => action === 'enqueued').length, 5)
    state = await waitForGenerations(planId, allApproved, 'voice change')
    assert.equal(providerCalls.length, 15)
    // Only the avatar identity changes: every audio is reused untouched.
    const avatarChanged = await api('POST', planPath(`/${planId}/presenter-profile`), 'bj-avatar-2', {
      ...context(state), profileSnapshotId: profileV3.profile.profileSnapshotId,
    })
    assert.equal(avatarChanged.status, 200, JSON.stringify(avatarChanged.payload))
    assert.deepEqual(avatarChanged.payload.data.generations.map(({ action }) => action), ['up-to-date', 'up-to-date', 'up-to-date', 'up-to-date', 'up-to-date'])
    assert.equal(providerCalls.length, 15)
    state = await getPlan(planId)

    // 9. A corrupted stored artifact never poisons the plan: the compile fails
    //    closed and only the affected block regenerates.
    const corruptTargetBlock = state.plan.version.blockSequence[0]
    const corruptGeneration = effectiveByBlock(state).get(corruptTargetBlock)
    const corruptRow = await client.v2MediaArtifact.findUniqueOrThrow({ where: { id: corruptGeneration.audioArtifactId } })
    if (objectStore) {
      await objectStore.client.send(new objectStore.aws.PutObjectCommand({
        Bucket: objectStore.bucket, Key: corruptRow.artifactKey, Body: Buffer.from('corrupted-bytes'),
      }))
    } else {
      await writeFile(join(artifactRoot, ...corruptRow.artifactKey.split('/')), Buffer.from('corrupted-bytes'))
    }
    const failedCompile = await api('POST', planPath(`/${planId}/audio-compilations`), 'bj-compile-corrupt', {
      ...context(state), settings: { gapMs: 200, outputFormat: 'mp3' },
    })
    assert.ok(failedCompile.status >= 400, JSON.stringify(failedCompile.payload))
    assert.equal(providerCalls.length, 15, 'a corrupted artifact must not silently trigger paid work')
    state = await getPlan(planId)
    const regenerateCorrupt = await api('POST', planPath(`/${planId}/blocks/${corruptTargetBlock}/regenerations`), 'bj-regen-corrupt', { ...context(state) })
    assert.equal(regenerateCorrupt.status, 201, JSON.stringify(regenerateCorrupt.payload))
    state = await waitForGenerations(planId, allApproved, 'regenerated corrupted block')
    assert.equal(providerCalls.length, 16)

    // 10. Compile: deterministic concatenation plus one consolidated master.
    const compiled = await api('POST', planPath(`/${planId}/audio-compilations`), 'bj-compile', {
      ...context(state), settings: { gapMs: 200, outputFormat: 'mp3' },
    })
    assert.equal(compiled.status, 201, JSON.stringify(compiled.payload))
    const concatenation = compiled.payload.data.concatenation
    assert.equal(concatenation.entries.length, 5)
    assert.equal(concatenation.audioMasterId, compiled.payload.data.audioMasterId)
    let cursor = 0
    for (const entry of concatenation.entries) {
      assert.equal(entry.outputInMs, cursor)
      cursor = entry.outputOutMs + entry.gapAfterMs
    }
    assert.equal(concatenation.durationMs, cursor)
    // Replay is idempotent.
    const replayedCompile = await api('POST', planPath(`/${planId}/audio-compilations`), 'bj-compile', {
      ...context(state), settings: { gapMs: 200, outputFormat: 'mp3' },
    })
    assert.equal(replayedCompile.status, 200, JSON.stringify(replayedCompile.payload))
    assert.equal(replayedCompile.payload.data.replayed, true)
    assert.equal(replayedCompile.payload.data.concatenation.finalAudioSha256, concatenation.finalAudioSha256)

    // The consolidated master is readable through /v1 with the shifted words.
    const master = await api('GET', `/v1/projects/${projectId}/synthetic-audio-masters/${concatenation.audioMasterId}`)
    assert.equal(master.status, 200, JSON.stringify(master.payload))
    assert.equal(master.payload.data.audioMaster.source.kind, 'concatenated')
    assert.equal(master.payload.data.audioMaster.audio.durationMs, concatenation.durationMs)
    assert.ok(master.payload.data.audioMaster.words.length >= 18)
    assert.ok(master.payload.data.audioMaster.words.at(-1).endMs <= concatenation.durationMs)

    // ffprobe evidence over the real stored consolidated audio bytes.
    const consolidatedRow = await client.v2MediaArtifact.findUniqueOrThrow({ where: { id: concatenation.audioArtifactId } })
    let consolidatedPath
    if (objectStore) {
      const object = await objectStore.client.send(new objectStore.aws.GetObjectCommand({ Bucket: objectStore.bucket, Key: consolidatedRow.artifactKey }))
      consolidatedPath = join(root, 'consolidated.mp3')
      await writeFile(consolidatedPath, Buffer.from(await object.Body.transformToByteArray()))
    } else {
      consolidatedPath = join(artifactRoot, ...consolidatedRow.artifactKey.split('/'))
    }
    assert.equal(await calculateFileSha256(consolidatedPath), concatenation.finalAudioSha256)
    const probe = JSON.parse(execFileSync(ffprobePath, ['-v', 'error', '-count_packets', '-show_entries', 'format=duration:stream=codec_name,sample_rate,channels,nb_read_packets', '-of', 'json', consolidatedPath], { encoding: 'utf8', windowsHide: true }))
    assert.equal(probe.streams[0].codec_name, 'mp3')
    assert.equal(Number(probe.streams[0].sample_rate), 44100)
    assert.equal(Number(probe.streams[0].channels), 1)
    assert.ok(Number(probe.streams[0].nb_read_packets) > 0)
    assert.ok(Math.abs(Number(probe.format.duration) * 1_000 - concatenation.durationMs) <= 120)

    // 11. Revoked consent: zero cache hits, zero paid calls, zero generations.
    // Registering the revoked version IS the act of revocation — the actor's
    // latest will — so it happens here, not in the setup.
    const profileV4 = await registerProfile(profileInput(4, 'voice_journey_b', 'avatar_journey_2', 'block-journey-profile-v4', { revokedAt: '2026-01-01T00:00:00.000Z' }))
    state = await getPlan(planId)
    const generationCount = await client.v2SyntheticBlockGeneration.count({ where: { workspaceId } })
    const revokedSwitch = await api('POST', planPath(`/${planId}/presenter-profile`), 'bj-revoked', {
      ...context(state), profileSnapshotId: profileV4.profile.profileSnapshotId,
    })
    assert.ok(revokedSwitch.status >= 400, JSON.stringify(revokedSwitch.payload))
    assert.equal(revokedSwitch.payload.error.code, 'ASSET_RIGHTS_BLOCKED')
    assert.equal(providerCalls.length, 16, 'revoked consent must cause zero paid calls')
    assert.equal(await client.v2SyntheticBlockGeneration.count({ where: { workspaceId } }), generationCount, 'revoked consent must cause zero cache hits or generations')

    // Plan history stays fully readable, command by command.
    const finalState = await getPlan(planId)
    assert.ok(finalState.plan.version.sequence >= 10)
  } finally {
    const stopProcess = async (child) => {
      if (!child || child.exitCode !== null) return
      await new Promise((resolve) => {
        const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 10_000)
        timeout.unref?.()
        child.once('exit', () => { clearTimeout(timeout); resolve() })
        child.kill('SIGTERM')
      })
    }
    await stopProcess(worker)
    await stopProcess(server)
    if (stub) await new Promise((resolve) => stub.close(resolve))
    await cleanup()
    await client.$disconnect()
    if (objectStore) {
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
    await rm(root, { recursive: true, force: true })
    if (process.env.APOLLO_BLOCK_JOURNEY_DEBUG === '1') {
      console.error('server logs tail:', serverLogs.slice(-4000))
      console.error('worker logs tail:', workerLogs.slice(-4000))
    }
  }
})
