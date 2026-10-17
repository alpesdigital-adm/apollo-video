import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { dirname, isAbsolute, join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { assertDashboardCftBuildBindings, createDashboardRuntimePreparationForTest, prepareDashboardRuntimeJourney, runDashboardRuntimeJourney } from './helpers/dashboard-runtime-journey.mjs'
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
  let runtimePreparation
  try {
    runtimePreparation = await prepareDashboardRuntimeJourney({ signal: t.signal })
    t.diagnostic(JSON.stringify({ kind: 'dashboard-runtime-preparation', ...runtimePreparation.evidence }))
  } catch (error) {
    try { if (error.dashboardRuntimePreparation) t.diagnostic(JSON.stringify({ kind: 'dashboard-runtime-preparation', ...error.dashboardRuntimePreparation })) } catch { /* Original preparation failure remains primary. */ }
    throw error
  }
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
  let journeyPrimaryError
  const httpDiagnosticsEnabled = process.env.APOLLO_DASHBOARD_HTTP_CONNECTION_DIAGNOSTICS === '1'
  let httpDiagnosticsModule, httpClient, httpServerReader, httpModuleFact, httpSnapshotFailure
  let httpDiagnosticGatePassed = null
  const httpWorkspacePaths = new Set()
  const observeHttpConnections = () => {
    try {
      const clientFacts = httpClient?.snapshot() ?? null, serverFacts = httpServerReader?.snapshot() ?? null
      return { schemaVersion: 'dashboard-native-http-diagnostics/v1', scope: 'diagnostic-not-normal-journey-or-performance',
        runId: suffix, module: httpModuleFact ?? null, nodeVersion: process.versions.node, undiciVersion: process.versions.undici ?? null,
        client: clientFacts, server: serverFacts, selectedWorkspacePaths: [...httpWorkspacePaths],
        joins: clientFacts && serverFacts ? httpDiagnosticsModule.joinConnectionDiagnostics(clientFacts, serverFacts, [...httpWorkspacePaths]) : [],
        resetAuthorIdentified: false }
    } catch (error) {
      httpSnapshotFailure ??= error
      return { scope: 'diagnostic-not-normal-journey-or-performance', instrumentationFailed: true }
    }
  }
  const serverLifecycle = { schemaVersion: 'dashboard-owned-next-lifecycle/v1', runId: suffix,
    ownerPid: process.pid, pid: null, creationRequestedAt: null, spawnReturnedAt: null,
    spawnObservedAt: null, exitObservedAt: null, closeObservedAt: null, events: [] }
  const observeOwnedServer = () => ({ ...serverLifecycle, observedAt: Date.now(), monotonicMs: performance.now(),
    exitCode: server?.exitCode ?? null, signalCode: server?.signalCode ?? null,
    events: serverLifecycle.events.map((event) => ({ ...event })) })
  const serverEvent = (event, fields = {}) => serverLifecycle.events.push({ event, at: Date.now(),
    monotonicMs: performance.now(), ...fields })

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
    let httpPreload = []
    if (httpDiagnosticsEnabled) {
      assert.notEqual(process.env.APOLLO_DASHBOARD_CANCEL_DIAGNOSTICS, '1', 'Native connection diagnostics never enable cancellation hooks')
      assert.equal(process.env.APOLLO_DASHBOARD_HTTP_DIAGNOSTICS_PRELOAD, undefined, 'The test client cannot be a server preload')
      const modulePath = 'C:/Users/leand/Documents/Apollo/w61-70-20261008/dashboard-http-connection-diagnostics.mjs'
      assert.equal(process.env.APOLLO_DASHBOARD_HTTP_DIAGNOSTICS_MODULE_PATH, modulePath)
      const modulePin = process.env.APOLLO_DASHBOARD_HTTP_DIAGNOSTICS_MODULE_SHA256
      assert.match(modulePin ?? '', /^[a-f0-9]{64}$/)
      const authEnd = performance.now() + 5000
      const remaining = () => { const value = Math.floor(authEnd - performance.now()); assert.ok(value > 0, 'HTTP diagnostic source authentication deadline'); return value }
      remaining(); const before = await lstat(modulePath); remaining()
      assert.equal(before.isFile(), true); assert.equal(before.isSymbolicLink(), false); assert.ok(before.size > 0 && before.size <= 131072)
      assert.equal((await realpath(modulePath)).replaceAll('\\', '/'), modulePath); remaining()
      const bytes = await readFile(modulePath, { signal: AbortSignal.timeout(remaining()) }); remaining()
      assert.equal(bytes.length, before.size); assert.equal(sha256(bytes), modulePin)
      const after = await lstat(modulePath); remaining()
      assert.deepEqual([after.dev, after.ino, after.size, after.mtimeMs], [before.dev, before.ino, before.size, before.mtimeMs])
      httpDiagnosticsModule = await import(pathToFileURL(modulePath).href); remaining()
      httpModuleFact = { path: modulePath, sha256: modulePin, bytes: bytes.length }
      httpClient = httpDiagnosticsModule.createConnectionDiagnostics({ role: 'client', origin: baseUrl, runId: suffix })
      httpPreload = ['--import', pathToFileURL(modulePath).href]
    }
    t.signal.throwIfAborted()
    assert.ok(runtimePreparation.evidence.readyAt <= Date.now(), 'Dependency preparation must precede server creation')
    serverLifecycle.creationRequestedAt = Date.now()
    serverLifecycle.runtimePreparationReadyAt = runtimePreparation.evidence.readyAt
    server = spawn(process.execPath, [...httpPreload, 'node_modules/next/dist/bin/next', ...(process.env.APOLLO_DASHBOARD_RUNTIME_SERVER_MODE === 'dev' ? ['dev', '--webpack'] : ['start']), '-p', String(port)], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...(httpDiagnosticsEnabled ? { APOLLO_DASHBOARD_HTTP_DIAGNOSTICS_PRELOAD: '1',
          APOLLO_DASHBOARD_HTTP_DIAGNOSTICS_ORIGIN: baseUrl, APOLLO_DASHBOARD_HTTP_DIAGNOSTICS_RUN_ID: suffix } : {}),
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
    // These are observations of this ChildProcess; null exit fields alone do
    // not prove liveness, and creationRequestedAt is not an OS creation time.
    serverLifecycle.pid = server.pid ?? null; serverLifecycle.spawnReturnedAt = Date.now()
    serverEvent('spawn-returned', { pid: serverLifecycle.pid })
    server.once('spawn', () => {
      serverLifecycle.spawnObservedAt = Date.now(); serverEvent('spawn', { pid: server.pid })
    })
    server.once('exit', (code, signal) => {
      serverLifecycle.exitObservedAt = Date.now(); serverEvent('exit', { code, signal })
    })
    server.once('close', (code, signal) => {
      serverLifecycle.closeObservedAt = Date.now(); serverEvent('close', { code, signal })
    })
    server.once('error', (error) => {
      const message = String(error.message ?? '')
      serverEvent('error', { code: /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code ?? '') ? error.code : null,
        messageSha256: sha256(message), messageBytes: Buffer.byteLength(message) })
    })
    if (httpDiagnosticsEnabled) httpServerReader = httpDiagnosticsModule.createServerDiagnosticReader({ runId: suffix, pid: server.pid })
    server.stdout.on('data', (chunk) => { httpServerReader?.feed(chunk); serverLogs += String(chunk); process.stdout.write(chunk) })
    if (httpDiagnosticsEnabled) {
      server.stdout.once('end', () => httpServerReader.end())
      server.stdout.once('close', () => httpServerReader.close())
    }
    server.stderr.on('data', (chunk) => { serverLogs += String(chunk); process.stderr.write(chunk) })
    try { await waitForServer(baseUrl, server) } catch (error) { throw new Error(`${error.message}\n${serverLogs}`, { cause: error }) }
    if (httpDiagnosticsEnabled) httpClient.assertHealthy()
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
    await runDashboardRuntimeJourney({ client, baseUrl, authorization, workspaceId, projectId, runtimePreparation,
      projectVersionId, projectVersionHash, directed, actor, sourceArtifactId, sourceManifestId,
      sourceSha256, sourceByteSize: sourceBytes.length, sourceManifest, sourcePath, artifactRoot,
      sourceColorProbe: colorProbe,
      mechanicalSeed: { transcript, brief: snapshots[0][3], policies: snapshots[1][3], createdAt: createdAt.toISOString() },
      uiUsername, uiPassword, suffix, signal: t.signal, observeOwnedServer,
      ...(httpDiagnosticsEnabled ? { observeHttpConnections,
        selectHttpWorkspacePath: (path) => httpWorkspacePaths.add(path) } : {}) })
  } catch (error) {
    journeyPrimaryError = error
    throw error
  } finally {
    const cleanupErrors = []
    const cleanupStage = async (stage, action) => {
      try { await action(); return true } catch (error) {
        cleanupErrors.push({ stage, error }); return false
      }
    }
    const evidenceRoot = process.env.APOLLO_DASHBOARD_RUNTIME_EVIDENCE_ROOT
    await cleanupStage('next-log-write', async () => {
      if (evidenceRoot) {
        await mkdir(evidenceRoot, { recursive: true })
        await writeFile(join(evidenceRoot, 'owned-next.log'), serverLogs)
      }
    })
    const serverTerminal = await cleanupStage('next-containment', async () => {
      const containmentEnd = performance.now() + 10000
      if (server && server.exitCode === null) {
        server.kill()
        await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))])
        if (server.exitCode === null && server.signalCode === null) {
          server.kill('SIGKILL')
          await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))])
        }
      }
      assert.ok(!server || server.exitCode !== null || server.signalCode !== null, 'Owned export Next server must terminate')
      if (httpDiagnosticsEnabled && server && serverLifecycle.closeObservedAt === null) {
        const remaining = Math.floor(containmentEnd - performance.now())
        assert.ok(remaining > 0, 'Owned Next close was not observed within the existing containment budget')
        let timer
        try { await Promise.race([once(server, 'close'), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Owned Next close remains inconclusive')), remaining)
        })]) } finally { clearTimeout(timer) }
      }
      if (httpDiagnosticsEnabled && server) assert.ok(serverLifecycle.closeObservedAt !== null, 'Owned Next child close must be observed')
    })
    if (httpDiagnosticsEnabled) {
      await cleanupStage('http-client-unsubscribe', () => { httpClient?.close() })
      httpDiagnosticGatePassed = await cleanupStage('http-diagnostics-gate', () => {
        if (httpSnapshotFailure) throw httpSnapshotFailure
        if (httpClient) httpClient.assertHealthy()
        if (httpServerReader) httpServerReader.assertHealthy()
        const snapshot = observeHttpConnections()
        if (httpSnapshotFailure) throw httpSnapshotFailure
        for (const path of httpWorkspacePaths) assert.ok(snapshot.client.events.some((event) =>
          event.event === 'request-create' && event.data.path === path && event.data.method === 'GET'), 'Workspace GET diagnostics missing')
      })
    }
    // Either disconnect must still run after an evidence/containment failure.
    const disconnects = await Promise.allSettled([
      (async () => {
        const { disconnectV2PostgresClient } = await import('../../src/v2/infrastructure/prisma-postgres/client.ts')
        await disconnectV2PostgresClient()
      })(),
      (async () => { await client.$disconnect() })(),
    ])
    disconnects.forEach((result, index) => {
      if (result.status === 'rejected') cleanupErrors.push({ stage: index === 0 ? 'app-client-disconnect' : 'fixture-client-disconnect', error: result.reason })
    })
    if (httpDiagnosticsEnabled) await cleanupStage('http-diagnostics-write', async () => {
      if (evidenceRoot) {
        await writeFile(join(evidenceRoot, 'dashboard-http-connections.json'), JSON.stringify({ ...observeHttpConnections(),
          ownedServer: observeOwnedServer(), primaryJourneyFailurePreserved: journeyPrimaryError !== undefined,
          containmentObserved: serverTerminal, diagnosticGatePassed: httpDiagnosticGatePassed,
          disconnects: disconnects.map((result) => result.status) }, null, 2))
        // Archive after actual child-close/stdout end+close checks and both
        // disconnect attempts, before artifact scratch removal.
        await writeFile(join(evidenceRoot, 'owned-next.log'), serverLogs)
      }
    })
    if (serverTerminal && disconnects.every((result) => result.status === 'fulfilled')) {
      await cleanupStage('artifact-scratch-remove', () => rm(join(artifactRoot, `workspaces/final-export-e2e-${suffix}`), { recursive: true, force: true }))
    }
    const errorDiagnostics = () => cleanupErrors.map(({ stage, error }) => {
      const message = String(error?.message ?? '')
      return { stage, messageSha256: sha256(message), messageBytes: Buffer.byteLength(message) }
    })
    await cleanupStage('next-lifecycle-write', async () => {
      if (evidenceRoot) {
        await mkdir(evidenceRoot, { recursive: true })
        await writeFile(join(evidenceRoot, 'owned-next-lifecycle.json'), JSON.stringify({ ...observeOwnedServer(),
          cleanupErrors: errorDiagnostics(), disconnects: disconnects.map((result) => result.status) }, null, 2))
      }
    })
    if (cleanupErrors.length) {
      process.stderr.write(`${JSON.stringify({ kind: 'dashboard-cleanup-failed', errors: errorDiagnostics(),
        originalJourneyFailurePreserved: journeyPrimaryError !== undefined })}\n`)
      if (!journeyPrimaryError) throw cleanupErrors[0].error
    }
  }
})

