import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

import { createApiClientService } from '../../src/v2/application/create-api-client.ts'
import { enqueueProjectProxyRenderService } from '../../src/v2/application/enqueue-project-proxy-render.ts'
import { runNextMediaIngestOperationService } from '../../src/v2/application/run-media-ingest-worker.ts'
import { runNextProjectProxyRenderOperationService } from '../../src/v2/application/run-project-proxy-render-worker.ts'
import { runProjectDirectorService } from '../../src/v2/application/run-project-director.ts'
import { createMediaTranscript } from '../../src/v2/domain/media-transcript.ts'
import { createWorkspace } from '../../src/v2/domain/workspace.ts'
import { FfmpegEditorialProxyRenderer } from '../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts'
import { FfmpegIngestProcessor } from '../../src/v2/infrastructure/media/ffmpeg-ingest-processor.ts'
import { LocalMediaUploadStorage } from '../../src/v2/infrastructure/media/local-media-upload-storage.ts'
import { LocalProjectLutRenderMaterializer } from '../../src/v2/infrastructure/media/local-project-lut-render-materializer.ts'
import { probeVideo } from '../../src/v2/infrastructure/media/video-probe.ts'
import { PrismaApiClientRepository } from '../../src/v2/infrastructure/prisma/api-client-repository.ts'
import { PrismaAssetRightsRepository } from '../../src/v2/infrastructure/prisma/asset-rights-repository.ts'
import { PrismaColorPipelineCompilationRepository } from '../../src/v2/infrastructure/prisma/color-pipeline-compilation-repository.ts'
import { PrismaDirectorRunRepository } from '../../src/v2/infrastructure/prisma/director-run-repository.ts'
import { PrismaMediaArtifactRepository } from '../../src/v2/infrastructure/prisma/media-artifact-repository.ts'
import { PrismaMediaTransferRepository } from '../../src/v2/infrastructure/prisma/media-transfer-repository.ts'
import { PrismaProjectLutSelectionRepository } from '../../src/v2/infrastructure/prisma/project-lut-selection-repository.ts'
import { PrismaProjectMediaRepository } from '../../src/v2/infrastructure/prisma/project-media-repository.ts'
import { PrismaProjectProxyRenderRepository } from '../../src/v2/infrastructure/prisma/project-proxy-render-repository.ts'
import { PrismaProxyReviewRepository } from '../../src/v2/infrastructure/prisma/proxy-review-repository.ts'
import { PrismaPublicOperationRepository } from '../../src/v2/infrastructure/prisma/public-operation-repository.ts'
import { PrismaRenderElementMapRepository } from '../../src/v2/infrastructure/prisma/render-element-map-repository.ts'
import { PrismaWorkspaceRepository } from '../../src/v2/infrastructure/prisma/workspace-repository.ts'
import { nodeApiCredentialCrypto } from '../../src/v2/infrastructure/security/api-credential.ts'
import { seedV2ProjectSource } from '../../scripts/seed-v2-project-source.mjs'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const execFileAsync = promisify(execFile)

function monotonicClock() {
  let now = Date.parse('2026-08-02T18:00:00.000Z')
  return () => new Date((now += 10))
}

async function waitForWork(run, deadline, label, signal) {
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error(`${label} polling was canceled`)
    const result = await run()
    if (result) return result
    await new Promise((resolve, reject) => {
      const canceled = () => {
        clearTimeout(timer)
        reject(new Error(`${label} polling was canceled`))
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', canceled)
        resolve()
      }, 25)
      timer.unref?.()
      signal?.addEventListener('abort', canceled, { once: true })
    })
  }
  throw new Error(`${label} was not claimed before its deadline`)
}

async function createFixture(path) {
  await execFileAsync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', path,
  ], { windowsHide: true, timeout: 120_000 })
}

