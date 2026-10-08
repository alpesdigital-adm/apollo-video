import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { createApiClientService } from '../../src/v2/application/create-api-client.ts'
import { createApiAccessAuditContext } from '../../src/v2/domain/api-access-control.ts'
import { PrismaApiClientRepository } from '../../src/v2/infrastructure/prisma/api-client-repository.ts'
import { PrismaPublicOperationRepository } from '../../src/v2/infrastructure/prisma/public-operation-repository.ts'
import { nodeApiCredentialCrypto } from '../../src/v2/infrastructure/security/api-credential.ts'
import { seedPerceptionProducerContext } from './helpers/perception-producer-pg-world.mjs'

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

async function waitForServer(baseUrl, child, state) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (state.spawnError) throw state.spawnError
    if (state.closed || child.exitCode !== null || child.signalCode !== null) throw new Error(`Next exited: ${child.exitCode}`)
    try { if ((await fetch(`${baseUrl}/v1/health`, { signal: AbortSignal.timeout(1500) })).ok) return }
    catch { /* startup pending */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Next HTTP server did not become ready')
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const closed = new Promise((resolve) => child.once('close', resolve))
  child.kill('SIGTERM')
  const stopped = await Promise.race([closed.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 3000))])
  if (stopped) return
  child.kill('SIGKILL')
  assert.notEqual(await Promise.race([closed.then(() => 'closed'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 3000))]), 'timeout')
}

