import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { createApiAccessAuditContext } from '../../src/v2/domain/api-access-control.ts'
import { enqueuePerceptionProducerRunService } from '../../src/v2/application/enqueue-perception-producer-run.ts'
import { putPerceptionTimelineService } from '../../src/v2/application/perception-timelines.ts'
import { runProjectDirectorService } from '../../src/v2/application/run-project-director.ts'
import { createProductionBrief } from '../../src/v2/domain/production-brief.ts'
import { createMediaTranscript } from '../../src/v2/domain/media-transcript.ts'
import { PERCEPTION_KINDS } from '../../src/v2/domain/perception-timeline.ts'
import { calculateCanonicalHash, stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { createEvidenceBoundBriefCompiler } from '../../src/v2/infrastructure/brief/evidence-bound-brief-compiler-model.ts'
import { createMediaArtifactManifestV2 } from '../../src/v2/domain/media-artifact.ts'
import { advancePublicOperationPhase, cancelPublicOperation, createQueuedPublicOperation, startPublicOperationAttempt,
} from '../../src/v2/domain/public-operation.ts'
import { EDITORIAL_PROXY_RECIPE_VERSION } from '../../src/v2/application/ports/editorial-proxy-renderer.ts'
import { calculateProxyReviewHash, evaluateRenderedProxy } from '../../src/v2/application/render-workflow.ts'
import { PrismaDirectorRunRepository } from '../../src/v2/infrastructure/prisma/director-run-repository.ts'
import { PrismaPerceptionProducerRequestContextRepository } from '../../src/v2/infrastructure/prisma/perception-producer-request-context-repository.ts'
import { PrismaPerceptionTimelineRepository } from '../../src/v2/infrastructure/prisma/perception-timeline-repository.ts'
import { hydratePublicOperationRecord, PrismaPublicOperationRepository } from '../../src/v2/infrastructure/prisma/public-operation-repository.ts'
import { PrismaProjectProxyRenderRepository } from '../../src/v2/infrastructure/prisma/project-proxy-render-repository.ts'
import { PrismaAutomaticCatalogRepository } from '../../src/v2/infrastructure/prisma/automatic-catalog-repository.ts'
import { externalActorAuditData } from '../../src/v2/infrastructure/prisma/external-actor-audit.ts'
import { expectedOcrTimeline } from '../../src/v2/domain/projected-ocr-timeline.ts'
import { calculateVersionHash } from '../../src/v2/application/version-hash.ts'
import { seedPerceptionProducerContext } from './helpers/perception-producer-pg-world.mjs'

const exec = promisify(execFile)
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

// Controlled repository-gate fixture. It models a leased worker at the persistence
// phase using domain transitions; no FFmpeg render is claimed by this row.
function controlledRunningProxyOperation({ id, workspaceId, projectId, clientId,
  artifactId, manifestId, now }) {
  const at = (offset) => new Date(now + offset).toISOString()
  const queued = createQueuedPublicOperation({ id, workspaceId, projectId, clientId,
    type: 'project-proxy-render', target: { type: 'media-artifact', id: artifactId, manifestId },
    createdAt: at(-4_000) })
  const started = startPublicOperationAttempt(queued, at(-3_000))
  const rendering = advancePublicOperationPhase(started, 'rendering', at(-2_500))
  const verifying = advancePublicOperationPhase(rendering, 'verifying', at(-2_000))
  const persisting = advancePublicOperationPhase(verifying, 'persisting', at(-1_500))
  return persisting
}

function assertControlledProxyRowHydrates(operationData, detailData, auditHash) {
  const hydrated = hydratePublicOperationRecord({
    ...operationData, projectProxyRender: { ...detailData,
      renderablePlanHash: null, renderablePlanId: null, renderableOrigin: null,
      renderableSourceId: null, renderableSourceHash: null,
      renderableVariantId: null, renderableFormat: null,
      reusedFromOperationId: null, reuseCommandId: null,
      reuseImpactHash: null, reuseBaseVersionId: null },
    artifactRender: null, mediaIngest: null, syntheticProductionRender: null,
    projectFinalExport: null, sourceCleanupPlan: null, longFormIndexWorkflow: null,
    projectDirectorRun: null, perceptionProducerOperation: null,
    temporalProducerOperation: null, faceProducerOperation: null,
    resultJson: null, errorCode: null, errorMessage: null, errorRetryable: null,
    completedAt: null, nextAttemptAt: null, deadLetteredAt: null, traceId: null,
    delegatedUserId: null, delegatedIdentityId: null, workspaceRole: null,
  })
  assert.equal(hydrated.context.kind, 'project-proxy-render')
  assert.equal(hydrated.authenticationAudit.contextHash, auditHash)
}

// The controller holds the operation row until both independent clients are
// observed waiting on PostgreSQL's lock. The short polling interval observes
// the latch; it does not choose which contender wins. Every path releases the
// transaction and disconnects the clients in the caller's finally block.
async function raceAtOperationLock({ controller, operationId, attachName,
  cancelName, attach, cancel, orderedFirst }) {
  let readyResolve, readyReject, waitingResolve, waitingReject, firstResolve, firstReject, release
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const waiting = new Promise((resolve, reject) => { waitingResolve = resolve; waitingReject = reject })
  const firstWaiting = orderedFirst && new Promise((resolve, reject) => {
    firstResolve = resolve; firstReject = reject
  })
  firstWaiting?.catch(() => {})
  const released = new Promise((resolve) => { release = resolve })
  const latch = controller.$transaction(async (tx) => {
    const locked = await tx.$queryRaw`SELECT id FROM public_operations
      WHERE id = ${operationId} FOR UPDATE`
    assert.equal(locked.length, 1, 'the latch must lock its exact operation row')
    readyResolve()
    const deadline = Date.now() + 3_000
    while (Date.now() < deadline) {
      await tx.$queryRaw`SELECT pg_stat_clear_snapshot() IS NULL AS cleared`
      const rows = await tx.$queryRaw`SELECT application_name AS name,
        wait_event_type AS "waitType" FROM pg_stat_activity
        WHERE application_name IN (${attachName}, ${cancelName})`
      const blocked = new Set(rows.filter((row) => row.waitType === 'Lock').map((row) => row.name))
      if (orderedFirst && blocked.has(orderedFirst === 'cancel' ? cancelName : attachName)) {
        firstResolve()
      }
      if (blocked.has(attachName) && blocked.has(cancelName)) {
        waitingResolve()
        await released
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error('W65 lock latch did not observe both contenders before its deadline')
  }, { timeout: 8_000 }).catch((error) => {
    readyReject(error)
    waitingReject(error)
    firstReject?.(error)
    throw error
  })
  try { await ready } catch (error) { await latch.catch(() => {}); throw error }
  const settled = (promise) => promise.then((value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason }))
  let attachResult, cancelResult
  let latchError = null
  try {
    if (orderedFirst === 'cancel') {
      cancelResult = settled(cancel())
      await firstWaiting
      attachResult = settled(attach())
    } else if (orderedFirst === 'attach') {
      attachResult = settled(attach())
      await firstWaiting
      cancelResult = settled(cancel())
    } else {
      attachResult = settled(attach())
      cancelResult = settled(cancel())
    }
    await waiting
  } catch (error) { latchError = error } finally { release() }
  try { await latch } catch (error) { latchError ??= error }
  const [attached, canceled] = await Promise.all([attachResult, cancelResult])
  if (latchError) throw latchError
  return { attach: attached, cancel: canceled }
}

function isolatedDbEndpoint(suffix) {
  const url = new URL(process.env.V2_DATABASE_URL)
  const runName = url.searchParams.get('application_name')
  assert.ok(runName?.startsWith('apollo-video-e2e-'),
    'the race must remain inside the supervised E2E application_name')
  const applicationName = `${runName}-${suffix}`
  assert.ok(applicationName.length <= 63,
    'PostgreSQL must retain the full run identity and race contender name')
  url.searchParams.set('application_name', applicationName)
  url.searchParams.set('connection_limit', '1')
  return { url: url.toString(), applicationName }
}

test('W65 controlled proxy fixture hydrates through the production operation parser before PostgreSQL', () => {
  const workspaceId = 'w65-offline-workspace', projectId = 'w65-offline-project'
  const clientId = 'w65-offline-client', artifactId = 'w65-offline-artifact'
  const operationId = 'w65-offline-operation', manifestId = 'w65-offline-manifest'
  const operation = controlledRunningProxyOperation({ id: operationId, workspaceId,
    projectId, clientId, artifactId, manifestId, now: Date.now() })
  const audit = createApiAccessAuditContext({ clientId, workspaceId,
    credentialId: 'w65-offline-credential', environment: 'production', authenticationKind: 'bearer' })
  assertControlledProxyRowHydrates({ id: operationId, workspaceId, projectId, clientId,
    ...externalActorAuditData(audit, workspaceId, clientId),
    type: operation.type, status: operation.status, phase: operation.phase,
    targetType: operation.target.type, targetId: operation.target.id,
    progressCompleted: operation.progress.completed, progressTotal: operation.progress.total,
    progressUnit: operation.progress.unit, cancelable: operation.cancelable,
    retryable: operation.retryable, attempt: operation.attempt, maxAttempts: operation.maxAttempts,
    createdAt: new Date(operation.createdAt), startedAt: new Date(operation.startedAt),
    updatedAt: new Date(operation.updatedAt), leaseOwner: 'w65-offline-worker',
    heartbeatAt: new Date(operation.updatedAt), leaseExpiresAt: new Date(Date.now() + 120_000),
  }, { operationId, workspaceId, projectId, projectVersionId: 'w65-offline-version',
    editPlanSnapshotId: 'w65-offline-edit', sourceArtifactId: 'w65-offline-source',
    sourceManifestId: 'w65-offline-source-manifest', outputArtifactId: artifactId,
    outputManifestId: manifestId, originalFileName: 'controlled.mp4',
    inputHash: 'a'.repeat(64), colorPipelineBindingsJson: stableSerialize([{
      sourceArtifactId: 'w65-offline-source', sourceManifestId: 'w65-offline-source-manifest',
      compilationId: 'w65-offline-color', compilationHash: 'b'.repeat(64),
      pipelineHash: 'c'.repeat(64),
    }]) }, audit.contextHash)
})

async function stopRunner(child) {
  if (!child) return
  if (!Number.isSafeInteger(child.pid)) return
  if (child.exitCode === null && child.signalCode === null) {
    const closed = new Promise((resolve) => child.once('close', resolve))
    child.kill('SIGTERM')
    const graceful = await Promise.race([closed.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 10_000))])
    if (!graceful) {
      child.kill('SIGKILL')
      assert.equal(await Promise.race([closed.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 5_000))]), true,
      'OCR runner did not terminate')
    }
  }
  assert.throws(() => process.kill(child.pid, 0), /ESRCH|not found/i)
  if (process.platform === 'win32') {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${child.pid}" | Select-Object -ExpandProperty ProcessId`],
    { windowsHide: true, timeout: 10_000 })
    assert.equal(stdout.trim(), '', 'OCR runner descendants remain after shutdown')
  }
}

