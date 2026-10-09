import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { createApiClientService } from '../../src/v2/application/create-api-client.ts'
import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { cancelPublicOperationService } from '../../src/v2/application/cancel-public-operation.ts'
import { PrismaApiClientRepository } from '../../src/v2/infrastructure/prisma/api-client-repository.ts'
import { PrismaPublicOperationRepository } from '../../src/v2/infrastructure/prisma/public-operation-repository.ts'
import { nodeApiCredentialCrypto } from '../../src/v2/infrastructure/security/api-credential.ts'
import { seedPerceptionProducerContext } from './helpers/perception-producer-pg-world.mjs'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const exec = promisify(execFile)
const expectedVideoSha = 'a6f255543f3b135ab51a463865625a09b5672d352cc97ac175de11619a5f38f7'

function actorFor(world) {
  const auditContext = createExternalAuditContext({ clientId: world.clientId,
    credentialId: `face-http-cleanup-${world.suffix}`, workspaceId: world.workspaceId,
    environment: 'production' })
  return { ...auditContext, scopes: new Set(['operations:cancel']),
    authenticationKind: 'bearer', clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false, clientAccessStatus: 'active',
    workspaceAccessStatus: 'active', auditContext }
}

async function freePort() {
  return new Promise((done, reject) => {
    const listener = net.createServer()
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address()
      listener.close((error) => error ? reject(error) : done(address.port))
    })
  })
}

function scopedDatabaseUrl(raw, suffix) {
  const url = new URL(raw)
  const base = url.searchParams.get('application_name')
  assert.ok(base && base.length + suffix.length <= 63, 'PostgreSQL application_name must fit 63 bytes')
  url.searchParams.set('application_name', `${base}${suffix}`)
  url.searchParams.set('connection_limit', '1')
  return url.toString()
}

async function stopChild(child, label) {
  if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0) return
  if (child.exitCode === null && child.signalCode === null) {
    const closed = new Promise((done) => child.once('close', done))
    child.kill('SIGTERM')
    const stopped = await Promise.race([closed.then(() => true),
      new Promise((done) => setTimeout(() => done(false), 10_000))])
    if (!stopped) {
      child.kill('SIGKILL')
      assert.equal(await Promise.race([closed.then(() => true),
        new Promise((done) => setTimeout(() => done(false), 5_000))]), true,
      `${label} must close after SIGKILL`)
    }
  }
  assert.throws(() => process.kill(child.pid, 0), /ESRCH|not found/i,
    `${label} PID must be terminal`)
  if (process.platform === 'win32') {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${child.pid}" | Select-Object -ExpandProperty ProcessId`],
    { windowsHide: true, timeout: 10_000 })
    assert.equal(stdout.trim(), '', `${label} descendants must be terminal`)
  }
}

