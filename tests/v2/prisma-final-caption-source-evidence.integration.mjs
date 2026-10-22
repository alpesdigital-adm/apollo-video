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
 * W65b PostgreSQL + FFmpeg proof of the face evidence keyed by SOURCE time, on a Director-cut timeline (written for a supervised run;
 * not run in CI).
 *
 * The source is a 6 s portrait master: a flat picture with a GREEN frame and a MAGENTA rectangle - the stand-in for a face - in the
 * lower centre, drawn only in source frames 120-179. The Director cut trims it and jumps over the middle:
 *
 *     timeline  0- 59   <- source   0- 59   (no stand-in face)
 *     timeline 60-119   <- source 120-179   (the stand-in face is on screen)
 *
 * so what the pixels show at a timeline frame of the second half is NOT what the source shows at the same frame number (source 60-119
 * has no face at all). The face windows are produced
 * by the real enqueue + worker + repository over PostgreSQL, in SOURCE frames, while the project's head is the BASE Version (one clip
 * playing the whole source); the final is exported from the Director's Version, which did not exist then. The detector is a stand-in
 * (it returns real V9 tensors for the source frames where the stand-in face is, because no real detector sees a magenta box as a face);
 * everything after it - storage, reading, projection through the clips, planning, the gate, the render and the pixel critic - is real.
 * The pixel critic is wired with a colour-key face veto of its own, which finds the stand-in on the caption-free frame.
 *
 *   F0  the cut, no cues                                       -> the control
 *   F1  the cut, two cues, windows over the whole source       -> BOTH burned: the first cue keeps the preferred bottom band, the
 *                                                                cue over the face is moved off it (evidence reused across Versions)
 *   F2  the cut, two cues, windows over source 0-149 only      -> the cue over source 130-169 is OMITTED and LISTED, the other burned
 *   F3  the cut, two cues, evidence placed on the TIMELINE     -> the pixel critic catches the caption on the face: no final is delivered
 */
const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const ffmpegStatic = require('ffmpeg-static')

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const FPS = 30
const SOURCE_FRAMES = 180
const CUT_FRAMES = 120
const MASTER = Object.freeze({ width: 180, height: 320 })
// the stand-in face, in source pixels and as the detector's normalised row
const MARKER = Object.freeze({ x: 72, y: 224, w: 36, h: 83 })
const FACE_ROW = Object.freeze([0.9, MARKER.x / MASTER.width, MARKER.y / MASTER.height, (MARKER.x + MARKER.w) / MASTER.width, (MARKER.y + MARKER.h) / MASTER.height])
const FACE_FIRST_SOURCE_FRAME = 120
const CUT = Object.freeze([
  { sourceInFrame: 0, sourceOutFrame: 60, timelineInFrame: 0, timelineOutFrame: 60 },
  { sourceInFrame: 120, sourceOutFrame: 180, timelineInFrame: 60, timelineOutFrame: 120 },
])
// The free cue comes first: the anchor solver keeps the previous band whenever it is still eligible (hysteresis), so a free cue AFTER a
// moved one would legitimately stay where that one went. First, it takes the preferred bottom band; the cue over the face must leave it.
const CUE_CLEAR = Object.freeze({ id: 'cue-clear', startFrame: 10, endFrame: 50, text: 'Legenda no trecho livre', anchor: 'bottom' })
const CUE_FACE = Object.freeze({ id: 'cue-face', startFrame: 70, endFrame: 110, text: 'Legenda sobre o rosto', anchor: 'bottom' })
const CLEAR_CUE_FRAMES = Object.freeze([15, 30, 45])
const FACE_CUE_FRAMES = Object.freeze([75, 90, 105])
const QUIET_FRAMES = Object.freeze([2, 55, 65, 115])

