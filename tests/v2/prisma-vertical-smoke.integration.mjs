import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

import {
  createExternalAuditContext,
} from '../../src/v2/application/authenticate-api-client.ts'
import { beginMediaUploadService } from '../../src/v2/application/begin-media-upload.ts'
import { createColorPipelineCompilationService } from '../../src/v2/application/color-pipeline-compilations.ts'
import { createApiClientService } from '../../src/v2/application/create-api-client.ts'
import { enqueueMediaIngestService } from '../../src/v2/application/enqueue-media-ingest.ts'
import { enqueueProjectProxyRenderService } from '../../src/v2/application/enqueue-project-proxy-render.ts'
import { issueMediaUploadSessionService } from '../../src/v2/application/issue-media-upload-session.ts'
import { completeMediaUploadService } from '../../src/v2/application/manage-media-upload.ts'
import { receiveMediaUploadContentService } from '../../src/v2/application/receive-media-upload-content.ts'
import { runNextMediaIngestOperationService } from '../../src/v2/application/run-media-ingest-worker.ts'
import { runNextProjectProxyRenderOperationService } from '../../src/v2/application/run-project-proxy-render-worker.ts'
import { runProjectDirectorService } from '../../src/v2/application/run-project-director.ts'
import { setProjectLutSelectionService } from '../../src/v2/application/project-lut-selections.ts'
import { setProjectPolicyOverridesService } from '../../src/v2/application/project-policy-overrides.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createMediaTranscript } from '../../src/v2/domain/media-transcript.ts'
import { createWorkspace } from '../../src/v2/domain/workspace.ts'
import { FfmpegEditorialProxyRenderer } from '../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts'
import { FfmpegIngestProcessor } from '../../src/v2/infrastructure/media/ffmpeg-ingest-processor.ts'
import { LocalArtifactSourceMaterializer, LocalMediaUploadStorage } from '../../src/v2/infrastructure/media/local-media-upload-storage.ts'
import { SharpImageAnalysisProcessor } from '../../src/v2/infrastructure/media/sharp-image-analysis-processor.ts'
import { calculateFileSha256 } from '../../src/v2/infrastructure/media/local-artifact-manifest.ts'
import {
  createArtifactS3ClientFromEnvironment,
  S3ArtifactSourceMaterializer,
  S3VerifiedMediaStorage,
} from '../../src/v2/infrastructure/media/s3-artifact-storage.ts'
import { LocalProjectLutRenderMaterializer } from '../../src/v2/infrastructure/media/local-project-lut-render-materializer.ts'
import { inspectUploadedMedia, probeVideo } from '../../src/v2/infrastructure/media/video-probe.ts'
import { PrismaApiClientRepository } from '../../src/v2/infrastructure/prisma/api-client-repository.ts'
import { PrismaAssetRightsRepository } from '../../src/v2/infrastructure/prisma/asset-rights-repository.ts'
import { PrismaColorPipelineCompilationRepository } from '../../src/v2/infrastructure/prisma/color-pipeline-compilation-repository.ts'
import { PrismaDirectorRunRepository } from '../../src/v2/infrastructure/prisma/director-run-repository.ts'
import { createEvidenceBoundBriefCompiler } from '../../src/v2/infrastructure/brief/evidence-bound-brief-compiler-model.ts'
import { PrismaMediaArtifactRepository } from '../../src/v2/infrastructure/prisma/media-artifact-repository.ts'
import { PrismaImageAnalysisRepository } from '../../src/v2/infrastructure/prisma/image-analysis-repository.ts'
import { PrismaMediaTransferRepository } from '../../src/v2/infrastructure/prisma/media-transfer-repository.ts'
import { PrismaProjectLutSelectionRepository } from '../../src/v2/infrastructure/prisma/project-lut-selection-repository.ts'
import { PrismaProjectPolicyOverridesRepository } from '../../src/v2/infrastructure/prisma/project-policy-overrides-repository.ts'
import { PrismaProjectMediaRepository } from '../../src/v2/infrastructure/prisma/project-media-repository.ts'
import { PrismaProjectProxyRenderRepository } from '../../src/v2/infrastructure/prisma/project-proxy-render-repository.ts'
import { PrismaProxyReviewRepository } from '../../src/v2/infrastructure/prisma/proxy-review-repository.ts'
import { PrismaPublicOperationRepository } from '../../src/v2/infrastructure/prisma/public-operation-repository.ts'
import { PrismaRenderElementMapRepository } from '../../src/v2/infrastructure/prisma/render-element-map-repository.ts'
import { PrismaWorkspaceRepository } from '../../src/v2/infrastructure/prisma/workspace-repository.ts'
import { nodeApiCredentialCrypto } from '../../src/v2/infrastructure/security/api-credential.ts'
import { createMediaUploadSessionSignerFromEnvironment } from '../../src/v2/infrastructure/security/media-upload-session-signer.ts'
import { seedV2ProjectSource } from '../../scripts/seed-v2-project-source.mjs'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const execFileAsync = promisify(execFile)

