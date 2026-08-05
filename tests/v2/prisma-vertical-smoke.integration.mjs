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

import {
  createExternalAuditContext,
} from '../../src/v2/application/authenticate-api-client.ts'
import { createColorPipelineCompilationService } from '../../src/v2/application/color-pipeline-compilations.ts'
import { createApiClientService } from '../../src/v2/application/create-api-client.ts'
import { enqueueProjectProxyRenderService } from '../../src/v2/application/enqueue-project-proxy-render.ts'
import { runNextMediaIngestOperationService } from '../../src/v2/application/run-media-ingest-worker.ts'
import { runNextProjectProxyRenderOperationService } from '../../src/v2/application/run-project-proxy-render-worker.ts'
import { runProjectDirectorService } from '../../src/v2/application/run-project-director.ts'
import { setProjectLutSelectionService } from '../../src/v2/application/project-lut-selections.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createMediaTranscript } from '../../src/v2/domain/media-transcript.ts'
import { createWorkspace } from '../../src/v2/domain/workspace.ts'
import { FfmpegEditorialProxyRenderer } from '../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts'
import { FfmpegIngestProcessor } from '../../src/v2/infrastructure/media/ffmpeg-ingest-processor.ts'
import { LocalArtifactSourceMaterializer, LocalMediaUploadStorage } from '../../src/v2/infrastructure/media/local-media-upload-storage.ts'
import {
  createArtifactS3ClientFromEnvironment,
  S3ArtifactSourceMaterializer,
  S3VerifiedMediaStorage,
} from '../../src/v2/infrastructure/media/s3-artifact-storage.ts'
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

