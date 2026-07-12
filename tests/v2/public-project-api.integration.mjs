import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import net from 'node:net'
import test from 'node:test'

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

async function waitForServer(baseUrl, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Next server exited with ${child.exitCode}`)
    try {
      const response = await fetch(`${baseUrl}/v1/health`)
      if (response.ok) return
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Next server did not become ready')
}

test('authenticated public API creates, replays and lists projects', async () => {
  const clientPackage =
    process.env.APOLLO_V2_PERSISTENCE === 'postgres'
      ? '@apollo/prisma-v2-client'
      : '@prisma/client'
  const { PrismaClient } = await import(clientPackage)
  const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
  const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
  const { PrismaApiClientRepository } = await import(
    '../../src/v2/infrastructure/prisma/api-client-repository.ts'
  )
  const { PrismaWorkspaceRepository } = await import(
    '../../src/v2/infrastructure/prisma/workspace-repository.ts'
  )
  const { nodeApiCredentialCrypto } = await import(
    '../../src/v2/infrastructure/security/api-credential.ts'
  )

  const client = new PrismaClient()
  const apiEnvironment =
    process.env.APOLLO_V2_PERSISTENCE === 'postgres' ? 'production' : 'sandbox'
  const workspaceId = 'public-api-workspace-v2'
  const apiClientId = 'public-api-client-v2'
  let server

  try {
    await client.v2IdempotencyRecord.deleteMany({ where: { workspaceId } })
    await client.v2Project.deleteMany({ where: { workspaceId } })
    await client.v2ApiClient.deleteMany({ where: { workspaceId } })
    await client.v2Workspace.deleteMany({ where: { id: workspaceId } })

    await new PrismaWorkspaceRepository(client).create(
      createWorkspace({
        id: workspaceId,
        slug: 'public-api-workspace-v2',
        name: 'Public API Workspace V2',
        status: 'active',
        createdAt: '2026-07-12T16:00:00.000Z',
      }),
    )
    const issued = await createApiClientService({
      repository: new PrismaApiClientRepository(client),
      credentialCrypto: nodeApiCredentialCrypto,
      clock: () => new Date('2026-07-12T16:01:00.000Z'),
    })({
      id: apiClientId,
      workspaceId,
      name: 'Public API Test Client',
      environment: apiEnvironment,
      scopes: ['clients:admin', 'projects:read', 'projects:write'],
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
          APOLLO_API_ENVIRONMENT: apiEnvironment,
        },
        stdio: 'ignore',
      },
    )
    await waitForServer(baseUrl, server)

    const healthResponse = await fetch(`${baseUrl}/v1/health`)
    assert.equal(healthResponse.status, 200)
    assert.equal(healthResponse.headers.get('apollo-api-version'), 'v1')
    assert.ok(healthResponse.headers.get('apollo-request-id'))

    const openApiResponse = await fetch(`${baseUrl}/v1/openapi.json`)
    const openApi = await openApiResponse.json()
    assert.equal(openApiResponse.status, 200)
    assert.equal(openApi.openapi, '3.1.0')
    assert.equal(
      openApi.paths['/v1/workspaces/{workspaceId}/clients'].post["x-apollo-capability-id"],
      'apollo.clients.create',
    )

    const schemaResponse = await fetch(
      `${baseUrl}/v1/schemas/create-project-request/v1`,
    )
    const schema = await schemaResponse.json()
    assert.equal(schemaResponse.status, 200)
    assert.match(schemaResponse.headers.get('content-type'), /^application\/schema\+json/)
    assert.equal(schema.$id, 'apollo://schemas/create-project-request/v1')
    assert.deepEqual(schema.required, ['name'])

    const missingSchemaResponse = await fetch(`${baseUrl}/v1/schemas/missing/v1`)
    assert.equal(missingSchemaResponse.status, 404)

    const unauthorized = await fetch(`${baseUrl}/v1/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'unauthorized' },
      body: JSON.stringify({ name: 'Should not exist' }),
    })
    assert.equal(unauthorized.status, 401)

    const authorization = `Bearer ${issued.token}`
    const capabilitiesResponse = await fetch(`${baseUrl}/v1/capabilities`, {
      headers: { authorization },
    })
    assert.equal(capabilitiesResponse.status, 200)
    const capabilities = await capabilitiesResponse.json()
    assert.deepEqual(
      capabilities.data.capabilities.map((capability) => capability.id),
      [
        'apollo.health.read',
        'apollo.capabilities.list',
        'apollo.projects.list',
        'apollo.contracts.openapi.read',
        'apollo.contracts.schemas.read',
        'apollo.projects.create',
        'apollo.clients.list',
        'apollo.clients.create',
        'apollo.clients.credentials.rotate',
        'apollo.clients.credentials.revoke',
      ],
    )

    const createChildRequest = () =>
      fetch(`${baseUrl}/v1/workspaces/${workspaceId}/clients`, {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': 'public-create-child-client-1',
        },
        body: JSON.stringify({
          name: 'Read-only external agent',
          environment: apiEnvironment,
          scopes: ['projects:read'],
        }),
      })
    const childCreatedResponse = await createChildRequest()
    const childCreated = await childCreatedResponse.json()
    assert.equal(childCreatedResponse.status, 201)
    assert.equal(childCreated.data.secretAvailable, true)
    assert.equal(typeof childCreated.data.token, 'string')
    assert.equal(childCreated.data.replayed, false)

    const childReplayResponse = await createChildRequest()
    const childReplay = await childReplayResponse.json()
    assert.equal(childReplayResponse.status, 200)
    assert.equal(childReplay.data.replayed, true)
    assert.equal(childReplay.data.secretAvailable, false)
    assert.equal('token' in childReplay.data, false)
    assert.equal(childReplay.data.client.id, childCreated.data.client.id)

    const childAuthorization = `Bearer ${childCreated.data.token}`
    const childCapabilitiesResponse = await fetch(`${baseUrl}/v1/capabilities`, {
      headers: { authorization: childAuthorization },
    })
    const childCapabilities = await childCapabilitiesResponse.json()
    assert.equal(childCapabilitiesResponse.status, 200)
    assert.deepEqual(
      childCapabilities.data.capabilities.map((capability) => capability.id),
      [
        'apollo.health.read',
        'apollo.capabilities.list',
        'apollo.projects.list',
        'apollo.contracts.openapi.read',
        'apollo.contracts.schemas.read',
      ],
    )

    const childEscalationResponse = await fetch(
      `${baseUrl}/v1/workspaces/${workspaceId}/clients`,
      {
        method: 'POST',
        headers: {
          authorization: childAuthorization,
          'content-type': 'application/json',
          'idempotency-key': 'child-escalation-attempt',
        },
        body: JSON.stringify({
          name: 'Escalated client',
          environment: apiEnvironment,
          scopes: ['clients:admin'],
        }),
      },
    )
    assert.equal(childEscalationResponse.status, 403)

    const crossWorkspaceResponse = await fetch(
      `${baseUrl}/v1/workspaces/another-workspace/clients`,
      { headers: { authorization } },
    )
    assert.equal(crossWorkspaceResponse.status, 404)

    const rotateRequest = () =>
      fetch(
        `${baseUrl}/v1/workspaces/${workspaceId}/clients/${childCreated.data.client.id}/credentials`,
        {
          method: 'POST',
          headers: {
            authorization,
            'content-type': 'application/json',
            'idempotency-key': 'rotate-child-client-1',
          },
          body: JSON.stringify({ overlapSeconds: 0 }),
        },
      )
    const rotatedResponse = await rotateRequest()
    const rotated = await rotatedResponse.json()
    assert.equal(rotatedResponse.status, 201)
    assert.equal(rotated.data.secretAvailable, true)
    assert.equal(typeof rotated.data.token, 'string')

    const expiredOldTokenResponse = await fetch(`${baseUrl}/v1/projects`, {
      headers: { authorization: childAuthorization },
    })
    assert.equal(expiredOldTokenResponse.status, 401)

    const rotatedAuthorization = `Bearer ${rotated.data.token}`
    const rotatedTokenResponse = await fetch(`${baseUrl}/v1/projects`, {
      headers: { authorization: rotatedAuthorization },
    })
    assert.equal(rotatedTokenResponse.status, 200)

    const rotateReplayResponse = await rotateRequest()
    const rotateReplay = await rotateReplayResponse.json()
    assert.equal(rotateReplayResponse.status, 200)
    assert.equal(rotateReplay.data.secretAvailable, false)
    assert.equal('token' in rotateReplay.data, false)
    assert.equal(rotateReplay.data.credential.id, rotated.data.credential.id)

    const selfRevokeResponse = await fetch(
      `${baseUrl}/v1/workspaces/${workspaceId}/clients/${apiClientId}/credentials/${issued.credential.id}`,
      { method: 'DELETE', headers: { authorization } },
    )
    assert.equal(selfRevokeResponse.status, 409)

    const revokeResponse = await fetch(
      `${baseUrl}/v1/workspaces/${workspaceId}/clients/${childCreated.data.client.id}/credentials/${rotated.data.credential.id}`,
      { method: 'DELETE', headers: { authorization } },
    )
    const revoked = await revokeResponse.json()
    assert.equal(revokeResponse.status, 200)
    assert.equal(revoked.data.credential.status, 'revoked')

    const revokedTokenResponse = await fetch(`${baseUrl}/v1/projects`, {
      headers: { authorization: rotatedAuthorization },
    })
    assert.equal(revokedTokenResponse.status, 401)

    const storedAdminResponses = await client.v2IdempotencyRecord.findMany({
      where: {
        workspaceId,
        key: { in: ['public-create-child-client-1', 'rotate-child-client-1'] },
      },
      select: { responseJson: true },
    })
    assert.equal(storedAdminResponses.length, 2)
    for (const record of storedAdminResponses) {
      assert.equal(record.responseJson.includes('apollo_v2.'), false)
      assert.equal(record.responseJson.includes('secret'), false)
    }

    const createRequest = () =>
      fetch(`${baseUrl}/v1/projects`, {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': 'public-create-project-1',
          'apollo-request-id': 'public-api-test-1',
        },
        body: JSON.stringify({ name: 'Projeto criado externamente' }),
      })
    const createdResponse = await createRequest()
    const created = await createdResponse.json()
    assert.equal(createdResponse.status, 201)
    assert.equal(created.data.replayed, false)
    assert.equal(created.data.project.name, 'Projeto criado externamente')
    assert.equal(created.data.version.sequence, 1)

    const replayResponse = await createRequest()
    const replay = await replayResponse.json()
    assert.equal(replayResponse.status, 200)
    assert.equal(replay.data.replayed, true)
    assert.equal(replay.data.project.id, created.data.project.id)

    const listResponse = await fetch(`${baseUrl}/v1/projects?limit=20`, {
      headers: { authorization },
    })
    const list = await listResponse.json()
    assert.equal(listResponse.status, 200)
    assert.equal(list.data.projects.length, 1)
    assert.equal(list.data.projects[0].id, created.data.project.id)
  } finally {
    if (server && server.exitCode === null) {
      server.kill()
      await Promise.race([
        once(server, 'exit'),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ])
    }
    await client.v2IdempotencyRecord.deleteMany({ where: { workspaceId } })
    await client.v2Project.deleteMany({ where: { workspaceId } })
    await client.v2ApiClient.deleteMany({ where: { workspaceId } })
    await client.v2Workspace.deleteMany({ where: { id: workspaceId } })
    await client.$disconnect()
  }
})