function monotonicClock() {
  let now = Date.now() - 1_000
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

async function createLibraryFixtures(root) {
  const audio = join(root, 'library-audio.wav')
  const image = join(root, 'library-image.jpg')
  await execFileAsync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    'sine=frequency=660:sample_rate=48000:duration=1', '-c:a', 'pcm_s16le', audio,
  ], { windowsHide: true, timeout: 120_000 })
  await execFileAsync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    'color=c=green:s=640x480', '-frames:v', '1', image,
  ], { windowsHide: true, timeout: 120_000 })
  return { audio, image }
}

test('T-F0-030/T-FR-014 real PostgreSQL vertical smoke uploads without briefing, directs media-only and renders a proxy', {
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
  const observedIngestFailures = []
  const diagnosticOperations = new Proxy(operations, {
    get(target, property) {
      if (property === 'failOrRetry') return async (input) => {
        observedIngestFailures.push(input.error)
        process.stderr.write(`[vertical-smoke ingest failure] ${JSON.stringify(input.error)}\n`)
        return target.failOrRetry(input)
      }
      const value = target[property]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const artifacts = new PrismaMediaArtifactRepository(prisma)
  const telemetryEvents = []
  const telemetry = {
    emit(event) { telemetryEvents.push(event) },
  }

  try {
    await createFixture(fixturePath)
    const libraryFixtures = await createLibraryFixtures(root)
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
      operations: diagnosticOperations,
      telemetry,
      uploads: new PrismaMediaTransferRepository(prisma),
      artifacts,
      projectMedia: new PrismaProjectMediaRepository(prisma),
      storage,
      processor: new FfmpegIngestProcessor({ workRoot: join(root, '.ingest-work'), ffmpegPath }),
      prober: { probe: probeVideo },
      inspector: { inspect: inspectUploadedMedia },
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
      imageAnalysis: { processor: new SharpImageAnalysisProcessor(join(root, '.image-analysis-work')), repository: new PrismaImageAnalysisRepository(prisma), integrity: { sha256: calculateFileSha256 } },
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
    assert.deepEqual(observedIngestFailures, [])

    const projectStatusBeforeLibrary = (await prisma.v2Project.findUniqueOrThrow({
      where: { id: seed.project.id }, select: { status: true },
    })).status
    const transfers = new PrismaMediaTransferRepository(prisma)
    const mediaActor = Object.freeze({ ...proxyActor, scopes: new Set(['media:write']) })
    const uploadSigner = createMediaUploadSessionSignerFromEnvironment({
      APOLLO_MEDIA_UPLOAD_SIGNING_SECRET: 'vertical-smoke-signing-secret-32-bytes-minimum',
    })
    const uploadLibraryInput = async ({ path, kind, mimeType, role }) => {
      const bytes = await readFile(path)
      const checksum = createHash('sha256').update(bytes).digest('hex')
      const begun = await beginMediaUploadService({ repository: transfers, clock })({
        workspaceId, actor: mediaActor, projectId: seed.project.id,
        fileName: path.split(/[\\/]/).at(-1), rightsConfirmed: true,
        idempotencyKey: `vertical-library-${kind}-${checksum}`, kind,
        size: String(bytes.length), mimeType, checksum,
      })
      const issued = await issueMediaUploadSessionService({
        repository: transfers, signer: uploadSigner, clock,
      })({ workspaceId, actor: mediaActor, uploadId: begun.upload.id })
      assert.equal(issued.session.mode, 'single')
      await receiveMediaUploadContentService({ repository: transfers, storage: localStorage, clock })({
        workspaceId, clientId, uploadId: begun.upload.id, mode: 'single', maxParts: 1,
        sessionExpiresAt: issued.session.expiresAt, mimeType,
        expectedSha256: checksum, body: new Blob([bytes]).stream(), contentLength: bytes.length,
      })
      const completed = await completeMediaUploadService({
        repository: transfers, verifier: localStorage, clock,
      })({ workspaceId, actor: mediaActor, uploadId: begun.upload.id })
      await enqueueMediaIngestService({ operations, clock })({ upload: completed.upload, actor: mediaActor })
      const outcome = await ingest(`vertical-library-${kind}-${randomUUID()}`)
      assert.equal(outcome.status, 'succeeded')
      const storedUpload = await prisma.v2MediaUpload.findUniqueOrThrow({ where: { id: begun.upload.id } })
      assert.equal(storedUpload.inspectionStatus, 'usable')
      assert.equal(storedUpload.detectedMimeType, mimeType)
      assert.ok(storedUpload.probeJson)
      const asset = await prisma.v2ProjectMediaAsset.findFirstOrThrow({
        where: { uploadId: begun.upload.id }, include: { artifact: { select: { mediaType: true } } },
      })
      assert.equal(asset.role, role)
      assert.equal(asset.artifact.mediaType, kind)
      const project = await prisma.v2Project.findUniqueOrThrow({
        where: { id: seed.project.id }, select: { status: true },
      })
      assert.equal(project.status, projectStatusBeforeLibrary)
      return asset
    }
    await uploadLibraryInput({ path: libraryFixtures.audio, kind: 'audio', mimeType: 'audio/wav', role: 'source-audio' })
    const imageAsset = await uploadLibraryInput({ path: libraryFixtures.image, kind: 'image', mimeType: 'image/jpeg', role: 'source-image' })
    const imageAnalysis = await prisma.v2ImageAnalysis.findFirstOrThrow({ where: { workspaceId, artifactId: imageAsset.artifactId } })
    const imageAnalysisJson = JSON.parse(imageAnalysis.analysisJson)
    assert.deepEqual(imageAnalysisJson.dimensions, { width: 640, height: 480 })
    assert.equal(imageAnalysisJson.ocr.state, 'unavailable')
    assert.equal(imageAnalysisJson.faces.state, 'unavailable')
    assert.equal(imageAnalysisJson.objects.state, 'unavailable')
    assert.equal(imageAnalysisJson.derivatives.immutableOriginal, true)
    const imageLibrary = await prisma.v2MediaLibraryEntry.findUniqueOrThrow({ where: { artifactId: imageAsset.artifactId } })
    assert.equal(imageLibrary.thumbnailArtifactId, imageAnalysis.thumbnailArtifactId)
    assert.equal(await prisma.v2MediaArtifactLineage.count({ where: { workspaceId, sourceArtifactId: imageAsset.artifactId } }), 2)

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
      compileBrief: createEvidenceBoundBriefCompiler(),
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
    assert.equal(directed.run.treatmentPlan.mode, 'media-only')
    assert.equal(directed.run.treatmentPlan.confidence, .65)
    assert.equal(directed.run.treatmentPlan.grammar.primary, 'speaker')
    assert.ok(directed.run.treatmentPlan.assumptions.includes('briefing-absent'))
    assert.ok(directed.run.treatmentPlan.claimPolicy.observedClaims.length > 0)
    assert.deepEqual(directed.run.treatmentPlan.claimPolicy.proposedClaims, [])
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

    const inheritedPolicyBefore = await prisma.v2ProjectSnapshot.findUniqueOrThrow({
      where: { id: noLut.version.snapshotRefs.policies },
      select: { id: true, contentJson: true, contentHash: true },
    })
    const policyRepository = new PrismaProjectPolicyOverridesRepository(prisma)
    const policyResult = await setProjectPolicyOverridesService({
      repository: policyRepository,
      createId: (kind) => `vertical-policy-${kind}-${randomUUID()}`,
      createEventId: randomUUID,
      clock,
    })({
      workspaceId,
      projectId: seed.project.id,
      baseVersionId: noLut.version.id,
      baseHash: noLut.version.baseHash,
      overrides: {
        logo: { mode: 'none' },
        instagramHandle: { mode: 'none' },
        youtubeHandle: { mode: 'inherit' },
        professionalName: { mode: 'custom', value: 'Apollo Vertical Smoke' },
      },
      actor: proxyActor,
      idempotencyKey: 'vertical-smoke-policy-overrides-v1',
      reason: 'Disable project-only branding while preserving workspace policy.',
    })
    assert.equal(policyResult.command.type, 'set-project-policy-overrides')
    assert.equal(policyResult.version.parentVersionId, noLut.version.id)
    assert.equal(policyResult.policySnapshot.contentSchemaVersion, 2)
    assert.deepEqual(policyResult.resolved.logo, { value: null, origin: 'project-none' })
    assert.deepEqual(policyResult.resolved.instagramHandle, { value: null, origin: 'project-none' })
    assert.deepEqual(policyResult.resolved.professionalName, { value: 'Apollo Vertical Smoke', origin: 'project-custom' })
    assert.equal(policyResult.impact.renderBlockedUntilDirectorRun, true)
    assert.equal(policyResult.invalidations.length, 1)
    assert.equal(policyResult.invalidations[0].artifactId, completed.context.outputArtifactId)
    assert.equal(await prisma.v2ProjectProxyRenderOperation.count({
      where: { workspaceId, projectId: seed.project.id, projectVersionId: policyResult.version.id },
    }), 0, 'policy Command must not enqueue a render before DirectorRun')
    const inheritedPolicyAfter = await prisma.v2ProjectSnapshot.findUniqueOrThrow({
      where: { id: inheritedPolicyBefore.id },
      select: { id: true, contentJson: true, contentHash: true },
    })
    assert.deepEqual(inheritedPolicyAfter, inheritedPolicyBefore, 'project override must not mutate the inherited workspace policy snapshot')
    const currentPolicy = await policyRepository.readCurrent({ workspaceId, projectId: seed.project.id })
    assert.equal(currentPolicy.version.id, policyResult.version.id)
    assert.equal(currentPolicy.policySnapshot.id, policyResult.policySnapshot.id)
    assert.deepEqual(currentPolicy.overrides.logo, { mode: 'none' })
    assert.deepEqual(currentPolicy.resolved.professionalName, { value: 'Apollo Vertical Smoke', origin: 'project-custom' })
    const storedPolicyContent = JSON.parse(policyResult.policySnapshot.contentJson)
    assert.deepEqual(storedPolicyContent.workspaceDefaults.guardrails, [])
    assert.equal(storedPolicyContent.overrides.logo.mode, 'none')
    assert.equal(storedPolicyContent.resolved.logo.origin, 'project-none')
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
    t.diagnostic(JSON.stringify({
      directorRunId: directed.run.id,
      projectVersionId: noLut.version.id,
      treatmentSnapshotId: directed.command.payload.snapshotRefs.treatment,
      treatment: {
        mode: directed.run.treatmentPlan.mode,
        confidence: directed.run.treatmentPlan.confidence,
        observedClaimCount: directed.run.treatmentPlan.claimPolicy.observedClaims.length,
        proposedClaimCount: directed.run.treatmentPlan.claimPolicy.proposedClaims.length,
      },
      proxyOperationId: enqueued.operation.id,
      outputManifestId: completed.context.outputManifestId,
      artifact: {
        sha256: outputManifestDocument.artifact.sha256,
        byteSize: outputManifestDocument.artifact.byteSize,
        width: outputProbe.width,
        height: outputProbe.height,
        durationSeconds: outputProbe.duration,
      },
    }))
  } finally {
    await prisma.v2Workspace.deleteMany({ where: { id: workspaceId } }).catch(() => undefined)
    await prisma.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})
