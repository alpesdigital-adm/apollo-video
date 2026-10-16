import assert from 'node:assert/strict'
import { ASS_EMISSION_POLICY } from '../../src/v2/domain/ass-emission-policy.ts'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const ffmpegStatic = require('ffmpeg-static')
const ffprobeStatic = require('ffprobe-static').path
const FORMATS = ['9:16', '16:9', '4:5', '1:1', '21:9']

function matrixMediaBinaries(environment = process.env) {
  return {
    ffmpeg: environment.FFMPEG_BIN?.trim() || environment.FFMPEG_PATH?.trim() || ffmpegStatic,
    ffprobe: environment.APOLLO_V2_FFPROBE_PATH?.trim() || environment.FFPROBE_PATH?.trim() ||
      environment.FFPROBE_BIN?.trim() || environment.APOLLO_OCR_FFPROBE?.trim() || ffprobeStatic,
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function ownedChild(root, target, expectedPrefix) {
  const inside = relative(resolve(root), resolve(target))
  assert.ok(inside && inside !== '..' && !inside.startsWith(`..${sep}`) &&
    !isAbsolute(inside) && basename(target).startsWith(expectedPrefix),
  'matrix test cleanup target escaped its owned directory')
  return resolve(target)
}

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

async function waitForServer(baseUrl, child, readLogs) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Next server exited with ${child.exitCode}\n${readLogs().slice(-4_000)}`)
    try {
      if ((await fetch(`${baseUrl}/v1/health`)).ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Next server did not become ready')
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolve) => {
    child.once('exit', () => resolve(true))
    child.once('error', () => resolve(true))
  })
  child.kill('SIGTERM')
  let gracefulTimer
  const graceful = await Promise.race([
    exited,
    new Promise((resolve) => {
      gracefulTimer = setTimeout(() => resolve(false), 5_000)
    }),
  ])
  clearTimeout(gracefulTimer)
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    let forcedTimer
    const forced = await Promise.race([
      exited,
      new Promise((resolve) => {
        forcedTimer = setTimeout(() => resolve(false), 2_000)
      }),
    ])
    clearTimeout(forcedTimer)
    if (!forced) throw new Error(`Next server PID ${child.pid} ignored SIGKILL`)
  }
  if (child.exitCode === null && child.signalCode === null)
    throw new Error(`Next server PID ${child.pid} did not stop`)
}

function matrixPerceptionSnapshot(id, sourceTranscriptId, createPerceptionTimeline) {
  return {
    schemaVersion: 1, id,
    timeline: createPerceptionTimeline({ durationMs: 1000, observations: [] }),
    summary: { id: `${id}-summary`, speechCoverage: 0,
      visualCoverage: 'absent', faceCoverage: 'absent', confidence: 0,
      sourceTranscriptId },
  }
}

function matrixReviewRequiredQuality(id, desiredActionId, evaluatedAt,
  createQualityReport, resolveStrategicRubric) {
  const rubric = resolveStrategicRubric('discovery')
  const strategic = createQualityReport({ objective: 'discovery',
    evidence: rubric.criteria.map((criterion) => ({ criterionId: criterion.id,
      score: 100, evidence: [`controlled:${criterion.id}`] })),
    gates: { narrativeIntegrity: true, legibility: true, rights: true },
    evaluatedAt })
  return { rubric, report: {
    schemaVersion: 'director-quality-report/v3', id,
    status: 'review-required', score: 1, desiredActionRef: { id: desiredActionId },
    strategic, faceSafety: { status: 'unknown', reasonCode: 'FACE_PERCEPTION_UNAVAILABLE', evidenceRefs: [] },
    hardChecks: { openingMotionProtected: true, automaticZoomDisabled: true,
      subtitlesFaceSafe: false, subtitlesBounded: true, forbiddenSpeechAbsent: true,
      timelineContinuous: true },
    issues: [], criticVersion: 'matrix-controlled-critic-1.0.0', evaluatedAt,
  } }
}

function matrixDeniedCommitBody() {
  return { commitToken: 'blocked-preflight-no-token-'.padEnd(80, 'x'),
    approval: { approved: true, note: 'Controlled request must be denied.' } }
}

async function matrixPublicValidators() {
  const [{ default: Ajv2020 }, { default: addFormats }, { getPublicSchema }] = await Promise.all([
    import('ajv/dist/2020.js'), import('ajv-formats'),
    import('../../src/v2/public-api/schema-registry.ts'),
  ])
  const ajv = addFormats(new Ajv2020({ strict: false, allErrors: true }))
  const compile = (name) => ajv.compile(getPublicSchema(`apollo://schemas/${name}/v1`).schema)
  return {
    preflightRequest: compile('export-matrix-preflight-request'),
    preflightCreated: compile('export-matrix-preflight-created'),
    commitRequest: compile('commit-export-matrix-request'),
    matrixResponse: compile('export-matrix-response'),
    errorResponse: ajv.compile(getPublicSchema('apollo://schemas/error-envelope/v5').schema),
  }
}

test('export matrix controlled fixture hydrates unknown perception, quality and operation controls offline', async () => {
  const validators = await matrixPublicValidators()
  const [{ getPublicSchema }, { publicSchemaExamples }] = await Promise.all([
    import('../../src/v2/public-api/schema-registry.ts'),
    import('../../src/v2/public-api/schema-examples.ts'),
  ])
  for (const [name, validator] of [
    ['export-matrix-preflight-request', validators.preflightRequest],
    ['export-matrix-preflight-created', validators.preflightCreated],
    ['commit-export-matrix-request', validators.commitRequest],
    ['export-matrix-response', validators.matrixResponse],
  ]) {
    const examples = publicSchemaExamples(getPublicSchema(`apollo://schemas/${name}/v1`))
    assert.ok(examples.length > 0, `${name} must have a public example`)
    for (const example of examples) assert.equal(validator(example), true,
      `${name}: ${JSON.stringify(validator.errors)}`)
  }
  const examplePreflightBody = { cells: [{ recipeId: 'review-required-master-v3',
    projectId: 'matrix-offline-project', projectVersionId: 'matrix-offline-version',
    projectVersionHash: 'a'.repeat(64), format: '9:16', locale: 'pt-BR' }],
  limits: { maximumCostMinorUnits: 100000000, maximumStorageBytes: 9000000000000 } }
  assert.equal(validators.preflightRequest(examplePreflightBody), true,
    JSON.stringify(validators.preflightRequest.errors))
  assert.equal(validators.commitRequest(matrixDeniedCommitBody()), true,
    JSON.stringify(validators.commitRequest.errors))
  const { createPerceptionTimeline } = await import('../../src/v2/domain/perception-timeline.ts')
  const { parseDirectorPerceptionSnapshotUnchecked } = await import('../../src/v2/infrastructure/prisma/director-run-repository.ts')
  const { createQualityReport, resolveStrategicRubric } = await import('../../src/v2/domain/strategic-rubric.ts')
  const { parseFinalExportQuality } = await import('../../src/v2/infrastructure/prisma/project-final-export-repository.ts')
  const { calculateVersionHash, stableSerialize } = await import('../../src/v2/application/version-hash.ts')
  const { createExternalAuditContext, materializeActorAuditContext } = await import('../../src/v2/application/authenticate-api-client.ts')
  const { cancelPublicOperationService } = await import('../../src/v2/application/cancel-public-operation.ts')
  const { retryPublicOperationService } = await import('../../src/v2/application/retry-public-operation.ts')
  const perception = matrixPerceptionSnapshot('matrix-offline-perception', 'matrix-offline-transcript', createPerceptionTimeline)
  const hydratedPerception = parseDirectorPerceptionSnapshotUnchecked({
    contentJson: stableSerialize(perception), contentHash: calculateVersionHash(perception),
    schemaVersion: 1, baseVersionId: 'matrix-offline-base',
  })
  assert.equal(hydratedPerception.summary.faceCoverage, 'absent')
  assert.equal(hydratedPerception.timeline.observations.length, 0)
  const evaluatedAt = '2026-08-24T20:00:00.000Z'
  const { rubric, report } = matrixReviewRequiredQuality('matrix-offline-quality',
    'matrix-offline-action', evaluatedAt, createQualityReport, resolveStrategicRubric)
  const hydratedQuality = parseFinalExportQuality({ contentJson: stableSerialize(report),
    contentHash: calculateVersionHash(report), contentSchemaVersion: 3,
    objective: 'discovery', rubricRef: `${rubric.id}/v${rubric.version}` })
  assert.equal(hydratedQuality.status, 'review-required')
  assert.equal(hydratedQuality.faceSafety.status, 'unknown')
  assert.equal(hydratedQuality.hardChecks.subtitlesFaceSafe, false)

  const auditContext = createExternalAuditContext({ clientId: 'matrix-offline-client',
    credentialId: 'matrix-offline-credential', workspaceId: 'matrix-offline-workspace',
    environment: 'production' })
  const actor = { ...auditContext, auditContext,
    scopes: new Set(['projects:write', 'operations:cancel', 'operations:retry']),
    authenticationKind: 'bearer', clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false, clientAccessStatus: 'active', workspaceAccessStatus: 'active' }
  const audit = materializeActorAuditContext(actor)
  const calls = []
  const operations = {
    async cancel(input) { calls.push(['cancel', input]); return { operation: { status: 'canceled' } } },
    async retry(input) { calls.push(['retry', input]); return { operation: { status: 'retrying' } } },
  }
  const clock = () => new Date(evaluatedAt)
  const controlId = () => 'matrix-offline-control'
  assert.equal((await cancelPublicOperationService({ operations, clock, createId: controlId })({
    workspaceId: actor.workspaceId, operationId: 'matrix-offline-operation', actor })).status, 'canceled')
  assert.equal((await retryPublicOperationService({ operations, clock, createId: controlId })({
    workspaceId: actor.workspaceId, operationId: 'matrix-offline-operation', actor })).status, 'retrying')
  assert.deepEqual(calls.map(([kind]) => kind), ['cancel', 'retry'])
  for (const [, input] of calls) {
    assert.equal(input.workspaceId, actor.workspaceId)
    assert.equal(input.operationId, 'matrix-offline-operation')
    assert.equal(input.authenticationAudit.contextHash, audit.contextHash)
  }
  assert.equal(calls[0][1].canceledAt, evaluatedAt)
  assert.equal(calls[1][1].requestedAt, evaluatedAt)
  assert.equal(Date.parse(calls[1][1].nextAttemptAt), Date.parse(evaluatedAt) + 1)
  const explicit = matrixMediaBinaries({ FFMPEG_BIN: 'C:/controlled/ffmpeg.exe',
    FFMPEG_PATH: 'C:/ignored/ffmpeg.exe', APOLLO_V2_FFPROBE_PATH: 'C:/controlled/ffprobe.exe',
    FFPROBE_PATH: 'C:/ignored/ffprobe.exe' })
  assert.equal(explicit.ffmpeg, 'C:/controlled/ffmpeg.exe')
  assert.equal(explicit.ffprobe, 'C:/controlled/ffprobe.exe')
  assert.equal(matrixMediaBinaries({}).ffmpeg, ffmpegStatic)
  assert.equal(matrixMediaBinaries({}).ffprobe, ffprobeStatic)
})

test('T-F2-GATE/F2.028 blocks the real API without facial authority and preserves five-cell export mechanics through a controlled port', {
  skip: process.env.APOLLO_EXPORT_MATRIX_E2E !== '1' && 'set APOLLO_EXPORT_MATRIX_E2E=1 with an isolated database',
  timeout: 300_000,
}, async () => {
  assert.ok(process.env.V2_DATABASE_URL)
  const databaseName = new URL(process.env.V2_DATABASE_URL).pathname.slice(1)
  assert.match(databaseName, /(?:^|_)e2e(?:_|$)/, 'the matrix E2E requires an isolated database')
  const artifactRoot = process.env.APOLLO_V2_ARTIFACT_ROOT?.trim() ?? ''
  const evidenceRoot = process.env.APOLLO_LIBRARY_EVIDENCE_ROOT?.trim()
  const { ffmpeg: ffmpegBin, ffprobe: ffprobeBin } = matrixMediaBinaries()
  assert.equal(isAbsolute(artifactRoot), true)
  if (evidenceRoot) {
    assert.equal(isAbsolute(evidenceRoot), true)
    const relativeToCheckout = relative(resolve(process.cwd()), resolve(evidenceRoot))
    assert.ok(relativeToCheckout === '..' || relativeToCheckout.startsWith(`..${sep}`) ||
      isAbsolute(relativeToCheckout), 'matrix evidence must stay outside the checkout')
  }
  assert.ok(ffmpegBin)
  assert.ok(ffprobeBin)
  assert.equal(isAbsolute(ffmpegBin), true)
  assert.equal(isAbsolute(ffprobeBin), true)

  const { assetRightsRevision, evaluateAssetUse } = await import('../../src/v2/domain/asset-rights.ts')
  const { createMediaColorProbe } = await import('../../src/v2/domain/color-and-export.ts')
  const { createPerceptionTimeline } = await import('../../src/v2/domain/perception-timeline.ts')
  const { readOutputFormatPreset } = await import('../../src/v2/domain/output-format-registry.ts')
  const { calculateVersionHash, stableSerialize } = await import('../../src/v2/application/version-hash.ts')
  const { createQualityReport, resolveStrategicRubric } = await import('../../src/v2/domain/strategic-rubric.ts')
  const { parseFinalExportQuality } = await import('../../src/v2/infrastructure/prisma/project-final-export-repository.ts')
  const { createExternalAuditContext } = await import('../../src/v2/application/authenticate-api-client.ts')
  const { createExportMatrixPreflightService, commitExportMatrixService } = await import('../../src/v2/application/export-matrices.ts')
  const { runNextProjectFinalExportOperationService } = await import('../../src/v2/application/run-project-final-export-worker.ts')
  const { cancelPublicOperationService } = await import('../../src/v2/application/cancel-public-operation.ts')
  const { retryPublicOperationService } = await import('../../src/v2/application/retry-public-operation.ts')
  const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
  const { setProjectLutSelectionService } = await import('../../src/v2/application/project-lut-selections.ts')
  const { setAssetRightsService } = await import('../../src/v2/application/set-asset-rights.ts')
  const {
    createArtifactSourceMaterializer, createAutomaticCatalogService,
    createColorPipelineCompilationRepository, createMediaArtifactPersistenceRepository,
    createProjectColorPlanRepository, createProjectLutSelectionRepository,
    createRenderElementMapRepository, createWorkspaceLutRepository,
  } = await import('../../src/v2/infrastructure/repository-factory.ts')
  const { createLocalMediaUploadStorageFromEnvironment } = await import('../../src/v2/infrastructure/media/local-media-upload-storage.ts')
  const { createFfmpegEditorialProxyRendererFromEnvironment } = await import('../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts')
  const { LocalProjectLutRenderMaterializer } = await import('../../src/v2/infrastructure/media/local-project-lut-render-materializer.ts')
  const { createExportMatrixCapacityProviderFromEnvironment } = await import('../../src/v2/infrastructure/export-matrix-capacity.ts')
  const { createPreflightCommitTokenIssuerFromEnvironment } = await import('../../src/v2/infrastructure/security/preflight-commit-token.ts')
  const { createProtectedPayloadCipherFromEnvironment } = await import('../../src/v2/infrastructure/security/recipe-parameter-cipher.ts')
  const { projectRenderSourcesFingerprint } = await import('../../src/v2/application/project-render-sources.ts')
  const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
  const { PrismaAssetRightsRepository } = await import('../../src/v2/infrastructure/prisma/asset-rights-repository.ts')
  const { PrismaProjectFinalExportRepository } = await import('../../src/v2/infrastructure/prisma/project-final-export-repository.ts')
  const { PrismaProjectProxyRenderRepository } = await import('../../src/v2/infrastructure/prisma/project-proxy-render-repository.ts')
  const { PrismaExportMatrixRepository } = await import('../../src/v2/infrastructure/prisma/export-matrix-repository.ts')
  const { PrismaPublicOperationRepository } = await import('../../src/v2/infrastructure/prisma/public-operation-repository.ts')
  const { PrismaProjectLutSelectionRepository } = await import('../../src/v2/infrastructure/prisma/project-lut-selection-repository.ts')
  const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
  const validators = await matrixPublicValidators()

  const client = new PrismaClient()
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `matrix-workspace-${suffix}`
  const sourceArtifactId = `matrix-source-${suffix}`
  const sourceManifestId = `matrix-source-manifest-${suffix}`
  const sourceArtifactKey = `workspaces/${workspaceId}/masters/shared-source.mp4`
  const sourcePath = join(artifactRoot, ...sourceArtifactKey.split('/'))
  const renderWorkRoot = join(artifactRoot, `.matrix-work-${suffix}`)
  const createdAt = new Date('2026-08-24T20:00:00.000Z')
  let server
  let serverLogs = ''
  let probeRoot
  let primaryError

  try {
    probeRoot = await mkdtemp(join(tmpdir(), 'apollo-matrix-probe-'))
    await client.$executeRawUnsafe('TRUNCATE TABLE "workspaces" CASCADE')
    await mkdir(dirname(sourcePath), { recursive: true })
    await execFileAsync(ffmpegBin, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', sourcePath,
    ], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })
    const sourceBytes = await readFile(sourcePath)
    const sourceSha = sha256(sourceBytes)

    await client.v2Workspace.create({ data: {
      id: workspaceId, slug: workspaceId, name: 'Export matrix E2E', status: 'active', createdAt, updatedAt: createdAt,
    } })
    const issued = await createApiClientService({
      repository: new PrismaApiClientRepository(client), credentialCrypto: nodeApiCredentialCrypto, clock: () => createdAt,
    })({
      id: `matrix-client-${suffix}`, workspaceId, name: 'Export matrix E2E', environment: 'production',
      scopes: ['projects:read', 'projects:write', 'operations:read', 'operations:cancel', 'operations:retry', 'artifacts:read'],
    })

    await client.v2MediaArtifact.create({ data: {
      id: sourceArtifactId, workspaceId, artifactKey: sourceArtifactKey, sha256: sourceSha,
      byteSize: BigInt(sourceBytes.byteLength), mediaType: 'video', container: 'mp4', status: 'available', createdAt,
    } })
    await client.v2MediaArtifactManifest.create({ data: {
      id: sourceManifestId, workspaceId, artifactId: sourceArtifactId,
      schemaVersion: 'media-artifact-manifest/v2', manifestHash: calculateVersionHash({ sourceManifestId }),
      recipeId: 'source-master', recipeVersion: '1.0.0',
      parametersHash: calculateVersionHash({ sourceManifestId, parameters: true }),
      manifestJson: stableSerialize({
        schemaVersion: 'media-artifact-manifest/v2',
        artifact: { artifactKey: sourceArtifactKey, sha256: sourceSha, byteSize: sourceBytes.byteLength, mediaType: 'video', container: 'mp4' },
        recipe: { id: 'source-master', version: '1.0.0', parametersHash: calculateVersionHash({ sourceManifestId, parameters: true }) },
        sources: [],
      }),
      createdAt,
    } })
    await setAssetRightsService({
      repository: new PrismaAssetRightsRepository(client), clock: () => createdAt,
      createId: () => `matrix-rights-${suffix}`,
    })({
      workspaceId, artifactId: sourceArtifactId, baseRevision: assetRightsRevision(sourceArtifactId, 0),
      draft: { status: 'approved', allowedUses: ['editorial-reuse', 'rendering'], prohibitedUses: [], allowedLocales: ['pt-BR'], consent: { status: 'not-required', allowedUses: [] } },
      actor: { type: 'api-client', id: issued.client.id },
    })

    const colorMetadata = {
      colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709', matrix: 'bt709', range: 'limited', bitDepth: 8,
    }
    const colorProbe = createMediaColorProbe({
      id: `matrix-color-probe-${suffix}`, workspaceId, artifactId: sourceArtifactId, manifestId: sourceManifestId,
      detection: { state: 'ready', metadata: colorMetadata, pixelFormat: 'yuv420p', hdrMode: 'sdr' },
      producer: { provider: 'ffprobe', version: '7.1.1', binaryDigest: sha256('matrix-ffprobe') },
      createdAt: createdAt.toISOString(),
    })
    await client.v2MediaColorProbe.create({ data: {
      id: colorProbe.id, workspaceId, artifactId: sourceArtifactId, manifestId: sourceManifestId,
      schemaVersion: colorProbe.schemaVersion, state: 'ready', metadataJson: stableSerialize(colorMetadata),
      pixelFormat: 'yuv420p', hdrMode: 'sdr', reasonsJson: '[]', producerProvider: 'ffprobe',
      producerVersion: colorProbe.producer.version, producerBinaryDigest: colorProbe.producer.binaryDigest,
      createdAt, probeHash: colorProbe.probeHash,
    } })

    const cells = []
    const controlledEvidence = new Map()
    for (const [index, format] of FORMATS.entries()) {
      const key = format.replace(':', 'x')
      const preset = readOutputFormatPreset(format)
      const projectId = `matrix-project-${key}-${suffix}`
      const baseVersionId = `matrix-base-${key}-${suffix}`
      const versionId = `matrix-version-${key}-${suffix}`
      const commandId = `matrix-command-${key}-${suffix}`
      const directorRunId = `matrix-director-${key}-${suffix}`
      const proxyArtifactId = `matrix-proxy-${key}-${suffix}`
      const proxyManifestId = `matrix-proxy-manifest-${key}-${suffix}`
      const proxyOperationId = `matrix-proxy-operation-${key}-${suffix}`
      const proxyReviewId = `matrix-proxy-review-${key}-${suffix}`
      const snapshots = {
        brief: `matrix-brief-${key}-${suffix}`, policies: `matrix-policies-${key}-${suffix}`,
        perception: `matrix-perception-${key}-${suffix}`, treatment: `matrix-treatment-${key}-${suffix}`,
        story: `matrix-story-${key}-${suffix}`,
        baseEditPlan: `matrix-base-edit-plan-${key}-${suffix}`,
        editPlan: `matrix-edit-plan-${key}-${suffix}`,
        quality: `matrix-quality-${key}-${suffix}`,
      }
      const editPlan = {
        schemaVersion: 2, state: 'compiled', id: `matrix-plan-${key}-${suffix}`, projectVersionId: versionId,
        fps: 30, durationFrames: 30,
        videoTracks: [{ id: `matrix-track-${key}-${suffix}`, kind: 'base-video', clips: [{
          id: `matrix-clip-${key}-${suffix}`, sourceArtifactId, sourceInFrame: 0, sourceOutFrame: 30,
          timelineInFrame: 0, timelineOutFrame: 30, rate: 1,
        }] }],
        subtitleTracks: [], transitions: [], movementPolicy: { automaticZoom: false, protectedOpeningFrames: 120 },
        composition: {
          layout: 'landscape-inset', background: 'blurred-source', foregroundScale: 1, verticalPosition: 0.5,
          faceSafeFallback: [0.08, 0.08, 0.84, 0.84], subtitleSafeRegion: [0.08, 0.68, 0.84, 0.22],
        },
      }
      const baseEditPlan = {
        ...editPlan,
        id: `matrix-base-plan-${key}-${suffix}`,
        projectVersionId: baseVersionId,
      }
      // Historical no-observation data is not facial evidence.
      const perception = matrixPerceptionSnapshot(snapshots.perception,
        `matrix-transcript-${key}-${suffix}`, createPerceptionTimeline)
      // The real API reads this report. It must remain an honest v3 review:
      // neither this controlled media nor a proxy review proves facial clearance.
      const { rubric, report: quality } = matrixReviewRequiredQuality(
        `matrix-quality-report-${key}-${suffix}`, `matrix-action-${key}-${suffix}`,
        createdAt.toISOString(), createQualityReport, resolveStrategicRubric)
      assert.equal(parseFinalExportQuality({ contentJson: stableSerialize(quality),
        contentHash: calculateVersionHash(quality), contentSchemaVersion: 3,
        objective: 'discovery', rubricRef: `${rubric.id}/v${rubric.version}` }).status, 'review-required')

      await client.v2Project.create({ data: {
        id: projectId, workspaceId, name: `Matrix ${format}`, status: 'reviewing-proxy', objective: 'conversion',
        format, locale: 'pt-BR', createdByType: 'api-client', createdById: issued.client.id, createdAt, updatedAt: createdAt,
      } })
      for (const [id, kind, schemaVersion, content] of [
        [snapshots.brief, 'brief', 1, { schemaVersion: 1, productionBrief: { ownerInput: { text: `Matrix ${format}` } } }],
        [snapshots.policies, 'policies', 1, { schemaVersion: 1, state: 'configured' }],
        [snapshots.perception, 'perception', 1, perception],
        [snapshots.treatment, 'treatment', 1, { schemaVersion: 1, state: 'complete' }],
        [snapshots.story, 'story', 1, { schemaVersion: 1, state: 'complete' }],
        [snapshots.baseEditPlan, 'edit-plan', 2, baseEditPlan],
        [snapshots.editPlan, 'edit-plan', 2, editPlan],
        [snapshots.quality, 'quality-report', 3, quality],
      ]) {
        await client.v2ProjectSnapshot.create({ data: {
          id, workspaceId, projectId, kind, schemaVersion, contentJson: stableSerialize(content),
          contentHash: calculateVersionHash(content), createdAt,
        } })
      }
      const baseHash = calculateVersionHash({ projectId, version: baseVersionId })
      await client.v2ProjectVersion.create({ data: {
        id: baseVersionId, workspaceId, projectId, sequence: 1, briefSnapshotId: snapshots.brief,
        editPlanSnapshotId: snapshots.baseEditPlan, policiesSnapshotId: snapshots.policies,
        baseHash, createdBy: issued.client.id, createdAt,
      } })
      await client.v2Project.update({ where: { id: projectId }, data: { currentVersionId: baseVersionId } })
      const noLut = await setProjectLutSelectionService({
        repository: new PrismaProjectLutSelectionRepository(client),
        createId: (kind) => `matrix-lut-${kind}-${key}-${suffix}`,
        createEventId: randomUUID,
        clock: () => createdAt,
      })({
        workspaceId, projectId, baseVersionId, baseHash,
        selection: { mode: 'none' }, actor: { type: 'system', id: 'matrix-e2e-system' },
        idempotencyKey: `matrix-lut-none-${key}-${suffix}`,
        reason: 'Keep the export matrix colorimetrically neutral.',
      })
      assert.equal(noLut.selection.resolved.mode, 'none')
      await client.v2EditCommand.create({ data: {
        id: commandId, workspaceId, projectId, baseVersionId: noLut.version.id, baseHash: noLut.version.baseHash, type: 'run-director',
        scopeJson: stableSerialize({ kind: 'video', targetIds: [] }),
        payloadJson: stableSerialize({ schemaVersion: 1, directorRunId }), reason: 'Matrix E2E',
        actorType: 'api-client', actorId: issued.client.id, idempotencyKey: `matrix-director-${key}-${suffix}`,
        requestFingerprint: calculateVersionHash({ commandId }), createdAt,
      } })
      const versionHash = calculateVersionHash({ projectId, version: versionId })
      await client.v2ProjectVersion.create({ data: {
        id: versionId, workspaceId, projectId, sequence: 3, parentVersionId: noLut.version.id,
        briefSnapshotId: snapshots.brief, treatmentSnapshotId: snapshots.treatment, storySnapshotId: snapshots.story,
        editPlanSnapshotId: snapshots.editPlan, policiesSnapshotId: snapshots.policies,
        baseHash: versionHash, createdBy: issued.client.id, commandId, createdAt,
      } })
      await client.v2DirectorRun.create({ data: {
        id: directorRunId, workspaceId, projectId, commandId, baseVersionId: noLut.version.id, resultVersionId: versionId,
        status: 'succeeded', objective: 'discovery', objectiveVersion: 1, rubricRef: 'awareness-discovery/v1',
        plannerVersion: 'matrix-e2e-1.0.0', criticVersion: 'matrix-e2e-1.0.0',
        perceptionSnapshotId: snapshots.perception, treatmentSnapshotId: snapshots.treatment,
        storySnapshotId: snapshots.story, editPlanSnapshotId: snapshots.editPlan, qualitySnapshotId: snapshots.quality,
        decisionsJson: '[]', assumptionsJson: '[]', initiatedByType: 'api-client', initiatedById: issued.client.id,
        createdAt, updatedAt: createdAt,
      } })
      await client.v2Project.update({ where: { id: projectId }, data: { currentVersionId: versionId } })
      await client.v2ProjectMediaAsset.create({ data: {
        id: randomUUID(), workspaceId, projectId, artifactId: sourceArtifactId, role: 'source-master',
        originalFileName: 'shared-source.mp4', createdAt,
      } })

      const proxyKey = `workspaces/${workspaceId}/proxies/${key}.mp4`
      await client.v2MediaArtifact.create({ data: {
        id: proxyArtifactId, workspaceId, artifactKey: proxyKey, sha256: calculateVersionHash({ proxyArtifactId }),
        byteSize: 1n, mediaType: 'video', container: 'mp4', status: 'available', createdAt,
      } })
      await client.v2MediaArtifactManifest.create({ data: {
        id: proxyManifestId, workspaceId, artifactId: proxyArtifactId, schemaVersion: 'media-artifact-manifest/v2',
        manifestHash: calculateVersionHash({ proxyManifestId }), recipeId: 'editorial-proxy', recipeVersion: '1.0.0',
        parametersHash: calculateVersionHash({ proxyManifestId, parameters: true }),
        manifestJson: stableSerialize({ artifact: { artifactKey: proxyKey } }), createdAt,
      } })
      await client.v2ProjectMediaAsset.create({ data: {
        id: randomUUID(), workspaceId, projectId, artifactId: proxyArtifactId, role: 'editorial-proxy',
        originalFileName: `${key}-proxy.mp4`, createdAt,
      } })
      const proxyInputHash = calculateVersionHash({ versionId, proxyArtifactId })
      await client.v2PublicOperation.create({ data: {
        id: proxyOperationId, workspaceId, projectId, clientId: issued.client.id, type: 'project-proxy-render',
        status: 'succeeded', phase: 'completed', targetType: 'media-artifact', targetId: proxyArtifactId,
        cancelable: false, retryable: false, attempt: 1, maxAttempts: 3,
        progressCompleted: 4, progressTotal: 4, progressUnit: 'render',
        resultJson: stableSerialize({ resource: { type: 'media-artifact', id: proxyArtifactId, manifestId: proxyManifestId } }),
        idempotencyKey: `matrix-proxy-${key}-${suffix}`, requestFingerprint: proxyInputHash,
        createdAt, updatedAt: createdAt, startedAt: createdAt, completedAt: createdAt,
      } })
      await client.v2ProjectProxyRenderOperation.create({ data: {
        operationId: proxyOperationId, workspaceId, projectId, projectVersionId: versionId,
        editPlanSnapshotId: snapshots.editPlan, sourceArtifactId, sourceManifestId, inputHash: proxyInputHash,
        colorPipelineBindingsJson: stableSerialize([]),
        outputArtifactId: proxyArtifactId, outputManifestId: proxyManifestId,
        originalFileName: `${key}-proxy.mp4`, createdAt,
      } })
      await client.v2ProxyReview.create({ data: {
        id: proxyReviewId, workspaceId, projectId, projectVersionId: versionId, operationId: proxyOperationId,
        proxyArtifactId, proxyManifestId, inputHash: proxyInputHash, outputSpecId: preset.spec.id,
        rangeCacheKey: calculateVersionHash({ proxyReviewId, ranges: [] }),
        specJson: stableSerialize({ width: preset.exportDefaults.proxy.width, height: preset.exportDefaults.proxy.height, codec: 'h264', container: 'mp4', quality: 'review', reusableRanges: true }),
        status: 'ready-for-final', technicalIssuesJson: '[]', criticIssuesJson: '[]', warningsAcknowledged: false,
        finalAllowed: true, reviewHash: calculateVersionHash({ proxyReviewId, versionId, proxyArtifactId, status: 'ready-for-final' }),
        revision: 1, uploadReceivedAt: createdAt, renderCompletedAt: createdAt, timeToFirstProxyMs: 0n,
        createdAt, updatedAt: createdAt,
      } })
      cells.push({ recipeId: 'review-required-master-v3', projectId, projectVersionId: versionId,
        projectVersionHash: versionHash, format, locale: 'pt-BR' })
      controlledEvidence.set(projectId, Object.freeze({ directorRunId, qualitySnapshotId: snapshots.quality,
        qualitySnapshotHash: calculateVersionHash(quality), quality,
        editPlanSnapshotId: snapshots.editPlan, editPlanHash: calculateVersionHash(editPlan),
        proxyReviewId, proxyReviewHash: calculateVersionHash({ proxyReviewId, versionId, proxyArtifactId, status: 'ready-for-final' }),
        proxyArtifactId, proxyManifestId, sourceArtifactId, sourceManifestId, sourceSha256: sourceSha }))
    }

    const port = await freePort()
    const baseUrl = `http://127.0.0.1:${port}`
    const nextMode = process.env.APOLLO_E2E_SERVER_MODE === 'start' ? 'start' : 'dev'
    server = spawn(process.execPath, [
      'node_modules/next/dist/bin/next', nextMode,
      ...(nextMode === 'dev' ? ['--webpack'] : []),
      '-p', String(port),
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env, NODE_ENV: nextMode === 'start' ? 'production' : 'development', __NEXT_PROCESSED_ENV: 'true',
        APOLLO_API_ENVIRONMENT: 'production', APOLLO_V2_ARTIFACT_ROOT: artifactRoot,
        APOLLO_PREFLIGHT_COMMIT_TOKEN_SECRET: `matrix-token-${suffix}`.padEnd(48, 'x'),
        APOLLO_EXPORT_MATRIX_MAX_COST_MINOR_UNITS: '100000000',
        APOLLO_EXPORT_MATRIX_AVAILABLE_STORAGE_BYTES: '9000000000000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.stdout.on('data', (chunk) => { serverLogs += String(chunk) })
    server.stderr.on('data', (chunk) => { serverLogs += String(chunk) })
    await waitForServer(baseUrl, server, () => serverLogs)
    const authorization = `Bearer ${issued.token}`

    for (const [index, cell] of cells.entries()) {
      const stage = (id, kind, enabled, output, provider, parameters) => ({
        id, kind, version: 'v1', enabled, output,
        implementation: { provider, version: 'v1', parameters, parametersHash: sha256(JSON.stringify(parameters)) },
      })
      const stages = [
        stage('technical-rec709', 'technical', true, colorMetadata, 'ffmpeg-zscale', { mode: 'identity' }),
        stage('match-source', 'match', false, colorMetadata, 'apollo-match', { mode: 'bypass' }),
        stage('creative-none', 'creative-lut', false, colorMetadata, 'apollo-lut', { mode: 'none' }),
        stage('output-rec709', 'output', true, colorMetadata, 'ffmpeg-zscale', { dither: true }),
      ]
      const response = await fetch(`${baseUrl}/v1/projects/${cell.projectId}/color-pipeline-compilations`, {
        method: 'POST', headers: { authorization, 'content-type': 'application/json', 'idempotency-key': `matrix-color-${index}-${suffix}` },
        body: JSON.stringify({ sourceArtifactId, sourceManifestId, outputMetadata: colorMetadata, stages }),
      })
      assert.equal(response.status, 201, `${await response.text()}\n${serverLogs.slice(-4_000)}`)
    }

    const preflightBody = { cells, limits: { maximumCostMinorUnits: 100000000, maximumStorageBytes: 9000000000000 } }
    assert.equal(validators.preflightRequest(preflightBody), true, JSON.stringify(validators.preflightRequest.errors))
    const preflightResponse = await fetch(`${baseUrl}/v1/export-matrix-preflights`, {
      method: 'POST', headers: { authorization, 'content-type': 'application/json', 'idempotency-key': `matrix-preflight-${suffix}` },
      body: JSON.stringify(preflightBody),
    })
    const preflight = await preflightResponse.json()
    assert.equal(preflightResponse.status, 201, `${JSON.stringify(preflight)}\n${serverLogs.slice(-4_000)}`)
    assert.equal(validators.preflightCreated(preflight), true, JSON.stringify(validators.preflightCreated.errors))
    assert.equal(preflight.data.preflight.allowed, false)
    assert.equal(preflight.data.preflight.definition.cells.length, 5)
    assert.equal(new Set(preflight.data.preflight.definition.cells.map((cell) => cell.outputFileName)).size, 5)
    assert.equal(preflight.data.preflight.cells.filter((cell) => cell.blockers.includes('CELL_NOT_READY')).length, 5)
    assert.equal(preflight.data.commitToken, undefined, 'unknown facial clearance cannot issue a commit token')

    const deniedCommitBody = matrixDeniedCommitBody()
    assert.equal(validators.commitRequest(deniedCommitBody), true, JSON.stringify(validators.commitRequest.errors))
    const deniedCommit = await fetch(`${baseUrl}/v1/export-matrix-preflights/${preflight.data.preflightId}/commit`, {
      method: 'POST', headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(deniedCommitBody),
    })
    const deniedCommitPayload = await deniedCommit.json()
    assert.equal(deniedCommit.status, 428, JSON.stringify(deniedCommitPayload))
    assert.equal(validators.errorResponse(deniedCommitPayload), true, JSON.stringify(validators.errorResponse.errors))
    assert.equal(deniedCommitPayload.error.code, 'PRECONDITION_REQUIRED')
    assert.equal(await client.v2ExportMatrix.count({ where: { workspaceId } }), 0)
    assert.equal(await client.v2PublicOperation.count({ where: { workspaceId, type: 'project-final-export' } }), 0)
    assert.equal(await client.v2AutomaticCatalogRecord.count({ where: { workspaceId } }), 0)

    // This port exists only in this test process. It checks PostgreSQL lineage,
    // source bytes and exact scope before letting the application exercise
    // export mechanics. The stored reports remain review-required/unknown.
    const sourceReader = new PrismaProjectProxyRenderRepository(client)
    const realProjects = new PrismaProjectFinalExportRepository(client)
    async function readControlledSource(input, immutable) {
      const cell = cells.find((candidate) => candidate.projectId === input.projectId)
      const evidence = controlledEvidence.get(input.projectId)
      if (!cell || !evidence || input.workspaceId !== workspaceId ||
          input.projectVersionId !== cell.projectVersionId ||
          input.projectVersionHash !== cell.projectVersionHash ||
          (immutable && ['editPlanSnapshotId', 'directorRunId', 'qualitySnapshotId',
            'qualitySnapshotHash', 'proxyReviewId', 'proxyReviewHash', 'proxyArtifactId',
            'sourceArtifactId', 'sourceManifestId'].some((key) => input[key] !== evidence[key]))) return null
      const source = immutable ? await sourceReader.readImmutableSource(input)
        : await sourceReader.readCurrentSource({ workspaceId, projectId: cell.projectId })
      if (!source || source.projectVersionId !== cell.projectVersionId ||
          source.editPlanSnapshotId !== evidence.editPlanSnapshotId ||
          source.editPlanHash !== evidence.editPlanHash ||
          source.sourceArtifactId !== sourceArtifactId || source.sourceManifestId !== sourceManifestId ||
          source.sourceSha256 !== evidence.sourceSha256 || source.format !== cell.format ||
          source.renderSources.length !== 1 ||
          source.renderSources[0].artifactId !== sourceArtifactId ||
          source.renderSources[0].manifestId !== sourceManifestId ||
          source.renderSources[0].sha256 !== evidence.sourceSha256) return null
      const [project, version, run, quality, review, sourceArtifact, sourceManifest,
        proxyArtifact, proxyManifest] = await Promise.all([
        client.v2Project.findFirst({ where: { id: cell.projectId, workspaceId } }),
        client.v2ProjectVersion.findFirst({ where: { id: cell.projectVersionId,
          workspaceId, projectId: cell.projectId, baseHash: cell.projectVersionHash } }),
        client.v2DirectorRun.findFirst({ where: { id: evidence.directorRunId,
          workspaceId, projectId: cell.projectId, resultVersionId: cell.projectVersionId,
          qualitySnapshotId: evidence.qualitySnapshotId, status: 'succeeded' } }),
        client.v2ProjectSnapshot.findFirst({ where: { id: evidence.qualitySnapshotId,
          workspaceId, projectId: cell.projectId, kind: 'quality-report' } }),
        client.v2ProxyReview.findFirst({ where: { id: evidence.proxyReviewId,
          workspaceId, projectId: cell.projectId, projectVersionId: cell.projectVersionId,
          reviewHash: evidence.proxyReviewHash, proxyArtifactId: evidence.proxyArtifactId,
          status: 'ready-for-final', finalAllowed: true } }),
        client.v2MediaArtifact.findFirst({ where: { id: sourceArtifactId, workspaceId,
          sha256: evidence.sourceSha256, status: 'available' } }),
        client.v2MediaArtifactManifest.findFirst({ where: { id: sourceManifestId,
          workspaceId, artifactId: sourceArtifactId } }),
        client.v2MediaArtifact.findFirst({ where: { id: evidence.proxyArtifactId,
          workspaceId, status: 'available' } }),
        client.v2MediaArtifactManifest.findFirst({ where: { id: evidence.proxyManifestId,
          workspaceId, artifactId: evidence.proxyArtifactId } }),
      ])
      if (!project || (!immutable && project.currentVersionId !== cell.projectVersionId) ||
          !version || version.editPlanSnapshotId !== evidence.editPlanSnapshotId ||
          !run || !quality || quality.schemaVersion !== 3 ||
          quality.contentHash !== evidence.qualitySnapshotHash ||
          quality.contentJson !== stableSerialize(evidence.quality) ||
          !review || !sourceArtifact || Number(sourceArtifact.byteSize) !== sourceBytes.byteLength ||
          !sourceManifest || !proxyArtifact || !proxyManifest ||
          review.proxyManifestId !== evidence.proxyManifestId ||
          proxyManifest.artifactId !== evidence.proxyArtifactId ||
          proxyArtifact.artifactKey !== JSON.parse(proxyManifest.manifestJson).artifact.artifactKey) return null
      const sourceDeclaration = JSON.parse(sourceManifest.manifestJson).artifact
      if (sourceDeclaration.artifactKey !== sourceArtifactKey ||
          sourceDeclaration.sha256 !== evidence.sourceSha256 ||
          sourceDeclaration.byteSize !== sourceBytes.byteLength) return null
      return Object.freeze({ ...source, projectVersionHash: cell.projectVersionHash,
        locale: project.locale ?? 'pt-BR', directorRunId: evidence.directorRunId,
        qualitySnapshotId: evidence.qualitySnapshotId,
        qualitySnapshotHash: evidence.qualitySnapshotHash,
        qualityStatus: 'approved', qualityScore: evidence.quality.score,
        proxyReviewId: evidence.proxyReviewId, proxyReviewHash: evidence.proxyReviewHash,
        proxyArtifactId: evidence.proxyArtifactId })
    }
    const controlledProjects = Object.freeze({
      readApprovedCurrentSource: (input) => readControlledSource(input, false),
      readImmutableApprovedSource: (input) => readControlledSource(input, true),
      convergeOutputIdentity: (input) => realProjects.convergeOutputIdentity(input),
      attachCompletedOutput: (input) => realProjects.attachCompletedOutput(input),
      markExportFailed: (input) => realProjects.markExportFailed(input),
      recordAttempt: (input) => realProjects.recordAttempt(input),
      readAttemptHistory: (input) => realProjects.readAttemptHistory(input),
    })
    const auditContext = createExternalAuditContext({ clientId: issued.client.id,
      credentialId: issued.credential.id, workspaceId, environment: 'production' })
    const controlledActor = { ...auditContext, auditContext,
      scopes: new Set(['projects:write', 'operations:cancel', 'operations:retry']),
      authenticationKind: 'bearer', clientKillSwitchEngaged: false,
      workspaceKillSwitchEngaged: false, clientAccessStatus: 'active', workspaceAccessStatus: 'active' }
    const workerEnvironment = {
      ...process.env, APOLLO_V2_ARTIFACT_ROOT: artifactRoot,
      APOLLO_V2_ARTIFACT_STORAGE_DRIVER: 'local',
      FFMPEG_PATH: ffmpegBin,
      APOLLO_V2_RENDER_WORK_ROOT: renderWorkRoot,
      APOLLO_V2_RENDER_LEASE_MS: '120000', APOLLO_V2_RENDER_HEARTBEAT_MS: '5000',
      APOLLO_V2_WORKER_RETRY_BASE_MS: '1', APOLLO_V2_WORKER_RETRY_MAX_MS: '1',
      APOLLO_PROTECTED_PAYLOAD_KEY_ID: 'matrix-e2e-key',
      APOLLO_PROTECTED_PAYLOAD_KEY: Buffer.alloc(32, 9).toString('base64url'),
    }
    const matrices = new PrismaExportMatrixRepository(client)
    const rights = new PrismaAssetRightsRepository(client)
    const operations = new PrismaPublicOperationRepository(client, randomUUID,
      () => createProtectedPayloadCipherFromEnvironment(workerEnvironment))
    const tokenIssuer = createPreflightCommitTokenIssuerFromEnvironment({
      APOLLO_PREFLIGHT_COMMIT_TOKEN_SECRET: `matrix-token-${suffix}`.padEnd(48, 'x'),
    })
    const controlledPreflight = await createExportMatrixPreflightService({
      matrices, projects: controlledProjects, rights,
      colorPipelines: createColorPipelineCompilationRepository(),
      capacity: createExportMatrixCapacityProviderFromEnvironment({
        APOLLO_EXPORT_MATRIX_MAX_COST_MINOR_UNITS: '100000000',
        APOLLO_EXPORT_MATRIX_AVAILABLE_STORAGE_BYTES: '9000000000000',
      }),
      tokenIssuer, clock: () => new Date(),
      createPreflightId: () => `preflight-matrix-controlled-${suffix}`,
    })({ workspaceId, cells, requestedMaximumCostMinorUnits: 100000000,
      requestedMaximumStorageBytes: 9000000000000, actor: controlledActor,
      idempotencyKey: `matrix-controlled-preflight-${suffix}` })
    assert.equal(controlledPreflight.record.preflight.allowed, true)
    assert.equal(controlledPreflight.record.preflight.definition.cells.length, 5)
    const committed = await commitExportMatrixService({
      matrices, projects: controlledProjects, rights, operations,
      colorPipelines: createColorPipelineCompilationRepository(), tokenIssuer,
      clock: () => new Date(), createId: (kind) => `${kind}-matrix-controlled-${randomUUID()}`,
    })({ workspaceId, preflightId: controlledPreflight.record.id,
      commitToken: controlledPreflight.commitToken,
      approval: { approved: true, note: 'Controlled export mechanics only.' },
      actor: controlledActor })
    const matrixId = committed.matrix.id
    assert.equal(committed.matrix.status, 'queued')
    assert.equal(new Set(committed.matrix.cells.map((cell) => cell.operationId)).size, 5)

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
          join(artifactRoot, '.lut-work'), createWorkspaceLutRepository()),
        sources: createArtifactSourceMaterializer(workerEnvironment),
        catalogOutput: createAutomaticCatalogService(),
        leaseDurationMs: 120_000, heartbeatIntervalMs: 5_000,
        retryBaseDelayMs: 1, retryMaxDelayMs: 1,
      })
    }
    const failingWorker = controlledWorker(process.execPath)
    const retryOutcome = await failingWorker(`matrix-worker-retry-${suffix}`)
    const retryOperation = retryOutcome
      ? await client.v2PublicOperation.findUnique({ where: { id: retryOutcome.operationId } })
      : null
    const retryDetail = retryOutcome
      ? await client.v2ProjectFinalExportOperation.findUnique({ where: { operationId: retryOutcome.operationId } })
      : null
    const retrySource = retryDetail
      ? await controlledProjects.readImmutableApprovedSource({
        workspaceId: retryDetail.workspaceId,
        projectId: retryDetail.projectId,
        projectVersionId: retryDetail.projectVersionId,
        projectVersionHash: retryDetail.projectVersionHash,
        editPlanSnapshotId: retryDetail.editPlanSnapshotId,
        directorRunId: retryDetail.directorRunId,
        qualitySnapshotId: retryDetail.qualitySnapshotId,
        qualitySnapshotHash: retryDetail.qualitySnapshotHash,
        proxyReviewId: retryDetail.proxyReviewId,
        proxyReviewHash: retryDetail.proxyReviewHash,
        proxyArtifactId: retryDetail.proxyArtifactId,
        sourceArtifactId: retryDetail.sourceArtifactId,
        sourceManifestId: retryDetail.sourceManifestId,
      })
      : null
    const retryBindings = retryDetail ? JSON.parse(retryDetail.colorPipelineBindingsJson) : []
    const retryOutputSpec = retryDetail ? {
      aspectRatio: retryDetail.outputAspectRatio,
      width: retryDetail.outputWidth,
      height: retryDetail.outputHeight,
      fps: retryDetail.outputFps,
      codec: retryDetail.outputCodec,
      audioCodec: retryDetail.outputAudioCodec,
      container: retryDetail.outputContainer,
      quality: retryDetail.outputQuality,
    } : null
    const recomputedInputHash = retryDetail && retrySource && retryOutputSpec
      ? calculateVersionHash({
        kind: 'project-final-export/v1', projectId: retryDetail.projectId,
        assEmissionPolicy: ASS_EMISSION_POLICY,
        projectVersionId: retryDetail.projectVersionId, projectVersionHash: retryDetail.projectVersionHash,
        editPlanSnapshotId: retrySource.editPlanSnapshotId, editPlanHash: retrySource.editPlanHash,
        directorRunId: retrySource.directorRunId, qualitySnapshotId: retrySource.qualitySnapshotId,
        qualitySnapshotHash: retrySource.qualitySnapshotHash, proxyReviewId: retrySource.proxyReviewId,
        proxyReviewHash: retrySource.proxyReviewHash, proxyArtifactId: retrySource.proxyArtifactId,
        sourceArtifactId: retrySource.sourceArtifactId, sourceManifestId: retrySource.sourceManifestId,
        sourceSha256: retrySource.sourceSha256,
        renderSourcesFingerprint: projectRenderSourcesFingerprint(retrySource.renderSources),
        colorPipelineBindings: retryBindings, outputSpec: retryOutputSpec,
      })
      : null
    assert.equal(retryOutcome?.status, 'retrying', stableSerialize({
      outcome: retryOutcome,
      errorCode: retryOperation?.errorCode,
      errorMessage: retryOperation?.errorMessage,
      errorRetryable: retryOperation?.errorRetryable,
      attempt: retryOperation?.attempt,
      maxAttempts: retryOperation?.maxAttempts,
      workerChecks: {
        sourceFound: Boolean(retrySource),
        inputHashMatches: recomputedInputHash === retryDetail?.inputHash,
        sourceFormat: retrySource?.format,
        outputFormat: retryOutputSpec?.aspectRatio,
        movementPolicy: retrySource?.editPlan.movementPolicy,
        clipCount: retrySource?.editPlan.videoTracks.find((track) => track.kind === 'base-video')?.clips.length,
        bindingCount: retryBindings.length,
        renderSourceIds: retrySource?.renderSources.map((source) => source.artifactId),
        bindingSourceIds: retryBindings.map((binding) => binding.sourceArtifactId),
      },
    }))
    const retryResponse = await fetch(`${baseUrl}/v1/export-matrices/${matrixId}`, { headers: { authorization } })
    const retrying = await retryResponse.json()
    assert.equal(retryResponse.status, 200)
    assert.equal(validators.matrixResponse(retrying), true, JSON.stringify(validators.matrixResponse.errors))
    assert.equal(retrying.data.matrix.cells.filter((cell) => cell.status === 'retrying').length, 1)
    assert.equal(retrying.data.matrix.cells.filter((cell) => cell.status === 'queued').length, 4)
    const canceled = await cancelPublicOperationService({ operations })({
      workspaceId, operationId: retryOutcome.operationId, actor: controlledActor })
    assert.equal(canceled.status, 'canceled')
    assert.equal((await client.v2ExportMatrixCell.findFirstOrThrow({
      where: { workspaceId, operationId: retryOutcome.operationId },
      include: { operation: true },
    })).operation.status, 'canceled')
    const resumed = await retryPublicOperationService({ operations })({
      workspaceId, operationId: retryOutcome.operationId, actor: controlledActor })
    assert.equal(resumed.status, 'retrying')
    await new Promise((resolve) => setTimeout(resolve, 25))

    const worker = controlledWorker(ffmpegBin)
    const assertSucceeded = async (outcome) => {
      const operation = outcome
        ? await client.v2PublicOperation.findUnique({ where: { id: outcome.operationId } })
        : null
      const detail = outcome
        ? await client.v2ProjectFinalExportOperation.findUnique({ where: { operationId: outcome.operationId } })
        : null
      const rights = detail
        ? await new PrismaAssetRightsRepository(client).findCurrent(detail.workspaceId, detail.sourceArtifactId)
        : null
      const project = detail
        ? await client.v2Project.findUnique({ where: { id: detail.projectId } })
        : null
      assert.equal(outcome?.status, 'succeeded', stableSerialize({
        outcome,
        errorCode: operation?.errorCode,
        errorMessage: operation?.errorMessage,
        errorRetryable: operation?.errorRetryable,
        attempt: operation?.attempt,
        maxAttempts: operation?.maxAttempts,
        projectStatus: project?.status,
        currentVersionMatches: project?.currentVersionId === detail?.projectVersionId,
        rightsDecision: detail ? evaluateAssetUse(rights?.snapshot ?? null, {
          workspaceId: detail.workspaceId, use: 'rendering', locale: project?.locale ?? 'pt-BR',
        }, new Date()) : null,
      }))
    }
    for (let index = 0; index < 3; index += 1) {
      const outcome = await worker(`matrix-worker-a-${index}-${suffix}`)
      await assertSucceeded(outcome)
    }
    const partialResponse = await fetch(`${baseUrl}/v1/export-matrices/${matrixId}`, { headers: { authorization } })
    const partial = await partialResponse.json()
    assert.equal(partialResponse.status, 200)
    assert.equal(validators.matrixResponse(partial), true, JSON.stringify(validators.matrixResponse.errors))
    assert.equal(partial.data.matrix.status, 'running')
    assert.equal(partial.data.matrix.cells.filter((cell) => cell.status === 'ready').length, 3)
    assert.equal(partial.data.matrix.cells.filter((cell) => cell.status === 'queued').length, 2)

    for (let index = 3; index < 5; index += 1) {
      const outcome = await worker(`matrix-worker-b-${index}-${suffix}`)
      await assertSucceeded(outcome)
    }
    const readyResponse = await fetch(`${baseUrl}/v1/export-matrices/${matrixId}`, { headers: { authorization } })
    const ready = await readyResponse.json()
    assert.equal(readyResponse.status, 200)
    assert.equal(validators.matrixResponse(ready), true, JSON.stringify(validators.matrixResponse.errors))
    assert.equal(ready.data.matrix.status, 'ready')
    assert.deepEqual(ready.data.matrix.cells.map((cell) => cell.status), Array(5).fill('ready'))
    assert.deepEqual(ready.data.matrix.cells.map((cell) => cell.attempt).toSorted(), [1, 1, 1, 1, 2])
    assert.equal(new Set(ready.data.matrix.cells.map((cell) => cell.outputArtifactId)).size, 5)
    assert.equal(new Set(ready.data.matrix.cells.map((cell) => cell.outputManifestId)).size, 5)

    const formatCritics = await client.v2ProjectFinalExportOperation.findMany({
      where: {
        workspaceId,
        operationId: {
          in: ready.data.matrix.cells.map((cell) => cell.operationId),
        },
      },
      include: { qualitySnapshot: true },
      orderBy: { outputAspectRatio: 'asc' },
    })
    assert.equal(formatCritics.length, 5)
    assert.deepEqual(
      [...new Set(formatCritics.map((item) => item.outputAspectRatio))].sort(),
      [...FORMATS].sort(),
    )
    assert.equal(
      new Set(formatCritics.map((item) => item.qualitySnapshotId)).size,
      5,
    )
    assert.ok(formatCritics.every((item) =>
      item.qualitySnapshotHash === item.qualitySnapshot.contentHash &&
      JSON.parse(item.qualitySnapshot.contentJson).status === 'review-required' &&
      JSON.parse(item.qualitySnapshot.contentJson).faceSafety.status === 'unknown'))

    const outputHashes = new Set()
    const verifiedOutputs = []
    for (const cell of ready.data.matrix.cells) {
      const artifact = await client.v2MediaArtifact.findUnique({ where: { id: cell.outputArtifactId } })
      assert.ok(artifact)
      outputHashes.add(artifact.sha256)
      const outputPath = join(artifactRoot, ...artifact.artifactKey.split('/'))
      const outputBytes = await readFile(outputPath)
      assert.equal(sha256(outputBytes), artifact.sha256)
      // Some Windows FFprobe builds cannot open long artifact paths.
      // Verify the same bytes in an owned short scratch path before probing.
      const probePath = join(probeRoot, `${cell.format.replace(':', 'x')}.mp4`)
      await copyFile(outputPath, probePath)
      assert.equal(sha256(await readFile(probePath)), artifact.sha256)
      const { stdout } = await execFileAsync(ffprobeBin, [
        '-v', 'error', '-count_frames', '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name,width,height,nb_read_frames', '-of', 'json', probePath,
      ], { timeout: 30_000 })
      const stream = JSON.parse(stdout).streams[0]
      const preset = readOutputFormatPreset(cell.format).spec
      assert.equal(stream.codec_name, 'h264')
      assert.equal(stream.width, preset.width)
      assert.equal(stream.height, preset.height)
      assert.equal(Number(stream.nb_read_frames), 30)
      await execFileAsync(ffmpegBin, [
        '-hide_banner', '-loglevel', 'error', '-xerror', '-threads', '2',
        '-i', probePath, '-map', '0:v:0', '-map', '0:a?', '-f', 'null', '-',
      ], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })
      const verifiedBytes = await readFile(probePath)
      assert.equal(verifiedBytes.byteLength, Number(artifact.byteSize))
      assert.equal(sha256(verifiedBytes), artifact.sha256)
      const critic = formatCritics.find((item) => item.operationId === cell.operationId)
      assert.ok(critic)
      verifiedOutputs.push({ format: cell.format, outputSpec: preset,
        operationId: cell.operationId, artifactId: artifact.id,
        artifactKey: artifact.artifactKey, artifactSha256: artifact.sha256,
        artifactByteSize: verifiedBytes.byteLength, manifestId: cell.outputManifestId,
        qualitySnapshotId: critic.qualitySnapshotId,
        qualitySnapshotHash: critic.qualitySnapshotHash,
        qualityStatus: JSON.parse(critic.qualitySnapshot.contentJson).status,
        probePath })
    }
    assert.equal(outputHashes.size, 5)
    assert.equal(await client.v2ProjectMediaAsset.count({ where: { workspaceId, artifactId: sourceArtifactId, role: 'source-master' } }), 5)
    assert.equal(await client.v2ExportMatrix.count({ where: { workspaceId } }), 1)
    assert.equal(await client.v2ExportMatrixCell.count({ where: { workspaceId } }), 5)
    if (evidenceRoot) {
      const runEvidenceRoot = ownedChild(evidenceRoot, join(evidenceRoot, `matrix-${suffix}`), 'matrix-')
      await mkdir(runEvidenceRoot, { recursive: true })
      const outputs = []
      for (const output of verifiedOutputs) {
        const fileName = `${output.format.replace(':', 'x')}.mp4`
        const preservedPath = ownedChild(runEvidenceRoot, join(runEvidenceRoot, fileName), '')
        await copyFile(output.probePath, preservedPath)
        const preservedBytes = await readFile(preservedPath)
        assert.equal(preservedBytes.byteLength, output.artifactByteSize)
        assert.equal(sha256(preservedBytes), output.artifactSha256)
        const { probePath: _privateScratchPath, ...metadata } = output
        outputs.push({ ...metadata, fileName })
      }
      assert.equal(outputs.length, 5)
      await writeFile(ownedChild(runEvidenceRoot, join(runEvidenceRoot, 'manifest.json'), ''),
        JSON.stringify({ schemaVersion: 'export-matrix-controlled-mechanics-proof/v1',
          proofScope: 'controlled-mechanics', faceSafety: 'unknown',
          publicApiCommitBlocked: true, fullDecode: 'passed',
          workspaceId, matrixId, sourceArtifactId, sourceSha256: sourceSha,
          outputs, deployed: false, ownerAccepted: false }, null, 2), { flag: 'wx' })
    }
  } catch (error) {
    primaryError = error
  } finally {
    const cleanupErrors = []
    for (const cleanup of [
      () => stopChild(server),
      async () => {
        const { disconnectV2PostgresClient } = await import('../../src/v2/infrastructure/prisma-postgres/client.ts')
        await disconnectV2PostgresClient()
      },
      () => client.$disconnect(),
      () => rm(ownedChild(join(artifactRoot, 'workspaces'),
        join(artifactRoot, 'workspaces', workspaceId), 'matrix-workspace-'), { recursive: true, force: true }),
      () => rm(ownedChild(artifactRoot, renderWorkRoot, '.matrix-work-'), { recursive: true, force: true }),
      ...(probeRoot ? [() => rm(ownedChild(tmpdir(), probeRoot, 'apollo-matrix-probe-'),
        { recursive: true, force: true })] : []),
    ]) {
      try { await cleanup() } catch (error) { cleanupErrors.push(error) }
    }
    if (primaryError && cleanupErrors.length) throw new AggregateError([primaryError, ...cleanupErrors], 'Matrix proof and cleanup failed')
    if (primaryError) throw primaryError
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Matrix proof cleanup failed')
  }
})
