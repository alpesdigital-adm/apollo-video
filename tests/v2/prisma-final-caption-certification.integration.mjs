import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { resetDisposableDatabase } from './helpers/disposable-database.mjs'

/**
 * W65b PostgreSQL + FFmpeg proof of the final-export gate (written for a supervised run; not run in CI).
 *
 * Nothing here is a stand-in for the thing being proved: the gate is the REAL `PrismaProjectFinalExportRepository` over real
 * PostgreSQL, the Director report is the one the Director really produces (`review-required`, face safety UNKNOWN, never
 * upgraded), the worker is the real final worker with the real caption planner, the real FFmpeg renderer and the real C1 pixel
 * critic. The project is the sealed world the product builds (creation Command, one explicit 9:16 output variant, the source's
 * persisted ingest, child Commands), as in the final-export E2E. Four finals are produced from the same two masters (a landscape
 * one and a portrait one):
 *
 *   A  landscape master + a cue   -> the bottom band lies over the blurred copy: certified by geometry, BURNED
 *   B  landscape master, no cue   -> the control of A
 *   C  portrait master  + a cue   -> the picture fills the canvas and no face window exists: uncertifiable, OMITTED and LISTED
 *   D  portrait master, no cue    -> the control of C
 *
 * and the pixels of the delivered MP4s are compared: A differs from B only under the cue and only inside the bottom band; C is
 * pixel-identical to D (the omitted cue left nothing behind). A dishonest Director report is refused by the same gate.
 */
const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const ffmpegStatic = require('ffmpeg-static')

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const FPS = 30
const DURATION = 120
const CUE = Object.freeze({ id: 'cue-w65b-1', startFrame: 30, endFrame: 90, text: 'Legenda certificada no final', anchor: 'bottom' })
const IN_CUE_FRAMES = Object.freeze([35, 60, 85])
const OUT_OF_CUE_FRAMES = Object.freeze([5, 15, 100, 115])

function qualityReportFor({ suffix, evaluatedAt, createQualityReport, resolveStrategicRubric, hardChecks = {} }) {
  const rubric = resolveStrategicRubric('discovery')
  const strategic = createQualityReport({ objective: 'discovery',
    evidence: rubric.criteria.map((criterion) => ({ criterionId: criterion.id, score: 100, evidence: [`controlled:${criterion.id}`] })),
    gates: { narrativeIntegrity: true, legibility: true, rights: true }, evaluatedAt })
  return {
    schemaVersion: 'director-quality-report/v3', id: `quality-report-${suffix}`, desiredActionRef: { id: `action-${suffix}` },
    status: 'review-required', strategic, score: 1,
    // The report the Director really produces: face safety UNKNOWN and nothing else to reserve.
    faceSafety: { status: 'unknown', reasonCode: 'FACE_PERCEPTION_UNAVAILABLE', evidenceRefs: [] },
    hardChecks: { openingMotionProtected: true, automaticZoomDisabled: true, subtitlesFaceSafe: false, subtitlesBounded: true,
      forbiddenSpeechAbsent: true, timelineContinuous: true, ...hardChecks },
    issues: [{ code: 'FACE_PERCEPTION_UNAVAILABLE_REVIEW_REQUIRED', severity: 'warning', category: 'editorial',
      message: 'Face detector evidence is unavailable. Caption placement requires review before approval or final export.', correctable: true }],
    criticVersion: 'project-director-critic/v2', evaluatedAt,
  }
}