function controlledPreparationBindings(onInvoke = () => assert.fail('Preparation must not invoke a runtime binding')) {
  return Object.fromEntries(['PrismaPublicOperationRepository', 'createProjectProxyRenderWorker', 'createColorPipelineCompilationRepository',
    'PrismaProjectProxyRenderRepository', 'PrismaProjectFinalExportRepository', 'PrismaAssetRightsRepository',
    'enqueueProjectFinalExportService', 'calculateVersionHash', 'stableSerialize', 'createProtectedPayloadCipherFromEnvironment',
    'probeVideo', 'resolveFfmpegBinary', 'parseCreateColorPipelineCompilationBody', 'setProjectLutSelectionService',
    'PrismaProjectLutSelectionRepository'].map((name) => [name, onInvoke]).concat([['chromium', { launchServer: onInvoke }]]))
}

test('dashboard runtime preparation is complete and cached before resource admission; DI cannot admit the real journey', async (t) => {
  const order = [], loaded = controlledPreparationBindings()
  const prepare = createDashboardRuntimePreparationForTest(async (specifier) => { order.push(specifier); return loaded })
  const prepared = await prepare({ signal: t.signal })
  order.push('resources-admitted')
  assert.equal(order.length, 15)
  assert.equal(order[0], '../../../src/v2/infrastructure/prisma/public-operation-repository.ts')
  assert.equal(order[1], '../../../src/v2/infrastructure/repository-factory.ts')
  assert.equal(order[10], 'playwright-core')
  assert.equal(order[13], '../../../src/v2/infrastructure/prisma/project-lut-selection-repository.ts')
  assert.equal(prepared.evidence.modules.length, 14)
  assert.equal(prepared.evidence.status, 'ready')
  assert.equal(prepared.evidence.nativeImportCancellationClaimed, false)
  assert.equal(prepared.evidence.resetCauseEstablished, false)
  assert.ok(prepared.evidence.elapsedMs >= 0)
  for (const [index, module] of prepared.evidence.modules.entries()) {
    assert.ok(module.completedAt >= module.startedAt && module.elapsedMs >= 0)
    if (index) assert.ok(module.startedAt >= prepared.evidence.modules[index - 1].completedAt)
  }
  assert.strictEqual(await prepare({ signal: t.signal }), prepared)
  assert.equal(order.length, 15, 'A cached preparation does not import again')
  await assert.rejects(runDashboardRuntimeJourney({ runtimePreparation: prepared }), /Runtime dependencies must be prepared/)
  await assert.rejects(runDashboardRuntimeJourney({ runtimePreparation: {} }), /Runtime dependencies must be prepared/)
})