test('T-F0-030 real PostgreSQL vertical smoke uploads, normalizes, directs and renders a proxy', {
  timeout: 240_000,
}, async (t) => {
  if (process.env.APOLLO_V2_VERTICAL_SMOKE !== '1') {
    t.skip('APOLLO_V2_VERTICAL_SMOKE=1 is required')
    return
  }
  const root = await mkdtemp(join(tmpdir(), 'apollo-v2-vertical-smoke-'))
  const fixturePath = join(root, 'fixture.mp4')
  const workspaceId = `vertical-workspace-${randomUUID()}`
  const clientId = `vertical-client-${randomUUID()}`
  const prisma = new PrismaClient()
  const clock = monotonicClock()
  const storage = new LocalMediaUploadStorage(root)
  const operations = new PrismaPublicOperationRepository(prisma)
  const artifacts = new PrismaMediaArtifactRepository(prisma)

  try {
    await createFixture(fixturePath)
    await new PrismaWorkspaceRepository(prisma).create(createWorkspace({
      id: workspaceId,
      slug: `vertical-${randomUUID()}`,
      name: 'Vertical Smoke Workspace',
      status: 'active',
      createdAt: clock().toISOString(),
    }))
    await createApiClientService({
      repository: new PrismaApiClientRepository(prisma),
      credentialCrypto: nodeApiCredentialCrypto,
      clock,
    })({
      id: clientId,
      credentialId: `credential-${randomUUID()}`,
      workspaceId,
      name: 'Vertical smoke client',
      environment: 'sandbox',
      scopes: ['media:write', 'projects:read', 'projects:write'],
    })

    const ingest = runNextMediaIngestOperationService({
      operations,
      uploads: new PrismaMediaTransferRepository(prisma),
      artifacts,
      projectMedia: new PrismaProjectMediaRepository(prisma),
      storage,
      processor: new FfmpegIngestProcessor({ workRoot: join(root, '.ingest-work'), ffmpegPath }),
      transcriber: {
        async transcribe() {
          return createMediaTranscript({
            language: 'pt-BR',
            text: 'Apollo transforma uma gravação em uma história clara e segura.',
            provider: 'controlled',
            model: 'vertical-smoke/v1',
            words: [
              { word: 'Apollo', start: 0.2, end: 0.7 },
              { word: 'transforma', start: 0.75, end: 1.25 },
              { word: 'uma', start: 1.3, end: 1.55 },
              { word: 'gravação', start: 1.6, end: 2.15 },
              { word: 'em', start: 2.2, end: 2.4 },
              { word: 'uma', start: 2.45, end: 2.7 },
              { word: 'história', start: 2.75, end: 3.25 },
              { word: 'clara', start: 3.3, end: 3.75 },
              { word: 'e', start: 3.8, end: 3.95 },
              { word: 'segura.', start: 4, end: 4.55 },
            ],
            segments: [{
              id: 0,
              text: 'Apollo transforma uma gravação em uma história clara e segura.',
              start: 0.2,
              end: 4.55,
              confidence: 1,
            }],
          })
        },
      },
      rights: new PrismaAssetRightsRepository(prisma),
      clock,
      leaseDurationMs: 60_000,
      heartbeatIntervalMs: 10_000,
    })
    const seedPromise = seedV2ProjectSource({
      client: prisma,
      arguments: {
        seedId: 'vertical-smoke-v1',
        workspaceId,
        clientId,
        projectName: 'Vertical Smoke Project',
        sourceFile: fixturePath,
        sourceMime: 'video/mp4',
        waitSeconds: 60,
        objective: 'discovery',
        format: '9:16',
        locale: 'pt-BR',
        briefing: 'Preservar a fala e evitar qualquer movimento de câmera sem justificativa.',
      },
      environment: {
        ...process.env,
        APOLLO_V2_ARTIFACT_ROOT: root,
        APOLLO_MEDIA_UPLOAD_SIGNING_SECRET: 'vertical-smoke-signing-secret-32-bytes-minimum',
      },
      clock,
    })
    const ingestPolling = new AbortController()
    const ingestOutcomePromise = waitForWork(
      () => ingest(`vertical-ingest-${randomUUID()}`),
      Date.now() + 60_000,
      'media ingest operation',
      ingestPolling.signal,
    )
    let seed
    let ingestOutcome
    try {
      [seed, ingestOutcome] = await Promise.all([seedPromise, ingestOutcomePromise])
    } finally {
      ingestPolling.abort()
      await Promise.allSettled([seedPromise, ingestOutcomePromise])
    }
    assert.equal(ingestOutcome.status, 'succeeded')
    assert.equal(seed.ingestOperation.status, 'succeeded')

    const projectAfterIngest = await prisma.v2Project.findUniqueOrThrow({
      where: { id: seed.project.id },
      select: { currentVersionId: true },
    })
    assert.notEqual(projectAfterIngest.currentVersionId, seed.project.versionId)
    const baseVersion = await prisma.v2ProjectVersion.findUniqueOrThrow({
      where: { id: projectAfterIngest.currentVersionId },
    })
    assert.equal(baseVersion.sequence, 2)
    assert.equal(baseVersion.parentVersionId, seed.project.versionId)
    const ingestPlanSnapshot = await prisma.v2ProjectSnapshot.findUniqueOrThrow({
      where: { id: baseVersion.editPlanSnapshotId },
    })
    const ingestPlan = JSON.parse(ingestPlanSnapshot.contentJson)
    assert.equal(ingestPlan.editorial.commandType, 'source-ingest')
    assert.equal(ingestPlan.videoTracks[0].clips.length, 1)
    assert.equal(ingestPlan.videoTracks[0].clips[0].sourceArtifactId, seed.source.artifactId)
    assert.equal(ingestPlan.editorial.exclusions.length, 0)
    const counters = new Map()
    const directed = await runProjectDirectorService({
      repository: new PrismaDirectorRunRepository(prisma),
      clock,
      createId(kind) {
        const next = (counters.get(kind) ?? 0) + 1
        counters.set(kind, next)
        return `vertical-${kind}-${next}`
      },
      createEventId: randomUUID,
    })({
      workspaceId,
      projectId: seed.project.id,
      baseVersionId: baseVersion.id,
      baseHash: baseVersion.baseHash,
      actor: { type: 'api-client', id: clientId },
      idempotency: { key: 'vertical-smoke-director-v1' },
      reason: 'Compile the deterministic vertical smoke plan.',
    })
    assert.equal(directed.run.status, 'planned')
    assert.equal(directed.run.editPlan.movementPolicy.automaticZoom, false)
    assert.ok(directed.run.editPlan.subtitleTracks[0].cues.length > 0)

    const enqueued = await enqueueProjectProxyRenderService({
      projects: new PrismaProjectProxyRenderRepository(prisma),
      operations,
      colorPipelines: new PrismaColorPipelineCompilationRepository(prisma),
      clock,
      createId: (kind) => `vertical-${kind}-${randomUUID()}`,
    })({
      workspaceId,
      projectId: seed.project.id,
      expectedProjectVersionId: directed.version.id,
      actor: { type: 'api-client', id: clientId },
      idempotencyKey: 'vertical-smoke-proxy-v1',
    })
    const render = runNextProjectProxyRenderOperationService({
      operations,
      projects: new PrismaProjectProxyRenderRepository(prisma),
      artifacts,
      storage,
      renderer: new FfmpegEditorialProxyRenderer({ workRoot: join(root, '.render-work'), ffmpegPath }),
      renderElementMaps: new PrismaRenderElementMapRepository(prisma),
      proxyReviews: new PrismaProxyReviewRepository(prisma),
      colorPipelines: new PrismaColorPipelineCompilationRepository(prisma),
      luts: new LocalProjectLutRenderMaterializer(
        new PrismaProjectLutSelectionRepository(prisma),
        join(root, '.lut-work'),
      ),
      artifactRoot: root,
      clock,
      leaseDurationMs: 60_000,
      heartbeatIntervalMs: 10_000,
    })
    const renderOutcome = await waitForWork(
      () => render(`vertical-render-${randomUUID()}`),
      Date.now() + 120_000,
      'project proxy render operation',
    )
    assert.equal(renderOutcome.status, 'succeeded')

    const completed = await operations.findById(workspaceId, enqueued.operation.id)
    assert.equal(completed.operation.status, 'succeeded')
    assert.equal(completed.context.kind, 'project-proxy-render')
    const outputManifest = await prisma.v2MediaArtifactManifest.findUniqueOrThrow({
      where: { id: completed.context.outputManifestId },
      select: { artifactKey: true, artifactSha256: true },
    })
    const outputPath = join(root, outputManifest.artifactKey)
    const outputStat = await stat(outputPath)
    const outputProbe = await probeVideo(outputPath)
    assert.ok(outputStat.size > 0)
    assert.equal(outputProbe.width, 540)
    assert.equal(outputProbe.height, 960)
    assert.ok(Math.abs(outputProbe.duration - 6) < 0.15)
    assert.match(outputManifest.artifactSha256, /^[a-f0-9]{64}$/)
    assert.equal(await prisma.v2RenderElementMap.count({
      where: { workspaceId, projectId: seed.project.id, projectVersionId: directed.version.id },
    }), 1)
  } finally {
    await prisma.v2Workspace.deleteMany({ where: { id: workspaceId } }).catch(() => undefined)
    await prisma.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})
