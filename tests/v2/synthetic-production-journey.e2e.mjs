import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const ffprobePath = require('ffprobe-static').path

const workspaceId = 'production-journey-workspace'
const foreignWorkspaceId = 'production-journey-foreign'
const clientId = 'production-journey-client'
const foreignClientId = 'production-journey-foreign-client'
const hash = (character) => character.repeat(64)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const at = (second) => new Date(Date.parse('2029-07-01T00:00:00.000Z') + second * 1_000).toISOString()

/** The four sentences the plan is segmented into. Every text is distinct. */
const S1 = 'Primeira ideia do roteiro.'
const S2 = 'Segunda ideia bem forte.'
const S3 = 'Terceira frase de teste.'
const S4 = 'Quarta reflexao calma.'
const SCRIPT = `${S1} ${S2} ${S3} ${S4}`
/** Introduced later, by explicit inserts, never by segmentation. */
const S5 = 'Quinta frase ainda nao julgada.'
const S6 = 'Sexta frase pedida duas vezes.'

/**
 * How long every controlled take is.
 *
 * Ten seconds is not decoration. The media evaluator calls a take dead only
 * when silence covers at least 99% of it (`DEAD_TAKE_RATIO`), and an MP3
 * container is always a little longer than the signal inside it: a two-second
 * silent take measures 2038ms of container against 2000ms of detected silence,
 * which is 98.1% and reads as a silence window rather than a dead take. At ten
 * seconds the same fixed encoder overhead is 10031ms against 10000ms — 99.7%,
 * comfortably past the line. Both numbers were measured with ffmpeg, not
 * assumed.
 */
const TAKE_SECONDS = 10

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

async function waitForServer(baseUrl, server, readLogs) {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Next server exited with ${server.exitCode}\n${readLogs().slice(-4_000)}`)
    }
    try {
      if ((await globalThis.fetch(`${baseUrl}/v1/health`)).ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for Next server\n${readLogs().slice(-4_000)}`)
}

/**
 * F3.007 / F3.008 / F3.009, the half that can be driven end to end today.
 *
 * WHAT THIS JOURNEY CROSSES, for real, with nothing simulated: a Next server in
 * `next dev`, PostgreSQL, a provider worker as a separate OS process that is
 * killed and relaunched mid-journey, the real ElevenLabs adapter talking to a
 * loopback HTTP server, real bytes on disk, real ffprobe, and the real critic
 * adapters (ffprobe media integrity, alignment pronunciation, deterministic
 * controlled probe) measuring those bytes. Paid provider calls: zero.
 *
 * WHAT IT DELIBERATELY DOES NOT CROSS, and why — each of these is covered by
 * `tests/v2/synthetic-master-reuse.e2e.mjs`, which reaches them by seeding an
 * approved avatar job as a database fixture instead of generating one:
 *
 *  - Master promotion (`POST /v1/projects/{id}/synthetic-masters`), master
 *    lineage, speech-segment cataloguing, cross-project reuse and promotion
 *    replay. A master requires a `provider-original` artifact, which only an
 *    `audio-avatar` job produces (`SYNTHETIC_MASTER_REQUIRED_ARTIFACT_ROLES`);
 *    a TTS job's ledger only ever carries `primary-audio` and
 *    `alignment-evidence`.
 *  - Generating that avatar job here. The only registered avatar adapter is
 *    HeyGen, which pins `https:` for its base URL and is given no base-URL
 *    override by `createProviderJobWorker`; its result is then fetched by
 *    `SafeProviderResultDownloader`, which pins `https:`, port 443, real DNS
 *    and `validateWebhookResolution` — 127.0.0.1 is refused by construction.
 *    Pointing that leg at a loopback server would mean weakening the product's
 *    SSRF defence to make a test pass, so this journey does not go there.
 *  - Compiling and ffprobing an MP4. No `/v1` route compiles a synthetic MP4;
 *    the only synthetic compilation route is audio (`audio-compilations`).
 *  - The master half of the "missing critic evidence" gate. Proving that a
 *    non-approving report also blocks promotion needs the avatar job above.
 *    The cache half of that gate IS proven here.
 *
 * One thing is driven through the application service rather than HTTP, and it
 * is named for what it is: the critic itself. `evaluateSyntheticCriticService`
 * has no write route and is called by no worker — the `synthetic-critic-reports`
 * and `synthetic-cache-decisions` routes are read-only. The service is therefore
 * invoked directly, but with the production adapters over the very bytes the
 * loopback provider delivered and the worker stored; nothing about the
 * measurement is stubbed, and every verdict is read back through `/v1`.
 */
