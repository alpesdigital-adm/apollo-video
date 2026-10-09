import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import net from 'node:net'
import test from 'node:test'
import { promisify } from 'node:util'

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { createApiAccessAuditContext } from '../../src/v2/domain/api-access-control.ts'
import { createApiClientService } from '../../src/v2/application/create-api-client.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createQueuedPublicOperation } from '../../src/v2/domain/public-operation.ts'
import { PrismaPerceptionProducerRequestContextRepository } from '../../src/v2/infrastructure/prisma/perception-producer-request-context-repository.ts'
import { PrismaPublicOperationRepository } from '../../src/v2/infrastructure/prisma/public-operation-repository.ts'
import { PrismaTemporalProducerEnvelopeRepository } from '../../src/v2/infrastructure/prisma/temporal-producer-envelope-repository.ts'
import { PrismaTemporalProducerRequestContextRepository } from '../../src/v2/infrastructure/prisma/perception-producer-request-context-repository.ts'
import { PrismaApiClientRepository } from '../../src/v2/infrastructure/prisma/api-client-repository.ts'
import { nodeApiCredentialCrypto } from '../../src/v2/infrastructure/security/api-credential.ts'
import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { enqueueTemporalProducerRunService } from '../../src/v2/application/enqueue-temporal-producer-run.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'
import { publicSchemaDocument } from '../../src/v2/public-api/schema-examples.ts'
import { presentPublicOperationV2, presentSuccess } from '../../src/v2/public-api/presenters.ts'
import { seedPerceptionProducerContext } from './helpers/perception-producer-pg-world.mjs'

const exec = promisify(execFile)
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

function freePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer()
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address()
      listener.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

async function waitForServer(base, child, state) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (state.error) throw state.error
    if (state.closed || child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Temporal HTTP server exited: ${state.diagnostic}`)
    }
    try {
      if ((await fetch(`${base}/v1/health`, { signal: AbortSignal.timeout(1500) })).ok) return
    } catch { /* server startup pending */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Temporal HTTP server did not become ready: ${state.diagnostic}`)
}

async function stopRunner(child) {
  if (!child) return
  const waitExit = (timeoutMs) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Temporal runner did not stop')), timeoutMs)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
  })

  if (child.exitCode === null && child.signalCode === null) {
    const gracefulExit = waitExit(10_000)
    child.kill('SIGTERM')
    try { await gracefulExit }
    catch {
      const forcedExit = waitExit(5_000)
      child.kill('SIGKILL')
      await forcedExit
    }
  }
  assert.throws(() => process.kill(child.pid, 0), /ESRCH|not found/i,
    'Temporal runner PID must be terminal')
  if (process.platform === 'win32') {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${child.pid}" | Select-Object -ExpandProperty ProcessId`],
    { windowsHide: true, timeout: 10_000 })
    assert.equal(stdout.trim(), '', 'Temporal runner descendants must be terminal')
  }
}

