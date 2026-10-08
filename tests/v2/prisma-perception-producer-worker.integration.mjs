import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { createApiAccessAuditContext } from '../../src/v2/domain/api-access-control.ts'
import { enqueuePerceptionProducerRunService } from '../../src/v2/application/enqueue-perception-producer-run.ts'
import { runNextPerceptionProducerOperationService } from '../../src/v2/application/run-perception-producer-worker.ts'
import { PrismaPerceptionProducerRequestContextRepository } from '../../src/v2/infrastructure/prisma/perception-producer-request-context-repository.ts'
import { PrismaPerceptionProducerEnvelopeRepository } from '../../src/v2/infrastructure/prisma/perception-producer-envelope-repository.ts'
import { PrismaPublicOperationRepository } from '../../src/v2/infrastructure/prisma/public-operation-repository.ts'
import { seedPerceptionProducerContext } from './helpers/perception-producer-pg-world.mjs'

const exec = promisify(execFile)
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
async function stopRunner(child) {
  if (!child) return
  const waitExit = (timeoutMs) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('OCR runner did not stop')), timeoutMs)
    child.once('exit', () => { clearTimeout(timeout); resolve() })
  })
  if (child.exitCode === null) {
    child.kill('SIGTERM')
    try { await waitExit(10_000) }
    catch {
      child.kill('SIGKILL')
      await waitExit(5_000)
    }
  }
  assert.throws(() => process.kill(child.pid, 0), /ESRCH|not found/i,
    'OCR runner PID must be terminal after shutdown')
  if (process.platform === 'win32') {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${child.pid}" | Select-Object -ExpandProperty ProcessId`],
    { windowsHide: true, timeout: 10_000 })
    assert.equal(stdout.trim(), '', 'OCR runner descendants must be terminal after shutdown')
  }
}

test('W61 PostgreSQL claim blocks revoked rights before source materialization and closes operation with events',
  { skip: !process.env.V2_DATABASE_URL }, async () => {
    const db = new PrismaClient()
    try {
      const { suffix, workspaceId, clientId, projectId, versionId, sourceId } =
        await seedPerceptionProducerContext(db)
      const auditContext = createExternalAuditContext({ clientId,
        credentialId: `w61-credential-${suffix}`, workspaceId, environment: 'production' })
      const actor = { ...auditContext, scopes: new Set(['projects:write']), authenticationKind: 'bearer',
        clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
        clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext }
      const operations = new PrismaPublicOperationRepository(db)
      const enqueue = enqueuePerceptionProducerRunService({
        context: new PrismaPerceptionProducerRequestContextRepository(db), operations,
        createOperationId: () => `w61-operation-${randomUUID()}`,
      })
      const queued = await enqueue({ workspaceId, projectId, projectVersionId: versionId,
        sourceArtifactId: sourceId, sampleIntervalFrames: 30, actor,
        idempotencyKey: `w61-worker-key-${suffix}` })
      const operationId = queued.operation.id
      await db.v2MediaArtifact.update({ where: { id: sourceId },
        data: { currentRightsSnapshotId: null, rightsRevision: 2 } })
      let materialized = 0, analyzed = 0
      const worker = runNextPerceptionProducerOperationService({
        repository: new PrismaPerceptionProducerEnvelopeRepository(db),
        materializer: { async materialize() { materialized += 1; assert.fail('revoked source read') },
          async cleanup() {} },
        adapter: { async analyze() { analyzed += 1; assert.fail('revoked source OCR') } },
      })
      assert.equal(await worker(`ocr-test-${suffix}`), null)
      assert.equal(materialized, 0)
      assert.equal(analyzed, 0)
      const stored = await operations.findById(workspaceId, operationId)
      assert.equal(stored.operation.status, 'failed')
      assert.equal(stored.operation.error.code, 'invalid_producer_context')
      assert.equal(await db.v2PerceptionProducerEnvelope.count({ where: { operationId } }), 0)
      const events = await db.v2PublicEventOutbox.findMany({ where: { workspaceId, resourceId: operationId },
        orderBy: { sequence: 'asc' } })
      assert.ok(events.some((event) => event.type === 'operation.failed'))
    } finally {
      await db.$disconnect()
    }
  })

