import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { proveCatalogOutputBrowser } from './helpers/catalog-output-browser-proof.mjs'

// The persisted Director quality is review-required with unknown face safety.
// The public API must reject it. A separately injected, test-only approval port
// exercises export mechanics with real PostgreSQL, FFmpeg and artifact storage;
// this is not an end-to-end approval or facial-safety claim.
const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const ffmpegStatic = require('ffmpeg-static')
const ffprobeStatic = require('ffprobe-static')?.path

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

async function waitForServer(baseUrl, child) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Next server exited with ${child.exitCode}`)
    try { if ((await fetch(`${baseUrl}/v1/health`)).ok) return } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Next server did not become ready')
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function reviewRequiredQualityReport({ suffix, evaluatedAt, createQualityReport, resolveStrategicRubric }) {
  const rubric = resolveStrategicRubric('discovery')
  const strategic = createQualityReport({ objective: 'discovery',
    evidence: rubric.criteria.map((criterion) => ({ criterionId: criterion.id, score: 100,
      evidence: [`controlled:${criterion.id}`] })),
    gates: { narrativeIntegrity: true, legibility: true, rights: true }, evaluatedAt })
  return {
    schemaVersion: 'director-quality-report/v3',
    id: `final-export-quality-report-${suffix}`,
    desiredActionRef: { id: `final-export-action-${suffix}` },
    status: 'review-required',
    strategic,
    faceSafety: { status: 'unknown', reasonCode: 'FACE_PERCEPTION_UNAVAILABLE', evidenceRefs: [] },
    hardChecks: { openingMotionProtected: true, automaticZoomDisabled: true,
      subtitlesFaceSafe: false, subtitlesBounded: true, forbiddenSpeechAbsent: true,
      timelineContinuous: true },
    score: 1,
    issues: [],
    criticVersion: 'project-director-critic/v2',
    evaluatedAt,
  }
}

function emptyDirectorPerceptionSnapshot({ id, sourceTranscriptId, createPerceptionTimeline }) {
  return {
    schemaVersion: 1,
    id,
    timeline: createPerceptionTimeline({ durationMs: 4_000, observations: [] }),
    summary: { id: `${id}-summary`, speechCoverage: 0, visualCoverage: 'absent',
      faceCoverage: 'absent', confidence: 0, sourceTranscriptId },
  }
}

test('T-FR-231 controlled fixture keeps quality unknown and materializes authenticated actor audit', async () => {
  const { createQualityReport, resolveStrategicRubric } = await import('../../src/v2/domain/strategic-rubric.ts')
  const { parseFinalExportQuality } = await import('../../src/v2/infrastructure/prisma/project-final-export-repository.ts')
  const { calculateVersionHash, stableSerialize } = await import('../../src/v2/application/version-hash.ts')
  const { createExternalAuditContext, materializeActorAuditContext } = await import('../../src/v2/application/authenticate-api-client.ts')
  const { createPerceptionTimeline } = await import('../../src/v2/domain/perception-timeline.ts')
  const { parseDirectorPerceptionSnapshotUnchecked } = await import('../../src/v2/infrastructure/prisma/director-run-repository.ts')
  const quality = reviewRequiredQualityReport({ suffix: 'offline-smoke',
    evaluatedAt: '2026-07-26T20:00:00.000Z', createQualityReport, resolveStrategicRubric })
  const rubric = resolveStrategicRubric('discovery')
  const parse = (report) => parseFinalExportQuality({ contentJson: stableSerialize(report),
    contentHash: calculateVersionHash(report), contentSchemaVersion: 3,
    objective: 'discovery', rubricRef: `${rubric.id}/v${rubric.version}` })
  assert.equal(parse(quality).status, 'review-required')
  assert.throws(() => parse({ ...quality, status: 'approved' }),
    (error) => error.code === 'PERSISTENCE_CONFLICT')
  const perception = emptyDirectorPerceptionSnapshot({ id: 'final-export-perception-offline',
    sourceTranscriptId: 'final-export-transcript-offline', createPerceptionTimeline })
  assert.equal(parseDirectorPerceptionSnapshotUnchecked({ contentJson: stableSerialize(perception),
    contentHash: calculateVersionHash(perception), schemaVersion: 1,
    baseVersionId: 'final-export-base-offline' }).summary.faceCoverage, 'absent')
  const invalidPerception = { schemaVersion: 1, state: 'complete' }
  assert.throws(() => parseDirectorPerceptionSnapshotUnchecked({
    contentJson: stableSerialize(invalidPerception),
    contentHash: calculateVersionHash(invalidPerception), schemaVersion: 1,
    baseVersionId: 'final-export-base-offline',
  }), (error) => error.code === 'PERSISTENCE_CONFLICT')
  const auditContext = createExternalAuditContext({ clientId: 'controlled-client-smoke',
    credentialId: 'controlled-credential-smoke', workspaceId: 'controlled-workspace-smoke',
    environment: 'production' })
  const actor = { ...auditContext, auditContext, scopes: new Set(['projects:write']),
    authenticationKind: 'bearer', clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false, clientAccessStatus: 'active', workspaceAccessStatus: 'active' }
  const audit = materializeActorAuditContext(actor)
  assert.equal(audit.clientId, actor.clientId)
  assert.equal(audit.credentialId, actor.credentialId)
  assert.equal(audit.workspaceId, actor.workspaceId)
  assert.match(audit.contextHash, /^[a-f0-9]{64}$/)
})

test('T-FR-231 rejects unknown face safety through the API and verifies controlled export mechanics', {
  skip: process.env.APOLLO_FINAL_EXPORT_E2E !== '1' && 'set APOLLO_FINAL_EXPORT_E2E=1 and use an isolated V2 database',
  timeout: process.env.APOLLO_FINAL_EXPORT_SERVER_MODE === 'dev' ? 360_000 : 180_000,
}, async () => {
  assert.ok(process.env.V2_DATABASE_URL, 'V2_DATABASE_URL must point to an isolated PostgreSQL database')
  const artifactRoot = process.env.APOLLO_V2_ARTIFACT_ROOT?.trim() ?? ''
  assert.equal(isAbsolute(artifactRoot), true, 'APOLLO_V2_ARTIFACT_ROOT must be absolute')
  const ffmpegBin = process.env.FFMPEG_BIN?.trim() || ffmpegStatic
  assert.ok(ffmpegBin && isAbsolute(ffmpegBin), 'a pinned absolute FFmpeg binary is required')
  const ffprobeBin = process.env.APOLLO_V2_FFPROBE_PATH?.trim() ||
    process.env.FFPROBE_PATH?.trim() || process.env.FFPROBE_BIN?.trim() ||
    process.env.APOLLO_OCR_FFPROBE?.trim() || ffprobeStatic
  assert.ok(ffprobeBin && isAbsolute(ffprobeBin), 'an absolute FFprobe binary is required')
  assert.equal((await stat(ffprobeBin)).isFile(), true)

  const { assetRightsRevision } = await import('../../src/v2/domain/asset-rights.ts')
  const { calculateVersionHash, stableSerialize } = await import('../../src/v2/application/version-hash.ts')
  const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
  const { createApiAccessAuditContext } = await import('../../src/v2/domain/api-access-control.ts')
  const { createMediaColorProbe } = await import('../../src/v2/domain/color-and-export.ts')
  const { createMediaArtifactManifestV2, assertMediaArtifactManifest } = await import('../../src/v2/domain/media-artifact.ts')
  const { createQualityReport, resolveStrategicRubric } = await import('../../src/v2/domain/strategic-rubric.ts')
  const { createExternalAuditContext } = await import('../../src/v2/application/authenticate-api-client.ts')
  const { enqueueProjectFinalExportService } = await import('../../src/v2/application/enqueue-project-final-export.ts')
  const { runNextProjectFinalExportOperationService } = await import('../../src/v2/application/run-project-final-export-worker.ts')
  const { reconstructFinal } = await import('../../src/v2/application/render-workflow.ts')
  const { setProjectLutSelectionService } = await import('../../src/v2/application/project-lut-selections.ts')
  const { catalogApprovedOutputService } = await import('../../src/v2/application/catalog-approved-output.ts')
  const { PrismaAutomaticCatalogRepository } = await import('../../src/v2/infrastructure/prisma/automatic-catalog-repository.ts')
  const { listMediaLibraryService } = await import('../../src/v2/application/media-library.ts')
  const { PrismaMediaLibraryRepository } = await import('../../src/v2/infrastructure/prisma/media-library-repository.ts')
  const { setAssetRightsService } = await import('../../src/v2/application/set-asset-rights.ts')
  const {
    createArtifactSourceMaterializer,
    createAutomaticCatalogService, createColorPipelineCompilationRepository,
    createMediaArtifactPersistenceRepository, createProjectColorPlanRepository,
    createProjectLutSelectionRepository,
    createRenderElementMapRepository, createWorkspaceLutRepository,
  } = await import('../../src/v2/infrastructure/repository-factory.ts')
  const { createFfmpegEditorialProxyRendererFromEnvironment } = await import('../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts')
  const { createLocalMediaUploadStorageFromEnvironment } = await import('../../src/v2/infrastructure/media/local-media-upload-storage.ts')
  const { LocalProjectLutRenderMaterializer } = await import('../../src/v2/infrastructure/media/local-project-lut-render-materializer.ts')
  const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
  const { PrismaAssetRightsRepository } = await import('../../src/v2/infrastructure/prisma/asset-rights-repository.ts')
  const { PrismaProjectLutSelectionRepository } = await import('../../src/v2/infrastructure/prisma/project-lut-selection-repository.ts')
  const { PrismaProjectFinalExportRepository } = await import('../../src/v2/infrastructure/prisma/project-final-export-repository.ts')
  const { PrismaProjectProxyRenderRepository } = await import('../../src/v2/infrastructure/prisma/project-proxy-render-repository.ts')
  const { PrismaPublicOperationRepository } = await import('../../src/v2/infrastructure/prisma/public-operation-repository.ts')
  const { createProtectedPayloadCipherFromEnvironment } = await import('../../src/v2/infrastructure/security/recipe-parameter-cipher.ts')
  const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
  const { createUiPasswordHash } = await import('../../src/v2/infrastructure/security/ui-session.ts')
  const { probeVideo } = await import('../../src/v2/infrastructure/media/video-probe.ts')
  const { createPerceptionTimeline } = await import('../../src/v2/domain/perception-timeline.ts')

  const client = new PrismaClient()
  const databaseName = new URL(process.env.V2_DATABASE_URL).pathname.slice(1)
  assert.match(databaseName, /(?:^|_)e2e(?:_|$)/, 'destructive E2E setup requires an explicitly isolated database')
  await client.$executeRawUnsafe('TRUNCATE TABLE "workspaces" CASCADE')
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `final-export-workspace-${suffix}`
  const projectId = `final-export-project-${suffix}`
  const baseVersionId = `final-export-base-${suffix}`
  const projectVersionId = `final-export-version-${suffix}`
  const commandId = `final-export-command-${suffix}`
  const directorRunId = `final-export-director-${suffix}`
  const sourceArtifactId = `final-export-source-${suffix}`
  const sourceManifestId = `final-export-source-manifest-${suffix}`
  const proxyArtifactId = `final-export-proxy-${suffix}`
  const proxyManifestId = `final-export-proxy-manifest-${suffix}`
  const proxyOperationId = `final-export-proxy-operation-${suffix}`
  const proxyReviewId = `final-export-proxy-review-${suffix}`
  const createdAt = new Date('2026-07-26T20:00:00.000Z')
  const sourceArtifactKey = `workspaces/final-export-e2e-${suffix}/masters/source.mp4`
  const sourcePath = join(artifactRoot, ...sourceArtifactKey.split('/'))
  const uiUsername = `catalog-${suffix}`
  const uiPassword = `Catalog-${suffix}-controlled-password`
  const protectedPayloadKeyId = `final-export-controlled-${suffix}`
  const protectedPayloadKey = Buffer.alloc(32, 7).toString('base64url')
  let server
  let serverLogs = ''
  let primaryError

  try {
    await mkdir(dirname(sourcePath), { recursive: true })
    await execFileAsync(ffmpegBin, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '4',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      sourcePath,
    ], { windowsHide: true, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })
    const sourceBytes = await readFile(sourcePath)
    const sourceSha256 = sha256(sourceBytes)
    const colorMetadata = {
      colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709', matrix: 'bt709', range: 'limited', bitDepth: 8,
    }

    await client.v2Workspace.create({
      data: {
        id: workspaceId,
        slug: workspaceId,
        name: 'Final export E2E',
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
      id: `final-export-client-${suffix}`,
      workspaceId,
      name: 'Final export E2E',
      environment: 'production',
      scopes: ['projects:read', 'projects:write', 'operations:read', 'artifacts:read'],
    })
    const authenticationAudit = createApiAccessAuditContext({
      clientId: issued.client.id,
      credentialId: issued.credential.id,
      workspaceId,
      environment: 'production',
      authenticationKind: 'bearer',
    })
    assert.equal(authenticationAudit.clientId, issued.client.id)
    assert.equal(authenticationAudit.credentialId, issued.credential.id)
    assert.equal(authenticationAudit.workspaceId, workspaceId)
    assert.equal(authenticationAudit.environment, 'production')
    assert.equal(authenticationAudit.authenticationKind, 'bearer')
    assert.match(authenticationAudit.contextHash, /^[a-f0-9]{64}$/)
    await client.v2Project.create({
      data: {
        id: projectId,
        workspaceId,
        name: 'Final export E2E',
        status: 'reviewing-proxy',
        objective: 'conversion',
        format: '9:16',
        locale: 'pt-BR',
        createdByType: 'api-client',
        createdById: issued.client.id,
        createdAt,
        updatedAt: createdAt,
      },
    })

    const editPlanSnapshotId = `final-export-edit-plan-${suffix}`
    const qualitySnapshotId = `final-export-quality-${suffix}`
    const snapshotIds = {
      brief: `final-export-brief-${suffix}`,
      policies: `final-export-policies-${suffix}`,
      perception: `final-export-perception-${suffix}`,
      treatment: `final-export-treatment-${suffix}`,
      story: `final-export-story-${suffix}`,
      baseEditPlan: `final-export-base-edit-plan-${suffix}`,
      editPlan: editPlanSnapshotId,
      quality: qualitySnapshotId,
    }
    const editPlan = {
      schemaVersion: 2,
      state: 'compiled',
      id: `final-export-plan-${suffix}`,
      projectVersionId,
      fps: 30,
      durationFrames: 120,
      videoTracks: [{
        id: `final-export-track-${suffix}`,
        kind: 'base-video',
        clips: [{
          id: `final-export-clip-${suffix}`,
          sourceArtifactId,
          sourceInFrame: 0,
          sourceOutFrame: 120,
          timelineInFrame: 0,
          timelineOutFrame: 120,
          rate: 1,
        }],
      }],
      subtitleTracks: [],
      transitions: [],
      movementPolicy: { automaticZoom: false, protectedOpeningFrames: 120 },
      composition: {
        layout: 'landscape-inset',
        background: 'blurred-source',
        foregroundScale: 1,
        verticalPosition: 0.5,
        faceSafeFallback: [0.08, 0.08, 0.84, 0.84],
        subtitleSafeRegion: [0.08, 0.68, 0.84, 0.22],
      },
    }
    const baseEditPlan = {
      ...editPlan,
      id: `final-export-base-plan-${suffix}`,
      projectVersionId: baseVersionId,
    }
    const qualityReport = reviewRequiredQualityReport({ suffix, evaluatedAt: createdAt.toISOString(),
      createQualityReport, resolveStrategicRubric })
    const snapshots = [
      [snapshotIds.brief, 'brief', 1, { schemaVersion: 1, productionBrief: { ownerInput: { text: 'Final aprovado.' } } }],
      [snapshotIds.policies, 'policies', 1, { schemaVersion: 1, state: 'configured' }],
      [snapshotIds.perception, 'perception', 1, emptyDirectorPerceptionSnapshot({
        id: snapshotIds.perception, sourceTranscriptId: `final-export-transcript-${suffix}`,
        createPerceptionTimeline })],
      [snapshotIds.treatment, 'treatment', 1, { schemaVersion: 1, state: 'complete' }],
      [snapshotIds.story, 'story', 1, { schemaVersion: 1, state: 'complete' }],
      [snapshotIds.baseEditPlan, 'edit-plan', 2, baseEditPlan],
      [snapshotIds.editPlan, 'edit-plan', 2, editPlan],
      [snapshotIds.quality, 'quality-report', 3, qualityReport],
    ]
    for (const [id, kind, schemaVersion, content] of snapshots) {
      await client.v2ProjectSnapshot.create({
        data: {
          id,
          workspaceId,
          projectId,
          kind,
          schemaVersion,
          contentJson: stableSerialize(content),
          contentHash: calculateVersionHash(content),
          createdAt,
        },
      })
    }
    const baseVersionHash = calculateVersionHash({ projectId, version: baseVersionId })
    await client.v2ProjectVersion.create({
      data: {
        id: baseVersionId,
        workspaceId,
        projectId,
        sequence: 1,
        briefSnapshotId: snapshotIds.brief,
        editPlanSnapshotId: snapshotIds.baseEditPlan,
        policiesSnapshotId: snapshotIds.policies,
        baseHash: baseVersionHash,
        createdBy: issued.client.id,
        createdAt,
      },
    })
    await client.v2Project.update({ where: { id: projectId }, data: { currentVersionId: baseVersionId } })
    const noLut = await setProjectLutSelectionService({
      repository: new PrismaProjectLutSelectionRepository(client),
      createId: (kind) => `final-export-lut-${kind}-${suffix}`,
      createEventId: randomUUID,
      clock: () => createdAt,
    })({
      workspaceId,
      projectId,
      baseVersionId,
      baseHash: baseVersionHash,
      selection: { mode: 'none' },
      actor: { type: 'system', id: 'final-export-e2e-system' },
      idempotencyKey: `final-export-lut-none-${suffix}`,
      reason: 'Keep this final-export fixture colorimetrically neutral.',
    })
    assert.equal(noLut.selection.resolved.mode, 'none')
    await client.v2EditCommand.create({
      data: {
        id: commandId,
        workspaceId,
        projectId,
        baseVersionId: noLut.version.id,
        baseHash: noLut.version.baseHash,
        type: 'run-director',
        scopeJson: stableSerialize({ kind: 'video', targetIds: [] }),
        payloadJson: stableSerialize({ schemaVersion: 1, directorRunId }),
        reason: 'E2E final render',
        actorType: 'api-client',
        actorId: issued.client.id,
        actorCredentialId: authenticationAudit.credentialId,
        actorEnvironment: authenticationAudit.environment,
        actorAuthenticationKind: authenticationAudit.authenticationKind,
        actorContextHash: authenticationAudit.contextHash,
        idempotencyKey: `final-export-director-${suffix}`,
        requestFingerprint: calculateVersionHash({ commandId }),
        createdAt,
      },
    })
    const projectVersionHash = calculateVersionHash({ projectId, version: projectVersionId })
    await client.v2ProjectVersion.create({
      data: {
        id: projectVersionId,
        workspaceId,
        projectId,
        sequence: 3,
        parentVersionId: noLut.version.id,
        briefSnapshotId: snapshotIds.brief,
        treatmentSnapshotId: snapshotIds.treatment,
        storySnapshotId: snapshotIds.story,
        editPlanSnapshotId,
        policiesSnapshotId: snapshotIds.policies,
        baseHash: projectVersionHash,
        createdBy: issued.client.id,
        commandId,
        createdAt,
      },
    })
    await client.v2DirectorRun.create({
      data: {
        id: directorRunId,
        workspaceId,
        projectId,
        commandId,
        baseVersionId: noLut.version.id,
        resultVersionId: projectVersionId,
        status: 'succeeded',
        objective: 'discovery',
        objectiveVersion: 1,
        rubricRef: 'awareness-discovery/v1',
        plannerVersion: 'director-e2e-1.0.0',
        criticVersion: 'critic-e2e-1.0.0',
        perceptionSnapshotId: snapshotIds.perception,
        treatmentSnapshotId: snapshotIds.treatment,
        storySnapshotId: snapshotIds.story,
        editPlanSnapshotId,
        qualitySnapshotId,
        decisionsJson: stableSerialize([]),
        assumptionsJson: stableSerialize([]),
        initiatedByType: 'api-client',
        initiatedById: issued.client.id,
        createdAt,
        updatedAt: createdAt,
      },
    })
    await client.v2Project.update({
      where: { id: projectId },
      data: { currentVersionId: projectVersionId },
    })

    await client.v2MediaArtifact.create({
      data: {
        id: sourceArtifactId,
        workspaceId,
        artifactKey: sourceArtifactKey,
        sha256: sourceSha256,
        byteSize: BigInt(sourceBytes.byteLength),
        mediaType: 'video',
        container: 'mp4',
        status: 'available',
        createdAt,
      },
    })
    const sourceManifest = createMediaArtifactManifestV2({
      artifactKey: sourceArtifactKey, artifactSha256: sourceSha256, byteSize: sourceBytes.byteLength,
      mediaType: 'video', container: 'mp4',
      recipe: { id: 'source-master', version: '1.0.0', parameters: { sourceManifestId, parameters: true } },
      sources: [], probe: { width: 320, height: 180, duration: 4, fps: 30 },
    })
    await client.v2MediaArtifactManifest.create({
      data: {
        id: sourceManifestId,
        workspaceId,
        artifactId: sourceArtifactId,
        schemaVersion: sourceManifest.schemaVersion,
        manifestHash: sourceManifest.manifestHash,
        recipeId: sourceManifest.recipe.id,
        recipeVersion: sourceManifest.recipe.version,
        parametersHash: sourceManifest.recipe.parametersHash,
        manifestJson: stableSerialize(sourceManifest),
        createdAt,
      },
    })
    const colorProbe = createMediaColorProbe({
      id: `final-export-color-probe-${suffix}`,
      workspaceId,
      artifactId: sourceArtifactId,
      manifestId: sourceManifestId,
      detection: { state: 'ready', metadata: colorMetadata, pixelFormat: 'yuv420p', hdrMode: 'sdr' },
      producer: { provider: 'ffprobe', version: '7.1.1', binaryDigest: sha256('final-export-ffprobe') },
      createdAt: createdAt.toISOString(),
    })
    await client.v2MediaColorProbe.create({ data: {
      id: colorProbe.id, workspaceId, artifactId: sourceArtifactId, manifestId: sourceManifestId,
      schemaVersion: colorProbe.schemaVersion, state: 'ready', metadataJson: stableSerialize(colorMetadata),
      pixelFormat: 'yuv420p', hdrMode: 'sdr', reasonsJson: stableSerialize([]), producerProvider: 'ffprobe',
      producerVersion: colorProbe.producer.version, producerBinaryDigest: colorProbe.producer.binaryDigest,
      createdAt, probeHash: colorProbe.probeHash,
    } })
    await client.v2ProjectMediaAsset.create({
      data: {
        id: randomUUID(),
        workspaceId,
        projectId,
        artifactId: sourceArtifactId,
        role: 'source-master',
        originalFileName: 'final-export-source.mp4',
        createdAt,
      },
    })
    await setAssetRightsService({
      repository: new PrismaAssetRightsRepository(client),
      clock: () => createdAt,
      createId: () => `final-export-rights-${suffix}`,
    })({
      workspaceId,
      artifactId: sourceArtifactId,
      baseRevision: assetRightsRevision(sourceArtifactId, 0),
      draft: {
        status: 'approved',
        allowedUses: ['rendering', 'editorial-reuse'],
        prohibitedUses: [],
        allowedLocales: ['pt-BR'],
        consent: { status: 'approved', allowedUses: ['rendering', 'editorial-reuse'], allowedLocales: ['pt-BR'] },
      },
      actor: { type: 'api-client', id: issued.client.id },
    })

    const proxySha256 = calculateVersionHash({ proxyArtifactId })
    const proxyArtifactKey = `workspaces/final-export-e2e-${suffix}/proxies/proxy.mp4`
    // Controlled proxy metadata only: the one declared byte is not a rendered MP4.
    const proxyManifest = createMediaArtifactManifestV2({
      artifactKey: proxyArtifactKey, artifactSha256: proxySha256, byteSize: 1,
      mediaType: 'video', container: 'mp4',
      recipe: { id: 'editorial-proxy', version: '1.0.0', parameters: { proxyManifestId, parameters: true } },
      sources: [{ artifactKey: sourceArtifactKey, sha256: sourceSha256, role: 'source-master',
        execution: { tool: { id: 'controlled-fixture-metadata', version: '1.0.0',
          digest: sha256(await readFile(new URL(import.meta.url))) } } }],
    })
    await client.v2MediaArtifact.create({
      data: {
        id: proxyArtifactId,
        workspaceId,
        artifactKey: proxyArtifactKey,
        sha256: proxySha256,
        byteSize: 1n,
        mediaType: 'video',
        container: 'mp4',
        status: 'available',
        createdAt,
      },
    })
    await client.v2MediaArtifactManifest.create({
      data: {
        id: proxyManifestId,
        workspaceId,
        artifactId: proxyArtifactId,
        schemaVersion: proxyManifest.schemaVersion,
        manifestHash: proxyManifest.manifestHash,
        recipeId: proxyManifest.recipe.id,
        recipeVersion: proxyManifest.recipe.version,
        parametersHash: proxyManifest.recipe.parametersHash,
        manifestJson: stableSerialize(proxyManifest),
        createdAt,
      },
    })
    await client.v2ProjectMediaAsset.create({
      data: {
        id: randomUUID(),
        workspaceId,
        projectId,
        artifactId: proxyArtifactId,
        role: 'editorial-proxy',
        originalFileName: 'final-export-proxy.mp4',
        createdAt,
      },
    })
    for (const [artifactId, manifestId, expected] of [
      [sourceArtifactId, sourceManifestId, sourceManifest],
      [proxyArtifactId, proxyManifestId, proxyManifest],
    ]) {
      const [artifact, manifest] = await Promise.all([
        client.v2MediaArtifact.findUniqueOrThrow({ where: { id: artifactId } }),
        client.v2MediaArtifactManifest.findUniqueOrThrow({ where: { id: manifestId } }),
      ])
      assertMediaArtifactManifest(JSON.parse(manifest.manifestJson))
      assert.deepEqual(JSON.parse(manifest.manifestJson), expected)
      assert.deepEqual([artifact.workspaceId, artifact.artifactKey, artifact.sha256,
        Number(artifact.byteSize), artifact.mediaType, artifact.container],
      [workspaceId, expected.artifact.artifactKey, expected.artifact.sha256,
        expected.artifact.byteSize, expected.artifact.mediaType, expected.artifact.container])
      assert.deepEqual([manifest.workspaceId, manifest.artifactId, manifest.schemaVersion, manifest.manifestHash,
        manifest.recipeId, manifest.recipeVersion, manifest.parametersHash],
      [workspaceId, artifactId, expected.schemaVersion, expected.manifestHash,
        expected.recipe.id, expected.recipe.version, expected.recipe.parametersHash])
    }
    const proxyInputHash = calculateVersionHash({ projectVersionId, proxyArtifactId })
    await client.v2PublicOperation.create({
      data: {
        id: proxyOperationId,
        workspaceId,
        projectId,
        clientId: issued.client.id,
        type: 'project-proxy-render',
        status: 'succeeded',
        phase: 'completed',
        progressCompleted: 4,
        progressTotal: 4,
        progressUnit: 'render',
        targetType: 'media-artifact',
        targetId: proxyArtifactId,
        cancelable: false,
        retryable: false,
        attempt: 1,
        maxAttempts: 3,
        actorCredentialId: authenticationAudit.credentialId,
        actorEnvironment: authenticationAudit.environment,
        actorAuthenticationKind: authenticationAudit.authenticationKind,
        actorContextHash: authenticationAudit.contextHash,
        resultJson: stableSerialize({
          resource: { type: 'media-artifact', id: proxyArtifactId, manifestId: proxyManifestId },
        }),
        idempotencyKey: `final-export-proxy-${suffix}`,
        requestFingerprint: proxyInputHash,
        createdAt,
        updatedAt: createdAt,
        startedAt: createdAt,
        completedAt: createdAt,
      },
    })
    await client.v2ProjectProxyRenderOperation.create({
      data: {
        operationId: proxyOperationId,
        workspaceId,
        projectId,
        projectVersionId,
        editPlanSnapshotId,
        sourceArtifactId,
        sourceManifestId,
        inputHash: proxyInputHash,
        colorPipelineBindingsJson: stableSerialize([]),
        outputArtifactId: proxyArtifactId,
        outputManifestId: proxyManifestId,
        originalFileName: 'final-export-proxy.mp4',
        createdAt,
      },
    })
    const proxyReviewHash = calculateVersionHash({
      proxyReviewId,
      projectVersionId,
      proxyArtifactId,
      status: 'ready-for-final',
    })
    await client.v2ProxyReview.create({
      data: {
        id: proxyReviewId,
        workspaceId,
        projectId,
        projectVersionId,
        operationId: proxyOperationId,
        proxyArtifactId,
        proxyManifestId,
        inputHash: proxyInputHash,
        outputSpecId: 'preset-9x16',
        rangeCacheKey: calculateVersionHash({ proxyReviewId, ranges: [] }),
        specJson: stableSerialize({
          width: 540,
          height: 960,
          codec: 'h264',
          container: 'mp4',
          quality: 'review',
          reusableRanges: true,
        }),
        status: 'ready-for-final',
        technicalIssuesJson: stableSerialize([]),
        criticIssuesJson: stableSerialize([]),
        warningsAcknowledged: false,
        finalAllowed: true,
        reviewHash: proxyReviewHash,
        revision: 1,
        uploadReceivedAt: createdAt,
        renderCompletedAt: createdAt,
        timeToFirstProxyMs: 0n,
        createdAt,
        updatedAt: createdAt,
      },
    })

    // Persisted quality remains review-required for the entire test. Syntax of a
    // forged "approved" report never grants evidence authority.
    const finalExportRepository = new PrismaProjectFinalExportRepository(client)
    const approvalInput = { workspaceId, projectId, projectVersionId, projectVersionHash,
      outputSpecId: 'preset-9x16', requireCurrent: true }
    assert.equal(await finalExportRepository.readApproval(approvalInput), null)
    const forgedReport = { ...qualityReport, status: 'approved' }
    await client.v2ProjectSnapshot.update({ where: { id: qualitySnapshotId }, data: {
      contentJson: stableSerialize(forgedReport), contentHash: calculateVersionHash(forgedReport),
    } })
    await assert.rejects(finalExportRepository.readApproval(approvalInput),
      (error) => error.code === 'PERSISTENCE_CONFLICT')
    await client.v2ProjectSnapshot.update({ where: { id: qualitySnapshotId }, data: {
      contentJson: stableSerialize(qualityReport), contentHash: calculateVersionHash(qualityReport),
    } })
    assert.equal(await finalExportRepository.readApproval(approvalInput), null)
    const sourceReader = new PrismaProjectProxyRenderRepository(client)
    let preflightSource
    try { preflightSource = await sourceReader.readCurrentSource({ workspaceId, projectId }) }
    catch (error) {
      assert.fail(`Final export fixture source is invalid: ${error?.code ?? 'UNKNOWN'}: ${error?.message ?? String(error)}`)
    }
    assert.ok(preflightSource)
    assert.equal(preflightSource.projectVersionId, projectVersionId)
    assert.equal(preflightSource.editPlanSnapshotId, editPlanSnapshotId)
    assert.equal(preflightSource.editPlanHash, calculateVersionHash(editPlan))
    assert.equal(preflightSource.sourceArtifactId, sourceArtifactId)
    assert.equal(preflightSource.sourceManifestId, sourceManifestId)
    assert.equal(preflightSource.sourceSha256, sourceSha256)
    assert.equal(preflightSource.trustedOcr, undefined)

    const port = await getFreePort()
    const baseUrl = `http://127.0.0.1:${port}`
    server = spawn(process.execPath, ['node_modules/next/dist/bin/next', ...(process.env.APOLLO_FINAL_EXPORT_SERVER_MODE === 'dev' ? ['dev', '--webpack'] : ['start']), '-H', '127.0.0.1', '-p', String(port)], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: process.env.APOLLO_FINAL_EXPORT_SERVER_MODE === 'dev' ? 'development' : 'production',
        __NEXT_PROCESSED_ENV: 'true',
        APOLLO_API_ENVIRONMENT: 'production',
        APOLLO_AUTH_MODE: 'bootstrap', APOLLO_ALLOW_BOOTSTRAP_AUTH: 'true', APOLLO_UI_BOOTSTRAP_ROLE: 'operator',
        APOLLO_UI_USERNAME: uiUsername, APOLLO_UI_PASSWORD_HASH: createUiPasswordHash(uiPassword, `catalog-salt-${suffix}`),
        APOLLO_UI_SESSION_SECRET: `catalog-${suffix}-session-secret-with-32-bytes`, APOLLO_UI_API_CLIENT_ID: issued.client.id,
        APOLLO_V2_ARTIFACT_ROOT: artifactRoot,
        APOLLO_V2_ARTIFACT_STORAGE_DRIVER: 'local',
        APOLLO_PROTECTED_PAYLOAD_KEY_ID: protectedPayloadKeyId,
        APOLLO_PROTECTED_PAYLOAD_KEY: protectedPayloadKey,
        APOLLO_MEDIA_DOWNLOAD_BASE_URL: `${baseUrl}/`,
        APOLLO_MEDIA_DOWNLOAD_SIGNING_SECRET: `final-export-download-${suffix}`.padEnd(48, 'x'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.stdout.on('data', (chunk) => { serverLogs += String(chunk) })
    server.stderr.on('data', (chunk) => { serverLogs += String(chunk) })
    try { await waitForServer(baseUrl, server) } catch (error) { throw new Error(`${error.message}\n${serverLogs}`, { cause: error }) }
    const authorization = `Bearer ${issued.token}`
    const stage = (id, kind, enabled, output, provider, parameters) => ({
      id, kind, version: 'v1', enabled, output,
      implementation: { provider, version: 'v1', parameters, parametersHash: sha256(JSON.stringify(parameters)) },
    })
    const compilationResponse = await fetch(`${baseUrl}/v1/projects/${projectId}/color-pipeline-compilations`, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': `final-export-color-${suffix}`,
      },
      body: JSON.stringify({
        sourceArtifactId,
        sourceManifestId,
        outputMetadata: colorMetadata,
        stages: [
          stage('technical-rec709', 'technical', true, colorMetadata, 'ffmpeg-zscale', { mode: 'identity' }),
          stage('match-source', 'match', false, colorMetadata, 'apollo-match', { mode: 'bypass' }),
          stage('creative-none', 'creative-lut', false, colorMetadata, 'apollo-lut', { mode: 'none' }),
          stage('output-rec709', 'output', true, colorMetadata, 'ffmpeg-zscale', { dither: true }),
        ],
      }),
    })
    assert.equal(compilationResponse.status, 201, `${await compilationResponse.text()}\n${serverLogs.slice(-4_000)}`)
    const exportBody = {
      projectVersionId,
      projectVersionHash,
      format: '9:16',
      approval: { approved: true, note: 'Controlled request; real quality remains review-required.' },
    }
    const reviewBlockedResponse = await fetch(`${baseUrl}/v1/projects/${projectId}/exports`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json',
        'idempotency-key': `final-export-review-blocked-${suffix}` },
      body: JSON.stringify(exportBody),
    })
    const reviewBlockedPayload = await reviewBlockedResponse.json()
    assert.equal(reviewBlockedResponse.status, 422, JSON.stringify(reviewBlockedPayload))
    assert.equal(reviewBlockedPayload.error.code, 'EDITORIAL_ACCEPTANCE_FAILED')
    assert.equal(await client.v2PublicOperation.count({ where: { workspaceId, type: 'project-final-export' } }), 0)
    assert.equal(await client.v2ProjectFinalExportAttempt.count({ where: { workspaceId } }), 0)
    assert.equal(await client.v2AutomaticCatalogRecord.count({ where: { workspaceId } }), 0)

    // From here on only this test-owned port supplies a controlled approval to
    // the application services. It validates the same PG lineage and immutable
    // source identities, while leaving the stored quality report UNKNOWN.
    const qualitySnapshotHash = calculateVersionHash(qualityReport)
    const controlledIdentity = Object.freeze({ workspaceId, projectId, projectVersionId,
      projectVersionHash, editPlanSnapshotId, directorRunId, qualitySnapshotId,
      qualitySnapshotHash, proxyReviewId, proxyReviewHash, proxyArtifactId,
      sourceArtifactId, sourceManifestId, sourceSha256 })
    async function readControlledSource(input, immutable) {
      if (Object.entries(input).some(([key, value]) => key in controlledIdentity && controlledIdentity[key] !== value) ||
          input.workspaceId !== workspaceId || input.projectId !== projectId ||
          input.projectVersionId !== projectVersionId || input.projectVersionHash !== projectVersionHash ||
          (immutable && Object.keys(controlledIdentity).filter((key) => key !== 'sourceSha256')
            .some((key) => input[key] !== controlledIdentity[key]))) return null
      const source = immutable
        ? await sourceReader.readImmutableSource(input)
        : await sourceReader.readCurrentSource({ workspaceId, projectId })
      if (!source || source.projectVersionId !== projectVersionId ||
          source.editPlanSnapshotId !== editPlanSnapshotId || source.sourceArtifactId !== sourceArtifactId ||
          source.editPlanHash !== calculateVersionHash(editPlan) ||
          source.sourceManifestId !== sourceManifestId || source.sourceSha256 !== sourceSha256 ||
          source.renderSources.length !== 1 || source.renderSources[0].artifactId !== sourceArtifactId ||
          source.renderSources[0].manifestId !== sourceManifestId ||
          source.renderSources[0].sha256 !== sourceSha256) return null
      const [project, version, run, snapshot, review, artifact, manifest] = await Promise.all([
        client.v2Project.findFirst({ where: { id: projectId, workspaceId } }),
        client.v2ProjectVersion.findFirst({ where: { id: projectVersionId, workspaceId, projectId, baseHash: projectVersionHash } }),
        client.v2DirectorRun.findFirst({ where: { id: directorRunId, workspaceId, projectId,
          resultVersionId: projectVersionId, qualitySnapshotId, status: 'succeeded' } }),
        client.v2ProjectSnapshot.findFirst({ where: { id: qualitySnapshotId, workspaceId, projectId, kind: 'quality-report' } }),
        client.v2ProxyReview.findFirst({ where: { id: proxyReviewId, workspaceId, projectId,
          projectVersionId, reviewHash: proxyReviewHash, proxyArtifactId, status: 'ready-for-final', finalAllowed: true } }),
        client.v2MediaArtifact.findFirst({ where: { id: sourceArtifactId, workspaceId, sha256: sourceSha256, status: 'available' } }),
        client.v2MediaArtifactManifest.findFirst({ where: { id: sourceManifestId, workspaceId, artifactId: sourceArtifactId } }),
      ])
      if (!project || (immutable ? false : project.currentVersionId !== projectVersionId) ||
          !version || version.editPlanSnapshotId !== editPlanSnapshotId || !run || !snapshot ||
          snapshot.contentHash !== qualitySnapshotHash || snapshot.contentJson !== stableSerialize(qualityReport) ||
          !review || !artifact || !manifest || Number(artifact.byteSize) !== sourceBytes.byteLength) return null
      return Object.freeze({ ...source, projectVersionHash, locale: project.locale ?? 'pt-BR',
        directorRunId, qualitySnapshotId, qualitySnapshotHash, qualityStatus: 'approved',
        qualityScore: qualityReport.score, proxyReviewId, proxyReviewHash, proxyArtifactId })
    }
    const controlledProjects = Object.freeze({
      readApprovedCurrentSource: (input) => readControlledSource(input, false),
      readImmutableApprovedSource: (input) => readControlledSource(input, true),
      convergeOutputIdentity: (input) => finalExportRepository.convergeOutputIdentity(input),
      attachCompletedOutput: (input) => finalExportRepository.attachCompletedOutput(input),
      markExportFailed: (input) => finalExportRepository.markExportFailed(input),
      recordAttempt: (input) => finalExportRepository.recordAttempt(input),
      readAttemptHistory: (input) => finalExportRepository.readAttemptHistory(input),
    })
    const auditContext = createExternalAuditContext({ clientId: issued.client.id,
      credentialId: issued.credential.id, workspaceId, environment: 'production' })
    const controlledActor = { ...auditContext, auditContext, scopes: new Set(['projects:write']),
      authenticationKind: 'bearer', clientKillSwitchEngaged: false,
      workspaceKillSwitchEngaged: false, clientAccessStatus: 'active', workspaceAccessStatus: 'active' }
    const workerEnvironment = {
      ...process.env,
      APOLLO_V2_ARTIFACT_ROOT: artifactRoot,
      APOLLO_V2_ARTIFACT_STORAGE_DRIVER: 'local',
      FFMPEG_PATH: ffmpegBin,
      APOLLO_V2_RENDER_LEASE_MS: '120000',
      APOLLO_V2_RENDER_HEARTBEAT_MS: '5000',
      APOLLO_V2_WORKER_RETRY_BASE_MS: '1',
      APOLLO_V2_WORKER_RETRY_MAX_MS: '1',
      APOLLO_PROTECTED_PAYLOAD_KEY_ID: protectedPayloadKeyId,
      APOLLO_PROTECTED_PAYLOAD_KEY: protectedPayloadKey,
    }
    const operations = new PrismaPublicOperationRepository(client, randomUUID,
      () => createProtectedPayloadCipherFromEnvironment(workerEnvironment))
    const rights = new PrismaAssetRightsRepository(client)
    const enqueue = enqueueProjectFinalExportService({ projects: controlledProjects,
      rights, operations,
      colorPipelines: createColorPipelineCompilationRepository(), clock: () => new Date(),
      createId: (kind) => `final-export-controlled-${kind}-${suffix}` })
    const enqueuePayload = await enqueue({ workspaceId, projectId, ...exportBody,
      actor: controlledActor, idempotencyKey: `final-export-${suffix}` })
    assert.equal(enqueuePayload.replayed, false)
    assert.deepEqual(enqueuePayload.context.outputSpec, {
      aspectRatio: '9:16',
      width: 1080,
      height: 1920,
      fps: 30,
      codec: 'h264',
      audioCodec: 'aac',
      container: 'mp4',
      quality: 'final',
    })
    const operationId = enqueuePayload.operation.id
    const replayPayload = await enqueue({ workspaceId, projectId, ...exportBody,
      actor: controlledActor, idempotencyKey: `final-export-${suffix}` })
    assert.equal(replayPayload.replayed, true)
    assert.equal(replayPayload.operation.id, operationId)
    await assert.rejects(enqueue({ workspaceId, projectId, ...exportBody,
      approval: { approved: true, note: 'A different payload with the same key.' },
      actor: controlledActor, idempotencyKey: `final-export-${suffix}` }),
    (error) => error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH')
    await assert.rejects(enqueue({ workspaceId, projectId, ...exportBody,
      projectVersionHash: '0'.repeat(64), actor: controlledActor,
      idempotencyKey: `final-export-stale-${suffix}` }),
    (error) => error.code === 'EDITORIAL_ACCEPTANCE_FAILED')

    function controlledWorker(ffmpegPath) {
      return runNextProjectFinalExportOperationService({
        operations, projects: controlledProjects, rights,
        artifacts: createMediaArtifactPersistenceRepository(workerEnvironment),
        storage: createLocalMediaUploadStorageFromEnvironment(workerEnvironment),
        renderer: createFfmpegEditorialProxyRendererFromEnvironment({ ...workerEnvironment, FFMPEG_PATH: ffmpegPath }),
        renderElementMaps: createRenderElementMapRepository(),
        colorPipelines: createColorPipelineCompilationRepository(),
        colorPlans: createProjectColorPlanRepository(),
        luts: new LocalProjectLutRenderMaterializer(createProjectLutSelectionRepository(),
          join(resolve(artifactRoot), '.lut-work'), createWorkspaceLutRepository()),
        sources: createArtifactSourceMaterializer(workerEnvironment),
        catalogOutput: createAutomaticCatalogService(),
        leaseDurationMs: 120_000, heartbeatIntervalMs: 5_000,
        retryBaseDelayMs: 1, retryMaxDelayMs: 1,
      })
    }
    const failingWorker = controlledWorker(process.execPath)
    const failedOutcome = await failingWorker(
      `final-export-worker-failed-${suffix}`,
    )
    assert.deepEqual(failedOutcome, { operationId, status: 'retrying' })
    const failedAttempt = await client.v2ProjectFinalExportAttempt.findUnique({
      where: { operationId_attempt: { operationId, attempt: 1 } },
    })
    assert.equal(failedAttempt?.status, 'failed')
    assert.equal(await client.v2AutomaticCatalogRecord.count({ where: { workspaceId } }), 0)
    assert.equal(await client.v2MediaLibraryEntry.count({ where: { workspaceId, originType: 'generated' } }), 0)
    await new Promise((resolve) => setTimeout(resolve, 25))
    const worker = controlledWorker(ffmpegBin)
    const completedOutcome = await worker(`final-export-worker-promoted-${suffix}`)
    const promotedAttempt = await client.v2ProjectFinalExportAttempt.findUnique({
      where: { operationId_attempt: { operationId, attempt: 2 } },
    })
    assert.deepEqual(completedOutcome, { operationId, status: 'succeeded' }, JSON.stringify({
      attemptStatus: promotedAttempt?.status,
      errorCode: promotedAttempt?.errorCode,
      errorMessage: promotedAttempt?.errorMessage,
    }))

    const attemptsResponse = await fetch(
      `${baseUrl}/v1/operations/${operationId}/final-export-attempts`,
      { headers: { authorization } },
    )
    const attemptsPayload = await attemptsResponse.json()
    assert.equal(attemptsResponse.status, 200, JSON.stringify(attemptsPayload))
    assert.equal(attemptsPayload.data.proxyReviewId, proxyReviewId)
    assert.deepEqual(attemptsPayload.data.outputSpec, {
      aspectRatio: '9:16',
      width: 1080,
      height: 1920,
      fps: 30,
      codec: 'h264',
      audioCodec: 'aac',
      container: 'mp4',
      quality: 'final',
    })
    assert.deepEqual(attemptsPayload.data.attempts.map((attempt) => attempt.status), ['failed', 'promoted'])
    assert.equal(attemptsPayload.data.attempts[1].validators.every((validator) => validator.passed), true)
    const output = attemptsPayload.data.attempts[1].output
    assert.match(output.sha256, /^[a-f0-9]{64}$/)
    // The controlled worker performs the real first catalog write itself.
    // These are independent PostgreSQL reads, not a catalog callback fake.
    const catalogRepository = new PrismaAutomaticCatalogRepository(client)
    const catalogRecord = await catalogRepository.find(workspaceId, output.artifactId)
    assert.ok(catalogRecord, 'promoted controlled-mechanics output must be automatically cataloged')
    assert.equal(catalogRecord.outputKind, 'final')
    assert.equal(catalogRecord.manifestId, output.manifestId)
    assert.match(catalogRecord.recordHash, /^[a-f0-9]{64}$/)
    assert.match(catalogRecord.eligibilityEvidenceHash, /^[a-f0-9]{64}$/)
    assert.deepEqual(catalogRecord.lineage.map((edge) => edge.sourceArtifactId), [sourceArtifactId])
    const inheritedRights = await new PrismaAssetRightsRepository(client).findCurrent(workspaceId, output.artifactId)
    assert.equal(inheritedRights.snapshot.id, catalogRecord.rightsSnapshotId)
    assert.equal(inheritedRights.snapshot.snapshotHash, catalogRecord.rightsSnapshotHash)
    assert.deepEqual(inheritedRights.snapshot.allowedUses, ['editorial-reuse', 'rendering'])
    assert.deepEqual(inheritedRights.snapshot.allowedLocales, ['pt-BR'])
    assert.deepEqual(inheritedRights.snapshot.consent.allowedLocales, ['pt-BR'])
    assert.equal(inheritedRights.snapshot.consent.status, 'approved')
    const libraryResult = await listMediaLibraryService({ repository: new PrismaMediaLibraryRepository(client) })({ workspaceId })
    assert.ok(libraryResult.items.some((item) => item.source.artifactId === output.artifactId))
    const catalog = catalogApprovedOutputService({ repository: catalogRepository, rights: new PrismaAssetRightsRepository(client) })
    const target = { workspaceId, artifactId: output.artifactId, manifestId: output.manifestId }
    const replays = await Promise.all([catalog(target), catalog(target), catalog(target)])
    assert.ok(replays.every((result) => result.status === 'already-cataloged'))
    assert.ok(replays.every((result) => result.record.recordHash === catalogRecord.recordHash))
    assert.equal(await client.v2AutomaticCatalogRecord.count({ where: { workspaceId, artifactId: output.artifactId } }), 1)
    assert.equal(await client.v2MediaLibraryEntry.count({ where: { workspaceId, artifactId: output.artifactId } }), 1)
    assert.equal((await new PrismaAssetRightsRepository(client).findCurrent(workspaceId, output.artifactId)).snapshot.id, inheritedRights.snapshot.id)
    // Recreate the first catalog write from the controlled, promoted output.
    // This exercises the unique PostgreSQL commit under simultaneous writers;
    // the replay above only exercises reads of an already existing record.
    await client.v2AutomaticCatalogRecord.delete({ where: { id: catalogRecord.id } })
    await client.v2MediaLibraryEntry.delete({ where: { artifactId: output.artifactId } })
    const concurrentFirstWrites = await Promise.all([catalog(target), catalog(target), catalog(target)])
    assert.deepEqual(concurrentFirstWrites.map((item) => item.status).sort(), ['already-cataloged', 'already-cataloged', 'cataloged'])
    assert.ok(concurrentFirstWrites.every((item) => item.record.recordHash === catalogRecord.recordHash))
    assert.equal(await client.v2AutomaticCatalogRecord.count({ where: { workspaceId, artifactId: output.artifactId } }), 1)
    assert.equal(await client.v2MediaLibraryEntry.count({ where: { workspaceId, artifactId: output.artifactId } }), 1)
    console.log(JSON.stringify({ event: 'automatic-catalog-first-write-concurrency', writers: 3, statuses: concurrentFirstWrites.map((item) => item.status).sort(), recordHash: catalogRecord.recordHash, catalogRows: 1, libraryRows: 1 }))
    // Raw source has no approved output recipe; cataloging it must not
    // create a searchable row even though it has explicit reuse rights.
    assert.deepEqual(await catalog({ workspaceId, artifactId: sourceArtifactId, manifestId: sourceManifestId }), { status: 'ignored', reason: 'not-approved', record: null })
    assert.equal(await client.v2AutomaticCatalogRecord.count({ where: { workspaceId, artifactId: sourceArtifactId } }), 0)
    // Negative output eligibility uses real persisted review/artifact states.
    await client.v2ProxyReview.update({ where: { id: proxyReviewId }, data: { status: 'blocked', finalAllowed: false } })
    assert.deepEqual(await catalog({ workspaceId, artifactId: proxyArtifactId, manifestId: proxyManifestId }), { status: 'ignored', reason: 'not-approved', record: null })
    assert.equal(await client.v2AutomaticCatalogRecord.count({ where: { workspaceId, artifactId: proxyArtifactId } }), 0)
    await client.v2ProxyReview.update({ where: { id: proxyReviewId }, data: { status: 'ready-for-final', finalAllowed: true } })
    await client.v2MediaArtifact.update({ where: { id: proxyArtifactId }, data: { status: 'quarantined' } })
    assert.deepEqual(await catalog({ workspaceId, artifactId: proxyArtifactId, manifestId: proxyManifestId }), { status: 'ignored', reason: 'not-approved', record: null })
    assert.equal(await client.v2MediaLibraryEntry.count({ where: { workspaceId, artifactId: proxyArtifactId } }), 0)
    await client.v2MediaArtifact.update({ where: { id: proxyArtifactId }, data: { status: 'available' } })


    const operationResponse = await fetch(`${baseUrl}/v1/operations/${operationId}`, {
      headers: { authorization },
    })
    const operationPayload = await operationResponse.json()
    assert.equal(operationResponse.status, 200, JSON.stringify(operationPayload))
    assert.equal(operationPayload.data.operation.status, 'succeeded')
    assert.equal(operationPayload.data.operation.attempt, 2)
    assert.equal(await finalExportRepository.readApproval(approvalInput), null,
      'mechanical completion must not upgrade the persisted unknown-face report')
    const completedProject = await client.v2Project.findUnique({ where: { id: projectId } })
    assert.equal(completedProject?.status, 'completed')

    const grantResponse = await fetch(`${baseUrl}/v1/artifacts/${output.artifactId}/download-grants`, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': `final-export-download-${suffix}`,
      },
      body: JSON.stringify({ ttlSeconds: 300 }),
    })
    const grantPayload = await grantResponse.json()
    assert.equal(grantResponse.status, 201, JSON.stringify(grantPayload))
    const persistedGrant = await client.v2MediaDownloadGrant.findUnique({
      where: { id: grantPayload.data.grant.id },
    })
    assert.equal(persistedGrant?.issuerCredentialId, issued.credential.id)
    assert.equal(persistedGrant?.issuerEnvironment, 'production')
    assert.equal(persistedGrant?.issuerAuthenticationKind, 'bearer')
    assert.match(persistedGrant?.issuerContextHash ?? '', /^[a-f0-9]{64}$/)
    assert.equal(persistedGrant?.revokerContextHash, null)
    const rangeResponse = await fetch(grantPayload.data.downloadUrl, {
      headers: { range: 'bytes=0-99' },
    })
    assert.equal(rangeResponse.status, 206)
    assert.equal((await rangeResponse.arrayBuffer()).byteLength, 100)
    const downloadResponse = await fetch(grantPayload.data.downloadUrl)
    const downloadedBytes = new Uint8Array(await downloadResponse.arrayBuffer())
    assert.equal(downloadResponse.status, 200)
    assert.equal(downloadedBytes.byteLength, output.byteSize)
    assert.equal(sha256(downloadedBytes), output.sha256)

    const finalArtifact = await client.v2MediaArtifact.findUnique({
      where: { id: output.artifactId },
      include: { manifests: { where: { id: output.manifestId } } },
    })
    assert.ok(finalArtifact)
    assert.equal(finalArtifact.sha256, output.sha256)
    assert.equal(Number(finalArtifact.byteSize), downloadedBytes.byteLength)
    const finalManifest = JSON.parse(finalArtifact.manifests[0].manifestJson)
    assert.equal(finalManifest.schemaVersion, 'media-artifact-manifest/v4')
    assert.match(finalManifest.renderInput.ref, /^render-input\/sha256\/[a-f0-9]{64}$/)
    assert.match(finalManifest.renderInput.inputHash, /^[a-f0-9]{64}$/)
    assert.ok(finalArtifact.manifests[0].renderInputRef)
    assert.equal(finalManifest.artifact.sha256, output.sha256)
    assert.equal(finalManifest.artifact.byteSize, downloadedBytes.byteLength)
    assert.equal(reconstructFinal({
      checksum: finalManifest.artifact.sha256,
      byteSize: finalManifest.artifact.byteSize,
      reconstructable: true,
    }, downloadedBytes), true)
    const finalPath = join(artifactRoot, ...finalArtifact.artifactKey.split('/'))
    assert.equal((await stat(finalPath)).size, downloadedBytes.byteLength)
    // The content-addressed key can exceed Windows MAX_PATH under an E2E
    // scratch root. Probe/decode an authenticated short copy, then remove it.
    const probeDir = await mkdtemp(join(tmpdir(), 'af-'))
    const probePath = join(probeDir, 'final.mp4')
    let finalProbe
    let probeError
    let probeCleanupError
    try {
      await copyFile(finalPath, probePath)
      assert.equal((await stat(probePath)).size, downloadedBytes.byteLength)
      assert.equal(sha256(await readFile(probePath)), output.sha256)
      finalProbe = await probeVideo(probePath, { environment: {
        ...process.env, APOLLO_V2_FFPROBE_PATH: ffprobeBin,
      } })
      await execFileAsync(ffmpegBin, ['-v', 'error', '-xerror', '-i', probePath, '-f', 'null', '-'],
        { windowsHide: true, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })
      assert.equal((await stat(probePath)).size, downloadedBytes.byteLength)
      assert.equal(sha256(await readFile(probePath)), output.sha256)
    } catch (error) {
      probeError = error
    } finally {
      try { await rm(probeDir, { recursive: true, force: true }) }
      catch (error) { probeCleanupError = error }
    }
    if (probeError && probeCleanupError) {
      throw new AggregateError([probeError, probeCleanupError], 'Final export probe and cleanup failed')
    }
    if (probeError) throw probeError
    if (probeCleanupError) throw probeCleanupError
    assert.equal(finalProbe.width, 1080)
    assert.equal(finalProbe.height, 1920)
    assert.equal(finalProbe.codec, 'h264')
    assert.equal(finalProbe.audioCodec, 'aac')
    assert.match(finalProbe.container, /mp4/)
    console.log(JSON.stringify({ event: 'controlled-final-export-mechanics-proof', qualityStatus: 'review-required',
      faceSafety: 'unknown', artifactId: output.artifactId, sha256: output.sha256,
      byteSize: downloadedBytes.byteLength, catalogRecordId: catalogRecord.id,
      recordHash: catalogRecord.recordHash, rightsSnapshotId: catalogRecord.rightsSnapshotId,
      lineageSourceIds: catalogRecord.lineage.map((edge) => edge.sourceArtifactId),
      originalPathLength: finalPath.length, probePathLength: probePath.length,
      fullDecode: 'passed' }))
    const mechanicsProof = {
      schemaVersion: 'automatic-catalog-proof/v1', proofScope: 'controlled-mechanics',
      qualityStatus: 'review-required', faceSafety: 'unknown', browserStatus: 'pending',
      controlledUpstream: ['Director snapshots', 'proxy review', 'color probe', 'test-only approval port'],
      sourceCommit: process.env.GITHUB_SHA ?? null, ciRunId: process.env.GITHUB_RUN_ID ?? null,
      ownerPid: process.pid, serverPid: server.pid,
      runtime: ['public export API rejection', 'DI application-service worker', 'FFmpeg renderer', 'PostgreSQL', 'local artifact storage'],
      artifact: { id: output.artifactId, manifestId: output.manifestId,
        sha256: output.sha256, byteSize: downloadedBytes.byteLength },
      catalogRecord, inheritedRights: inheritedRights.snapshot, fullDecode: 'passed',
      replayConcurrency: 3, firstWriteConcurrency: 3, catalogRows: 1, libraryRows: 1,
      failedAttemptCatalogRows: 0, rejectedOutputCatalogRows: 0, quarantinedOutputLibraryRows: 0,
      deployed: false, ownerAccepted: false,
    }
    let mechanicsProofPath
    if (process.env.APOLLO_LIBRARY_EVIDENCE_ROOT) {
      const evidenceRoot = process.env.APOLLO_LIBRARY_EVIDENCE_ROOT
      assert.equal(isAbsolute(evidenceRoot), true)
      await mkdir(evidenceRoot, { recursive: true })
      const mechanicsMediaPath = join(evidenceRoot, 'controlled-final-export-mechanics.mp4')
      await writeFile(mechanicsMediaPath, downloadedBytes)
      assert.equal((await stat(mechanicsMediaPath)).size, downloadedBytes.byteLength)
      assert.equal(sha256(await readFile(mechanicsMediaPath)), output.sha256)
      mechanicsProofPath = join(evidenceRoot, 'controlled-final-export-mechanics.json')
      await writeFile(mechanicsProofPath, JSON.stringify(mechanicsProof, null, 2))
    }
    const catalogBrowser = await proveCatalogOutputBrowser({ baseUrl, authorization,
      username: uiUsername, password: uiPassword, prisma: client, workspaceId,
      output, catalogRecord, proofScope: 'controlled-mechanics',
      qualityStatus: 'review-required', faceSafety: 'unknown',
      evidenceDir: process.env.APOLLO_LIBRARY_EVIDENCE_ROOT ?? join(artifactRoot, 'catalog-browser-evidence') })
    mechanicsProof.browserStatus = 'passed'
    mechanicsProof.catalogBrowser = catalogBrowser
    if (mechanicsProofPath) await writeFile(mechanicsProofPath, JSON.stringify(mechanicsProof, null, 2))


    const tamperedUrl = new URL(grantPayload.data.downloadUrl)
    const token = tamperedUrl.searchParams.get('token')
    tamperedUrl.searchParams.set('token', `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`)
    const tamperedResponse = await fetch(tamperedUrl)
    assert.equal(tamperedResponse.status, 409)

    const revokeResponse = await fetch(
      `${baseUrl}/v1/media/download-grants/${grantPayload.data.grant.id}/revoke`,
      { method: 'POST', headers: { authorization } },
    )
    const revokePayload = await revokeResponse.json()
    assert.equal(revokeResponse.status, 200, JSON.stringify(revokePayload))
    assert.equal(revokePayload.data.grant.status, 'revoked')
    const revokedGrant = await client.v2MediaDownloadGrant.findUnique({
      where: { id: grantPayload.data.grant.id },
    })
    assert.equal(revokedGrant?.revokerCredentialId, issued.credential.id)
    assert.equal(revokedGrant?.revokerEnvironment, 'production')
    assert.equal(revokedGrant?.revokerAuthenticationKind, 'bearer')
    assert.match(revokedGrant?.revokerContextHash ?? '', /^[a-f0-9]{64}$/)
    assert.equal((await fetch(grantPayload.data.downloadUrl)).status, 409)
  } catch (error) {
    primaryError = error
  } finally {
    const cleanupErrors = []
    const cleanupStage = async (name, action) => {
      const startedAt = Date.now()
      const before = process.getActiveResourcesInfo()
      let outcome = 'completed'
      try { await action() }
      catch (error) { outcome = 'failed'; cleanupErrors.push(error) }
      finally {
        console.log(JSON.stringify({ event: 'final-export-cleanup-stage', name, outcome,
          ownerPid: process.pid, serverPid: server?.pid ?? null,
          serverExitCode: server?.exitCode ?? null, serverSignalCode: server?.signalCode ?? null,
          durationMs: Date.now() - startedAt, resourcesBefore: before,
          resourcesAfter: process.getActiveResourcesInfo() }))
      }
    }
    await cleanupStage('next-server', async () => {
      if (server && server.exitCode === null && server.signalCode === null) {
        server.kill()
        await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))])
        if (server.exitCode === null && server.signalCode === null) {
          server.kill('SIGKILL')
          await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))])
        }
      }
      assert.ok(!server || server.exitCode !== null || server.signalCode !== null,
        'Owned export Next server must terminate')
    })
    await cleanupStage('repository-factory-prisma', async () => {
      const { disconnectV2PostgresClient } = await import('../../src/v2/infrastructure/prisma-postgres/client.ts')
      await disconnectV2PostgresClient()
    })
    await cleanupStage('fixture-prisma', () => client.$disconnect())
    await cleanupStage('fixture-media', async () => {
      await rm(join(artifactRoot, `workspaces/final-export-e2e-${suffix}`), { recursive: true, force: true })
    })
    if (cleanupErrors.length) {
      throw new AggregateError(primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
        'Final-export fixture failed to clean up all owned resources')
    }
  }
  if (primaryError) throw primaryError
})