// ---- the oracle: code of its own, no import from the critic's decision logic -----------------------------------------------------
const isMarker = (r, g, b) => r > 170 && b > 170 && g < 100
const isFrameGreen = (r, g, b) => g > 190 && r < 80 && b < 80
function boxOf(raw, width, height, predicate, within = null) {
  const from = within ?? { left: 0, top: 0, right: width, bottom: height }
  let minX = width, minY = height, maxX = -1, maxY = -1, count = 0
  for (let y = Math.max(0, Math.floor(from.top)); y < Math.min(height, Math.ceil(from.bottom)); y += 1) {
    for (let x = Math.max(0, Math.floor(from.left)); x < Math.min(width, Math.ceil(from.right)); x += 1) {
      const o = (y * width + x) * 3
      if (!predicate(raw[o], raw[o + 1], raw[o + 2])) continue
      count += 1; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y
    }
  }
  return count < 40 ? null : { left: minX, top: minY, right: maxX + 1, bottom: maxY + 1, count }
}
const intersects = (a, b) => a !== null && b !== null && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
const px = (box, width, height) => ({ left: box.x * width, top: box.y * height, right: (box.x + box.width) * width, bottom: (box.y + box.height) * height })
const insideBand = (footprint, band, tolerance) => footprint.x >= band.x - tolerance.x && footprint.y >= band.y - tolerance.y &&
  footprint.x + footprint.width <= band.x + band.width + tolerance.x && footprint.y + footprint.height <= band.y + band.height + tolerance.y

/** The tests-only veto detector: it finds the stand-in face by colour on the caption-free frame, inside the picture's green frame. */
const markerVeto = {
  id: 'color-key-marker',
  async detect({ width, height, rgb }) {
    const picture = boxOf(rgb, width, height, isFrameGreen)
    const box = picture ? boxOf(rgb, width, height, isMarker, picture) : null
    return box ? [{ x: box.left / width, y: box.top / height, width: (box.right - box.left) / width, height: (box.bottom - box.top) / height }] : []
  },
}

function qualityReportFor({ suffix, evaluatedAt, createQualityReport, resolveStrategicRubric }) {
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
      forbiddenSpeechAbsent: true, timelineContinuous: true },
    issues: [{ code: 'FACE_PERCEPTION_UNAVAILABLE_REVIEW_REQUIRED', severity: 'warning', category: 'editorial',
      message: 'Face detector evidence is unavailable. Caption placement requires review before approval or final export.', correctable: true }],
    criticVersion: 'apollo-director-critic/v3', evaluatedAt,
  }
}