test('dashboard runtime preparation failure preserves the primary error and never publishes or retries partial bindings', async (t) => {
  const primary = new Error('controlled import failure'), order = [], loaded = controlledPreparationBindings()
  const prepare = createDashboardRuntimePreparationForTest(async (specifier) => {
    order.push(specifier)
    if (order.length === 3) throw primary
    return loaded
  })
  await assert.rejects(prepare({ signal: t.signal }), (error) => error === primary)
  assert.equal(primary.dashboardRuntimePreparation.status, 'failed')
  assert.equal(primary.dashboardRuntimePreparation.moduleId, 'proxy-repository')
  assert.equal(primary.dashboardRuntimePreparation.modules.length, 2)
  await assert.rejects(prepare({ signal: t.signal }), (error) => error === primary)
  assert.equal(order.length, 3)
})

test('dashboard runtime preparation observes abort before importing and after a late import without publishing readiness', async () => {
  const early = new AbortController(), earlyReason = new Error('controlled early abort')
  early.abort(earlyReason)
  let calls = 0
  const earlyPrepare = createDashboardRuntimePreparationForTest(async () => { calls++; return controlledPreparationBindings() })
  await assert.rejects(earlyPrepare({ signal: early.signal }), (error) => error === earlyReason)
  assert.equal(calls, 0)
  const late = new AbortController(), lateReason = new Error('controlled abort during import')
  const latePrepare = createDashboardRuntimePreparationForTest(async () => {
    calls++; late.abort(lateReason); return controlledPreparationBindings()
  })
  await assert.rejects(latePrepare({ signal: late.signal }), (error) => error === lateReason)
  assert.equal(calls, 1)
  assert.equal(lateReason.dashboardRuntimePreparation.status, 'failed')
  assert.equal(lateReason.dashboardRuntimePreparation.stage, 'import-return')
  assert.equal(lateReason.dashboardRuntimePreparation.modules.length, 0)
})