test('T-FR-104/105/106 synthetic TTS production, criticism and cache reuse run end to end through /v1, durable workers and real bytes — master promotion and MP4 compilation excluded, see header', {
  skip: !process.env.V2_DATABASE_URL && 'V2_DATABASE_URL is required',
  timeout: 1_800_000,
}, async () => {
  const client = new PrismaClient({ datasources: { db: { url: process.env.V2_DATABASE_URL } } })
  const root = await mkdtemp(join(tmpdir(), 'apollo-production-journey-'))
  const artifactRoot = join(root, 'artifacts')
  const workRoot = join(root, 'work')
  let stub = null
  let server = null
  let worker = null
  let serverLogs = ''
  let workerLogs = ''

  const cleanupWorkspace = async (id) => {
    await client.v2SyntheticCriticIssue.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticCriticMeasurement.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticCriticEvaluator.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticCriticReport.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticScriptPlan.updateMany({ where: { workspaceId: id }, data: { currentVersionId: null } })
    await client.v2SyntheticCacheSubmissionClaim.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticCacheDecision.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticBlockConcatenation.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticBlockGeneration.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticScriptBlock.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticScriptPlanVersion.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticScriptPlan.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticSpeechSegment.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticAudioMaster.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticMasterArtifact.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticMasterAsset.deleteMany({ where: { workspaceId: id } })
    await client.v2ProviderResultArtifact.deleteMany({ where: { workspaceId: id } })
    await client.v2ProviderJobTransition.deleteMany({ where: { workspaceId: id } })
    await client.v2ProviderJob.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticPresenterProfileHead.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticPresenterProfile.deleteMany({ where: { workspaceId: id } })
    await client.v2MediaArtifact.updateMany({
      where: { workspaceId: id },
      data: { currentRightsSnapshotId: null, rightsRevision: 0 },
    })
    await client.v2AssetRightsChange.deleteMany({ where: { workspaceId: id } })
    await client.v2AssetRightsSnapshot.deleteMany({ where: { workspaceId: id } })
    await client.v2MediaArtifactLineage.deleteMany({ where: { workspaceId: id } })
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

  /** Every number this journey claims, printed at the end and asserted above. */
  const measured = {}

  /** Owner of every child process: nothing outlives this test, ever. */
  const stopProcess = async (child) => {
    if (!child || child.exitCode !== null) return
    await new Promise((resolve) => {
      const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 10_000)
      timeout.unref?.()
      child.once('exit', () => { clearTimeout(timeout); resolve() })
      child.kill('SIGTERM')
    })
  }

  try {
    await cleanup()

    const { createProjectService } = await import('../../src/v2/application/create-project.ts')
    const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
    const { createExternalAuditContext } = await import('../../src/v2/application/authenticate-api-client.ts')
    const { registerSyntheticPresenterProfileService } = await import('../../src/v2/application/synthetic-production.ts')
    const { setAssetRightsService } = await import('../../src/v2/application/set-asset-rights.ts')
    const { assetRightsRevision } = await import('../../src/v2/domain/asset-rights.ts')
    const { evaluateSyntheticCriticService } = await import('../../src/v2/application/synthetic-critic.ts')
    const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
    const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
    const { PrismaWorkspaceRepository } = await import('../../src/v2/infrastructure/prisma/workspace-repository.ts')
    const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
    const { PrismaAssetRightsRepository } = await import('../../src/v2/infrastructure/prisma/asset-rights-repository.ts')
    const { PrismaMediaArtifactRepository } = await import('../../src/v2/infrastructure/prisma/media-artifact-repository.ts')
    const { PrismaProjectCreationRepository } = await import('../../src/v2/infrastructure/prisma/project-creation-repository.ts')
    const { PrismaProviderJobRepository } = await import('../../src/v2/infrastructure/prisma/provider-job-repository.ts')
    const { PrismaSyntheticProductionRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-production-repository.ts')
    const { PrismaSyntheticCriticReportRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-critic-report-repository.ts')
    const { LocalArtifactSourceMaterializer } = await import('../../src/v2/infrastructure/media/local-media-upload-storage.ts')
    const { LocalArtifactContentStorage } = await import('../../src/v2/infrastructure/media/local-artifact-content-storage.ts')
    const { StoredSyntheticMasterAlignmentReader } = await import('../../src/v2/infrastructure/media/synthetic-master-alignment-reader.ts')
    const { FfprobeSyntheticCriticMediaEvaluator } = await import('../../src/v2/infrastructure/media/synthetic-critic-media-integrity.ts')
    const { AlignmentSyntheticCriticPronunciationEvaluator } = await import('../../src/v2/infrastructure/media/synthetic-critic-pronunciation.ts')
    const { DeterministicSyntheticCriticControlledEvaluator } = await import('../../src/v2/infrastructure/media/synthetic-critic-controlled-probe.ts')

    // -----------------------------------------------------------------------
    // 0. The controlled provider boundary: a real loopback HTTP server that the
    //    REAL ElevenLabs adapter, running inside the worker process, calls.
    //    Every take is genuinely synthesized here with ffmpeg, so the critic
    //    downstream measures bytes, never a flag.
    // -----------------------------------------------------------------------
    const cleanFixture = join(root, 'take-clean.mp3')
    execFileSync(ffmpegPath, [
      '-v', 'error', '-y', '-f', 'lavfi',
      '-i', `sine=frequency=230:sample_rate=44100:duration=${TAKE_SECONDS}`,
      '-c:a', 'libmp3lame', '-b:a', '128k', cleanFixture,
    ], { windowsHide: true })
    const silentFixture = join(root, 'take-silent.mp3')
    execFileSync(ffmpegPath, [
      '-v', 'error', '-y', '-f', 'lavfi',
      '-i', 'anullsrc=r=44100:cl=mono', '-t', String(TAKE_SECONDS),
      '-c:a', 'libmp3lame', '-b:a', '128k', silentFixture,
    ], { windowsHide: true })
    const probeDurationMs = (path) => {
      const probe = JSON.parse(execFileSync(ffprobePath, [
        '-v', 'error', '-show_entries', 'format=duration:stream=codec_name,sample_rate,channels',
        '-of', 'json', path,
      ], { encoding: 'utf8', windowsHide: true }))
      return { ms: Math.round(Number(probe.format.duration) * 1_000), stream: probe.streams[0] }
    }
    const cleanProbe = probeDurationMs(cleanFixture)
    const silentProbe = probeDurationMs(silentFixture)
    // The approval every take is judged against. It is measured once, from the
    // controlled provider's own recipe, before a single block exists — so it is
    // knowledge the pipeline holds up front, not a reading taken off the take
    // under judgment. The dead take is built to the very same length, so the
    // rejection below can only be about signal, never about duration.
    const EXPECTED_DURATION_MS = cleanProbe.ms
    assert.equal(silentProbe.ms, EXPECTED_DURATION_MS, 'the dead take must be exactly as long as a healthy one')
    assert.equal(cleanProbe.stream.codec_name, 'mp3')
    assert.equal(Number(cleanProbe.stream.sample_rate), 44_100)
    assert.equal(Number(cleanProbe.stream.channels), 1)
    measured.expectedTakeDurationMs = EXPECTED_DURATION_MS

    const silentBytes = await readFile(silentFixture)
    const audioByCall = new Map()
    const cleanBytesFor = async (key) => {
      if (!audioByCall.has(key)) {
        const index = audioByCall.size
        const path = join(root, `take-clean-${index}.mp3`)
        // A different frequency per call, so no two paid takes are ever the
        // same bytes and a reuse can never be mistaken for a fresh generation.
        execFileSync(ffmpegPath, [
          '-v', 'error', '-y', '-f', 'lavfi',
          '-i', `sine=frequency=${230 + index * 29}:sample_rate=44100:duration=${TAKE_SECONDS}`,
          '-c:a', 'libmp3lame', '-b:a', '128k', path,
        ], { windowsHide: true })
        audioByCall.set(key, await readFile(path))
      }
      return audioByCall.get(key)
    }

    /** Every text the loopback provider was asked to synthesize, in order. */
    const providerCalls = []
    /**
     * Texts whose NEXT delivery comes back as a dead take. This models a flaky
     * provider, not a flaky test: the same request yields silence once and
     * healthy speech afterwards, which is exactly what a retry has to fix.
     */
    const silentOnce = new Set()
    let requestSequence = 0
    stub = http.createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => { body += chunk })
      request.on('end', async () => {
        try {
          const payload = JSON.parse(body)
          const text = String(payload.text)
          providerCalls.push(text)
          requestSequence += 1
          const dead = silentOnce.delete(text)
          const bytes = dead ? silentBytes : await cleanBytesFor(`call-${requestSequence}`)
          const characters = [...text]
          // The alignment spans the take: ingestion refuses an alignment that
          // does not cover the audio it claims to time.
          const step = TAKE_SECONDS / characters.length
          response.writeHead(200, { 'content-type': 'application/json', 'request-id': `pj_req_${requestSequence}` })
          response.end(JSON.stringify({
            audio_base64: bytes.toString('base64'),
            // The alignment always spells the approved text, dead take included:
            // the take below is rejected on signal alone, with pronunciation
            // measuring zero deviations.
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

    // -----------------------------------------------------------------------
    // 1. Workspace, API client, project and an active presenter with valid
    //    consent. Registration runs through the application service before the
    //    server boots, exactly as the two reference journeys do.
    // -----------------------------------------------------------------------
    const workspaces = new PrismaWorkspaceRepository(client)
    await workspaces.create(createWorkspace({ id: workspaceId, slug: workspaceId, name: 'Production journey', status: 'active', createdAt: at(0) }))
    await workspaces.create(createWorkspace({ id: foreignWorkspaceId, slug: foreignWorkspaceId, name: 'Foreign workspace', status: 'active', createdAt: at(0) }))

    const issueClient = createApiClientService({
      repository: new PrismaApiClientRepository(client), credentialCrypto: nodeApiCredentialCrypto, clock: () => new Date(at(0)),
    })
    const issued = await issueClient({
      id: clientId, workspaceId, name: 'Production journey client', environment: 'production',
      scopes: ['projects:read', 'projects:write'],
    })
    const foreignIssued = await issueClient({
      id: foreignClientId, workspaceId: foreignWorkspaceId, name: 'Foreign client', environment: 'production',
      scopes: ['projects:read', 'projects:write'],
    })
    const auditContext = createExternalAuditContext({
      clientId, credentialId: issued.credential.id, workspaceId, environment: 'production',
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
      createId: (kind) => `${kind}-production-journey-${++entity}`,
      createEventId: () => `00000000-0000-4000-8000-${String(820_000 + ++event).padStart(12, '0')}`,
    })({
      workspaceId, name: 'Jornada de producao', objective: 'awareness', format: '9:16', actor,
      idempotency: { clientId, key: 'production-journey-project' },
    })
    const projectId = project.project.id
    const projectVersionId = project.version.id

    await client.v2MediaArtifact.create({
      data: {
        id: 'production-journey-consent', workspaceId, artifactKey: 'production-journey/consent.json',
        sha256: hash('a'), byteSize: 512n, mediaType: 'data', container: 'json', status: 'available', createdAt: new Date(at(0)),
      },
    })
    const registerProfile = registerSyntheticPresenterProfileService({
      repository: new PrismaSyntheticProductionRepository(client),
      artifacts: new PrismaMediaArtifactRepository(client),
      clock: () => new Date(at(0)),
    })
    const profileInput = (version, voiceId, avatarRef, key, extra = {}) => ({
      workspaceId, profileId: 'production-journey-presenter', version, actorIdentityId: 'production-journey-identity',
      avatar: { adapterId: 'heygen-v3', adapterVersion: '3.0.0', identityRef: avatarRef },
      voice: { id: voiceId, version: 1, adapterId: 'elevenlabs-tts', adapterVersion: '1.0.0' },
      defaultLocale: 'pt-BR', status: 'active', disclosure: 'Conteúdo gerado com IA',
      consent: {
        id: `production-journey-consent-v${version}`, evidenceArtifactId: 'production-journey-consent', granted: true,
        allowedUses: ['ads'], allowedMarkets: ['BRA'], allowedLocales: ['pt-BR'],
        allowedOperations: ['tts', 'audio-avatar'], expiresAt: '2030-01-01T00:00:00.000Z',
        ...extra,
      },
      actor, idempotencyKey: key,
    })
    const profileV1 = await registerProfile(profileInput(1, 'voice_pj_a', 'avatar_pj_1', 'production-journey-profile-v1'))
    const profileV2 = await registerProfile(profileInput(2, 'voice_pj_b', 'avatar_pj_1', 'production-journey-profile-v2'))
    const profileV3 = await registerProfile(profileInput(3, 'voice_pj_b', 'avatar_pj_2', 'production-journey-profile-v3'))

    const port = await freePort()
    const baseUrl = `http://127.0.0.1:${port}`
    const runtimeEnv = {
      ...process.env,
      NODE_ENV: 'development',
      __NEXT_PROCESSED_ENV: 'true',
      APOLLO_API_ENVIRONMENT: 'production',
      APOLLO_GOVERNANCE_ANOMALY_REQUEST_MINIMUM: '400',
      APOLLO_V2_PERSISTENCE: 'postgres',
      // Local storage is deliberate, not incidental: the tamper phase rewrites
      // stored bytes and the critic reads them back off disk with ffprobe.
      APOLLO_V2_ARTIFACT_STORAGE_DRIVER: 'local',
      APOLLO_V2_ARTIFACT_ROOT: artifactRoot,
      APOLLO_V2_RENDER_WORK_ROOT: workRoot,
      APOLLO_V2_PROVIDER_WORK_ROOT: join(workRoot, 'provider'),
      APOLLO_PROTECTED_PAYLOAD_KEY_ID: 'production-journey-protected-payload',
      APOLLO_PROTECTED_PAYLOAD_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      FFMPEG_PATH: ffmpegPath,
      FFPROBE_PATH: ffprobePath,
      APOLLO_V2_ELEVENLABS_API_KEY: 'production-journey-stub-secret',
      APOLLO_V2_ELEVENLABS_BASE_URL: `http://127.0.0.1:${stubPort}`,
      // High enough that a short sentence still carries a non-zero persisted
      // estimate: a cache hit refuses to book a saving it cannot price.
      APOLLO_V2_ELEVENLABS_COST_MINOR_UNITS_PER_THOUSAND_CHARACTERS: '5000',
      APOLLO_V2_PROVIDER_POLL_MS: '200',
    }
    server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--webpack', '-p', String(port)], {
      cwd: process.cwd(), env: runtimeEnv, stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.stdout.on('data', (chunk) => { serverLogs += String(chunk) })
    server.stderr.on('data', (chunk) => { serverLogs += String(chunk) })
    await waitForServer(baseUrl, server, () => serverLogs)

    const startWorker = () => {
      const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/run-v2-provider-worker.mjs'], {
        cwd: process.cwd(), env: runtimeEnv, stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout.on('data', (chunk) => { workerLogs += String(chunk) })
      child.stderr.on('data', (chunk) => { workerLogs += String(chunk) })
      return child
    }
    worker = startWorker()

    const api = async (method, path, options = {}) => {
      const token = options.token ?? issued.token
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
      if (options.key) headers['idempotency-key'] = options.key
      // A 404 with a null body is the dev server still lazily compiling the
      // route (a real 404 carries the {error} envelope). Replaying is safe:
      // every mutation here carries an idempotency key.
      const deadline = Date.now() + 30_000
      for (;;) {
        const response = await globalThis.fetch(`${baseUrl}${path}`, {
          method, headers,
          ...(options.payload === undefined ? {} : { body: JSON.stringify(options.payload) }),
        })
        const payload = await response.json().catch(() => null)
        if (response.status === 404 && payload === null && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 500))
          continue
        }
        return { status: response.status, payload }
      }
    }

    const planPath = (suffix = '') => `/v1/projects/${projectId}/synthetic-script-plans${suffix}`
    const getPlan = async (planId) => {
      const read = await api('GET', planPath(`/${planId}`))
      assert.equal(read.status, 200, JSON.stringify(read.payload))
      return read.payload.data
    }
    const effectiveByBlock = (data) => {
      const byBlock = new Map()
      for (const generation of data.generations) {
        const current = byBlock.get(generation.blockId)
        if (!current || generation.attempt > current.attempt) byBlock.set(generation.blockId, generation)
      }
      return byBlock
    }
    const allApproved = (data) =>
      data.plan.version.blockSequence.every((blockId) => effectiveByBlock(data).get(blockId)?.status === 'approved')
    const waitForGenerations = async (planId, predicate, label) => {
      const deadline = Date.now() + 240_000
      for (;;) {
        if (worker.exitCode !== null) {
          throw new Error(`provider worker exited with ${worker.exitCode} while waiting for ${label}\n${workerLogs.slice(-3_000)}`)
        }
        const data = await getPlan(planId)
        if (predicate(data)) return data
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${label}: ${JSON.stringify(data.generations.map(({ blockId, status }) => ({ blockId, status })))}\n${workerLogs.slice(-2_000)}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
    /**
     * Clears the rights on every take the worker has just stored.
     *
     * This is a real step of the real pipeline, not a convenience: reuse is
     * refused for an artifact that is not cleared for the use and market being
     * asked for, and without this the cache would answer every duplicate with
     * CANDIDATE_RIGHTS_BLOCKED. Doing it right after each settle is what an
     * operator approving their own takes does.
     */
    let rightsSequence = 0
    const setRights = setAssetRightsService({
      repository: new PrismaAssetRightsRepository(client),
      clock: () => new Date(at(50)),
      createId: () => `production-journey-rights-${++rightsSequence}`,
    })
    const clearProducedTakes = async () => {
      const pending = await client.v2MediaArtifact.findMany({
        where: { workspaceId, mediaType: 'audio', currentRightsSnapshotId: null },
      })
      for (const row of pending) {
        await setRights({
          workspaceId, artifactId: row.id, baseRevision: assetRightsRevision(row.id, 0),
          draft: {
            status: 'approved', allowedUses: ['ads'], prohibitedUses: [],
            allowedMarkets: ['BRA'], allowedLocales: ['pt-BR'],
            allowedSyntheticOperations: ['tts'],
            consent: { status: 'not-required', allowedUses: [] },
          },
          actor: { type: 'api-client', id: clientId },
        })
      }
      return pending.length
    }
    /** Wait for the worker to settle the plan, then clear what it produced. */
    const settle = async (predicate, label) => {
      const settled = await waitForGenerations(planId, predicate, label)
      await clearProducedTakes()
      return settled
    }

    const context = (data) => ({
      projectVersionId,
      baseVersionId: data.plan.version.id,
      baseHash: data.plan.version.planVersionHash,
      use: 'ads',
      market: 'BRA',
    })

    const blockRows = async () =>
      new Map((await client.v2SyntheticScriptBlock.findMany({ where: { workspaceId } }))
        .map((row) => [row.id, row]))
    const decisionsForKey = async (cacheKey) =>
      await client.v2SyntheticCacheDecision.findMany({ where: { workspaceId, cacheKey }, orderBy: { decidedAt: 'asc' } })
    const counts = async () => Object.freeze({
      providerCalls: providerCalls.length,
      providerJobs: await client.v2ProviderJob.count({ where: { workspaceId } }),
      generations: await client.v2SyntheticBlockGeneration.count({ where: { workspaceId } }),
      cacheDecisions: await client.v2SyntheticCacheDecision.count({ where: { workspaceId } }),
      criticReports: await client.v2SyntheticCriticReport.count({ where: { workspaceId } }),
      blocks: await client.v2SyntheticScriptBlock.count({ where: { workspaceId } }),
    })

    // -----------------------------------------------------------------------
    // 2. The plan: four complete sentences, four paid calls, all approved by
    //    the real worker.
    // -----------------------------------------------------------------------
    // The third sentence comes back dead on its first delivery. Dealing it here
    // rather than by forcing a regeneration later matters: a block carries a
    // budget of three attempts, and this take needs all three — the bad one,
    // the retry that fixes it, and the voice change further down.
    silentOnce.add(S3)

    const created = await api('POST', planPath(), {
      key: 'pj-create',
      payload: {
        projectVersionId,
        profileSnapshotId: profileV1.profile.profileSnapshotId,
        locale: 'pt-BR',
        scriptText: SCRIPT,
        use: 'ads', market: 'BRA',
      },
    })
    assert.equal(created.status, 201, JSON.stringify(created.payload))
    const planId = created.payload.data.plan.head.id
    assert.equal(created.payload.data.plan.blocks.length, 4, 'the plan must segment into four complete sentences')
    assert.deepEqual(
      created.payload.data.generations.map(({ action }) => action),
      ['enqueued', 'enqueued', 'enqueued', 'enqueued'],
    )
    let state = await settle(allApproved, 'the four initial blocks')
    assert.equal(providerCalls.length, 4)
    assert.deepEqual([...providerCalls].sort(), [S1, S2, S3, S4].sort(), 'the provider was asked for exactly the four sentences')
    measured.afterPlan = await counts()
    assert.deepEqual(measured.afterPlan, {
      providerCalls: 4, providerJobs: 4, generations: 4, cacheDecisions: 4, criticReports: 0, blocks: 4,
    })
    // Four first-time addresses: every one of them a priced miss with no candidate.
    const openingDecisions = await client.v2SyntheticCacheDecision.findMany({ where: { workspaceId } })
    assert.deepEqual(openingDecisions.map(({ outcome }) => outcome).sort(), ['miss', 'miss', 'miss', 'miss'])
    assert.deepEqual([...new Set(openingDecisions.map(({ reasonCode }) => reasonCode))], ['CACHE_MISS_NO_CANDIDATE'])

    // -----------------------------------------------------------------------
    // 3. The provider worker is a real OS process. Killing and relaunching it
    //    between stages must change nothing but the PID.
    // -----------------------------------------------------------------------
    const firstWorkerPid = worker.pid
    await stopProcess(worker)
    worker = startWorker()
    assert.notEqual(worker.pid, firstWorkerPid, 'the relaunched worker must be a different process')
    measured.workerPids = { first: firstWorkerPid, second: worker.pid }
    state = await settle(allApproved, 'the plan after the worker restart')
    assert.equal(providerCalls.length, 4, 'a worker restart must not re-pay for settled work')

    // -----------------------------------------------------------------------
    // 4. The critic, with the production adapters, over the bytes the worker
    //    stored. `evaluateSyntheticCriticService` has no write route, so it is
    //    driven directly — but every instrument and every byte is real.
    // -----------------------------------------------------------------------
    const criticReports = new PrismaSyntheticCriticReportRepository(client)
    const artifactRepository = new PrismaMediaArtifactRepository(client)
    const criticEnvironment = { ...process.env, FFMPEG_PATH: ffmpegPath, FFPROBE_PATH: ffprobePath }
    let criticTick = 100
    const evaluateCritic = evaluateSyntheticCriticService({
      reports: criticReports,
      media: new FfprobeSyntheticCriticMediaEvaluator({
        sources: new LocalArtifactSourceMaterializer(artifactRoot),
        environment: criticEnvironment,
      }),
      pronunciation: new AlignmentSyntheticCriticPronunciationEvaluator({
        alignment: new StoredSyntheticMasterAlignmentReader({
          artifacts: artifactRepository,
          storage: new LocalArtifactContentStorage(artifactRoot),
        }),
      }),
      controlled: new DeterministicSyntheticCriticControlledEvaluator(),
      clock: () => new Date(at(criticTick += 1)),
      createId: ({ blockId, artifactId }) => `pj-critic-${sha256(`${blockId}:${artifactId}`).slice(0, 40)}`,
    })
    const judge = async (blockId, { identityRef, withAlignment = true }) => {
      const plan = await getPlan(planId)
      const generation = effectiveByBlock(plan).get(blockId)
      assert.ok(generation?.audioArtifactId, `block ${blockId} must carry stored audio to judge`)
      const blocks = await blockRows()
      const block = blocks.get(blockId)
      const audioRow = await client.v2MediaArtifact.findUniqueOrThrow({ where: { id: generation.audioArtifactId } })
      return await evaluateCritic({
        subject: {
          workspaceId, projectId, blockId,
          capability: 'tts', adapterId: 'elevenlabs-tts', adapterVersion: '1.0.0', modelRef: null,
          video: null,
          audio: {
            artifactId: audioRow.id, artifactKey: audioRow.artifactKey,
            sha256: audioRow.sha256, byteSize: Number(audioRow.byteSize),
          },
          alignmentArtifactId: withAlignment ? generation.alignmentArtifactId : null,
          scriptText: block.exactText,
          expected: {
            durationMs: EXPECTED_DURATION_MS,
            fps: null, videoCodec: null,
            audioCodec: 'mp3', audioSampleRateHz: 44_100,
            identityRef, declaredIdentityRef: null,
            rights: { withinGrantedScope: true, reason: null },
            previousBlock: null,
          },
        },
        profileSnapshotId: profileV1.profile.profileSnapshotId,
        scriptHash: sha256(block.exactText),
        actor,
      })
    }

    const blocksByText = async () => {
      const rows = await blockRows()
      const byText = new Map()
      const sequence = (await getPlan(planId)).plan.version.blockSequence
      for (const blockId of sequence) {
        const row = rows.get(blockId)
        if (row && !byText.has(row.exactText)) byText.set(row.exactText, blockId)
      }
      return byText
    }

    let planState = await getPlan(planId)
    const s3BlockId = (await blocksByText()).get(S3)
    assert.equal(silentOnce.size, 0, 'the dead take was actually delivered')

    const verdicts = new Map()
    for (const [text, blockId] of await blocksByText()) {
      const result = await judge(blockId, { identityRef: 'avatar_pj_1' })
      assert.equal(result.replayed, false)
      verdicts.set(text, result.report)
    }
    measured.firstCriticSweep = Object.fromEntries([...verdicts].map(([text, report]) => [text, report.decision]))

    // The dead take is rejected on a number nobody chose: live-signal is zero
    // because the bytes are silent, and the pipeline is told to retry.
    const rejected = verdicts.get(S3)
    assert.equal(rejected.decision, 'rejected')
    assert.equal(rejected.recommendedAction, 'retry')
    assert.equal(rejected.thresholdsVersion, 'synthetic-critic-thresholds/tts/v1')
    const live = rejected.measurements.find(({ dimension }) => dimension === 'audiovisual-integrity')
    assert.equal(live.status, 'measured')
    assert.equal(live.value, 0, 'the dead take carries no live signal')
    assert.equal(live.unit, 'live-signal')
    assert.equal(live.threshold, 1)
    const drift = rejected.measurements.find(({ dimension }) => dimension === 'temporal-integrity')
    assert.equal(drift.status, 'measured')
    assert.ok(drift.value <= 34, `the dead take must be rejected on signal, not on a ${drift.value}ms duration drift`)
    const spoken = rejected.measurements.find(({ dimension }) => dimension === 'pronunciation')
    assert.equal(spoken.status, 'measured')
    assert.equal(spoken.value, 0, 'the dead take said every approved word; only the signal is missing')

    // The persisted issue points at the block, at the stretch of the timeline
    // it was measured on, and at what to do about it.
    assert.equal(rejected.issues.length, 1, JSON.stringify(rejected.issues))
    const issue = rejected.issues[0]
    assert.equal(issue.blockId, s3BlockId)
    assert.equal(issue.dimension, 'audiovisual-integrity')
    assert.equal(issue.action, 'retry')
    assert.ok(issue.range, 'a measurable defect must say where it is')
    assert.equal(issue.range.startMs, 0)
    assert.equal(issue.range.endMs, EXPECTED_DURATION_MS)
    assert.ok(issue.evidence.startsWith('audio-silent:'), issue.evidence)
    for (const text of [S1, S2, S4]) {
      assert.equal(verdicts.get(text).decision, 'approved', `${text} must be approved`)
      assert.equal(verdicts.get(text).issues.length, 0)
    }

    // The verdict is a document, readable through /v1 by block and by id.
    const evidenceRead = await api('GET', `/v1/projects/${projectId}/synthetic-blocks/${s3BlockId}/critic-evidence`)
    assert.equal(evidenceRead.status, 200, JSON.stringify(evidenceRead.payload))
    assert.equal(evidenceRead.payload.data.report.reportHash, rejected.reportHash)
    assert.equal(evidenceRead.payload.data.report.decision, 'rejected')
    const rejectedList = await api('GET', `/v1/projects/${projectId}/synthetic-critic-reports?decision=rejected&limit=20`)
    assert.equal(rejectedList.status, 200, JSON.stringify(rejectedList.payload))
    assert.deepEqual(rejectedList.payload.data.reports.map(({ reportHash }) => reportHash), [rejected.reportHash])

    measured.afterFirstCritic = await counts()
    assert.deepEqual(measured.afterFirstCritic, {
      providerCalls: 4, providerJobs: 4, generations: 4, cacheDecisions: 4, criticReports: 4, blocks: 4,
    })

    // -----------------------------------------------------------------------
    // 5. Retry exactly the rejected block. The forced regeneration is a
    //    spending decision, so it is audited in the operator's own words, and
    //    nothing else in the plan is touched.
    // -----------------------------------------------------------------------
    const generationsBeforeRetry = new Map(
      [...effectiveByBlock(await getPlan(planId))].map(([blockId, generation]) => [blockId, generation.id]),
    )
    planState = await getPlan(planId)
    const retryReason = 'the critic rejected this take for a dead audio signal, so the provider is asked again'
    const retried = await api('POST', planPath(`/${planId}/blocks/${s3BlockId}/regenerations`), {
      key: 'pj-retry-rejected',
      payload: { ...context(planState), reason: retryReason },
    })
    assert.equal(retried.status, 201, JSON.stringify(retried.payload))
    assert.deepEqual(
      retried.payload.data.generations.filter(({ action }) => action === 'enqueued').map(({ blockId }) => blockId),
      [s3BlockId],
      'only the rejected block may be regenerated',
    )
    state = await settle(allApproved, 'the retried block')
    assert.equal(providerCalls.length, 5, 'the retry costs exactly one call')
    assert.equal(providerCalls.at(-1), S3)

    const generationsAfterRetry = new Map(
      [...effectiveByBlock(await getPlan(planId))].map(([blockId, generation]) => [blockId, generation.id]),
    )
    for (const [blockId, generationId] of generationsBeforeRetry) {
      if (blockId === s3BlockId) {
        assert.notEqual(generationsAfterRetry.get(blockId), generationId, 'the retried block must carry a new generation')
      } else {
        assert.equal(generationsAfterRetry.get(blockId), generationId, `${blockId} must not have been touched by the retry`)
      }
    }

    // The ledger says who authorized paying again, and why.
    const forcedRows = await client.v2SyntheticCacheDecision.findMany({
      where: { workspaceId, outcome: 'forced-regenerate' }, orderBy: { decidedAt: 'asc' },
    })
    assert.equal(forcedRows.length, 1, 'the retry is the only forced regeneration so far')
    const retryRow = forcedRows[0]
    assert.equal(retryRow.reasonCode, 'MUST_REGENERATE')
    assert.ok(retryRow.reason.includes(clientId), retryRow.reason)
    assert.ok(retryRow.reason.includes(retryReason), retryRow.reason)

    // The new bytes are judged on their own: a fresh artifact is a fresh
    // question, and this time the answer is approval.
    const healed = await judge(s3BlockId, { identityRef: 'avatar_pj_1' })
    assert.equal(healed.replayed, false)
    assert.equal(healed.report.decision, 'approved')
    assert.equal(healed.report.issues.length, 0)
    assert.notEqual(healed.report.artifactId, rejected.artifactId, 'the retry judged different bytes')

    // Every block of the plan now stands approved, by the worker and by the critic.
    const approvedReports = await api('GET', `/v1/projects/${projectId}/synthetic-critic-reports?decision=approved&limit=20`)
    assert.equal(approvedReports.status, 200, JSON.stringify(approvedReports.payload))
    assert.equal(approvedReports.payload.data.reports.length, 4)
    measured.afterRetry = await counts()
    assert.deepEqual(measured.afterRetry, {
      providerCalls: 5, providerJobs: 5, generations: 5, cacheDecisions: 5, criticReports: 5, blocks: 4,
    })

    // -----------------------------------------------------------------------
    // 6. A config change that matters: a different voice is a different cache
    //    address, so every block misses and is paid for again.
    // -----------------------------------------------------------------------
    planState = await getPlan(planId)
    const voiceChanged = await api('POST', planPath(`/${planId}/presenter-profile`), {
      key: 'pj-voice-b',
      payload: { ...context(planState), profileSnapshotId: profileV2.profile.profileSnapshotId },
    })
    assert.equal(voiceChanged.status, 200, JSON.stringify(voiceChanged.payload))
    assert.deepEqual(
      voiceChanged.payload.data.generations.map(({ action }) => action),
      ['enqueued', 'enqueued', 'enqueued', 'enqueued'],
      'a new voice regenerates every block',
    )
    state = await settle(allApproved, 'the new voice')
    assert.equal(providerCalls.length, 9, 'four blocks, four new paid calls')
    const missRows = await client.v2SyntheticCacheDecision.findMany({ where: { workspaceId, outcome: 'miss' } })
    assert.equal(missRows.length, 8, 'four opening misses plus four for the new voice')
    assert.deepEqual([...new Set(missRows.map(({ reasonCode }) => reasonCode))], ['CACHE_MISS_NO_CANDIDATE'])
    measured.afterVoiceChange = await counts()
    assert.deepEqual(measured.afterVoiceChange, {
      providerCalls: 9, providerJobs: 9, generations: 9, cacheDecisions: 9, criticReports: 5, blocks: 4,
    })

    // The new takes are judged too, so every reuse below is backed by a written
    // approval of the very bytes it reuses rather than by a job status alone.
    const voiceBVerdicts = new Map()
    for (const [text, blockId] of await blocksByText()) {
      const result = await judge(blockId, { identityRef: 'avatar_pj_1' })
      assert.equal(result.replayed, false)
      assert.equal(result.report.decision, 'approved', `${text} under the new voice must be approved`)
      voiceBVerdicts.set(text, result.report)
    }
    assert.equal(await client.v2SyntheticCriticReport.count({ where: { workspaceId } }), 9)

    // -----------------------------------------------------------------------
    // 7. A config change that does not matter: only the avatar identity moves,
    //    the voice is the same, so not one block is regenerated.
    // -----------------------------------------------------------------------
    planState = await getPlan(planId)
    const avatarChanged = await api('POST', planPath(`/${planId}/presenter-profile`), {
      key: 'pj-avatar-2',
      payload: { ...context(planState), profileSnapshotId: profileV3.profile.profileSnapshotId },
    })
    assert.equal(avatarChanged.status, 200, JSON.stringify(avatarChanged.payload))
    assert.deepEqual(
      avatarChanged.payload.data.generations.map(({ action }) => action),
      ['up-to-date', 'up-to-date', 'up-to-date', 'up-to-date'],
      'a semantically equivalent presenter change is not new work',
    )
    assert.equal(providerCalls.length, 9, 'an equivalent presenter change costs nothing')
    measured.afterEquivalentChange = await counts()
    assert.deepEqual(measured.afterEquivalentChange, {
      providerCalls: 9, providerJobs: 9, generations: 9, cacheDecisions: 9, criticReports: 9, blocks: 4,
    })

    // -----------------------------------------------------------------------
    // 8. An auditable cache hit: a new block that says exactly what an approved
    //    block already said reuses it, and the ledger prices what was avoided
    //    from the paying job's own persisted estimate.
    // -----------------------------------------------------------------------
    const s2BlockId = (await blocksByText()).get(S2)
    const s2Generation = effectiveByBlock(await getPlan(planId)).get(s2BlockId)
    const payingJob = await new PrismaProviderJobRepository(client).read({
      workspaceId, projectId, jobId: s2Generation.providerJobId,
    })
    assert.ok(payingJob?.job.estimate, 'the paying job must carry the estimate a saving is priced from')

    planState = await getPlan(planId)
    const duplicated = await api('POST', planPath(`/${planId}/blocks`), {
      key: 'pj-duplicate-of-s2',
      payload: { ...context(planState), position: 4, text: S2 },
    })
    assert.equal(duplicated.status, 201, JSON.stringify(duplicated.payload))
    assert.deepEqual(
      duplicated.payload.data.generations.filter(({ action }) => action !== 'up-to-date').map(({ action }) => action),
      ['reused'],
      JSON.stringify(duplicated.payload.data.generations),
    )
    assert.equal(providerCalls.length, 9, 'a cache hit costs nothing')

    const hitRows = await client.v2SyntheticCacheDecision.findMany({ where: { workspaceId, outcome: 'hit' } })
    assert.equal(hitRows.length, 1, JSON.stringify(hitRows))
    const hit = hitRows[0]
    assert.equal(hit.reasonCode, 'CACHE_HIT_ELIGIBLE')
    assert.equal(hit.candidateGenerationId, s2Generation.id)
    assert.equal(hit.criticReportHash, voiceBVerdicts.get(S2).reportHash, 'the hit cites the written approval of the reused bytes')
    assert.equal(hit.avoidedCostMinorUnits, payingJob.job.estimate.costMinorUnits)
    assert.equal(hit.estimatedSavingMinorUnits, payingJob.job.estimate.costMinorUnits)
    assert.equal(hit.currency, payingJob.job.estimate.currency)
    assert.ok(hit.avoidedCostMinorUnits > 0, 'a saving that cannot be priced is not booked')
    measured.avoidedCost = { minorUnits: hit.avoidedCostMinorUnits, currency: hit.currency }

    // The same row, read back through the public ledger by its own address.
    const traced = await api('GET', `/v1/workspaces/${workspaceId}/synthetic-cache-decisions?cacheKey=${encodeURIComponent(hit.cacheKey)}&limit=20`)
    assert.equal(traced.status, 200, JSON.stringify(traced.payload))
    assert.equal(traced.payload.data.cacheKey, hit.cacheKey)
    assert.ok(traced.payload.data.decisions.some((decision) => decision.decisionHash === hit.decisionHash))

    measured.afterCacheHit = await counts()
    assert.deepEqual(measured.afterCacheHit, {
      providerCalls: 9, providerJobs: 9, generations: 10, cacheDecisions: 10, criticReports: 9, blocks: 5,
    })

    // -----------------------------------------------------------------------
    // 9. A sentence nobody has judged yet, generated normally. It is the subject
    //    of the missing-evidence gate below.
    // -----------------------------------------------------------------------
    planState = await getPlan(planId)
    const fresh = await api('POST', planPath(`/${planId}/blocks`), {
      key: 'pj-insert-unjudged',
      payload: { ...context(planState), position: 5, text: S5 },
    })
    assert.equal(fresh.status, 201, JSON.stringify(fresh.payload))
    state = await settle(allApproved, 'the unjudged sentence')
    assert.equal(providerCalls.length, 10)
    const s5BlockId = (await blocksByText()).get(S5)

    // -----------------------------------------------------------------------
    // 10. A tampered blob is never reused. The stored bytes are rewritten and
    //     the catalog row is rewritten with them, so the artifact still agrees
    //     with itself — and disagrees with the provider result ledger, which is
    //     the only record that can tell a healthy reuse from a rewritten one.
    // -----------------------------------------------------------------------
    const s1BlockId = (await blocksByText()).get(S1)
    const s1Generation = effectiveByBlock(await getPlan(planId)).get(s1BlockId)
    const tamperedRow = await client.v2MediaArtifact.findUniqueOrThrow({ where: { id: s1Generation.audioArtifactId } })
    const tamperedPath = join(artifactRoot, ...tamperedRow.artifactKey.split('/'))
    const tamperedBytes = Buffer.concat([await readFile(tamperedPath), Buffer.from('tampered')])
    await writeFile(tamperedPath, tamperedBytes)
    await client.v2MediaArtifact.update({
      where: { id: tamperedRow.id },
      data: { sha256: sha256(tamperedBytes), byteSize: BigInt(tamperedBytes.byteLength) },
    })
    assert.notEqual(sha256(tamperedBytes), tamperedRow.sha256, 'the tamper must actually change the content address')

    planState = await getPlan(planId)
    const afterTamperInsert = await api('POST', planPath(`/${planId}/blocks`), {
      key: 'pj-duplicate-of-tampered',
      payload: { ...context(planState), position: 6, text: S1 },
    })
    assert.equal(afterTamperInsert.status, 201, JSON.stringify(afterTamperInsert.payload))
    assert.deepEqual(
      afterTamperInsert.payload.data.generations.filter(({ action }) => action !== 'up-to-date').map(({ action }) => action),
      ['enqueued'],
      'a tampered candidate degrades into a paid miss, never into a silent reuse',
    )
    state = await settle(allApproved, 'the block that could not reuse tampered bytes')
    assert.equal(providerCalls.length, 11)
    const driftRows = await client.v2SyntheticCacheDecision.findMany({
      where: { workspaceId, reasonCode: 'CANDIDATE_CHECKSUM_DRIFT' },
    })
    assert.equal(driftRows.length, 1, JSON.stringify(driftRows))
    assert.equal(driftRows[0].outcome, 'miss')
    assert.equal(driftRows[0].candidateGenerationId, s1Generation.id)
    assert.ok(driftRows[0].reason.includes('CANDIDATE_CHECKSUM_DRIFT'), driftRows[0].reason)
    assert.equal(
      await client.v2SyntheticCacheDecision.count({ where: { workspaceId, outcome: 'hit' } }),
      1,
      'the tampered address produced no hit',
    )
    measured.afterTamper = await counts()

    // -----------------------------------------------------------------------
    // 11. Missing mandatory evidence is not approval. The unjudged sentence is
    //     judged without its alignment: pronunciation cannot be measured, the
    //     verdict is `evidence-unavailable`, and the cache then refuses to reuse
    //     those bytes.
    //
    //     Only the cache half of this gate is proven here. The master half needs
    //     an avatar job this journey cannot generate — see the header.
    // -----------------------------------------------------------------------
    const blind = await judge(s5BlockId, { identityRef: 'avatar_pj_2', withAlignment: false })
    assert.equal(blind.replayed, false)
    assert.equal(blind.report.decision, 'evidence-unavailable')
    assert.equal(blind.report.recommendedAction, 'manual-review')
    const blindPronunciation = blind.report.measurements.find(({ dimension }) => dimension === 'pronunciation')
    assert.equal(blindPronunciation.status, 'unavailable')
    assert.equal(blindPronunciation.value, null, 'an unmeasured dimension never carries a passing number')
    assert.ok(blind.report.issues.some((entry) => entry.evidence.startsWith('required-evidence-missing:')), JSON.stringify(blind.report.issues))

    planState = await getPlan(planId)
    const afterBlindInsert = await api('POST', planPath(`/${planId}/blocks`), {
      key: 'pj-duplicate-of-unjudged',
      payload: { ...context(planState), position: 7, text: S5 },
    })
    assert.equal(afterBlindInsert.status, 201, JSON.stringify(afterBlindInsert.payload))
    assert.deepEqual(
      afterBlindInsert.payload.data.generations.filter(({ action }) => action !== 'up-to-date').map(({ action }) => action),
      ['enqueued'],
      'bytes the critic could not vouch for are paid for again, not reused',
    )
    state = await settle(allApproved, 'the block that could not reuse unvouched bytes')
    assert.equal(providerCalls.length, 12)
    const criticRejectedRows = await client.v2SyntheticCacheDecision.findMany({
      where: { workspaceId, reasonCode: 'CANDIDATE_CRITIC_REJECTED' },
    })
    assert.equal(criticRejectedRows.length, 1, JSON.stringify(criticRejectedRows))
    assert.equal(criticRejectedRows[0].outcome, 'miss')
    measured.afterEvidenceGate = await counts()

    // -----------------------------------------------------------------------
    // 12. Two simultaneous demands for one unit of work, one submission.
    //
    //     The worker is stopped first, so the first demand is genuinely still in
    //     flight when the second arrives — the race is arranged, not hoped for.
    //     The second block must not pay: it is deferred to reuse whatever the
    //     first buys. Restarting the worker settles the first, and a costless
    //     reorder gives the deferred twin the take it was waiting for.
    // -----------------------------------------------------------------------
    const secondWorkerPid = worker.pid
    await stopProcess(worker)
    planState = await getPlan(planId)
    const firstDemand = await api('POST', planPath(`/${planId}/blocks`), {
      key: 'pj-twin-first',
      payload: { ...context(planState), position: 8, text: S6 },
    })
    assert.equal(firstDemand.status, 201, JSON.stringify(firstDemand.payload))
    assert.deepEqual(
      firstDemand.payload.data.generations.filter(({ action }) => action !== 'up-to-date').map(({ action }) => action),
      ['enqueued'],
    )
    planState = await getPlan(planId)
    const secondDemand = await api('POST', planPath(`/${planId}/blocks`), {
      key: 'pj-twin-second',
      payload: { ...context(planState), position: 9, text: S6 },
    })
    assert.equal(secondDemand.status, 201, JSON.stringify(secondDemand.payload))
    assert.deepEqual(
      secondDemand.payload.data.generations.filter(({ action }) => action !== 'up-to-date').map(({ action }) => action),
      ['deferred-duplicate'],
      'the twin demand must be deferred, never paid for twice',
    )
    const twinRows = await client.v2SyntheticCacheDecision.findMany({
      where: { workspaceId, reasonCode: 'IN_FLIGHT_TWIN' },
    })
    assert.equal(twinRows.length, 1, JSON.stringify(twinRows))
    assert.equal(twinRows[0].outcome, 'blocked')

    worker = startWorker()
    assert.notEqual(worker.pid, secondWorkerPid, 'the relaunched worker must be a different process')
    assert.notEqual(worker.pid, firstWorkerPid)
    measured.workerPids.third = worker.pid
    const s6Blocks = (await client.v2SyntheticScriptBlock.findMany({
      where: { workspaceId, exactText: S6 }, orderBy: { occurrence: 'asc' },
    })).map(({ id }) => id)
    assert.equal(s6Blocks.length, 2)
    await settle(
      (data) => effectiveByBlock(data).get(s6Blocks[0])?.status === 'approved',
      'the first of the twin demands',
    )
    assert.equal(providerCalls.length, 13, 'two demands, one paid call')
    assert.equal(providerCalls.filter((text) => text === S6).length, 1)

    // A reorder costs nothing and is enough to let the deferred twin reuse.
    planState = await getPlan(planId)
    const reordered = await api('POST', planPath(`/${planId}/block-order`), {
      key: 'pj-twin-resolve',
      payload: { ...context(planState), order: [...planState.plan.version.blockSequence].reverse() },
    })
    assert.equal(reordered.status, 200, JSON.stringify(reordered.payload))
    assert.deepEqual(
      reordered.payload.data.generations.filter(({ action }) => action !== 'up-to-date').map(({ action }) => action),
      ['reused'],
      'the deferred twin reuses what its sibling paid for',
    )
    state = await settle(allApproved, 'the resolved twin')
    assert.equal(providerCalls.length, 13, 'resolving the twin costs nothing')
    const twinHit = (await client.v2SyntheticCacheDecision.findMany({ where: { workspaceId, outcome: 'hit' } }))
      .find((row) => row.decisionHash !== hit.decisionHash)
    assert.equal(twinHit.reasonCode, 'CACHE_HIT_ELIGIBLE')
    assert.ok(twinHit.avoidedCostMinorUnits > 0)
    measured.singleSubmission = {
      simultaneousDemands: 2, submissions: 1, deferredTwins: twinRows.length, resolvedByReuse: 1,
    }
    // -----------------------------------------------------------------------
    // 13. Revoked consent stops everything before the cache is even consulted:
    //     no hit, no job, no call. Registering the revoked version IS the act of
    //     revocation, so it happens here rather than in the setup.
    // -----------------------------------------------------------------------
    const beforeRevocation = await counts()
    const hitsBeforeRevocation = await client.v2SyntheticCacheDecision.count({ where: { workspaceId, outcome: 'hit' } })
    const profileV4 = await registerProfile(profileInput(4, 'voice_pj_b', 'avatar_pj_2', 'production-journey-profile-v4', {
      revokedAt: '2026-01-01T00:00:00.000Z',
    }))
    planState = await getPlan(planId)
    const revoked = await api('POST', planPath(`/${planId}/presenter-profile`), {
      key: 'pj-revoked',
      payload: { ...context(planState), profileSnapshotId: profileV4.profile.profileSnapshotId },
    })
    assert.ok(revoked.status >= 400, JSON.stringify(revoked.payload))
    assert.equal(revoked.payload.error.code, 'ASSET_RIGHTS_BLOCKED')
    const afterRevocation = await counts()
    assert.equal(afterRevocation.providerCalls, beforeRevocation.providerCalls, 'revoked consent must cause zero paid calls')
    assert.equal(afterRevocation.providerJobs, beforeRevocation.providerJobs, 'revoked consent must cause zero provider jobs')
    assert.equal(afterRevocation.generations, beforeRevocation.generations, 'revoked consent must cause zero generations')
    assert.equal(
      await client.v2SyntheticCacheDecision.count({ where: { workspaceId, outcome: 'hit' } }),
      hitsBeforeRevocation,
      'revoked consent must cause zero cache hits',
    )
    // The refusal is itself audited: one blocked row per block of the plan,
    // written after the stop so a ledger failure could never turn a refusal
    // into a paid call.
    const revokedRows = await client.v2SyntheticCacheDecision.findMany({
      where: { workspaceId, reasonCode: 'CONSENT_REVOKED' },
    })
    assert.equal(revokedRows.length, beforeRevocation.blocks, 'every block of the plan records why it was stopped')
    assert.deepEqual([...new Set(revokedRows.map(({ outcome }) => outcome))], ['blocked'])
    measured.afterRevocation = { ...afterRevocation, consentRevokedRows: revokedRows.length }

    // -----------------------------------------------------------------------
    // 14. Another workspace sees none of it, and no field leaks into the refusal.
    // -----------------------------------------------------------------------
    // Two contract shapes answer a foreign client, and both are invisibility:
    // an addressed resource refuses, a workspace-scoped listing comes back
    // empty because the listing is scoped to the caller's own workspace. What
    // is asserted is the property itself — nothing of workspace A crosses over,
    // in either shape.
    const secrets = [planId, s3BlockId, rejected.reportHash, hit.decisionHash, hit.cacheKey]
    for (const path of [
      planPath(`/${planId}`),
      `/v1/projects/${projectId}/synthetic-critic-reports?limit=20`,
      `/v1/projects/${projectId}/synthetic-cache-decisions?limit=20`,
      `/v1/projects/${projectId}/synthetic-blocks/${s3BlockId}/critic-evidence`,
    ]) {
      const refused = await api('GET', path, { token: foreignIssued.token })
      if (refused.status >= 400) {
        assert.ok(refused.payload.error?.code, JSON.stringify(refused.payload))
      } else {
        assert.equal(refused.status, 200, JSON.stringify(refused.payload))
        const collections = Object.values(refused.payload.data).filter(Array.isArray)
        assert.ok(collections.length > 0, `${path} answered a foreign client with a resource, not a listing`)
        for (const collection of collections) {
          assert.deepEqual(collection, [], `${path} listed workspace A content to a foreign client`)
        }
      }
      const body = JSON.stringify(refused.payload)
      for (const secret of secrets) {
        assert.equal(body.includes(secret), false, `${path} leaked ${secret}`)
      }
    }
    const foreignLedger = await api(
      'GET',
      `/v1/workspaces/${workspaceId}/synthetic-cache-decisions?cacheKey=${encodeURIComponent(hit.cacheKey)}&limit=20`,
      { token: foreignIssued.token },
    )
    assert.ok(foreignLedger.status >= 400, JSON.stringify(foreignLedger.payload))
    assert.equal(foreignLedger.payload.error.code, 'WORKSPACE_NOT_FOUND')
    assert.equal(await client.v2SyntheticCacheDecision.count({ where: { workspaceId: foreignWorkspaceId } }), 0)
    assert.equal(await client.v2SyntheticCriticReport.count({ where: { workspaceId: foreignWorkspaceId } }), 0)

    // -----------------------------------------------------------------------
    // 15. The closing tally. Every number below was read from PostgreSQL or
    //     from the loopback provider's own call log, never predicted.
    // -----------------------------------------------------------------------
    const final = await counts()
    assert.deepEqual(final, {
      providerCalls: 13, providerJobs: 13, generations: 15, cacheDecisions: 26, criticReports: 10, blocks: 10,
    })
    const summary = await api('GET', `/v1/projects/${projectId}/synthetic-cache-decisions/summary`)
    assert.equal(summary.status, 200, JSON.stringify(summary.payload))
    assert.equal(summary.payload.data.summary.byOutcome.hit, 2)
    assert.equal(summary.payload.data.summary.byOutcome.miss, 12)
    assert.equal(summary.payload.data.summary.byOutcome['forced-regenerate'], 1)
    assert.equal(summary.payload.data.summary.byOutcome.blocked, 11, 'one deferred twin plus one refusal per block')
    const booked = summary.payload.data.summary.byCurrency.find(({ currency }) => currency === hit.currency)
    assert.equal(
      booked.avoidedCostMinorUnits, hit.avoidedCostMinorUnits + twinHit.avoidedCostMinorUnits,
      'the booked saving is exactly the two reuses, each priced from the job that paid for it',
    )
    assert.equal(booked.decisions, 26)
    measured.final = final
    measured.savingsByCurrency = summary.payload.data.summary.byCurrency
    console.log('T-FR-104/105/106 measured:', JSON.stringify(measured, null, 2))
  } finally {
    await stopProcess(worker)
    await stopProcess(server)
    if (stub) await new Promise((resolve) => stub.close(resolve))
    await cleanup()
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
    if (process.env.APOLLO_PRODUCTION_JOURNEY_DEBUG === '1') {
      console.error('server logs tail:', serverLogs.slice(-6_000))
      console.error('worker logs tail:', workerLogs.slice(-6_000))
    }
  }
})