test('W63 PostgreSQL runner publishes real pinned FFmpeg measurements with scoped immutable read',
  { skip: !process.env.V2_DATABASE_URL || process.env.APOLLO_TEMPORAL_VIDEO_E2E !== '1',
    timeout: 180_000 }, async () => {
    const db = new PrismaClient()
    const root = await mkdtemp(join(tmpdir(), 'apollo-w63-temporal-pg-'))
    let child, server, cleanup
    try {
      const ffmpeg = process.env.APOLLO_TEMPORAL_FFMPEG
      const ffprobe = process.env.APOLLO_TEMPORAL_FFPROBE
      assert.ok(isAbsolute(ffmpeg) && isAbsolute(ffprobe))
      const suffix = randomUUID().slice(0, 8)
      const workspaceId = `w61-admission-${suffix}`
      const artifactKey = `${workspaceId}/source.mp4`
      const artifactPath = join(root, artifactKey)
      await mkdir(join(root, workspaceId), { recursive: true })
      await exec(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
        '-i', 'color=c=black:s=320x180:r=30:d=4', '-frames:v', '120',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', artifactPath],
      { windowsHide: true, timeout: 30_000 })
      const bytes = await readFile(artifactPath)
      const world = await seedPerceptionProducerContext(db, { suffix, artifactKey,
        sourceSha256: sha(bytes), byteSize: BigInt(bytes.length) })
      const auditContext = createExternalAuditContext({ clientId: world.clientId,
        credentialId: `w63-credential-${suffix}`, workspaceId,
        environment: 'production' })
      const actor = { ...auditContext, scopes: new Set(['projects:write']),
        authenticationKind: 'bearer', clientKillSwitchEngaged: false,
        workspaceKillSwitchEngaged: false, clientAccessStatus: 'active',
        workspaceAccessStatus: 'active', auditContext }
      const operations = new PrismaPublicOperationRepository(db)
      const enqueue = enqueueTemporalProducerRunService({
        context: new PrismaTemporalProducerRequestContextRepository(db), operations,
        createOperationId: () => `w63-operation-${randomUUID()}`,
      })
      const queued = await enqueue({ workspaceId, projectId: world.projectId,
        projectVersionId: world.versionId, sourceArtifactId: world.sourceId,
        actor, idempotencyKey: `w63-real-temporal-${suffix}` })
      cleanup = { operations, workspaceId, operationId: queued.operation.id,
        audit: createApiAccessAuditContext({ clientId: world.clientId,
          credentialId: `w63-credential-${suffix}`, workspaceId,
          environment: 'production', authenticationKind: 'bearer' }) }
      const env = { ...process.env, APOLLO_V2_ARTIFACT_ROOT: root,
        APOLLO_V2_ARTIFACT_STORAGE_DRIVER: 'local',
        APOLLO_V2_TEMPORAL_FFMPEG_BIN: ffmpeg,
        APOLLO_V2_TEMPORAL_FFPROBE_BIN: ffprobe,
        APOLLO_V2_TEMPORAL_FFMPEG_SHA256: sha(await readFile(ffmpeg)),
        APOLLO_V2_TEMPORAL_FFPROBE_SHA256: sha(await readFile(ffprobe)),
        APOLLO_V2_TEMPORAL_POLL_MS: '100' }
      child = spawn(process.execPath, ['--import', 'tsx',
        'scripts/run-v2-temporal-producer-worker.mjs'], { cwd: process.cwd(), env,
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0)
      let diagnostic = '', exited = false
      child.stdout.on('data', (data) => { diagnostic = (diagnostic + data.toString()).slice(-4000) })
      child.stderr.on('data', (data) => { diagnostic = (diagnostic + data.toString()).slice(-4000) })
      child.once('error', (error) => { diagnostic = (diagnostic + String(error)).slice(-4000); exited = true })
      child.once('exit', (code) => { diagnostic = (diagnostic + ` exit=${code}`).slice(-4000); exited = true })
      const deadline = Date.now() + 120_000
      let stored
      while (Date.now() < deadline) {
        stored = await operations.findById(workspaceId, queued.operation.id)
        if (stored?.operation.status === 'succeeded' || stored?.operation.status === 'failed' || exited) break
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      assert.equal(stored?.operation.status, 'succeeded', diagnostic)
      assert.equal(stored.operation.progress.completed, 4)
      const row = await db.v2TemporalProducerEnvelope.findFirst({ where: { operationId: queued.operation.id } })
      assert.ok(row)
      const repository = new PrismaTemporalProducerEnvelopeRepository(db)
      const input = { id: row.id, workspaceId, projectId: world.projectId,
        inputVersionId: world.versionId, now: new Date() }
      const envelope = await repository.read(input)
      assert.equal(envelope.authority, 'server-produced')
      assert.equal(envelope.interpretation, 'raw-measurements-only')
      assert.equal(envelope.faceSafety, 'unknown')
      assert.equal(envelope.analysis.observedFrameCount, 120)
      assert.equal(envelope.shot.observations.length, 119)
      assert.deepEqual(envelope.shot.gaps.at(-1), { startTimelineFrame: 119,
        endTimelineFrame: 120, reasonCode: 'NO_ADJACENT_OBSERVED_PAIR' })
      const ajv = new Ajv2020({ strict: true, allErrors: true })
      addFormats(ajv)
      const schema = publicSchemaDocument(getPublicSchema('apollo://schemas/temporal-producer-operation-read/v1'))
      const validate = ajv.compile(schema)
      const response = presentSuccess({ operation: presentPublicOperationV2(stored.operation,
        { includeProjectId: true }), envelope })
      assert.equal(validate(response), true, ajv.errorsText(validate.errors))
      const events = await db.v2PublicEventOutbox.findMany({ where: { workspaceId,
        resourceId: queued.operation.id } })
      assert.ok(events.some((event) => event.type === 'operation.succeeded'))
      await db.v2TemporalProducerEnvelope.update({ where: { id: row.id },
        data: { envelopeHash: 'f'.repeat(64) } })
      await assert.rejects(repository.read(input), /integrity|hash/i)
      await db.v2TemporalProducerEnvelope.update({ where: { id: row.id },
        data: { envelopeHash: envelope.envelopeHash } })
      await db.v2MediaArtifact.update({ where: { id: world.sourceId },
        data: { currentRightsSnapshotId: null, rightsRevision: 2 } })
      await assert.rejects(repository.read(input), /rights/i)
      await db.v2MediaArtifact.update({ where: { id: world.sourceId },
        data: { currentRightsSnapshotId: world.rightsId, rightsRevision: 3 } })
      assert.equal((await repository.read(input)).envelopeHash, envelope.envelopeHash)
      if (process.env.APOLLO_TEMPORAL_HTTP_E2E === '1') {
        await stopRunner(child)
        child = undefined
        const issue = createApiClientService({ repository: new PrismaApiClientRepository(db),
          credentialCrypto: nodeApiCredentialCrypto, clock: () => new Date() })
        const scopes = ['projects:read', 'projects:write', 'operations:read', 'operations:cancel']
        const token = (await issue({ id: `w63-http-${suffix}`,
          credentialId: `w63-http-credential-${suffix}`, workspaceId,
          name: 'W63 temporal HTTP', environment: 'production', scopes })).token
        const foreignToken = (await issue({ id: `w63-http-foreign-${suffix}`,
          credentialId: `w63-http-foreign-credential-${suffix}`,
          workspaceId: world.otherWorkspaceId, name: 'W63 foreign HTTP',
          environment: 'production', scopes })).token
        const port = await freePort()
        const base = `http://127.0.0.1:${port}`
        const state = { closed: false, error: null, diagnostic: '' }
        server = spawn(process.execPath,
          ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)],
          { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, NODE_ENV: 'production', __NEXT_PROCESSED_ENV: 'true',
              APOLLO_API_ENVIRONMENT: 'production', NEXT_TELEMETRY_DISABLED: '1',
              APOLLO_GOVERNANCE_ANOMALY_REQUEST_MINIMUM: '2000000000',
              APOLLO_GOVERNANCE_ANOMALY_SPEND_MINIMUM_MINOR_UNITS: '2000000000' } })
        assert.ok(Number.isSafeInteger(server.pid) && server.pid > 0)
        server.once('error', (error) => { state.error = error })
        server.once('close', (code) => { state.closed = true; state.diagnostic += ` close=${code}` })
        for (const stream of [server.stdout, server.stderr]) {
          stream.on('data', (data) => { state.diagnostic = (state.diagnostic + data.toString()).slice(-4000) })
        }
        await waitForServer(base, server, state)
        const request = async (bearer, path, method = 'GET', body, key) => {
          const response = await fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(20_000),
            headers: { authorization: `Bearer ${bearer}`,
              ...(body ? { 'content-type': 'application/json' } : {}),
              ...(key ? { 'idempotency-key': key } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}) })
          return { status: response.status, body: await response.json() }
        }
        const route = `/v1/projects/${world.projectId}/temporal-producer-operations`
        const sealed = await request(token, `${route}/${queued.operation.id}`)
        assert.equal(sealed.status, 200, JSON.stringify(sealed.body))
        assert.equal(validate(sealed.body), true, ajv.errorsText(validate.errors))
        assert.equal(sealed.body.data.envelope.envelopeHash, envelope.envelopeHash)
        const denied = await request(foreignToken, `${route}/${queued.operation.id}`)
        assert.equal(denied.status, 404)
        const httpBody = { projectVersionId: world.versionId, sourceArtifactId: world.sourceId }
        const httpKey = `w63-http-key-${suffix}`
        const queuedHttp = await request(token, route, 'POST', httpBody, httpKey)
        assert.equal(queuedHttp.status, 202, JSON.stringify(queuedHttp.body))
        const createdSchema = publicSchemaDocument(getPublicSchema(
          'apollo://schemas/temporal-producer-operation-created/v1'))
        const validateCreated = ajv.compile(createdSchema)
        assert.equal(validateCreated(queuedHttp.body), true, ajv.errorsText(validateCreated.errors))
        const httpOperationId = queuedHttp.body.data.operation.id
        cleanup.httpOperationId = httpOperationId
        const replay = await request(token, route, 'POST', httpBody, httpKey)
        assert.equal(replay.status, 200)
        assert.equal(replay.body.data.operation.id, httpOperationId)
        assert.equal(replay.body.data.replayed, true)
        const spoofed = await request(token, route, 'POST', { ...httpBody, trusted: true },
          `w63-spoof-${suffix}`)
        assert.equal(spoofed.status, 422)
        assert.equal(spoofed.body.error.code, 'INVALID_ARGUMENT')
        const readQueued = await request(token, `${route}/${httpOperationId}`)
        assert.equal(readQueued.status, 200)
        assert.equal(validate(readQueued.body), true, ajv.errorsText(validate.errors))
        assert.equal(Object.hasOwn(readQueued.body.data, 'envelope'), false)
        const canceled = await request(token, `/v1/operations/${httpOperationId}/cancel`, 'POST')
        assert.equal(canceled.status, 200, JSON.stringify(canceled.body))
        assert.equal(canceled.body.data.operation.status, 'canceled')
      }
    } finally {
      try { await stopRunner(server); await stopRunner(child) }
      finally {
        try {
          if (cleanup) {
            for (const operationId of [cleanup.operationId, cleanup.httpOperationId].filter(Boolean)) {
              const pending = await cleanup.operations.findById(cleanup.workspaceId, operationId)
              if (pending && ['queued', 'running', 'waiting', 'retrying'].includes(pending.operation.status)) {
                await cleanup.operations.cancel({ workspaceId: cleanup.workspaceId,
                  operationId, commandId: `w63-cleanup-${randomUUID()}`,
                  authenticationAudit: cleanup.audit, canceledAt: new Date().toISOString() })
              }
            }
          }
        } finally {
          await db.$disconnect()
          const canonical = await realpath(root).catch(() => null)
          if (canonical && isAbsolute(canonical)) {
            const offset = relative(resolve(tmpdir()), canonical)
            if (offset && !offset.startsWith('..') && !isAbsolute(offset)) {
              await rm(canonical, { recursive: true, force: true })
            }
          }
        }
      }
    }
  })