test('dashboard runtime preparation rejects an incomplete imported binding before resource admission', async (t) => {
  let calls = 0
  const prepare = createDashboardRuntimePreparationForTest(async () => { calls++; return {} })
  await assert.rejects(prepare({ signal: t.signal }), /Prepared PrismaPublicOperationRepository binding is incomplete/)
  assert.equal(calls, 1)
})

test('dashboard CfT build bindings admit fresh authenticated layouts and reject source/bundle/CDP/helper authority mismatches', () => {
  // Controlled representations of the IO facts consumed by the semantic gate.
  // This unit does not authenticate raw files, an owner freeze or a browser.
  const base = 'C:/Users/leand/Documents/Apollo/w61-70-20261008'
  const sourceHead = '9'.repeat(40), buildCommit = 'a'.repeat(40), bundlePin = 'b'.repeat(64)
  const helper = { path: 'C:/Users/leand/.codex/worktrees/w61-ci-observer/apollo-video/tests/v2/helpers/dashboard-runtime-journey.mjs', bytes: 12345, sha256: 'c'.repeat(64) }
  const bundle = { schemaVersion: 1, sourceCommit: buildCommit, buildRunId: 'build-shell-95b4-v1-f2a493ed',
    root: 'C:/Users/leand/.codex/worktrees/w61-70-integration/apollo-video',
    files: [{ path: '.next/static/chunks/fixture.js', bytes: 4, sha256: 'd'.repeat(64) }], fileCount: 1, totalBytes: 4 }
  const bundlePath = `${base}/${bundle.buildRunId}/bundle-manifest.json`
  const facts = { sourceHead, helper, bundlePin, bundlePath, bundle, cdpManifest: structuredClone(bundle),
    config: { sourceHead, buildSourceCommit: buildCommit, bundleManifestPath: bundlePath, bundleManifestSha256: bundlePin },
    freeze: { schemaVersion: 'dashboard-cft157-freeze/v1', sourceHead, files: [structuredClone(helper)] } }
  assert.notEqual(sourceHead, buildCommit, 'Build provenance need not equal the test source commit')
  assert.doesNotThrow(() => assertDashboardCftBuildBindings(facts))
  const mutations = [
    (value) => { value.config.sourceHead = '8'.repeat(40) },
    (value) => { value.config.buildSourceCommit = '8'.repeat(40) },
    (value) => { value.sourceHead = 'short' },
    (value) => { value.config.bundleManifestSha256 = 'e'.repeat(64) },
    (value) => { value.bundlePin = undefined },
    (value) => { value.cdpManifest.sourceCommit = '8'.repeat(40) },
    (value) => { value.cdpManifest.files[0].sha256 = 'e'.repeat(64) },
    (value) => { value.bundle.root = 'C:/arbitrary'; value.cdpManifest.root = value.bundle.root },
    (value) => { value.bundle.buildRunId = 'other-build'; value.cdpManifest.buildRunId = value.bundle.buildRunId },
    (value) => { value.freeze.sourceHead = '8'.repeat(40) },
    (value) => { value.freeze.files = [] },
    (value) => { value.freeze.files.push(structuredClone(value.freeze.files[0])) },
    (value) => { value.freeze.files[0].sha256 = 'e'.repeat(64) },
    (value) => { value.freeze.files[0].bytes += 1 },
    (value) => { value.freeze.files[0].path += '.other' },
  ]
  for (const mutate of mutations) {
    const invalid = structuredClone(facts); mutate(invalid)
    assert.throws(() => assertDashboardCftBuildBindings(invalid))
  }
  for (const path of [`${base}/../outside/bundle-manifest.json`, `${base}/build/child/bundle-manifest.json`,
    `${base}/build/bundle-manifest-v2.json`, `${base}/build\\escape/bundle-manifest.json`,
    `${base}/build/bundle-manifest.json?query`, 'C:/arbitrary/bundle-manifest.json']) {
    const invalid = structuredClone(facts)
    invalid.config.bundleManifestPath = path; invalid.bundlePath = path
    assert.throws(() => assertDashboardCftBuildBindings(invalid))
  }
})
