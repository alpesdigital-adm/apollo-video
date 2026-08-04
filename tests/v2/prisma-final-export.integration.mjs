import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import net from 'node:net'
import { dirname, isAbsolute, join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const ffmpegStatic = require('ffmpeg-static')

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

test('T-FR-231 approves, retries, renders, validates, downloads and reconstructs one immutable final', {
  skip: process.env.APOLLO_FINAL_EXPORT_E2E !== '1' && 'set APOLLO_FINAL_EXPORT_E2E=1 and use an isolated V2 database',
  timeout: 180_000,
}, async () => {
  assert.ok(process.env.V2_DATABASE_URL, 'V2_DATABASE_URL must point to an isolated PostgreSQL database')
  const artifactRoot = process.env.APOLLO_V2_ARTIFACT_ROOT?.trim() ?? ''
  assert.equal(isAbsolute(artifactRoot), true, 'APOLLO_V2_ARTIFACT_ROOT must be absolute')
  assert.ok(ffmpegStatic, 'ffmpeg-static is required')

  const { assetRightsRevision } = await import('../../src/v2/domain/asset-rights.ts')
  const { calculateVersionHash, stableSerialize } = await import('../../src/v2/application/version-hash.ts')
  const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
  const { reconstructFinal } = await import('../../src/v2/application/render-workflow.ts')
  const { setAssetRightsService } = await import('../../src/v2/application/set-asset-rights.ts')
  const { createProjectFinalExportWorker } = await import('../../src/v2/infrastructure/repository-factory.ts')
  const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
  const { PrismaAssetRightsRepository } = await import('../../src/v2/infrastructure/prisma/asset-rights-repository.ts')
  const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
  const { probeVideo } = await import('../../src/v2/infrastructure/media/video-probe.ts')

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
  let server
  let serverLogs = ''

  try {
    await mkdir(dirname(sourcePath), { recursive: true })
    await execFileAsync(ffmpegStatic, [
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
    const qualityReport = {
      schemaVersion: 'director-quality-report/v1',
      id: `final-export-quality-report-${suffix}`,
      status: 'approved',
      score: 0.98,
      issues: [],
      evaluatedAt: createdAt.toISOString(),
    }
    const snapshots = [
      [snapshotIds.brief, 'brief', 1, { schemaVersion: 1, productionBrief: { ownerInput: { text: 'Final aprovado.' } } }],
      [snapshotIds.policies, 'policies', 1, { schemaVersion: 1, state: 'configured' }],
      [snapshotIds.perception, 'perception', 1, { schemaVersion: 1, state: 'complete' }],
      [snapshotIds.treatment, 'treatment', 1, { schemaVersion: 1, state: 'complete' }],
      [snapshotIds.story, 'story', 1, { schemaVersion: 1, state: 'complete' }],
      [snapshotIds.editPlan, 'edit-plan', 2, editPlan],
      [snapshotIds.quality, 'quality-report', 1, qualityReport],
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
        editPlanSnapshotId,
        policiesSnapshotId: snapshotIds.policies,
        baseHash: baseVersionHash,
        createdBy: issued.client.id,
        createdAt,
      },
    })
    await client.v2EditCommand.create({
      data: {
        id: commandId,
        workspaceId,
        projectId,
        baseVersionId,
        baseHash: baseVersionHash,
        type: 'run-director',
        scopeJson: stableSerialize({ kind: 'video', targetIds: [] }),
        payloadJson: stableSerialize({ schemaVersion: 1, directorRunId }),
        reason: 'E2E final render',
        actorType: 'api-client',
        actorId: issued.client.id,
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
        sequence: 2,
        parentVersionId: baseVersionId,
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
        baseVersionId,
        resultVersionId: projectVersionId,
        status: 'succeeded',
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
    await client.v2MediaArtifactManifest.create({
      data: {
        id: sourceManifestId,
        workspaceId,
        artifactId: sourceArtifactId,
        schemaVersion: 'media-artifact-manifest/v2',
        manifestHash: calculateVersionHash({ sourceManifestId }),
        recipeId: 'source-master',
        recipeVersion: '1.0.0',
        parametersHash: calculateVersionHash({ sourceManifestId, parameters: true }),
        manifestJson: stableSerialize({
          schemaVersion: 'media-artifact-manifest/v2',
          artifact: {
            artifactKey: sourceArtifactKey,
            sha256: sourceSha256,
            byteSize: sourceBytes.byteLength,
            mediaType: 'video',
            container: 'mp4',
          },
          recipe: {
            id: 'source-master',
            version: '1.0.0',
            parametersHash: calculateVersionHash({ sourceManifestId, parameters: true }),
          },
          sources: [],
        }),
        createdAt,
      },
    })
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
        allowedUses: ['rendering'],
        prohibitedUses: [],
        allowedLocales: ['pt-BR'],
        consent: { status: 'not-required', allowedUses: [] },
      },
      actor: { type: 'api-client', id: issued.client.id },
    })

    const proxySha256 = calculateVersionHash({ proxyArtifactId })
    await client.v2MediaArtifact.create({
      data: {
        id: proxyArtifactId,
        workspaceId,
        artifactKey: `workspaces/final-export-e2e-${suffix}/proxies/proxy.mp4`,
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
        schemaVersion: 'media-artifact-manifest/v2',
        manifestHash: calculateVersionHash({ proxyManifestId }),
        recipeId: 'editorial-proxy',
        recipeVersion: '1.0.0',
        parametersHash: calculateVersionHash({ proxyManifestId, parameters: true }),
        manifestJson: stableSerialize({
          artifact: { artifactKey: `workspaces/final-export-e2e-${suffix}/proxies/proxy.mp4` },
        }),
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
        targetType: 'media-artifact',
        targetId: proxyArtifactId,
        cancelable: false,
        retryable: false,
        attempt: 1,
        maxAttempts: 3,
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

    const port = await getFreePort()
    const baseUrl = `http://127.0.0.1:${port}`
    server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port)], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        __NEXT_PROCESSED_ENV: 'true',
        APOLLO_API_ENVIRONMENT: 'production',
        APOLLO_V2_ARTIFACT_ROOT: artifactRoot,
        APOLLO_MEDIA_DOWNLOAD_BASE_URL: `${baseUrl}/`,
        APOLLO_MEDIA_DOWNLOAD_SIGNING_SECRET: `final-export-download-${suffix}`.padEnd(48, 'x'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.stdout.on('data', (chunk) => { serverLogs += String(chunk) })
    server.stderr.on('data', (chunk) => { serverLogs += String(chunk) })
    await waitForServer(baseUrl, server)
    const authorization = `Bearer ${issued.token}`
    const exportBody = {
      projectVersionId,
      projectVersionHash,
      format: '9:16',
      approval: { approved: true, note: 'Aprovado pelo E2E para render final.' },
    }
    const enqueueResponse = await fetch(`${baseUrl}/v1/projects/${projectId}/exports`, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': `final-export-${suffix}`,
      },
      body: JSON.stringify(exportBody),
    })
    const enqueuePayload = await enqueueResponse.json()
    assert.equal(enqueueResponse.status, 202, `${JSON.stringify(enqueuePayload)}\n${serverLogs.slice(-4_000)}`)
    assert.equal(enqueuePayload.data.replayed, false)
    assert.deepEqual(enqueuePayload.data.outputSpec, {
      aspectRatio: '9:16',
      width: 1080,
      height: 1920,
      fps: 30,
    })
    const operationId = enqueuePayload.data.operation.id
    const replayResponse = await fetch(`${baseUrl}/v1/projects/${projectId}/exports`, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': `final-export-${suffix}`,
      },
      body: JSON.stringify(exportBody),
    })
    const replayPayload = await replayResponse.json()
    assert.equal(replayResponse.status, 202, JSON.stringify(replayPayload))
    assert.equal(replayPayload.data.replayed, true)
    assert.equal(replayPayload.data.operation.id, operationId)

    const mismatchResponse = await fetch(`${baseUrl}/v1/projects/${projectId}/exports`, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': `final-export-${suffix}`,
      },
      body: JSON.stringify({
        ...exportBody,
        approval: { approved: true, note: 'Payload diferente com a mesma chave.' },
      }),
    })
    assert.equal(mismatchResponse.status, 409, JSON.stringify(await mismatchResponse.json()))
    const staleResponse = await fetch(`${baseUrl}/v1/projects/${projectId}/exports`, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': `final-export-stale-${suffix}`,
      },
      body: JSON.stringify({ ...exportBody, projectVersionHash: '0'.repeat(64) }),
    })
    assert.equal(staleResponse.status, 422, JSON.stringify(await staleResponse.json()))

    const workerEnvironment = {
      ...process.env,
      APOLLO_V2_ARTIFACT_ROOT: artifactRoot,
      APOLLO_V2_RENDER_LEASE_MS: '120000',
      APOLLO_V2_RENDER_HEARTBEAT_MS: '5000',
      APOLLO_V2_WORKER_RETRY_BASE_MS: '1',
      APOLLO_V2_WORKER_RETRY_MAX_MS: '1',
      APOLLO_PROTECTED_PAYLOAD_KEY_ID: 'final-export-e2e-key',
      APOLLO_PROTECTED_PAYLOAD_KEY: Buffer.alloc(32, 7).toString('base64url'),
    }
    const failingWorker = createProjectFinalExportWorker({
      ...workerEnvironment,
      FFMPEG_PATH: process.execPath,
    })
    const failedOutcome = await failingWorker(
      `final-export-worker-failed-${suffix}`,
    )
    assert.deepEqual(failedOutcome, { operationId, status: 'retrying' })
    const failedAttempt = await client.v2ProjectFinalExportAttempt.findUnique({
      where: { operationId_attempt: { operationId, attempt: 1 } },
    })
    assert.equal(failedAttempt?.status, 'failed')
    await new Promise((resolve) => setTimeout(resolve, 25))
    const worker = createProjectFinalExportWorker(workerEnvironment)
    const completedOutcome = await worker(`final-export-worker-promoted-${suffix}`)
    assert.deepEqual(completedOutcome, { operationId, status: 'succeeded' })

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

    const operationResponse = await fetch(`${baseUrl}/v1/operations/${operationId}`, {
      headers: { authorization },
    })
    const operationPayload = await operationResponse.json()
    assert.equal(operationResponse.status, 200, JSON.stringify(operationPayload))
    assert.equal(operationPayload.data.operation.status, 'succeeded')
    assert.equal(operationPayload.data.operation.attempt, 2)
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
    const finalProbe = await probeVideo(finalPath)
    assert.equal(finalProbe.width, 1080)
    assert.equal(finalProbe.height, 1920)
    assert.equal(finalProbe.codec, 'h264')
    assert.equal(finalProbe.audioCodec, 'aac')
    assert.match(finalProbe.container, /mp4/)

    const tamperedUrl = new URL(grantPayload.data.downloadUrl)
    const token = tamperedUrl.searchParams.get('token')
    tamperedUrl.searchParams.set('token', `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`)
    const tamperedResponse = await fetch(tamperedUrl)
    assert.equal(tamperedResponse.status, 409)
  } finally {
    if (server && server.exitCode === null) {
      server.kill()
      await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))])
    }
    await client.$disconnect()
    await rm(join(artifactRoot, `workspaces/final-export-e2e-${suffix}`), { recursive: true, force: true })
  }
})