test('W61 PostgreSQL retryable OCR failure preserves the PublicOperation retrying invariant',
  { skip: !process.env.V2_DATABASE_URL }, async () => {
    const db = new PrismaClient()
    let cleanup
    try {
      const { suffix, workspaceId, clientId, projectId, versionId, sourceId } =
        await seedPerceptionProducerContext(db)
      const auditContext = createExternalAuditContext({ clientId,
        credentialId: `w61-credential-${suffix}`, workspaceId, environment: 'production' })
      const actor = { ...auditContext, scopes: new Set(['projects:write']), authenticationKind: 'bearer',
        clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
        clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext }
      const operations = new PrismaPublicOperationRepository(db)
      const enqueue = enqueuePerceptionProducerRunService({
        context: new PrismaPerceptionProducerRequestContextRepository(db), operations,
        createOperationId: () => `w61-operation-${randomUUID()}`,
      })
      const queued = await enqueue({ workspaceId, projectId, projectVersionId: versionId,
        sourceArtifactId: sourceId, sampleIntervalFrames: 30, actor,
        idempotencyKey: `w61-retry-key-${suffix}` })
      cleanup = { operations, workspaceId, operationId: queued.operation.id, clientId, suffix }
      const repository = new PrismaPerceptionProducerEnvelopeRepository(db)
      const now = new Date()
      const claimed = await repository.claimNext({ leaseOwner: `ocr-retry-${suffix}`, now, leaseMs: 30_000 })
      assert.equal(claimed?.operationId, queued.operation.id)
      assert.equal(await repository.failAttempt({ operationId: claimed.operationId,
        attempt: claimed.attempt, leaseOwner: claimed.leaseOwner, now: new Date(),
        errorCode: 'RENDER_EXECUTION_FAILED', errorMessage: 'Controlled adapter failure', retryable: true }), true)
      const persisted = await operations.findById(workspaceId, claimed.operationId)
      assert.equal(persisted.operation.status, 'retrying')
      assert.equal(persisted.operation.error, undefined)
      const row = await db.v2PublicOperation.findUniqueOrThrow({ where: { id: claimed.operationId } })
      assert.equal(row.errorCode, null)
      assert.equal(row.errorMessage, null)
      assert.equal(row.errorRetryable, null)
      assert.ok(row.nextAttemptAt instanceof Date)
    } finally {
      try {
        if (cleanup) {
          const authenticationAudit = createApiAccessAuditContext({ clientId: cleanup.clientId,
            credentialId: `w61-credential-${cleanup.suffix}`,
            workspaceId: cleanup.workspaceId, environment: 'production', authenticationKind: 'bearer' })
          await cleanup.operations.cancel({ workspaceId: cleanup.workspaceId,
            operationId: cleanup.operationId, commandId: `w61-retry-cancel-${cleanup.suffix}`,
            authenticationAudit, canceledAt: new Date().toISOString() })
        }
      } finally { await db.$disconnect() }
    }
  })