function identityColorStages(metadata) {
  const implementation = (provider, parameters) => ({
    provider,
    version: 'v1',
    parameters,
    parametersHash: calculateCanonicalHash(parameters),
  })
  return [
    { id: 'technical-source', kind: 'technical', version: 'v1', enabled: true, output: metadata, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
    { id: 'match-bypass', kind: 'match', version: 'v1', enabled: false, output: metadata, implementation: implementation('apollo-match', { mode: 'bypass' }) },
    { id: 'creative-none', kind: 'creative-lut', version: 'v1', enabled: false, output: metadata, implementation: implementation('apollo-lut', { mode: 'none' }) },
    { id: 'output-source', kind: 'output', version: 'v1', enabled: true, output: metadata, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
  ]
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
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
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
  const localStorage = new LocalMediaUploadStorage(root)
  const useS3 = process.env.APOLLO_V2_S3_RECONSTRUCTION_SMOKE === '1'
  const s3 = useS3 ? createArtifactS3ClientFromEnvironment(process.env) : undefined
  const storage = s3 ? new S3VerifiedMediaStorage(localStorage, s3) : localStorage
  const operations = new PrismaPublicOperationRepository(prisma)
  const artifacts = new PrismaMediaArtifactRepository(prisma)
  const telemetryEvents = []
  const telemetry = {
    emit(event) { telemetryEvents.push(event) },
  }

  try {
    await createFixture(fixturePath)
    await new PrismaWorkspaceRepository(prisma).create(createWorkspace({
      id: workspaceId,
      slug: `vertical-${randomUUID()}`,
      name: 'Vertical Smoke Workspace',
      status: 'active',
      createdAt: clock().toISOString(),
    }))
    const issuedClient = await createApiClientService({
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
    const proxyAuditContext = createExternalAuditContext({
      clientId, credentialId: issuedClient.credential.id, workspaceId, environment: 'sandbox',
    })
    const proxyActor = Object.freeze({
      ...proxyAuditContext, scopes: new Set(['projects:write']), authenticationKind: 'bearer',
      clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
      clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext: proxyAuditContext,
    })

    const ingest = runNextMediaIngestOperationService({
      operations,
      telemetry,
      uploads: new PrismaMediaTransferRepository(prisma),
      artifacts,
      projectMedia: new PrismaProjectMediaRepository(prisma),
      storage,
      processor: new FfmpegIngestProcessor({ workRoot: join(root, '.ingest-work'), ffmpegPath }),
      prober: { probe: probeVideo },
      providers: {
        resolveTranscription() {
          return { create() { return { async transcribe() {
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
          } }
        } }
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
        credentialId: issuedClient.credential.id,
        apiEnvironment: 'sandbox',
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
    const proxyProjects = new PrismaProjectProxyRenderRepository(prisma)
    const colorPipelines = new PrismaColorPipelineCompilationRepository(prisma)
    const staticSource = await proxyProjects.readCurrentSource({ workspaceId, projectId: seed.project.id })
    assert.ok(staticSource)
    const sourceProbe = await colorPipelines.loadTrustedProbe({
      workspaceId,
      projectId: seed.project.id,
      sourceArtifactId: staticSource.sourceArtifactId,
      sourceManifestId: staticSource.sourceManifestId,
    })
    assert.equal(sourceProbe?.detection.state, 'ready')
    const sourceMetadata = sourceProbe.detection.metadata
    const compiledColor = await createColorPipelineCompilationService({
      repository: colorPipelines,
      createId: () => 'vertical-color-pipeline-source',
      clock,
    })({
      workspaceId,
      projectId: seed.project.id,
      sourceArtifactId: staticSource.sourceArtifactId,
      sourceManifestId: staticSource.sourceManifestId,
      outputMetadata: sourceMetadata,
      stages: identityColorStages(sourceMetadata),
      actor: proxyActor,
      idempotencyKey: 'vertical-smoke-color-source-v1',
    })
    assert.equal(compiledColor.replayed, false)
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
      actor: proxyActor,
      idempotency: { key: 'vertical-smoke-director-v1' },
      reason: 'Compile the deterministic vertical smoke plan.',
    })
    assert.equal(directed.run.status, 'planned')
    assert.equal(directed.run.editPlan.movementPolicy.automaticZoom, false)
    assert.ok(directed.run.editPlan.subtitleTracks[0].cues.length > 0)
    const lutSelections = new PrismaProjectLutSelectionRepository(prisma)
    const noLut = await setProjectLutSelectionService({
      repository: lutSelections,
      createId: (kind) => `vertical-lut-${kind}-${randomUUID()}`,
      createEventId: randomUUID,
      clock,
    })({
      workspaceId,
      projectId: seed.project.id,
      baseVersionId: directed.version.id,
      baseHash: directed.version.baseHash,
      selection: { mode: 'none' },
      actor: proxyActor,
      idempotencyKey: 'vertical-smoke-lut-none-v1',
      reason: 'Keep the controlled vertical smoke colorimetrically neutral.',
    })
    assert.equal(noLut.selection.resolved.mode, 'none')
    assert.equal(noLut.version.parentVersionId, directed.version.id)

    if (useS3) {
      await rm(join(root, 'workspaces'), { recursive: true, force: true })
      assert.equal(await stat(join(root, 'workspaces')).catch(() => null), null)
    }

    const enqueued = await enqueueProjectProxyRenderService({
      projects: proxyProjects,
      operations,
      colorPipelines,
      clock,
      createId: (kind) => `vertical-${kind}-${randomUUID()}`,
    })({
      workspaceId,
      projectId: seed.project.id,
      expectedProjectVersionId: noLut.version.id,
      actor: proxyActor,
      idempotencyKey: 'vertical-smoke-proxy-v1',
    })
    const ffmpegRenderer = new FfmpegEditorialProxyRenderer({
      workRoot: join(root, '.render-work'),
      ffmpegPath,
    })
    let observedRenderError
    const observedRenderer = {
      async render(input) {
        try {
          return await ffmpegRenderer.render(input)
        } catch (error) {
          observedRenderError = error
          throw error
        }
      },
      cleanup(operationId) {
        return ffmpegRenderer.cleanup(operationId)
      },
    }
    const render = runNextProjectProxyRenderOperationService({
      operations,
      telemetry,
      projects: proxyProjects,
      artifacts,
      storage,
      renderer: observedRenderer,
      renderElementMaps: new PrismaRenderElementMapRepository(prisma),
      proxyReviews: new PrismaProxyReviewRepository(prisma),
      colorPipelines,
      luts: new LocalProjectLutRenderMaterializer(
        lutSelections,
        join(root, '.lut-work'),
      ),
      sources: s3
        ? new S3ArtifactSourceMaterializer(join(root, '.s3-render-materialized'), s3)
        : new LocalArtifactSourceMaterializer(root),
      clock,
      leaseDurationMs: 60_000,
      heartbeatIntervalMs: 10_000,
    })
    const renderOutcome = await waitForWork(
      () => render(`vertical-render-${randomUUID()}`),
      Date.now() + 120_000,
      'project proxy render operation',
    )
    const completed = await operations.findById(workspaceId, enqueued.operation.id)
    assert.equal(
      renderOutcome.status,
      'succeeded',
      completed?.operation.error
        ? `${completed.operation.error.code}: ${observedRenderError instanceof Error ? observedRenderError.message : completed.operation.error.message}`
        : 'Project proxy worker returned no persisted failure detail',
    )
    assert.equal(completed.operation.status, 'succeeded')
    assert.equal(completed.context.kind, 'project-proxy-render')
    const outputManifest = await prisma.v2MediaArtifactManifest.findUniqueOrThrow({
      where: { id: completed.context.outputManifestId },
      select: { manifestJson: true },
    })
    const outputManifestDocument = JSON.parse(outputManifest.manifestJson)
    const verificationMaterializer = s3
      ? new S3ArtifactSourceMaterializer(join(root, '.s3-fresh-verification'), s3)
      : new LocalArtifactSourceMaterializer(root)
    const verifiedOutput = await verificationMaterializer.materialize({
      operationId: 'vertical-smoke-fresh-verification',
      artifactKey: outputManifestDocument.artifact.artifactKey,
      sha256: outputManifestDocument.artifact.sha256,
      byteSize: outputManifestDocument.artifact.byteSize,
    })
    const outputPath = verifiedOutput.path
    const outputStat = await stat(outputPath)
    const outputProbe = await probeVideo(outputPath)
    assert.ok(outputStat.size > 0)
    assert.equal(outputProbe.width, 540)
    assert.equal(outputProbe.height, 960)
    assert.ok(Math.abs(outputProbe.duration - 6) < 0.15)
    assert.match(outputManifestDocument.artifact.sha256, /^[a-f0-9]{64}$/)
    await verificationMaterializer.cleanup('vertical-smoke-fresh-verification')
    assert.equal(await prisma.v2RenderElementMap.count({
      where: { workspaceId, projectId: seed.project.id, projectVersionId: noLut.version.id },
    }), 1)
    const spans = telemetryEvents.filter((event) =>
      event.schemaVersion === 'public-operation-span-telemetry/v1')
    assert.deepEqual(
      spans.map((event) => [event.spanName, event.event]),
      [
        ['ffmpeg-media-normalize', 'operation.span-started'],
        ['ffmpeg-media-normalize', 'operation.span-succeeded'],
        ['media-transcription', 'operation.span-started'],
        ['media-transcription', 'operation.span-succeeded'],
        ['ffmpeg-editorial-proxy', 'operation.span-started'],
        ['ffmpeg-editorial-proxy', 'operation.span-succeeded'],
      ],
    )
    assert.equal(
      spans.filter((event) => event.event === 'operation.span-succeeded')
        .every((event) => Number.isSafeInteger(event.durationMs) && event.durationMs >= 0),
      true,
    )
    for (const spanName of [
      'ffmpeg-media-normalize',
      'media-transcription',
      'ffmpeg-editorial-proxy',
    ]) {
      const pair = spans.filter((event) => event.spanName === spanName)
      assert.equal(new Set(pair.map((event) => event.traceId)).size, 1)
      assert.equal(new Set(pair.map((event) => event.jobId)).size, 1)
      assert.equal(pair.every((event) => event.workspaceId === workspaceId), true)
    }
  } finally {
    await prisma.v2Workspace.deleteMany({ where: { id: workspaceId } }).catch(() => undefined)
    await prisma.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})
