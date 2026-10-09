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
import { EDITORIAL_PROXY_RECIPE_VERSION } from '../../src/v2/application/ports/editorial-proxy-renderer.ts'
import { PrismaDirectorRunRepository } from '../../src/v2/infrastructure/prisma/director-run-repository.ts'
import { PrismaPerceptionProducerRequestContextRepository } from '../../src/v2/infrastructure/prisma/perception-producer-request-context-repository.ts'
import { PrismaPerceptionTimelineRepository } from '../../src/v2/infrastructure/prisma/perception-timeline-repository.ts'
import { PrismaPublicOperationRepository } from '../../src/v2/infrastructure/prisma/public-operation-repository.ts'
import { PrismaProjectProxyRenderRepository } from '../../src/v2/infrastructure/prisma/project-proxy-render-repository.ts'
import { expectedOcrTimeline } from '../../src/v2/domain/projected-ocr-timeline.ts'
import { calculateVersionHash } from '../../src/v2/application/version-hash.ts'
import { seedPerceptionProducerContext } from './helpers/perception-producer-pg-world.mjs'

const exec = promisify(execFile)
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

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
    const db = new PrismaClient()
    const root = await mkdtemp(join(tmpdir(), 'apollo-w64-director-ocr-'))
    let runner
    let cleanupScope
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
      const recipeParameters = { ocrReceipt, inputHash,
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
      await db.v2PublicOperation.create({ data: { id: proxyOperationId, workspaceId,
        projectId: world.projectId, clientId: world.clientId,
        type: 'project-proxy-render', status: 'succeeded', phase: 'completed',
        targetType: 'media-artifact', targetId: outputArtifactId,
        cancelable: false, retryable: false, attempt: 1, maxAttempts: 3,
        resultJson: stableSerialize({ resource: { type: 'media-artifact', id: outputArtifactId,
          manifestId: outputManifestId } }),
        idempotencyKey: `w65-proxy-attach-${suffix}`, requestFingerprint: inputHash,
        startedAt: new Date(), completedAt: new Date() } })
      await db.v2ProjectProxyRenderOperation.create({ data: { operationId: proxyOperationId,
        workspaceId, projectId: world.projectId, projectVersionId: directed.version.id,
        editPlanSnapshotId: directedEdit.id, sourceArtifactId: world.sourceId,
        sourceManifestId: manifestId, colorPipelineBindingsJson: '[]', inputHash,
        outputArtifactId, outputManifestId, originalFileName: 'controlled-proxy.mp4' } })
      const attach = (receipt = ocrReceipt, parameters = recipeParameters) => proxy.attachCompletedOutput({
        workspaceId, operationId: proxyOperationId, projectId: world.projectId,
        projectVersionId: directed.version.id, variantId: '9:16',
        outputArtifactId, outputManifestId, originalFileName: 'controlled-proxy.mp4',
        createdAt: new Date().toISOString(), recipeParameters: parameters, ocrReceipt: receipt })
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
      await attach()
      assert.ok(await db.v2ProjectMediaAsset.findFirst({ where: { workspaceId,
        projectId: world.projectId, artifactId: outputArtifactId, role: 'editorial-proxy' } }))
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
    } finally {
      try { await stopRunner(runner) }
      finally {
        try {
          if (cleanupScope) {
            const audit = createApiAccessAuditContext({ clientId: cleanupScope.clientId,
              credentialId: `w64-credential-${cleanupScope.suffix}`,
              workspaceId: cleanupScope.workspaceId, environment: 'production',
              authenticationKind: 'bearer' })
            const pending = await db.v2PublicOperation.findMany({
              where: { workspaceId: cleanupScope.workspaceId,
                idempotencyKey: `w64-ocr-${cleanupScope.suffix}` },
              select: { id: true, status: true } })
            const operations = new PrismaPublicOperationRepository(db)
            for (const row of pending) if (['queued', 'running', 'waiting', 'retrying'].includes(row.status)) {
              await operations.cancel({ workspaceId: cleanupScope.workspaceId,
                operationId: row.id, commandId: `w64-cleanup-${randomUUID()}`,
                authenticationAudit: audit, canceledAt: new Date().toISOString() })
            }
          }
        } finally {
          await db.$disconnect()
          const scratch = await realpath(root)
          const parent = await realpath(tmpdir())
          assert.ok(scratch.startsWith(join(parent, 'apollo-w64-director-ocr-')),
            'Scratch path must stay within the owned temporary directory')
          await rm(scratch, { recursive: true, force: true })
        }
      }
    }
  })