test('W61 PostgreSQL runner publishes a real OCR envelope without facial clearance and rejects tampering',
  { skip: !process.env.V2_DATABASE_URL || !process.env.APOLLO_OCR_VIDEO_E2E,
    timeout: 180_000 }, async () => {
    const db = new PrismaClient()
    const root = await mkdtemp(join(tmpdir(), 'apollo-w61-ocr-pg-'))
    let child
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
      const world = await seedPerceptionProducerContext(db, { suffix,
        artifactKey, sourceSha256: sha(bytes), byteSize: BigInt(bytes.length) })
      const auditContext = createExternalAuditContext({ clientId: world.clientId,
        credentialId: `w61-credential-${suffix}`, workspaceId, environment: 'production' })
      const actor = { ...auditContext, scopes: new Set(['projects:write']), authenticationKind: 'bearer',
        clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
        clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext }
      const operations = new PrismaPublicOperationRepository(db)
      const enqueue = enqueuePerceptionProducerRunService({
        context: new PrismaPerceptionProducerRequestContextRepository(db), operations,
        createOperationId: () => `w61-operation-${randomUUID()}`,
      })
      const queued = await enqueue({ workspaceId, projectId: world.projectId,
        projectVersionId: world.versionId, sourceArtifactId: world.sourceId,
        sampleIntervalFrames: 60, actor, idempotencyKey: `w61-real-ocr-${suffix}` })
      const operationId = queued.operation.id
      const env = { ...process.env, APOLLO_V2_ARTIFACT_ROOT: root,
        APOLLO_V2_ARTIFACT_STORAGE_DRIVER: 'local',
        APOLLO_V2_OCR_FFMPEG_BIN: process.env.APOLLO_OCR_FFMPEG,
        APOLLO_V2_OCR_FFPROBE_BIN: process.env.APOLLO_OCR_FFPROBE,
        APOLLO_V2_OCR_TESSERACT_BIN: process.env.APOLLO_OCR_TESSERACT,
        APOLLO_V2_OCR_TESSDATA_DIR: process.env.APOLLO_OCR_TESSDATA,
        APOLLO_V2_OCR_TESSDATA_LICENSE: join(process.env.APOLLO_OCR_TESSDATA, 'LICENSE'),
        APOLLO_V2_OCR_LANGUAGES: 'eng', APOLLO_V2_OCR_POLL_MS: '100' }
      child = spawn(process.execPath, ['--import', 'tsx',
        'scripts/run-v2-perception-producer-worker.mjs'], { cwd: process.cwd(), env,
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const pid = child.pid
      assert.ok(Number.isSafeInteger(pid) && pid > 0)
      let diagnostic = ''
      child.stdout.on('data', (data) => { diagnostic = (diagnostic + data.toString()).slice(-4000) })
      child.stderr.on('data', (data) => { diagnostic = (diagnostic + data.toString()).slice(-4000) })
      const deadline = Date.now() + 105_000
      let stored
      while (Date.now() < deadline) {
        stored = await operations.findById(workspaceId, operationId)
        if (stored?.operation.status === 'succeeded' || stored?.operation.status === 'failed') break
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      assert.equal(stored?.operation.status, 'succeeded', diagnostic)
      assert.equal(stored.operation.type, 'perception-producer-run')
      assert.equal(stored.operation.progress.completed, 4)
      assert.equal(stored.operation.result.resource.id, world.versionId)
      const row = await db.v2PerceptionProducerEnvelope.findFirst({ where: { operationId } })
      assert.ok(row)
      const evidence = new PrismaPerceptionProducerEnvelopeRepository(db)
      const envelope = await evidence.read({ id: row.id, workspaceId,
        projectId: world.projectId, inputVersionId: world.versionId, now: new Date() })
      assert.equal(envelope.authority, 'server-produced')
      assert.equal(envelope.modality, 'ocr')
      assert.equal(envelope.faceSafety, 'unknown')
      assert.equal(envelope.samples.length, 2)
      assert.ok(envelope.samples[0].ocr.some((region) => /APOLLO/i.test(region.text)))
      assert.ok(envelope.gaps.length > 0)
      const events = await db.v2PublicEventOutbox.findMany({ where: { workspaceId, resourceId: operationId } })
      assert.ok(events.some((event) => event.type === 'operation.succeeded'))
      await db.v2PerceptionProducerEnvelope.update({ where: { id: row.id },
        data: { envelopeHash: 'f'.repeat(64) } })
      await assert.rejects(evidence.read({ id: row.id, workspaceId,
        projectId: world.projectId, inputVersionId: world.versionId, now: new Date() }),
      /integrity|hash/i)
      await db.v2PerceptionProducerEnvelope.update({ where: { id: row.id },
        data: { envelopeHash: envelope.envelopeHash } })
      assert.equal((await evidence.read({ id: row.id, workspaceId,
        projectId: world.projectId, inputVersionId: world.versionId, now: new Date() })).envelopeHash,
      envelope.envelopeHash)
    } finally {
      try { await stopRunner(child) }
      finally {
        await db.$disconnect()
        await rm(root, { recursive: true, force: true })
      }
    }
  })
