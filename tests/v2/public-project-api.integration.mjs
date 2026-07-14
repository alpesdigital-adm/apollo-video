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

test('authenticated public API manages projects, clients and artifact inspection', async () => {
  const clientPackage =
    process.env.APOLLO_V2_PERSISTENCE === 'postgres'
      ? '../../generated/prisma-v2/index.js'
      : '@prisma/client'
  const { PrismaClient } = await import(clientPackage)
  const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
  const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
  const {
    createMediaArtifactManifest,
    createReconstructableMediaArtifactManifest,
  } = await import(
    '../../src/v2/domain/media-artifact.ts'
  )
  const { createRenderInputSpec } = await import('../../src/v2/domain/render-input.ts')
  const { PrismaApiClientRepository } = await import(
    '../../src/v2/infrastructure/prisma/api-client-repository.ts'
  )
  const { PrismaMediaArtifactRepository } = await import(
    '../../src/v2/infrastructure/prisma/media-artifact-repository.ts'
  )
  const { PrismaMaterializationAuthorizationRepository } = await import(
    '../../src/v2/infrastructure/prisma/materialization-authorization-repository.ts'
  )
  const { PrismaWorkspaceRepository } = await import(
    '../../src/v2/infrastructure/prisma/workspace-repository.ts'
  )
  const { nodeApiCredentialCrypto } = await import(
    '../../src/v2/infrastructure/security/api-credential.ts'
  )
  const { createAesRecipeParameterCipher } = await import(
    '../../src/v2/infrastructure/security/recipe-parameter-cipher.ts'
  )

  const client = new PrismaClient()
  const apiEnvironment =
    process.env.APOLLO_V2_PERSISTENCE === 'postgres' ? 'production' : 'sandbox'
  const workspaceId = 'public-api-workspace-v2'
  const otherWorkspaceId = 'public-api-other-workspace-v2'
  const workspaceIds = [workspaceId, otherWorkspaceId]
  const apiClientId = 'public-api-client-v2'
  const sourceArtifactId = 'public-api-source-artifact-v2'
  const derivedArtifactId = 'public-api-derived-artifact-v2'
  const derivedManifestId = 'public-api-derived-manifest-v2'
  const otherArtifactId = 'public-api-other-artifact-v2'
  const sha = (character) => character.repeat(64)
  let server

  const cleanup = async () => {
    await client.v2ArtifactRenderOperation.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    })
    await client.v2PublicOperation.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    })
    await client.v2AssetUseDecision.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    })
    await client.v2MaterializationAuthorization.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    })
    await client.v2MediaArtifactLineage.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    })
    await client.v2MediaArtifactManifest.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    })
    await client.v2MediaArtifact.updateMany({
      where: { workspaceId: { in: workspaceIds } },
      data: { currentRightsSnapshotId: null },
    })
    await client.v2AssetRightsSnapshot.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    })
    await client.v2MediaArtifact.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    })
    await client.v2RenderInputPayload.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    })
    await client.v2RecipeParameterPayload.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    })
    await client.v2PublicEventOutbox.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    })
    await client.v2IdempotencyRecord.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    })
    await client.v2Project.deleteMany({ where: { workspaceId: { in: workspaceIds } } })
    await client.v2ApiClient.deleteMany({ where: { workspaceId: { in: workspaceIds } } })
    await client.v2Workspace.deleteMany({ where: { id: { in: workspaceIds } } })
  }

  try {
    await cleanup()

    const workspaces = new PrismaWorkspaceRepository(client)
    await workspaces.create(
      createWorkspace({
        id: workspaceId,
        slug: 'public-api-workspace-v2',
        name: 'Public API Workspace V2',
        status: 'active',
        createdAt: '2026-07-12T16:00:00.000Z',
      }),
    )
    await workspaces.create(
      createWorkspace({
        id: otherWorkspaceId,
        slug: 'public-api-other-workspace-v2',
        name: 'Other Public API Workspace V2',
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
      scopes: [
        'artifacts:read',
        'artifacts:render',
        'artifacts:rights',
        'clients:admin',
        'operations:cancel',
        'operations:read',
        'operations:retry',
        'projects:read',
        'projects:write',
      ],
    })

    const artifacts = new PrismaMediaArtifactRepository(
      client,
      createAesRecipeParameterCipher({
        keyId: 'public-api-recipe-key-v1',
        key: Buffer.alloc(32, 9),
      }),
    )
    const sourceKey = 'workspaces/public-api/raw/source.mov'
    const sourceManifest = createMediaArtifactManifest({
      artifactKey: sourceKey,
      artifactSha256: sha('a'),
      byteSize: 4096,
      mediaType: 'video',
      container: 'mov',
      recipe: { id: 'ingest-source', version: 'v1', parameters: {} },
      probe: { width: 1920, height: 1080, duration: 20, fps: 30 },
    })
    await artifacts.persistOrReplay({
      workspaceId,
      artifactId: sourceArtifactId,
      manifestId: 'public-api-source-manifest-v2',
      lineageIds: [],
      manifest: sourceManifest,
      createdAt: '2026-07-12T16:02:00.000Z',
    })
    const derivedRenderInput = createRenderInputSpec({
      schemaVersion: 'render-input/v1',
      renderer: { id: 'remotion', version: '4.0.489', digest: sha('8') },
      composition: {
        id: 'apollo-video',
        version: 'v1',
        propsSchemaRef: 'apollo://render-props/apollo-video/v1',
      },
      plan: {
        id: 'plan-public-api-persisted',
        versionId: 'plan-version-public-api-persisted',
        hash: sha('9'),
      },
      output: {
        id: 'preset-9x16',
        locale: 'pt-BR',
        aspectRatio: '9:16',
        width: 1080,
        height: 1920,
        fps: 30,
        safeArea: { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 },
        durationInFrames: 555,
      },
      assets: [
        {
          id: 'asset-persisted-source',
          artifactId: sourceArtifactId,
          artifactKey: sourceKey,
          kind: 'video',
          role: 'primary',
          ordinal: 0,
          sha256: sha('a'),
          byteSize: 4096,
        },
      ],
      props: {
        primaryVideoAssetId: 'asset-persisted-source',
        title: 'protected-api-render-input-value',
      },
    })
    const derivedReplayable = createReconstructableMediaArtifactManifest({
      artifactKey: 'workspaces/public-api/derived/final.mp4',
      artifactSha256: sha('b'),
      byteSize: 8192,
      mediaType: 'video',
      container: 'mp4',
      recipe: {
        id: 'normalize-video',
        version: 'v3',
        parameters: { crf: 23, instruction: 'protected-api-replay-value' },
      },
      sources: [
        {
          artifactKey: sourceKey,
          sha256: sha('a'),
          role: 'primary',
          execution: {
            tool: { id: 'ffmpeg', version: '7.1.1', digest: sha('7') },
            model: {
              provider: 'openai',
              id: 'gpt-5',
              version: '2026.07',
              config: { privatePrompt: 'must-not-leak', temperature: 0 },
            },
          },
        },
      ],
      probe: { width: 1080, height: 1920, duration: 18.5, fps: 30 },
      renderInput: derivedRenderInput,
    })
    await artifacts.persistOrReplay({
      workspaceId,
      artifactId: derivedArtifactId,
      manifestId: derivedManifestId,
      lineageIds: ['public-api-derived-lineage-v2-0'],
      manifest: derivedReplayable.manifest,
      recipeParameters: derivedReplayable.recipeParameters,
      renderInput: derivedReplayable.renderInput,
      createdAt: '2026-07-12T16:03:00.000Z',
    })
    await artifacts.persistOrReplay({
      workspaceId: otherWorkspaceId,
      artifactId: otherArtifactId,
      manifestId: 'public-api-other-manifest-v2',
      lineageIds: [],
      manifest: createMediaArtifactManifest({
        artifactKey: 'workspaces/other/raw/private.mp4',
        artifactSha256: sha('c'),
        byteSize: 1024,
        mediaType: 'video',
        container: 'mp4',
        recipe: { id: 'ingest-source', version: 'v1', parameters: {} },
      }),
      createdAt: '2026-07-12T16:03:00.000Z',
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
          APOLLO_PROTECTED_PAYLOAD_KEY_ID: 'public-api-recipe-key-v1',
          APOLLO_PROTECTED_PAYLOAD_KEY: Buffer.alloc(32, 9).toString('base64url'),
          APOLLO_RENDERER_DIGEST: sha('8'),
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
    assert.equal(
      openApi.paths['/v1/artifacts/{artifactId}'].get['x-apollo-capability-id'],
      'apollo.artifacts.read',
    )
    assert.equal(
      openApi.paths['/v1/artifacts/{artifactId}/lineage-diagnostics/{manifestId}'].get[
        'x-apollo-capability-id'
      ],
      'apollo.artifacts.lineage.diagnose',
    )
    assert.equal(
      openApi.paths['/v1/artifacts/{artifactId}/provenance/{manifestId}'].get[
        'x-apollo-capability-id'
      ],
      'apollo.artifacts.provenance.read',
    )
    assert.equal(
      openApi.paths['/v1/artifacts/{artifactId}/replay-spec/{manifestId}'].get[
        'x-apollo-capability-id'
      ],
      'apollo.artifacts.replay-spec.read',
    )
    assert.equal(
      openApi.paths['/v1/artifacts/{artifactId}/render-input/{manifestId}'].get[
        'x-apollo-capability-id'
      ],
      'apollo.artifacts.render-input.read',
    )
    assert.equal(
      openApi.paths[
        '/v1/artifacts/{artifactId}/reconstruction-preflight/{manifestId}'
      ].post['x-apollo-capability-id'],
      'apollo.artifacts.reconstruction.preflight',
    )
    assert.equal(
      openApi.paths['/v1/artifacts/{artifactId}/rights'].put[
        'x-apollo-capability-id'
      ],
      'apollo.artifacts.rights.set',
    )
    assert.equal(
      openApi.paths[
        '/v1/artifacts/{artifactId}/materialization-authorizations/{manifestId}'
      ].post['x-apollo-capability-id'],
      'apollo.artifacts.materialization.authorize',
    )
    assert.equal(
      openApi.paths['/v1/render-inputs/preflight'].post['x-apollo-capability-id'],
      'apollo.render-inputs.preflight',
    )
    assert.equal(
      openApi.paths['/v1/artifacts/{artifactId}/renders/{manifestId}'].post[
        'x-apollo-capability-id'
      ],
      'apollo.artifacts.render.enqueue',
    )
    assert.equal(
      openApi.paths['/v1/events/catalog'].get['x-apollo-capability-id'],
      'apollo.events.catalog.read',
    )
    assert.equal(
      openApi.paths['/v1/operations'].get['x-apollo-capability-id'],
      'apollo.operations.list',
    )
    assert.deepEqual(
      openApi.paths['/v1/operations'].get.parameters.map((parameter) => parameter.name),
      ['limit', 'after', 'status', 'type', 'targetId'],
    )
    assert.equal(
      openApi.paths['/v1/operations/dead-letter'].get['x-apollo-capability-id'],
      'apollo.operations.dead-letter.list',
    )
    assert.deepEqual(
      openApi.paths['/v1/operations/dead-letter'].get.parameters.map(
        (parameter) => parameter.name,
      ),
      ['limit', 'after', 'type', 'targetId'],
    )
    assert.equal(
      openApi.paths['/v1/operations/{operationId}'].get['x-apollo-capability-id'],
      'apollo.operations.read',
    )
    assert.equal(
      openApi.paths['/v1/operations/{operationId}/cancel'].post[
        'x-apollo-capability-id'
      ],
      'apollo.operations.cancel',
    )
    assert.equal(
      openApi.paths['/v1/operations/{operationId}/retry'].post[
        'x-apollo-capability-id'
      ],
      'apollo.operations.retry',
    )

    const schemaResponse = await fetch(
      `${baseUrl}/v1/schemas/create-project-request/v1`,
    )
    const schema = await schemaResponse.json()
    assert.equal(schemaResponse.status, 200)
    assert.match(schemaResponse.headers.get('content-type'), /^application\/schema\+json/)
    assert.equal(schema.$id, 'apollo://schemas/create-project-request/v1')
    assert.deepEqual(schema.required, ['name'])
    assert.deepEqual(schema.examples, [{ name: 'Anúncio de descoberta' }])

    const missingSchemaResponse = await fetch(`${baseUrl}/v1/schemas/missing/v1`)
    assert.equal(missingSchemaResponse.status, 404)

    const eventEnvelopeSchemaResponse = await fetch(
      `${baseUrl}/v1/schemas/public-event/v1`,
    )
    const eventEnvelopeSchema = await eventEnvelopeSchemaResponse.json()
    assert.equal(eventEnvelopeSchemaResponse.status, 200)
    assert.equal(eventEnvelopeSchema.$id, 'apollo://schemas/public-event/v1')
    assert.deepEqual(
      eventEnvelopeSchema.required,
      ['id', 'type', 'version', 'workspaceId', 'occurredAt', 'resource', 'data'],
    )
    const eventCatalogResponse = await fetch(`${baseUrl}/v1/events/catalog`)
    const eventCatalog = await eventCatalogResponse.json()
    assert.equal(eventCatalogResponse.status, 200)
    assert.equal(
      eventCatalog.data.envelopeSchemaRef,
      'apollo://schemas/public-event/v1',
    )
    assert.equal(eventCatalog.data.events.length, 14)
    assert.deepEqual(
      eventCatalog.data.events.map((event) => event.type),
      [
        'project.created',
        'project.version.created',
        'project.status.changed',
        'operation.status.changed',
        'operation.succeeded',
        'operation.failed',
        'annotation.created',
        'annotation.resolved',
        'quality.report.created',
        'approval.changed',
        'artifact.ready',
        'artifact.rejected',
        'budget.threshold.reached',
        'client.suspended',
      ],
    )
    assert.equal(JSON.stringify(eventCatalog).includes(workspaceId), false)

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
        'apollo.events.catalog.read',
        'apollo.projects.list',
        'apollo.artifacts.read',
        'apollo.artifacts.lineage.diagnose',
        'apollo.artifacts.provenance.read',
        'apollo.artifacts.replay-spec.read',
        'apollo.artifacts.render-input.read',
        'apollo.artifacts.reconstruction.preflight',
        'apollo.artifacts.rights.read',
        'apollo.artifacts.rights.set',
        'apollo.artifacts.materialization.authorize',
        'apollo.render-inputs.preflight',
        'apollo.artifacts.render.enqueue',
        'apollo.operations.list',
        'apollo.operations.dead-letter.list',
        'apollo.operations.read',
        'apollo.operations.cancel',
        'apollo.operations.retry',
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
        'apollo.events.catalog.read',
        'apollo.projects.list',
        'apollo.contracts.openapi.read',
        'apollo.contracts.schemas.read',
      ],
    )

    const childArtifactResponse = await fetch(
      `${baseUrl}/v1/artifacts/${derivedArtifactId}`,
      { headers: { authorization: childAuthorization } },
    )
    assert.equal(childArtifactResponse.status, 403)
    const childDiagnosticResponse = await fetch(
      `${baseUrl}/v1/artifacts/${derivedArtifactId}/lineage-diagnostics/${derivedManifestId}`,
      { headers: { authorization: childAuthorization } },
    )
    assert.equal(childDiagnosticResponse.status, 403)
    const childProvenanceResponse = await fetch(
      `${baseUrl}/v1/artifacts/${derivedArtifactId}/provenance/${derivedManifestId}`,
      { headers: { authorization: childAuthorization } },
    )
    assert.equal(childProvenanceResponse.status, 403)
    const childReplaySpecResponse = await fetch(
      `${baseUrl}/v1/artifacts/${derivedArtifactId}/replay-spec/${derivedManifestId}`,
      { headers: { authorization: childAuthorization } },
    )
    assert.equal(childReplaySpecResponse.status, 403)
    const childRenderInputMetadataResponse = await fetch(
      `${baseUrl}/v1/artifacts/${derivedArtifactId}/render-input/${derivedManifestId}`,
      { headers: { authorization: childAuthorization } },
    )
    assert.equal(childRenderInputMetadataResponse.status, 403)
    const childReconstructionPreflightResponse = await fetch(
      `${baseUrl}/v1/artifacts/${derivedArtifactId}/reconstruction-preflight/${derivedManifestId}`,
      { method: 'POST', headers: { authorization: childAuthorization } },
    )
    assert.equal(childReconstructionPreflightResponse.status, 403)
    const childRightsResponse = await fetch(
      `${baseUrl}/v1/artifacts/${sourceArtifactId}/rights`,
      { headers: { authorization: childAuthorization } },
    )
    assert.equal(childRightsResponse.status, 403)
    const childRenderInputResponse = await fetch(`${baseUrl}/v1/render-inputs/preflight`, {
      method: 'POST',
      headers: {
        authorization: childAuthorization,
        'content-type': 'application/json',
      },
      body: '{}',
    })
    assert.equal(childRenderInputResponse.status, 403)

    const artifactResponse = await fetch(`${baseUrl}/v1/artifacts/${derivedArtifactId}`, {
      headers: { authorization },
    })
    const artifact = await artifactResponse.json()
    assert.equal(artifactResponse.status, 200)
    assert.equal(artifact.data.artifact.id, derivedArtifactId)
    assert.equal(artifact.data.artifact.byteSize, '8192')
    assert.equal(artifact.data.manifests.length, 1)
    assert.deepEqual(artifact.data.manifests[0].sources, [
      {
        artifactId: sourceArtifactId,
        artifactKey: sourceKey,
        sha256: sha('a'),
        role: 'primary',
        ordinal: 0,
      },
    ])
    assert.equal(JSON.stringify(artifact).includes('manifestJson'), false)
    assert.equal(JSON.stringify(artifact).includes('"parameters":'), false)
    assert.equal(JSON.stringify(artifact).includes('renderInput'), false)

    const diagnosticResponse = await fetch(
      `${baseUrl}/v1/artifacts/${derivedArtifactId}/lineage-diagnostics/${derivedManifestId}`,
      { headers: { authorization } },
    )
    const diagnostic = await diagnosticResponse.json()
    assert.equal(diagnosticResponse.status, 200)
    assert.equal(diagnostic.data.healthy, true)
    assert.deepEqual(
      diagnostic.data.nodes.map((node) => node.artifactId),
      [sourceArtifactId, derivedArtifactId],
    )
    assert.deepEqual(diagnostic.data.edges, [
      {
        sourceArtifactId,
        targetArtifactId: derivedArtifactId,
        sha256: sha('a'),
        role: 'primary',
        ordinal: 0,
      },
    ])
    assert.deepEqual(diagnostic.data.issues, [])

    const provenanceResponse = await fetch(
      `${baseUrl}/v1/artifacts/${derivedArtifactId}/provenance/${derivedManifestId}`,
      { headers: { authorization } },
    )
    const provenance = await provenanceResponse.json()
    assert.equal(provenanceResponse.status, 200)
    assert.equal(provenance.data.complete, true)
    assert.equal(provenance.data.schemaVersion, 'media-artifact-manifest/v4')
    assert.equal(provenance.data.edges[0].execution.tool.id, 'ffmpeg')
    assert.equal(provenance.data.edges[0].execution.tool.version, '7.1.1')
    assert.equal(provenance.data.edges[0].execution.tool.digest, sha('7'))
    assert.equal(provenance.data.edges[0].execution.model.provider, 'openai')
    assert.equal(provenance.data.edges[0].execution.model.id, 'gpt-5')
    assert.equal(provenance.data.edges[0].execution.model.version, '2026.07')
    assert.equal(provenance.data.edges[0].execution.model.configHash.length, 64)
    assert.equal(JSON.stringify(provenance).includes('must-not-leak'), false)
    assert.equal(JSON.stringify(provenance).includes('privatePrompt'), false)

    const replaySpecResponse = await fetch(
      `${baseUrl}/v1/artifacts/${derivedArtifactId}/replay-spec/${derivedManifestId}`,
      { headers: { authorization } },
    )
    const replaySpec = await replaySpecResponse.json()
    assert.equal(replaySpecResponse.status, 200)
    assert.equal(replaySpec.data.available, true)
    assert.equal(replaySpec.data.schemaVersion, 'media-artifact-manifest/v4')
    assert.equal(
      replaySpec.data.recipe.parametersHash,
      derivedReplayable.recipeParameters.parametersHash,
    )
    assert.deepEqual(replaySpec.data.parameters, {
      ref: derivedReplayable.recipeParameters.ref,
      canonicalByteSize: derivedReplayable.recipeParameters.canonicalByteSize,
      protection: { algorithm: 'aes-256-gcm' },
    })
    assert.deepEqual(replaySpec.data.issues, [])
    assert.equal(JSON.stringify(replaySpec).includes('protected-api-replay-value'), false)
    assert.equal(JSON.stringify(replaySpec).includes('ciphertext'), false)
    assert.equal(JSON.stringify(replaySpec).includes('keyId'), false)

    const persistedRenderInputResponse = await fetch(
      `${baseUrl}/v1/artifacts/${derivedArtifactId}/render-input/${derivedManifestId}`,
      { headers: { authorization } },
    )
    const persistedRenderInput = await persistedRenderInputResponse.json()
    assert.equal(persistedRenderInputResponse.status, 200)
    assert.equal(persistedRenderInput.data.available, true)
    assert.equal(persistedRenderInput.data.schemaVersion, 'media-artifact-manifest/v4')
    assert.deepEqual(persistedRenderInput.data.renderInput, {
      ref: derivedReplayable.renderInput.ref,
      inputHash: derivedReplayable.renderInput.inputHash,
      canonicalByteSize: derivedReplayable.renderInput.canonicalByteSize,
      protection: { algorithm: 'aes-256-gcm' },
    })
    assert.deepEqual(persistedRenderInput.data.issues, [])
    assert.equal(
      JSON.stringify(persistedRenderInput).includes('protected-api-render-input-value'),
      false,
    )
    assert.equal(JSON.stringify(persistedRenderInput).includes('ciphertext'), false)
    assert.equal(JSON.stringify(persistedRenderInput).includes('keyId'), false)

    const reconstructionPreflightResponse = await fetch(
      `${baseUrl}/v1/artifacts/${derivedArtifactId}/reconstruction-preflight/${derivedManifestId}`,
      { method: 'POST', headers: { authorization } },
    )
    const reconstructionPreflight = await reconstructionPreflightResponse.json()
    assert.equal(reconstructionPreflightResponse.status, 200)
    assert.equal(reconstructionPreflight.data.payloadAuthenticated, true)
    assert.equal(reconstructionPreflight.data.eligible, true)
    assert.equal(reconstructionPreflight.data.rightsValidationRequired, true)
    assert.equal(reconstructionPreflight.data.materializationRequired, true)
    assert.equal(reconstructionPreflight.data.inputHash, derivedRenderInput.inputHash)
    assert.equal(reconstructionPreflight.data.renderer.supported, true)
    assert.equal(reconstructionPreflight.data.composition.supported, true)
    assert.deepEqual(reconstructionPreflight.data.assets, { total: 1, available: 1 })
    assert.deepEqual(reconstructionPreflight.data.issues, [])
    assert.equal(
      JSON.stringify(reconstructionPreflight).includes('protected-api-render-input-value'),
      false,
    )
    assert.equal(JSON.stringify(reconstructionPreflight).includes(sourceKey), false)
    assert.equal(JSON.stringify(reconstructionPreflight).includes('ciphertext'), false)
    assert.equal(JSON.stringify(reconstructionPreflight).includes('keyId'), false)
    const reconstructionBodyResponse = await fetch(
      `${baseUrl}/v1/artifacts/${derivedArtifactId}/reconstruction-preflight/${derivedManifestId}`,
      {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: '{}',
      },
    )
    assert.equal(reconstructionBodyResponse.status, 422)
    assert.equal((await reconstructionBodyResponse.json()).error.code, 'INVALID_ARGUMENT')

    const unconfiguredRightsResponse = await fetch(
      `${baseUrl}/v1/artifacts/${sourceArtifactId}/rights`,
      { headers: { authorization } },
    )
    const unconfiguredRights = await unconfiguredRightsResponse.json()
    assert.equal(unconfiguredRightsResponse.status, 200)
    assert.deepEqual(unconfiguredRights.data, {
      artifactId: sourceArtifactId,
      configured: false,
    })

    const missingRightsAuthorizationResponse = await fetch(
      `${baseUrl}/v1/artifacts/${derivedArtifactId}/materialization-authorizations/${derivedManifestId}`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': 'materialization-missing-rights-1',
        },
        body: JSON.stringify({ use: 'paid-ad', market: 'BR' }),
      },
    )
    const missingRightsAuthorization = await missingRightsAuthorizationResponse.json()
    assert.equal(missingRightsAuthorizationResponse.status, 201)
    assert.equal(missingRightsAuthorization.data.authorization.status, 'denied')
    assert.deepEqual(
      missingRightsAuthorization.data.authorization.decisions[0].reasonCodes,
      ['RIGHTS_MISSING'],
    )
    assert.equal('validUntil' in missingRightsAuthorization.data.authorization, false)

    const approvedRightsRequest = {
      owner: 'Public API Workspace V2',
      license: 'owned-media',
      status: 'approved',
      allowedUses: ['paid-ad'],
      prohibitedUses: [],
      allowedMarkets: ['BR'],
      allowedLocales: ['pt-BR'],
      allowedSyntheticOperations: [],
      expiresAt: '2027-07-14T12:00:00.000Z',
      consent: { status: 'not-required', allowedUses: [] },
      sourceNote: 'Internal legal note that must not leak into authorization receipts.',
    }
    const setRights = () =>
      fetch(`${baseUrl}/v1/artifacts/${sourceArtifactId}/rights`, {
        method: 'PUT',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify(approvedRightsRequest),
      })
    const setRightsResponse = await setRights()
    const setRightsResult = await setRightsResponse.json()
    assert.equal(setRightsResponse.status, 200)
    assert.equal(setRightsResult.data.replayed, false)
    assert.equal(setRightsResult.data.rights.status, 'approved')
    assert.equal(setRightsResult.data.rights.sequence, 1)
    assert.equal(setRightsResult.data.rights.snapshotHash.length, 64)

    const replayRightsResponse = await setRights()
    const replayRights = await replayRightsResponse.json()
    assert.equal(replayRightsResponse.status, 200)
    assert.equal(replayRights.data.replayed, true)
    assert.equal(replayRights.data.rights.id, setRightsResult.data.rights.id)

    const currentRightsResponse = await fetch(
      `${baseUrl}/v1/artifacts/${sourceArtifactId}/rights`,
      { headers: { authorization } },
    )
    const currentRights = await currentRightsResponse.json()
    assert.equal(currentRightsResponse.status, 200)
    assert.equal(currentRights.data.configured, true)
    assert.equal(currentRights.data.rights.id, setRightsResult.data.rights.id)

    const createMaterializationAuthorization = (key, body = { use: 'paid-ad', market: 'BR' }) =>
      fetch(
        `${baseUrl}/v1/artifacts/${derivedArtifactId}/materialization-authorizations/${derivedManifestId}`,
        {
          method: 'POST',
          headers: {
            authorization,
            'content-type': 'application/json',
            'idempotency-key': key,
          },
          body: JSON.stringify(body),
        },
      )
    const materializationResponse = await createMaterializationAuthorization(
      'materialization-approved-1',
    )
    const materialization = await materializationResponse.json()
    assert.equal(materializationResponse.status, 201)
    assert.equal(materialization.data.authorization.status, 'authorized')
    assert.equal(materialization.data.authorization.locale, 'pt-BR')
    assert.equal(materialization.data.authorization.revalidationRequired, true)
    assert.deepEqual(materialization.data.authorization.issues, [])
    assert.deepEqual(
      materialization.data.authorization.decisions.map((decision) => decision.outcome),
      ['allow'],
    )
    assert.equal(JSON.stringify(materialization).includes(sourceKey), false)
    assert.equal(JSON.stringify(materialization).includes('Internal legal note'), false)

    const materializationReplayResponse = await createMaterializationAuthorization(
      'materialization-approved-1',
    )
    const materializationReplay = await materializationReplayResponse.json()
    assert.equal(materializationReplayResponse.status, 200)
    assert.equal(materializationReplay.data.replayed, true)
    assert.equal(
      materializationReplay.data.authorization.id,
      materialization.data.authorization.id,
    )
    const materializationMismatchResponse = await createMaterializationAuthorization(
      'materialization-approved-1',
      { use: 'organic-content', market: 'BR' },
    )
    assert.equal(materializationMismatchResponse.status, 409)
    assert.equal(
      (await materializationMismatchResponse.json()).error.code,
      'IDEMPOTENCY_PAYLOAD_MISMATCH',
    )
    assert.equal(
      await client.v2MaterializationAuthorization.count({
        where: { workspaceId, id: materialization.data.authorization.id },
      }),
      1,
    )
    assert.equal(
      await client.v2AssetUseDecision.count({
        where: { workspaceId, authorizationId: materialization.data.authorization.id },
      }),
      1,
    )
    const storedAuthorization = await new PrismaMaterializationAuthorizationRepository(
      client,
    ).findById(workspaceId, materialization.data.authorization.id)
    assert.equal(storedAuthorization.id, materialization.data.authorization.id)
    assert.equal(storedAuthorization.status, 'authorized')
    assert.equal(storedAuthorization.decisions[0].rightsSnapshotHash.length, 64)
    assert.equal(
      await new PrismaMaterializationAuthorizationRepository(client).findById(
        otherWorkspaceId,
        materialization.data.authorization.id,
      ),
      null,
    )

    const enqueueRender = (
      key,
      authorizationId = materialization.data.authorization.id,
      bodyOverrides = {},
    ) =>
      fetch(
        `${baseUrl}/v1/artifacts/${derivedArtifactId}/renders/${derivedManifestId}`,
        {
          method: 'POST',
          headers: {
            authorization,
            'content-type': 'application/json',
            'idempotency-key': key,
          },
          body: JSON.stringify({ authorizationId, ...bodyOverrides }),
        },
      )
    const renderOperationResponse = await enqueueRender('render-operation-approved-1')
    const renderOperation = await renderOperationResponse.json()
    assert.equal(renderOperationResponse.status, 202)
    assert.equal(renderOperation.data.replayed, false)
    assert.equal(renderOperation.data.operation.schemaVersion, 'public-operation/v1')
    assert.equal(renderOperation.data.operation.type, 'artifact-render')
    assert.equal(renderOperation.data.operation.status, 'queued')
    assert.equal(renderOperation.data.operation.phase, 'queued')
    assert.deepEqual(renderOperation.data.operation.progress, {
      completed: 0,
      total: 1,
      unit: 'render',
    })
    assert.deepEqual(renderOperation.data.operation.target, {
      type: 'media-artifact',
      id: derivedArtifactId,
      manifestId: derivedManifestId,
    })
    const publicOperationJson = JSON.stringify(renderOperation)
    assert.equal(publicOperationJson.includes(materialization.data.authorization.id), false)
    assert.equal(publicOperationJson.includes(derivedRenderInput.inputHash), false)
    assert.equal(publicOperationJson.includes(sourceKey), false)
    assert.equal(publicOperationJson.includes('file:'), false)

    const renderOperationReplayResponse = await enqueueRender('render-operation-approved-1')
    const renderOperationReplay = await renderOperationReplayResponse.json()
    assert.equal(renderOperationReplayResponse.status, 202)
    assert.equal(renderOperationReplay.data.replayed, true)
    assert.equal(
      renderOperationReplay.data.operation.id,
      renderOperation.data.operation.id,
    )
    const renderOperationMismatchResponse = await enqueueRender(
      'render-operation-approved-1',
      'another-authorization-id',
    )
    assert.equal(renderOperationMismatchResponse.status, 409)
    assert.equal(
      (await renderOperationMismatchResponse.json()).error.code,
      'IDEMPOTENCY_PAYLOAD_MISMATCH',
    )
    const invalidRenderOperationResponse = await enqueueRender(
      'render-operation-invalid-body',
      materialization.data.authorization.id,
      { outputPath: 'must-not-be-accepted' },
    )
    assert.equal(invalidRenderOperationResponse.status, 422)

    const operationReadResponse = await fetch(
      `${baseUrl}/v1/operations/${renderOperation.data.operation.id}`,
      { headers: { authorization } },
    )
    const operationRead = await operationReadResponse.json()
    assert.equal(operationReadResponse.status, 200)
    assert.deepEqual(operationRead.data.operation, renderOperation.data.operation)
    const childCancelResponse = await fetch(
      `${baseUrl}/v1/operations/${renderOperation.data.operation.id}/cancel`,
      { method: 'POST', headers: { authorization: childAuthorization } },
    )
    assert.equal(childCancelResponse.status, 403)
    const cancelOperationRequest = () => fetch(
      `${baseUrl}/v1/operations/${renderOperation.data.operation.id}/cancel`,
      { method: 'POST', headers: { authorization } },
    )
    const canceledOperationResponse = await cancelOperationRequest()
    const canceledOperation = await canceledOperationResponse.json()
    assert.equal(canceledOperationResponse.status, 200)
    assert.equal(canceledOperation.data.operation.status, 'canceled')
    assert.equal(canceledOperation.data.operation.phase, 'canceled')
    assert.equal(canceledOperation.data.operation.cancelable, false)
    assert.equal(canceledOperation.data.operation.retryable, false)
    assert.equal(typeof canceledOperation.data.operation.completedAt, 'string')
    const canceledReplayResponse = await cancelOperationRequest()
    const canceledReplay = await canceledReplayResponse.json()
    assert.equal(canceledReplayResponse.status, 200)
    assert.deepEqual(canceledReplay.data.operation, canceledOperation.data.operation)
    const childRetryResponse = await fetch(
      `${baseUrl}/v1/operations/${renderOperation.data.operation.id}/retry`,
      { method: 'POST', headers: { authorization: childAuthorization } },
    )
    assert.equal(childRetryResponse.status, 403)
    const retryOperationRequest = () => fetch(
      `${baseUrl}/v1/operations/${renderOperation.data.operation.id}/retry`,
      { method: 'POST', headers: { authorization } },
    )
    const retriedOperationResponse = await retryOperationRequest()
    const retriedOperation = await retriedOperationResponse.json()
    assert.equal(retriedOperationResponse.status, 200)
    assert.equal(retriedOperation.data.operation.status, 'queued')
    assert.equal(retriedOperation.data.operation.phase, 'queued')
    assert.equal(retriedOperation.data.operation.attempt, 0)
    assert.equal(retriedOperation.data.operation.cancelable, true)
    assert.equal('completedAt' in retriedOperation.data.operation, false)
    const retriedReplayResponse = await retryOperationRequest()
    assert.deepEqual(
      (await retriedReplayResponse.json()).data.operation,
      retriedOperation.data.operation,
    )
    const canceledReadResponse = await fetch(
      `${baseUrl}/v1/operations/${renderOperation.data.operation.id}`,
      { headers: { authorization } },
    )
    assert.deepEqual(
      (await canceledReadResponse.json()).data.operation,
      retriedOperation.data.operation,
    )
    const secondRenderOperationResponse = await enqueueRender('render-operation-approved-2')
    const secondRenderOperation = await secondRenderOperationResponse.json()
    assert.equal(secondRenderOperationResponse.status, 202)
    assert.notEqual(
      secondRenderOperation.data.operation.id,
      renderOperation.data.operation.id,
    )
    const childListResponse = await fetch(`${baseUrl}/v1/operations`, {
      headers: { authorization: childAuthorization },
    })
    assert.equal(childListResponse.status, 403)
    const listQuery = new URLSearchParams({
      limit: '1',
      status: 'queued',
      type: 'artifact-render',
      targetId: derivedArtifactId,
    })
    const firstOperationPageResponse = await fetch(
      `${baseUrl}/v1/operations?${listQuery}`,
      { headers: { authorization } },
    )
    const firstOperationPage = await firstOperationPageResponse.json()
    assert.equal(firstOperationPageResponse.status, 200)
    assert.equal(firstOperationPage.data.operations.length, 1)
    assert.match(firstOperationPage.data.nextCursor, /^[A-Za-z0-9_-]+$/)
    const secondPageQuery = new URLSearchParams(listQuery)
    secondPageQuery.set('after', firstOperationPage.data.nextCursor)
    const secondOperationPageResponse = await fetch(
      `${baseUrl}/v1/operations?${secondPageQuery}`,
      { headers: { authorization } },
    )
    const secondOperationPage = await secondOperationPageResponse.json()
    assert.equal(secondOperationPageResponse.status, 200)
    assert.equal(secondOperationPage.data.operations.length, 1)
    assert.equal('nextCursor' in secondOperationPage.data, false)
    assert.deepEqual(
      [
        firstOperationPage.data.operations[0].id,
        secondOperationPage.data.operations[0].id,
      ].sort(),
      [
        renderOperation.data.operation.id,
        secondRenderOperation.data.operation.id,
      ].sort(),
    )
    const operationListJson = JSON.stringify([
      firstOperationPage,
      secondOperationPage,
    ])
    assert.equal(operationListJson.includes(materialization.data.authorization.id), false)
    assert.equal(operationListJson.includes(derivedRenderInput.inputHash), false)
    assert.equal(operationListJson.includes(sourceKey), false)

    const emptyOperationListResponse = await fetch(
      `${baseUrl}/v1/operations?status=failed&targetId=${derivedArtifactId}`,
      { headers: { authorization } },
    )
    assert.deepEqual((await emptyOperationListResponse.json()).data.operations, [])
    for (const invalidQuery of [
      'limit=0',
      'limit=101',
      'status=unknown',
      'type=internal-render',
      'after=not-a-cursor',
      'status=queued&status=failed',
      'sql=status%3Dqueued',
      `status=failed&after=${encodeURIComponent(firstOperationPage.data.nextCursor)}`,
    ]) {
      const invalidListResponse = await fetch(
        `${baseUrl}/v1/operations?${invalidQuery}`,
        { headers: { authorization } },
      )
      assert.equal(invalidListResponse.status, 422)
      assert.equal((await invalidListResponse.json()).error.code, 'INVALID_ARGUMENT')
    }

    for (const operationId of [
      renderOperation.data.operation.id,
      secondRenderOperation.data.operation.id,
    ]) {
      const stored = await client.v2PublicOperation.findUniqueOrThrow({
        where: { id: operationId },
      })
      const startedAt = new Date(stored.createdAt.getTime() + 1)
      const completedAt = new Date(stored.createdAt.getTime() + 2)
      await client.v2PublicOperation.update({
        where: { id: operationId },
        data: {
          status: 'failed',
          phase: 'failed',
          cancelable: false,
          retryable: false,
          attempt: 1,
          maxAttempts: 1,
          errorCode: 'render_execution_failed',
          errorMessage: 'Render operation exhausted automatic retry capacity',
          errorRetryable: false,
          startedAt,
          completedAt,
          updatedAt: completedAt,
          nextAttemptAt: null,
          deadLetteredAt: completedAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
        },
      })
    }
    const childDeadLetterResponse = await fetch(
      `${baseUrl}/v1/operations/dead-letter`,
      { headers: { authorization: childAuthorization } },
    )
    assert.equal(childDeadLetterResponse.status, 403)
    const deadLetterQuery = new URLSearchParams({
      limit: '1',
      type: 'artifact-render',
      targetId: derivedArtifactId,
    })
    const firstDeadLetterPageResponse = await fetch(
      `${baseUrl}/v1/operations/dead-letter?${deadLetterQuery}`,
      { headers: { authorization } },
    )
    const firstDeadLetterPage = await firstDeadLetterPageResponse.json()
    assert.equal(firstDeadLetterPageResponse.status, 200)
    assert.equal(firstDeadLetterPage.data.operations.length, 1)
    assert.equal(firstDeadLetterPage.data.operations[0].status, 'failed')
    assert.equal(firstDeadLetterPage.data.operations[0].retryable, false)
    assert.match(firstDeadLetterPage.data.nextCursor, /^[A-Za-z0-9_-]+$/)
    const secondDeadLetterQuery = new URLSearchParams(deadLetterQuery)
    secondDeadLetterQuery.set('after', firstDeadLetterPage.data.nextCursor)
    const secondDeadLetterPageResponse = await fetch(
      `${baseUrl}/v1/operations/dead-letter?${secondDeadLetterQuery}`,
      { headers: { authorization } },
    )
    const secondDeadLetterPage = await secondDeadLetterPageResponse.json()
    assert.equal(secondDeadLetterPageResponse.status, 200)
    assert.equal(secondDeadLetterPage.data.operations.length, 1)
    assert.equal('nextCursor' in secondDeadLetterPage.data, false)
    assert.deepEqual(
      [
        firstDeadLetterPage.data.operations[0].id,
        secondDeadLetterPage.data.operations[0].id,
      ].sort(),
      [
        renderOperation.data.operation.id,
        secondRenderOperation.data.operation.id,
      ].sort(),
    )
    const deadLetterJson = JSON.stringify([firstDeadLetterPage, secondDeadLetterPage])
    assert.equal(deadLetterJson.includes(materialization.data.authorization.id), false)
    assert.equal(deadLetterJson.includes(derivedRenderInput.inputHash), false)
    assert.equal(deadLetterJson.includes('deadLetteredAt'), false)

    for (const invalidQuery of [
      'status=failed',
      'limit=0',
      `targetId=another-target-id&after=${encodeURIComponent(firstDeadLetterPage.data.nextCursor)}`,
    ]) {
      const invalidDeadLetterResponse = await fetch(
        `${baseUrl}/v1/operations/dead-letter?${invalidQuery}`,
        { headers: { authorization } },
      )
      assert.equal(invalidDeadLetterResponse.status, 422)
      assert.equal((await invalidDeadLetterResponse.json()).error.code, 'INVALID_ARGUMENT')
    }
    const retriedDeadLetterResponse = await fetch(
      `${baseUrl}/v1/operations/${firstDeadLetterPage.data.operations[0].id}/retry`,
      { method: 'POST', headers: { authorization } },
    )
    const retriedDeadLetter = await retriedDeadLetterResponse.json()
    assert.equal(retriedDeadLetterResponse.status, 200)
    assert.equal(retriedDeadLetter.data.operation.status, 'retrying')
    assert.equal(retriedDeadLetter.data.operation.attempt, 1)
    assert.equal(retriedDeadLetter.data.operation.maxAttempts, 2)
    const remainingDeadLetterResponse = await fetch(
      `${baseUrl}/v1/operations/dead-letter?targetId=${derivedArtifactId}`,
      { headers: { authorization } },
    )
    const remainingDeadLetter = await remainingDeadLetterResponse.json()
    assert.equal(remainingDeadLetter.data.operations.length, 1)
    assert.equal(
      remainingDeadLetter.data.operations[0].id,
      secondDeadLetterPage.data.operations[0].id,
    )
    const missingOperationResponse = await fetch(
      `${baseUrl}/v1/operations/missing-operation-id`,
      { headers: { authorization } },
    )
    assert.equal(missingOperationResponse.status, 404)
    assert.equal(
      (await missingOperationResponse.json()).error.code,
      'PUBLIC_OPERATION_NOT_FOUND',
    )
    const missingCancellationResponse = await fetch(
      `${baseUrl}/v1/operations/missing-operation-id/cancel`,
      { method: 'POST', headers: { authorization } },
    )
    assert.equal(missingCancellationResponse.status, 404)
    const missingRetryResponse = await fetch(
      `${baseUrl}/v1/operations/missing-operation-id/retry`,
      { method: 'POST', headers: { authorization } },
    )
    assert.equal(missingRetryResponse.status, 404)
    assert.equal(
      await client.v2PublicOperation.count({ where: { workspaceId } }),
      2,
    )
    const storedRenderOperation = await client.v2ArtifactRenderOperation.findUnique({
      where: { operationId: renderOperation.data.operation.id },
    })
    assert.equal(storedRenderOperation.authorizationId, materialization.data.authorization.id)
    assert.equal(storedRenderOperation.inputHash, derivedRenderInput.inputHash)

    const legacyRenderInputResponse = await fetch(
      `${baseUrl}/v1/artifacts/${sourceArtifactId}/render-input/public-api-source-manifest-v2`,
      { headers: { authorization } },
    )
    const legacyRenderInput = await legacyRenderInputResponse.json()
    assert.equal(legacyRenderInputResponse.status, 200)
    assert.equal(legacyRenderInput.data.available, false)
    assert.equal('renderInput' in legacyRenderInput.data, false)
    assert.deepEqual(
      legacyRenderInput.data.issues.map((issue) => issue.code),
      ['RENDER_INPUT_MISSING'],
    )
    const legacyReconstructionPreflightResponse = await fetch(
      `${baseUrl}/v1/artifacts/${sourceArtifactId}/reconstruction-preflight/public-api-source-manifest-v2`,
      { method: 'POST', headers: { authorization } },
    )
    const legacyReconstructionPreflight = await legacyReconstructionPreflightResponse.json()
    assert.equal(legacyReconstructionPreflightResponse.status, 200)
    assert.equal(legacyReconstructionPreflight.data.payloadAuthenticated, false)
    assert.equal(legacyReconstructionPreflight.data.eligible, false)
    assert.deepEqual(
      legacyReconstructionPreflight.data.issues.map((issue) => issue.code),
      ['RENDER_INPUT_MISSING'],
    )

    const renderInputRequest = {
      schemaVersion: 'render-input/v1',
      renderer: { id: 'remotion', version: '4.0.489', digest: sha('8') },
      composition: {
        id: 'apollo-video',
        version: 'v1',
        propsSchemaRef: 'apollo://render-props/apollo-video/v1',
      },
      plan: {
        id: 'plan-public-api',
        versionId: 'plan-version-public-api',
        hash: sha('9'),
      },
      output: {
        id: 'preset-9x16',
        locale: 'pt-BR',
        aspectRatio: '9:16',
        width: 1080,
        height: 1920,
        fps: 30,
        safeArea: { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 },
        durationInFrames: 600,
      },
      assets: [
        {
          id: 'asset-primary-video',
          artifactId: sourceArtifactId,
          artifactKey: sourceKey,
          kind: 'video',
          role: 'primary',
          ordinal: 0,
          sha256: sha('a'),
          byteSize: 4096,
        },
      ],
      props: {
        primaryVideoAssetId: 'asset-primary-video',
        title: 'Protected input is not echoed',
      },
    }
    const renderInputResponse = await fetch(`${baseUrl}/v1/render-inputs/preflight`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(renderInputRequest),
    })
    const renderInput = await renderInputResponse.json()
    assert.equal(renderInputResponse.status, 200)
    assert.equal(renderInput.data.schemaVersion, 'render-input/v1')
    assert.equal(renderInput.data.validationScope, 'portable-envelope')
    assert.equal(renderInput.data.materializationRequired, true)
    assert.equal(renderInput.data.inputHash.length, 64)
    assert.equal(renderInput.data.composition.propsHash.length, 64)
    assert.equal(renderInput.data.assetCount, 1)
    assert.equal(renderInput.data.totalAssetBytes, '4096')
    assert.equal(JSON.stringify(renderInput).includes('Protected input is not echoed'), false)
    assert.equal(JSON.stringify(renderInput).includes(sourceKey), false)
    assert.equal(JSON.stringify(renderInput).includes('uri'), false)

    const invalidRenderInputResponse = await fetch(`${baseUrl}/v1/render-inputs/preflight`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ ...renderInputRequest, databaseId: 'must-not-be-accepted' }),
    })
    assert.equal(invalidRenderInputResponse.status, 422)
    assert.equal(
      (await invalidRenderInputResponse.json()).error.code,
      'INVALID_RENDER_INPUT',
    )

    await client.v2MediaArtifact.update({
      where: { id: sourceArtifactId },
      data: { status: 'quarantined' },
    })
    const unavailableDiagnosticResponse = await fetch(
      `${baseUrl}/v1/artifacts/${derivedArtifactId}/lineage-diagnostics/${derivedManifestId}`,
      { headers: { authorization } },
    )
    const unavailableDiagnostic = await unavailableDiagnosticResponse.json()
    assert.equal(unavailableDiagnosticResponse.status, 200)
    assert.equal(unavailableDiagnostic.data.healthy, false)
    assert.deepEqual(
      unavailableDiagnostic.data.issues.map((issue) => issue.code),
      ['ARTIFACT_UNAVAILABLE'],
    )
    await client.v2MediaArtifact.update({
      where: { id: sourceArtifactId },
      data: { status: 'available' },
    })

    const missingManifestDiagnostic = await fetch(
      `${baseUrl}/v1/artifacts/${derivedArtifactId}/lineage-diagnostics/missing-manifest-v2`,
      { headers: { authorization } },
    )
    const hiddenDiagnostic = await fetch(
      `${baseUrl}/v1/artifacts/${otherArtifactId}/lineage-diagnostics/public-api-other-manifest-v2`,
      { headers: { authorization } },
    )
    const missingReplaySpec = await fetch(
      `${baseUrl}/v1/artifacts/${derivedArtifactId}/replay-spec/missing-manifest-v2`,
      { headers: { authorization } },
    )
    const hiddenReplaySpec = await fetch(
      `${baseUrl}/v1/artifacts/${otherArtifactId}/replay-spec/public-api-other-manifest-v2`,
      { headers: { authorization } },
    )
    const missingRenderInput = await fetch(
      `${baseUrl}/v1/artifacts/${derivedArtifactId}/render-input/missing-manifest-v2`,
      { headers: { authorization } },
    )
    const hiddenRenderInput = await fetch(
      `${baseUrl}/v1/artifacts/${otherArtifactId}/render-input/public-api-other-manifest-v2`,
      { headers: { authorization } },
    )
    const missingReconstructionPreflight = await fetch(
      `${baseUrl}/v1/artifacts/${derivedArtifactId}/reconstruction-preflight/missing-manifest-v2`,
      { method: 'POST', headers: { authorization } },
    )
    const hiddenReconstructionPreflight = await fetch(
      `${baseUrl}/v1/artifacts/${otherArtifactId}/reconstruction-preflight/public-api-other-manifest-v2`,
      { method: 'POST', headers: { authorization } },
    )
    assert.equal(missingManifestDiagnostic.status, 404)
    assert.equal(hiddenDiagnostic.status, 404)
    assert.equal(missingReplaySpec.status, 404)
    assert.equal(hiddenReplaySpec.status, 404)
    assert.equal(missingRenderInput.status, 404)
    assert.equal(hiddenRenderInput.status, 404)
    assert.equal(missingReconstructionPreflight.status, 404)
    assert.equal(hiddenReconstructionPreflight.status, 404)

    const hiddenArtifactResponse = await fetch(
      `${baseUrl}/v1/artifacts/${otherArtifactId}`,
      { headers: { authorization } },
    )
    const missingArtifactResponse = await fetch(
      `${baseUrl}/v1/artifacts/missing-artifact-v2`,
      { headers: { authorization } },
    )
    assert.equal(hiddenArtifactResponse.status, 404)
    assert.equal(missingArtifactResponse.status, 404)
    assert.deepEqual(
      (await hiddenArtifactResponse.json()).error.code,
      (await missingArtifactResponse.json()).error.code,
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
    const projectEvents = await client.v2PublicEventOutbox.findMany({
      where: {
        workspaceId,
        resourceId: { in: [created.data.project.id, created.data.version.id] },
      },
    })
    assert.deepEqual(projectEvents.map((event) => event.type).sort(), [
      'project.created',
      'project.version.created',
    ])
    assert.ok(projectEvents.every((event) => event.actorClientId === apiClientId))
    assert.ok(projectEvents.every((event) => event.publishedAt === null))

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
    await cleanup()
    await client.$disconnect()
  }
})
