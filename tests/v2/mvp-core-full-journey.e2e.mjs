import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import net from 'node:net'
import { dirname, isAbsolute, join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { resetDisposableDatabase } from './helpers/disposable-database.mjs'
import { createProjectWithVariant } from './helpers/explicit-project-http.mjs'
import { measureStateAssertion } from './helpers/state-assertion-timing.mjs'
import { commitSealedChild, persistReceiptForExistingVideo, testActor } from './helpers/pg-output-world.mjs'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const ffmpegStatic = require('ffmpeg-static')

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close((error) => error
        ? reject(error)
        : resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

async function waitForServer(baseUrl, child) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Next server exited with ${child.exitCode}`)
    }
    try {
      if ((await fetch(`${baseUrl}/v1/health`)).ok) return
    } catch {
      // The production server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Next server did not become ready')
}

function transcriptWords(entries) {
  return entries.flatMap(({ text, start, end }) => {
    const tokens = text.split(/\s+/).filter(Boolean)
    const step = (end - start) / tokens.length
    return tokens.map((word, index) => ({
      word,
      start: Number((start + index * step).toFixed(3)),
      end: Number((start + (index + 1) * step - 0.01).toFixed(3)),
    }))
  })
}

function transcriptSegments(entries) {
  return entries.map((entry, index) => ({
    id: index,
    start: entry.start,
    end: entry.end,
    text: entry.text,
    confidence: 0.99,
  }))
}

test('T-FR-222 completes the public MVP Core journey with real 9:16 and 16:9 MP4 exports', {
  skip: process.env.APOLLO_MVP_CORE_FULL_E2E !== '1' &&
    'set APOLLO_MVP_CORE_FULL_E2E=1 and use an isolated V2 database',
  timeout: 900_000,
}, async () => {
  assert.ok(
    process.env.V2_DATABASE_URL,
    'V2_DATABASE_URL must point to an isolated PostgreSQL database',
  )
  const databaseName = new URL(process.env.V2_DATABASE_URL).pathname.slice(1)
  assert.match(
    databaseName,
    /(?:^|_)e2e(?:_|$)/,
    'destructive E2E setup requires an explicitly isolated database',
  )
  assert.ok(ffmpegStatic, 'ffmpeg-static is required')

  const sourceMasterPath = join(
    process.cwd(),
    '.apollo',
    'test-inputs',
    'imersao-master.mp4',
  )
  assert.equal(isAbsolute(sourceMasterPath), true)
  assert.equal((await stat(sourceMasterPath)).isFile(), true)

  const {
    calculateVersionHash,
    stableSerialize,
  } = await import('../../src/v2/application/version-hash.ts')
  const { createApiClientService } = await import(
    '../../src/v2/application/create-api-client.ts'
  )
  const { createMediaTranscript } = await import(
    '../../src/v2/domain/media-transcript.ts'
  )
  const { createMediaColorProbe } = await import(
    '../../src/v2/domain/color-and-export.ts'
  )
  const { compileInitialSourceEditPlan } = await import(
    '../../src/v2/application/apply-editorial-cut-command.ts'
  )
  const { createMediaArtifactManifestV2 } = await import(
    '../../src/v2/domain/media-artifact.ts'
  )
  const { PrismaApiClientRepository } = await import(
    '../../src/v2/infrastructure/prisma/api-client-repository.ts'
  )
  const { nodeApiCredentialCrypto } = await import(
    '../../src/v2/infrastructure/security/api-credential.ts'
  )
  const { probeVideo } = await import(
    '../../src/v2/infrastructure/media/video-probe.ts'
  )

  const client = new PrismaClient()
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `mvp-full-workspace-${suffix}`
  const artifactRoot = join(
    process.cwd(),
    '.apollo',
    'e2e-artifacts',
    `mvp-core-${suffix}`,
  )
  const evidenceRoot = join(
    process.cwd(),
    '.apollo',
    'review',
    'mvp-core-f1-051',
  )
  const primaryBrollInput = join(artifactRoot, 'inputs', 'primary-broll.mp4')
  const companionBrollInput = join(artifactRoot, 'inputs', 'companion-broll.mp4')
  const generatedRejectedInput = join(artifactRoot, 'inputs', 'generated-rejected.mp4')
  const companionVoiceoverInput = join(artifactRoot, 'inputs', 'companion-voiceover.mp4')
  const createdAt = new Date('2026-07-27T03:00:00.000Z')
  const protectedKey = Buffer.alloc(32, 17).toString('base64url')
  let server
  let serverLogs = ''
  let governanceWaits = 0
  let journeyCompleted = false

  const artifactIds = {
    primaryMaster: `mvp-primary-master-${suffix}`,
    primaryBroll: `mvp-primary-broll-${suffix}`,
    generatedRejected: `mvp-generated-rejected-${suffix}`,
    companionMaster: `mvp-companion-master-${suffix}`,
    companionBroll: `mvp-companion-broll-${suffix}`,
  }
  const transcriptIds = {
    primary: `mvp-primary-transcript-${suffix}`,
    companion: `mvp-companion-transcript-${suffix}`,
  }

  try {
    await resetDisposableDatabase(client)
    await mkdir(dirname(primaryBrollInput), { recursive: true })
    await mkdir(evidenceRoot, { recursive: true })

    await Promise.all([
      execFileAsync(ffmpegStatic, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'color=c=0x102f3d:s=1280x720:r=30',
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
        '-vf',
        "drawbox=x='mod(t*180,1600)-320':y=80:w=320:h=560:color=0xf2b84b@0.85:t=fill,drawbox=x='1280-mod(t*120,1600)':y=190:w=240:h=340:color=0x35a7a0@0.75:t=fill",
        '-t', '4.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '96k', '-shortest',
        '-movflags', '+faststart', primaryBrollInput,
      ], { windowsHide: true, timeout: 60_000 }),
      execFileAsync(ffmpegStatic, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'color=c=0x171b2d:s=1280x720:r=30',
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
        '-vf',
        "drawbox=x=90:y='mod(t*110,900)-180':w=1100:h=180:color=0x6f7bf7@0.75:t=fill,drawbox=x=180:y='720-mod(t*80,900)':w=920:h=100:color=0xf06d8b@0.70:t=fill",
        '-t', '5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '96k', '-shortest',
        '-movflags', '+faststart', companionBrollInput,
      ], { windowsHide: true, timeout: 60_000 }),
      execFileAsync(ffmpegStatic, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
        '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '96k', '-shortest',
        '-movflags', '+faststart', generatedRejectedInput,
      ], { windowsHide: true, timeout: 60_000 }),
      execFileAsync(ffmpegStatic, [
        '-hide_banner', '-loglevel', 'error', '-y',
        // A voiceover with no person on screen: the first seconds of the master's speech over a plain picture. Audio-only masters
        // are cataloged by ingest without a transcript or an initial plan, so the project's source is a recording with a picture.
        '-f', 'lavfi', '-i', 'color=c=0x1c2433:s=1280x720:r=30',
        '-i', sourceMasterPath, '-t', '5', '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '160k', '-shortest',
        '-movflags', '+faststart', companionVoiceoverInput,
      ], { windowsHide: true, timeout: 60_000 }),
    ])

    await client.v2Workspace.create({
      data: {
        id: workspaceId,
        slug: workspaceId,
        name: 'Apollo MVP Core full E2E',
        status: 'active',
        createdAt,
        updatedAt: createdAt,
      },
    })
    const issued = await createApiClientService({
      repository: new PrismaApiClientRepository(client),
      credentialCrypto: nodeApiCredentialCrypto,
      clock: () => createdAt,
    })({
      id: `mvp-full-client-${suffix}`,
      workspaceId,
      name: 'MVP Core full external operator',
      environment: 'production',
      scopes: [
        'projects:read',
        'projects:write',
        'projects:approve',
        'operations:read',
        'operations:cancel',
        'operations:retry',
        'artifacts:read',
        'artifacts:rights',
      ],
    })

    const port = await getFreePort()
    const baseUrl = `http://127.0.0.1:${port}`
    const workerEnvironment = {
      ...process.env,
      APOLLO_V2_ARTIFACT_ROOT: artifactRoot,
      APOLLO_V2_RENDER_LEASE_MS: '120000',
      APOLLO_V2_RENDER_HEARTBEAT_MS: '5000',
      APOLLO_V2_WORKER_RETRY_BASE_MS: '1',
      APOLLO_V2_WORKER_RETRY_MAX_MS: '1',
      APOLLO_PROTECTED_PAYLOAD_KEY_ID: 'mvp-full-e2e-key',
      APOLLO_PROTECTED_PAYLOAD_KEY: protectedKey,
    }
    server = spawn(
      process.execPath,
      ['node_modules/next/dist/bin/next', 'start', '-p', String(port)],
      {
        cwd: process.cwd(),
        env: {
          ...workerEnvironment,
          NODE_ENV: 'production',
          __NEXT_PROCESSED_ENV: 'true',
          APOLLO_API_ENVIRONMENT: 'production',
          APOLLO_MEDIA_DOWNLOAD_BASE_URL: `${baseUrl}/`,
          APOLLO_MEDIA_DOWNLOAD_SIGNING_SECRET:
            `mvp-core-download-${suffix}`.padEnd(48, 'x'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    server.stdout.on('data', (chunk) => { serverLogs += String(chunk) })
    server.stderr.on('data', (chunk) => { serverLogs += String(chunk) })
    await waitForServer(baseUrl, server)
    const authorization = `Bearer ${issued.token}`

    async function runWorkerOnce(kind, environmentOverrides = {}) {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [
          'node_modules/tsx/dist/cli.mjs',
          'scripts/run-v2-render-worker-once.mjs',
        ],
        {
          cwd: process.cwd(),
          env: {
            ...workerEnvironment,
            APOLLO_V2_WORKER_ONCE_KIND: kind,
            ...environmentOverrides,
          },
          windowsHide: true,
          timeout: 360_000,
          maxBuffer: 8 * 1024 * 1024,
        },
      )
      const line = stdout.split(/\r?\n/).find(
        (candidate) => candidate.startsWith('APOLLO_WORKER_OUTCOME='),
      )
      assert.ok(
        line,
        `worker ${kind} did not emit an outcome\nstdout: ${stdout}\nstderr: ${stderr}`,
      )
      return JSON.parse(line.slice('APOLLO_WORKER_OUTCOME='.length))
    }

    async function api({
      method = 'GET',
      path,
      body,
      key,
      expected = [200],
    }) {
      let response
      let payload
      // Governance admission judges the requests of the last minute against the five minutes before it, and answers a burst with a retryable 429
      // that executes nothing. A journey whose long steps got faster meets that burst sooner, so the client does what the error says: it waits for
      // the window to move and sends the same request again (same idempotency key). The thresholds are the product's, untouched.
      for (let attempt = 0; ; attempt += 1) {
        response = await fetch(`${baseUrl}${path}`, {
          method,
          headers: {
            authorization,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(key ? { 'idempotency-key': key } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        payload = await response.json()
        const governed = response.status === 429 &&
          payload?.error?.code === 'GOVERNANCE_LIMIT_EXCEEDED' && payload.error.retryable === true
        if (!governed || attempt >= 18) break
        governanceWaits += 1
        await new Promise((resolve) => setTimeout(resolve, 5_000))
      }
      assert.ok(
        expected.includes(response.status),
        `${method} ${path} returned ${response.status}: ${JSON.stringify(payload)}\n${serverLogs.slice(-8_000)}`,
      )
      return { response, payload: payload.data }
    }

    // The 6.0.0 contract: a project has no format of its own. The output a journey edits is an explicit variant created on
    // top of the creation Version, so the journey states the aspect ratio it means and edits against the variant Version.
    async function createProject({
      name,
      objective,
      aspectRatio,
      destination,
      briefing,
      key,
    }) {
      const call = async (path, body, idempotencyKey) => (await api({
        method: 'POST',
        path,
        key: idempotencyKey,
        expected: [200, 201],
        body,
      })).payload
      const made = await createProjectWithVariant(call, {
        key,
        aspectRatio,
        project: {
          name,
          objective,
          locale: 'pt-BR',
          ...(briefing ? { briefing } : {}),
          ...(destination ? { desiredAction: {
            destination: { type: 'url', value: destination },
          } } : {}),
        },
      })
      return {
        project: { id: made.projectId },
        version: made.version,
        variant: made.variant,
      }
    }

    const primary = await createProject({
      name: 'Imersão — edição final 9:16',
      objective: 'discovery',
      aspectRatio: '9:16',
      key: `mvp-primary-${suffix}`,
    })
    const companion = await createProject({
      name: 'Voiceover sem pessoa — 16:9',
      objective: 'sale',
      aspectRatio: '16:9',
      destination: 'https://example.com/checkout',
      // Without an owner briefing the Director treats a project as media-only (evidence-bound, no treatment mode of its own to claim); the montage this
      // journey proves is the one the owner asked for: a voiceover over the visual source, no person on screen.
      briefing: 'Público: quem decide a compra. Oferta: o material de comunicação. Tom: claro e direto. Voiceover sobre a imagem, sem pessoa em cena.',
      key: `mvp-companion-${suffix}`,
    })

    async function seedArtifact({
      artifactId,
      projectId,
      role,
      sourcePath,
      mediaType,
      container,
      probe,
      originalFileName,
    }) {
      const artifactKey = [
        'workspaces',
        workspaceId,
        'seed',
        `${artifactId}.${container}`,
      ].join('/')
      const storedPath = join(artifactRoot, ...artifactKey.split('/'))
      await mkdir(dirname(storedPath), { recursive: true })
      await copyFile(sourcePath, storedPath)
      const bytes = await readFile(storedPath)
      const artifactSha256 = sha256(bytes)
      const manifestId = `manifest-${artifactId}`
      const manifest = createMediaArtifactManifestV2({
        artifactKey,
        artifactSha256,
        byteSize: bytes.byteLength,
        mediaType,
        container,
        recipe: {
          id: 'mvp-core-controlled-source',
          version: '1.0.0',
          parameters: { artifactId, controlledE2e: true },
        },
        sources: [],
        probe: {
          width: probe.width,
          height: probe.height,
          duration: probe.duration,
          fps: probe.fps,
        },
      })
      await client.v2MediaArtifact.create({
        data: {
          id: artifactId,
          workspaceId,
          artifactKey,
          sha256: artifactSha256,
          byteSize: BigInt(bytes.byteLength),
          mediaType,
          container,
          status: 'available',
          createdAt,
        },
      })
      await client.v2MediaArtifactManifest.create({
        data: {
          id: manifestId,
          workspaceId,
          artifactId,
          schemaVersion: 'media-artifact-manifest/v2',
          manifestHash: manifest.manifestHash,
          recipeId: 'mvp-core-controlled-source',
          recipeVersion: '1.0.0',
          parametersHash: manifest.recipe.parametersHash,
          manifestJson: stableSerialize(manifest),
          createdAt,
        },
      })
      if (projectId && role) {
        await client.v2ProjectMediaAsset.create({
          data: {
            id: randomUUID(),
            workspaceId,
            projectId,
            artifactId,
            role,
            originalFileName,
            createdAt,
          },
        })
      }
      return {
        artifactId,
        manifestId,
        artifactKey,
        storedPath,
        sha256: artifactSha256,
      }
    }

    const sourceProbe = await probeVideo(sourceMasterPath)
    const primaryMaster = await seedArtifact({
      artifactId: artifactIds.primaryMaster,
      projectId: primary.project.id,
      role: 'source-master',
      sourcePath: sourceMasterPath,
      mediaType: 'video',
      container: 'mp4',
      // The controlled receipt below measures the master at its nominal 30 fps, so the manifest states the same rate.
      probe: { ...sourceProbe, fps: 30 },
      originalFileName: 'imersao-master.mp4',
    })
    const primaryBrollProbe = await probeVideo(primaryBrollInput)
    const primaryBroll = await seedArtifact({
      artifactId: artifactIds.primaryBroll,
      sourcePath: primaryBrollInput,
      mediaType: 'video',
      container: 'mp4',
      probe: primaryBrollProbe,
      originalFileName: 'primary-broll.mp4',
    })
    const rejectedGenerated = await seedArtifact({
      artifactId: artifactIds.generatedRejected,
      sourcePath: generatedRejectedInput,
      mediaType: 'video',
      container: 'mp4',
      probe: await probeVideo(generatedRejectedInput),
      originalFileName: 'generated-rejected.mp4',
    })
    const companionMaster = await seedArtifact({
      artifactId: artifactIds.companionMaster,
      projectId: companion.project.id,
      role: 'source-master',
      sourcePath: companionVoiceoverInput,
      mediaType: 'video',
      container: 'mp4',
      probe: { ...await probeVideo(companionVoiceoverInput), fps: 30 },
      originalFileName: 'companion-voiceover.mp4',
    })
    const companionBroll = await seedArtifact({
      artifactId: artifactIds.companionBroll,
      sourcePath: companionBrollInput,
      mediaType: 'video',
      container: 'mp4',
      probe: await probeVideo(companionBrollInput),
      originalFileName: 'companion-broll.mp4',
    })

    async function seedTranscript({
      id,
      projectId,
      sourceArtifact,
      entries,
    }) {
      const transcript = createMediaTranscript({
        language: 'pt-BR',
        text: entries.map((entry) => entry.text).join(' '),
        words: transcriptWords(entries),
        segments: transcriptSegments(entries),
        provider: 'controlled-e2e',
        model: 'aligned-human-evidence-v1',
      })
      await client.v2MediaTranscript.create({
        data: {
          id,
          workspaceId,
          projectId,
          sourceArtifactId: sourceArtifact.artifactId,
          sourceManifestId: sourceArtifact.manifestId,
          schemaVersion: 'media-transcript/v1',
          language: transcript.language,
          provider: transcript.provider,
          model: transcript.model,
          transcriptHash: transcript.transcriptHash,
          transcriptJson: stableSerialize(transcript),
          createdAt,
        },
      })
      return transcript
    }

    const primaryTranscript = await seedTranscript({
      id: transcriptIds.primary,
      projectId: primary.project.id,
      sourceArtifact: primaryMaster,
      entries: [
        {
          text: 'Seja muito bem vindo você garantiu a sua vaga nesta imersão',
          start: 0.4,
          end: 6.5,
        },
        {
          text: 'A comunicação é uma habilidade valiosa para posicionar sua mensagem',
          start: 14,
          end: 24,
        },
        {
          text: 'O encontro será em trinta e um de janeiro e primeiro de fevereiro',
          start: 37,
          end: 43,
        },
        {
          text: 'Você vai aprender a construir clareza confiança e impacto',
          start: 60,
          end: 72,
        },
        {
          text: 'Serão dois dias de prática guiada',
          start: 86.65,
          end: 87.5,
        },
        {
          text: 'A comunicação transforma a maneira como o mercado percebe você',
          start: 89,
          end: 101,
        },
      ],
    })
    const companionTranscript = await seedTranscript({
      id: transcriptIds.companion,
      projectId: companion.project.id,
      sourceArtifact: companionMaster,
      entries: [
        {
          // A sale video says its call to action: the Director refuses (cta-required) a conversion objective whose action is not spoken.
          text: 'Uma mensagem clara aproxima pessoas e oportunidades garanta a sua vaga no link',
          start: 0.2,
          end: 4.2,
        },
        {
          text: 'remover',
          start: 4.55,
          end: 4.75,
        },
      ],
    })

    async function setRights(artifactId, status = 'approved') {
      const read = await fetch(`${baseUrl}/v1/artifacts/${artifactId}/rights`, {
        headers: { authorization },
      })
      const readPayload = await read.json()
      assert.equal(read.status, 200, JSON.stringify(readPayload))
      const etag = read.headers.get('etag')
      assert.ok(etag)
      const response = await fetch(`${baseUrl}/v1/artifacts/${artifactId}/rights`, {
        method: 'PUT',
        headers: {
          authorization,
          'content-type': 'application/json',
          'if-match': etag,
        },
        body: JSON.stringify(status === 'approved'
          ? {
              status: 'approved',
              allowedUses: ['editorial-reuse', 'rendering'],
              prohibitedUses: [],
              allowedLocales: ['pt-BR'],
              consent: { status: 'not-required', allowedUses: [] },
              sourceNote: 'Controlled MVP Core E2E asset.',
            }
          : {
              status: 'revoked',
              allowedUses: [],
              prohibitedUses: ['rendering'],
              consent: { status: 'not-required', allowedUses: [] },
              sourceNote: 'Rejected generated candidate used to prove fail-closed selection.',
            }),
      })
      const payload = await response.json()
      assert.equal(response.status, 200, JSON.stringify(payload))
    }
    await setRights(primaryMaster.artifactId)
    await setRights(primaryBroll.artifactId)
    await setRights(rejectedGenerated.artifactId, 'revoked')
    await setRights(companionMaster.artifactId)
    await setRights(companionBroll.artifactId)

    // Every video the renderer plays needs its measured colour and an exact colour pipeline compilation. The controlled sources are
    // limited BT.709 SDR, so each gets its probe and the identity pipeline is compiled for the project that plays it.
    const colorMetadata = {
      colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709', matrix: 'bt709', range: 'limited', bitDepth: 8,
    }
    const colorStage = (id, kind, enabled, provider, parameters) => ({
      id,
      kind,
      version: 'v1',
      enabled,
      output: colorMetadata,
      implementation: { provider, version: 'v1', parameters, parametersHash: sha256(JSON.stringify(parameters)) },
    })
    async function compileColor(world, source) {
      const colorProbe = createMediaColorProbe({
        id: `mvp-color-probe-${source.artifactId}`,
        workspaceId,
        artifactId: source.artifactId,
        manifestId: source.manifestId,
        detection: { state: 'ready', metadata: colorMetadata, pixelFormat: 'yuv420p', hdrMode: 'sdr' },
        producer: { provider: 'ffprobe', version: '7.1.1', binaryDigest: sha256('mvp-core-ffprobe') },
        createdAt: createdAt.toISOString(),
      })
      await client.v2MediaColorProbe.create({
        data: {
          id: colorProbe.id,
          workspaceId,
          artifactId: source.artifactId,
          manifestId: source.manifestId,
          schemaVersion: colorProbe.schemaVersion,
          state: 'ready',
          metadataJson: stableSerialize(colorMetadata),
          pixelFormat: 'yuv420p',
          hdrMode: 'sdr',
          reasonsJson: '[]',
          producerProvider: 'ffprobe',
          producerVersion: colorProbe.producer.version,
          producerBinaryDigest: colorProbe.producer.binaryDigest,
          createdAt,
          probeHash: colorProbe.probeHash,
        },
      })
      await api({
        method: 'POST',
        path: `/v1/projects/${world.project.id}/color-pipeline-compilations`,
        key: `mvp-color-${source.artifactId}-${world.project.id}`,
        expected: [201],
        body: {
          sourceArtifactId: source.artifactId,
          sourceManifestId: source.manifestId,
          outputMetadata: colorMetadata,
          stages: [
            colorStage('technical-rec709', 'technical', true, 'ffmpeg-zscale', { mode: 'identity' }),
            colorStage('match-source', 'match', false, 'apollo-match', { mode: 'bypass' }),
            colorStage('creative-none', 'creative-lut', false, 'apollo-lut', { mode: 'none' }),
            colorStage('output-rec709', 'output', true, 'ffmpeg-zscale', { dither: true }),
          ],
        },
      })
    }

    // 6.0.0: a source enters a project through ingest, which leaves its receipt and the compiled initial EditPlan as the Version the
    // editorial Command builds on. This journey seeds the source bytes itself, so it persists what the ingest leaves (the receipt)
    // and commits the initial plan as the child Command the ingest worker commits; the variant's Version is no longer the head.
    const ingestActor = testActor({
      workspaceId,
      clientId: issued.client.id,
      credentialId: issued.credential.id,
      environment: 'production',
      scopes: ['projects:write', 'media:write'],
    })
    async function commitIngestedSource({ world, label, receipt, master, insert, insertOwnAudio = false, transcript, transcriptId, durationSeconds, fps }) {
      await receipt()
      const bundle = await commitSealedChild(client, {
        workspaceId,
        projectId: world.project.id,
        actor: ingestActor,
        suffix: `mvp-ingest-${label}-${suffix}`,
        mutatePlan: (parentPlan) => {
          const initial = JSON.parse(stableSerialize(compileInitialSourceEditPlan({
            id: parentPlan.id,
            projectVersionId: parentPlan.projectVersionId,
            transcriptId,
            transcript,
            sourceArtifactId: master.artifactId,
            sourceDurationSeconds: durationSeconds,
            fps,
            createdAt: parentPlan.createdAt,
          })))
          // After an editorial cut a project can only play recordings its State already observed (a cut copy owns no recording to
          // adopt), so the project's second recording is observed by the plan the ingest leaves: it follows the master on the
          // timeline, and the cut, which recompiles the plan from the master's transcript, keeps the observation.
          const insertFrames = insertFramesByArtifact.get(insert.artifactId)
          const [track] = initial.videoTracks
          return {
            ...initial,
            durationFrames: initial.durationFrames + insertFrames,
            videoTracks: [{
              ...track,
              clips: [...track.clips, {
                id: `ingest-insert-${label}`,
                sourceArtifactId: insert.artifactId,
                sourceInFrame: 0,
                sourceOutFrame: insertFrames,
                timelineInFrame: initial.durationFrames,
                timelineOutFrame: initial.durationFrames + insertFrames,
                rate: 1,
                // The Director treats a project as a montage only when every clip names the recording its sound comes from.
                ...(insertOwnAudio
                  ? { audioSourceArtifactId: insert.artifactId, audioSourceInFrame: 0, audioSourceOutFrame: insertFrames }
                  : {}),
              }],
            }],
            sources: [...initial.sources, {
              id: insert.artifactId,
              artifactId: insert.artifactId,
              kind: 'video',
              durationSeconds: insertFrames / fps,
            }],
            lineageRefs: [...initial.lineageRefs, insert.artifactId],
          }
        },
        // The insert is observed with the master: the cut binds every recording of the project, so a later replace can play it.
        adopt: [master.artifactId, insert.artifactId],
      })
      world.version = bundle.version
    }
    // The inserts are part of their projects the way ingest leaves them: linked to the project, with the receipt of their normalization
    // and their colour pipeline, all before the cut binds the project's recordings.
    const insertFramesByArtifact = new Map()
    for (const [world, broll, brollInput, fileName] of [
      [primary, primaryBroll, primaryBrollInput, 'primary-broll.mp4'],
      [companion, companionBroll, companionBrollInput, 'companion-broll.mp4'],
    ]) {
      const brollProbe = await probeVideo(brollInput)
      insertFramesByArtifact.set(broll.artifactId, Math.round(brollProbe.duration * 30))
      await client.v2ProjectMediaAsset.create({
        data: {
          id: randomUUID(),
          workspaceId,
          projectId: world.project.id,
          artifactId: broll.artifactId,
          role: 'selected-insert',
          originalFileName: fileName,
          createdAt,
        },
      })
      await persistReceiptForExistingVideo(client, {
        workspaceId,
        projectId: world.project.id,
        actor: ingestActor,
        artifactId: broll.artifactId,
        createdAt: new Date(createdAt.getTime() - 60_000).toISOString(),
        nativeFps: 30,
        durationFrames: Math.round(brollProbe.duration * 30),
      })
      await compileColor(world, broll)
    }
    await commitIngestedSource({
      world: primary,
      label: 'primary',
      receipt: () => persistReceiptForExistingVideo(client, {
        workspaceId,
        projectId: primary.project.id,
        actor: ingestActor,
        artifactId: primaryMaster.artifactId,
        createdAt: new Date(createdAt.getTime() - 60_000).toISOString(),
        // The master's average rate is 30 fps to within the container's rounding; the receipt states the 30 fps it plays at.
        nativeFps: 30,
        durationFrames: Math.round(sourceProbe.duration * 30),
      }),
      master: primaryMaster,
      insert: primaryBroll,
      transcript: primaryTranscript,
      transcriptId: transcriptIds.primary,
      durationSeconds: sourceProbe.duration,
      fps: 30,
    })
    await commitIngestedSource({
      world: companion,
      label: 'companion',
      receipt: () => persistReceiptForExistingVideo(client, {
        workspaceId,
        projectId: companion.project.id,
        actor: ingestActor,
        artifactId: companionMaster.artifactId,
        createdAt: new Date(createdAt.getTime() - 60_000).toISOString(),
        nativeFps: 30,
        durationFrames: 150,
      }),
      master: companionMaster,
      insert: companionBroll,
      insertOwnAudio: true,
      transcript: companionTranscript,
      transcriptId: transcriptIds.companion,
      durationSeconds: 5,
      fps: 30,
    })

    await compileColor(primary, primaryMaster)
    await compileColor(companion, companionMaster)

    const primaryRules = [
      {
        id: 'date-january-31',
        label: '31 de janeiro',
        alternatives: ['trinta e um de janeiro'],
      },
      {
        id: 'date-february-1',
        label: '1 de fevereiro',
        alternatives: ['primeiro de fevereiro'],
      },
      {
        id: 'duration-two-days',
        label: 'dois dias',
        alternatives: ['dois dias'],
      },
    ]
    const primaryCut = (await api({
      method: 'POST',
      path: `/v1/projects/${primary.project.id}/commands`,
      key: `primary-cut-${suffix}`,
      expected: [201],
      body: {
        type: 'remove-spoken-content',
        baseVersionId: primary.version.id,
        baseHash: primary.version.baseHash,
        variantId: primary.variant.id,
        sourceTranscriptId: transcriptIds.primary,
        rules: primaryRules,
        exclusionOverrides: [
          {
            sourceStartSeconds: 36.26,
            sourceEndSeconds: 58.12,
            ruleIds: ['date-january-31', 'date-february-1'],
            reason: 'Validated source range containing both obsolete event dates.',
          },
          {
            sourceStartSeconds: 86.58,
            sourceEndSeconds: 87.76,
            ruleIds: ['duration-two-days'],
            reason: 'Validated source range containing the obsolete two-day claim.',
          },
        ],
        reason: 'Remove obsolete dates and duration before any visual direction.',
      },
    })).payload
    assert.deepEqual(
      primaryCut.editorial.exclusions.map((item) => [
        item.sourceStartSeconds,
        item.sourceEndSeconds,
      ]),
      [[36.26, 58.12], [86.58, 87.76]],
    )
    assert.equal(primaryCut.editorial.automaticZoom, false)
    assert.equal(primaryCut.editorial.subtitleFaceProtection, true)
    assert.equal(primaryCut.editorial.impact.schemaVersion, 'editorial-cut-impact/v2')
    assert.deepEqual(primaryCut.editorial.impact.affectedVariantIds, [primary.variant.id])
    assert.equal(primaryCut.editorial.impact.commandId, primaryCut.command.id)
    assert.equal(primaryCut.editorial.impact.renderSemanticsChanged, true)
    assert.equal(primaryCut.editorial.impact.affectedRanges[0].startFrame, 0)
    assert.equal(primaryCut.editorial.impact.affectedRanges[0].endFrame >= primaryCut.editorial.outputDurationFrames, true)
    assert.deepEqual(primaryCut.editorial.impact.dependencyTypes, ['audio', 'content', 'timing', 'visual'])
    assert.equal(primaryCut.editorial.impact.minimalRenders.length, 1)
    assert.equal(primaryCut.editorial.impact.minimalRenders[0].ranges[0].endFrame, primaryCut.editorial.outputDurationFrames)
    assert.equal(primaryCut.editorial.invalidations.length, 0)
    assert.equal(primaryCut.operation.type, 'project-proxy-render')
    assert.equal(primaryCut.operation.status, 'queued')
    // The cut of the real master is a multi-megabyte State; its integrity assertion runs twice inside the 10 s commit, so its cost is measured here.
    const cutStateAssertion = await measureStateAssertion(client, primaryCut.version.id)
    console.log(`STATE_ASSERTION_TIMING ${JSON.stringify(cutStateAssertion)}`)
    // The cut leaves its proxy render queued; the worker takes the oldest queued render, and this journey renders the Director's, so the cut's is canceled.
    await cancelOperation(primaryCut.operation.id)

    const companionCut = (await api({
      method: 'POST',
      path: `/v1/projects/${companion.project.id}/commands`,
      key: `companion-cut-${suffix}`,
      expected: [201],
      body: {
        type: 'remove-spoken-content',
        baseVersionId: companion.version.id,
        baseHash: companion.version.baseHash,
        variantId: companion.variant.id,
        sourceTranscriptId: transcriptIds.companion,
        rules: [{
          id: 'companion-tail',
          label: 'remover',
          alternatives: ['remover'],
        }],
        exclusionOverrides: [{
          sourceStartSeconds: 4.5,
          sourceEndSeconds: 5,
          ruleIds: ['companion-tail'],
          reason: 'Remove controlled tail marker and retain one continuous voiceover clip.',
        }],
      },
    })).payload
    await cancelOperation(companionCut.operation.id)

    const selectionBrief = {
      intention: 'Criar uma quebra de padrão curta sem interromper a fala.',
      content: ['comunicação', 'clareza', 'impacto'],
      style: ['clean', 'editorial'],
      durationMs: { min: 1500, max: 4000 },
      entry: 'sentence boundary',
      exit: 'return to speaker before the closing claim',
      prohibited: ['rostos sintéticos', 'texto ilegível'],
    }
    const candidate = (artifactId, source, patch = {}) => ({
      artifactId,
      source,
      content: ['comunicação', 'clareza', 'impacto'],
      style: ['clean', 'editorial'],
      durationMs: 3000,
      quality: 0.94,
      continuity: 0.9,
      novelty: 0.55,
      literalness: 0.2,
      ...patch,
    })
    const rejectedSelection = (await api({
      method: 'POST',
      path: `/v1/projects/${primary.project.id}/asset-selections`,
      key: `primary-generated-rejection-${suffix}`,
      expected: [201],
      body: {
        projectVersionId: primaryCut.version.id,
        projectVersionHash: primaryCut.version.baseHash,
        brief: selectionBrief,
        candidates: [
          candidate(artifactIds.generatedRejected, 'generated'),
        ],
      },
    })).payload.selection
    assert.equal(rejectedSelection.decision, 'no_insert')
    assert.equal(rejectedSelection.evaluations[0].verdict, 'rejected')

    const primarySelection = (await api({
      method: 'POST',
      path: `/v1/projects/${primary.project.id}/asset-selections`,
      key: `primary-library-selection-${suffix}`,
      expected: [201],
      body: {
        projectVersionId: primaryCut.version.id,
        projectVersionHash: primaryCut.version.baseHash,
        brief: selectionBrief,
        candidates: [
          candidate(artifactIds.primaryBroll, 'library'),
        ],
      },
    })).payload.selection
    assert.equal(primarySelection.selectedArtifactId, artifactIds.primaryBroll)

    const companionSelection = (await api({
      method: 'POST',
      path: `/v1/projects/${companion.project.id}/asset-selections`,
      key: `companion-library-selection-${suffix}`,
      expected: [201],
      body: {
        projectVersionId: companionCut.version.id,
        projectVersionHash: companionCut.version.baseHash,
        brief: selectionBrief,
        candidates: [
          candidate(artifactIds.companionBroll, 'library', {
            durationMs: 4000,
          }),
        ],
      },
    })).payload.selection
    assert.equal(companionSelection.selectedArtifactId, artifactIds.companionBroll)

    async function cancelOperation(operationId) {
      const result = await api({
        method: 'POST',
        path: `/v1/operations/${operationId}/cancel`,
        expected: [200],
      })
      assert.equal(result.payload.operation.status, 'canceled')
    }

    const preliminaryDirector = (await api({
      method: 'POST',
      path: `/v1/projects/${primary.project.id}/commands`,
      key: `primary-preliminary-director-${suffix}`,
      expected: [201],
      body: {
        type: 'run-director',
        baseVersionId: primaryCut.version.id,
        baseHash: primaryCut.version.baseHash,
        reason: 'Build a face-safe subtitle track before precise manual refinements.',
      },
    })).payload
    assert.equal(preliminaryDirector.directorRun.editPlan.automaticZoom, false)
    assert.equal(preliminaryDirector.directorRun.impact.schemaVersion, 'director-run-impact/v1')
    assert.equal(preliminaryDirector.directorRun.impact.commandId, preliminaryDirector.command.id)
    assert.equal(preliminaryDirector.directorRun.impact.resultVersionId, preliminaryDirector.version.id)
    assert.deepEqual(preliminaryDirector.directorRun.impact.dependencyTypes, ['audio', 'content', 'policy', 'timing', 'visual'])
    assert.deepEqual(preliminaryDirector.directorRun.impact.minimalRenders, [{
      kind: 'proxy', variantId: primary.variant.id,
      ranges: [{ startFrame: 0, endFrame: preliminaryDirector.directorRun.editPlan.durationFrames }],
    }])
    assert.deepEqual(preliminaryDirector.directorRun.invalidations, [])
    await cancelOperation(preliminaryDirector.operation.id)

    async function timeline(projectId) {
      return (await api({
        path: `/v1/projects/${projectId}/timeline`,
      })).payload
    }

    async function manual(projectId, current, operation, key, targetVersionId) {
      const targetId = operation?.clipId ??
        current.timeline.clips[0]?.id ??
        'clip-1'
      const result = (await api({
        method: 'POST',
        path: `/v1/projects/${projectId}/manual-edits`,
        key,
        expected: [201],
        body: {
          action: targetVersionId ? 'undo' : 'apply',
          baseVersionId: current.timeline.versionId,
          baseHash: current.baseHash,
          expectedRevision: current.timeline.revision,
          variantId: projectId === primary.project.id ? primary.variant.id : companion.variant.id,
          targetId,
          ...(operation ? { operation } : {}),
          ...(targetVersionId ? { targetVersionId } : {}),
          reason: 'MVP Core E2E public manual editing evidence.',
        },
      })).payload
      await cancelOperation(result.operation.id)
      return result
    }

    let primaryTimeline = await timeline(primary.project.id)
    // The cut kept three stretches of the master and left the insert the ingest placed after them, so the timeline has four clips; the ids of
    // the stretches are derived by the product, the insert keeps the id the ingest gave it. The edits below work on the last stretch of the master.
    assert.equal(primaryTimeline.timeline.clips.length, 4)
    assert.equal(primaryTimeline.timeline.clips.at(-1).id, 'ingest-insert-primary')
    const lastPrimaryClip = primaryTimeline.timeline.clips[2]
    const splitAtMs = lastPrimaryClip.startMs + 3000
    await manual(
      primary.project.id,
      primaryTimeline,
      { kind: 'split', clipId: lastPrimaryClip.id, atMs: splitAtMs },
      `primary-split-${suffix}`,
    )
    primaryTimeline = await timeline(primary.project.id)
    await manual(
      primary.project.id,
      primaryTimeline,
      {
        kind: 'replace',
        clipId: `${lastPrimaryClip.id}:a`,
        sourceId: artifactIds.primaryBroll,
      },
      `primary-replace-${suffix}`,
    )
    primaryTimeline = await timeline(primary.project.id)
    const trailingClip = primaryTimeline.timeline.clips.find(
      (clip) => clip.id === `${lastPrimaryClip.id}:b`,
    )
    await manual(
      primary.project.id,
      primaryTimeline,
      {
        kind: 'trim',
        clipId: trailingClip.id,
        edge: 'end',
        atMs: trailingClip.endMs - 200,
      },
      `primary-trim-${suffix}`,
    )
    primaryTimeline = await timeline(primary.project.id)
    const inspected = await manual(
      primary.project.id,
      primaryTimeline,
      {
        kind: 'inspect',
        clipId: primaryTimeline.timeline.clips[0].id,
        patch: {
          layout: 'face-safe-landscape-inset',
          text: 'Comunicação que gera impacto.',
          subtitle: 'clean-color',
          color: 'neutral-warm',
          motion: 'static',
          audioGain: 1,
        },
      },
      `primary-inspect-${suffix}`,
    )
    primaryTimeline = await timeline(primary.project.id)
    await manual(
      primary.project.id,
      primaryTimeline,
      {
        kind: 'inspect',
        clipId: primaryTimeline.timeline.clips[0].id,
        patch: { color: 'temporary-cool-test' },
      },
      `primary-inspect-temporary-${suffix}`,
    )
    primaryTimeline = await timeline(primary.project.id)
    await manual(
      primary.project.id,
      primaryTimeline,
      undefined,
      `primary-undo-${suffix}`,
      inspected.version.id,
    )

    let companionTimeline = await timeline(companion.project.id)
    // The companion's cut kept its one stretch of the master and left the insert the ingest placed after it.
    assert.equal(companionTimeline.timeline.clips.length, 2)
    assert.equal(companionTimeline.timeline.clips.at(-1).id, 'ingest-insert-companion')
    await manual(
      companion.project.id,
      companionTimeline,
      {
        kind: 'replace',
        clipId: companionTimeline.timeline.clips[0].id,
        sourceId: artifactIds.companionBroll,
      },
      `companion-replace-${suffix}`,
    )

    await new Promise((resolve) => setTimeout(resolve, 10))
    // A Version renders only under an explicit project LUT selection (the renderer refuses to guess a grade); this journey grades nothing and says so.
    async function selectNoLut(projectId, key) {
      const current = await timeline(projectId)
      const selected = (await api({
        method: 'POST',
        path: `/v1/projects/${projectId}/lut-selection`,
        key,
        expected: [201],
        body: {
          baseVersionId: current.timeline.versionId,
          baseHash: current.baseHash,
          selection: { mode: 'none' },
          reason: 'MVP Core E2E renders the sources as they are, without a creative LUT.',
        },
      })).payload
      if (selected.operation) await cancelOperation(selected.operation.id)
    }
    await selectNoLut(primary.project.id, `primary-no-lut-${suffix}`)
    primaryTimeline = await timeline(primary.project.id)
    const primaryDirector = (await api({
      method: 'POST',
      path: `/v1/projects/${primary.project.id}/commands`,
      key: `primary-final-director-${suffix}`,
      expected: [201],
      body: {
        type: 'run-director',
        baseVersionId: primaryTimeline.timeline.versionId,
        baseHash: primaryTimeline.baseHash,
        reason: 'Finalize the 9:16 talking-head direction with the selected B-roll and no gratuitous zoom.',
      },
    })).payload
    assert.equal(primaryDirector.directorRun.editPlan.automaticZoom, false)
    assert.equal(primaryDirector.directorRun.impact.commandType, 'run-director')
    assert.equal(primaryDirector.directorRun.impact.sourceTranscriptId, transcriptIds.primary)
    assert.equal(primaryDirector.directorRun.impact.renderSemanticsChanged, true)
    assert.equal(primaryDirector.operation.type, 'project-proxy-render')
    assert.equal(
      primaryDirector.directorRun.decisions.some((decision) =>
        decision.category === 'insert' &&
        decision.choice === 'use_selected_insert'),
      true,
    )
    await selectNoLut(companion.project.id, `companion-no-lut-${suffix}`)
    companionTimeline = await timeline(companion.project.id)
    const companionDirector = (await api({
      method: 'POST',
      path: `/v1/projects/${companion.project.id}/commands`,
      key: `companion-final-director-${suffix}`,
      expected: [201],
      body: {
        type: 'run-director',
        baseVersionId: companionTimeline.timeline.versionId,
        baseHash: companionTimeline.baseHash,
        reason: 'Finalize a no-person voiceover video using the selected visual source.',
      },
    })).payload
    assert.equal(companionDirector.directorRun.treatmentPlan.plan.mode, 'visual-montage')
    assert.equal(companionDirector.directorRun.impact.minimalRenders[0].variantId, companion.variant.id)

    async function runProxyUntilTerminal(expectedOperationId) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const outcome = await runWorkerOnce('proxy')
        assert.equal(outcome.operationId, expectedOperationId)
        if (outcome.status === 'succeeded') return outcome
        if (outcome.status !== 'retrying') {
          const diagnostic = await api({
            path: `/v1/operations/${expectedOperationId}`,
          })
          assert.fail(`proxy render failed: ${JSON.stringify(diagnostic.payload)}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      const diagnostic = await api({
        path: `/v1/operations/${expectedOperationId}`,
      })
      assert.fail(`proxy render exhausted retries: ${JSON.stringify(diagnostic.payload)}`)
    }
    const primaryProxyOutcome = await runProxyUntilTerminal(
      primaryDirector.operation.id,
    )
    assert.deepEqual(primaryProxyOutcome, {
      operationId: primaryDirector.operation.id,
      status: 'succeeded',
    })
    const companionProxyOutcome = await runProxyUntilTerminal(
      companionDirector.operation.id,
    )
    assert.deepEqual(companionProxyOutcome, {
      operationId: companionDirector.operation.id,
      status: 'succeeded',
    })

    async function acknowledgeReview(projectId, projectVersionId, key) {
      const review = (await api({
        path: `/v1/projects/${projectId}/proxy-reviews?projectVersionId=${projectVersionId}`,
      })).payload.review
      assert.equal(review.status, 'warning-ack-required')
      assert.equal(review.criticIssues.some((issue) =>
        Array.isArray(issue.rangeMs) || typeof issue.targetId === 'string'), true)
      const acknowledged = (await api({
        method: 'POST',
        path: `/v1/projects/${projectId}/proxy-reviews`,
        key,
        expected: [201],
        body: {
          action: 'acknowledge-warnings',
          proxyReviewId: review.id,
          projectVersionId,
          baseRevision: review.reviewHash,
          expectedRevision: review.revision,
        },
      })).payload.review
      assert.equal(acknowledged.status, 'ready-for-final')
      assert.equal(acknowledged.finalAllowed, true)
      return acknowledged
    }
    const primaryReview = await acknowledgeReview(
      primary.project.id,
      primaryDirector.version.id,
      `primary-review-${suffix}`,
    )
    await acknowledgeReview(
      companion.project.id,
      companionDirector.version.id,
      `companion-review-${suffix}`,
    )

    async function enqueueExport(projectId, version, format, key) {
      return (await api({
        method: 'POST',
        path: `/v1/projects/${projectId}/exports`,
        key,
        expected: [202],
        body: {
          projectVersionId: version.id,
          projectVersionHash: version.baseHash,
          format,
          approval: {
            approved: true,
            note: 'Approved by the full public MVP Core E2E.',
          },
        },
      })).payload
    }

    const primaryExport = await enqueueExport(
      primary.project.id,
      primaryDirector.version,
      '9:16',
      `primary-export-${suffix}`,
    )
    const retryOutcome = await runWorkerOnce('final', {
      FFMPEG_PATH: process.execPath,
    })
    assert.deepEqual(retryOutcome, {
      operationId: primaryExport.operation.id,
      status: 'retrying',
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.deepEqual(
      await runWorkerOnce('final'),
      {
        operationId: primaryExport.operation.id,
        status: 'succeeded',
      },
    )

    const companionExport = await enqueueExport(
      companion.project.id,
      companionDirector.version,
      '16:9',
      `companion-export-${suffix}`,
    )
    assert.deepEqual(
      await runWorkerOnce('final'),
      {
        operationId: companionExport.operation.id,
        status: 'succeeded',
      },
    )

    async function finalOutput(operationId, expectedStatuses) {
      const attempts = (await api({
        path: `/v1/operations/${operationId}/final-export-attempts`,
      })).payload
      assert.deepEqual(
        attempts.attempts.map((attempt) => attempt.status),
        expectedStatuses,
      )
      const promoted = attempts.attempts.find(
        (attempt) => attempt.status === 'promoted',
      )
      assert.ok(promoted)
      return promoted.output
    }
    const primaryOutput = await finalOutput(
      primaryExport.operation.id,
      ['failed', 'promoted'],
    )
    const companionOutput = await finalOutput(
      companionExport.operation.id,
      ['promoted'],
    )

    const primaryFinalArtifact = await client.v2MediaArtifact.findUniqueOrThrow({
      where: { id: primaryOutput.artifactId },
    })
    const companionFinalArtifact = await client.v2MediaArtifact.findUniqueOrThrow({
      where: { id: companionOutput.artifactId },
    })
    const primaryFinalPath = join(
      artifactRoot,
      ...primaryFinalArtifact.artifactKey.split('/'),
    )
    const companionFinalPath = join(
      artifactRoot,
      ...companionFinalArtifact.artifactKey.split('/'),
    )
    const primaryFinalProbe = await probeVideo(primaryFinalPath)
    const companionFinalProbe = await probeVideo(companionFinalPath)
    assert.deepEqual(
      [primaryFinalProbe.width, primaryFinalProbe.height],
      [1080, 1920],
    )
    assert.deepEqual(
      [companionFinalProbe.width, companionFinalProbe.height],
      [1920, 1080],
    )
    assert.ok(primaryFinalProbe.duration > 79 && primaryFinalProbe.duration < 81)
    assert.ok(companionFinalProbe.duration > 4 && companionFinalProbe.duration < 4.6)

    const primaryReviewPath = join(evidenceRoot, 'apollo-primary-9x16.mp4')
    const companionReviewPath = join(evidenceRoot, 'apollo-companion-16x9.mp4')
    await copyFile(primaryFinalPath, primaryReviewPath)
    await copyFile(companionFinalPath, companionReviewPath)

    const annotation = (await api({
      method: 'POST',
      path: `/v1/projects/${primary.project.id}/annotations`,
      key: `primary-region-annotation-${suffix}`,
      expected: [201],
      body: {
        projectVersionId: primaryDirector.version.id,
        proxyArtifactId: primaryOutput.artifactId,
        proxyHash: primaryOutput.sha256,
        frame: 30,
        timeRangeMs: [1000, 1000],
        screenshotRef: 'data:image/jpeg;base64,/9j/2Q==',
        scope: 'region',
        region: { x: 0.08, y: 0.68, width: 0.84, height: 0.22 },
        targetIds: [],
        text: 'Manter a legenda abaixo do rosto e dentro da área segura.',
      },
    })).payload.annotation
    assert.equal(annotation.scope, 'region')
    const proposal = (await api({
      method: 'POST',
      path: `/v1/projects/${primary.project.id}/patch-proposals`,
      key: `primary-region-proposal-${suffix}`,
      expected: [201],
      body: { annotationId: annotation.id },
    })).payload.proposal
    assert.equal(proposal.status, 'ready')
    const appliedPatch = (await api({
      method: 'POST',
      path: `/v1/projects/${primary.project.id}/patch-proposals/${proposal.id}/apply`,
      key: `primary-region-apply-${suffix}`,
      expected: [201],
      body: { confirmed: true },
    })).payload
    assert.equal(appliedPatch.proposal.status, 'applied')
    await cancelOperation(appliedPatch.operation.id)

    const duplicate = (await api({
      method: 'POST',
      path: `/v1/projects/${primary.project.id}/duplicates`,
      key: `primary-duplicate-${suffix}`,
      expected: [201],
      body: {
        expectedVersionId: appliedPatch.version.id,
        expectedVersionHash: appliedPatch.version.baseHash,
        name: 'Imersão — copy-on-write proof',
      },
    })).payload

    const gate = (await api({
      method: 'POST',
      path: `/v1/projects/${primary.project.id}/mvp-core-gates`,
      key: `mvp-core-full-gate-${suffix}`,
      expected: [201],
      body: {
        primaryVersionId: appliedPatch.version.id,
        primaryVersionHash: appliedPatch.version.baseHash,
        companionProjectId: companion.project.id,
        companionVersionId: companionDirector.version.id,
        companionVersionHash: companionDirector.version.baseHash,
        duplicateProjectId: duplicate.project.id,
      },
    })).payload.gate
    assert.equal(gate.report.covered, 16)
    assert.equal(gate.report.passed, 16)
    assert.equal(gate.report.total, 16)
    assert.equal(gate.report.approved, true)
    assert.equal(gate.report.serverEvidenceOnly, true)
    assert.equal(gate.report.evidence.every((criterion) =>
      criterion.passed &&
      criterion.checks.every((check) =>
        check.passed && check.references.length > 0)), true)

    const evidence = {
      cutStateAssertion,
      governanceWaits,
      schemaVersion: 'mvp-core-full-e2e-evidence/v1',
      workspaceId,
      primaryProjectId: primary.project.id,
      companionProjectId: companion.project.id,
      duplicateProjectId: duplicate.project.id,
      gateId: gate.id,
      gateRecordHash: gate.recordHash,
      gateReportFingerprint: gate.reportFingerprint,
      exclusions: primaryCut.editorial.exclusions,
      primary: {
        operationId: primaryExport.operation.id,
        artifactId: primaryOutput.artifactId,
        sha256: primaryOutput.sha256,
        outputPath: primaryReviewPath,
        probe: primaryFinalProbe,
      },
      companion: {
        operationId: companionExport.operation.id,
        artifactId: companionOutput.artifactId,
        sha256: companionOutput.sha256,
        outputPath: companionReviewPath,
        probe: companionFinalProbe,
      },
      validatedAt: new Date().toISOString(),
    }
    await writeFile(
      join(evidenceRoot, 'mvp-core-full-e2e.json'),
      `${JSON.stringify(evidence, null, 2)}\n`,
      'utf8',
    )
    journeyCompleted = true
  } finally {
    if (server && server.exitCode === null) {
      server.kill()
      await Promise.race([
        once(server, 'exit'),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ])
    }
    await client.$disconnect()
    if (journeyCompleted) {
      await rm(artifactRoot, { recursive: true, force: true }).catch(() => {})
    }
  }
})
