import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import net from 'node:net'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close((error) => error
        ? reject(error)
        : resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

async function waitForServer(baseUrl, child) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Next server exited with ${child.exitCode}`)
    }
    try {
      if ((await fetch(`${baseUrl}/v1/health`)).ok) return
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Next server did not become ready')
}

test('T-FR-220 persists a fail-closed server-only MVP Core gate through the public API', {
  skip: process.env.APOLLO_MVP_CORE_GATE_E2E !== '1' &&
    'set APOLLO_MVP_CORE_GATE_E2E=1 and use an isolated V2 database',
  timeout: 120_000,
}, async () => {
  assert.ok(
    process.env.V2_DATABASE_URL,
    'V2_DATABASE_URL must point to an isolated PostgreSQL database',
  )
  const databaseName = new URL(process.env.V2_DATABASE_URL).pathname.slice(1)
  assert.match(
    databaseName,
    /(?:^|_)e2e(?:_|$)/,
    'destructive E2E setup requires an explicitly isolated database',
  )

  const { createApiClientService } = await import(
    '../../src/v2/application/create-api-client.ts'
  )
  const { PrismaApiClientRepository } = await import(
    '../../src/v2/infrastructure/prisma/api-client-repository.ts'
  )
  const { nodeApiCredentialCrypto } = await import(
    '../../src/v2/infrastructure/security/api-credential.ts'
  )

  const client = new PrismaClient()
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `mvp-gate-workspace-${suffix}`
  const otherWorkspaceId = `mvp-gate-other-workspace-${suffix}`
  const createdAt = new Date('2026-07-27T02:00:00.000Z')
  let server
  let serverLogs = ''

  try {
    await client.$executeRawUnsafe('TRUNCATE TABLE "workspaces" CASCADE')
    await client.v2Workspace.createMany({
      data: [
        {
          id: workspaceId,
          slug: workspaceId,
          name: 'MVP Core gate E2E',
          status: 'active',
          createdAt,
          updatedAt: createdAt,
        },
        {
          id: otherWorkspaceId,
          slug: otherWorkspaceId,
          name: 'MVP Core gate other workspace',
          status: 'active',
          createdAt,
          updatedAt: createdAt,
        },
      ],
    })
    const createClient = createApiClientService({
      repository: new PrismaApiClientRepository(client),
      credentialCrypto: nodeApiCredentialCrypto,
      clock: () => createdAt,
    })
    const issued = await createClient({
      id: `mvp-gate-client-${suffix}`,
      workspaceId,
      name: 'MVP Core gate E2E',
      environment: 'production',
      scopes: ['projects:read', 'projects:write'],
    })
    const otherIssued = await createClient({
      id: `mvp-gate-other-client-${suffix}`,
      workspaceId: otherWorkspaceId,
      name: 'MVP Core gate other workspace',
      environment: 'production',
      scopes: ['projects:read', 'projects:write'],
    })

    const port = await getFreePort()
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
      },
    )
    server.stdout.on('data', (chunk) => { serverLogs += String(chunk) })
    server.stderr.on('data', (chunk) => { serverLogs += String(chunk) })
    await waitForServer(baseUrl, server)
    const authorization = `Bearer ${issued.token}`

    async function createProject(name, format, key) {
      const response = await fetch(`${baseUrl}/v1/projects`, {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        body: JSON.stringify({
          name,
          objective: 'discovery',
          format,
          locale: 'pt-BR',
        }),
      })
      const payload = await response.json()
      assert.equal(
        response.status,
        201,
        `${JSON.stringify(payload)}\n${serverLogs.slice(-4_000)}`,
      )
      return payload.data
    }

    const primary = await createProject(
      'MVP primary talking head',
      '9:16',
      `mvp-primary-${suffix}`,
    )
    const companion = await createProject(
      'MVP companion voiceover',
      '16:9',
      `mvp-companion-${suffix}`,
    )
    const duplicateResponse = await fetch(
      `${baseUrl}/v1/projects/${primary.project.id}/duplicates`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': `mvp-duplicate-${suffix}`,
        },
        body: JSON.stringify({
          expectedVersionId: primary.version.id,
          expectedVersionHash: primary.version.baseHash,
          name: 'MVP copy-on-write proof',
        }),
      },
    )
    const duplicatePayload = await duplicateResponse.json()
    assert.equal(
      duplicateResponse.status,
      201,
      `${JSON.stringify(duplicatePayload)}\n${serverLogs.slice(-4_000)}`,
    )

    const gateBody = {
      primaryVersionId: primary.version.id,
      primaryVersionHash: primary.version.baseHash,
      companionProjectId: companion.project.id,
      companionVersionId: companion.version.id,
      companionVersionHash: companion.version.baseHash,
      duplicateProjectId: duplicatePayload.data.project.id,
    }
    const gateKey = `mvp-core-gate-${suffix}`
    const runResponse = await fetch(
      `${baseUrl}/v1/projects/${primary.project.id}/mvp-core-gates`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': gateKey,
        },
        body: JSON.stringify(gateBody),
      },
    )
    const runPayload = await runResponse.json()
    assert.equal(
      runResponse.status,
      201,
      `${JSON.stringify(runPayload)}\n${serverLogs.slice(-4_000)}`,
    )
    assert.equal(runPayload.data.replayed, false)
    const gate = runPayload.data.gate
    assert.equal(gate.schemaVersion, 'mvp-core-gate/v1')
    assert.equal(gate.report.schemaVersion, 'mvp-core-gate-report/v1')
    assert.equal(gate.report.serverEvidenceOnly, true)
    assert.equal(gate.report.total, 16)
    assert.equal(gate.report.covered, 16)
    assert.equal(gate.report.evidence.length, 16)
    assert.equal(gate.report.approved, false)
    assert.ok(gate.report.passed < 16)
    assert.match(gate.reportFingerprint, /^[a-f0-9]{64}$/)
    assert.match(gate.recordHash, /^[a-f0-9]{64}$/)
    assert.ok(gate.report.evidence.every((item) =>
      item.source === 'server' &&
      item.automatic === true &&
      item.checks.every((check) => check.references.length >= 1)))

    const replayResponse = await fetch(
      `${baseUrl}/v1/projects/${primary.project.id}/mvp-core-gates`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': gateKey,
        },
        body: JSON.stringify(gateBody),
      },
    )
    const replayPayload = await replayResponse.json()
    assert.equal(replayResponse.status, 200, JSON.stringify(replayPayload))
    assert.equal(replayPayload.data.replayed, true)
    assert.equal(replayPayload.data.gate.id, gate.id)
    assert.equal(replayPayload.data.gate.recordHash, gate.recordHash)

    const mismatchResponse = await fetch(
      `${baseUrl}/v1/projects/${primary.project.id}/mvp-core-gates`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': gateKey,
        },
        body: JSON.stringify({
          ...gateBody,
          companionVersionHash: 'f'.repeat(64),
        }),
      },
    )
    assert.equal(
      mismatchResponse.status,
      409,
      JSON.stringify(await mismatchResponse.json()),
    )

    const injectionResponse = await fetch(
      `${baseUrl}/v1/projects/${primary.project.id}/mvp-core-gates`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': `mvp-injection-${suffix}`,
        },
        body: JSON.stringify({
          ...gateBody,
          approved: true,
          evidence: [],
          passed: 16,
        }),
      },
    )
    assert.equal(
      injectionResponse.status,
      422,
      JSON.stringify(await injectionResponse.json()),
    )

    const staleResponse = await fetch(
      `${baseUrl}/v1/projects/${primary.project.id}/mvp-core-gates`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': `mvp-stale-${suffix}`,
        },
        body: JSON.stringify({
          ...gateBody,
          primaryVersionHash: '0'.repeat(64),
        }),
      },
    )
    assert.equal(
      staleResponse.status,
      409,
      JSON.stringify(await staleResponse.json()),
    )

    const crossWorkspaceResponse = await fetch(
      `${baseUrl}/v1/projects/${primary.project.id}/mvp-core-gates`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${otherIssued.token}`,
          'content-type': 'application/json',
          'idempotency-key': `mvp-cross-workspace-${suffix}`,
        },
        body: JSON.stringify(gateBody),
      },
    )
    assert.equal(
      crossWorkspaceResponse.status,
      404,
      JSON.stringify(await crossWorkspaceResponse.json()),
    )

    const listResponse = await fetch(
      `${baseUrl}/v1/projects/${primary.project.id}/mvp-core-gates?limit=10`,
      { headers: { authorization } },
    )
    const listPayload = await listResponse.json()
    assert.equal(listResponse.status, 200, JSON.stringify(listPayload))
    assert.equal(listPayload.data.gates.length, 1)
    assert.equal(listPayload.data.gates[0].id, gate.id)

    const stored = await client.v2MvpCoreGate.findUnique({
      where: { id: gate.id },
    })
    assert.ok(stored)
    await client.v2MvpCoreGate.update({
      where: { id: gate.id },
      data: { recordHash: '0'.repeat(64) },
    })
    const corruptedResponse = await fetch(
      `${baseUrl}/v1/projects/${primary.project.id}/mvp-core-gates`,
      { headers: { authorization } },
    )
    assert.equal(
      corruptedResponse.status,
      409,
      JSON.stringify(await corruptedResponse.json()),
    )
    await client.v2MvpCoreGate.update({
      where: { id: gate.id },
      data: { recordHash: stored.recordHash },
    })
  } finally {
    if (server && server.exitCode === null) {
      server.kill()
      await Promise.race([
        once(server, 'exit'),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ])
    }
    await client.$executeRawUnsafe(
      'TRUNCATE TABLE "workspaces" CASCADE',
    ).catch(() => {})
    await client.$disconnect()
  }
})