test('W61 HTTP producer POST converges, fences workspaces and serves only a sealed succeeded envelope',
  { skip: !process.env.V2_DATABASE_URL || process.env.APOLLO_PERCEPTION_HTTP_E2E !== '1', timeout: 180_000 }, async () => {
    const db = new PrismaClient()
    let server
    let serverLog
    let cleanupScope
    try {
      const world = await seedPerceptionProducerContext(db)
      cleanupScope = { workspaceId: world.workspaceId, clientId: world.clientId, suffix: world.suffix }
      const issue = createApiClientService({ repository: new PrismaApiClientRepository(db),
        credentialCrypto: nodeApiCredentialCrypto, clock: () => new Date() })
      const scopes = ['projects:read', 'projects:write', 'operations:read', 'operations:cancel', 'operations:retry']
      const tokenA = (await issue({ id: `w61-http-a-${world.suffix}`,
        credentialId: `w61-http-a-credential-${world.suffix}`, workspaceId: world.workspaceId,
        name: 'W61 HTTP A', environment: 'production', scopes })).token
      const tokenB = (await issue({ id: `w61-http-b-${world.suffix}`,
        credentialId: `w61-http-b-credential-${world.suffix}`, workspaceId: world.otherWorkspaceId,
        name: 'W61 HTTP B', environment: 'production', scopes })).token
      const port = await freePort()
      const base = `http://127.0.0.1:${port}`
      const logPath = join(process.env.APOLLO_LIBRARY_EVIDENCE_ROOT, 'perception-http-server.log')
      serverLog = createWriteStream(logPath)
      server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)], {
        cwd: process.cwd(), windowsHide: true,
        env: { ...process.env, NODE_ENV: 'production', __NEXT_PROCESSED_ENV: 'true',
          APOLLO_API_ENVIRONMENT: 'production', NEXT_TELEMETRY_DISABLED: '1',
          APOLLO_GOVERNANCE_ANOMALY_REQUEST_MINIMUM: '2000000000',
          APOLLO_GOVERNANCE_ANOMALY_SPEND_MINIMUM_MINOR_UNITS: '2000000000' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const serverState = { closed: false, spawnError: null }
      server.once('error', (error) => { serverState.spawnError = error })
      server.once('close', () => { serverState.closed = true })
      assert.ok(Number.isSafeInteger(server.pid) && server.pid > 0, 'Next spawn must have an owned PID')
      console.log(`W61 HTTP Next owned PID ${server.pid}`)
      server.stdout.pipe(serverLog, { end: false })
      server.stderr.pipe(serverLog, { end: false })
      await waitForServer(base, server, serverState)
      const request = async (token, path, method = 'GET', body, key) => {
        const response = await fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(20_000),
          headers: { authorization: `Bearer ${token}`,
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
      const validateCreated = await schemaFor('perception-producer-operation-created')
      const validateRead = await schemaFor('perception-producer-operation-read')
      const assertSchema = (validate, body) => assert.equal(validate(body), true,
        JSON.stringify(validate.errors))
      const route = `/v1/projects/${world.projectId}/perception-producer-operations`
      const body = { projectVersionId: world.versionId, sourceArtifactId: world.sourceId,
        sampleIntervalFrames: 30 }
      const key = `w61-http-key-${world.suffix}`
      const concurrent = await Promise.all(Array.from({ length: 4 }, () =>
        request(tokenA, route, 'POST', body, key)))
      assert.equal(concurrent.every((result) => [200, 202].includes(result.status)), true,
        JSON.stringify(concurrent))
      for (const result of concurrent) assertSchema(validateCreated, result.body)
      const ids = concurrent.map((result) => result.body.data.operation.id)
      assert.equal(new Set(ids).size, 1)
      assert.equal(concurrent.filter((result) => result.status === 202).length, 1)
      const operationId = ids[0]
      assert.equal((await db.v2PerceptionProducerOperation.count({ where: { operationId } })), 1)
      const replay = await request(tokenA, route, 'POST', body, key)
      assert.equal(replay.status, 200)
      assertSchema(validateCreated, replay.body)
      assert.equal(replay.body.data.replayed, true)
      const mismatch = await request(tokenA, route, 'POST', { ...body, sampleIntervalFrames: 31 }, key)
      assert.equal(mismatch.status, 409)
      assert.equal(mismatch.body.error.code, 'IDEMPOTENCY_PAYLOAD_MISMATCH')
      const queued = await request(tokenA, `${route}/${operationId}`)
      assert.equal(queued.status, 200)
      assertSchema(validateRead, queued.body)
      assert.equal(queued.body.data.operation.status, 'queued')
      assert.equal(Object.hasOwn(queued.body.data, 'envelope'), false)
      for (const path of [`${route}/${operationId}`, `/v1/operations/${operationId}`]) {
        const denied = await request(tokenB, path)
        assert.equal(denied.status, 404)
      }
      for (const action of ['cancel', 'retry']) {
        const denied = await request(tokenB, `/v1/operations/${operationId}/${action}`, 'POST')
        assert.equal(denied.status, 404)
      }
      const canceled = await request(tokenA, `/v1/operations/${operationId}/cancel`, 'POST')
      assert.equal(canceled.status, 200)
      assert.equal(canceled.body.data.operation.status, 'canceled')

      // The preceding worker integration test produced this envelope from real
      // OCR media and restored its hash after its tamper rejection assertion.
      const succeeded = await db.v2PublicOperation.findFirst({ where: {
        type: 'perception-producer-run', status: 'succeeded',
        idempotencyKey: { startsWith: 'w61-real-ocr-' },
      }, orderBy: { createdAt: 'desc' } })
      assert.ok(succeeded, 'run the real OCR worker PG test before this HTTP test')
      const readerToken = (await issue({ id: `w61-http-reader-${randomUUID()}`,
        credentialId: `w61-http-reader-credential-${randomUUID()}`,
        workspaceId: succeeded.workspaceId, name: 'W61 envelope reader',
        environment: 'production', scopes: ['projects:read'] })).token
      const sealed = await request(readerToken,
        `/v1/projects/${succeeded.projectId}/perception-producer-operations/${succeeded.id}`)
      assert.equal(sealed.status, 200, JSON.stringify(sealed.body))
      assertSchema(validateRead, sealed.body)
      assert.equal(sealed.body.data.operation.status, 'succeeded')
      assert.equal(sealed.body.data.envelope.authority, 'server-produced')
      assert.equal(sealed.body.data.envelope.modality, 'ocr')
      assert.equal(sealed.body.data.envelope.faceSafety, 'unknown')
      assert.ok(sealed.body.data.envelope.samples.length > 0)
      const foreignEnvelope = await request(tokenB,
        `/v1/projects/${succeeded.projectId}/perception-producer-operations/${succeeded.id}`)
      assert.equal(foreignEnvelope.status, 404)
    } finally {
      try { await stopServer(server) }
      finally {
        if (serverLog) await new Promise((resolve) => serverLog.end(resolve))
        try {
          if (cleanupScope) {
            const { workspaceId, clientId, suffix } = cleanupScope
            const pending = await db.v2PublicOperation.findMany({
              where: { workspaceId, idempotencyKey: `w61-http-key-${suffix}` },
              select: { id: true, status: true },
            })
            const audit = createApiAccessAuditContext({ clientId,
              credentialId: `w61-http-cleanup-${suffix}`, workspaceId,
              environment: 'production', authenticationKind: 'bearer' })
            const operations = new PrismaPublicOperationRepository(db)
            for (const row of pending) {
              if (['queued', 'running', 'waiting', 'retrying'].includes(row.status)) {
                await operations.cancel({ workspaceId, operationId: row.id,
                  commandId: `w61-http-cleanup-${randomUUID()}`, authenticationAudit: audit,
                  canceledAt: new Date().toISOString() })
              }
            }
          }
        } finally { await db.$disconnect() }
      }
    }
  })
