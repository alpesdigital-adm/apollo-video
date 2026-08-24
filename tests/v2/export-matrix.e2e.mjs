import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import net from 'node:net'
import { dirname, isAbsolute, join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const ffmpegStatic = require('ffmpeg-static')
const ffprobeStatic = require('ffprobe-static').path
const FORMATS = ['9:16', '16:9', '4:5', '1:1', '21:9']

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
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
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ])
  if (child.exitCode === null) {
    child.kill('SIGKILL')
    await once(child, 'exit')
  }
}

test('F2.028 exports five deterministic cells through API, PostgreSQL and the real worker', {
  skip: process.env.APOLLO_EXPORT_MATRIX_E2E !== '1' && 'set APOLLO_EXPORT_MATRIX_E2E=1 with an isolated database',
  timeout: 300_000,
}, async () => {
  assert.ok(process.env.V2_DATABASE_URL)
  const databaseName = new URL(process.env.V2_DATABASE_URL).pathname.slice(1)
  assert.match(databaseName, /(?:^|_)e2e(?:_|$)/, 'the matrix E2E requires an isolated database')
  const artifactRoot = process.env.APOLLO_V2_ARTIFACT_ROOT?.trim() ?? ''
  assert.equal(isAbsolute(artifactRoot), true)
  assert.ok(ffmpegStatic)
  assert.ok(ffprobeStatic)

  const { assetRightsRevision } = await import('../../src/v2/domain/asset-rights.ts')
  const { createMediaColorProbe } = await import('../../src/v2/domain/color-and-export.ts')
  const { readOutputFormatPreset } = await import('../../src/v2/domain/output-format-registry.ts')
  const { calculateVersionHash, stableSerialize } = await import('../../src/v2/application/version-hash.ts')
  const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
  const { setAssetRightsService } = await import('../../src/v2/application/set-asset-rights.ts')
  const { createProjectFinalExportWorker } = await import('../../src/v2/infrastructure/repository-factory.ts')
  const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
  const { PrismaAssetRightsRepository } = await import('../../src/v2/infrastructure/prisma/asset-rights-repository.ts')
  const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')

  const client = new PrismaClient()
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `matrix-workspace-${suffix}`
  const sourceArtifactId = `matrix-source-${suffix}`
  const sourceManifestId = `matrix-source-manifest-${suffix}`
  const sourceArtifactKey = `workspaces/${workspaceId}/masters/shared-source.mp4`
  const sourcePath = join(artifactRoot, ...sourceArtifactKey.split('/'))
  const createdAt = new Date('2026-08-24T20:00:00.000Z')
  let server
  let serverLogs = ''

  try {
    await client.$executeRawUnsafe('TRUNCATE TABLE "workspaces" CASCADE')
    await mkdir(dirname(sourcePath), { recursive: true })
    await execFileAsync(ffmpegStatic, [
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
      scopes: ['projects:read', 'projects:write', 'operations:read', 'artifacts:read'],
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
      draft: { status: 'approved', allowedUses: ['rendering'], prohibitedUses: [], allowedLocales: ['pt-BR'], consent: { status: 'not-required', allowedUses: [] } },
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
        story: `matrix-story-${key}-${suffix}`, editPlan: `matrix-edit-plan-${key}-${suffix}`,
        quality: `matrix-quality-${key}-${suffix}`,
      }
      const editPlan = {
        schemaVersion: 2, state: 'compiled', id: `matrix-plan-${key}-${suffix}`, projectVersionId: versionId,
        fps: 30, durationFrames: 30,
        videoTracks: [{ id: `matrix-track-${key}-${suffix}`, kind: 'base-video', clips: [{
          id: `matrix-clip-${key}-${suffix}`, sourceArtifactId, sourceInFrame: 0, sourceOutFrame: 30,
          timelineInFrame: 0, timelineOutFrame: 30, rate: 1,
        }] }],
        subtitleTracks: [], transitions: [], movementPolicy: { automaticZoom: false, protectedOpeningFrames: 30 },
        composition: {
          layout: 'landscape-inset', background: 'blurred-source', foregroundScale: 1, verticalPosition: 0.5,
          faceSafeFallback: [0.08, 0.08, 0.84, 0.84], subtitleSafeRegion: [0.08, 0.68, 0.84, 0.22],
        },
      }
      const quality = {
        schemaVersion: 'director-quality-report/v1', id: `matrix-quality-report-${key}-${suffix}`,
        status: 'approved', score: 0.99, issues: [], evaluatedAt: createdAt.toISOString(),
      }

      await client.v2Project.create({ data: {
        id: projectId, workspaceId, name: `Matrix ${format}`, status: 'reviewing-proxy', objective: 'conversion',
        format, locale: 'pt-BR', createdByType: 'api-client', createdById: issued.client.id, createdAt, updatedAt: createdAt,
      } })
      for (const [id, kind, schemaVersion, content] of [
        [snapshots.brief, 'brief', 1, { schemaVersion: 1, productionBrief: { ownerInput: { text: `Matrix ${format}` } } }],
        [snapshots.policies, 'policies', 1, { schemaVersion: 1, state: 'configured' }],
        [snapshots.perception, 'perception', 1, { schemaVersion: 1, state: 'complete' }],
        [snapshots.treatment, 'treatment', 1, { schemaVersion: 1, state: 'complete' }],
        [snapshots.story, 'story', 1, { schemaVersion: 1, state: 'complete' }],
        [snapshots.editPlan, 'edit-plan', 2, editPlan],
        [snapshots.quality, 'quality-report', 1, quality],
      ]) {
        await client.v2ProjectSnapshot.create({ data: {
          id, workspaceId, projectId, kind, schemaVersion, contentJson: stableSerialize(content),
          contentHash: calculateVersionHash(content), createdAt,
        } })
      }
      const baseHash = calculateVersionHash({ projectId, version: baseVersionId })
      await client.v2ProjectVersion.create({ data: {
        id: baseVersionId, workspaceId, projectId, sequence: 1, briefSnapshotId: snapshots.brief,
        editPlanSnapshotId: snapshots.editPlan, policiesSnapshotId: snapshots.policies,
        baseHash, createdBy: issued.client.id, createdAt,
      } })
      await client.v2EditCommand.create({ data: {
        id: commandId, workspaceId, projectId, baseVersionId, baseHash, type: 'run-director',
        scopeJson: stableSerialize({ kind: 'video', targetIds: [] }),
        payloadJson: stableSerialize({ schemaVersion: 1, directorRunId }), reason: 'Matrix E2E',
        actorType: 'api-client', actorId: issued.client.id, idempotencyKey: `matrix-director-${key}-${suffix}`,
        requestFingerprint: calculateVersionHash({ commandId }), createdAt,
      } })
      const versionHash = calculateVersionHash({ projectId, version: versionId })
      await client.v2ProjectVersion.create({ data: {
        id: versionId, workspaceId, projectId, sequence: 2, parentVersionId: baseVersionId,
        briefSnapshotId: snapshots.brief, treatmentSnapshotId: snapshots.treatment, storySnapshotId: snapshots.story,
        editPlanSnapshotId: snapshots.editPlan, policiesSnapshotId: snapshots.policies,
        baseHash: versionHash, createdBy: issued.client.id, commandId, createdAt,
      } })
      await client.v2DirectorRun.create({ data: {
        id: directorRunId, workspaceId, projectId, commandId, baseVersionId, resultVersionId: versionId,
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
      cells.push({ recipeId: 'approved-master-v1', projectId, projectVersionId: versionId, projectVersionHash: versionHash, format, locale: 'pt-BR' })
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

    const preflightResponse = await fetch(`${baseUrl}/v1/export-matrix-preflights`, {
      method: 'POST', headers: { authorization, 'content-type': 'application/json', 'idempotency-key': `matrix-preflight-${suffix}` },
      body: JSON.stringify({ cells, limits: { maximumCostMinorUnits: 100000000, maximumStorageBytes: 9000000000000 } }),
    })
    const preflight = await preflightResponse.json()
    assert.equal(preflightResponse.status, 201, `${JSON.stringify(preflight)}\n${serverLogs.slice(-4_000)}`)
    assert.equal(preflight.data.preflight.allowed, true)
    assert.equal(preflight.data.preflight.definition.cells.length, 5)
    assert.equal(new Set(preflight.data.preflight.definition.cells.map((cell) => cell.outputFileName)).size, 5)

    const commitResponse = await fetch(`${baseUrl}/v1/export-matrix-preflights/${preflight.data.preflightId}/commit`, {
      method: 'POST', headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ commitToken: preflight.data.commitToken, approval: { approved: true, note: 'Matrix E2E approved.' } }),
    })
    const committed = await commitResponse.json()
    assert.equal(commitResponse.status, 202, `${JSON.stringify(committed)}\n${serverLogs.slice(-4_000)}`)
    const matrixId = committed.data.matrix.id
    assert.equal(committed.data.matrix.status, 'queued')
    assert.equal(new Set(committed.data.matrix.cells.map((cell) => cell.operationId)).size, 5)

    const workerEnvironment = {
      ...process.env, APOLLO_V2_ARTIFACT_ROOT: artifactRoot,
      APOLLO_V2_RENDER_WORK_ROOT: join(artifactRoot, '.matrix-work'),
      APOLLO_V2_RENDER_LEASE_MS: '120000', APOLLO_V2_RENDER_HEARTBEAT_MS: '5000',
      APOLLO_V2_WORKER_RETRY_BASE_MS: '1', APOLLO_V2_WORKER_RETRY_MAX_MS: '1',
      APOLLO_PROTECTED_PAYLOAD_KEY_ID: 'matrix-e2e-key',
      APOLLO_PROTECTED_PAYLOAD_KEY: Buffer.alloc(32, 9).toString('base64url'),
    }
    const failingWorker = createProjectFinalExportWorker({ ...workerEnvironment, FFMPEG_PATH: process.execPath })
    const retryOutcome = await failingWorker(`matrix-worker-retry-${suffix}`)
    const retryOperation = retryOutcome
      ? await client.v2PublicOperation.findUnique({ where: { id: retryOutcome.operationId } })
      : null
    assert.equal(retryOutcome?.status, 'retrying', stableSerialize({
      outcome: retryOutcome,
      errorCode: retryOperation?.errorCode,
      errorMessage: retryOperation?.errorMessage,
      errorRetryable: retryOperation?.errorRetryable,
      attempt: retryOperation?.attempt,
      maxAttempts: retryOperation?.maxAttempts,
    }))
    const retryResponse = await fetch(`${baseUrl}/v1/export-matrices/${matrixId}`, { headers: { authorization } })
    const retrying = await retryResponse.json()
    assert.equal(retryResponse.status, 200)
    assert.equal(retrying.data.matrix.cells.filter((cell) => cell.status === 'retrying').length, 1)
    assert.equal(retrying.data.matrix.cells.filter((cell) => cell.status === 'queued').length, 4)
    await new Promise((resolve) => setTimeout(resolve, 25))

    const worker = createProjectFinalExportWorker(workerEnvironment)
    for (let index = 0; index < 3; index += 1) {
      const outcome = await worker(`matrix-worker-a-${index}-${suffix}`)
      assert.equal(outcome?.status, 'succeeded')
    }
    const partialResponse = await fetch(`${baseUrl}/v1/export-matrices/${matrixId}`, { headers: { authorization } })
    const partial = await partialResponse.json()
    assert.equal(partialResponse.status, 200)
    assert.equal(partial.data.matrix.status, 'running')
    assert.equal(partial.data.matrix.cells.filter((cell) => cell.status === 'ready').length, 3)
    assert.equal(partial.data.matrix.cells.filter((cell) => cell.status === 'queued').length, 2)

    for (let index = 3; index < 5; index += 1) {
      const outcome = await worker(`matrix-worker-b-${index}-${suffix}`)
      assert.equal(outcome?.status, 'succeeded')
    }
    const readyResponse = await fetch(`${baseUrl}/v1/export-matrices/${matrixId}`, { headers: { authorization } })
    const ready = await readyResponse.json()
    assert.equal(readyResponse.status, 200)
    assert.equal(ready.data.matrix.status, 'ready')
    assert.deepEqual(ready.data.matrix.cells.map((cell) => cell.status), Array(5).fill('ready'))
    assert.deepEqual(ready.data.matrix.cells.map((cell) => cell.attempt).toSorted(), [1, 1, 1, 1, 2])
    assert.equal(new Set(ready.data.matrix.cells.map((cell) => cell.outputArtifactId)).size, 5)
    assert.equal(new Set(ready.data.matrix.cells.map((cell) => cell.outputManifestId)).size, 5)

    const outputHashes = new Set()
    for (const cell of ready.data.matrix.cells) {
      const artifact = await client.v2MediaArtifact.findUnique({ where: { id: cell.outputArtifactId } })
      assert.ok(artifact)
      outputHashes.add(artifact.sha256)
      const outputPath = join(artifactRoot, ...artifact.artifactKey.split('/'))
      const { stdout } = await execFileAsync(ffprobeStatic, [
        '-v', 'error', '-count_frames', '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name,width,height,nb_read_frames', '-of', 'json', outputPath,
      ], { timeout: 30_000 })
      const stream = JSON.parse(stdout).streams[0]
      const preset = readOutputFormatPreset(cell.format).spec
      assert.equal(stream.codec_name, 'h264')
      assert.equal(stream.width, preset.width)
      assert.equal(stream.height, preset.height)
      assert.equal(Number(stream.nb_read_frames), 30)
      assert.equal(sha256(await readFile(outputPath)), artifact.sha256)
    }
    assert.equal(outputHashes.size, 5)
    assert.equal(await client.v2ProjectMediaAsset.count({ where: { workspaceId, artifactId: sourceArtifactId, role: 'source-master' } }), 5)
    assert.equal(await client.v2ExportMatrix.count({ where: { workspaceId } }), 1)
    assert.equal(await client.v2ExportMatrixCell.count({ where: { workspaceId } }), 5)
  } finally {
    await stopChild(server)
    await client.$disconnect()
    await rm(join(artifactRoot, 'workspaces', workspaceId), { recursive: true, force: true })
    await rm(join(artifactRoot, '.matrix-work'), { recursive: true, force: true })
  }
})
