import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { dirname, isAbsolute, join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { runDashboardRuntimeJourney } from './helpers/dashboard-runtime-journey.mjs'
import { dashboardColorProbePersistenceData } from './helpers/dashboard-controlled-export-fixture.mjs'

// Source bytes, aligned transcript, initial timeline, rights and color probe are
// controlled inputs. The real Director service materializes canonical snapshots.
// Public final admission must reject UNKNOWN. PostgreSQL must also reject a
// test-only approval claim; a separate blocked review GUI state is explicitly
// seeded. Positive final admission, worker, MP4 and completed GUI remain pending.
const execFileAsync = promisify(execFile)

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

test('W35 real dashboard proxy/retry transitions and negative final admission; seeded review GUI', {
  skip: process.env.APOLLO_DASHBOARD_RUNTIME_E2E !== '1' && 'set APOLLO_DASHBOARD_RUNTIME_E2E=1 and use an isolated V2 database',
  timeout: process.env.APOLLO_DASHBOARD_RUNTIME_SERVER_MODE === 'dev' ? 480_000 : 360_000,
}, async (t) => {
  assert.ok(process.env.V2_DATABASE_URL, 'V2_DATABASE_URL must point to an isolated PostgreSQL database')
  const artifactRoot = process.env.APOLLO_V2_ARTIFACT_ROOT?.trim() ?? ''
  assert.equal(isAbsolute(artifactRoot), true, 'APOLLO_V2_ARTIFACT_ROOT must be absolute')
  const { resolveFfmpegBinary } = await import('../../src/v2/infrastructure/media/ffmpeg-binary.ts')
  const ffmpegBin = resolveFfmpegBinary()
  assert.equal(isAbsolute(ffmpegBin), true, 'Resolved FFmpeg binary must be absolute')

  const { assetRightsRevision } = await import('../../src/v2/domain/asset-rights.ts')
  const { calculateVersionHash, stableSerialize } = await import('../../src/v2/application/version-hash.ts')
  const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
  const { createApiAccessAuditContext } = await import('../../src/v2/domain/api-access-control.ts')
  const { createMediaColorProbe } = await import('../../src/v2/domain/color-and-export.ts')
  const { createMediaTranscript } = await import('../../src/v2/domain/media-transcript.ts')
  const { createMediaArtifactManifestV2 } = await import('../../src/v2/domain/media-artifact.ts')
  const { runProjectDirectorService } = await import('../../src/v2/application/run-project-director.ts')
  const { createExternalAuditContext } = await import('../../src/v2/application/authenticate-api-client.ts')
  const { PrismaDirectorRunRepository } = await import('../../src/v2/infrastructure/prisma/director-run-repository.ts')
  const { createEvidenceBoundBriefCompiler } = await import('../../src/v2/infrastructure/brief/evidence-bound-brief-compiler-model.ts')
  const { setProjectLutSelectionService } = await import('../../src/v2/application/project-lut-selections.ts')
  const { setAssetRightsService } = await import('../../src/v2/application/set-asset-rights.ts')
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
  const createdAt = new Date('2026-07-26T20:00:00.000Z')
  const sourceArtifactKey = `workspaces/final-export-e2e-${suffix}/masters/source.mp4`
  const sourcePath = join(artifactRoot, ...sourceArtifactKey.split('/'))
  const uiUsername = `catalog-${suffix}`
  const uiPassword = `Catalog-${suffix}-controlled-password`
  let server
  let serverLogs = ''

  try {
    await mkdir(dirname(sourcePath), { recursive: true })
    await execFileAsync(ffmpegBin, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '4',
      '-vf', 'format=gbrp,zscale=matrixin=gbr:primariesin=709:transferin=linear:matrix=709:primaries=709:transfer=709:range=limited,format=yuv420p',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709:fullrange=off',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
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
        // This controlled two-page browser proof opens every card destination
        // and samples every phase; it uses the existing journey test policy.
        APOLLO_GOVERNANCE_ANOMALY_REQUEST_MINIMUM: '400',
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
    const snapshotIds = {
      brief: `final-export-brief-${suffix}`,
      policies: `final-export-policies-${suffix}`,
      baseEditPlan: `final-export-base-edit-plan-${suffix}`,
    }
    const transcriptId = `runtime-transcript-${suffix}`
    const transcript = createMediaTranscript({ language: 'pt-BR',
      text: 'Bem vindo ao Apollo', provider: 'controlled', model: 'aligned-fixture-v1',
      words: [{ word: 'Bem', start: 0.2, end: 0.5 }, { word: 'vindo', start: 0.5, end: 0.9 },
        { word: 'ao', start: 0.9, end: 1.1 }, { word: 'Apollo', start: 1.1, end: 1.7 }],
      segments: [{ id: 0, start: 0.2, end: 1.7, text: 'Bem vindo ao Apollo' }] })
    const editPlan = {
      schemaVersion: 2,
      state: 'compiled',
      id: `final-export-plan-${suffix}`,
      projectVersionId,
      storyPlanId: null,
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
      sources: [{ id: sourceArtifactId, artifactId: sourceArtifactId, kind: 'video', durationSeconds: 4 }],
      overlayTracks: [], audioTracks: [], effectTracks: [], markers: [], protectedElements: [],
      localeVariantRefs: [], formatVariantRefs: [], lineageRefs: [sourceArtifactId],
      editorial: { commandType: 'remove-spoken-content', exclusions: [],
        retainedSourceRanges: [{ sourceStartSeconds: 0, sourceEndSeconds: 4 }] },
      subtitlePolicy: { faceProtection: true, anchor: 'bottom', maxCharactersPerBlock: 32 },
      retimedTranscript: { sourceTranscriptId: transcriptId, sourceTranscriptHash: transcript.transcriptHash,
        words: transcript.words.map((word) => ({ text: word.word, sourceStartSeconds: word.start,
          sourceEndSeconds: word.end, timelineStartFrame: Math.round(word.start * 30),
          timelineEndFrame: Math.round(word.end * 30) })) },
      createdAt: createdAt.toISOString(),
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
    const { createProductionBrief } = await import('../../src/v2/domain/production-brief.ts')
    const snapshots = [
      [snapshotIds.brief, 'brief', 1, { schemaVersion: 1, objective: 'discovery',
        desiredAction: { schemaVersion: 1, kind: 'continue-viewing', disclosures: [] },
        outputSpec: { schemaVersion: 1, id: `runtime-output-${suffix}`, locale: 'pt-BR',
          aspectRatio: '9:16', width: 1080, height: 1920, fps: 30,
          safeArea: { top: 0.05, right: 0.05, bottom: 0.08, left: 0.05 } },
        productionBrief: createProductionBrief({ ownerText: 'Público: equipes criativas. Tom: direto e natural.' }),
        createdAt: createdAt.toISOString() }],
      [snapshotIds.policies, 'policies', 1, { schemaVersion: 1, state: 'configured', guardrails: [], createdAt: createdAt.toISOString() }],
      [snapshotIds.baseEditPlan, 'edit-plan', 2, baseEditPlan],
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
    const sourceProbe = await probeVideo(sourcePath)
    assert.deepEqual(sourceProbe.color, { state: 'ready', metadata: colorMetadata, pixelFormat: 'yuv420p', hdrMode: 'sdr' },
      'Controlled RGB source must be measured as limited BT.709 before fixture persistence')
    const sourceManifest = createMediaArtifactManifestV2({ artifactKey: sourceArtifactKey,
      artifactSha256: sourceSha256, byteSize: sourceBytes.length, mediaType: 'video', container: 'mp4',
      recipe: { id: 'source-master', version: '1.0.0', parameters: { controlled: true, durationSeconds: 4 } },
      sources: [], probe: { width: sourceProbe.width, height: sourceProbe.height,
        duration: sourceProbe.duration, fps: sourceProbe.fps } })
    await client.v2MediaArtifactManifest.create({
      data: {
        id: sourceManifestId,
        workspaceId,
        artifactId: sourceArtifactId,
        schemaVersion: 'media-artifact-manifest/v2',
        manifestHash: sourceManifest.manifestHash,
        recipeId: 'source-master',
        recipeVersion: '1.0.0',
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
      detection: sourceProbe.color,
      producer: sourceProbe.producer,
      createdAt: createdAt.toISOString(),
    })
    await client.v2MediaColorProbe.create({ data: dashboardColorProbePersistenceData(colorProbe, stableSerialize) })
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

    await client.v2MediaTranscript.create({ data: { id: transcriptId, workspaceId, projectId,
      sourceArtifactId, sourceManifestId, schemaVersion: transcript.schemaVersion,
      language: transcript.language, provider: transcript.provider, model: transcript.model,
      providerVersion: 'controlled-v1', transcriptHash: transcript.transcriptHash,
      transcriptJson: stableSerialize(transcript), createdAt } })
    const auditContext = createExternalAuditContext({ clientId: issued.client.id,
      credentialId: issued.credential.id, workspaceId, environment: 'production' })
    const actor = { ...auditContext, auditContext, scopes: new Set(['projects:write']),
      authenticationKind: 'bearer', clientKillSwitchEngaged: false,
      workspaceKillSwitchEngaged: false, clientAccessStatus: 'active', workspaceAccessStatus: 'active' }
    const directed = await runProjectDirectorService({
      repository: new PrismaDirectorRunRepository(client), clock: () => createdAt,
      createEventId: randomUUID, compileBrief: createEvidenceBoundBriefCompiler(),
      createId: (kind) => kind === 'project-version' ? projectVersionId
        : kind === 'director-run' ? directorRunId : kind === 'edit-command' ? commandId
          : `runtime-${kind}-${randomUUID()}`,
    })({ workspaceId, projectId, baseVersionId: noLut.version.id, baseHash: noLut.version.baseHash,
      actor, idempotency: { key: `runtime-director-${suffix}` },
      reason: 'Controlled upstream for dashboard mechanics; absent face evidence requires review.' })
    assert.equal(directed.run.perception.schemaVersion, 2)
    assert.equal(directed.run.perception.inputVersionId, noLut.version.id)
    assert.equal(directed.run.perception.summary.faceCoverage, 'absent')
    assert.equal(directed.run.qualityReport.status, 'review-required')
    assert.equal(directed.run.qualityReport.faceSafety.status, 'unknown')
    assert.equal(directed.run.qualityReport.hardChecks.subtitlesFaceSafe, false)
    const projectVersionHash = directed.version.baseHash

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
    await runDashboardRuntimeJourney({ client, baseUrl, authorization, workspaceId, projectId,
      projectVersionId, projectVersionHash, directed, actor, sourceArtifactId, sourceManifestId,
      sourceSha256, sourceByteSize: sourceBytes.length, sourceManifest, sourcePath, artifactRoot,
      sourceColorProbe: colorProbe,
      mechanicalSeed: { transcript, brief: snapshots[0][3], policies: snapshots[1][3], createdAt: createdAt.toISOString() },
      uiUsername, uiPassword, suffix, signal: t.signal })
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