test('W63 temporal PublicOperation has fenced phases and database rejects wrong target or progress',
  { skip: !process.env.V2_DATABASE_URL, timeout: 120_000 }, async () => {
    const db = new PrismaClient()
    let cleanup
    try {
      const world = await seedPerceptionProducerContext(db)
      const audit = createApiAccessAuditContext({ clientId: world.clientId,
        credentialId: `w63-credential-${world.suffix}`, workspaceId: world.workspaceId,
        environment: 'production', authenticationKind: 'bearer' })
      const source = await new PrismaPerceptionProducerRequestContextRepository(db).read({
        workspaceId: world.workspaceId, projectId: world.projectId,
        projectVersionId: world.versionId, sourceArtifactId: world.sourceId,
      })
      assert.ok(source)
      const requestFingerprint = calculateCanonicalHash({ kind: 'perception-temporal-run/v1',
        workspaceId: world.workspaceId, projectId: world.projectId,
        projectVersionId: world.versionId, sourceArtifactId: world.sourceId,
        actorContextHash: audit.contextHash })
      const operation = createQueuedPublicOperation({ id: `w63-operation-${randomUUID()}`,
        workspaceId: world.workspaceId, projectId: world.projectId, clientId: world.clientId,
        type: 'perception-temporal-run', target: { type: 'project-version', id: world.versionId },
        createdAt: new Date().toISOString() })
      const operations = new PrismaPublicOperationRepository(db)
      cleanup = { operations, workspaceId: world.workspaceId, audit, operationIds: [operation.id] }
      await operations.createOrReplay({ operation, authenticationAudit: audit,
        context: { kind: 'perception-temporal-run', ...source, requestHash: requestFingerprint },
        idempotencyKey: `w63-temporal-${world.suffix}`, requestFingerprint })
      const stored = await operations.findById(world.workspaceId, operation.id)
      assert.equal(stored.operation.type, 'perception-temporal-run')
      assert.equal(stored.context.kind, 'perception-temporal-run')
      const row = await db.v2PublicOperation.findUniqueOrThrow({ where: { id: operation.id } })
      await assert.rejects(db.v2PublicOperation.update({ where: { id: operation.id },
        data: { targetType: 'media-artifact' } }), /constraint|check/i)
      await assert.rejects(db.v2PublicOperation.update({ where: { id: operation.id },
        data: { progressTotal: 5 } }), /constraint|check/i)
      assert.equal((await db.v2PublicOperation.findUniqueOrThrow({ where: { id: operation.id } })).targetType,
        row.targetType)
      const producer = new PrismaTemporalProducerEnvelopeRepository(db)
      const claim = await producer.claimNext({ leaseOwner: `w63-owner-${world.suffix}`,
        now: new Date(), leaseMs: 30_000 })
      assert.equal(claim?.operationId, operation.id)
      assert.equal(claim.timeMap[0].rate, 1)
      await assert.rejects(db.v2PublicOperation.update({ where: { id: operation.id },
        data: { phase: 'transcribing', progressCompleted: 1 } }), /constraint|check/i)
      assert.equal(await producer.advancePhase({ operationId: operation.id, attempt: claim.attempt,
        leaseOwner: `w63-owner-${world.suffix}`, now: new Date(), phase: 'analyzing' }), true)
      assert.equal((await operations.findById(world.workspaceId, operation.id)).operation.phase, 'analyzing')
      assert.equal(await producer.failAttempt({ operationId: operation.id, attempt: claim.attempt,
        leaseOwner: `w63-owner-${world.suffix}`, now: new Date(),
        errorCode: 'INVALID_ARGUMENT', errorMessage: 'Controlled unsupported source', retryable: false }), true)
      assert.equal((await operations.findById(world.workspaceId, operation.id)).operation.status, 'failed')
      const events = await db.v2PublicEventOutbox.findMany({ where: {
        workspaceId: world.workspaceId, resourceId: operation.id }, orderBy: { sequence: 'asc' } })
      assert.ok(events.some((event) => event.type === 'operation.failed'))
      const retryAt = new Date(Date.now() + 1000)
      const retried = await operations.retry({ workspaceId: world.workspaceId,
        operationId: operation.id, commandId: `w63-retry-${world.suffix}`,
        authenticationAudit: audit, requestedAt: retryAt.toISOString(),
        nextAttemptAt: new Date(retryAt.getTime() + 1000).toISOString() })
      assert.equal(retried.operation.status, 'retrying')
      const canceled = await operations.cancel({ workspaceId: world.workspaceId,
        operationId: operation.id, commandId: `w63-cancel-${world.suffix}`,
        authenticationAudit: audit, canceledAt: new Date(retryAt.getTime() + 2000).toISOString() })
      assert.equal(canceled.operation.status, 'canceled')

      const revokedOperation = createQueuedPublicOperation({
        id: `w63-operation-${randomUUID()}`, workspaceId: world.workspaceId,
        projectId: world.projectId, clientId: world.clientId, type: 'perception-temporal-run',
        target: { type: 'project-version', id: world.versionId }, createdAt: new Date().toISOString(),
      })
      cleanup.operationIds.push(revokedOperation.id)
      await operations.createOrReplay({ operation: revokedOperation, authenticationAudit: audit,
        context: { kind: 'perception-temporal-run', ...source, requestHash: requestFingerprint },
        idempotencyKey: `w63-revoked-${world.suffix}`, requestFingerprint })
      await db.v2MediaArtifact.update({ where: { id: world.sourceId },
        data: { currentRightsSnapshotId: null, rightsRevision: 2 } })
      assert.equal(await producer.claimNext({ leaseOwner: `w63-revoked-${world.suffix}`,
        now: new Date(), leaseMs: 30_000 }), null)
      const revoked = await operations.findById(world.workspaceId, revokedOperation.id)
      assert.equal(revoked.operation.status, 'failed')
      assert.equal(revoked.operation.error.code, 'invalid_producer_context')
      assert.equal(await db.v2TemporalProducerEnvelope.count({ where: { operationId: revokedOperation.id } }), 0)
    } finally {
      try {
        if (cleanup) for (const operationId of cleanup.operationIds) {
          const stored = await cleanup.operations.findById(cleanup.workspaceId, operationId)
          if (stored && ['queued', 'running', 'waiting', 'retrying'].includes(stored.operation.status)) {
            await cleanup.operations.cancel({ workspaceId: cleanup.workspaceId, operationId,
              commandId: `w63-cleanup-${randomUUID()}`, authenticationAudit: cleanup.audit,
              canceledAt: new Date().toISOString() })
          }
        }
      } finally { await db.$disconnect() }
    }
  })