test('T-W65B final export on a Director cut with face evidence keyed by source time: reused across Versions, projected through the clips, confirmed in pixels', {
  skip: process.env.APOLLO_FINAL_SOURCE_EVIDENCE_E2E !== '1' && 'set APOLLO_FINAL_SOURCE_EVIDENCE_E2E=1 and use an isolated V2 database (supervised harness)',
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
  const { sourceWindowHarness } = await import('./helpers/face-source-pg.mjs')
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
  const { PrismaFaceSourceWindowRepository } = await import('../../src/v2/infrastructure/prisma/face-source-window-repository.ts')
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
  const protectedPayloadKeyId = `final-source-${suffix}`
  const protectedPayloadKey = Buffer.alloc(32, 9).toString('base64url')
  const workerEnvironment = {
    ...process.env, APOLLO_V2_ARTIFACT_ROOT: artifactRoot, APOLLO_V2_ARTIFACT_STORAGE_DRIVER: 'local', FFMPEG_PATH: ffmpegBin,
    APOLLO_V2_RENDER_LEASE_MS: '300000', APOLLO_V2_RENDER_HEARTBEAT_MS: '5000', APOLLO_V2_WORKER_RETRY_BASE_MS: '1', APOLLO_V2_WORKER_RETRY_MAX_MS: '1',
    APOLLO_PROTECTED_PAYLOAD_KEY_ID: protectedPayloadKeyId, APOLLO_PROTECTED_PAYLOAD_KEY: protectedPayloadKey,
  }
  const scratch = await mkdtemp(join(tmpdir(), 'w65bs-'))
  const evidence = []
  let primaryError

  /** One master, generated once; every world copies the same bytes, so a pixel difference is never the source. */
  const masterPath = join(scratch, 'master.mp4')
  async function master() {
    await execFileAsync(ffmpegBin, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=0x303030:s=${MASTER.width}x${MASTER.height}:r=${FPS}:d=6`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-vf', `drawbox=x=0:y=0:w=iw:h=ih:color=0x00ff00:t=3,drawbox=x=${MARKER.x}:y=${MARKER.y}:w=${MARKER.w}:h=${MARKER.h}:color=0xff00ff:t=fill:enable='between(n,${FACE_FIRST_SOURCE_FRAME},${SOURCE_FRAMES - 1})'`,
      '-t', '6', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', masterPath],
    { windowsHide: true, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })
    const bytes = await readFile(masterPath)
    return Object.freeze({ path: masterPath, bytes, sha256: sha256(bytes) })
  }

  /**
   * One complete world: root + explicit 9:16 variant, the source's persisted ingest, a BASE Version playing the whole source, the
   * face windows requested under that base, a neutral LUT, and the Director's Version - the cut - with a `review-required` report
   * whose face safety is UNKNOWN, plus the ready proxy review the final is approved from.
   */
  async function seedWorld({ key, source, cues, windows = [], rowsAt = () => [] }) {
    const id = (name) => `w65s-${key}-${name}-${suffix}`
    const workspaceId = id('workspace'), projectId = id('project'), baseVersionId = id('base'), projectVersionId = id('version')
    const directorRunId = id('director'), sourceArtifactId = id('source'), sourceManifestId = id('source-manifest')
    const proxyArtifactId = id('proxy'), proxyManifestId = id('proxy-manifest'), proxyOperationId = id('proxy-operation')
    const proxyReviewId = id('proxy-review'), editPlanSnapshotId = id('edit-plan'), qualitySnapshotId = id('quality')
    const sourceArtifactKey = `workspaces/w65s-${suffix}-${key}/masters/source.mp4`
    const sourcePath = join(artifactRoot, ...sourceArtifactKey.split('/'))
    await mkdir(dirname(sourcePath), { recursive: true })
    await copyFile(source.path, sourcePath)
    await client.v2Workspace.create({ data: { id: workspaceId, slug: workspaceId, name: `W65b source ${key}`, status: 'active', createdAt, updatedAt: createdAt } })
    const issued = await createApiClientService({ repository: new PrismaApiClientRepository(client), credentialCrypto: nodeApiCredentialCrypto, clock: () => createdAt })({
      id: id('client'), workspaceId, name: `W65b source ${key}`, environment: 'production',
      scopes: ['projects:read', 'projects:write', 'operations:read', 'artifacts:read'] })
    const actor = testActor({ workspaceId, clientId: issued.client.id, credentialId: issued.credential.id, environment: 'production',
      scopes: ['projects:read', 'projects:write', 'operations:read', 'artifacts:read', 'operations:cancel'] })
    await seedReviewProject(client, { workspaceId, actor, prefix: `w65s-${key}`, ids: { project: projectId }, name: `W65b source ${key}`,
      objective: 'discovery', aspectRatio: '9:16', status: 'reviewing-proxy' })
    // The ingest ran before the controlled instant of the rest of the fixture, so its operation is the older one.
    await registerMeasuredVideo(client, { workspaceId, projectId, actor, artifactId: sourceArtifactId,
      artifactKey: sourceArtifactKey, sha256: source.sha256, byteSize: source.bytes.byteLength,
      probe: { width: MASTER.width, height: MASTER.height, duration: SOURCE_FRAMES / FPS, fps: FPS }, slug: `w65s-${key}-${suffix}`, manifestId: sourceManifestId,
      originalFileName: 'w65s-source.mp4', recipeId: 'source-master', createdAt: new Date(createdAt.getTime() - 60_000) })
    await registerColorPipeline(client, { workspaceId, projectId, actor, artifactId: sourceArtifactId, manifestId: sourceManifestId, createdAt })
    await setAssetRightsService({ repository: new PrismaAssetRightsRepository(client), clock: () => createdAt, createId: () => id('rights') })({
      workspaceId, artifactId: sourceArtifactId, baseRevision: assetRightsRevision(sourceArtifactId, 0),
      // `editing` is the use face analysis is allowed under; the render needs `rendering`
      draft: { status: 'approved', allowedUses: ['editing', 'rendering', 'editorial-reuse'], prohibitedUses: [], allowedLocales: ['pt-BR'],
        consent: { status: 'approved', allowedUses: ['editing', 'rendering', 'editorial-reuse'], allowedLocales: ['pt-BR'] } },
      actor: { type: 'api-client', id: issued.client.id } })

    const clip = (name, bounds) => ({ id: id(name), sourceArtifactId, rate: 1, ...bounds })
    const planOf = ({ planId, versionId, clips, durationFrames, withCues }) => ({
      schemaVersion: 2, state: 'compiled', id: planId, projectVersionId: versionId, fps: FPS, durationFrames,
      videoTracks: [{ id: id(`track-${planId}`), kind: 'base-video', clips }],
      sources: [{ id: sourceArtifactId, artifactId: sourceArtifactId, kind: 'video', durationSeconds: SOURCE_FRAMES / FPS }],
      overlayTracks: [], audioTracks: [], effectTracks: [], markers: [], protectedElements: [],
      localeVariantRefs: [], formatVariantRefs: [], lineageRefs: [sourceArtifactId],
      subtitleTracks: withCues && cues.length ? [{ id: 'track-captions', kind: 'captions', presetId: 'clean-color', anchor: 'bottom', faceProtection: true,
        maxLines: 2, maxCharactersPerBlock: 32, cues: cues.map((cue) => ({ ...cue })) }] : [],
      transitions: [], movementPolicy: { automaticZoom: false, protectedOpeningFrames: 120 },
    })
    // The BASE Version plays the whole source in one clip.
    const baseEditPlan = planOf({ planId: id('base-plan'), versionId: baseVersionId, durationFrames: SOURCE_FRAMES, withCues: false,
      clips: [clip('base-clip', { sourceInFrame: 0, sourceOutFrame: SOURCE_FRAMES, timelineInFrame: 0, timelineOutFrame: SOURCE_FRAMES })] })
    const baseBundle = await commitSealedChild(client, { workspaceId, projectId, actor, suffix: id('base-commit'),
      versionId: baseVersionId, mutatePlan: () => baseEditPlan, adopt: [sourceArtifactId] })

    // ---- the face windows, in SOURCE frames, requested while the project's head is the BASE Version ----
    const windowWorld = { suffix: `${key}-${suffix}`, workspaceId, projectId, sourceId: sourceArtifactId, clientId: issued.client.id, actor }
    const harness = sourceWindowHarness(client, windowWorld)
    const produced = []
    for (const [index, window] of windows.entries()) {
      produced.push(await harness.publish(`${key}-window-${index}`, window, rowsAt, { actor }))
    }
    const requestedHead = await client.v2Project.findUniqueOrThrow({ where: { id: projectId } })
    assert.equal(requestedHead.currentVersionId, baseBundle.version.id, 'the windows are requested under the base Version')

    const noLut = await setProjectLutSelectionService({
      repository: new PrismaProjectLutSelectionRepository(client), createId: (kind) => `${id('lut')}-${kind}`, createEventId: randomUUID, clock: () => createdAt,
    })({ workspaceId, projectId, baseVersionId: baseBundle.version.id, baseHash: baseBundle.version.baseHash,
      selection: { mode: 'none' }, actor, idempotencyKey: id('lut-none'), reason: 'Keep this fixture colorimetrically neutral.' })
    assert.equal(noLut.selection.resolved.mode, 'none')
    // The run's own snapshots. A snapshot is inserted, never edited.
    const qualityReport = qualityReportFor({ suffix: `${key}-${suffix}`, evaluatedAt: createdAt.toISOString(), createQualityReport, resolveStrategicRubric })
    const snapshotIds = { perception: id('perception'), treatment: id('treatment'), story: id('story'), quality: qualitySnapshotId }
    for (const [snapshotId, kind, schemaVersion, content] of [
      [snapshotIds.perception, 'perception', 1, { schemaVersion: 1, id: snapshotIds.perception,
        timeline: createPerceptionTimeline({ durationMs: 6_000, observations: [] }),
        summary: { id: `${snapshotIds.perception}-summary`, speechCoverage: 0, visualCoverage: 'absent', faceCoverage: 'absent', confidence: 0,
          sourceTranscriptId: id('transcript') } }],
      [snapshotIds.treatment, 'treatment', 1, { schemaVersion: 1, state: 'complete' }],
      [snapshotIds.story, 'story', 1, { schemaVersion: 1, state: 'complete' }],
      [snapshotIds.quality, 'quality-report', 3, qualityReport],
    ]) {
      await client.v2ProjectSnapshot.create({ data: { id: snapshotId, workspaceId, projectId, kind, schemaVersion,
        contentJson: stableSerialize(content), contentHash: calculateVersionHash(content), createdAt } })
    }
    // The Director's Version: a real child Command (run-director) that plays the SAME source through the cut.
    const editPlan = planOf({ planId: id('plan'), versionId: projectVersionId, durationFrames: CUT_FRAMES, withCues: true,
      clips: CUT.map((bounds, index) => clip(`cut-clip-${index + 1}`, bounds)) })
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
    const proxyArtifactKey = `workspaces/w65s-${suffix}-${key}/proxies/proxy.mp4`
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
      role: 'editorial-proxy', originalFileName: 'w65s-proxy.mp4', createdAt } })
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
      outputArtifactId: proxyArtifactId, outputManifestId: proxyManifestId, originalFileName: 'w65s-proxy.mp4', createdAt } })
    await client.v2ProxyReview.create({ data: { id: proxyReviewId, workspaceId, projectId, projectVersionId, operationId: proxyOperationId,
      proxyArtifactId, proxyManifestId, inputHash: proxyInputHash, outputSpecId: 'preset-9x16',
      rangeCacheKey: calculateVersionHash({ proxyReviewId, ranges: [] }),
      specJson: stableSerialize({ width: 540, height: 960, codec: 'h264', container: 'mp4', quality: 'review', reusableRanges: true }),
      status: 'ready-for-final', technicalIssuesJson: stableSerialize([]), criticIssuesJson: stableSerialize([]), warningsAcknowledged: false,
      finalAllowed: true, reviewHash: calculateVersionHash({ proxyReviewId, projectVersionId, proxyArtifactId, status: 'ready-for-final' }),
      revision: 1, uploadReceivedAt: createdAt, renderCompletedAt: createdAt, timeToFirstProxyMs: 0n, createdAt, updatedAt: createdAt } })
    return Object.freeze({ key, workspaceId, projectId, baseVersionId: baseBundle.version.id, projectVersionId, projectVersionHash, actor,
      windows: Object.freeze(produced), windowOperationIds: Object.freeze(produced.map((row) => row.operationId)) })
  }

  const finalRepository = new PrismaProjectFinalExportRepository(client)
  const operations = new PrismaPublicOperationRepository(client, randomUUID, () => createProtectedPayloadCipherFromEnvironment(workerEnvironment))
  const rights = new PrismaAssetRightsRepository(client)
  const enqueue = (world, tag) => enqueueProjectFinalExportService({ projects: finalRepository, rights, operations,
    colorPipelines: createColorPipelineCompilationRepository(), clock: () => new Date(),
    createId: (kind) => `w65s-${world.key}-${kind}-${tag}-${suffix}` })({
    workspaceId: world.workspaceId, projectId: world.projectId, projectVersionId: world.projectVersionId, projectVersionHash: world.projectVersionHash,
    format: '9:16', approval: { approved: true, note: 'W65b: face safety stays unknown; captions are certified per burned cue.' },
    actor: world.actor, idempotencyKey: `w65s-final-${world.key}-${tag}-${suffix}` })
  const worker = () => runNextProjectFinalExportOperationService({
    mp4ExportAcknowledgement: { actor: 'test-world', recordedAt: '2026-10-20T00:00:00.000Z', reason: 'this world wires no MP4 critic (W67 fails closed without one)' },
    operations, projects: finalRepository, rights, artifacts: createMediaArtifactPersistenceRepository(workerEnvironment),
    storage: createLocalMediaUploadStorageFromEnvironment(workerEnvironment),
    renderer: createFfmpegEditorialProxyRendererFromEnvironment(workerEnvironment),
    renderElementMaps: createRenderElementMapRepository(), colorPipelines: createColorPipelineCompilationRepository(),
    colorPlans: createProjectColorPlanRepository(),
    luts: new LocalProjectLutRenderMaterializer(createProjectLutSelectionRepository(), join(resolve(artifactRoot), '.lut-work'), createWorkspaceLutRepository()),
    sources: createArtifactSourceMaterializer(workerEnvironment), catalogOutput: createAutomaticCatalogService(),
    faceEvidence: new PrismaFaceSourceWindowRepository(client),
    captionPixelCritic: new FfmpegCaptionPixelCritic({ ffmpegPath: ffmpegBin, faceVeto: markerVeto }),
    leaseDurationMs: 300_000, heartbeatIntervalMs: 5_000, retryBaseDelayMs: 1, retryMaxDelayMs: 1,
  })

  /** Runs the whole chain for one world and returns the delivered MP4 (copied next to the test, away from the long artifact key). */
  async function finalFor(world) {
    const queued = await enqueue(world, 'one')
    assert.equal(queued.replayed, false)
    const outcome = await worker()(`w65s-worker-${world.key}-${suffix}`)
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
  async function png(path, number, target) {
    await execFileAsync(ffmpegBin, ['-hide_banner', '-loglevel', 'error', '-y', '-i', path, '-vf', `select='eq(n,${number})'`, '-frames:v', '1', '-fps_mode', 'passthrough', target],
      { windowsHide: true, timeout: 60_000 })
  }

  try {
    const masterFile = await master()
    const EVERYWHERE = { startSourceFrame: 0, endSourceFrame: SOURCE_FRAMES }
    const FIRST_PART = { startSourceFrame: 0, endSourceFrame: 150 }
    // the detector stand-in sees the stand-in face where the source has it: source frames 120-179
    const faceWhereTheSourceHasIt = (frame) => (frame >= FACE_FIRST_SOURCE_FRAME ? [FACE_ROW] : [])
    // a producer that measured on the TIMELINE would have put the face at timeline 60-119 (where it is on screen) and none elsewhere
    const faceWhereTheTimelineHasIt = (frame) => (frame >= 60 && frame < 120 ? [FACE_ROW] : [])

    const worlds = {
      F0: await seedWorld({ key: 'f0', source: masterFile, cues: [] }),
      F1: await seedWorld({ key: 'f1', source: masterFile, cues: [CUE_CLEAR, CUE_FACE], windows: [EVERYWHERE], rowsAt: faceWhereTheSourceHasIt }),
      F2: await seedWorld({ key: 'f2', source: masterFile, cues: [CUE_CLEAR, CUE_FACE], windows: [FIRST_PART], rowsAt: faceWhereTheSourceHasIt }),
      F3: await seedWorld({ key: 'f3', source: masterFile, cues: [CUE_CLEAR, CUE_FACE], windows: [EVERYWHERE], rowsAt: faceWhereTheTimelineHasIt }),
    }

    // ---- the evidence was produced in SOURCE frames, under a Version that is not the one exported ----
    for (const key of ['F1', 'F2', 'F3']) {
      const world = worlds[key]
      assert.notEqual(world.baseVersionId, world.projectVersionId)
      for (const row of world.windows) {
        assert.equal(row.schemaVersion, 'face-producer-envelope/v3')
        const requested = await client.v2FaceProducerOperation.findUniqueOrThrow({ where: { operationId: row.operationId } })
        assert.equal(requested.projectVersionId, world.baseVersionId, `${key}: the window was requested under the base Version`)
        assert.notEqual(requested.projectVersionId, world.projectVersionId)
        assert.equal(requested.detectorProfile, 'openvino-face0204-v9-source')
        const content = JSON.parse(row.contentJson)
        assert.ok(!('projectVersionId' in content) && !('timeMap' in content) && !('timelineDurationFrames' in content))
        assert.equal(content.sourceArtifactId.endsWith(`-source-${suffix}`), true)
      }
    }

    // ---- the four finals ----
    const F0 = await finalFor(worlds.F0)
    const F1 = await finalFor(worlds.F1)
    const F2 = await finalFor(worlds.F2)
    for (const [label, entry] of Object.entries({ F0, F1, F2 })) {
      evidence.push({ label, key: entry.world.key, operationId: entry.operationId, sha256: entry.output.sha256, byteSize: entry.output.byteSize, certification: entry.certification.message })
    }
    // the gate admitted the report as it is: face safety stayed unknown in the database
    for (const entry of [F1, F2]) {
      const stored = await client.v2ProjectSnapshot.findUniqueOrThrow({ where: { id: `w65s-${entry.world.key}-quality-${suffix}` } })
      const report = JSON.parse(stored.contentJson)
      assert.equal(report.status, 'review-required')
      assert.deepEqual(report.faceSafety, { status: 'unknown', reasonCode: 'FACE_PERCEPTION_UNAVAILABLE', evidenceRefs: [] })
    }
    // the attempt records say what was burned and what was left out
    assert.match(F0.certification.message, /^0 caption\(s\) burned.*0 omitted/)
    assert.match(F1.certification.message, /^2 caption\(s\) burned in certified bands, confirmed by the pixel critic \(ran\); 0 omitted and listed for review/)
    assert.match(F2.certification.message, /^1 caption\(s\) burned in certified bands.*1 omitted and listed for review: cue-face \(FACE_PERCEPTION_UNAVAILABLE\)/)

    // ---- pixels ----
    const preset = readOutputFormatPreset('9:16')
    const { width, height } = { width: 1080, height: 1920 }
    const bands = deriveSubtitleAnchorBands({ region: deriveSubtitleRegion({ spec: preset.spec, presetId: 'clean-color' }), safeArea: preset.spec.safeArea })
    const tolerance = { x: CAPTION_BAND_TOLERANCE_PX / width, y: CAPTION_BAND_TOLERANCE_PX / height }
    const otherBands = Object.entries(bands).filter(([name]) => name !== 'bottom')
    assert.ok(otherBands.length > 0, 'the preset offers a band other than the bottom one')
    const facts = { premise: [], faceCueMovedOffTheFace: [], clearCueInBottomBand: [], quiet: [], omitted: [], keyedByTimelineCaught: null }

    // the premise, from the delivered control: the stand-in face is on screen on timeline 60-119 and not on 0-59
    const markerAt = new Map()
    for (const number of [...FACE_CUE_FRAMES, ...CLEAR_CUE_FRAMES]) {
      const raw = await frame(F0.delivered, number, width, height)
      const picture = boxOf(raw, width, height, isFrameGreen)
      assert.ok(picture, `the picture's frame is in the control at timeline frame ${number}`)
      const box = boxOf(raw, width, height, isMarker, picture)
      markerAt.set(number, box)
      facts.premise.push({ frame: number, marker: box })
    }
    for (const number of FACE_CUE_FRAMES) assert.ok(markerAt.get(number), `the stand-in face is on screen at timeline frame ${number} (source ${number + 60})`)
    for (const number of CLEAR_CUE_FRAMES) assert.equal(markerAt.get(number), null, `no stand-in face at timeline frame ${number} (source ${number})`)
    const markerBox = markerAt.get(FACE_CUE_FRAMES[0])
    const bottomPx = px(bands.bottom, width, height)
    assert.equal(intersects({ left: bottomPx.left, top: bottomPx.top, right: bottomPx.right, bottom: bottomPx.bottom }, markerBox), true, 'the stand-in face is under the bottom band')

    // F1: the cue over the free stretch takes the preferred bottom band; the cue over the face is burned OFF it, in another band
    for (const number of FACE_CUE_FRAMES) {
      const [delivered, control] = await Promise.all([frame(F1.delivered, number, width, height), frame(F0.delivered, number, width, height)])
      const measured = captionFootprintOf(delivered, control, width, height)
      assert.ok(measured.footprint && measured.changedPixels >= MIN_CHANGED_PIXELS, `F1 burned the face cue at frame ${number} (${measured.changedPixels} changed pixels)`)
      const box = px(measured.footprint, width, height)
      assert.equal(intersects(box, markerAt.get(number)), false, `the face cue does not cover the stand-in face at frame ${number}`)
      assert.equal(insideBand(measured.footprint, bands.bottom, tolerance), false, `the face cue left the bottom band at frame ${number}`)
      const band = otherBands.find(([, candidate]) => insideBand(measured.footprint, candidate, tolerance))
      assert.ok(band, `the face cue sits inside another certified band at frame ${number}: ${JSON.stringify(measured.footprint)}`)
      facts.faceCueMovedOffTheFace.push({ frame: number, band: band[0], changedPixels: measured.changedPixels, footprint: measured.footprint, marker: markerAt.get(number) })
    }
    for (const number of CLEAR_CUE_FRAMES) {
      const [delivered, control] = await Promise.all([frame(F1.delivered, number, width, height), frame(F0.delivered, number, width, height)])
      const measured = captionFootprintOf(delivered, control, width, height)
      assert.ok(measured.footprint && measured.changedPixels >= MIN_CHANGED_PIXELS, `F1 burned the clear cue at frame ${number} (${measured.changedPixels} changed pixels)`)
      assert.equal(insideBand(measured.footprint, bands.bottom, tolerance), true, `the clear cue stands in the preferred bottom band at frame ${number}: ${JSON.stringify(measured.footprint)}`)
      facts.clearCueInBottomBand.push({ frame: number, changedPixels: measured.changedPixels, footprint: measured.footprint })
    }
    for (const number of QUIET_FRAMES) {
      const [delivered, control] = await Promise.all([frame(F1.delivered, number, width, height), frame(F0.delivered, number, width, height)])
      const measured = captionFootprintOf(delivered, control, width, height)
      assert.equal(measured.footprint, null, `F1 has no caption outside the cues (frame ${number}, ${measured.changedPixels} changed pixels)`)
      facts.quiet.push({ frame: number, changedPixels: measured.changedPixels })
    }

    // F2: evidence only over source 0-149: the cue over source 130-169 (timeline 70-109) cannot be certified, so NOTHING is drawn for it
    for (const number of FACE_CUE_FRAMES) {
      const [delivered, control] = await Promise.all([frame(F2.delivered, number, width, height), frame(F0.delivered, number, width, height)])
      const measured = captionFootprintOf(delivered, control, width, height)
      assert.equal(measured.footprint, null, `F2 drew nothing for the uncertifiable cue (frame ${number}, ${measured.changedPixels} changed pixels)`)
      facts.omitted.push({ frame: number, changedPixels: measured.changedPixels })
    }
    for (const number of CLEAR_CUE_FRAMES) {
      const [delivered, control] = await Promise.all([frame(F2.delivered, number, width, height), frame(F0.delivered, number, width, height)])
      const measured = captionFootprintOf(delivered, control, width, height)
      assert.ok(measured.footprint, `F2 burned the covered cue at frame ${number}`)
      assert.equal(insideBand(measured.footprint, bands.bottom, tolerance), true)
    }

    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true })
      await png(F0.delivered, 30, join(evidenceDir, 'F0-control-timeline-30-no-face.png'))
      await png(F0.delivered, 90, join(evidenceDir, 'F0-control-timeline-90-face-on-screen.png'))
      await png(F1.delivered, 30, join(evidenceDir, 'F1-clear-cue-in-bottom-band-30.png'))
      await png(F1.delivered, 90, join(evidenceDir, 'F1-face-cue-moved-off-the-face-90.png'))
      await png(F2.delivered, 30, join(evidenceDir, 'F2-covered-cue-burned-30.png'))
      await png(F2.delivered, 90, join(evidenceDir, 'F2-uncertifiable-cue-omitted-90.png'))
    }

    // F3 (mutation): evidence placed at the TIMELINE's frames instead of the source's says "no face" under the cue that is over the
    // face, so the cue is planned onto it - and the pixel critic, which looks at the delivered pixels, refuses to deliver the final.
    const wrongQueued = await enqueue(worlds.F3, 'one')
    const wrongOutcome = await worker()(`w65s-worker-f3-${suffix}`)
    const wrongAttempt = await client.v2ProjectFinalExportAttempt.findFirst({ where: { operationId: wrongQueued.operation.id }, orderBy: { attempt: 'desc' } })
    assert.notEqual(wrongOutcome?.status, 'succeeded', JSON.stringify(wrongOutcome))
    assert.notEqual(wrongAttempt?.status, 'promoted')
    assert.equal(wrongAttempt?.outputArtifactId ?? null, null, 'no final was delivered on the wrong evidence')
    assert.equal(wrongAttempt?.errorCode, 'render_output_invalid')
    const wrongValidators = JSON.parse(wrongAttempt.validatorsJson)
    const wrongCertification = wrongValidators.find((validator) => validator.code === 'FINAL_CAPTION_CERTIFICATION')
    assert.equal(wrongCertification?.passed, false)
    assert.match(wrongCertification.message, /pixel|face|overlap/i, wrongCertification.message)
    facts.keyedByTimelineCaught = { status: wrongAttempt.status, errorCode: wrongAttempt.errorCode, certification: wrongCertification.message }

    console.log(JSON.stringify({ event: 'w65b-final-source-evidence-proof', finals: evidence, pixelFacts: facts, bands, canvas: { width, height },
      cut: CUT, windowOperations: Object.fromEntries(Object.entries(worlds).map(([key, world]) => [key, world.windowOperationIds])), faceSafety: 'unknown' }))
    if (evidenceDir) await writeFile(join(evidenceDir, 'w65b-final-source-evidence-proof.json'), JSON.stringify({ finals: evidence, pixelFacts: facts, bands, cut: CUT }, null, 2))
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
        for (const key of ['f0', 'f1', 'f2', 'f3']) {
          await rm(join(artifactRoot, 'workspaces', `w65s-${suffix}-${key}`), { recursive: true, force: true })
          await rm(join(artifactRoot, 'workspaces', `w65s-${key}-workspace-${suffix}`), { recursive: true, force: true })
        }
      }],
    ]) {
      try { await action() } catch (error) { cleanupErrors.push(Object.assign(error, { cleanupStage: name })) }
    }
    if (cleanupErrors.length) throw new AggregateError(primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors, 'W65b source evidence fixture failed to clean up')
  }
  if (primaryError) throw primaryError
})