test('T-W65B final export through the real gate: a certified cue is burned and confirmed in pixels, an uncertifiable one is omitted and listed', {
  skip: process.env.APOLLO_FINAL_CAPTION_E2E !== '1' && 'set APOLLO_FINAL_CAPTION_E2E=1 and use an isolated V2 database (supervised harness)',
  timeout: 900_000,
}, async () => {
  assert.ok(process.env.V2_DATABASE_URL, 'V2_DATABASE_URL must point to an isolated PostgreSQL database')
  const artifactRoot = process.env.APOLLO_V2_ARTIFACT_ROOT?.trim() ?? ''
  assert.equal(isAbsolute(artifactRoot), true, 'APOLLO_V2_ARTIFACT_ROOT must be absolute')
  const ffmpegBin = process.env.FFMPEG_BIN?.trim() || ffmpegStatic
  assert.ok(ffmpegBin && isAbsolute(ffmpegBin), 'a pinned absolute FFmpeg binary is required')
  const evidenceDir = process.env.APOLLO_W65B_EVIDENCE_DIR?.trim() || ''

  const { assetRightsRevision } = await import('../../src/v2/domain/asset-rights.ts')
  const { calculateVersionHash, stableSerialize } = await import('../../src/v2/application/version-hash.ts')
  const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
  const { createQualityReport, resolveStrategicRubric } = await import('../../src/v2/domain/strategic-rubric.ts')
  const { createMediaArtifactManifestV2 } = await import('../../src/v2/domain/media-artifact.ts')
  const { enqueueProjectFinalExportService } = await import('../../src/v2/application/enqueue-project-final-export.ts')
  const { runNextProjectFinalExportOperationService } = await import('../../src/v2/application/run-project-final-export-worker.ts')
  const { setProjectLutSelectionService } = await import('../../src/v2/application/project-lut-selections.ts')
  const { setAssetRightsService } = await import('../../src/v2/application/set-asset-rights.ts')
  const { commitSealedChild, testActor } = await import('./helpers/pg-output-world.mjs')
  const { registerColorPipeline, registerMeasuredVideo, seedReviewProject } = await import('./helpers/review-edit-world.mjs')
  const {
    createArtifactSourceMaterializer, createAutomaticCatalogService, createColorPipelineCompilationRepository,
    createMediaArtifactPersistenceRepository, createProjectColorPlanRepository, createProjectLutSelectionRepository,
    createRenderElementMapRepository, createWorkspaceLutRepository,
  } = await import('../../src/v2/infrastructure/repository-factory.ts')
  const { createFfmpegEditorialProxyRendererFromEnvironment } = await import('../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts')
  const { createLocalMediaUploadStorageFromEnvironment } = await import('../../src/v2/infrastructure/media/local-media-upload-storage.ts')
  const { LocalProjectLutRenderMaterializer } = await import('../../src/v2/infrastructure/media/local-project-lut-render-materializer.ts')
  const { FfmpegCaptionPixelCritic, captionFootprintOf, MIN_CHANGED_PIXELS } = await import('../../src/v2/infrastructure/media/ffmpeg-caption-pixel-critic.ts')
  const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
  const { PrismaAssetRightsRepository } = await import('../../src/v2/infrastructure/prisma/asset-rights-repository.ts')
  const { PrismaFaceWindowEnvelopeRepository } = await import('../../src/v2/infrastructure/prisma/face-window-envelope-repository.ts')
  const { PrismaProjectLutSelectionRepository } = await import('../../src/v2/infrastructure/prisma/project-lut-selection-repository.ts')
  const { PrismaProjectFinalExportRepository } = await import('../../src/v2/infrastructure/prisma/project-final-export-repository.ts')
  const { PrismaPublicOperationRepository } = await import('../../src/v2/infrastructure/prisma/public-operation-repository.ts')
  const { createProtectedPayloadCipherFromEnvironment } = await import('../../src/v2/infrastructure/security/recipe-parameter-cipher.ts')
  const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
  const { createPerceptionTimeline } = await import('../../src/v2/domain/perception-timeline.ts')
  const { readOutputFormatPreset } = await import('../../src/v2/domain/output-format-registry.ts')
  const { deriveSubtitleRegion } = await import('../../src/v2/domain/subtitle-region.ts')
  const { deriveSubtitleAnchorBands } = await import('../../src/v2/domain/subtitle-anchor-plan.ts')
  const { CAPTION_BAND_TOLERANCE_PX } = await import('../../src/v2/domain/caption-pixel-verdict.ts')

  const client = new PrismaClient()
  const databaseName = new URL(process.env.V2_DATABASE_URL).pathname.slice(1)
  assert.match(databaseName, /(?:^|_)e2e(?:_|$)/, 'destructive E2E setup requires an explicitly isolated database')
  await resetDisposableDatabase(client)
  const suffix = randomUUID().slice(0, 8)
  const createdAt = new Date('2026-07-26T20:00:00.000Z')
  const protectedPayloadKeyId = `final-caption-${suffix}`
  const protectedPayloadKey = Buffer.alloc(32, 9).toString('base64url')
  const workerEnvironment = {
    ...process.env, APOLLO_V2_ARTIFACT_ROOT: artifactRoot, APOLLO_V2_ARTIFACT_STORAGE_DRIVER: 'local', FFMPEG_PATH: ffmpegBin,
    APOLLO_V2_RENDER_LEASE_MS: '300000', APOLLO_V2_RENDER_HEARTBEAT_MS: '5000', APOLLO_V2_WORKER_RETRY_BASE_MS: '1', APOLLO_V2_WORKER_RETRY_MAX_MS: '1',
    APOLLO_PROTECTED_PAYLOAD_KEY_ID: protectedPayloadKeyId, APOLLO_PROTECTED_PAYLOAD_KEY: protectedPayloadKey,
  }
  const scratch = await mkdtemp(join(tmpdir(), 'w65b-'))
  const evidence = []
  let primaryError

  /** Generates one test master once; every world that uses it copies the same bytes, so a pixel difference is never the source. */
  const masters = new Map()
  async function master(label, width, height) {
    if (masters.has(label)) return masters.get(label)
    const path = join(scratch, `${label}.mp4`)
    await execFileAsync(ffmpegBin, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${FPS}`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', path],
    { windowsHide: true, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })
    const bytes = await readFile(path)
    const entry = Object.freeze({ path, bytes, sha256: sha256(bytes), width, height })
    masters.set(label, entry)
    return entry
  }

  /**
   * One complete world, the way the product builds it: root + explicit 9:16 variant, the source's persisted ingest, a child
   * Command that plays it, the neutral LUT, the Version of a Director run whose report is `review-required` with UNKNOWN face
   * safety, and the ready proxy review the final is approved from.
   */
  async function seedWorld({ key, source, cues, hardChecks }) {
    const id = (name) => `w65b-${key}-${name}-${suffix}`
    const workspaceId = id('workspace'), projectId = id('project'), baseVersionId = id('base'), projectVersionId = id('version')
    const directorRunId = id('director'), sourceArtifactId = id('source'), sourceManifestId = id('source-manifest')
    const proxyArtifactId = id('proxy'), proxyManifestId = id('proxy-manifest'), proxyOperationId = id('proxy-operation')
    const proxyReviewId = id('proxy-review'), editPlanSnapshotId = id('edit-plan'), qualitySnapshotId = id('quality')
    const sourceArtifactKey = `workspaces/w65b-${suffix}-${key}/masters/source.mp4`
    const sourcePath = join(artifactRoot, ...sourceArtifactKey.split('/'))
    await mkdir(dirname(sourcePath), { recursive: true })
    await copyFile(source.path, sourcePath)
    await client.v2Workspace.create({ data: { id: workspaceId, slug: workspaceId, name: `W65b ${key}`, status: 'active', createdAt, updatedAt: createdAt } })
    const issued = await createApiClientService({ repository: new PrismaApiClientRepository(client), credentialCrypto: nodeApiCredentialCrypto, clock: () => createdAt })({
      id: id('client'), workspaceId, name: `W65b ${key}`, environment: 'production',
      scopes: ['projects:read', 'projects:write', 'operations:read', 'artifacts:read'] })
    const actor = testActor({ workspaceId, clientId: issued.client.id, credentialId: issued.credential.id, environment: 'production',
      scopes: ['projects:read', 'projects:write', 'operations:read', 'artifacts:read'] })
    await seedReviewProject(client, { workspaceId, actor, prefix: `w65b-${key}`, ids: { project: projectId }, name: `W65b ${key}`,
      objective: 'discovery', aspectRatio: '9:16', status: 'reviewing-proxy' })
    // The ingest ran before the controlled instant of the rest of the fixture, so its operation is the older one.
    const registered = await registerMeasuredVideo(client, { workspaceId, projectId, actor, artifactId: sourceArtifactId,
      artifactKey: sourceArtifactKey, sha256: source.sha256, byteSize: source.bytes.byteLength,
      probe: { width: source.width, height: source.height, duration: 4, fps: FPS }, slug: `w65b-${key}-${suffix}`, manifestId: sourceManifestId,
      originalFileName: 'w65b-source.mp4', recipeId: 'source-master', createdAt: new Date(createdAt.getTime() - 60_000) })
    await registerColorPipeline(client, { workspaceId, projectId, actor, artifactId: sourceArtifactId, manifestId: sourceManifestId, createdAt })
    await setAssetRightsService({ repository: new PrismaAssetRightsRepository(client), clock: () => createdAt, createId: () => id('rights') })({
      workspaceId, artifactId: sourceArtifactId, baseRevision: assetRightsRevision(sourceArtifactId, 0),
      draft: { status: 'approved', allowedUses: ['rendering', 'editorial-reuse'], prohibitedUses: [], allowedLocales: ['pt-BR'],
        consent: { status: 'approved', allowedUses: ['rendering', 'editorial-reuse'], allowedLocales: ['pt-BR'] } },
      actor: { type: 'api-client', id: issued.client.id } })

    const landscape = source.width >= source.height
    const editPlan = {
      schemaVersion: 2, state: 'compiled', id: id('plan'), projectVersionId, fps: FPS, durationFrames: DURATION,
      videoTracks: [{ id: id('track'), kind: 'base-video', clips: [{ id: id('clip'), sourceArtifactId, sourceInFrame: 0,
        sourceOutFrame: DURATION, timelineInFrame: 0, timelineOutFrame: DURATION, rate: 1 }] }],
      sources: [{ id: sourceArtifactId, artifactId: sourceArtifactId, kind: 'video', durationSeconds: 4 }],
      overlayTracks: [], audioTracks: [], effectTracks: [], markers: [], protectedElements: [],
      localeVariantRefs: [], formatVariantRefs: [], lineageRefs: [sourceArtifactId],
      subtitleTracks: cues.length ? [{ id: 'track-captions', kind: 'captions', presetId: 'clean-color', anchor: 'bottom', faceProtection: true,
        maxLines: 2, maxCharactersPerBlock: 32, cues: cues.map((cue) => ({ ...cue })) }] : [],
      transitions: [], movementPolicy: { automaticZoom: false, protectedOpeningFrames: 120 },
      ...(landscape ? { composition: { layout: 'landscape-inset', background: 'blurred-source', foregroundScale: 1, verticalPosition: 0.5,
        faceSafeFallback: [0.08, 0.08, 0.84, 0.84], subtitleSafeRegion: [0.08, 0.68, 0.84, 0.22] } } : {}),
    }
    const baseEditPlan = { ...editPlan, id: id('base-plan'), projectVersionId: baseVersionId }
    const baseBundle = await commitSealedChild(client, { workspaceId, projectId, actor, suffix: id('base-commit'),
      versionId: baseVersionId, mutatePlan: () => baseEditPlan, adopt: [sourceArtifactId] })
    const noLut = await setProjectLutSelectionService({
      repository: new PrismaProjectLutSelectionRepository(client), createId: (kind) => `${id('lut')}-${kind}`, createEventId: randomUUID, clock: () => createdAt,
    })({ workspaceId, projectId, baseVersionId: baseBundle.version.id, baseHash: baseBundle.version.baseHash,
      selection: { mode: 'none' }, actor, idempotencyKey: id('lut-none'), reason: 'Keep this fixture colorimetrically neutral.' })
    assert.equal(noLut.selection.resolved.mode, 'none')
    // The run's own snapshots. A snapshot is inserted, never edited: the quality report is the one the run persisted.
    const qualityReport = qualityReportFor({ suffix: `${key}-${suffix}`, evaluatedAt: createdAt.toISOString(), createQualityReport, resolveStrategicRubric, hardChecks })
    const snapshotIds = { perception: id('perception'), treatment: id('treatment'), story: id('story'), quality: qualitySnapshotId }
    for (const [snapshotId, kind, schemaVersion, content] of [
      [snapshotIds.perception, 'perception', 1, { schemaVersion: 1, id: snapshotIds.perception,
        timeline: createPerceptionTimeline({ durationMs: 4_000, observations: [] }),
        summary: { id: `${snapshotIds.perception}-summary`, speechCoverage: 0, visualCoverage: 'absent', faceCoverage: 'absent', confidence: 0,
          sourceTranscriptId: id('transcript') } }],
      [snapshotIds.treatment, 'treatment', 1, { schemaVersion: 1, state: 'complete' }],
      [snapshotIds.story, 'story', 1, { schemaVersion: 1, state: 'complete' }],
      [snapshotIds.quality, 'quality-report', 3, qualityReport],
    ]) {
      await client.v2ProjectSnapshot.create({ data: { id: snapshotId, workspaceId, projectId, kind, schemaVersion,
        contentJson: stableSerialize(content), contentHash: calculateVersionHash(content), createdAt } })
    }
    // The Director run's Version: a real child Command (run-director) over the neutral-LUT Version, playing the same source.
    const directedBundle = await commitSealedChild(client, { workspaceId, projectId, actor, suffix: id('run-commit'),
      type: 'run-director', versionId: projectVersionId, snapshotId: editPlanSnapshotId, mutatePlan: () => editPlan })
    const projectVersionHash = directedBundle.version.baseHash
    await client.v2DirectorRun.create({ data: { id: directorRunId, workspaceId, projectId, commandId: directedBundle.origin.command.id,
      baseVersionId: noLut.version.id, resultVersionId: projectVersionId, status: 'succeeded', objective: 'discovery', objectiveVersion: 1,
      rubricRef: 'awareness-discovery/v1', plannerVersion: 'director-e2e-1.0.0', criticVersion: 'critic-e2e-1.0.0',
      perceptionSnapshotId: snapshotIds.perception, treatmentSnapshotId: snapshotIds.treatment, storySnapshotId: snapshotIds.story,
      editPlanSnapshotId, qualitySnapshotId, decisionsJson: stableSerialize([]), assumptionsJson: stableSerialize([]),
      initiatedByType: 'api-client', initiatedById: issued.client.id, createdAt, updatedAt: createdAt } })

    // The approved proxy: controlled metadata only (the one declared byte is not a rendered MP4); its review is ready-for-final.
    const proxySha256 = calculateVersionHash({ proxyArtifactId })
    const proxyArtifactKey = `workspaces/w65b-${suffix}-${key}/proxies/proxy.mp4`
    const proxyManifest = createMediaArtifactManifestV2({
      artifactKey: proxyArtifactKey, artifactSha256: proxySha256, byteSize: 1, mediaType: 'video', container: 'mp4',
      recipe: { id: 'editorial-proxy', version: '1.0.0', parameters: { proxyManifestId, parameters: true } },
      sources: [{ artifactKey: sourceArtifactKey, sha256: source.sha256, role: 'source-master',
        execution: { tool: { id: 'controlled-fixture-metadata', version: '1.0.0', digest: sha256(await readFile(new URL(import.meta.url))) } } }] })
    await client.v2MediaArtifact.create({ data: { id: proxyArtifactId, workspaceId, artifactKey: proxyArtifactKey,
      sha256: proxySha256, byteSize: 1n, mediaType: 'video', container: 'mp4', status: 'available', createdAt } })
    await client.v2MediaArtifactManifest.create({ data: { id: proxyManifestId, workspaceId, artifactId: proxyArtifactId,
      schemaVersion: proxyManifest.schemaVersion, manifestHash: proxyManifest.manifestHash, recipeId: proxyManifest.recipe.id,
      recipeVersion: proxyManifest.recipe.version, parametersHash: proxyManifest.recipe.parametersHash, manifestJson: stableSerialize(proxyManifest), createdAt } })
    await client.v2ProjectMediaAsset.create({ data: { id: randomUUID(), workspaceId, projectId, artifactId: proxyArtifactId,
      role: 'editorial-proxy', originalFileName: 'w65b-proxy.mp4', createdAt } })
    const proxyInputHash = calculateVersionHash({ projectVersionId, proxyArtifactId })
    await client.v2PublicOperation.create({ data: { id: proxyOperationId, workspaceId, projectId, clientId: issued.client.id,
      type: 'project-proxy-render', status: 'succeeded', phase: 'completed', progressCompleted: 4, progressTotal: 4, progressUnit: 'render',
      targetType: 'media-artifact', targetId: proxyArtifactId, cancelable: false, retryable: false, attempt: 1, maxAttempts: 3,
      actorCredentialId: actor.auditContext.credentialId, actorEnvironment: actor.auditContext.environment,
      actorAuthenticationKind: actor.auditContext.authenticationKind, actorContextHash: actor.auditContext.contextHash,
      resultJson: stableSerialize({ resource: { type: 'media-artifact', id: proxyArtifactId, manifestId: proxyManifestId } }),
      idempotencyKey: id('proxy-key'), requestFingerprint: proxyInputHash, createdAt, updatedAt: createdAt, startedAt: createdAt, completedAt: createdAt } })
    await client.v2ProjectProxyRenderOperation.create({ data: { operationId: proxyOperationId, workspaceId, projectId, projectVersionId,
      editPlanSnapshotId, sourceArtifactId, sourceManifestId, inputHash: proxyInputHash, colorPipelineBindingsJson: stableSerialize([]),
      outputArtifactId: proxyArtifactId, outputManifestId: proxyManifestId, originalFileName: 'w65b-proxy.mp4', createdAt } })
    await client.v2ProxyReview.create({ data: { id: proxyReviewId, workspaceId, projectId, projectVersionId, operationId: proxyOperationId,
      proxyArtifactId, proxyManifestId, inputHash: proxyInputHash, outputSpecId: 'preset-9x16',
      rangeCacheKey: calculateVersionHash({ proxyReviewId, ranges: [] }),
      specJson: stableSerialize({ width: 540, height: 960, codec: 'h264', container: 'mp4', quality: 'review', reusableRanges: true }),
      status: 'ready-for-final', technicalIssuesJson: stableSerialize([]), criticIssuesJson: stableSerialize([]), warningsAcknowledged: false,
      finalAllowed: true, reviewHash: calculateVersionHash({ proxyReviewId, projectVersionId, proxyArtifactId, status: 'ready-for-final' }),
      revision: 1, uploadReceivedAt: createdAt, renderCompletedAt: createdAt, timeToFirstProxyMs: 0n, createdAt, updatedAt: createdAt } })
    return Object.freeze({ key, workspaceId, projectId, projectVersionId, projectVersionHash, directorRunId, qualitySnapshotId, qualityReport, actor,
      registered })
  }

  const finalRepository = new PrismaProjectFinalExportRepository(client)
  const operations = new PrismaPublicOperationRepository(client, randomUUID, () => createProtectedPayloadCipherFromEnvironment(workerEnvironment))
  const rights = new PrismaAssetRightsRepository(client)
  const enqueue = (world, tag) => enqueueProjectFinalExportService({ projects: finalRepository, rights, operations,
    colorPipelines: createColorPipelineCompilationRepository(), clock: () => new Date(),
    createId: (kind) => `w65b-${world.key}-${kind}-${tag}-${suffix}` })({
    workspaceId: world.workspaceId, projectId: world.projectId, projectVersionId: world.projectVersionId, projectVersionHash: world.projectVersionHash,
    format: '9:16', approval: { approved: true, note: 'W65b: face safety stays unknown; captions are certified per burned cue.' },
    actor: world.actor, idempotencyKey: `w65b-final-${world.key}-${tag}-${suffix}` })
  const worker = () => runNextProjectFinalExportOperationService({
    operations, projects: finalRepository, rights, artifacts: createMediaArtifactPersistenceRepository(workerEnvironment),
    storage: createLocalMediaUploadStorageFromEnvironment(workerEnvironment),
    renderer: createFfmpegEditorialProxyRendererFromEnvironment(workerEnvironment),
    renderElementMaps: createRenderElementMapRepository(), colorPipelines: createColorPipelineCompilationRepository(),
    colorPlans: createProjectColorPlanRepository(),
    luts: new LocalProjectLutRenderMaterializer(createProjectLutSelectionRepository(), join(resolve(artifactRoot), '.lut-work'), createWorkspaceLutRepository()),
    sources: createArtifactSourceMaterializer(workerEnvironment), catalogOutput: createAutomaticCatalogService(),
    faceEvidence: new PrismaFaceWindowEnvelopeRepository(client),
    captionPixelCritic: new FfmpegCaptionPixelCritic({ ffmpegPath: ffmpegBin }),
    leaseDurationMs: 300_000, heartbeatIntervalMs: 5_000, retryBaseDelayMs: 1, retryMaxDelayMs: 1,
  })

  /** Runs the whole chain for one world and returns the delivered MP4 (copied next to the test, away from the long artifact key). */
  async function finalFor(world) {
    const queued = await enqueue(world, 'one')
    assert.equal(queued.replayed, false)
    const outcome = await worker()(`w65b-worker-${world.key}-${suffix}`)
    const attempt = await client.v2ProjectFinalExportAttempt.findFirst({ where: { operationId: queued.operation.id }, orderBy: { attempt: 'desc' } })
    assert.deepEqual(outcome, { operationId: queued.operation.id, status: 'succeeded' }, JSON.stringify({ key: world.key, status: attempt?.status, code: attempt?.errorCode, message: attempt?.errorMessage }))
    const history = await finalRepository.readAttemptHistory({ workspaceId: world.workspaceId, operationId: queued.operation.id })
    const promoted = history.attempts.find((entry) => entry.status === 'promoted')
    assert.ok(promoted?.output, `${world.key}: the final was promoted`)
    const artifact = await client.v2MediaArtifact.findUniqueOrThrow({ where: { id: promoted.output.artifactId } })
    const delivered = join(scratch, `final-${world.key}.mp4`)
    await copyFile(join(artifactRoot, ...artifact.artifactKey.split('/')), delivered)
    assert.equal(sha256(await readFile(delivered)), promoted.output.sha256)
    const certification = promoted.validators.find((validator) => validator.code === 'FINAL_CAPTION_CERTIFICATION')
    assert.ok(certification, `${world.key}: the certification is part of the attempt record`)
    assert.equal(promoted.validators.every((validator) => validator.passed), true, `${world.key}: ${JSON.stringify(promoted.validators.filter((validator) => !validator.passed))}`)
    return Object.freeze({ world, operationId: queued.operation.id, output: promoted.output, certification, delivered })
  }

  async function frame(path, number, width, height) {
    const { stdout } = await execFileAsync(ffmpegBin, ['-hide_banner', '-loglevel', 'error', '-i', path, '-vf', `select='eq(n,${number})'`,
      '-frames:v', '1', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { encoding: 'buffer', windowsHide: true, timeout: 60_000, maxBuffer: width * height * 3 + 4096 })
    assert.equal(stdout.byteLength, width * height * 3, `frame ${number} of ${path} decoded`)
    return new Uint8Array(stdout.buffer, stdout.byteOffset, stdout.byteLength)
  }
  const sameBytes = (left, right) => left.byteLength === right.byteLength && Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0
  async function png(path, number, target) {
    await execFileAsync(ffmpegBin, ['-hide_banner', '-loglevel', 'error', '-y', '-i', path, '-vf', `select='eq(n,${number})'`, '-frames:v', '1', '-fps_mode', 'passthrough', target],
      { windowsHide: true, timeout: 60_000 })
  }

  try {
    const landscape = await master('landscape', 320, 180)
    const portrait = await master('portrait', 180, 320)

    // ---- the four finals ----
    const A = await finalFor(await seedWorld({ key: 'a', source: landscape, cues: [CUE] }))
    const B = await finalFor(await seedWorld({ key: 'b', source: landscape, cues: [] }))
    const C = await finalFor(await seedWorld({ key: 'c', source: portrait, cues: [CUE] }))
    const D = await finalFor(await seedWorld({ key: 'd', source: portrait, cues: [] }))
    for (const [label, entry] of Object.entries({ A, B, C, D })) {
      evidence.push({ label, key: entry.world.key, operationId: entry.operationId, sha256: entry.output.sha256, byteSize: entry.output.byteSize, certification: entry.certification.message })
    }

    // ---- the gate admitted the report as it is: face safety stayed unknown in the database ----
    for (const entry of [A, C]) {
      const stored = await client.v2ProjectSnapshot.findUniqueOrThrow({ where: { id: entry.world.qualitySnapshotId } })
      const report = JSON.parse(stored.contentJson)
      assert.equal(report.status, 'review-required')
      assert.deepEqual(report.faceSafety, { status: 'unknown', reasonCode: 'FACE_PERCEPTION_UNAVAILABLE', evidenceRefs: [] })
      assert.equal(report.hardChecks.subtitlesFaceSafe, false)
    }

    // ---- the attempt records say what was burned and what was left out ----
    assert.match(A.certification.message, /^1 caption\(s\) burned in certified bands, confirmed by the pixel critic \(ran\); 0 omitted and listed for review/)
    assert.match(C.certification.message, /^0 caption\(s\) burned in certified bands.*1 omitted and listed for review: cue-w65b-1 \(FACE_PERCEPTION_UNAVAILABLE\)/)
    assert.match(B.certification.message, /^0 caption\(s\) burned.*0 omitted/)
    assert.match(D.certification.message, /^0 caption\(s\) burned.*0 omitted/)

    // ---- pixels: A differs from B only under the cue, and only inside the bottom band ----
    const preset = readOutputFormatPreset('9:16')
    const { width, height } = { width: 1080, height: 1920 }
    const bands = deriveSubtitleAnchorBands({ region: deriveSubtitleRegion({ spec: preset.spec, presetId: 'clean-color' }), safeArea: preset.spec.safeArea })
    const bottom = bands.bottom
    const tolerance = { x: CAPTION_BAND_TOLERANCE_PX / width, y: CAPTION_BAND_TOLERANCE_PX / height }
    const pixelFacts = { burned: [], quiet: [], omitted: [] }
    // A and B are separate lossy encodes (the rate control of one sees a filter graph the other does not), so "no caption" is the
    // critic's own measure - no run of pixels whose luma moved by more than the codec noise - not byte equality.
    for (const number of OUT_OF_CUE_FRAMES) {
      const [withCue, control] = await Promise.all([frame(A.delivered, number, width, height), frame(B.delivered, number, width, height)])
      const measured = captionFootprintOf(withCue, control, width, height)
      assert.equal(measured.footprint, null, `A has no caption outside the cue (frame ${number}, ${measured.changedPixels} changed pixels)`)
      pixelFacts.quiet.push({ frame: number, changedPixels: measured.changedPixels, byteIdentical: sameBytes(withCue, control) })
    }
    for (const number of IN_CUE_FRAMES) {
      const [withCue, control] = await Promise.all([frame(A.delivered, number, width, height), frame(B.delivered, number, width, height)])
      const measured = captionFootprintOf(withCue, control, width, height)
      assert.ok(measured.changedPixels >= MIN_CHANGED_PIXELS && measured.footprint, `A burned a caption at frame ${number} (${measured.changedPixels} changed pixels)`)
      const box = measured.footprint
      assert.ok(box.x >= bottom.x - tolerance.x && box.y >= bottom.y - tolerance.y &&
        box.x + box.width <= bottom.x + bottom.width + tolerance.x && box.y + box.height <= bottom.y + bottom.height + tolerance.y,
      `the caption of frame ${number} is inside the bottom band: ${JSON.stringify({ box, bottom })}`)
      pixelFacts.burned.push({ frame: number, changedPixels: measured.changedPixels, footprint: box })
    }
    // ---- pixels: C is D - the omitted cue left nothing behind (every cue frame and every other one) ----
    const everyFrame = [...OUT_OF_CUE_FRAMES, ...IN_CUE_FRAMES, 30, 89]
    for (const number of everyFrame) {
      const [withOmitted, control] = await Promise.all([frame(C.delivered, number, width, height), frame(D.delivered, number, width, height)])
      const measured = captionFootprintOf(withOmitted, control, width, height)
      assert.equal(measured.footprint, null, `C has no caption (frame ${number}, ${measured.changedPixels} changed pixels): nothing was drawn for the omitted cue`)
      pixelFacts.omitted.push({ frame: number, changedPixels: measured.changedPixels, byteIdentical: sameBytes(withOmitted, control) })
    }
    // Informational: with no drawn cue the two filter graphs are the same, so an encoder that is deterministic gives the same bytes.
    const identicalBytes = C.output.sha256 === D.output.sha256

    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true })
      await png(A.delivered, 60, join(evidenceDir, 'final-A-burned-cue-frame-60.png'))
      await png(B.delivered, 60, join(evidenceDir, 'final-B-no-cue-frame-60.png'))
      await png(C.delivered, 60, join(evidenceDir, 'final-C-omitted-cue-frame-60.png'))
      await png(D.delivered, 60, join(evidenceDir, 'final-D-no-cue-frame-60.png'))
    }

    // ---- the same gate still refuses a dishonest report: a failed hard check is not "unknown face safety" ----
    const dishonest = await seedWorld({ key: 'e', source: landscape, cues: [CUE], hardChecks: { timelineContinuous: false } })
    await assert.rejects(enqueue(dishonest, 'one'), (error) => error.code === 'EDITORIAL_ACCEPTANCE_FAILED')
    assert.equal(await client.v2PublicOperation.count({ where: { workspaceId: dishonest.workspaceId, type: 'project-final-export' } }), 0)
    assert.equal(await client.v2ProjectFinalExportAttempt.count({ where: { workspaceId: dishonest.workspaceId } }), 0)
    // and a forged `approved` report (a claim of verified face safety it does not carry) is a persistence conflict, never an approval.
    // A stored snapshot cannot be updated (a trigger refuses it), so the forgery is a second quality-report snapshot, INSERTED with
    // the "approved" status and the Director run pointed at it inside a transaction that always rolls back.
    const honest = A.world
    const approvalInput = { workspaceId: honest.workspaceId, projectId: honest.projectId, projectVersionId: honest.projectVersionId,
      projectVersionHash: honest.projectVersionHash, outputSpecId: 'preset-9x16', requireCurrent: true }
    const forged = { ...honest.qualityReport, status: 'approved' }
    const forgedSnapshotId = `w65b-forged-quality-${suffix}`
    const rolledBack = new Error('forged approval rolled back')
    await assert.rejects(() => client.$transaction(async (transaction) => {
      await transaction.v2ProjectSnapshot.create({ data: { id: forgedSnapshotId, workspaceId: honest.workspaceId, projectId: honest.projectId,
        kind: 'quality-report', schemaVersion: 3, contentJson: stableSerialize(forged), contentHash: calculateVersionHash(forged), createdAt } })
      await transaction.v2DirectorRun.update({ where: { id: honest.directorRunId }, data: { qualitySnapshotId: forgedSnapshotId } })
      await assert.rejects(new PrismaProjectFinalExportRepository(transaction).readApproval(approvalInput), (error) => error.code === 'PERSISTENCE_CONFLICT')
      throw rolledBack
    }), (error) => error === rolledBack)
    assert.equal(await client.v2ProjectSnapshot.findUnique({ where: { id: forgedSnapshotId } }), null)
    const restored = await finalRepository.readApproval(approvalInput)
    assert.equal(restored.admissionBasis, 'per-cue-caption-certification')
    assert.equal(restored.qualityStatus, 'review-required')

    console.log(JSON.stringify({ event: 'w65b-final-caption-certification-proof', finals: evidence, pixelFacts, identicalBytesCvsD: identicalBytes,
      bottomBand: bottom, canvas: { width, height }, faceSafety: 'unknown', qualityStatus: 'review-required' }))
    if (evidenceDir) await writeFile(join(evidenceDir, 'w65b-final-caption-certification-proof.json'), JSON.stringify({ finals: evidence, pixelFacts, identicalBytesCvsD: identicalBytes, bottomBand: bottom }, null, 2))
  } catch (error) {
    primaryError = error
  } finally {
    const cleanupErrors = []
    for (const [name, action] of [
      ['repository-factory-prisma', async () => { const { disconnectV2PostgresClient } = await import('../../src/v2/infrastructure/prisma-postgres/client.ts'); await disconnectV2PostgresClient() }],
      ['fixture-prisma', () => client.$disconnect()],
      ['fixture-media', async () => {
        await rm(scratch, { recursive: true, force: true })
        // only what this run owns: the fixture masters and the outputs promoted under each world's workspace
        for (const key of ['a', 'b', 'c', 'd', 'e']) {
          await rm(join(artifactRoot, 'workspaces', `w65b-${suffix}-${key}`), { recursive: true, force: true })
          await rm(join(artifactRoot, 'workspaces', `w65b-${key}-workspace-${suffix}`), { recursive: true, force: true })
        }
      }],
    ]) {
      try { await action() } catch (error) { cleanupErrors.push(Object.assign(error, { cleanupStage: name })) }
    }
    if (cleanupErrors.length) throw new AggregateError(primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors, 'W65b fixture failed to clean up')
  }
  if (primaryError) throw primaryError
})
