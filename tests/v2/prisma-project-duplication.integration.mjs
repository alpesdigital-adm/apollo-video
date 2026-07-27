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

test('T-FR-053 duplicates a project copy-on-write through the public API with PostgreSQL lineage and idempotency', {
  skip: process.env.APOLLO_PROJECT_DUPLICATION_E2E !== '1' &&
    'set APOLLO_PROJECT_DUPLICATION_E2E=1 and use an isolated V2 database',
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
  const workspaceId = `duplication-workspace-${suffix}`
  const otherWorkspaceId = `duplication-other-workspace-${suffix}`
  const artifactId = `duplication-master-${suffix}`
  const createdAt = new Date('2026-07-27T01:30:00.000Z')
  let server
  let serverLogs = ''

  try {
    await client.$executeRawUnsafe('TRUNCATE TABLE "workspaces" CASCADE')
    await client.v2Workspace.createMany({
      data: [
        {
          id: workspaceId,
          slug: workspaceId,
          name: 'Project duplication E2E',
          status: 'active',
          createdAt,
          updatedAt: createdAt,
        },
        {
          id: otherWorkspaceId,
          slug: otherWorkspaceId,
          name: 'Project duplication other workspace',
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
      id: `duplication-client-${suffix}`,
      workspaceId,
      name: 'Project duplication E2E',
      environment: 'production',
      scopes: ['projects:read', 'projects:write'],
    })
    const otherIssued = await createClient({
      id: `duplication-other-client-${suffix}`,
      workspaceId: otherWorkspaceId,
      name: 'Project duplication other workspace',
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
    const createResponse = await fetch(`${baseUrl}/v1/projects`, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': `duplication-source-${suffix}`,
      },
      body: JSON.stringify({
        name: 'Original imutável',
        objective: 'discovery',
        format: '9:16',
        locale: 'pt-BR',
        briefing: 'Descoberta com enquadramento seguro e sem texto sobre o rosto.',
      }),
    })
    const createPayload = await createResponse.json()
    assert.equal(
      createResponse.status,
      201,
      `${JSON.stringify(createPayload)}\n${serverLogs.slice(-4_000)}`,
    )
    const sourceProject = createPayload.data.project
    const sourceVersion = createPayload.data.version

    await client.v2MediaArtifact.create({
      data: {
        id: artifactId,
        workspaceId,
        artifactKey: `duplication/${artifactId}.mp4`,
        sha256: 'a'.repeat(64),
        byteSize: 12_345n,
        mediaType: 'video',
        container: 'mp4',
        status: 'available',
        createdAt,
      },
    })
    await client.v2ProjectMediaAsset.create({
      data: {
        id: randomUUID(),
        workspaceId,
        projectId: sourceProject.id,
        artifactId,
        role: 'source-master',
        originalFileName: 'master-original.mp4',
        createdAt,
      },
    })

    const duplicateBody = {
      expectedVersionId: sourceVersion.id,
      expectedVersionHash: sourceVersion.baseHash,
      name: 'Cópia independente',
    }
    const duplicationKey = `duplicate-${suffix}`
    const duplicateResponse = await fetch(
      `${baseUrl}/v1/projects/${sourceProject.id}/duplicates`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': duplicationKey,
        },
        body: JSON.stringify(duplicateBody),
      },
    )
    const duplicatePayload = await duplicateResponse.json()
    assert.equal(
      duplicateResponse.status,
      201,
      `${JSON.stringify(duplicatePayload)}\n${serverLogs.slice(-4_000)}`,
    )
    assert.equal(duplicatePayload.data.replayed, false)
    assert.equal(duplicatePayload.data.project.name, 'Cópia independente')
    assert.equal(
      duplicatePayload.data.project.duplicatedFromProjectId,
      sourceProject.id,
    )
    assert.equal(
      duplicatePayload.data.version.forkedFromProjectId,
      sourceProject.id,
    )
    assert.equal(
      duplicatePayload.data.version.forkedFromVersionId,
      sourceVersion.id,
    )
    assert.deepEqual(
      duplicatePayload.data.version.snapshotRefs,
      sourceVersion.snapshotRefs,
    )
    assert.deepEqual(duplicatePayload.data.sharedArtifactIds, [artifactId])
    assert.equal(duplicatePayload.data.copiedBytes, 0)

    const duplicateProjectId = duplicatePayload.data.project.id
    const duplicateVersionId = duplicatePayload.data.version.id
    assert.notEqual(duplicateProjectId, sourceProject.id)
    assert.notEqual(duplicateVersionId, sourceVersion.id)

    const [
      artifactCount,
      artifactBytes,
      projectMedia,
      storedDuplicate,
      storedVersion,
    ] = await Promise.all([
      client.v2MediaArtifact.count({ where: { workspaceId } }),
      client.v2MediaArtifact.aggregate({
        where: { workspaceId },
        _sum: { byteSize: true },
      }),
      client.v2ProjectMediaAsset.findMany({
        where: { workspaceId, artifactId },
        orderBy: { projectId: 'asc' },
      }),
      client.v2Project.findUnique({ where: { id: duplicateProjectId } }),
      client.v2ProjectVersion.findUnique({ where: { id: duplicateVersionId } }),
    ])
    assert.equal(artifactCount, 1)
    assert.equal(artifactBytes._sum.byteSize, 12_345n)
    assert.equal(projectMedia.length, 2)
    assert.equal(new Set(projectMedia.map((item) => item.artifactId)).size, 1)
    assert.equal(new Set(projectMedia.map((item) => item.id)).size, 2)
    assert.equal(storedDuplicate?.currentVersionId, duplicateVersionId)
    assert.equal(storedDuplicate?.duplicatedFromProjectId, sourceProject.id)
    assert.equal(storedVersion?.forkedFromProjectId, sourceProject.id)
    assert.equal(storedVersion?.forkedFromVersionId, sourceVersion.id)
    assert.deepEqual(
      {
        brief: storedVersion?.briefSnapshotId,
        ...(storedVersion?.treatmentSnapshotId
          ? { treatment: storedVersion.treatmentSnapshotId }
          : {}),
        ...(storedVersion?.storySnapshotId
          ? { story: storedVersion.storySnapshotId }
          : {}),
        editPlan: storedVersion?.editPlanSnapshotId,
        policies: storedVersion?.policiesSnapshotId,
      },
      sourceVersion.snapshotRefs,
    )

    const replayResponse = await fetch(
      `${baseUrl}/v1/projects/${sourceProject.id}/duplicates`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': duplicationKey,
        },
        body: JSON.stringify(duplicateBody),
      },
    )
    const replayPayload = await replayResponse.json()
    assert.equal(replayResponse.status, 200, JSON.stringify(replayPayload))
    assert.equal(replayPayload.data.replayed, true)
    assert.equal(replayPayload.data.project.id, duplicateProjectId)
    assert.equal(replayPayload.data.version.id, duplicateVersionId)
    assert.equal(
      await client.v2MediaArtifact.count({ where: { workspaceId } }),
      1,
    )
    assert.equal(
      await client.v2ProjectMediaAsset.count({
        where: { workspaceId, artifactId },
      }),
      2,
    )

    const mismatchResponse = await fetch(
      `${baseUrl}/v1/projects/${sourceProject.id}/duplicates`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': duplicationKey,
        },
        body: JSON.stringify({ ...duplicateBody, name: 'Outra carga' }),
      },
    )
    assert.equal(
      mismatchResponse.status,
      409,
      JSON.stringify(await mismatchResponse.json()),
    )

    const staleResponse = await fetch(
      `${baseUrl}/v1/projects/${sourceProject.id}/duplicates`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': `duplicate-stale-${suffix}`,
        },
        body: JSON.stringify({
          ...duplicateBody,
          expectedVersionHash: '0'.repeat(64),
        }),
      },
    )
    assert.equal(
      staleResponse.status,
      409,
      JSON.stringify(await staleResponse.json()),
    )

    const injectionResponse = await fetch(
      `${baseUrl}/v1/projects/${sourceProject.id}/duplicates`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': `duplicate-injection-${suffix}`,
        },
        body: JSON.stringify({
          ...duplicateBody,
          copiedBytes: 99,
          sharedArtifactIds: ['client-controlled-artifact'],
        }),
      },
    )
    assert.equal(
      injectionResponse.status,
      422,
      JSON.stringify(await injectionResponse.json()),
    )

    const crossWorkspaceResponse = await fetch(
      `${baseUrl}/v1/projects/${sourceProject.id}/duplicates`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${otherIssued.token}`,
          'content-type': 'application/json',
          'idempotency-key': `duplicate-cross-workspace-${suffix}`,
        },
        body: JSON.stringify(duplicateBody),
      },
    )
    assert.equal(
      crossWorkspaceResponse.status,
      404,
      JSON.stringify(await crossWorkspaceResponse.json()),
    )
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
