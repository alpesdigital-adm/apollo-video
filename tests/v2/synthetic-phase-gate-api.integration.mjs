import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import net from 'node:net'
import test from 'node:test'
import { promisify } from 'node:util'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

const RUN = process.env.APOLLO_SYNTHETIC_PHASE_GATE_API_E2E === '1'
const SKIP = RUN
  ? false
  : 'set APOLLO_SYNTHETIC_PHASE_GATE_API_E2E=1 with a built app and migrated local E2E PostgreSQL'
const execFileAsync = promisify(execFile)

function assertSafeDatabaseUrl() {
  assert.ok(process.env.V2_DATABASE_URL, 'V2_DATABASE_URL must name a disposable local PostgreSQL')
  const url = new URL(process.env.V2_DATABASE_URL)
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(url.hostname))
  assert.match(url.pathname.slice(1), /(?:^|_)e2e(?:_|$)/)
  assert.match(
    url.searchParams.get('application_name') ?? '',
    /^apollo-video-e2e-synthetic-phase-gate-[a-z0-9-]+$/,
  )
  for (const [parameter, maximum] of [
    ['connection_limit', 5],
    ['pool_timeout', 10],
    ['connect_timeout', 10],
  ]) {
    const value = Number(url.searchParams.get(parameter))
    assert.ok(Number.isInteger(value) && value >= 1 && value <= maximum)
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

function boundedFetch(input, init, testSignal, timeoutMs = 10_000) {
  const signals = [testSignal, AbortSignal.timeout(timeoutMs)]
  if (init?.signal) signals.push(init.signal)
  return fetch(input, { ...init, signal: AbortSignal.any(signals) })
}

async function waitForServer(baseUrl, child, testSignal) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Next exited before readiness (${child.exitCode ?? child.signalCode})`)
    }
    try {
      if ((await boundedFetch(`${baseUrl}/v1/health`, undefined, testSignal, 1_000)).ok) return
    } catch {
      // The supervised local server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Next did not become ready')
}

async function childExitWithin(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return new Promise((resolve) => {
    let timer
    const finish = (exited) => {
      clearTimeout(timer)
      child.off('exit', onExit)
      resolve(exited)
    }
    const onExit = () => finish(true)
    child.once('exit', onExit)
    timer = setTimeout(() => finish(false), timeoutMs)
  })
}

function signalProcessGroup(child, signal) {
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    await execFileAsync(
      'taskkill.exe',
      ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, timeout: 15_000 },
    ).catch(() => undefined)
  } else {
    signalProcessGroup(child, 'SIGTERM')
  }
  const stopped = await childExitWithin(child, 5_000)
  if (stopped) return
  if (process.platform === 'win32') {
    await execFileAsync(
      'taskkill.exe',
      ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, timeout: 15_000 },
    ).catch(() => undefined)
  } else {
    signalProcessGroup(child, 'SIGKILL')
  }
  const forced = await childExitWithin(child, 10_000)
  assert.equal(forced, true, `Next process tree ${child.pid} did not stop`)
}

async function seedClient(prisma, issueApiCredential, {
  workspaceId,
  clientId,
  credentialId,
  scopes,
  now,
}) {
  const issued = issueApiCredential(clientId, credentialId)
  await prisma.v2ApiClient.create({
    data: {
      id: clientId,
      workspaceId,
      name: clientId,
      allowedEnvironmentsJson: '["production"]',
      scopeGrantsJson: JSON.stringify(scopes),
      createdBy: 'synthetic-phase-gate-api-e2e',
      createdAt: now,
      updatedAt: now,
    },
  })
  await prisma.v2ApiCredential.create({
    data: {
      id: credentialId,
      workspaceId,
      clientId,
      secretSalt: issued.secretSalt,
      secretHash: issued.secretHash,
      createdAt: now,
    },
  })
  return `Bearer ${issued.token}`
}

async function seedProjectVersion(prisma, {
  workspaceId,
  clientId,
  projectId,
  versionId,
  versionHash,
  now,
}) {
  await prisma.v2Project.create({
    data: {
      id: projectId,
      workspaceId,
      name: projectId,
      status: 'reviewing-proxy',
      objective: 'awareness',
      format: '16:9',
      locale: 'pt-BR',
      createdByType: 'api-client',
      createdById: clientId,
      createdAt: now,
      updatedAt: now,
    },
  })
  const snapshots = [
    { kind: 'brief', suffix: 'brief', hash: '1'.repeat(64), schemaVersion: 1 },
    { kind: 'edit-plan', suffix: 'edit-plan', hash: '2'.repeat(64), schemaVersion: 2 },
    { kind: 'policies', suffix: 'policies', hash: '3'.repeat(64), schemaVersion: 1 },
  ]
  await prisma.v2ProjectSnapshot.createMany({
    data: snapshots.map((snapshot) => ({
      id: `${projectId}-${snapshot.suffix}`,
      workspaceId,
      projectId,
      kind: snapshot.kind,
      schemaVersion: snapshot.schemaVersion,
      contentJson: JSON.stringify({ kind: snapshot.kind }),
      contentHash: snapshot.hash,
      createdAt: now,
    })),
  })
  await prisma.v2ProjectVersion.create({
    data: {
      id: versionId,
      workspaceId,
      projectId,
      sequence: 1,
      briefSnapshotId: `${projectId}-brief`,
      editPlanSnapshotId: `${projectId}-edit-plan`,
      policiesSnapshotId: `${projectId}-policies`,
      baseHash: versionHash,
      createdBy: clientId,
      createdAt: now,
    },
  })
  await prisma.v2Project.update({
    where: { id: projectId },
    data: { currentVersionId: versionId },
  })
}

async function removeFixtures(prisma, workspaceIds) {
  await prisma.$transaction(async (transaction) => {
    await transaction.v2SyntheticPhaseGate.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    })
    await transaction.v2Project.updateMany({
      where: { workspaceId: { in: workspaceIds } },
      data: { currentVersionId: null },
    })
    await transaction.v2ProjectVersion.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    })
    await transaction.v2ProjectSnapshot.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    })
    await transaction.v2Project.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    })
    await transaction.v2ApiCredential.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    })
    await transaction.v2ApiClient.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    })
    await transaction.v2Workspace.deleteMany({
      where: { id: { in: workspaceIds } },
    })
  })
}

test('T-F3-GATE public HTTP run/list enforces auth, scope, tenant, closed input and idempotency', {
  skip: SKIP,
  timeout: 90_000,
}, async (t) => {
  assertSafeDatabaseUrl()
  const { issueApiCredential } = await import(
    '../../src/v2/infrastructure/security/api-credential.ts'
  )
  const prisma = new PrismaClient()
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const workspaceId = `synthetic-gate-api-${suffix}`
  const otherWorkspaceId = `synthetic-gate-api-other-${suffix}`
  const workspaceIds = [workspaceId, otherWorkspaceId]
  const projectId = `synthetic-gate-api-project-${suffix}`
  const otherProjectId = `synthetic-gate-api-other-project-${suffix}`
  const versionId = `synthetic-gate-api-version-${suffix}`
  const otherVersionId = `synthetic-gate-api-other-version-${suffix}`
  const versionHash = 'a'.repeat(64)
  const otherVersionHash = 'b'.repeat(64)
  const now = new Date('2026-09-23T12:00:00.000Z')
  let server
  let diagnostics = ''
  let primaryError

  try {
    await removeFixtures(prisma, workspaceIds)
    await prisma.v2Workspace.createMany({ data: [
      { id: workspaceId, slug: workspaceId, name: workspaceId, createdAt: now, updatedAt: now },
      { id: otherWorkspaceId, slug: otherWorkspaceId, name: otherWorkspaceId, createdAt: now, updatedAt: now },
    ] })
    const authorization = await seedClient(prisma, issueApiCredential, {
      workspaceId,
      clientId: `synthetic-gate-api-client-${suffix}`,
      credentialId: `synthetic-gate-api-credential-${suffix}`,
      scopes: ['projects:read', 'projects:write'],
      now,
    })
    const readOnlyAuthorization = await seedClient(prisma, issueApiCredential, {
      workspaceId,
      clientId: `synthetic-gate-api-reader-${suffix}`,
      credentialId: `synthetic-gate-api-reader-cred-${suffix}`,
      scopes: ['projects:read'],
      now,
    })
    const writeOnlyAuthorization = await seedClient(prisma, issueApiCredential, {
      workspaceId,
      clientId: `synthetic-gate-api-writer-${suffix}`,
      credentialId: `synthetic-gate-api-writer-cred-${suffix}`,
      scopes: ['projects:write'],
      now,
    })
    const otherAuthorization = await seedClient(prisma, issueApiCredential, {
      workspaceId: otherWorkspaceId,
      clientId: `synthetic-gate-api-other-client-${suffix}`,
      credentialId: `synthetic-gate-api-other-cred-${suffix}`,
      scopes: ['projects:read', 'projects:write'],
      now,
    })
    await seedProjectVersion(prisma, {
      workspaceId,
      clientId: `synthetic-gate-api-client-${suffix}`,
      projectId,
      versionId,
      versionHash,
      now,
    })
    await seedProjectVersion(prisma, {
      workspaceId: otherWorkspaceId,
      clientId: `synthetic-gate-api-other-client-${suffix}`,
      projectId: otherProjectId,
      versionId: otherVersionId,
      versionHash: otherVersionHash,
      now,
    })

    const port = await freePort()
    const baseUrl = `http://127.0.0.1:${port}`
    server = spawn(
      process.execPath,
      ['node_modules/next/dist/bin/next', 'start', '-p', String(port)],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: 'production',
          __NEXT_PROCESSED_ENV: 'true',
          APOLLO_API_ENVIRONMENT: 'production',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      },
    )
    const retain = (chunk) => {
      diagnostics = `${diagnostics}${chunk.toString('utf8')}`.slice(-64 * 1024)
    }
    server.stdout.on('data', retain)
    server.stderr.on('data', retain)
    await waitForServer(baseUrl, server, t.signal)

    const endpoint = `${baseUrl}/v1/projects/${projectId}/synthetic-phase-gates`
    const body = { projectVersionId: versionId, projectVersionHash: versionHash }
    const request = (input, init) => boundedFetch(input, init, t.signal)
    const post = (headers, requestBody = body) => request(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(requestBody),
    })

    assert.equal((await request(endpoint)).status, 401)
    assert.equal((await post({ 'idempotency-key': 'anonymous-gate-request' })).status, 401)
    assert.equal((await request(endpoint, {
      headers: { authorization: writeOnlyAuthorization },
    })).status, 403)
    assert.equal((await post({
      authorization: readOnlyAuthorization,
      'idempotency-key': 'read-only-gate-request',
    })).status, 403)

    for (const field of ['evidence', 'approved']) {
      const response = await post({
        authorization,
        'idempotency-key': `closed-body-${field}`,
      }, { ...body, [field]: true })
      assert.equal(response.status, 422)
      assert.equal((await response.json()).error.code, 'INVALID_ARGUMENT')
    }
    const missingIdempotency = await post({ authorization })
    assert.equal(missingIdempotency.status, 422)
    assert.equal((await missingIdempotency.json()).error.code, 'INVALID_ARGUMENT')

    for (const query of ['unknown=1', 'limit=1&limit=2', 'limit=0', 'limit=101', 'limit=1.5']) {
      const response = await request(`${endpoint}?${query}`, { headers: { authorization } })
      assert.equal(response.status, 422, query)
      assert.equal((await response.json()).error.code, 'INVALID_ARGUMENT')
    }

    const stale = await post({
      authorization,
      'idempotency-key': 'synthetic-gate-stale-version',
    }, { ...body, projectVersionHash: 'f'.repeat(64) })
    assert.equal(stale.status, 409)
    assert.equal((await stale.json()).error.code, 'VERSION_CONFLICT')

    const foreignPost = await request(
      `${baseUrl}/v1/projects/${otherProjectId}/synthetic-phase-gates`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': 'synthetic-gate-cross-workspace',
        },
        body: JSON.stringify({
          projectVersionId: otherVersionId,
          projectVersionHash: otherVersionHash,
        }),
      },
    )
    assert.equal(foreignPost.status, 404)
    assert.equal((await foreignPost.json()).error.code, 'PROJECT_NOT_FOUND')
    const foreignList = await request(endpoint, { headers: { authorization: otherAuthorization } })
    assert.equal(foreignList.status, 200)
    assert.deepEqual((await foreignList.json()).data.gates, [])

    const first = await post({
      authorization,
      'idempotency-key': 'synthetic-gate-http-replay',
    })
    const firstPayload = await first.json()
    assert.equal(first.status, 201, JSON.stringify(firstPayload))
    assert.equal(firstPayload.data.replayed, false)
    assert.equal(firstPayload.data.gate.report.approved, false)
    assert.equal('idempotencyKey' in firstPayload.data.gate, false)
    assert.equal('requestFingerprint' in firstPayload.data.gate, false)
    const replay = await post({
      authorization,
      'idempotency-key': 'synthetic-gate-http-replay',
    })
    const replayPayload = await replay.json()
    assert.equal(replay.status, 200, JSON.stringify(replayPayload))
    assert.equal(replayPayload.data.replayed, true)
    assert.equal(replayPayload.data.gate.id, firstPayload.data.gate.id)

    const mismatch = await post({
      authorization,
      'idempotency-key': 'synthetic-gate-http-replay',
    }, { ...body, projectVersionHash: 'e'.repeat(64) })
    assert.equal(mismatch.status, 409)
    assert.equal((await mismatch.json()).error.code, 'IDEMPOTENCY_PAYLOAD_MISMATCH')

    const concurrent = await Promise.all([
      post({ authorization, 'idempotency-key': 'synthetic-gate-http-concurrent' }),
      post({ authorization, 'idempotency-key': 'synthetic-gate-http-concurrent' }),
    ])
    assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 201])
    const concurrentPayloads = await Promise.all(concurrent.map((response) => response.json()))
    assert.equal(concurrentPayloads[0].data.gate.id, concurrentPayloads[1].data.gate.id)
    assert.deepEqual(
      concurrentPayloads.map((payload) => payload.data.replayed).sort(),
      [false, true],
    )

    const listed = await request(`${endpoint}?limit=2`, { headers: { authorization } })
    const listedPayload = await listed.json()
    assert.equal(listed.status, 200, JSON.stringify(listedPayload))
    assert.equal(listedPayload.data.gates.length, 2)
    assert.equal(JSON.stringify(listedPayload).includes('idempotencyKey'), false)
    assert.equal(JSON.stringify(listedPayload).includes('requestFingerprint'), false)
    assert.equal(await prisma.v2SyntheticPhaseGate.count({ where: { workspaceId } }), 2)
  } catch (error) {
    primaryError = error
    throw new Error(`${error instanceof Error ? error.stack : String(error)}\nNext diagnostics:\n${diagnostics}`)
  } finally {
    const teardownErrors = []
    try {
      await stopChild(server)
    } catch (error) {
      teardownErrors.push(error)
    }
    try {
      await removeFixtures(prisma, workspaceIds)
    } catch (error) {
      teardownErrors.push(error)
    }
    try {
      await prisma.$disconnect()
    } catch (error) {
      teardownErrors.push(error)
    }
    if (teardownErrors.length > 0) {
      throw new AggregateError(
        primaryError ? [primaryError, ...teardownErrors] : teardownErrors,
        primaryError
          ? 'synthetic phase gate HTTP proof and teardown both failed'
          : 'synthetic phase gate HTTP proof teardown failed',
      )
    }
  }
})
