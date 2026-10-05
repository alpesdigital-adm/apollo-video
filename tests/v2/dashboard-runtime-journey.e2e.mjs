import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import net from 'node:net'
import { dirname, isAbsolute, join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { runDashboardRuntimeJourney } from './helpers/dashboard-runtime-journey.mjs'

// Only upstream Director snapshots, source bytes and color probe are controlled inputs.
// Project creation/status, operations, proxy review, outputs and terminal transitions
// are produced exclusively by public APIs and real production workers.
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
    try { if ((await fetch(`${baseUrl}/v1/health`, { signal: AbortSignal.timeout(3000) })).ok) return } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Next server did not become ready')
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

test('W35 real dashboard transitions originate in APIs and fenced FFmpeg workers', {
  skip: process.env.APOLLO_DASHBOARD_RUNTIME_E2E !== '1' && 'set APOLLO_DASHBOARD_RUNTIME_E2E=1 and use an isolated V2 database',
  timeout: process.env.APOLLO_DASHBOARD_RUNTIME_SERVER_MODE === 'dev' ? 480_000 : 360_000,
}, async (t) => {
  assert.ok(process.env.V2_DATABASE_URL, 'V2_DATABASE_URL must point to an isolated PostgreSQL database')
  const artifactRoot = process.env.APOLLO_V2_ARTIFACT_ROOT?.trim() ?? ''
  assert.equal(isAbsolute(artifactRoot), true, 'APOLLO_V2_ARTIFACT_ROOT must be absolute')
  assert.ok(ffmpegStatic, 'ffmpeg-static is required')

  const { assetRightsRevision } = await import('../../src/v2/domain/asset-rights.ts')
  const { calculateVersionHash, stableSerialize } = await import('../../src/v2/application/version-hash.ts')
  const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
  const { createApiAccessAuditContext } = await import('../../src/v2/domain/api-access-control.ts')
  const { createMediaColorProbe } = await import('../../src/v2/domain/color-and-export.ts')
  const { reconstructFinal } = await import('../../src/v2/application/render-workflow.ts')
  const { setProjectLutSelectionService } = await import('../../src/v2/application/project-lut-selections.ts')
  const { catalogApprovedOutputService } = await import('../../src/v2/application/catalog-approved-output.ts')
  const { PrismaAutomaticCatalogRepository } = await import('../../src/v2/infrastructure/prisma/automatic-catalog-repository.ts')
  const { listMediaLibraryService } = await import('../../src/v2/application/media-library.ts')
  const { PrismaMediaLibraryRepository } = await import('../../src/v2/infrastructure/prisma/media-library-repository.ts')
  const { setAssetRightsService } = await import('../../src/v2/application/set-asset-rights.ts')
  const { createProjectFinalExportWorker } = await import('../../src/v2/infrastructure/repository-factory.ts')
  const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
  const { PrismaAssetRightsRepository } = await import('../../src/v2/infrastructure/prisma/asset-rights-repository.ts')
  const { PrismaProjectLutSelectionRepository } = await import('../../src/v2/infrastructure/prisma/project-lut-selection-repository.ts')
  const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
  const { createUiPasswordHash } = await import('../../src/v2/infrastructure/security/ui-session.ts')
  const { probeVideo } = await import('../../src/v2/infrastructure/media/video-probe.ts')

  const client = new PrismaClient()
  const databaseName = new URL(process.env.V2_DATABASE_URL).pathname.slice(1)
  assert.match(databaseName, /(?:^|_)e2e(?:_|$)/, 'destructive E2E setup requires an explicitly isolated database')
  await client.$executeRawUnsafe('TRUNCATE TABLE "workspaces" CASCADE')
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `final-export-workspace-${suffix}`
  let projectId
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
      scopes: ['projects:read', 'projects:write', 'operations:read', 'operations:retry', 'artifacts:read'],
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
    const port = await getFreePort()
    const baseUrl = `http://localhost:${port}`
    server = spawn(process.execPath, ['node_modules/next/dist/bin/next', ...(process.env.APOLLO_DASHBOARD_RUNTIME_SERVER_MODE === 'dev' ? ['dev', '--webpack'] : ['start']), '-p', String(port)], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: process.env.APOLLO_DASHBOARD_RUNTIME_SERVER_MODE === 'dev' ? 'development' : 'production',
        __NEXT_PROCESSED_ENV: 'true',
        APOLLO_API_ENVIRONMENT: 'production',
        APOLLO_AUTH_MODE: 'bootstrap', APOLLO_ALLOW_BOOTSTRAP_AUTH: 'true', APOLLO_UI_BOOTSTRAP_ROLE: 'operator',
        APOLLO_UI_USERNAME: uiUsername, APOLLO_UI_PASSWORD_HASH: createUiPasswordHash(uiPassword, `catalog-salt-${suffix}`),
        APOLLO_UI_SESSION_SECRET: `catalog-${suffix}-session-secret-with-32-bytes`, APOLLO_UI_API_CLIENT_ID: issued.client.id,
        APOLLO_V2_ARTIFACT_ROOT: artifactRoot,
        APOLLO_MEDIA_DOWNLOAD_BASE_URL: `${baseUrl}/`,
        APOLLO_MEDIA_DOWNLOAD_SIGNING_SECRET: `final-export-download-${suffix}`.padEnd(48, 'x'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.stdout.on('data', (chunk) => { serverLogs += String(chunk); process.stdout.write(chunk) })
    server.stderr.on('data', (chunk) => { serverLogs += String(chunk); process.stderr.write(chunk) })
    try { await waitForServer(baseUrl, server) } catch (error) { throw new Error(`${error.message}\n${serverLogs}`, { cause: error }) }
    const authorization = `Bearer ${issued.token}`
    const created = await fetch(`${baseUrl}/v1/projects`, { method: 'POST', headers: { authorization, 'content-type': 'application/json', 'idempotency-key': `runtime-create-${suffix}` }, body: JSON.stringify({ name: 'Dashboard runtime W35', objective: 'discovery', format: '9:16', locale: 'pt-BR' }) })
    const createdBody = await created.json()
    assert.equal(created.status, 201, JSON.stringify(createdBody))
    projectId = createdBody.data.project.id
    assert.equal(createdBody.data.project.status, 'draft')
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
      [snapshotIds.baseEditPlan, 'edit-plan', 2, baseEditPlan],
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
        sequence: 2,
        parentVersionId: createdBody.data.version.id,
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
        sequence: 4,
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
    await runDashboardRuntimeJourney({ client, baseUrl, authorization, workspaceId, projectId, projectVersionId, projectVersionHash, sourcePath, artifactRoot, uiUsername, uiPassword, suffix, signal: t.signal })
  } finally {
    if (process.env.APOLLO_DASHBOARD_RUNTIME_EVIDENCE_ROOT) {
      await mkdir(process.env.APOLLO_DASHBOARD_RUNTIME_EVIDENCE_ROOT, { recursive: true })
      await writeFile(join(process.env.APOLLO_DASHBOARD_RUNTIME_EVIDENCE_ROOT, 'owned-next.log'), serverLogs)
    }
    if (server && server.exitCode === null) {
      server.kill()
      await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))])
      if (server.exitCode === null && server.signalCode === null) {
        server.kill('SIGKILL')
        await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))])
      }
    }
    assert.ok(!server || server.exitCode !== null || server.signalCode !== null, 'Owned export Next server must terminate')
    const { disconnectV2PostgresClient } = await import('../../src/v2/infrastructure/prisma-postgres/client.ts')
    await disconnectV2PostgresClient()
    await client.$disconnect()
    await rm(join(artifactRoot, `workspaces/final-export-e2e-${suffix}`), { recursive: true, force: true })
  }
})
