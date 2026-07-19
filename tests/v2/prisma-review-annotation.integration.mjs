import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import net from 'node:net'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

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
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Next server exited with ${child.exitCode}`)
    try {
      const response = await fetch(`${baseUrl}/v1/health`)
      if (response.ok) return
    } catch {
      // The production server may take longer while the local processor is busy.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Next server did not become ready')
}

test('review annotations persist idempotently without mutating the project version', async () => {
  const { createProjectService } = await import('../../src/v2/application/create-project.ts')
  const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
  const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
  const { PrismaApiClientRepository } = await import(
    '../../src/v2/infrastructure/prisma/api-client-repository.ts'
  )
  const { PrismaProjectCreationRepository } = await import(
    '../../src/v2/infrastructure/prisma/project-creation-repository.ts'
  )
  const { PrismaReviewAnnotationRepository } = await import(
    '../../src/v2/infrastructure/prisma/review-annotation-repository.ts'
  )
  const { PrismaWorkspaceRepository } = await import(
    '../../src/v2/infrastructure/prisma/workspace-repository.ts'
  )
  const { nodeApiCredentialCrypto } = await import(
    '../../src/v2/infrastructure/security/api-credential.ts'
  )

  const client = new PrismaClient()
  const workspaceId = 'review-integration-workspace'
  const artifactId = 'review-integration-proxy'
  const proxyHash = 'a'.repeat(64)
  const createdAt = '2026-07-19T14:30:00.000Z'
  let server

  const cleanup = async () => {
    await client.v2ReviewAnnotation.deleteMany({ where: { workspaceId } })
    await client.v2ProjectProxyRenderOperation.deleteMany({ where: { workspaceId } })
    await client.v2PublicOperation.deleteMany({ where: { workspaceId } })
    await client.v2ProjectMediaAsset.deleteMany({ where: { workspaceId } })
    await client.v2MediaArtifactManifest.deleteMany({ where: { workspaceId } })
    await client.v2MediaArtifact.deleteMany({ where: { workspaceId } })
    await client.v2PublicEventOutbox.deleteMany({ where: { workspaceId } })
    await client.v2IdempotencyRecord.deleteMany({ where: { workspaceId } })
    await client.v2Project.deleteMany({ where: { workspaceId } })
    await client.v2ApiClient.deleteMany({ where: { workspaceId } })
    await client.v2Workspace.deleteMany({ where: { id: workspaceId } })
  }

  try {
    await cleanup()
    await new PrismaWorkspaceRepository(client).create(createWorkspace({
      id: workspaceId,
      slug: workspaceId,
      name: 'Review Integration Workspace',
      status: 'active',
      createdAt,
    }))
    const issued = await createApiClientService({
      repository: new PrismaApiClientRepository(client),
      credentialCrypto: nodeApiCredentialCrypto,
      clock: () => new Date(createdAt),
    })({
      id: 'review-integration-client',
      workspaceId,
      name: 'Review Integration Client',
      environment: 'production',
      scopes: ['projects:read', 'projects:write'],
    })

    let entityCounter = 0
    let eventCounter = 0
    const projectResult = await createProjectService({
      repository: new PrismaProjectCreationRepository(client),
      clock: () => new Date(createdAt),
      createId: (kind) => `${kind}-review-integration-${++entityCounter}`,
      createEventId: () => `00000000-0000-4000-8000-${String(++eventCounter).padStart(12, '0')}`,
    })({
      workspaceId,
      name: 'Projeto de revisão',
      objective: 'discovery',
      format: '9:16',
      actor: { type: 'api-client', id: issued.client.id },
      idempotency: { clientId: 'review-integration-client', key: 'review-integration-project' },
    })

    await client.v2MediaArtifact.create({
      data: {
        id: artifactId,
        workspaceId,
        artifactKey: 'review-integration/proxy.mp4',
        sha256: proxyHash,
        byteSize: 2048n,
        mediaType: 'video',
        container: 'mp4',
        status: 'available',
        createdAt: new Date(createdAt),
      },
    })
    await client.v2MediaArtifactManifest.create({
      data: {
        id: 'review-integration-manifest',
        workspaceId,
        artifactId,
        schemaVersion: 'media-artifact-manifest/v1',
        manifestHash: 'b'.repeat(64),
        recipeId: 'review-proxy',
        recipeVersion: 'v1',
        parametersHash: 'c'.repeat(64),
        manifestJson: JSON.stringify({ probe: { width: 1080, height: 1920, duration: 3, fps: 30 } }),
        createdAt: new Date(createdAt),
      },
    })
    await client.v2ProjectMediaAsset.create({
      data: {
        id: randomUUID(),
        workspaceId,
        projectId: projectResult.project.id,
        artifactId,
        role: 'editing-proxy',
        originalFileName: 'proxy.mp4',
        createdAt: new Date(createdAt),
      },
    })
    await client.v2PublicOperation.create({
      data: {
        id: 'review-integration-operation',
        workspaceId,
        clientId: issued.client.id,
        type: 'project-proxy-render',
        status: 'succeeded',
        phase: 'completed',
        targetType: 'media-artifact',
        targetId: artifactId,
        cancelable: false,
        retryable: false,
        attempt: 1,
        resultJson: JSON.stringify({ artifactId }),
        idempotencyKey: 'review-integration-render',
        requestFingerprint: 'd'.repeat(64),
        createdAt: new Date(createdAt),
        updatedAt: new Date(createdAt),
        startedAt: new Date(createdAt),
        completedAt: new Date(createdAt),
      },
    })
    await client.v2ProjectProxyRenderOperation.create({
      data: {
        operationId: 'review-integration-operation',
        workspaceId,
        projectId: projectResult.project.id,
        projectVersionId: projectResult.version.id,
        editPlanSnapshotId: projectResult.version.snapshotRefs.editPlan,
        sourceArtifactId: artifactId,
        sourceManifestId: 'review-integration-manifest',
        inputHash: 'e'.repeat(64),
        outputArtifactId: artifactId,
        outputManifestId: 'review-integration-manifest',
        originalFileName: 'proxy.mp4',
        createdAt: new Date(createdAt),
      },
    })

    const repository = new PrismaReviewAnnotationRepository(client)
    const port = await getFreePort()
    const baseUrl = `http://127.0.0.1:${port}`
    server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port)], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        __NEXT_PROCESSED_ENV: 'true',
        APOLLO_API_ENVIRONMENT: 'production',
      },
      stdio: 'ignore',
    })
    await waitForServer(baseUrl, server)
    const authorization = `Bearer ${issued.token}`
    const reviewUrl = `${baseUrl}/v1/projects/${projectResult.project.id}/annotations`
    const initialResponse = await fetch(`${reviewUrl}?limit=10`, { headers: { authorization } })
    const initialPayload = await initialResponse.json()
    assert.equal(initialResponse.status, 200, JSON.stringify(initialPayload))
    assert.equal(initialPayload.data.session.projectVersionId, projectResult.version.id)
    assert.equal(initialPayload.data.session.proxyArtifactId, artifactId)
    assert.equal(initialPayload.data.session.proxyHash, proxyHash)
    assert.equal(initialPayload.data.session.stale, false)
    assert.equal(initialPayload.data.versions.length, 1)
    assert.equal(initialPayload.data.versions[0].current, true)
    assert.equal(initialPayload.data.scopeContext.options.length, 9)
    assert.equal(initialPayload.data.annotations.length, 0)

    const annotationRequest = {
      projectVersionId: projectResult.version.id,
      proxyArtifactId: artifactId,
      proxyHash,
      frame: 30,
      timeRangeMs: [1000, 1000],
      screenshotRef: 'data:image/jpeg;base64,/9j/2Q==',
      scope: 'region',
      region: { x: 0.1, y: 0.2, width: 0.3, height: 0.2 },
      targetIds: [],
      text: 'Manter a legenda abaixo do rosto.',
    }
    const postAnnotation = () => fetch(reviewUrl, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': 'review-integration-annotation',
      },
      body: JSON.stringify(annotationRequest),
    })
    const firstResponse = await postAnnotation()
    const firstPayload = await firstResponse.json()
    const replayResponse = await postAnnotation()
    const replayPayload = await replayResponse.json()
    assert.equal(firstResponse.status, 201, JSON.stringify(firstPayload))
    assert.equal(replayResponse.status, 200, JSON.stringify(replayPayload))
    assert.equal(firstPayload.data.replayed, false)
    assert.equal(replayPayload.data.replayed, true)
    assert.equal(replayPayload.data.annotation.id, firstPayload.data.annotation.id)
    assert.equal(firstPayload.data.annotation.applicationScope.kind, 'region')
    assert.deepEqual(firstPayload.data.annotation.applicationScope.formatIds, ['9:16'])
    assert.deepEqual(firstPayload.data.annotation.applicationScope.localeIds, ['pt-BR'])
    assert.equal(firstPayload.data.annotation.affectedCount, 1)

    const globalRequest = {
      ...annotationRequest,
      frame: 45,
      timeRangeMs: [1500, 1500],
      applicationScope: { kind: 'formats', global: true },
      text: 'Aplicar o mesmo ajuste em todos os formatos.',
    }
    const unconfirmedGlobalResponse = await fetch(reviewUrl, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': 'review-integration-global-annotation',
      },
      body: JSON.stringify(globalRequest),
    })
    assert.equal(unconfirmedGlobalResponse.status, 428)
    const confirmedGlobalResponse = await fetch(reviewUrl, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        'idempotency-key': 'review-integration-global-annotation',
      },
      body: JSON.stringify({ ...globalRequest, confirmedGlobal: true }),
    })
    const confirmedGlobalPayload = await confirmedGlobalResponse.json()
    assert.equal(confirmedGlobalResponse.status, 201, JSON.stringify(confirmedGlobalPayload))
    assert.equal(confirmedGlobalPayload.data.annotation.applicationScope.kind, 'formats')
    assert.equal(confirmedGlobalPayload.data.annotation.applicationScope.global, true)
    assert.equal(confirmedGlobalPayload.data.annotation.affectedCount, 1)

    const stored = await repository.list({
      workspaceId,
      projectId: projectResult.project.id,
      projectVersionId: projectResult.version.id,
      limit: 10,
    })
    const projectAfterReview = await client.v2Project.findUnique({
      where: { id: projectResult.project.id },
      include: { versions: true },
    })

    assert.equal(stored.length, 2)
    const regional = stored.find((annotation) => annotation.applicationScope.kind === 'region')
    const global = stored.find((annotation) => annotation.applicationScope.kind === 'formats')
    assert.deepEqual(regional.region, annotationRequest.region)
    assert.equal(regional.affectedCount, 1)
    assert.equal(global.applicationScope.global, true)
    assert.equal(global.affectedCount, 1)
    assert.equal(projectAfterReview.currentVersionId, projectResult.version.id)
    assert.equal(projectAfterReview.versions.length, 1)
  } finally {
    if (server && server.exitCode === null) {
      server.kill()
      await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))])
    }
    await cleanup()
    await client.$disconnect()
  }
})
