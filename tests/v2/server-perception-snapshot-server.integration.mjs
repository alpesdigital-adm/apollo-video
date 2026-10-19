import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import net from 'node:net'
import { join } from 'node:path'
import test from 'node:test'

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { coverageOf, seedSnapshotWorld } from './helpers/server-perception-pg-world.mjs'
import { seedPerceptionProducerContext } from './helpers/perception-producer-pg-world.mjs'

// Under tsx a static named import of a TypeScript module is not visible to Node (the module runs as CommonJS), so these are dynamic.
const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')

/**
 * W63a: GET /v1/projects/{projectId}/perception/snapshot through a REAL Next server (`next start` on a production build), over a
 * PostgreSQL world with sealed OCR, temporal and face evidence written by the products' own writers (supervised harness with
 * `--build`; not run in hosted CI). The in-process route suite proves the cases; this one proves the same contract survives the
 * framework: routing of the nested path, authentication on the wire, the published schema served by the API itself, and the
 * OpenAPI document that lists the path.
 */
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
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (state.spawnError) throw state.spawnError
    if (state.closed || child.exitCode !== null || child.signalCode !== null) throw new Error(`Next exited: ${child.exitCode}`)
    try { if ((await fetch(`${base}/v1/health`, { signal: AbortSignal.timeout(1500) })).ok) return }
    catch { /* startup pending */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Next HTTP server did not become ready')
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const closed = new Promise((resolve) => child.once('close', resolve))
  child.kill('SIGTERM')
  const stopped = await Promise.race([closed.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5000))])
  if (stopped) return
  child.kill('SIGKILL')
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5000))])
}

test('W63a real Next server: the snapshot route, its published schema and the OpenAPI path agree, with auth on the wire',
  { skip: !process.env.V2_DATABASE_URL || process.env.APOLLO_SNAPSHOT_SERVER_E2E !== '1', timeout: 600_000 }, async () => {
    const db = new PrismaClient()
    let server, serverLog, primaryError
    try {
      const built = await seedSnapshotWorld(db)
      const { world } = built
      const other = await seedPerceptionProducerContext(db, { durationFrames: 120 })
      const issue = createApiClientService({ repository: new PrismaApiClientRepository(db), credentialCrypto: nodeApiCredentialCrypto, clock: () => new Date() })
      const token = async (id, workspaceId, scopes) => (await issue({ id: `w63a-srv-${id}-${world.suffix}`,
        credentialId: `w63a-srv-${id}-credential-${world.suffix}`, workspaceId, name: `W63a server ${id}`, environment: 'production', scopes })).token
      const reader = await token('reader', world.workspaceId, ['projects:read'])
      const noScope = await token('noscope', world.workspaceId, ['artifacts:read'])
      const stranger = await token('stranger', other.workspaceId, ['projects:read'])

      const port = await freePort()
      const base = `http://127.0.0.1:${port}`
      const evidenceRoot = process.env.APOLLO_LIBRARY_EVIDENCE_ROOT
      if (evidenceRoot) await mkdir(evidenceRoot, { recursive: true })
      if (evidenceRoot) serverLog = createWriteStream(join(evidenceRoot, `snapshot-server-${world.suffix}.log`))
      server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)], {
        cwd: process.cwd(), windowsHide: true,
        env: { ...process.env, NODE_ENV: 'production', __NEXT_PROCESSED_ENV: 'true', APOLLO_API_ENVIRONMENT: 'production', NEXT_TELEMETRY_DISABLED: '1',
          APOLLO_GOVERNANCE_ANOMALY_REQUEST_MINIMUM: '2000000000', APOLLO_GOVERNANCE_ANOMALY_SPEND_MINIMUM_MINOR_UNITS: '2000000000' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const state = { closed: false, spawnError: null }
      server.once('error', (error) => { state.spawnError = error })
      server.once('close', () => { state.closed = true })
      assert.ok(Number.isSafeInteger(server.pid) && server.pid > 0, 'Next spawn must have an owned PID')
      console.log(`W63a Next owned PID ${server.pid}`)
      if (serverLog) { server.stdout.pipe(serverLog, { end: false }); server.stderr.pipe(serverLog, { end: false }) }
      else { server.stdout.resume(); server.stderr.resume() }
      await waitForServer(base, server, state)

      const call = async (path, who) => {
        const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(30_000), headers: who ? { authorization: `Bearer ${who}` } : {} })
        return { status: response.status, headers: response.headers, body: await response.json() }
      }
      const route = `/v1/projects/${world.projectId}/perception/snapshot`
      const schemaResponse = await fetch(`${base}/v1/schemas/server-perception-snapshot-response/v1`, { signal: AbortSignal.timeout(15_000) })
      assert.equal(schemaResponse.status, 200)
      const ajv = addFormats(new Ajv2020({ strict: false, allErrors: true }))
      const validate = ajv.compile(await schemaResponse.json())

      const full = await call(route, reader)
      assert.equal(full.status, 200, JSON.stringify(full.body))
      assert.equal(validate(full.body), true, ajv.errorsText(validate.errors))
      assert.ok(full.headers.get('x-request-id'), 'the response is traceable')
      assert.deepEqual(full.body.data.origin, { kind: 'server-assembled', manualTimelinesIncluded: false })
      assert.deepEqual(Object.fromEntries(full.body.data.result.coverage.map((entry) => [entry.kind, entry.state])), {
        'transcript-word': 'partial', speaker: 'absent', silence: 'absent', face: 'partial', object: 'absent',
        shot: 'partial', motion: 'partial', ocr: 'partial', 'image-insert': 'absent' })
      const clipped = await call(`${route}?fromMs=1000&toMs=2000&kinds=ocr,object`, reader)
      assert.equal(clipped.status, 200)
      assert.equal(validate(clipped.body), true, ajv.errorsText(validate.errors))
      assert.deepEqual(coverageOf(clipped.body.data, 'ocr').ranges, [[1_000, 1_033]])
      assert.equal(coverageOf(clipped.body.data, 'object').reasonCode, 'NO_VERIFIED_DETECTOR')
      assert.equal((await call(route, null)).status, 401)
      assert.equal((await call(route, noScope)).status, 403)
      const foreign = await call(route, stranger)
      assert.equal(foreign.status, 404)
      assert.equal(JSON.stringify(foreign.body).includes(full.body.data.snapshot.snapshotHash), false)
      assert.equal((await call(`${route}?kinds=lighting`, reader)).status, 422)

      const openapi = await call('/v1/openapi.json', null)
      assert.equal(openapi.status, 200)
      const operation = openapi.body.paths['/v1/projects/{projectId}/perception/snapshot']?.get
      assert.ok(operation, 'the OpenAPI document lists the path')
      assert.equal(operation['x-apollo-capability-id'], 'apollo.projects.perception.snapshot.read')
      assert.equal(operation['x-apollo-capability-version'], '1.0.0')
      assert.deepEqual(operation['x-apollo-required-scopes'], ['projects:read'])
      assert.deepEqual(operation.parameters.map((parameter) => parameter.name).filter((name) => name !== 'projectId').sort(),
        ['fromMs', 'kinds', 'toMs', 'versionId'])
    } catch (error) {
      primaryError = error
    } finally {
      try { await stopServer(server) } catch (error) { primaryError ??= error }
      serverLog?.end()
      try { await db.$disconnect() } catch (error) { primaryError ??= error }
      if (primaryError) throw primaryError
    }
  })