async function waitForServer(baseUrl, child, state) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (state.spawnError) throw state.spawnError
    if (state.closed || child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Next exited before readiness: ${child.exitCode}`)
    }
    try { if ((await fetch(`${baseUrl}/v1/health`, { signal: AbortSignal.timeout(1500) })).ok) return }
    catch { /* readiness pending */ }
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error('Next HTTP server did not become ready')
}

test('W61 HTTP face POST, real diagnostic runner, sealed GET and fail-closed controls',
  { skip: !process.env.V2_DATABASE_URL || process.env.APOLLO_FACE_HTTP_E2E !== '1', timeout: 210_000 }, async () => {
    const required = ['W61_FACE_DEV_VIDEO', 'W61_FACE_DEV_LINEAGE', 'W61_FACE_DEV_LANDING',
      'W61_PYTHON', 'W61_PYDEPS', 'W61_YUNET_MODEL', 'W61_OPENCV_BINARY',
      'W61_FFMPEG', 'W61_FFPROBE', 'W61_YUNET_LICENSE', 'APOLLO_LIBRARY_EVIDENCE_ROOT']
    for (const key of required) assert.ok(isAbsolute(process.env[key] ?? ''), `${key} must be absolute`)
    const videoBytes = await readFile(process.env.W61_FACE_DEV_VIDEO)
    const lineage = JSON.parse(await readFile(process.env.W61_FACE_DEV_LINEAGE, 'utf8'))
    assert.equal(sha(videoBytes), expectedVideoSha)
    assert.equal(lineage.videoSha256, expectedVideoSha)
    assert.equal(lineage.imageId, 'eb03b32d7c7c6b7a')
    assert.equal(lineage.license, 'https://creativecommons.org/licenses/by/2.0/')
    assert.equal(sha(await readFile(process.env.W61_FACE_DEV_LANDING)), lineage.landingSha256)

    const db = new PrismaClient()
    const root = await mkdtemp(join(tmpdir(), 'apollo-face-http-'))
    let server, worker, serverLog, workerLog, world, operationId
    let primaryError
    try {
      const suffix = randomUUID().slice(0, 8)
      const workspaceId = `w61-admission-${suffix}`
      const artifactKey = `${workspaceId}/source.mp4`
      await mkdir(join(root, workspaceId), { recursive: true })
      await copyFile(process.env.W61_FACE_DEV_VIDEO, join(root, artifactKey))
      world = await seedPerceptionProducerContext(db, { suffix, artifactKey,
        sourceSha256: expectedVideoSha, byteSize: BigInt(videoBytes.length) })
      const issue = createApiClientService({ repository: new PrismaApiClientRepository(db),
        credentialCrypto: nodeApiCredentialCrypto, clock: () => new Date() })
      const scopes = ['projects:read', 'projects:write', 'operations:read', 'operations:cancel', 'operations:retry']
      const token = (await issue({ id: `face-http-a-${suffix}`,
        credentialId: `face-http-a-credential-${suffix}`, workspaceId: world.workspaceId,
        name: 'Face HTTP A', environment: 'production', scopes })).token
      const readOnlyToken = (await issue({ id: `face-http-readonly-${suffix}`,
        credentialId: `face-http-readonly-credential-${suffix}`, workspaceId: world.workspaceId,
        name: 'Face HTTP read only', environment: 'production', scopes: ['projects:read'] })).token
      const foreignToken = (await issue({ id: `face-http-b-${suffix}`,
        credentialId: `face-http-b-credential-${suffix}`, workspaceId: world.otherWorkspaceId,
        name: 'Face HTTP B', environment: 'production', scopes })).token
      const port = await freePort()
      const base = `http://127.0.0.1:${port}`
      serverLog = createWriteStream(join(process.env.APOLLO_LIBRARY_EVIDENCE_ROOT, 'face-http-next.log'))
      server = spawn(process.execPath,
        ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)], {
          cwd: process.cwd(), windowsHide: true,
          env: { ...process.env, APOLLO_V2_ARTIFACT_ROOT: root,
            APOLLO_V2_ARTIFACT_STORAGE_DRIVER: 'local', NODE_ENV: 'production',
            V2_DATABASE_URL: scopedDatabaseUrl(process.env.V2_DATABASE_URL, '-face-http-next'),
            __NEXT_PROCESSED_ENV: 'true', APOLLO_API_ENVIRONMENT: 'production',
            NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
        })
      const serverState = { closed: false, spawnError: null }
      server.once('error', (error) => { serverState.spawnError = error })
      server.once('close', () => { serverState.closed = true })
      assert.ok(Number.isSafeInteger(server.pid) && server.pid > 0)
      console.log(`W61 face HTTP Next owned PID ${server.pid}`)
      server.stdout.pipe(serverLog, { end: false })
      server.stderr.pipe(serverLog, { end: false })
      await waitForServer(base, server, serverState)
      const request = async (auth, path, method = 'GET', body, key) => {
        const response = await fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(20_000),
          headers: { authorization: `Bearer ${auth}`,
            ...(body ? { 'content-type': 'application/json' } : {}),
            ...(key ? { 'idempotency-key': key } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}) })
        return { status: response.status, body: await response.json() }
      }
      const ajv = new Ajv2020({ strict: false, allErrors: true })
      addFormats(ajv)
      const schemaFor = async (id) => {
        const response = await fetch(`${base}/v1/schemas/${id}/v1`, { signal: AbortSignal.timeout(15_000) })
        assert.equal(response.status, 200)
        return ajv.compile(await response.json())
      }
      const validateCreated = await schemaFor('face-producer-operation-created')
      const validateRead = await schemaFor('face-producer-operation-read')
      const assertSchema = (validate, body) => assert.equal(validate(body), true,
        JSON.stringify(validate.errors))
      const route = `/v1/projects/${world.projectId}/face-producer-operations`
      const body = { projectVersionId: world.versionId, sourceArtifactId: world.sourceId,
        sampleIntervalFrames: 30 }
      const key = `face-http-key-${world.suffix}`
      const anonymous = await fetch(`${base}${route}`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': `face-anon-${suffix}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
      assert.equal(anonymous.status, 401)
      assert.equal((await anonymous.json()).error.code, 'AUTH_INVALID')
      const noWrite = await request(readOnlyToken, route, 'POST', body, `face-readonly-${suffix}`)
      assert.equal(noWrite.status, 403)
      assert.equal(noWrite.body.error.code, 'AUTH_SCOPE_REQUIRED')
      const foreignCreate = await request(foreignToken, route, 'POST', body, `face-foreign-${suffix}`)
      assert.equal(foreignCreate.status, 428)
      assert.equal(foreignCreate.body.error.code, 'PRECONDITION_REQUIRED')
      const concurrent = await Promise.all(Array.from({ length: 4 }, () =>
        request(token, route, 'POST', body, key)))
      assert.equal(concurrent.every((result) => [200, 202].includes(result.status)), true,
        JSON.stringify(concurrent))
      for (const result of concurrent) assertSchema(validateCreated, result.body)
      assert.equal(concurrent.filter((result) => result.status === 202).length, 1)
      const ids = concurrent.map((result) => result.body.data.operation.id)
      assert.equal(new Set(ids).size, 1)
      operationId = ids[0]
      assert.equal(await db.v2FaceProducerOperation.count({ where: { operationId } }), 1)
      const replay = await request(token, route, 'POST', body, key)
      assert.equal(replay.status, 200)
      assertSchema(validateCreated, replay.body)
      assert.equal(replay.body.data.replayed, true)
      const mismatch = await request(token, route, 'POST', { ...body, sampleIntervalFrames: 31 }, key)
      assert.equal(mismatch.status, 409)
      assert.equal(mismatch.body.error.code, 'IDEMPOTENCY_PAYLOAD_MISMATCH')
      for (const spoof of [{ ...body, trusted: true }, { ...body, sourceSha256: expectedVideoSha }]) {
        const denied = await request(token, route, 'POST', spoof, `face-spoof-${randomUUID()}`)
        assert.equal(denied.status, 422)
        assert.equal(denied.body.error.code, 'INVALID_ARGUMENT')
      }
      const queued = await request(token, `${route}/${operationId}`)
      assert.equal(queued.status, 200)
      assertSchema(validateRead, queued.body)
      assert.equal(queued.body.data.operation.status, 'queued')
      assert.equal(Object.hasOwn(queued.body.data, 'envelope'), false)
      assert.equal((await request(foreignToken, `${route}/${operationId}`)).status, 404)
      assert.equal((await request(foreignToken, `/v1/operations/${operationId}/cancel`, 'POST')).status, 404)

      const runtime = {
        APOLLO_V2_ARTIFACT_ROOT: root, APOLLO_V2_ARTIFACT_STORAGE_DRIVER: 'local',
        APOLLO_V2_FACE_PYTHON_BIN: process.env.W61_PYTHON,
        APOLLO_V2_FACE_PYTHON_SHA256: sha(await readFile(process.env.W61_PYTHON)),
        APOLLO_V2_FACE_PYTHON_MODULE_DIR: process.env.W61_PYDEPS,
        APOLLO_V2_FACE_MODEL_BIN: process.env.W61_YUNET_MODEL,
        APOLLO_V2_FACE_BRIDGE_SCRIPT: resolve('src/v2/infrastructure/perception/yunet_cpu_bridge.py'),
        APOLLO_V2_FACE_OPENCV_BINARY: process.env.W61_OPENCV_BINARY,
        APOLLO_V2_FACE_OPENCV_SHA256: sha(await readFile(process.env.W61_OPENCV_BINARY)),
        APOLLO_V2_FACE_FFMPEG_BIN: process.env.W61_FFMPEG,
        APOLLO_V2_FACE_FFMPEG_SHA256: sha(await readFile(process.env.W61_FFMPEG)),
        APOLLO_V2_FACE_FFPROBE_BIN: process.env.W61_FFPROBE,
        APOLLO_V2_FACE_FFPROBE_SHA256: sha(await readFile(process.env.W61_FFPROBE)),
        APOLLO_V2_FACE_MODEL_LICENSE: process.env.W61_YUNET_LICENSE,
        APOLLO_V2_FACE_MODEL_LICENSE_SHA256: sha(await readFile(process.env.W61_YUNET_LICENSE)),
        APOLLO_V2_FACE_POLL_MS: '100',
      }
      runtime.APOLLO_V2_FACE_BRIDGE_SHA256 = sha(await readFile(runtime.APOLLO_V2_FACE_BRIDGE_SCRIPT))
      workerLog = createWriteStream(join(process.env.APOLLO_LIBRARY_EVIDENCE_ROOT, 'face-http-worker.log'))
      worker = spawn(process.execPath, ['--import', 'tsx', 'scripts/run-v2-face-producer-worker.mjs'], {
        cwd: process.cwd(), windowsHide: true, env: { ...process.env, ...runtime,
          V2_DATABASE_URL: scopedDatabaseUrl(process.env.V2_DATABASE_URL, '-face-http-worker') },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const workerState = { closed: false, spawnError: null }
      worker.once('error', (error) => { workerState.spawnError = error })
      worker.once('close', () => { workerState.closed = true })
      assert.ok(Number.isSafeInteger(worker.pid) && worker.pid > 0)
      console.log(`W61 face HTTP worker owned PID ${worker.pid}`)
      worker.stdout.pipe(workerLog, { end: false })
      worker.stderr.pipe(workerLog, { end: false })
      const operations = new PrismaPublicOperationRepository(db)
      const deadline = Date.now() + 120_000
      let stored
      while (Date.now() < deadline) {
        if (workerState.spawnError) throw workerState.spawnError
        stored = await operations.findById(world.workspaceId, operationId)
        if (stored?.operation.status === 'succeeded' || stored?.operation.status === 'failed' ||
            workerState.closed) break
        await new Promise((done) => setTimeout(done, 250))
      }
      assert.equal(stored?.operation.status, 'succeeded', 'real face worker must publish diagnostic envelope')
      await stopChild(worker, 'face worker')
      worker = null
      const completed = await request(token, `${route}/${operationId}`)
      assert.equal(completed.status, 200, JSON.stringify(completed.body))
      assertSchema(validateRead, completed.body)
      assert.equal(completed.body.data.operation.status, 'succeeded')
      const envelope = completed.body.data.envelope
      assert.equal(envelope.authority, 'server-produced')
      assert.equal(envelope.faceSafety, 'unknown')
      assert.equal(envelope.producer.assessment.status, 'failed-gate')
      assert.equal(envelope.identity, 'not-performed')
      assert.equal(envelope.sourceSha256, expectedVideoSha)
      assert.deepEqual(envelope.samples.map((sample) => sample.sourceFrame), [0, 30, 60, 90])
      assert.ok(envelope.samples.some((sample) => sample.status === 'observed' && sample.boxes.length > 0))
      await writeFile(join(process.env.APOLLO_LIBRARY_EVIDENCE_ROOT, 'face-http-response.json'),
        JSON.stringify(completed.body, null, 2))
      await writeFile(join(process.env.APOLLO_LIBRARY_EVIDENCE_ROOT, 'face-http-samples.json'),
        JSON.stringify({ operationId, sourceSha256: envelope.sourceSha256,
          envelopeHash: envelope.envelopeHash, faceSafety: envelope.faceSafety,
          assessment: envelope.producer.assessment.status,
          samples: envelope.samples.map((sample) => ({ sourceFrame: sample.sourceFrame,
            sourcePts: sample.sourcePts, sourcePtsEvidenceHash: sample.sourcePtsEvidenceHash,
            imageSha256: sample.imageSha256,
            status: sample.status, boxCount: sample.boxes.length })) }, null, 2))
      assert.equal((await request(foreignToken, `${route}/${operationId}`)).status, 404)

      await db.v2MediaArtifact.update({ where: { id: world.sourceId },
        data: { currentRightsSnapshotId: null, rightsRevision: 2 } })
      const revoked = await request(token, `${route}/${operationId}`)
      assert.notEqual(revoked.status, 200)
      assert.equal(Object.hasOwn(revoked.body.data ?? {}, 'envelope'), false)
    } catch (error) {
      primaryError = error
    } finally {
      const cleanupErrors = []
      try { await stopChild(worker, 'face worker') } catch (error) { cleanupErrors.push(error) }
      try { await stopChild(server, 'Next server') } catch (error) { cleanupErrors.push(error) }
      for (const log of [workerLog, serverLog]) {
        if (log) try { await new Promise((done) => log.end(done)) }
        catch (error) { cleanupErrors.push(error) }
      }
      if (world) {
        try {
          const rows = await db.v2PublicOperation.findMany({ where: {
            workspaceId: world.workspaceId, type: 'perception-face-run' } })
          for (const row of rows) {
            if (['queued', 'running', 'waiting', 'retrying'].includes(row.status)) {
              const canceledAt = new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1,
                (row.nextAttemptAt?.getTime() ?? 0) + 1))
              const canceled = await cancelPublicOperationService({
                operations: new PrismaPublicOperationRepository(db), clock: () => canceledAt,
              })({ workspaceId: world.workspaceId, operationId: row.id, actor: actorFor(world) })
              assert.equal(canceled.status, 'canceled')
            }
          }
          const remaining = await db.v2PublicOperation.count({ where: {
            workspaceId: world.workspaceId, type: 'perception-face-run',
            status: { in: ['queued', 'running', 'waiting', 'retrying'] } } })
          assert.equal(remaining, 0, 'face HTTP fixture left active operations')
        } catch (error) { cleanupErrors.push(error) }
      }
      try { await db.$disconnect() } catch (error) { cleanupErrors.push(error) }
      try {
        const canonical = await realpath(root).catch(() => null)
        if (canonical && isAbsolute(canonical)) {
          const offset = relative(resolve(tmpdir()), canonical)
          if (offset && !offset.startsWith('..') && !isAbsolute(offset)) {
            await rm(canonical, { recursive: true, force: true })
          }
        }
      } catch (error) { cleanupErrors.push(error) }
      if (primaryError && cleanupErrors.length) throw new AggregateError([primaryError, ...cleanupErrors])
      if (primaryError) throw primaryError
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors)
    }
  })