test('W64 PostgreSQL Director consumes a sealed OCR run, persists scoped refs and keeps face review required',
  { skip: !process.env.V2_DATABASE_URL || !process.env.APOLLO_OCR_FFMPEG ||
      !process.env.APOLLO_OCR_FFPROBE || !process.env.APOLLO_OCR_TESSERACT ||
      !process.env.APOLLO_OCR_TESSDATA,
    timeout: 180_000 }, async () => {
    const db = new PrismaClient({ datasources: { db: {
      url: isolatedDbEndpoint('main').url,
    } } })
    const root = await mkdtemp(join(tmpdir(), 'apollo-w64-director-ocr-'))
    let runner
    let cleanupScope
    let primaryError
    try {
      const suffix = randomUUID().slice(0, 8)
      const workspaceId = `w61-admission-${suffix}`
      const artifactKey = `${workspaceId}/source.mp4`
      const artifactPath = join(root, artifactKey)
      await mkdir(join(root, workspaceId), { recursive: true })
      const imagePath = join(root, 'text.png')
      const { default: sharp } = await import('sharp')
      await sharp(Buffer.from('<svg width="640" height="360" xmlns="http://www.w3.org/2000/svg"><rect width="640" height="360" fill="white"/><text x="50" y="200" font-size="100" font-family="Arial" font-weight="bold" fill="black">APOLLO</text></svg>'))
        .png().toFile(imagePath)
      await exec(process.env.APOLLO_OCR_FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
        '-loop', '1', '-framerate', '30', '-t', '4', '-i', imagePath,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', artifactPath],
      { windowsHide: true, timeout: 30_000 })
      const bytes = await readFile(artifactPath)
      const world = await seedPerceptionProducerContext(db, { suffix, artifactKey,
        sourceSha256: sha(bytes), byteSize: BigInt(bytes.length) })
      cleanupScope = { workspaceId, clientId: world.clientId, suffix }
      const manifestId = `w64-manifest-${suffix}`
      await db.v2MediaArtifactManifest.create({ data: { id: manifestId,
        workspaceId, artifactId: world.sourceId, schemaVersion: 'media-artifact-manifest/v2',
        manifestHash: sha(Buffer.from(`manifest-${suffix}`)), recipeId: 'w64-controlled-source',
        recipeVersion: '1.0.0', parametersHash: sha(Buffer.from(`parameters-${suffix}`)),
        manifestJson: stableSerialize({ artifact: { artifactKey },
          probe: { width: 640, height: 360, duration: 4, fps: 30 } }) } })
      const transcriptId = `w64-transcript-${suffix}`
      const transcript = createMediaTranscript({ language: 'pt-BR',
        text: 'Bem vindo ao Apollo', provider: 'groq', model: 'whisper-large-v3',
        words: [
          { word: 'Bem', start: 0.2, end: 0.5 },
          { word: 'vindo', start: 0.5, end: 0.9 },
          { word: 'ao', start: 0.9, end: 1.1 },
          { word: 'Apollo', start: 1.1, end: 1.7 },
        ],
        segments: [{ id: 0, start: 0.2, end: 1.7, text: 'Bem vindo ao Apollo' }] })
      await db.v2MediaTranscript.create({ data: { id: transcriptId, workspaceId,
        projectId: world.projectId, sourceArtifactId: world.sourceId, sourceManifestId: manifestId,
        schemaVersion: transcript.schemaVersion, language: transcript.language,
        provider: transcript.provider, model: transcript.model, providerVersion: 'controlled-v1',
        transcriptHash: transcript.transcriptHash, transcriptJson: stableSerialize(transcript) } })
      const brief = { schemaVersion: 1, objective: 'discovery',
        desiredAction: { schemaVersion: 1, kind: 'continue-viewing', disclosures: [] },
        outputSpec: { schemaVersion: 1, id: `w64-output-${suffix}`, locale: 'pt-BR',
          aspectRatio: '9:16', width: 1080, height: 1920, fps: 30,
          safeArea: { top: 0.05, right: 0.05, bottom: 0.08, left: 0.05 } },
        productionBrief: createProductionBrief({ ownerText: 'Público: equipes criativas. Tom: direto e natural.' }),
        createdAt: new Date().toISOString() }
      const policies = { schemaVersion: 1, state: 'configured', guardrails: [],
        createdAt: new Date().toISOString() }
      const plan = { ...world.plan, sources: [{ id: world.sourceId, artifactId: world.sourceId,
        kind: 'video', durationSeconds: 4 }], overlayTracks: [], subtitleTracks: [],
        audioTracks: [], effectTracks: [], markers: [], transitions: [], protectedElements: [],
        localeVariantRefs: [], formatVariantRefs: [], lineageRefs: [world.sourceId],
        editorial: { commandType: 'remove-spoken-content', exclusions: [],
          retainedSourceRanges: [{ sourceStartSeconds: 0, sourceEndSeconds: 4 }] },
        subtitlePolicy: { faceProtection: true, anchor: 'bottom', maxCharactersPerBlock: 32 },
        retimedTranscript: { sourceTranscriptId: transcriptId, sourceTranscriptHash: transcript.transcriptHash,
          words: [
            { text: 'Bem', sourceStartSeconds: 0.2, sourceEndSeconds: 0.5,
              timelineStartFrame: 6, timelineEndFrame: 15 },
            { text: 'vindo', sourceStartSeconds: 0.5, sourceEndSeconds: 0.9,
              timelineStartFrame: 15, timelineEndFrame: 27 },
            { text: 'ao', sourceStartSeconds: 0.9, sourceEndSeconds: 1.1,
              timelineStartFrame: 27, timelineEndFrame: 33 },
            { text: 'Apollo', sourceStartSeconds: 1.1, sourceEndSeconds: 1.7,
              timelineStartFrame: 33, timelineEndFrame: 51 },
          ] }, createdAt: new Date().toISOString() }
      for (const [id, content, schemaVersion] of [
        [`w61-brief-${suffix}`, brief, 1], [`w61-policy-${suffix}`, policies, 1],
        [world.editId, plan, 2],
      ]) await db.v2ProjectSnapshot.update({ where: { id },
        data: { contentJson: stableSerialize(content), contentHash: calculateCanonicalHash(content),
          schemaVersion } })
      const actorContext = createExternalAuditContext({ clientId: world.clientId,
        credentialId: `w64-credential-${suffix}`, workspaceId, environment: 'production' })
      const actor = { ...actorContext, scopes: new Set(['projects:write']),
        authenticationKind: 'bearer', clientKillSwitchEngaged: false,
        workspaceKillSwitchEngaged: false, clientAccessStatus: 'active',
        workspaceAccessStatus: 'active', auditContext: actorContext }
      const manuallyPut = await putPerceptionTimelineService({
        repository: new PrismaPerceptionTimelineRepository(db), clock: () => new Date(),
        createId: () => `w64-manual-perception-${suffix}`,
      })({ workspaceId, projectId: world.projectId, projectVersionId: world.versionId,
        baseRevision: null, durationMs: 4000, actor,
        observations: [{ id: 'caller-ocr-1', kind: 'ocr', startMs: 0, endMs: 500,
          value: { text: 'Caller claim' },
          provenance: { source: 'caller', model: 'caller', version: 'v1', confidence: 0.99 } }],
        coverage: PERCEPTION_KINDS.map((kind) => ({ kind,
          ranges: kind === 'ocr' ? [[0, 500]] : [] })),
        idempotencyKey: `w64-manual-${suffix}` })
      assert.equal(manuallyPut.timeline.origin.trust, 'unverified')
      const director = new PrismaDirectorRunRepository(db)
      assert.equal((await director.readContext({ workspaceId, projectId: world.projectId })).ocrEnvelope,
        undefined, 'no server envelope must remain absent')
      const operations = new PrismaPublicOperationRepository(db)
      const queued = await enqueuePerceptionProducerRunService({
        context: new PrismaPerceptionProducerRequestContextRepository(db), operations,
        createOperationId: () => `w64-operation-${randomUUID()}`,
      })({ workspaceId, projectId: world.projectId, projectVersionId: world.versionId,
        sourceArtifactId: world.sourceId, sampleIntervalFrames: 60, actor,
        idempotencyKey: `w64-ocr-${suffix}` })
      const env = { ...process.env, APOLLO_V2_ARTIFACT_ROOT: root,
        APOLLO_V2_ARTIFACT_STORAGE_DRIVER: 'local',
        APOLLO_V2_OCR_FFMPEG_BIN: process.env.APOLLO_OCR_FFMPEG,
        APOLLO_V2_OCR_FFPROBE_BIN: process.env.APOLLO_OCR_FFPROBE,
        APOLLO_V2_OCR_TESSERACT_BIN: process.env.APOLLO_OCR_TESSERACT,
        APOLLO_V2_OCR_TESSDATA_DIR: process.env.APOLLO_OCR_TESSDATA,
        APOLLO_V2_OCR_TESSDATA_LICENSE: join(process.env.APOLLO_OCR_TESSDATA, 'LICENSE'),
        APOLLO_V2_OCR_LANGUAGES: 'eng', APOLLO_V2_OCR_POLL_MS: '100' }
      runner = spawn(process.execPath, ['--import', 'tsx',
        'scripts/run-v2-perception-producer-worker.mjs'], { cwd: process.cwd(), env,
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const runnerState = { spawnError: null, closed: false }
      runner.once('error', (error) => { runnerState.spawnError = error })
      runner.once('close', () => { runnerState.closed = true })
      assert.ok(Number.isSafeInteger(runner.pid) && runner.pid > 0)
      let diagnostic = ''
      runner.stdout.on('data', (data) => { diagnostic = (diagnostic + data.toString()).slice(-4000) })
      runner.stderr.on('data', (data) => { diagnostic = (diagnostic + data.toString()).slice(-4000) })
      const deadline = Date.now() + 105_000
      let completed
      while (Date.now() < deadline) {
        if (runnerState.spawnError) throw runnerState.spawnError
        completed = await operations.findById(workspaceId, queued.operation.id)
        if (['succeeded', 'failed'].includes(completed?.operation.status)) break
        if (runnerState.closed || runner.exitCode !== null || runner.signalCode !== null) {
          throw new Error(`OCR runner stopped before terminal operation: ${diagnostic}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      assert.equal(completed?.operation.status, 'succeeded', diagnostic)
      const context = await director.readContext({ workspaceId, projectId: world.projectId })
      assert.equal(context.ocrEnvelope?.authority, 'server-produced')
      assert.equal(context.ocrEnvelope?.faceSafety, 'unknown')
      assert.equal(context.ocrEnvelope?.projectVersionId, world.versionId)
      const envelopeId = context.ocrEnvelope.id
      const envelopeHash = context.ocrEnvelope.envelopeHash
      const row = await db.v2PerceptionProducerEnvelope.findUniqueOrThrow({ where: { id: envelopeId } })
      await db.v2PerceptionProducerEnvelope.update({ where: { id: envelopeId },
        data: { envelopeHash: 'f'.repeat(64) } })
      await assert.rejects(director.readContext({ workspaceId, projectId: world.projectId }),
        /integrity|hash/i)
      await db.v2PerceptionProducerEnvelope.update({ where: { id: envelopeId },
        data: { envelopeHash } })
      await db.v2MediaArtifact.update({ where: { id: world.sourceId },
        data: { currentRightsSnapshotId: null, rightsRevision: 2 } })
      await assert.rejects(director.readContext({ workspaceId, projectId: world.projectId }),
        /rights|blocked/i)
      await db.v2MediaArtifact.update({ where: { id: world.sourceId },
        data: { currentRightsSnapshotId: world.rightsId, rightsRevision: 3 } })
      const counters = new Map()
      const run = runProjectDirectorService({ repository: director,
        clock: () => new Date(), createEventId: randomUUID,
        createId: (kind) => `${kind}-${suffix}-${counters.set(kind, (counters.get(kind) ?? 0) + 1).get(kind)}`,
        compileBrief: createEvidenceBoundBriefCompiler() })
      const request = { workspaceId, projectId: world.projectId,
        baseVersionId: world.versionId, baseHash: 'b'.repeat(64), actor,
        idempotency: { key: `w64-director-${suffix}` },
        reason: 'Plan source OCR as untrusted content with explicit review.' }
      const directed = await run(request)
      assert.equal(directed.run.perception.schemaVersion, 2)
      assert.equal(directed.run.perception.inputVersionId, world.versionId)
      assert.equal(directed.run.perception.ocrEvidence.envelopeId, envelopeId)
      assert.equal(directed.run.perception.ocrEvidence.envelopeHash, envelopeHash)
      assert.ok(directed.run.decisions.some((decision) => decision.evidenceRefs.includes(envelopeId)))
      assert.equal(directed.run.qualityReport.status, 'review-required')
      assert.equal(directed.run.qualityReport.faceSafety.status, 'unknown')
      assert.equal(directed.run.qualityReport.hardChecks.subtitlesFaceSafe, false)
      const proxy = new PrismaProjectProxyRenderRepository(db)
      const proxySource = await proxy.readCurrentSource({ workspaceId, projectId: world.projectId })
      assert.equal(proxySource?.trustedOcr?.envelopeId, envelopeId,
        'Result version may read only its Director input envelope with the same source map')
      assert.equal(proxySource.trustedOcr.inputVersionId, world.versionId)
      assert.equal(proxySource.trustedOcr.timeline.timelineHash,
        expectedOcrTimeline(context.ocrEnvelope, directed.run.editPlan.fps,
          directed.run.editPlan.durationFrames).timelineHash)
      await db.v2PerceptionProducerEnvelope.update({ where: { id: envelopeId },
        data: { envelopeHash: 'f'.repeat(64) } })
      await assert.rejects(proxy.readCurrentSource({ workspaceId, projectId: world.projectId }),
        /integrity|hash/i)
      await db.v2PerceptionProducerEnvelope.update({ where: { id: envelopeId },
        data: { envelopeHash } })
      await db.v2MediaArtifact.update({ where: { id: world.sourceId },
        data: { currentRightsSnapshotId: null, rightsRevision: 4 } })
      await assert.rejects(proxy.readCurrentSource({ workspaceId, projectId: world.projectId }),
        /rights|blocked/i)
      await db.v2MediaArtifact.update({ where: { id: world.sourceId },
        data: { currentRightsSnapshotId: world.rightsId, rightsRevision: 5 } })
      const directedEdit = await db.v2ProjectSnapshot.findUniqueOrThrow({
        where: { id: directed.version.snapshotRefs.editPlan } })
      const alteredEdit = JSON.parse(directedEdit.contentJson)
      alteredEdit.videoTracks.find((track) => track.kind === 'base-video').clips[0].sourceInFrame += 1
      await db.v2ProjectSnapshot.update({ where: { id: directedEdit.id },
        data: { contentJson: stableSerialize(alteredEdit), contentHash: calculateVersionHash(alteredEdit) } })
      assert.equal((await proxy.readCurrentSource({ workspaceId, projectId: world.projectId })).trustedOcr,
        undefined, 'A changed result time map cannot carry source-frame OCR coordinates')
      await db.v2ProjectSnapshot.update({ where: { id: directedEdit.id },
        data: { contentJson: directedEdit.contentJson, contentHash: directedEdit.contentHash } })
      // Controlled repository attachment: the receipt is bound to a sealed recipe, not a
      // fabricated facial approval or a claim that this output was actually rendered.
      const ocrReceipt = { envelopeId, envelopeHash, inputVersionId: world.versionId,
        timeMapHash: proxySource.trustedOcr.timeMapHash,
        timelineHash: proxySource.trustedOcr.timeline.timelineHash,
        sourceArtifactId: world.sourceId, sourceManifestId: manifestId,
        sourceSha256: world.sourceSha256, editPlanHash: directedEdit.contentHash }
      const outputArtifactId = `w65-proxy-output-${suffix}`
      const outputManifestId = `w65-proxy-manifest-${suffix}`
      const proxyOperationId = `w65-proxy-operation-${suffix}`
      const inputHash = sha(Buffer.from(`w65-proxy-input-${suffix}`))
      const recipeParameters = { ocrReceipt, inputHash, format: '9:16',
        projectVersionId: directed.version.id, editPlanSnapshotId: directedEdit.id }
      const outputManifest = createMediaArtifactManifestV2({
        artifactKey: `${workspaceId}/controlled-proxy.mp4`, artifactSha256: 'd'.repeat(64),
        byteSize: 1024, mediaType: 'video', container: 'mp4',
        recipe: { id: 'editorial-proxy', version: EDITORIAL_PROXY_RECIPE_VERSION,
          parameters: recipeParameters },
        sources: [{ artifactKey, sha256: world.sourceSha256, role: 'source-master',
          execution: { tool: { id: 'ffmpeg', version: 'static', digest: 'f'.repeat(64) } } }],
      })
      await db.v2MediaArtifact.create({ data: { id: outputArtifactId, workspaceId,
        artifactKey: `${workspaceId}/controlled-proxy.mp4`, sha256: 'd'.repeat(64),
        byteSize: 1024n, mediaType: 'video', container: 'mp4', status: 'available' } })
       await db.v2MediaArtifactManifest.create({ data: { id: outputManifestId, workspaceId,
         artifactId: outputArtifactId, schemaVersion: outputManifest.schemaVersion,
         manifestHash: outputManifest.manifestHash, recipeId: outputManifest.recipe.id,
         recipeVersion: outputManifest.recipe.version,
         parametersHash: outputManifest.recipe.parametersHash,
         manifestJson: stableSerialize(outputManifest) } })
       const controlledOperation = controlledRunningProxyOperation({
         id: proxyOperationId, workspaceId, projectId: world.projectId,
         clientId: world.clientId, artifactId: outputArtifactId,
         manifestId: outputManifestId, now: Date.now(),
       })
       const proxyAudit = createApiAccessAuditContext({ clientId: world.clientId,
         credentialId: `w65-proxy-credential-${suffix}`, workspaceId,
         environment: 'production', authenticationKind: 'bearer' })
       const operationData = { id: proxyOperationId, workspaceId,
         projectId: world.projectId, clientId: world.clientId,
         ...externalActorAuditData(proxyAudit, workspaceId, world.clientId),
         type: controlledOperation.type, status: controlledOperation.status,
         phase: controlledOperation.phase,
         targetType: 'media-artifact', targetId: outputArtifactId,
         progressCompleted: controlledOperation.progress.completed,
         progressTotal: controlledOperation.progress.total,
         progressUnit: controlledOperation.progress.unit,
         cancelable: controlledOperation.cancelable, retryable: controlledOperation.retryable,
         attempt: controlledOperation.attempt, maxAttempts: controlledOperation.maxAttempts,
         resultJson: null,
         idempotencyKey: `w65-proxy-attach-${suffix}`, requestFingerprint: inputHash,
         createdAt: new Date(controlledOperation.createdAt),
         startedAt: new Date(controlledOperation.startedAt),
         completedAt: null,
         leaseOwner: 'w65-controlled-worker',
         leaseExpiresAt: new Date(Date.now() + 120_000),
         heartbeatAt: new Date(controlledOperation.updatedAt),
         updatedAt: new Date(controlledOperation.updatedAt) }
      const detailData = { operationId: proxyOperationId,
        workspaceId, projectId: world.projectId, projectVersionId: directed.version.id,
        editPlanSnapshotId: directedEdit.id, sourceArtifactId: world.sourceId,
        sourceManifestId: manifestId, colorPipelineBindingsJson: stableSerialize([{
          sourceArtifactId: world.sourceId, sourceManifestId: manifestId,
          compilationId: `w65-controlled-color-${suffix}`,
          compilationHash: 'b'.repeat(64), pipelineHash: 'c'.repeat(64),
        }]), inputHash,
        outputArtifactId, outputManifestId, originalFileName: 'controlled-proxy.mp4' }
      // Exercise the production row hydrator before opening PostgreSQL: the
      // controlled fixture must satisfy the same actor/context/phase invariants.
      assertControlledProxyRowHydrates(operationData, detailData, proxyAudit.contextHash)
      await db.v2PublicOperation.create({ data: operationData })
      await db.v2ProjectProxyRenderOperation.create({ data: detailData })
      const reviewTime = new Date().toISOString()
      const controlledReview = evaluateRenderedProxy({
        projectVersionId: directed.version.id, proxyArtifactId: outputArtifactId,
        proxyManifestId: outputManifestId, proxySha256: 'd'.repeat(64), inputHash,
        format: '9:16', sourceSha256: world.sourceSha256,
        editPlanHash: directedEdit.contentHash,
        expectedDurationMs: Math.round(directed.run.editPlan.durationFrames /
          directed.run.editPlan.fps * 1000),
        uploadReceivedAt: new Date(Date.now() - 60_000).toISOString(),
        renderCompletedAt: reviewTime,
        probe: { width: 540, height: 960,
          duration: directed.run.editPlan.durationFrames / directed.run.editPlan.fps,
          fps: directed.run.editPlan.fps, codec: 'h264', container: 'mp4' },
        map: { schemaVersion: 'render-element-map/v1', proxyHash: 'd'.repeat(64),
          fps: directed.run.editPlan.fps,
          durationFrames: directed.run.editPlan.durationFrames,
          canvas: { width: 540, height: 960 }, elements: [] },
        criticIssues: [{ code: 'FACE_PERCEPTION_UNAVAILABLE', severity: 'hard',
          category: 'integrity', message: 'Controlled face evidence remains unknown',
          correctable: false }],
      })
      assert.equal(controlledReview.status, 'blocked')
      const attach = (receipt = ocrReceipt, parameters = recipeParameters) => proxy.attachCompletedOutput({
        workspaceId, operationId: proxyOperationId, projectId: world.projectId,
        projectVersionId: directed.version.id, variantId: '9:16',
        outputArtifactId, outputManifestId, originalFileName: 'controlled-proxy.mp4',
        createdAt: reviewTime, recipeParameters: parameters, ocrReceipt: receipt,
        lease: { owner: 'w65-controlled-worker', attempt: controlledOperation.attempt,
          now: new Date().toISOString() }, review: controlledReview })
      const canceledId = `w65-canceled-proxy-${suffix}`
      const canceledQueued = createQueuedPublicOperation({ id: canceledId, workspaceId,
        projectId: world.projectId, clientId: world.clientId,
        type: 'project-proxy-render', target: { type: 'media-artifact',
          id: outputArtifactId, manifestId: outputManifestId },
        createdAt: new Date(Date.now() - 2_000).toISOString() })
      const canceled = cancelPublicOperation(canceledQueued, new Date(Date.now() - 1_000).toISOString())
      await db.v2PublicOperation.create({ data: { id: canceledId, workspaceId,
        projectId: world.projectId, clientId: world.clientId,
        ...externalActorAuditData(proxyAudit, workspaceId, world.clientId),
        type: canceled.type, status: canceled.status, phase: canceled.phase,
        targetType: 'media-artifact', targetId: outputArtifactId,
        progressCompleted: canceled.progress.completed, progressTotal: canceled.progress.total,
        progressUnit: canceled.progress.unit, cancelable: canceled.cancelable,
        retryable: canceled.retryable, attempt: canceled.attempt, maxAttempts: canceled.maxAttempts,
        idempotencyKey: `w65-canceled-${suffix}`, requestFingerprint: sha(Buffer.from(canceledId)),
        createdAt: new Date(canceled.createdAt), updatedAt: new Date(canceled.updatedAt),
        completedAt: new Date(canceled.completedAt) } })
      await assert.rejects(proxy.attachCompletedOutput({
        workspaceId, operationId: canceledId, projectId: world.projectId,
        projectVersionId: directed.version.id, variantId: '9:16', outputArtifactId,
        outputManifestId, originalFileName: 'controlled-proxy.mp4', createdAt: reviewTime,
        recipeParameters, ocrReceipt, lease: { owner: 'w65-controlled-worker',
          attempt: controlledOperation.attempt, now: new Date().toISOString() },
        review: controlledReview,
      }), /lease/i)
      await assert.rejects(attach(null), /receipt|recipe/i)
      await assert.rejects(attach({ ...ocrReceipt, envelopeHash: '0'.repeat(64) }), /receipt|recipe/i)
      await db.v2MediaArtifact.update({ where: { id: outputArtifactId },
        data: { sha256: 'e'.repeat(64) } })
      await assert.rejects(attach(), /receipt|recipe/i)
      await db.v2MediaArtifact.update({ where: { id: outputArtifactId },
        data: { sha256: 'd'.repeat(64) } })
      await db.v2Project.update({ where: { id: world.projectId },
        data: { currentVersionId: world.versionId } })
      await assert.rejects(attach(), /current|version/i)
      await db.v2Project.update({ where: { id: world.projectId },
        data: { currentVersionId: directed.version.id } })
      await db.v2MediaArtifact.update({ where: { id: world.sourceId },
        data: { currentRightsSnapshotId: null, rightsRevision: 6 } })
      await assert.rejects(attach(), /rights|blocked/i)
      await db.v2MediaArtifact.update({ where: { id: world.sourceId },
        data: { currentRightsSnapshotId: world.rightsId, rightsRevision: 7 } })
      await db.v2ProjectSnapshot.update({ where: { id: directedEdit.id },
        data: { contentJson: stableSerialize(alteredEdit), contentHash: calculateVersionHash(alteredEdit) } })
      await assert.rejects(attach(), /changed|evidence|time.map/i)
      await db.v2ProjectSnapshot.update({ where: { id: directedEdit.id },
        data: { contentJson: directedEdit.contentJson, contentHash: directedEdit.contentHash } })
      await db.v2PublicOperation.update({ where: { id: proxyOperationId },
        data: { leaseOwner: 'w65-takeover-worker' } })
      await assert.rejects(attach(), /lease/i)
      await db.v2PublicOperation.update({ where: { id: proxyOperationId },
        data: { leaseOwner: 'w65-controlled-worker' } })
      await assert.rejects(proxy.attachCompletedOutput({
        workspaceId, operationId: proxyOperationId, projectId: world.projectId,
        projectVersionId: directed.version.id, variantId: '9:16',
        outputArtifactId, outputManifestId, originalFileName: 'controlled-proxy.mp4',
        createdAt: reviewTime, recipeParameters, ocrReceipt,
        lease: { owner: 'w65-controlled-worker', attempt: controlledOperation.attempt + 1,
          now: new Date().toISOString() }, review: controlledReview,
      }), /lease/i)
      const inspect = PrismaAutomaticCatalogRepository.prototype.inspect
      PrismaAutomaticCatalogRepository.prototype.inspect = async () => {
        throw new Error('W65_CONTROLLED_CATALOG_ROLLBACK')
      }
      try { await assert.rejects(attach(), /W65_CONTROLLED_CATALOG_ROLLBACK/) }
      finally { PrismaAutomaticCatalogRepository.prototype.inspect = inspect }
      assert.equal(await db.v2ProjectMediaAsset.count({ where: { projectId: world.projectId,
        artifactId: outputArtifactId, role: 'editorial-proxy' } }), 0)
      assert.equal(await db.v2ProxyReview.count({ where: { operationId: proxyOperationId } }), 0)
      assert.equal((await db.v2PublicOperation.findUniqueOrThrow({
        where: { id: proxyOperationId } })).status, 'running')
      await attach()
      assert.ok(await db.v2ProjectMediaAsset.findFirst({ where: { workspaceId,
        projectId: world.projectId, artifactId: outputArtifactId, role: 'editorial-proxy' } }))
      const finalized = await db.v2PublicOperation.findUniqueOrThrow({ where: { id: proxyOperationId } })
      assert.equal(finalized.status, 'succeeded')
      assert.equal(finalized.phase, 'completed')
      assert.equal(finalized.attempt, controlledOperation.attempt)
      assert.equal((await db.v2ProxyReview.findUniqueOrThrow({
        where: { operationId: proxyOperationId } })).status, 'blocked')
      const catalogBeforeReplay = await db.v2AutomaticCatalogRecord.count({
        where: { workspaceId, artifactId: outputArtifactId } })
      await attach()
      assert.equal(await db.v2ProjectMediaAsset.count({ where: { projectId: world.projectId,
        artifactId: outputArtifactId, role: 'editorial-proxy' } }), 1)
      assert.equal(await db.v2AutomaticCatalogRecord.count({
        where: { workspaceId, artifactId: outputArtifactId } }), catalogBeforeReplay)
      await assert.rejects(proxy.attachCompletedOutput({
        workspaceId, operationId: proxyOperationId, projectId: world.projectId,
        projectVersionId: world.versionId, variantId: '9:16',
        outputArtifactId, outputManifestId, originalFileName: 'controlled-proxy.mp4',
        createdAt: reviewTime, recipeParameters, ocrReceipt,
        lease: { owner: 'w65-controlled-worker', attempt: controlledOperation.attempt,
          now: new Date().toISOString() }, review: controlledReview,
      }), /replay identity/i)
      const stored = await db.v2ProjectSnapshot.findUniqueOrThrow({
        where: { id: directed.command.payload.snapshotRefs.perception } })
      assert.equal(stored.schemaVersion, 2)
      assert.equal(calculateCanonicalHash(JSON.parse(stored.contentJson)), stored.contentHash)
      assert.equal((await run(request)).replayed, true)
      await db.v2ProjectSnapshot.update({ where: { id: stored.id },
        data: { contentHash: 'f'.repeat(64) } })
      await assert.rejects(run(request), /hash|snapshot|invalid/i)
      await db.v2ProjectSnapshot.update({ where: { id: stored.id },
        data: { contentHash: stored.contentHash } })
      assert.equal(row.projectVersionId, directed.version.parentVersionId)
      assert.equal((await director.readContext({ workspaceId, projectId: world.projectId })).ocrEnvelope,
        undefined, 'OCR from parent version must not flow to a later version')

      await stopRunner(runner)
      runner = undefined

      // Two real PostgreSQL clients contend for the same operation row after a
      // controlled render checkpoint. A third one holds an explicit row lock
      // until both contenders are observed waiting; no timer chooses a winner.
      // This is a persistence race proof, not an additional rendered MP4.
      const raceId = `w65-race-operation-${suffix}`
      const raceArtifactId = `w65-race-output-${suffix}`
      const raceManifestId = `w65-race-manifest-${suffix}`
      const raceInputHash = sha(Buffer.from(raceId))
      const raceKey = `${workspaceId}/controlled-race-proxy.mp4`
      const raceParameters = { ...recipeParameters, inputHash: raceInputHash }
      const raceManifest = createMediaArtifactManifestV2({
        artifactKey: raceKey, artifactSha256: 'd'.repeat(64), byteSize: 1024,
        mediaType: 'video', container: 'mp4',
        recipe: { id: 'editorial-proxy', version: EDITORIAL_PROXY_RECIPE_VERSION,
          parameters: raceParameters },
        sources: [{ artifactKey, sha256: world.sourceSha256, role: 'source-master',
          execution: { tool: { id: 'ffmpeg', version: 'static', digest: 'f'.repeat(64) } } }],
      })
      await db.v2MediaArtifact.create({ data: { id: raceArtifactId, workspaceId,
        artifactKey: raceKey, sha256: 'd'.repeat(64), byteSize: 1024n,
        mediaType: 'video', container: 'mp4', status: 'available' } })
      await db.v2MediaArtifactManifest.create({ data: { id: raceManifestId,
        workspaceId, artifactId: raceArtifactId,
        schemaVersion: raceManifest.schemaVersion,
        manifestHash: raceManifest.manifestHash,
        recipeId: raceManifest.recipe.id,
        recipeVersion: raceManifest.recipe.version,
        parametersHash: raceManifest.recipe.parametersHash,
        manifestJson: stableSerialize(raceManifest) } })
      const raceOperation = controlledRunningProxyOperation({ id: raceId,
        workspaceId, projectId: world.projectId, clientId: world.clientId,
        artifactId: raceArtifactId, manifestId: raceManifestId, now: Date.now() })
      const raceOperationData = { ...operationData, id: raceId, targetId: raceArtifactId,
        status: raceOperation.status, phase: raceOperation.phase,
        progressCompleted: raceOperation.progress.completed,
        progressTotal: raceOperation.progress.total,
        progressUnit: raceOperation.progress.unit,
        cancelable: raceOperation.cancelable, retryable: raceOperation.retryable,
        attempt: raceOperation.attempt, maxAttempts: raceOperation.maxAttempts,
        idempotencyKey: `w65-race-${suffix}`, requestFingerprint: raceInputHash,
        createdAt: new Date(raceOperation.createdAt),
        startedAt: new Date(raceOperation.startedAt),
        updatedAt: new Date(raceOperation.updatedAt),
        heartbeatAt: new Date(raceOperation.updatedAt),
        leaseExpiresAt: new Date(Date.now() + 120_000) }
      const raceDetailData = { ...detailData, operationId: raceId,
        inputHash: raceInputHash, outputArtifactId: raceArtifactId,
        outputManifestId: raceManifestId, originalFileName: 'controlled-race-proxy.mp4' }
      assertControlledProxyRowHydrates(raceOperationData, raceDetailData,
        proxyAudit.contextHash)
      await db.v2PublicOperation.create({ data: raceOperationData })
      await db.v2ProjectProxyRenderOperation.create({ data: raceDetailData })
      await db.v2Project.update({ where: { id: world.projectId },
        data: { status: 'rendering-proxy' } })
      const raceReviewBase = { ...controlledReview }
      delete raceReviewBase.reviewHash
      const raceReviewTime = new Date().toISOString()
      const raceReviewBody = { ...raceReviewBase, proxyArtifactId: raceArtifactId,
        proxyManifestId: raceManifestId, inputHash: raceInputHash,
        renderCompletedAt: raceReviewTime,
        timeToFirstProxyMs: Date.parse(raceReviewTime) -
          Date.parse(raceReviewBase.uploadReceivedAt) }
      const raceReview = Object.freeze({ ...raceReviewBody,
        reviewHash: calculateProxyReviewHash(raceReviewBody) })
      const attachEndpoint = isolatedDbEndpoint(`attach-${suffix}`)
      const cancelEndpoint = isolatedDbEndpoint(`cancel-${suffix}`)
      const latchEndpoint = isolatedDbEndpoint(`latch-${suffix}`)
      const attachName = attachEndpoint.applicationName
      const cancelName = cancelEndpoint.applicationName
      const controller = new PrismaClient({ datasources: { db: {
        url: latchEndpoint.url } } })
      const attachClient = new PrismaClient({ datasources: { db: {
        url: attachEndpoint.url } } })
      const cancelClient = new PrismaClient({ datasources: { db: {
        url: cancelEndpoint.url } } })
      let raceFailure
      try {
        await Promise.all([controller.$connect(), attachClient.$connect(),
          cancelClient.$connect()])
        await Promise.all([controller.$queryRaw`SELECT 1`,
          attachClient.$queryRaw`SELECT 1`, cancelClient.$queryRaw`SELECT 1`])
        const raced = await raceAtOperationLock({ controller, operationId: raceId,
          attachName, cancelName,
          attach: () => new PrismaProjectProxyRenderRepository(attachClient).attachCompletedOutput({
            workspaceId, operationId: raceId, projectId: world.projectId,
            projectVersionId: directed.version.id, variantId: '9:16',
            outputArtifactId: raceArtifactId, outputManifestId: raceManifestId,
            originalFileName: 'controlled-race-proxy.mp4',
            createdAt: raceReviewTime, recipeParameters: raceParameters,
            ocrReceipt, lease: { owner: 'w65-controlled-worker',
              attempt: raceOperation.attempt, now: new Date().toISOString() },
            review: raceReview,
          }),
          cancel: () => new PrismaPublicOperationRepository(cancelClient).cancel({
            workspaceId, operationId: raceId,
            commandId: `w65-race-cancel-${suffix}`,
            authenticationAudit: proxyAudit, canceledAt: new Date().toISOString(),
          }),
        })
        const raceFinal = await db.v2PublicOperation.findUniqueOrThrow({
          where: { id: raceId } })
        const raceLinks = await db.v2ProjectMediaAsset.count({ where: {
          workspaceId, projectId: world.projectId, artifactId: raceArtifactId,
          role: 'editorial-proxy' } })
        const raceReviews = await db.v2ProxyReview.count({ where: {
          workspaceId, operationId: raceId } })
        if (raceFinal.status === 'succeeded') {
          assert.equal(raced.attach.status, 'fulfilled')
          assert.equal(raced.cancel.status, 'fulfilled')
          assert.equal(raced.cancel.value.operation.status, 'succeeded')
          assert.equal(raceLinks, 1)
          assert.equal(raceReviews, 1)
        } else {
          assert.equal(raceFinal.status, 'canceled')
          assert.equal(raced.attach.status, 'rejected')
          assert.equal(raced.cancel.status, 'fulfilled')
          assert.equal(raced.cancel.value.operation.status, 'canceled')
          assert.equal(raceLinks, 0)
          assert.equal(raceReviews, 0)
        }
        assert.ok(['succeeded', 'canceled'].includes(raceFinal.status))
        console.log(`W65 controlled PostgreSQL attach/cancel winner: ${raceFinal.status}`)
      } catch (error) {
        raceFailure = error
        throw error
      } finally {
        const disconnected = await Promise.allSettled([controller.$disconnect(),
          attachClient.$disconnect(), cancelClient.$disconnect()])
        const failures = disconnected.filter((result) => result.status === 'rejected')
          .map((result) => result.reason)
        if (failures.length) throw new AggregateError(
          raceFailure ? [raceFailure, ...failures] : failures,
          'W65 PostgreSQL race clients did not disconnect cleanly',
        )
      }

      // Two further controlled rows exercise an observed cancel-first lock queue
      // and an actual expired-lease reclaim. They use the same sealed source and
      // review shape; each output has a distinct artifact/manifest/operation.
      async function seedOrderedRace(label, expiredLease = false) {
        const id = `w65-${label}-operation-${suffix}`
        const artifactId = `w65-${label}-output-${suffix}`
        const manifestId = `w65-${label}-manifest-${suffix}`
        const key = `${workspaceId}/controlled-${label}-proxy.mp4`
        const hash = sha(Buffer.from(id))
        const parameters = { ...recipeParameters, inputHash: hash }
        const manifest = createMediaArtifactManifestV2({
          artifactKey: key, artifactSha256: 'd'.repeat(64), byteSize: 1024,
          mediaType: 'video', container: 'mp4',
          recipe: { id: 'editorial-proxy', version: EDITORIAL_PROXY_RECIPE_VERSION,
            parameters },
          sources: [{ artifactKey, sha256: world.sourceSha256, role: 'source-master',
            execution: { tool: { id: 'ffmpeg', version: 'static', digest: 'f'.repeat(64) } } }],
        })
        await db.v2MediaArtifact.create({ data: { id: artifactId, workspaceId,
          artifactKey: key, sha256: 'd'.repeat(64), byteSize: 1024n,
          mediaType: 'video', container: 'mp4', status: 'available' } })
        await db.v2MediaArtifactManifest.create({ data: { id: manifestId,
          workspaceId, artifactId, schemaVersion: manifest.schemaVersion,
          manifestHash: manifest.manifestHash, recipeId: manifest.recipe.id,
          recipeVersion: manifest.recipe.version,
          parametersHash: manifest.recipe.parametersHash,
          manifestJson: stableSerialize(manifest) } })
        const running = controlledRunningProxyOperation({ id, workspaceId,
          projectId: world.projectId, clientId: world.clientId,
          artifactId, manifestId, now: Date.now() })
        const publicRow = { ...raceOperationData, id, targetId: artifactId,
          requestFingerprint: hash, idempotencyKey: `w65-${label}-${suffix}`,
          createdAt: new Date(running.createdAt), startedAt: new Date(running.startedAt),
          updatedAt: new Date(running.updatedAt), heartbeatAt: new Date(running.updatedAt),
          leaseExpiresAt: new Date(Date.now() + (expiredLease ? -500 : 120_000)) }
        const detailRow = { ...raceDetailData, operationId: id, inputHash: hash,
          outputArtifactId: artifactId, outputManifestId: manifestId,
          originalFileName: `controlled-${label}-proxy.mp4` }
        assertControlledProxyRowHydrates(publicRow, detailRow, proxyAudit.contextHash)
        await db.v2PublicOperation.create({ data: publicRow })
        await db.v2ProjectProxyRenderOperation.create({ data: detailRow })
        await db.v2Project.update({ where: { id: world.projectId },
          data: { status: 'rendering-proxy' } })
        const finishedAt = new Date().toISOString()
        const base = { ...controlledReview }
        delete base.reviewHash
        const reviewBody = { ...base, proxyArtifactId: artifactId,
          proxyManifestId: manifestId, inputHash: hash,
          renderCompletedAt: finishedAt,
          timeToFirstProxyMs: Date.parse(finishedAt) - Date.parse(base.uploadReceivedAt) }
        const review = Object.freeze({ ...reviewBody,
          reviewHash: calculateProxyReviewHash(reviewBody) })
        return { id, artifactId, manifestId, parameters, review, running,
          attach: (client) => new PrismaProjectProxyRenderRepository(client).attachCompletedOutput({
            workspaceId, operationId: id, projectId: world.projectId,
            projectVersionId: directed.version.id, variantId: '9:16',
            outputArtifactId: artifactId, outputManifestId: manifestId,
            originalFileName: `controlled-${label}-proxy.mp4`,
            createdAt: finishedAt, recipeParameters: parameters,
            ocrReceipt, lease: { owner: 'w65-controlled-worker',
              attempt: running.attempt, now: new Date().toISOString() }, review,
          }) }
      }

      for (const scenario of ['cancel-first', 'takeover']) {
        const candidate = await seedOrderedRace(scenario, scenario === 'takeover')
        const latchEndpoint = isolatedDbEndpoint(`latch-${scenario}-${suffix}`)
        const attachEndpoint = isolatedDbEndpoint(`attach-${scenario}-${suffix}`)
        const controlEndpoint = isolatedDbEndpoint(`control-${scenario}-${suffix}`)
        const latchClient = new PrismaClient({ datasources: { db: { url: latchEndpoint.url } } })
        const oldWorker = new PrismaClient({ datasources: { db: { url: attachEndpoint.url } } })
        const controllerClient = new PrismaClient({ datasources: { db: { url: controlEndpoint.url } } })
        let scenarioFailure
        try {
          await Promise.all([latchClient.$connect(), oldWorker.$connect(),
            controllerClient.$connect()])
          await Promise.all([latchClient.$queryRaw`SELECT 1`,
            oldWorker.$queryRaw`SELECT 1`, controllerClient.$queryRaw`SELECT 1`])
          const outcome = await raceAtOperationLock({ controller: latchClient,
            operationId: candidate.id, attachName: attachEndpoint.applicationName,
            cancelName: controlEndpoint.applicationName, orderedFirst: 'cancel',
            attach: () => candidate.attach(oldWorker),
            cancel: scenario === 'cancel-first'
              ? () => new PrismaPublicOperationRepository(controllerClient).cancel({
                workspaceId, operationId: candidate.id,
                commandId: `w65-cancel-first-${suffix}`,
                authenticationAudit: proxyAudit, canceledAt: new Date().toISOString(),
              })
              : () => new PrismaPublicOperationRepository(controllerClient).claimNext({
                workspaceId, operationId: candidate.id, type: 'project-proxy-render',
                leaseOwner: `w65-new-worker-${suffix}`, now: new Date().toISOString(),
                leaseUntil: new Date(Date.now() + 120_000).toISOString(),
              }),
          })
          const final = await db.v2PublicOperation.findUniqueOrThrow({
            where: { id: candidate.id } })
          assert.equal(outcome.cancel.status, 'fulfilled')
          assert.equal(outcome.attach.status, 'rejected')
          if (scenario === 'cancel-first') {
            assert.equal(final.status, 'canceled')
            assert.equal(outcome.cancel.value.operation.status, 'canceled')
          } else {
            assert.equal(final.status, 'running')
            assert.equal(final.attempt, candidate.running.attempt + 1)
            assert.equal(final.leaseOwner, `w65-new-worker-${suffix}`)
            assert.equal(outcome.cancel.value.operation.attempt, final.attempt)
          }
          assert.equal(await db.v2ProjectMediaAsset.count({ where: {
            workspaceId, projectId: world.projectId, artifactId: candidate.artifactId,
            role: 'editorial-proxy' } }), 0)
          assert.equal(await db.v2ProxyReview.count({ where: {
            workspaceId, operationId: candidate.id } }), 0)
          assert.equal(await db.v2AutomaticCatalogRecord.count({ where: {
            workspaceId, artifactId: candidate.artifactId } }), 0)
          console.log(`W65 observed PostgreSQL ${scenario}: ${final.status}, attempt ${final.attempt}`)
        } catch (error) { scenarioFailure = error; throw error } finally {
          const disconnected = await Promise.allSettled([latchClient.$disconnect(),
            oldWorker.$disconnect(), controllerClient.$disconnect()])
          const failures = disconnected.filter((result) => result.status === 'rejected')
            .map((result) => result.reason)
          if (failures.length) throw new AggregateError(
            scenarioFailure ? [scenarioFailure, ...failures] : failures,
            `W65 ${scenario} PostgreSQL clients did not disconnect cleanly`)
        }
      }
    } catch (error) { primaryError = error } finally {
      const cleanupErrors = []
      try { await stopRunner(runner) } catch (error) { cleanupErrors.push(error) }
      if (cleanupScope) {
        const activeStatuses = ['queued', 'running', 'waiting', 'retrying']
        try {
          const audit = createApiAccessAuditContext({ clientId: cleanupScope.clientId,
            credentialId: `w64-credential-${cleanupScope.suffix}`,
            workspaceId: cleanupScope.workspaceId, environment: 'production',
            authenticationKind: 'bearer' })
          const pending = await db.v2PublicOperation.findMany({
            where: { workspaceId: cleanupScope.workspaceId,
              status: { in: activeStatuses } },
            select: { id: true, updatedAt: true, nextAttemptAt: true } })
          const operations = new PrismaPublicOperationRepository(db)
          for (const row of pending) {
            const canceledAt = new Date(Math.max(Date.now(),
              row.updatedAt.getTime(), row.nextAttemptAt?.getTime() ?? 0))
            await operations.cancel({ workspaceId: cleanupScope.workspaceId,
              operationId: row.id, commandId: `w64-cleanup-${randomUUID()}`,
              authenticationAudit: audit, canceledAt: canceledAt.toISOString() })
          }
        } catch (error) { cleanupErrors.push(error) }
        try {
          assert.equal(await db.v2PublicOperation.count({ where: {
            workspaceId: cleanupScope.workspaceId,
            status: { in: activeStatuses },
          } }), 0, 'the private workspace must have no active operations after cleanup')
        } catch (error) { cleanupErrors.push(error) }
      }
      try { await db.$disconnect() } catch (error) { cleanupErrors.push(error) }
      try {
        const scratch = await realpath(root)
        const parent = await realpath(tmpdir())
        assert.ok(scratch.startsWith(join(parent, 'apollo-w64-director-ocr-')),
          'Scratch path must stay within the owned temporary directory')
        await rm(scratch, { recursive: true, force: true })
      } catch (error) { cleanupErrors.push(error) }
      if (primaryError && cleanupErrors.length) throw new AggregateError(
        [primaryError, ...cleanupErrors], 'W65 test and cleanup both failed')
      if (primaryError) throw primaryError
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'W65 cleanup failed')
    }
  })
