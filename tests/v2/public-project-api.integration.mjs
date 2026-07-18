import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
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
  const {
    APOLLO_SESSION_COOKIE,
    createUiPasswordHash,
    verifyUiPassword,
  } = await import('../../src/v2/infrastructure/security/ui-session.ts')
  const { createAesRecipeParameterCipher } = await import(
    '../../src/v2/infrastructure/security/recipe-parameter-cipher.ts'
  )

  const client = new PrismaClient()
  const apiEnvironment = 'production'
  const workspaceId = 'public-api-workspace-v2'
  const otherWorkspaceId = 'public-api-other-workspace-v2'
  const workspaceIds = [workspaceId, otherWorkspaceId]
  const apiClientId = 'public-api-client-v2'
  const uiUsername = 'apollo-e2e'
  const uiPassword = 'apollo-e2e-password'
  const uiPasswordHash = createUiPasswordHash(uiPassword, 'public-api-test-salt')
  const uiSessionSecret = 'public-api-ui-session-secret-with-at-least-32-characters'
  const uiEnvironment = {
    APOLLO_UI_API_CLIENT_ID: apiClientId,
    APOLLO_UI_PASSWORD_HASH: uiPasswordHash,
    APOLLO_UI_SESSION_SECRET: uiSessionSecret,
    APOLLO_UI_USERNAME: uiUsername,
  }
  assert.equal(verifyUiPassword(uiUsername, uiPassword, uiEnvironment), true)
  const sourceArtifactId = 'public-api-source-artifact-v2'
  const derivedArtifactId = 'public-api-derived-artifact-v2'
  const derivedManifestId = 'public-api-derived-manifest-v2'
  const otherArtifactId = 'public-api-other-artifact-v2'
  const webhookEndpointId = '00000000-0000-4000-8000-000000000901'
  const webhookSecretId = '00000000-0000-4000-8000-000000000909'
  const webhookSubscriptionId = '00000000-0000-4000-8000-000000000902'
  const webhookEventId = '00000000-0000-4000-8000-000000000903'
  const webhookDeliveryId = '00000000-0000-4000-8000-000000000904'
  const webhookAttemptId = '00000000-0000-4000-8000-000000000905'
  const webhookReplayEventId = '00000000-0000-4000-8000-000000000906'
  const webhookReplayDeliveryId = '00000000-0000-4000-8000-000000000907'
  const webhookReplayAttemptId = '00000000-0000-4000-8000-000000000908'
  const sha = (character) => character.repeat(64)
  let server

  const cleanup = async () => {
    await client.v2WebhookDeliveryAttempt.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    })
    await client.v2WebhookDelivery.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    })
    await client.v2WebhookSubscription.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    })
    await client.v2WebhookSigningSecretRotation.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    })
    await client.v2WebhookSigningSecretPayload.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    })
    await client.v2WebhookSigningSecret.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    })
    await client.v2WebhookEndpoint.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    })
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
        'webhooks:admin',
      ],
    })

    const webhookCreatedAt = new Date('2026-07-12T16:01:30.000Z')
    await client.v2WebhookEndpoint.create({
      data: {
        id: webhookEndpointId,
        workspaceId,
        url: 'https://hooks.example.com/public-api',
        status: 'active',
        createdByClientId: apiClientId,
        createdAt: webhookCreatedAt,
        verifiedAt: webhookCreatedAt,
      },
    })
    await client.v2WebhookSigningSecret.create({
      data: {
        id: webhookSecretId,
        workspaceId,
        endpointId: webhookEndpointId,
        version: 1,
        keyRef: 'vault://public-api/webhooks/secret-v1',
        fingerprint: sha('b'),
        status: 'active',
        createdAt: webhookCreatedAt,
      },
    })
    await client.v2WebhookSubscription.create({
      data: {
        id: webhookSubscriptionId,
        workspaceId,
        endpointId: webhookEndpointId,
        status: 'active',
        filterEventTypesJson: '["project.created"]',
        filterResourceIdsJson: '["public-api-webhook-project"]',
        filterHash: sha('d'),
        createdByClientId: apiClientId,
        createdAt: webhookCreatedAt,
      },
    })
    await client.v2PublicEventOutbox.create({
      data: {
        id: webhookEventId,
        workspaceId,
        type: 'project.created',
        version: '1.0.0',
        occurredAt: webhookCreatedAt,
        actorClientId: apiClientId,
        resourceType: 'project',
        resourceId: 'public-api-webhook-project',
        dataJson: '{}',
        publishedAt: webhookCreatedAt,
        createdAt: webhookCreatedAt,
      },
    })
    await client.v2WebhookDelivery.create({
      data: {
        id: webhookDeliveryId,
        workspaceId,
        subscriptionId: webhookSubscriptionId,
        eventId: webhookEventId,
        status: 'succeeded',
        attemptCount: 1,
        maxAttempts: 8,
        nextAttemptAt: webhookCreatedAt,
        createdAt: webhookCreatedAt,
        completedAt: new Date(webhookCreatedAt.getTime() + 1_000),
      },
    })
    await client.v2WebhookDeliveryAttempt.create({
      data: {
        id: webhookAttemptId,
        workspaceId,
        deliveryId: webhookDeliveryId,
        attemptNumber: 1,
        status: 'succeeded',
        scheduledAt: webhookCreatedAt,
        startedAt: webhookCreatedAt,
        completedAt: new Date(webhookCreatedAt.getTime() + 1_000),
        responseStatus: 204,
        responseBodyHash: sha('e'),
        createdAt: webhookCreatedAt,
      },
    })
    const webhookReplayCreatedAt = new Date(webhookCreatedAt.getTime() + 2_000)
    await client.v2PublicEventOutbox.create({
      data: {
        id: webhookReplayEventId,
        workspaceId,
        type: 'project.created',
        version: '1.0.0',
        occurredAt: webhookReplayCreatedAt,
        actorClientId: apiClientId,
        resourceType: 'project',
        resourceId: 'public-api-webhook-replay-project',
        dataJson: '{}',
        publishedAt: webhookReplayCreatedAt,
        createdAt: webhookReplayCreatedAt,
      },
    })
    await client.v2WebhookDelivery.create({
      data: {
        id: webhookReplayDeliveryId,
        workspaceId,
        subscriptionId: webhookSubscriptionId,
        eventId: webhookReplayEventId,
        status: 'succeeded',
        attemptCount: 1,
        maxAttempts: 8,
        nextAttemptAt: webhookReplayCreatedAt,
        createdAt: webhookReplayCreatedAt,
        completedAt: new Date(webhookReplayCreatedAt.getTime() + 1_000),
      },
    })
    await client.v2WebhookDeliveryAttempt.create({
      data: {
        id: webhookReplayAttemptId,
        workspaceId,
        deliveryId: webhookReplayDeliveryId,
        attemptNumber: 1,
        status: 'succeeded',
        scheduledAt: webhookReplayCreatedAt,
        startedAt: webhookReplayCreatedAt,
        completedAt: new Date(webhookReplayCreatedAt.getTime() + 1_000),
        responseStatus: 204,
        responseBodyHash: sha('f'),
        createdAt: webhookReplayCreatedAt,
      },
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
          __NEXT_PROCESSED_ENV: 'true',
          APOLLO_API_ENVIRONMENT: apiEnvironment,
          APOLLO_API_CAPABILITY_POLICY_JSON: JSON.stringify({
            byClient: { [apiClientId]: ['apollo.events.catalog.read'] },
          }),
          APOLLO_PROTECTED_PAYLOAD_KEY_ID: 'public-api-recipe-key-v1',
          APOLLO_PROTECTED_PAYLOAD_KEY: Buffer.alloc(32, 9).toString('base64url'),
          APOLLO_RENDERER_DIGEST: sha('8'),
          ...uiEnvironment,
        },
        stdio: 'ignore',
      },
    )
    await waitForServer(baseUrl, server)

    const healthResponse = await fetch(`${baseUrl}/v1/health`)
    assert.equal(healthResponse.status, 200)
    assert.equal(healthResponse.headers.get('apollo-api-version'), 'v1')
    assert.ok(healthResponse.headers.get('apollo-request-id'))

    const uiLoginResponse = await fetch(`${baseUrl}/v1/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: uiUsername, password: uiPassword, next: '/' }),
    })
    const uiLoginPayload = await uiLoginResponse.json()
    assert.equal(uiLoginResponse.status, 200, JSON.stringify(uiLoginPayload))
    assert.equal(uiLoginPayload.data.redirectTo, '/')
    const uiSession = uiLoginResponse.headers
      .get('set-cookie')
      ?.match(new RegExp(`${APOLLO_SESSION_COOKIE}=([^;]+)`))?.[1]
    assert.ok(uiSession)
    const uiSessionResponse = await fetch(`${baseUrl}/v1/session`, {
      headers: { cookie: `${APOLLO_SESSION_COOKIE}=${uiSession}` },
    })
    const uiSessionPayload = await uiSessionResponse.json()
    assert.equal(uiSessionResponse.status, 200)
    assert.equal(uiSessionPayload.data.workspaceId, workspaceId)
    const uiProjectListResponse = await fetch(`${baseUrl}/v1/projects`, {
      headers: { cookie: `${APOLLO_SESSION_COOKIE}=${uiSession}` },
    })
    assert.equal(uiProjectListResponse.status, 200)

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
    assert.equal(
      openApi.paths['/v1/webhooks/endpoints'].get['x-apollo-capability-id'],
      'apollo.webhooks.endpoints.list',
    )
    assert.equal(
      openApi.paths['/v1/webhooks/endpoints'].post['x-apollo-capability-id'],
      'apollo.webhooks.endpoints.create',
    )
    assert.equal(
      openApi.paths['/v1/webhooks/endpoints'].post.requestBody.content['application/json']
        .schema.$ref,
      '#/components/schemas/CreateWebhookEndpointRequestV1',
    )
    assert.equal(
      openApi.paths['/v1/webhooks/endpoints'].post.parameters.some(
        (parameter) => parameter.name === 'Idempotency-Key' && parameter.required,
      ),
      true,
    )
    assert.deepEqual(
      openApi.paths['/v1/webhooks/endpoints'].get.parameters.map(
        (parameter) => parameter.name,
      ),
      ['limit', 'after', 'status'],
    )
    assert.equal(
      openApi.paths['/v1/webhooks/endpoints/{endpointId}'].get[
        'x-apollo-capability-id'
      ],
      'apollo.webhooks.endpoints.read',
    )
    assert.equal(
      openApi.paths['/v1/webhooks/endpoints/{endpointId}/status'].put[
        'x-apollo-capability-id'
      ],
      'apollo.webhooks.endpoints.status.set',
    )
    assert.equal(
      openApi.paths['/v1/webhooks/endpoints/{endpointId}/status'].put
        .requestBody.content['application/json'].schema.$ref,
      '#/components/schemas/SetWebhookEndpointStatusRequestV1',
    )
    assert.equal(
      openApi.paths['/v1/webhooks/endpoints/{endpointId}/challenge'].post[
        'x-apollo-capability-id'
      ],
      'apollo.webhooks.endpoints.challenge',
    )
    assert.equal(
      'requestBody' in openApi.paths['/v1/webhooks/endpoints/{endpointId}/challenge'].post,
      false,
    )
    assert.equal(
      openApi.paths['/v1/webhooks/endpoints/{endpointId}/signing-secrets'].post[
        'x-apollo-capability-id'
      ],
      'apollo.webhooks.endpoints.signing-secrets.provision',
    )
    assert.equal(
      openApi.paths['/v1/webhooks/endpoints/{endpointId}/signing-secrets'].post
        .requestBody.content['application/json'].schema.$ref,
      '#/components/schemas/ProvisionWebhookSigningSecretRequestV1',
    )
    assert.equal(
      openApi.paths['/v1/webhooks/endpoints/{endpointId}/signing-secrets'].post
        .parameters.some(
          (parameter) => parameter.name === 'Idempotency-Key' && parameter.required,
        ),
      true,
    )
    assert.equal(
      openApi.paths['/v1/webhooks/endpoints/{endpointId}/signing-secrets/rotations'].post[
        'x-apollo-capability-id'
      ],
      'apollo.webhooks.endpoints.signing-secrets.rotations.stage',
    )
    assert.equal(
      openApi.paths['/v1/webhooks/endpoints/{endpointId}/signing-secrets/rotations'].post
        .requestBody.content['application/json'].schema.$ref,
      '#/components/schemas/StageWebhookSigningSecretRotationRequestV1',
    )
    assert.equal(
      openApi.paths['/v1/webhooks/endpoints/{endpointId}/signing-secrets/rotations'].post
        .parameters.some(
          (parameter) => parameter.name === 'Idempotency-Key' && parameter.required,
        ),
      true,
    )
    assert.equal(
      openApi.paths['/v1/webhooks/endpoints/{endpointId}/signing-secrets/rotations'].get[
        'x-apollo-capability-id'
      ],
      'apollo.webhooks.endpoints.signing-secrets.rotations.list',
    )
    assert.deepEqual(
      openApi.paths['/v1/webhooks/endpoints/{endpointId}/signing-secrets/rotations'].get
        .parameters.map((parameter) => parameter.name),
      ['endpointId', 'limit', 'after', 'status'],
    )
    assert.equal(
      openApi.paths['/v1/webhooks/endpoints/{endpointId}/signing-secrets/rotations/{rotationId}'].get[
        'x-apollo-capability-id'
      ],
      'apollo.webhooks.endpoints.signing-secrets.rotations.read',
    )
    assert.equal(
      openApi.paths['/v1/webhooks/signing-secrets/hygiene'].post['x-apollo-capability-id'],
      'apollo.webhooks.signing-secrets.hygiene.run',
    )
    assert.equal(
      openApi.paths['/v1/webhooks/signing-secrets/hygiene'].post
        .requestBody.content['application/json'].schema.$ref,
      '#/components/schemas/RunWebhookSigningSecretHygieneRequestV1',
    )
    assert.equal(
      openApi.paths['/v1/webhooks/endpoints/{endpointId}/signing-secrets/rotations/{rotationId}/activate'].post[
        'x-apollo-capability-id'
      ],
      'apollo.webhooks.endpoints.signing-secrets.rotations.activate',
    )
    assert.equal(
      openApi.paths['/v1/webhooks/endpoints/{endpointId}/signing-secrets/rotations/{rotationId}/activate'].post
        .requestBody.content['application/json'].schema.$ref,
      '#/components/schemas/ActivateWebhookSigningSecretRotationRequestV1',
    )
    assert.equal(
      openApi.paths['/v1/webhooks/endpoints/{endpointId}/signing-secrets/rotations/{rotationId}/cancel'].post[
        'x-apollo-capability-id'
      ],
      'apollo.webhooks.endpoints.signing-secrets.rotations.cancel',
    )
    assert.equal(
      openApi.paths['/v1/webhooks/subscriptions'].get['x-apollo-capability-id'],
      'apollo.webhooks.subscriptions.list',
    )
    assert.equal(
      openApi.paths['/v1/webhooks/subscriptions'].post['x-apollo-capability-id'],
      'apollo.webhooks.subscriptions.create',
    )
    assert.equal(
      openApi.paths['/v1/webhooks/subscriptions'].post.requestBody.content['application/json']
        .schema.$ref,
      '#/components/schemas/CreateWebhookSubscriptionRequestV1',
    )
    assert.equal(
      openApi.paths['/v1/webhooks/subscriptions'].post.parameters.some(
        (parameter) => parameter.name === 'Idempotency-Key' && parameter.required,
      ),
      true,
    )
    assert.deepEqual(
      openApi.paths['/v1/webhooks/subscriptions'].get.parameters.map(
        (parameter) => parameter.name,
      ),
      ['limit', 'after', 'status', 'endpointId'],
    )
    assert.equal(
      openApi.paths['/v1/webhooks/subscriptions/{subscriptionId}'].get[
        'x-apollo-capability-id'
      ],
      'apollo.webhooks.subscriptions.read',
    )
    assert.equal(
      openApi.paths['/v1/webhooks/subscriptions/{subscriptionId}/status'].put[
        'x-apollo-capability-id'
      ],
      'apollo.webhooks.subscriptions.status.set',
    )
    assert.equal(
      openApi.paths['/v1/webhooks/subscriptions/{subscriptionId}/status'].put
        .requestBody.content['application/json'].schema.$ref,
      '#/components/schemas/SetWebhookSubscriptionStatusRequestV1',
    )
    assert.equal(
      openApi.paths['/v1/webhooks/deliveries'].get['x-apollo-capability-id'],
      'apollo.webhooks.deliveries.list',
    )
    assert.deepEqual(
      openApi.paths['/v1/webhooks/deliveries'].get.parameters.map(
        (parameter) => parameter.name,
      ),
      ['limit', 'after', 'status', 'endpointId', 'eventId'],
    )
    assert.equal(
      openApi.paths['/v1/webhooks/deliveries/{deliveryId}'].get[
        'x-apollo-capability-id'
      ],
      'apollo.webhooks.deliveries.read',
    )
    assert.equal(
      openApi.paths['/v1/webhooks/deliveries/{deliveryId}/replay'].post[
        'x-apollo-capability-id'
      ],
      'apollo.webhooks.deliveries.replay',
    )
    assert.equal(
      openApi.paths['/v1/webhooks/deliveries/{deliveryId}/replay'].post.parameters.some(
        (parameter) => parameter.name === 'Idempotency-Key' && parameter.required,
      ),
      true,
    )
    assert.equal(
      openApi.paths['/v1/webhooks/events/{eventId}/replay'].post[
        'x-apollo-capability-id'
      ],
      'apollo.webhooks.events.replay',
    )
    assert.equal(
      openApi.paths['/v1/webhooks/events/{eventId}/replay'].post.parameters.some(
        (parameter) => parameter.name === 'Idempotency-Key' && parameter.required,
      ),
      true,
    )

    const schemaResponse = await fetch(
      `${baseUrl}/v1/schemas/create-project-request/v2`,
    )
    const schema = await schemaResponse.json()
    assert.equal(schemaResponse.status, 200)
    assert.match(schemaResponse.headers.get('content-type'), /^application\/schema\+json/)
    assert.equal(schema.$id, 'apollo://schemas/create-project-request/v2')
    assert.deepEqual(schema.required, ['name', 'objective', 'format'])
    assert.equal(schema.examples[0].objective, 'discovery')
    assert.equal(schema.examples[0].format, '9:16')

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
    const anonymousCapabilitiesResponse = await fetch(`${baseUrl}/v1/capabilities`)
    const anonymousCapabilities = await anonymousCapabilitiesResponse.json()
    assert.equal(anonymousCapabilitiesResponse.status, 200)
    assert.equal(
      anonymousCapabilities.data.capabilities.some(
        (capability) => capability.id === 'apollo.events.catalog.read',
      ),
      true,
    )
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
        'apollo.tools.list',
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
        'apollo.webhooks.endpoints.create',
        'apollo.webhooks.endpoints.list',
        'apollo.webhooks.endpoints.read',
        'apollo.webhooks.endpoints.status.set',
        'apollo.webhooks.endpoints.challenge',
        'apollo.webhooks.endpoints.signing-secrets.provision',
        'apollo.webhooks.endpoints.signing-secrets.rotations.stage',
        'apollo.webhooks.endpoints.signing-secrets.rotations.activate',
        'apollo.webhooks.endpoints.signing-secrets.rotations.cancel',
        'apollo.webhooks.endpoints.signing-secrets.rotations.list',
        'apollo.webhooks.endpoints.signing-secrets.rotations.read',
        'apollo.webhooks.signing-secrets.hygiene.run',
        'apollo.webhooks.subscriptions.create',
        'apollo.webhooks.subscriptions.list',
        'apollo.webhooks.subscriptions.read',
        'apollo.webhooks.subscriptions.status.set',
        'apollo.webhooks.deliveries.list',
        'apollo.webhooks.deliveries.read',
        'apollo.webhooks.deliveries.replay',
        'apollo.webhooks.events.replay',
        'apollo.contracts.openapi.read',
        'apollo.contracts.schemas.read',
        'apollo.projects.create',
        'apollo.clients.list',
        'apollo.clients.create',
        'apollo.clients.credentials.rotate',
        'apollo.clients.credentials.revoke',
        'apollo.artifacts.download-grants.issue',
        'apollo.artifacts.download-grants.revoke',
        'apollo.governance.usage-audit.list',
      ],
    )

    const webhookEndpointListResponse = await fetch(
      `${baseUrl}/v1/webhooks/endpoints?status=active`,
      { headers: { authorization } },
    )
    const webhookEndpointList = await webhookEndpointListResponse.json()
    assert.equal(webhookEndpointListResponse.status, 200)
    assert.equal(webhookEndpointList.data.endpoints.length, 1)
    assert.equal(webhookEndpointList.data.endpoints[0].id, webhookEndpointId)
    assert.equal(
      webhookEndpointList.data.endpoints[0].destinationOrigin,
      'https://hooks.example.com',
    )
    assert.match(webhookEndpointList.data.endpoints[0].urlFingerprint, /^[a-f0-9]{64}$/)
    assert.equal(webhookEndpointList.data.endpoints[0].currentSigningSecret.version, 1)
    assert.equal(webhookEndpointList.data.endpoints[0].currentSigningSecret.fingerprint, sha('b'))
    assert.equal(JSON.stringify(webhookEndpointList).includes('/public-api'), false)
    assert.equal(JSON.stringify(webhookEndpointList).includes('keyRef'), false)
    assert.equal(JSON.stringify(webhookEndpointList).includes('workspaceId'), false)

    const webhookEndpointReadResponse = await fetch(
      `${baseUrl}/v1/webhooks/endpoints/${webhookEndpointId}`,
      { headers: { authorization } },
    )
    const webhookEndpointRead = await webhookEndpointReadResponse.json()
    assert.equal(webhookEndpointReadResponse.status, 200)
    assert.equal(webhookEndpointRead.data.endpoint.id, webhookEndpointId)
    assert.match(webhookEndpointRead.data.endpoint.revision, /^[a-f0-9]{64}$/)
    assert.deepEqual(
      webhookEndpointRead.data.endpoint.signingSecrets.map((secret) => secret.version),
      [1],
    )
    assert.equal(JSON.stringify(webhookEndpointRead).includes('vault://'), false)

    const webhookChallengeUrl =
      `${baseUrl}/v1/webhooks/endpoints/${webhookEndpointId}/challenge`
    const challengeReplayRequest = () => fetch(webhookChallengeUrl, {
      method: 'POST',
      headers: { authorization },
    })
    const webhookChallengeResponses = await Promise.all([
      challengeReplayRequest(),
      challengeReplayRequest(),
    ])
    assert.deepEqual(webhookChallengeResponses.map((response) => response.status), [200, 200])
    const [webhookChallenge, concurrentWebhookChallengeReplay] = await Promise.all(
      webhookChallengeResponses.map((response) => response.json()),
    )

    const toolsResponse = await fetch(`${baseUrl}/v1/tools`, { headers: { authorization } })
    const tools = await toolsResponse.json()
    assert.equal(toolsResponse.status, 200)
    assert.deepEqual(
      tools.data.tools.map((tool) => tool.apollo.capabilityId),
      capabilities.data.capabilities.map((capability) => capability.id),
    )
    assert.equal(
      tools.data.tools.some((tool) => tool.name === 'apollo.events.catalog.read'),
      false,
    )
    const rightsTool = tools.data.tools.find(
      (tool) => tool.name === 'apollo.artifacts.rights.set',
    )
    assert.deepEqual(rightsTool.inputSchema.required, ['path', 'headers', 'body'])
    assert.deepEqual(rightsTool.inputSchema.properties.headers.required, ['ifMatch'])
    assert.equal(rightsTool.errorSchema.properties.error.properties.conflict.type, 'object')
    assert.equal(rightsTool.apollo.confirmation, 'human-approval')
    assert.match(rightsTool.description, /trusted human approval from the host/)
    assert.equal(Object.hasOwn(rightsTool.inputSchema.properties, 'approval'), false)
    assert.equal(
      tools.data.tools.find(
        (tool) => tool.name === 'apollo.clients.credentials.revoke',
      ).apollo.confirmation,
      'human-approval',
    )
    assert.equal(JSON.stringify(tools).includes('vault://'), false)
    assert.equal(JSON.stringify(tools).includes('"keyRef"'), false)
    assert.equal(webhookChallenge.data.endpoint.id, webhookEndpointId)
    assert.equal(webhookChallenge.data.endpoint.status, 'active')
    assert.equal(webhookChallenge.data.effects.activatedSubscriptions, 0)
    assert.equal(webhookChallenge.data.replayed, true)
    assert.deepEqual(concurrentWebhookChallengeReplay.data, webhookChallenge.data)
    assert.equal(JSON.stringify(webhookChallenge).includes('keyRef'), false)
    assert.equal(JSON.stringify(webhookChallenge).includes('/public-api'), false)

    const webhookChallengeBodyResponse = await fetch(webhookChallengeUrl, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(webhookChallengeBodyResponse.status, 422)
    const missingWebhookChallengeResponse = await fetch(
      `${baseUrl}/v1/webhooks/endpoints/00000000-0000-4000-8000-000000000999/challenge`,
      { method: 'POST', headers: { authorization } },
    )
    assert.equal(missingWebhookChallengeResponse.status, 404)

    const createWebhookEndpointRequest = (idempotencyKey, body) => fetch(
      `${baseUrl}/v1/webhooks/endpoints`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body: JSON.stringify(body),
      },
    )
    const createEndpointBody = { url: 'https://created-hooks.example.com/apollo' }
    const createEndpointConcurrentResponses = await Promise.all([
      createWebhookEndpointRequest('public-endpoint-create-1', createEndpointBody),
      createWebhookEndpointRequest('public-endpoint-create-1', createEndpointBody),
    ])
    assert.deepEqual(
      createEndpointConcurrentResponses.map((response) => response.status).sort(),
      [200, 201],
    )
    const createEndpointConcurrentBodies = await Promise.all(
      createEndpointConcurrentResponses.map((response) => response.json()),
    )
    const createdEndpoint = createEndpointConcurrentBodies.find(
      (body) => body.data.replayed === false,
    )
    const replayedEndpoint = createEndpointConcurrentBodies.find(
      (body) => body.data.replayed === true,
    )
    assert.ok(createdEndpoint)
    assert.ok(replayedEndpoint)
    assert.equal(createdEndpoint.data.replayed, false)
    assert.equal(createdEndpoint.data.endpoint.status, 'pending-verification')
    assert.equal(createdEndpoint.data.endpoint.destinationOrigin, 'https://created-hooks.example.com')
    assert.equal(createdEndpoint.data.endpoint.currentSigningSecret.version, 1)
    assert.equal(JSON.stringify(createdEndpoint).includes('keyRef'), false)
    assert.equal(JSON.stringify(createdEndpoint).includes('ciphertext'), false)
    assert.equal(JSON.stringify(createdEndpoint).includes('workspaceId'), false)
    assert.equal(replayedEndpoint.data.replayed, true)
    assert.equal(replayedEndpoint.data.endpoint.id, createdEndpoint.data.endpoint.id)
    const mismatchedEndpointResponse = await createWebhookEndpointRequest(
      'public-endpoint-create-1',
      { url: 'https://different-hooks.example.com/apollo' },
    )
    assert.equal(mismatchedEndpointResponse.status, 409)
    assert.equal((await mismatchedEndpointResponse.json()).error.code, 'IDEMPOTENCY_PAYLOAD_MISMATCH')
    const duplicateEndpointResponse = await createWebhookEndpointRequest(
      'public-endpoint-create-2',
      createEndpointBody,
    )
    assert.equal(duplicateEndpointResponse.status, 409)
    assert.equal((await duplicateEndpointResponse.json()).error.code, 'WEBHOOK_ENDPOINT_ALREADY_EXISTS')

    const responseLossEndpointBody = {
      url: 'https://response-loss-hooks.example.com/apollo',
    }
    const discardedEndpointResponse = await createWebhookEndpointRequest(
      'public-endpoint-response-loss-1',
      responseLossEndpointBody,
    )
    assert.equal(discardedEndpointResponse.status, 201)
    const recoveredEndpointResponse = await createWebhookEndpointRequest(
      'public-endpoint-response-loss-1',
      responseLossEndpointBody,
    )
    const recoveredEndpoint = await recoveredEndpointResponse.json()
    assert.equal(recoveredEndpointResponse.status, 200)
    assert.equal(recoveredEndpoint.data.replayed, true)
    assert.equal(
      await client.v2WebhookEndpoint.count({
        where: { workspaceId, url: responseLossEndpointBody.url },
      }),
      1,
    )

    const mismatchedConcurrentEndpointResponses = await Promise.all([
      createWebhookEndpointRequest('public-endpoint-concurrent-mismatch-1', {
        url: 'https://concurrent-hooks-a.example.com/apollo',
      }),
      createWebhookEndpointRequest('public-endpoint-concurrent-mismatch-1', {
        url: 'https://concurrent-hooks-b.example.com/apollo',
      }),
    ])
    assert.deepEqual(
      mismatchedConcurrentEndpointResponses.map((response) => response.status).sort(),
      [201, 409],
    )
    const mismatchedConcurrentEndpointBodies = await Promise.all(
      mismatchedConcurrentEndpointResponses.map((response) => response.json()),
    )
    assert.equal(
      mismatchedConcurrentEndpointBodies.find((body) => body.error).error.code,
      'IDEMPOTENCY_PAYLOAD_MISMATCH',
    )
    assert.equal((await createWebhookEndpointRequest('', createEndpointBody)).status, 422)
    const createdEndpointSecret = await client.v2WebhookSigningSecret.findFirstOrThrow({
      where: { endpointId: createdEndpoint.data.endpoint.id, workspaceId },
    })
    assert.equal(await client.v2WebhookSigningSecretPayload.count({
      where: { secretId: createdEndpointSecret.id },
    }), 1)

    const signingSecretProvisioningUrl =
      `${baseUrl}/v1/webhooks/endpoints/${createdEndpoint.data.endpoint.id}/signing-secrets`
    const provisionSigningSecretFor = (endpointId, idempotencyKey, body) => fetch(
      `${baseUrl}/v1/webhooks/endpoints/${endpointId}/signing-secrets`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body: JSON.stringify(body),
      },
    )
    const provisionSigningSecret = (idempotencyKey, body) =>
      provisionSigningSecretFor(createdEndpoint.data.endpoint.id, idempotencyKey, body)
    const provisionSecretBody = {
      baseRevision: createdEndpoint.data.endpoint.revision,
    }
    const provisionSecretConcurrentResponses = await Promise.all([
      provisionSigningSecret('public-secret-provision-1', provisionSecretBody),
      provisionSigningSecret('public-secret-provision-1', provisionSecretBody),
    ])
    assert.deepEqual(
      provisionSecretConcurrentResponses.map((response) => response.status).sort(),
      [200, 201],
    )
    const provisionSecretConcurrentBodies = await Promise.all(
      provisionSecretConcurrentResponses.map((response) => response.json()),
    )
    const provisionedSecret = provisionSecretConcurrentBodies.find(
      (body) => body.data.replayed === false,
    )
    const provisionSecretReplay = provisionSecretConcurrentBodies.find(
      (body) => body.data.replayed === true,
    )
    assert.ok(provisionedSecret)
    assert.ok(provisionSecretReplay)
    assert.equal(provisionedSecret.data.secretAvailable, true)
    assert.equal(provisionedSecret.data.replayed, false)
    assert.match(provisionedSecret.data.secretBase64url, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(provisionedSecret.data.endpoint.currentSigningSecret.version, 2)
    assert.equal(JSON.stringify(provisionedSecret).includes('keyRef'), false)
    assert.equal(JSON.stringify(provisionedSecret).includes('ciphertext'), false)
    const persistedProvisionedSecret = await client.v2WebhookSigningSecret.findFirstOrThrow({
      where: {
        endpointId: createdEndpoint.data.endpoint.id,
        workspaceId,
        status: 'active',
      },
    })
    assert.equal(
      createHash('sha256')
        .update(Buffer.from(provisionedSecret.data.secretBase64url, 'base64url'))
        .digest('hex'),
      persistedProvisionedSecret.fingerprint,
    )
    assert.equal(
      (await client.v2WebhookSigningSecret.findUniqueOrThrow({
        where: { id: createdEndpointSecret.id },
      })).status,
      'retired',
    )
    assert.equal(await client.v2WebhookSigningSecretPayload.count({
      where: { secretId: persistedProvisionedSecret.id },
    }), 1)
    assert.equal(provisionSecretReplay.data.secretAvailable, false)
    assert.equal(provisionSecretReplay.data.replayed, true)
    assert.equal('secretBase64url' in provisionSecretReplay.data, false)
    assert.equal(
      provisionSecretReplay.data.endpoint.currentSigningSecret.fingerprint,
      provisionedSecret.data.endpoint.currentSigningSecret.fingerprint,
    )

    const responseLossProvisionBody = {
      baseRevision: recoveredEndpoint.data.endpoint.revision,
    }
    const discardedProvisionResponse = await provisionSigningSecretFor(
      recoveredEndpoint.data.endpoint.id,
      'public-secret-provision-response-loss-1',
      responseLossProvisionBody,
    )
    assert.equal(discardedProvisionResponse.status, 201)
    const recoveredProvisionResponse = await provisionSigningSecretFor(
      recoveredEndpoint.data.endpoint.id,
      'public-secret-provision-response-loss-1',
      responseLossProvisionBody,
    )
    const recoveredProvision = await recoveredProvisionResponse.json()
    assert.equal(recoveredProvisionResponse.status, 200)
    assert.equal(recoveredProvision.data.replayed, true)
    assert.equal(recoveredProvision.data.secretAvailable, false)
    assert.equal('secretBase64url' in recoveredProvision.data, false)
    assert.equal(
      await client.v2WebhookSigningSecret.count({
        where: { workspaceId, endpointId: recoveredEndpoint.data.endpoint.id },
      }),
      2,
    )
    assert.equal(
      await client.v2WebhookSigningSecret.count({
        where: {
          workspaceId,
          endpointId: recoveredEndpoint.data.endpoint.id,
          status: 'active',
        },
      }),
      1,
    )
    assert.equal(
      (await provisionSigningSecret(
        'public-secret-provision-1',
        { baseRevision: 'a'.repeat(64) },
      )).status,
      409,
    )
    assert.equal((await provisionSigningSecret('', provisionSecretBody)).status, 422)
    assert.equal(
      (await provisionSigningSecret(
        'public-secret-provision-extra',
        { ...provisionSecretBody, extra: true },
      )).status,
      422,
    )
    assert.equal(
      (await provisionSigningSecret(
        'public-secret-provision-stale',
        provisionSecretBody,
      )).status,
      409,
    )
    assert.equal(
      (await fetch(
        `${baseUrl}/v1/webhooks/endpoints/${webhookEndpointId}/signing-secrets`,
        {
          method: 'POST',
          headers: {
            authorization,
            'content-type': 'application/json',
            'idempotency-key': 'public-secret-provision-active',
          },
          body: JSON.stringify({ baseRevision: webhookEndpointRead.data.endpoint.revision }),
        },
      )).status,
      409,
    )
    const stageRotationUrl =
      `${baseUrl}/v1/webhooks/endpoints/${webhookEndpointId}/signing-secrets/rotations`
    const stageRotation = (idempotencyKey, body) => fetch(stageRotationUrl, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    })
    const stageRotationBody = {
      baseRevision: webhookEndpointRead.data.endpoint.revision,
      overlapSeconds: 300,
    }
    const stageRotationResponse = await stageRotation(
      'public-secret-rotation-stage-1',
      stageRotationBody,
    )
    const stagedRotation = await stageRotationResponse.json()
    assert.equal(stageRotationResponse.status, 201)
    assert.equal(stagedRotation.data.rotation.endpointId, webhookEndpointId)
    assert.equal(stagedRotation.data.rotation.candidateVersion, 2)
    assert.equal(stagedRotation.data.rotation.status, 'staged')
    assert.equal(stagedRotation.data.rotation.overlapSeconds, 300)
    assert.equal(stagedRotation.data.secretAvailable, true)
    assert.equal(stagedRotation.data.replayed, false)
    assert.match(stagedRotation.data.secretBase64url, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(JSON.stringify(stagedRotation).includes('keyRef'), false)
    assert.equal(JSON.stringify(stagedRotation).includes('payloadCiphertext'), false)
    assert.equal(await client.v2WebhookSigningSecret.count({
      where: { endpointId: webhookEndpointId, status: 'active' },
    }), 1)
    assert.equal(await client.v2WebhookSigningSecret.count({
      where: { endpointId: webhookEndpointId, version: 2 },
    }), 0)
    const stagedRotationReplayResponse = await stageRotation(
      'public-secret-rotation-stage-1',
      stageRotationBody,
    )
    const stagedRotationReplay = await stagedRotationReplayResponse.json()
    assert.equal(stagedRotationReplayResponse.status, 200)
    assert.equal(stagedRotationReplay.data.secretAvailable, false)
    assert.equal(stagedRotationReplay.data.replayed, true)
    assert.equal('secretBase64url' in stagedRotationReplay.data, false)
    assert.equal(stagedRotationReplay.data.rotation.id, stagedRotation.data.rotation.id)
    assert.equal((await stageRotation(
      'public-secret-rotation-stage-1',
      { ...stageRotationBody, overlapSeconds: 301 },
    )).status, 409)
    assert.equal((await stageRotation('', stageRotationBody)).status, 422)
    assert.equal((await stageRotation(
      'public-secret-rotation-stage-extra',
      { ...stageRotationBody, extra: true },
    )).status, 422)
    const activateRotationUrl = `${stageRotationUrl}/${stagedRotation.data.rotation.id}/activate`
    const activateRotation = (body) => fetch(activateRotationUrl, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const activateRotationResponse = await activateRotation({
      baseRevision: stageRotationBody.baseRevision,
    })
    const activatedRotation = await activateRotationResponse.json()
    assert.equal(activateRotationResponse.status, 200)
    assert.equal(activatedRotation.data.replayed, false)
    assert.equal(activatedRotation.data.endpoint.id, webhookEndpointId)
    assert.equal(activatedRotation.data.endpoint.status, 'active')
    assert.notEqual(activatedRotation.data.endpoint.revision, stageRotationBody.baseRevision)
    assert.equal(activatedRotation.data.rotation.status, 'activated')
    assert.equal(activatedRotation.data.rotation.candidateVersion, 2)
    assert.equal(activatedRotation.data.signing.activeVersion, 2)
    assert.equal(activatedRotation.data.signing.previousVersion, 1)
    assert.equal(
      activatedRotation.data.signing.previousUsableUntil,
      activatedRotation.data.rotation.overlapUntil,
    )
    assert.equal(JSON.stringify(activatedRotation).includes('keyRef'), false)
    assert.equal(JSON.stringify(activatedRotation).includes('secretBase64url'), false)
    const activationReplayResponse = await activateRotation({
      baseRevision: stageRotationBody.baseRevision,
    })
    const activationReplay = await activationReplayResponse.json()
    assert.equal(activationReplayResponse.status, 200)
    assert.equal(activationReplay.data.replayed, true)
    assert.equal(activationReplay.data.rotation.id, activatedRotation.data.rotation.id)
    assert.equal((await activateRotation({ baseRevision: 'invalid' })).status, 422)
    assert.equal((await activateRotation({ baseRevision: 'a'.repeat(64) })).status, 409)
    assert.equal((await fetch(activateRotationUrl, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ baseRevision: stageRotationBody.baseRevision, extra: true }),
    })).status, 422)
    const secondStageRotationBody = {
      baseRevision: activatedRotation.data.endpoint.revision,
      overlapSeconds: 600,
    }
    const secondStageRotationResponse = await stageRotation(
      'public-secret-rotation-stage-2',
      secondStageRotationBody,
    )
    const secondStagedRotation = await secondStageRotationResponse.json()
    assert.equal(secondStageRotationResponse.status, 201)
    assert.equal(secondStagedRotation.data.rotation.candidateVersion, 3)
    const cancelRotationUrl = `${stageRotationUrl}/${secondStagedRotation.data.rotation.id}/cancel`
    const cancelRotation = (url, body) => fetch(url, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const cancelRotationResponse = await cancelRotation(cancelRotationUrl, {
      baseRevision: secondStageRotationBody.baseRevision,
    })
    const cancelledRotation = await cancelRotationResponse.json()
    assert.equal(cancelRotationResponse.status, 200)
    assert.equal(cancelledRotation.data.rotation.status, 'cancelled')
    assert.equal(cancelledRotation.data.rotation.candidateVersion, 3)
    assert.equal(cancelledRotation.data.envelopeDestroyed, true)
    assert.equal(cancelledRotation.data.replayed, false)
    assert.equal(JSON.stringify(cancelledRotation).includes('secretBase64url'), false)
    assert.equal(JSON.stringify(cancelledRotation).includes('ciphertext'), false)
    const storedCancelledRotation = await client.v2WebhookSigningSecretRotation.findUniqueOrThrow({
      where: { id: secondStagedRotation.data.rotation.id },
    })
    assert.equal(storedCancelledRotation.payloadAlgorithm, null)
    assert.equal(storedCancelledRotation.payloadCiphertext, null)
    assert.equal(await client.v2WebhookSigningSecret.count({
      where: { endpointId: webhookEndpointId, version: 3 },
    }), 0)
    const cancelRotationReplayResponse = await cancelRotation(cancelRotationUrl, {
      baseRevision: secondStageRotationBody.baseRevision,
    })
    const cancelRotationReplay = await cancelRotationReplayResponse.json()
    assert.equal(cancelRotationReplayResponse.status, 200)
    assert.equal(cancelRotationReplay.data.replayed, true)
    assert.equal(cancelRotationReplay.data.rotation.id, cancelledRotation.data.rotation.id)
    const rotationListResponse = await fetch(`${stageRotationUrl}?limit=1&status=cancelled`, {
      headers: { authorization },
    })
    const rotationList = await rotationListResponse.json()
    assert.equal(rotationListResponse.status, 200)
    assert.equal(rotationList.data.rotations.length, 1)
    assert.equal(rotationList.data.rotations[0].id, cancelledRotation.data.rotation.id)
    assert.equal(rotationList.data.rotations[0].baseRevision, secondStageRotationBody.baseRevision)
    assert.equal(JSON.stringify(rotationList).includes('candidateSecretId'), false)
    assert.equal(JSON.stringify(rotationList).includes('keyRef'), false)
    assert.equal(JSON.stringify(rotationList).includes('payloadCiphertext'), false)
    const rotationReadResponse = await fetch(
      `${stageRotationUrl}/${cancelledRotation.data.rotation.id}`,
      { headers: { authorization } },
    )
    const rotationRead = await rotationReadResponse.json()
    assert.equal(rotationReadResponse.status, 200)
    assert.deepEqual(rotationRead.data.rotation, rotationList.data.rotations[0])
    assert.equal((await fetch(`${stageRotationUrl}?status=invalid`, {
      headers: { authorization },
    })).status, 422)
    assert.equal((await fetch(
      `${stageRotationUrl}/00000000-0000-4000-8000-000000000999`,
      { headers: { authorization } },
    )).status, 404)
    assert.equal((await stageRotation(
      'public-secret-rotation-stage-2',
      secondStageRotationBody,
    )).status, 409)
    assert.equal((await cancelRotation(cancelRotationUrl, {
      baseRevision: 'a'.repeat(64),
    })).status, 409)
    assert.equal((await cancelRotation(
      `${stageRotationUrl}/${stagedRotation.data.rotation.id}/cancel`,
      { baseRevision: stageRotationBody.baseRevision },
    )).status, 409)
    const thirdStageRotationResponse = await stageRotation(
      'public-secret-rotation-stage-3',
      secondStageRotationBody,
    )
    const thirdStagedRotation = await thirdStageRotationResponse.json()
    assert.equal(thirdStageRotationResponse.status, 201)
    assert.equal(thirdStagedRotation.data.rotation.candidateVersion, 4)
    const hygieneNow = new Date()
    await client.v2WebhookSigningSecretRotation.update({
      where: { id: thirdStagedRotation.data.rotation.id },
      data: {
        createdAt: new Date(hygieneNow.getTime() - 2_000),
        expiresAt: new Date(hygieneNow.getTime() - 1_000),
      },
    })
    const retiredSecret = await client.v2WebhookSigningSecret.findFirstOrThrow({
      where: { endpointId: webhookEndpointId, status: 'retired' },
    })
    await client.v2WebhookSigningSecretPayload.upsert({
      where: { secretId: retiredSecret.id },
      create: {
        secretId: retiredSecret.id,
        workspaceId,
        endpointId: webhookEndpointId,
        secretVersion: retiredSecret.version,
        algorithm: 'aes-256-gcm',
        keyId: 'hygiene-test-key',
        nonce: 'A'.repeat(16),
        ciphertext: 'B'.repeat(16),
        authTag: 'C'.repeat(16),
        createdAt: new Date(hygieneNow.getTime() - 2_000),
      },
      update: {},
    })
    await client.v2WebhookSigningSecret.update({
      where: { id: retiredSecret.id },
      data: {
        retiredAt: new Date(hygieneNow.getTime() - 2_000),
        usableUntil: new Date(hygieneNow.getTime() - 1_000),
      },
    })
    const hygieneResponse = await fetch(`${baseUrl}/v1/webhooks/signing-secrets/hygiene`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ limitPerKind: 100 }),
    })
    const hygiene = await hygieneResponse.json()
    assert.equal(hygieneResponse.status, 200)
    assert.equal(hygiene.data.expiredRotations, 1)
    assert.equal(hygiene.data.destroyedRotationEnvelopes, 1)
    assert.equal(hygiene.data.destroyedSigningSecretPayloads, 1)
    assert.equal(hygiene.data.hasMore, false)
    assert.equal((await client.v2WebhookSigningSecretRotation.findUniqueOrThrow({
      where: { id: thirdStagedRotation.data.rotation.id },
    })).status, 'expired')
    assert.equal(await client.v2WebhookSigningSecretPayload.count({
      where: { secretId: retiredSecret.id },
    }), 0)
    assert.equal(await client.v2WebhookSigningSecretPayload.count({
      where: { endpointId: webhookEndpointId, secret: { status: 'active' } },
    }), 1)
    assert.equal((await fetch(`${baseUrl}/v1/webhooks/signing-secrets/hygiene`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ limitPerKind: 0 }),
    })).status, 422)
    await client.v2WebhookSigningSecretPayload.deleteMany({
      where: { endpointId: createdEndpoint.data.endpoint.id },
    })
    await client.v2WebhookSigningSecret.deleteMany({
      where: { endpointId: createdEndpoint.data.endpoint.id },
    })
    await client.v2WebhookEndpoint.delete({ where: { id: createdEndpoint.data.endpoint.id } })
    await client.v2IdempotencyRecord.deleteMany({
      where: {
        workspaceId,
        OR: [
          { key: { startsWith: 'public-endpoint-create-' } },
          { key: { startsWith: 'public-secret-provision-' } },
        ],
      },
    })

    const webhookEndpointStatusUrl =
      `${baseUrl}/v1/webhooks/endpoints/${webhookEndpointId}/status`
    const setWebhookEndpointStatus = (status, baseRevision) => fetch(
      webhookEndpointStatusUrl,
      {
        method: 'PUT',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ status, baseRevision }),
      },
    )
    const invalidEndpointBodyResponse = await fetch(webhookEndpointStatusUrl, {
      method: 'PUT',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        status: 'suspended',
        baseRevision: webhookEndpointRead.data.endpoint.revision,
        unexpected: true,
      }),
    })
    assert.equal(invalidEndpointBodyResponse.status, 422)
    const missingEndpointStatusResponse = await fetch(
      `${baseUrl}/v1/webhooks/endpoints/00000000-0000-4000-8000-000000000999/status`,
      {
        method: 'PUT',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({
          status: 'suspended',
          baseRevision: webhookEndpointRead.data.endpoint.revision,
        }),
      },
    )
    assert.equal(missingEndpointStatusResponse.status, 404)

    const webhookSubscriptionListResponse = await fetch(
      `${baseUrl}/v1/webhooks/subscriptions?status=active&endpointId=${webhookEndpointId}`,
      { headers: { authorization } },
    )
    const webhookSubscriptionList = await webhookSubscriptionListResponse.json()
    assert.equal(webhookSubscriptionListResponse.status, 200)
    assert.equal(webhookSubscriptionList.data.subscriptions.length, 1)
    assert.equal(webhookSubscriptionList.data.subscriptions[0].id, webhookSubscriptionId)
    assert.deepEqual(webhookSubscriptionList.data.subscriptions[0].eventTypes, ['project.created'])
    assert.deepEqual(
      webhookSubscriptionList.data.subscriptions[0].resourceIds,
      ['public-api-webhook-project'],
    )
    assert.equal(JSON.stringify(webhookSubscriptionList).includes('filterHash'), false)

    const webhookSubscriptionReadResponse = await fetch(
      `${baseUrl}/v1/webhooks/subscriptions/${webhookSubscriptionId}`,
      { headers: { authorization } },
    )
    const webhookSubscriptionRead = await webhookSubscriptionReadResponse.json()
    assert.equal(webhookSubscriptionReadResponse.status, 200)
    assert.equal(webhookSubscriptionRead.data.subscription.id, webhookSubscriptionId)
    assert.deepEqual(webhookSubscriptionRead.data.subscription.eventTypes, ['project.created'])
    assert.match(webhookSubscriptionRead.data.subscription.revision, /^[a-f0-9]{64}$/)

    const createWebhookSubscriptionRequest = (idempotencyKey, body) => fetch(
      `${baseUrl}/v1/webhooks/subscriptions`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body: JSON.stringify(body),
      },
    )
    const createSubscriptionBody = {
      endpointId: webhookEndpointId,
      eventTypes: ['artifact.ready'],
      resourceIds: ['public-api-artifact'],
    }
    const createSubscriptionConcurrentResponses = await Promise.all([
      createWebhookSubscriptionRequest('public-subscription-create-1', createSubscriptionBody),
      createWebhookSubscriptionRequest('public-subscription-create-1', createSubscriptionBody),
    ])
    assert.deepEqual(
      createSubscriptionConcurrentResponses.map((response) => response.status).sort(),
      [200, 201],
    )
    const createSubscriptionConcurrentBodies = await Promise.all(
      createSubscriptionConcurrentResponses.map((response) => response.json()),
    )
    const createdSubscription = createSubscriptionConcurrentBodies.find(
      (body) => body.data.replayed === false,
    )
    const replayedCreatedSubscription = createSubscriptionConcurrentBodies.find(
      (body) => body.data.replayed === true,
    )
    assert.ok(createdSubscription)
    assert.ok(replayedCreatedSubscription)
    assert.equal(createdSubscription.data.replayed, false)
    assert.equal(createdSubscription.data.subscription.status, 'active')
    assert.deepEqual(createdSubscription.data.subscription.eventTypes, ['artifact.ready'])
    assert.equal('workspaceId' in createdSubscription.data.subscription, false)
    assert.equal(replayedCreatedSubscription.data.replayed, true)
    assert.equal(
      replayedCreatedSubscription.data.subscription.id,
      createdSubscription.data.subscription.id,
    )
    const mismatchedSubscriptionResponse = await createWebhookSubscriptionRequest(
      'public-subscription-create-1',
      { ...createSubscriptionBody, eventTypes: ['project.version.created'] },
    )
    assert.equal(mismatchedSubscriptionResponse.status, 409)
    assert.equal(
      (await mismatchedSubscriptionResponse.json()).error.code,
      'IDEMPOTENCY_PAYLOAD_MISMATCH',
    )
    const duplicateSubscriptionResponse = await createWebhookSubscriptionRequest(
      'public-subscription-create-2',
      createSubscriptionBody,
    )
    assert.equal(duplicateSubscriptionResponse.status, 409)
    assert.equal(
      (await duplicateSubscriptionResponse.json()).error.code,
      'WEBHOOK_SUBSCRIPTION_ALREADY_EXISTS',
    )

    const responseLossSubscriptionBody = {
      endpointId: webhookEndpointId,
      eventTypes: ['quality.report.created'],
      resourceIds: ['response-loss-resource'],
    }
    const discardedSubscriptionResponse = await createWebhookSubscriptionRequest(
      'public-subscription-response-loss-1',
      responseLossSubscriptionBody,
    )
    assert.equal(discardedSubscriptionResponse.status, 201)
    const recoveredSubscriptionResponse = await createWebhookSubscriptionRequest(
      'public-subscription-response-loss-1',
      responseLossSubscriptionBody,
    )
    const recoveredSubscription = await recoveredSubscriptionResponse.json()
    assert.equal(recoveredSubscriptionResponse.status, 200)
    assert.equal(recoveredSubscription.data.replayed, true)

    const mismatchedConcurrentSubscriptionResponses = await Promise.all([
      createWebhookSubscriptionRequest('public-subscription-concurrent-mismatch-1', {
        endpointId: webhookEndpointId,
        eventTypes: ['operation.succeeded'],
      }),
      createWebhookSubscriptionRequest('public-subscription-concurrent-mismatch-1', {
        endpointId: webhookEndpointId,
        eventTypes: ['operation.failed'],
      }),
    ])
    assert.deepEqual(
      mismatchedConcurrentSubscriptionResponses.map((response) => response.status).sort(),
      [201, 409],
    )
    const mismatchedConcurrentSubscriptionBodies = await Promise.all(
      mismatchedConcurrentSubscriptionResponses.map((response) => response.json()),
    )
    const mismatchedConcurrentSubscriptionWinner =
      mismatchedConcurrentSubscriptionBodies.find((body) => body.data)
    assert.equal(
      mismatchedConcurrentSubscriptionBodies.find((body) => body.error).error.code,
      'IDEMPOTENCY_PAYLOAD_MISMATCH',
    )
    assert.equal((await createWebhookSubscriptionRequest('', createSubscriptionBody)).status, 422)
    await client.v2WebhookSubscription.deleteMany({
      where: {
        id: {
          in: [
            createdSubscription.data.subscription.id,
            recoveredSubscription.data.subscription.id,
            mismatchedConcurrentSubscriptionWinner.data.subscription.id,
          ],
        },
      },
    })
    await client.v2IdempotencyRecord.deleteMany({
      where: { workspaceId, key: { startsWith: 'public-subscription-create-' } },
    })

    const webhookSubscriptionStatusUrl =
      `${baseUrl}/v1/webhooks/subscriptions/${webhookSubscriptionId}/status`
    const setWebhookSubscriptionStatus = (status, baseRevision) => fetch(
      webhookSubscriptionStatusUrl,
      {
        method: 'PUT',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ status, baseRevision }),
      },
    )
    const invalidSubscriptionBodyResponse = await fetch(webhookSubscriptionStatusUrl, {
      method: 'PUT',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        status: 'paused',
        baseRevision: webhookSubscriptionRead.data.subscription.revision,
        unexpected: true,
      }),
    })
    assert.equal(invalidSubscriptionBodyResponse.status, 422)
    const missingSubscriptionStatusResponse = await fetch(
      `${baseUrl}/v1/webhooks/subscriptions/00000000-0000-4000-8000-000000000999/status`,
      {
        method: 'PUT',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({
          status: 'paused',
          baseRevision: webhookSubscriptionRead.data.subscription.revision,
        }),
      },
    )
    assert.equal(missingSubscriptionStatusResponse.status, 404)
    const pauseSubscriptionResponses = await Promise.all([
      setWebhookSubscriptionStatus(
        'paused',
        webhookSubscriptionRead.data.subscription.revision,
      ),
      setWebhookSubscriptionStatus(
        'paused',
        webhookSubscriptionRead.data.subscription.revision,
      ),
    ])
    assert.deepEqual(pauseSubscriptionResponses.map((response) => response.status), [200, 200])
    const pauseSubscriptionBodies = await Promise.all(
      pauseSubscriptionResponses.map((response) => response.json()),
    )
    const pausedSubscription = pauseSubscriptionBodies[0]
    assert.deepEqual(
      pauseSubscriptionBodies[1].data.subscription,
      pausedSubscription.data.subscription,
    )
    assert.equal(pausedSubscription.data.subscription.status, 'paused')
    assert.notEqual(
      pausedSubscription.data.subscription.revision,
      webhookSubscriptionRead.data.subscription.revision,
    )
    const pauseSubscriptionAgainResponse = await setWebhookSubscriptionStatus(
      'paused',
      webhookSubscriptionRead.data.subscription.revision,
    )
    assert.equal(pauseSubscriptionAgainResponse.status, 200)
    assert.equal(
      (await pauseSubscriptionAgainResponse.json()).data.subscription.revision,
      pausedSubscription.data.subscription.revision,
    )
    const staleResumeResponse = await setWebhookSubscriptionStatus('active', '0'.repeat(64))
    assert.equal(staleResumeResponse.status, 409)
    assert.equal(
      (await staleResumeResponse.json()).error.code,
      'WEBHOOK_SUBSCRIPTION_REVISION_MISMATCH',
    )
    const discardedResumeSubscriptionResponse = await setWebhookSubscriptionStatus(
      'active',
      pausedSubscription.data.subscription.revision,
    )
    assert.equal(discardedResumeSubscriptionResponse.status, 200)
    const recoveredResumeSubscriptionResponse = await setWebhookSubscriptionStatus(
      'active',
      pausedSubscription.data.subscription.revision,
    )
    const resumedSubscription = await recoveredResumeSubscriptionResponse.json()
    assert.equal(recoveredResumeSubscriptionResponse.status, 200)
    assert.equal(resumedSubscription.data.subscription.status, 'active')
    assert.equal('pausedAt' in resumedSubscription.data.subscription, false)
    let currentSubscription = resumedSubscription.data.subscription
    const invalidSubscriptionStatusResponse = await setWebhookSubscriptionStatus(
      'pending-verification',
      resumedSubscription.data.subscription.revision,
    )
    assert.equal(invalidSubscriptionStatusResponse.status, 422)

    const suspendEndpointResponses = await Promise.all([
      setWebhookEndpointStatus('suspended', activatedRotation.data.endpoint.revision),
      setWebhookEndpointStatus('suspended', activatedRotation.data.endpoint.revision),
    ])
    assert.deepEqual(suspendEndpointResponses.map((response) => response.status), [200, 200])
    const suspendEndpointBodies = await Promise.all(
      suspendEndpointResponses.map((response) => response.json()),
    )
    const suspendedEndpoint = suspendEndpointBodies.find((body) => body.data.replayed === false)
    const suspendedEndpointConcurrentReplay = suspendEndpointBodies.find(
      (body) => body.data.replayed === true,
    )
    assert.ok(suspendedEndpoint)
    assert.ok(suspendedEndpointConcurrentReplay)
    assert.equal(suspendedEndpoint.data.endpoint.status, 'suspended')
    assert.equal(suspendedEndpoint.data.effects.pausedSubscriptions, 1)
    assert.equal(suspendedEndpoint.data.effects.revokedSubscriptions, 0)
    assert.equal(suspendedEndpoint.data.replayed, false)
    assert.equal(JSON.stringify(suspendedEndpoint).includes('/public-api'), false)
    assert.equal(JSON.stringify(suspendedEndpoint).includes('keyRef'), false)
    assert.equal(suspendedEndpointConcurrentReplay.data.effects.pausedSubscriptions, 0)
    const suspendEndpointAgainResponse = await setWebhookEndpointStatus(
      'suspended',
      activatedRotation.data.endpoint.revision,
    )
    const suspendedEndpointAgain = await suspendEndpointAgainResponse.json()
    assert.equal(suspendEndpointAgainResponse.status, 200)
    assert.equal(suspendedEndpointAgain.data.replayed, true)
    assert.equal(suspendedEndpointAgain.data.effects.pausedSubscriptions, 0)
    const staleEndpointResumeResponse = await setWebhookEndpointStatus('active', '0'.repeat(64))
    assert.equal(staleEndpointResumeResponse.status, 409)
    assert.equal(
      (await staleEndpointResumeResponse.json()).error.code,
      'WEBHOOK_ENDPOINT_REVISION_MISMATCH',
    )
    const cascadePausedSubscriptionResponse = await fetch(
      `${baseUrl}/v1/webhooks/subscriptions/${webhookSubscriptionId}`,
      { headers: { authorization } },
    )
    const cascadePausedSubscription = await cascadePausedSubscriptionResponse.json()
    assert.equal(cascadePausedSubscription.data.subscription.status, 'paused')
    const resumeWhileEndpointSuspendedResponse = await setWebhookSubscriptionStatus(
      'active',
      cascadePausedSubscription.data.subscription.revision,
    )
    assert.equal(resumeWhileEndpointSuspendedResponse.status, 409)
    const discardedResumeEndpointResponse = await setWebhookEndpointStatus(
      'active',
      suspendedEndpoint.data.endpoint.revision,
    )
    assert.equal(discardedResumeEndpointResponse.status, 200)
    const recoveredResumeEndpointResponse = await setWebhookEndpointStatus(
      'active',
      suspendedEndpoint.data.endpoint.revision,
    )
    const resumedEndpoint = await recoveredResumeEndpointResponse.json()
    assert.equal(recoveredResumeEndpointResponse.status, 200)
    assert.equal(resumedEndpoint.data.replayed, true)
    assert.equal(resumedEndpoint.data.endpoint.status, 'active')
    assert.equal(resumedEndpoint.data.effects.pausedSubscriptions, 0)
    const stillPausedSubscriptionResponse = await fetch(
      `${baseUrl}/v1/webhooks/subscriptions/${webhookSubscriptionId}`,
      { headers: { authorization } },
    )
    const stillPausedSubscription = await stillPausedSubscriptionResponse.json()
    assert.equal(stillPausedSubscription.data.subscription.status, 'paused')
    const resumeAfterEndpointResponse = await setWebhookSubscriptionStatus(
      'active',
      stillPausedSubscription.data.subscription.revision,
    )
    assert.equal(resumeAfterEndpointResponse.status, 200)
    currentSubscription = (await resumeAfterEndpointResponse.json()).data.subscription
    assert.equal(currentSubscription.status, 'active')
    const currentEndpoint = resumedEndpoint.data.endpoint

    const invalidWebhookAdministrationFilterResponse = await fetch(
      `${baseUrl}/v1/webhooks/endpoints?unknown=value`,
      { headers: { authorization } },
    )
    assert.equal(invalidWebhookAdministrationFilterResponse.status, 422)
    const missingWebhookEndpointResponse = await fetch(
      `${baseUrl}/v1/webhooks/endpoints/00000000-0000-4000-8000-000000000999`,
      { headers: { authorization } },
    )
    assert.equal(missingWebhookEndpointResponse.status, 404)

    const webhookListResponse = await fetch(
      `${baseUrl}/v1/webhooks/deliveries?status=succeeded&endpointId=${webhookEndpointId}&eventId=${webhookEventId}`,
      { headers: { authorization } },
    )
    const webhookList = await webhookListResponse.json()
    assert.equal(webhookListResponse.status, 200)
    assert.equal(webhookList.data.deliveries.length, 1)
    assert.equal(webhookList.data.deliveries[0].id, webhookDeliveryId)
    assert.equal(webhookList.data.deliveries[0].endpointId, webhookEndpointId)
    assert.equal(JSON.stringify(webhookList).includes('hooks.example.com'), false)
    assert.equal(JSON.stringify(webhookList).includes('lease'), false)
    assert.equal(JSON.stringify(webhookList).includes('dataJson'), false)

    const webhookReadResponse = await fetch(
      `${baseUrl}/v1/webhooks/deliveries/${webhookDeliveryId}`,
      { headers: { authorization } },
    )
    const webhookRead = await webhookReadResponse.json()
    assert.equal(webhookReadResponse.status, 200)
    assert.equal(webhookRead.data.delivery.id, webhookDeliveryId)
    assert.deepEqual(
      webhookRead.data.delivery.attempts.map((attempt) => attempt.attemptNumber),
      [1],
    )
    assert.equal(webhookRead.data.delivery.attempts[0].responseStatus, 204)
    assert.equal('workspaceId' in webhookRead.data.delivery, false)
    assert.equal('deliveryId' in webhookRead.data.delivery.attempts[0], false)
    const invalidWebhookFilterResponse = await fetch(
      `${baseUrl}/v1/webhooks/deliveries?unknown=value`,
      { headers: { authorization } },
    )
    assert.equal(invalidWebhookFilterResponse.status, 422)
    const webhookReplayUrl = `${baseUrl}/v1/webhooks/deliveries/${webhookDeliveryId}/replay`
    const missingReplayKeyResponse = await fetch(webhookReplayUrl, {
      method: 'POST',
      headers: { authorization },
    })
    assert.equal(missingReplayKeyResponse.status, 422)
    const replayWebhookRequest = (idempotencyKey) => fetch(webhookReplayUrl, {
      method: 'POST',
      headers: { authorization, 'idempotency-key': idempotencyKey },
    })
    const webhookReplayConcurrentResponses = await Promise.all([
      replayWebhookRequest('public-webhook-replay-1'),
      replayWebhookRequest('public-webhook-replay-1'),
    ])
    assert.deepEqual(
      webhookReplayConcurrentResponses.map((response) => response.status).sort(),
      [200, 202],
    )
    const webhookReplayConcurrentBodies = await Promise.all(
      webhookReplayConcurrentResponses.map((response) => response.json()),
    )
    const webhookReplay = webhookReplayConcurrentBodies.find(
      (body) => body.data.replayed === false,
    )
    const webhookReplayAgain = webhookReplayConcurrentBodies.find(
      (body) => body.data.replayed === true,
    )
    assert.ok(webhookReplay)
    assert.ok(webhookReplayAgain)
    assert.equal(webhookReplay.data.replayed, false)
    assert.equal(webhookReplay.data.delivery.status, 'retry-scheduled')
    assert.equal('completedAt' in webhookReplay.data.delivery, false)
    assert.deepEqual(
      webhookReplay.data.delivery.attempts.map((attempt) => attempt.attemptNumber),
      [1],
    )
    assert.equal(webhookReplayAgain.data.replayed, true)
    assert.deepEqual(webhookReplayAgain.data.delivery, webhookReplay.data.delivery)
    const duplicateReplayResponse = await replayWebhookRequest('public-webhook-replay-2')
    const duplicateReplay = await duplicateReplayResponse.json()
    assert.equal(duplicateReplayResponse.status, 409)
    assert.equal(duplicateReplay.error.code, 'WEBHOOK_DELIVERY_REPLAY_REJECTED')

    const replayResetAt = new Date()
    await client.v2WebhookDelivery.update({
      where: { id: webhookDeliveryId },
      data: {
        status: 'dead-lettered',
        completedAt: replayResetAt,
        deadLetteredAt: replayResetAt,
        updatedAt: replayResetAt,
      },
    })
    const discardedReplayResponse = await replayWebhookRequest('public-webhook-replay-loss-1')
    assert.equal(discardedReplayResponse.status, 202)
    const recoveredReplayResponse = await replayWebhookRequest('public-webhook-replay-loss-1')
    const recoveredReplay = await recoveredReplayResponse.json()
    assert.equal(recoveredReplayResponse.status, 200)
    assert.equal(recoveredReplay.data.replayed, true)
    assert.equal(recoveredReplay.data.delivery.id, webhookDeliveryId)
    assert.equal(recoveredReplay.data.delivery.status, 'retry-scheduled')

    const webhookEventReplayUrl =
      `${baseUrl}/v1/webhooks/events/${webhookReplayEventId}/replay`
    const missingEventReplayKeyResponse = await fetch(webhookEventReplayUrl, {
      method: 'POST',
      headers: { authorization },
    })
    assert.equal(missingEventReplayKeyResponse.status, 422)
    const replayWebhookEventRequest = (idempotencyKey) => fetch(webhookEventReplayUrl, {
      method: 'POST',
      headers: { authorization, 'idempotency-key': idempotencyKey },
    })
    const webhookEventReplayConcurrentResponses = await Promise.all([
      replayWebhookEventRequest('public-webhook-event-replay-1'),
      replayWebhookEventRequest('public-webhook-event-replay-1'),
    ])
    assert.deepEqual(
      webhookEventReplayConcurrentResponses.map((response) => response.status).sort(),
      [200, 202],
    )
    const webhookEventReplayConcurrentBodies = await Promise.all(
      webhookEventReplayConcurrentResponses.map((response) => response.json()),
    )
    const webhookEventReplay = webhookEventReplayConcurrentBodies.find(
      (body) => body.data.replayed === false,
    )
    const webhookEventReplayAgain = webhookEventReplayConcurrentBodies.find(
      (body) => body.data.replayed === true,
    )
    assert.ok(webhookEventReplay)
    assert.ok(webhookEventReplayAgain)
    assert.equal(webhookEventReplay.data.eventId, webhookReplayEventId)
    assert.equal(webhookEventReplay.data.replayed, false)
    assert.equal(webhookEventReplay.data.items.length, 1)
    assert.equal(webhookEventReplay.data.items[0].status, 'scheduled')
    assert.equal(webhookEventReplay.data.items[0].delivery.id, webhookReplayDeliveryId)
    assert.equal(webhookEventReplay.data.items[0].delivery.status, 'retry-scheduled')
    assert.equal('workspaceId' in webhookEventReplay.data.items[0].delivery, false)
    assert.equal(webhookEventReplayAgain.data.replayed, true)
    assert.deepEqual(webhookEventReplayAgain.data.items, webhookEventReplay.data.items)
    const duplicateEventReplayResponse = await replayWebhookEventRequest(
      'public-webhook-event-replay-2',
    )
    assert.equal(duplicateEventReplayResponse.status, 409)
    assert.equal(
      (await duplicateEventReplayResponse.json()).error.code,
      'WEBHOOK_EVENT_REPLAY_REJECTED',
    )

    const eventReplayResetAt = new Date()
    await client.v2WebhookDelivery.update({
      where: { id: webhookReplayDeliveryId },
      data: {
        status: 'dead-lettered',
        completedAt: eventReplayResetAt,
        deadLetteredAt: eventReplayResetAt,
        updatedAt: eventReplayResetAt,
      },
    })
    const discardedEventReplayResponse = await replayWebhookEventRequest(
      'public-webhook-event-replay-loss-1',
    )
    assert.equal(discardedEventReplayResponse.status, 202)
    const recoveredEventReplayResponse = await replayWebhookEventRequest(
      'public-webhook-event-replay-loss-1',
    )
    const recoveredEventReplay = await recoveredEventReplayResponse.json()
    assert.equal(recoveredEventReplayResponse.status, 200)
    assert.equal(recoveredEventReplay.data.replayed, true)
    assert.equal(recoveredEventReplay.data.eventId, webhookReplayEventId)
    assert.equal(recoveredEventReplay.data.items.length, 1)
    assert.equal(recoveredEventReplay.data.items[0].status, 'scheduled')

    const revokeEndpointResponse = await setWebhookEndpointStatus(
      'revoked',
      currentEndpoint.revision,
    )
    const revokedEndpoint = await revokeEndpointResponse.json()
    assert.equal(revokeEndpointResponse.status, 200)
    assert.equal(revokedEndpoint.data.endpoint.status, 'revoked')
    assert.equal(revokedEndpoint.data.effects.revokedSubscriptions, 1)
    assert.equal(revokedEndpoint.data.effects.revokedSigningSecrets, 1)
    assert.equal(revokedEndpoint.data.endpoint.currentSigningSecret.status, 'revoked')
    const cascadedRevokedSubscriptionResponse = await fetch(
      `${baseUrl}/v1/webhooks/subscriptions/${webhookSubscriptionId}`,
      { headers: { authorization } },
    )
    const cascadedRevokedSubscription = await cascadedRevokedSubscriptionResponse.json()
    assert.equal(cascadedRevokedSubscription.data.subscription.status, 'revoked')
    const revokeSubscriptionResponse = await setWebhookSubscriptionStatus(
      'revoked',
      cascadedRevokedSubscription.data.subscription.revision,
    )
    const revokedSubscription = await revokeSubscriptionResponse.json()
    assert.equal(revokeSubscriptionResponse.status, 200)
    assert.equal(revokedSubscription.data.subscription.status, 'revoked')
    const resumeRevokedSubscriptionResponse = await setWebhookSubscriptionStatus(
      'active',
      revokedSubscription.data.subscription.revision,
    )
    assert.equal(resumeRevokedSubscriptionResponse.status, 409)
    assert.equal(
      (await resumeRevokedSubscriptionResponse.json()).error.code,
      'WEBHOOK_SUBSCRIPTION_TRANSITION_REJECTED',
    )
    const resumeRevokedEndpointResponse = await setWebhookEndpointStatus(
      'active',
      revokedEndpoint.data.endpoint.revision,
    )
    assert.equal(resumeRevokedEndpointResponse.status, 409)
    assert.equal(
      (await resumeRevokedEndpointResponse.json()).error.code,
      'WEBHOOK_ENDPOINT_TRANSITION_REJECTED',
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
    const childConcurrentResponses = await Promise.all([
      createChildRequest(),
      createChildRequest(),
    ])
    assert.deepEqual(
      childConcurrentResponses.map((response) => response.status).sort(),
      [200, 201],
    )
    const childConcurrentBodies = await Promise.all(
      childConcurrentResponses.map((response) => response.json()),
    )
    const childCreated = childConcurrentBodies.find((body) => body.data.replayed === false)
    const childReplay = childConcurrentBodies.find((body) => body.data.replayed === true)
    assert.ok(childCreated)
    assert.ok(childReplay)
    assert.equal(childCreated.data.secretAvailable, true)
    assert.equal(typeof childCreated.data.token, 'string')
    assert.equal(childCreated.data.replayed, false)
    assert.equal(childReplay.data.replayed, true)
    assert.equal(childReplay.data.secretAvailable, false)
    assert.equal('token' in childReplay.data, false)
    assert.equal(childReplay.data.client.id, childCreated.data.client.id)

    const responseLossRequest = () =>
      fetch(`${baseUrl}/v1/workspaces/${workspaceId}/clients`, {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': 'public-create-client-response-loss-1',
        },
        body: JSON.stringify({
          name: 'Client with discarded response',
          environment: apiEnvironment,
          scopes: ['projects:read'],
        }),
      })
    const discardedResponse = await responseLossRequest()
    assert.equal(discardedResponse.status, 201)
    const recoveredResponse = await responseLossRequest()
    const recovered = await recoveredResponse.json()
    assert.equal(recoveredResponse.status, 200)
    assert.equal(recovered.data.replayed, true)
    assert.equal(recovered.data.secretAvailable, false)
    assert.equal('token' in recovered.data, false)

    const mismatchedClientRequest = (name) =>
      fetch(`${baseUrl}/v1/workspaces/${workspaceId}/clients`, {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          'idempotency-key': 'public-create-client-concurrent-mismatch-1',
        },
        body: JSON.stringify({
          name,
          environment: apiEnvironment,
          scopes: ['projects:read'],
        }),
      })
    const mismatchedResponses = await Promise.all([
      mismatchedClientRequest('Concurrent client A'),
      mismatchedClientRequest('Concurrent client B'),
    ])
    assert.deepEqual(
      mismatchedResponses.map((response) => response.status).sort(),
      [201, 409],
    )
    const mismatchedBodies = await Promise.all(
      mismatchedResponses.map((response) => response.json()),
    )
    const mismatchedWinner = mismatchedBodies.find((body) => body.data)
    const mismatchedFailure = mismatchedBodies.find((body) => body.error)
    assert.equal(mismatchedWinner.data.replayed, false)
    assert.equal(mismatchedWinner.data.secretAvailable, true)
    assert.equal(typeof mismatchedWinner.data.token, 'string')
    assert.equal(mismatchedFailure.error.code, 'IDEMPOTENCY_PAYLOAD_MISMATCH')

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
        'apollo.tools.list',
        'apollo.events.catalog.read',
        'apollo.projects.list',
        'apollo.contracts.openapi.read',
        'apollo.contracts.schemas.read',
      ],
    )
    const childWebhookResponse = await fetch(`${baseUrl}/v1/webhooks/deliveries`, {
      headers: { authorization: childAuthorization },
    })
    assert.equal(childWebhookResponse.status, 403)
    const childWebhookEndpointResponse = await fetch(`${baseUrl}/v1/webhooks/endpoints`, {
      headers: { authorization: childAuthorization },
    })
    assert.equal(childWebhookEndpointResponse.status, 403)
    const childWebhookEndpointCreateResponse = await fetch(`${baseUrl}/v1/webhooks/endpoints`, {
      method: 'POST',
      headers: {
        authorization: childAuthorization,
        'content-type': 'application/json',
        'idempotency-key': 'child-endpoint-create-1',
      },
      body: JSON.stringify({ url: 'https://child-hooks.example.com/apollo' }),
    })
    assert.equal(childWebhookEndpointCreateResponse.status, 403)
    const childWebhookChallengeResponse = await fetch(webhookChallengeUrl, {
      method: 'POST',
      headers: { authorization: childAuthorization },
    })
    assert.equal(childWebhookChallengeResponse.status, 403)
    const childWebhookSecretProvisionResponse = await fetch(signingSecretProvisioningUrl, {
      method: 'POST',
      headers: {
        authorization: childAuthorization,
        'content-type': 'application/json',
        'idempotency-key': 'child-secret-provision-1',
      },
      body: JSON.stringify(provisionSecretBody),
    })
    assert.equal(childWebhookSecretProvisionResponse.status, 403)
    const childWebhookEndpointStatusResponse = await fetch(
      webhookEndpointStatusUrl,
      {
        method: 'PUT',
        headers: {
          authorization: childAuthorization,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          status: 'suspended',
          baseRevision: revokedEndpoint.data.endpoint.revision,
        }),
      },
    )
    assert.equal(childWebhookEndpointStatusResponse.status, 403)
    const childWebhookSubscriptionResponse = await fetch(
      `${baseUrl}/v1/webhooks/subscriptions`,
      { headers: { authorization: childAuthorization } },
    )
    assert.equal(childWebhookSubscriptionResponse.status, 403)
    const childWebhookSubscriptionCreateResponse = await fetch(
      `${baseUrl}/v1/webhooks/subscriptions`,
      {
        method: 'POST',
        headers: {
          authorization: childAuthorization,
          'content-type': 'application/json',
          'idempotency-key': 'child-subscription-create-1',
        },
        body: JSON.stringify({
          endpointId: webhookEndpointId,
          eventTypes: ['artifact.ready'],
        }),
      },
    )
    assert.equal(childWebhookSubscriptionCreateResponse.status, 403)
    const childWebhookSubscriptionStatusResponse = await fetch(
      webhookSubscriptionStatusUrl,
      {
        method: 'PUT',
        headers: {
          authorization: childAuthorization,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          status: 'paused',
          baseRevision: revokedSubscription.data.subscription.revision,
        }),
      },
    )
    assert.equal(childWebhookSubscriptionStatusResponse.status, 403)
    const childWebhookReplayResponse = await fetch(
      `${baseUrl}/v1/webhooks/deliveries/${webhookDeliveryId}/replay`,
      {
        method: 'POST',
        headers: {
          authorization: childAuthorization,
          'idempotency-key': 'child-webhook-replay-1',
        },
      },
    )
    assert.equal(childWebhookReplayResponse.status, 403)
    const childWebhookEventReplayResponse = await fetch(
      `${baseUrl}/v1/webhooks/events/${webhookReplayEventId}/replay`,
      {
        method: 'POST',
        headers: {
          authorization: childAuthorization,
          'idempotency-key': 'child-webhook-event-replay-1',
        },
      },
    )
    assert.equal(childWebhookEventReplayResponse.status, 403)

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
        artifactKey: `artifact:${sourceArtifactId}`,
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
    const unconfiguredRightsEtag = unconfiguredRightsResponse.headers.get('etag')
    assert.match(unconfiguredRightsEtag, /^"[a-f0-9]{64}"$/)
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
        headers: {
          authorization,
          'content-type': 'application/json',
          'if-match': unconfiguredRightsEtag,
        },
        body: JSON.stringify(approvedRightsRequest),
      })
    const missingRightsIfMatchResponse = await fetch(
      `${baseUrl}/v1/artifacts/${sourceArtifactId}/rights`,
      {
        method: 'PUT',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify(approvedRightsRequest),
      },
    )
    assert.equal(missingRightsIfMatchResponse.status, 428)
    assert.equal((await missingRightsIfMatchResponse.json()).error.code, 'PRECONDITION_REQUIRED')
    const malformedRightsIfMatchResponse = await fetch(
      `${baseUrl}/v1/artifacts/${sourceArtifactId}/rights`,
      {
        method: 'PUT',
        headers: {
          authorization,
          'content-type': 'application/json',
          'if-match': 'not-a-strong-etag',
        },
        body: JSON.stringify(approvedRightsRequest),
      },
    )
    assert.equal(malformedRightsIfMatchResponse.status, 422)
    assert.equal((await malformedRightsIfMatchResponse.json()).error.code, 'INVALID_ARGUMENT')
    const setRightsResponses = await Promise.all([setRights(), setRights()])
    assert.deepEqual(setRightsResponses.map((response) => response.status), [200, 200])
    const setRightsBodies = await Promise.all(setRightsResponses.map((response) => response.json()))
    const setRightsResult = setRightsBodies.find((body) => body.data.replayed === false)
    const concurrentRightsReplay = setRightsBodies.find((body) => body.data.replayed === true)
    assert.ok(setRightsResult)
    assert.ok(concurrentRightsReplay)
    assert.equal(setRightsResponses[0].headers.get('etag'), setRightsResponses[1].headers.get('etag'))
    assert.equal(setRightsResult.data.replayed, false)
    assert.equal(setRightsResult.data.rights.status, 'approved')
    assert.equal(setRightsResult.data.rights.sequence, 1)
    assert.equal(setRightsResult.data.rights.snapshotHash.length, 64)
    assert.equal(concurrentRightsReplay.data.rights.id, setRightsResult.data.rights.id)
    assert.equal(concurrentRightsReplay.data.rights.sequence, 1)

    const discardedRightsResponse = await setRights()
    assert.equal(discardedRightsResponse.status, 200)
    const recoveredRightsResponse = await setRights()
    const replayRights = await recoveredRightsResponse.json()
    assert.equal(recoveredRightsResponse.status, 200)
    assert.equal(replayRights.data.replayed, true)
    assert.equal(replayRights.data.rights.id, setRightsResult.data.rights.id)
    const storedRightsArtifact = await client.v2MediaArtifact.findUniqueOrThrow({
      where: { id: sourceArtifactId },
      select: { rightsRevision: true, currentRightsSnapshotId: true },
    })
    assert.equal(storedRightsArtifact.rightsRevision, 1)
    assert.equal(storedRightsArtifact.currentRightsSnapshotId, setRightsResult.data.rights.id)

    const currentRightsResponse = await fetch(
      `${baseUrl}/v1/artifacts/${sourceArtifactId}/rights`,
      { headers: { authorization } },
    )
    const currentRights = await currentRightsResponse.json()
    assert.equal(currentRightsResponse.status, 200)
    const currentRightsEtag = currentRightsResponse.headers.get('etag')
    assert.equal(currentRightsEtag, setRightsResponses[0].headers.get('etag'))
    assert.equal(currentRights.data.configured, true)
    assert.equal(currentRights.data.rights.id, setRightsResult.data.rights.id)

    const setDivergentRights = (sourceNote) =>
      fetch(`${baseUrl}/v1/artifacts/${sourceArtifactId}/rights`, {
        method: 'PUT',
        headers: {
          authorization,
          'content-type': 'application/json',
          'if-match': currentRightsEtag,
        },
        body: JSON.stringify({ ...approvedRightsRequest, sourceNote }),
      })
    const divergentRightsResponses = await Promise.all([
      setDivergentRights('Concurrent legal revision A'),
      setDivergentRights('Concurrent legal revision B'),
    ])
    assert.deepEqual(
      divergentRightsResponses.map((response) => response.status).sort(),
      [200, 412],
    )
    const divergentRightsBodies = await Promise.all(
      divergentRightsResponses.map((response) => response.json()),
    )
    assert.equal(
      divergentRightsBodies.find((body) => body.error)?.error.code,
      'ASSET_RIGHTS_REVISION_MISMATCH',
    )
    const divergentWinner = divergentRightsResponses.find((response) => response.status === 200)
    assert.ok(divergentWinner)
    assert.notEqual(divergentWinner.headers.get('etag'), currentRightsEtag)
    const afterDivergentRightsArtifact = await client.v2MediaArtifact.findUniqueOrThrow({
      where: { id: sourceArtifactId },
      select: { rightsRevision: true },
    })
    assert.equal(afterDivergentRightsArtifact.rightsRevision, 2)

    const divergentWinnerEtag = divergentWinner.headers.get('etag')
    const restoreHistoricalRights = () =>
      fetch(`${baseUrl}/v1/artifacts/${sourceArtifactId}/rights`, {
        method: 'PUT',
        headers: {
          authorization,
          'content-type': 'application/json',
          'if-match': divergentWinnerEtag,
        },
        body: JSON.stringify(approvedRightsRequest),
      })
    const restoredHistoricalRightsResponse = await restoreHistoricalRights()
    const restoredHistoricalRights = await restoredHistoricalRightsResponse.json()
    assert.equal(restoredHistoricalRightsResponse.status, 200)
    assert.equal(restoredHistoricalRights.data.replayed, false)
    assert.equal(restoredHistoricalRights.data.rights.id, setRightsResult.data.rights.id)
    assert.notEqual(restoredHistoricalRightsResponse.headers.get('etag'), divergentWinnerEtag)
    const restoredHistoricalReplayResponse = await restoreHistoricalRights()
    const restoredHistoricalReplay = await restoredHistoricalReplayResponse.json()
    assert.equal(restoredHistoricalReplayResponse.status, 200)
    assert.equal(restoredHistoricalReplay.data.replayed, true)
    assert.equal(
      restoredHistoricalReplayResponse.headers.get('etag'),
      restoredHistoricalRightsResponse.headers.get('etag'),
    )
    const afterHistoricalRestoreArtifact = await client.v2MediaArtifact.findUniqueOrThrow({
      where: { id: sourceArtifactId },
      select: { rightsRevision: true },
    })
    assert.equal(afterHistoricalRestoreArtifact.rightsRevision, 3)

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
    const materializationConcurrentResponses = await Promise.all([
      createMaterializationAuthorization('materialization-approved-1'),
      createMaterializationAuthorization('materialization-approved-1'),
    ])
    assert.deepEqual(
      materializationConcurrentResponses.map((response) => response.status).sort(),
      [200, 201],
    )
    const materializationConcurrentBodies = await Promise.all(
      materializationConcurrentResponses.map((response) => response.json()),
    )
    const materialization = materializationConcurrentBodies.find(
      (body) => body.data.replayed === false,
    )
    const materializationReplay = materializationConcurrentBodies.find(
      (body) => body.data.replayed === true,
    )
    assert.ok(materialization)
    assert.ok(materializationReplay)
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

    assert.equal(materializationReplay.data.replayed, true)
    assert.equal(
      materializationReplay.data.authorization.id,
      materialization.data.authorization.id,
    )
    const discardedMaterializationResponse = await createMaterializationAuthorization(
      'materialization-response-loss-1',
    )
    assert.equal(discardedMaterializationResponse.status, 201)
    const recoveredMaterializationResponse = await createMaterializationAuthorization(
      'materialization-response-loss-1',
    )
    const recoveredMaterialization = await recoveredMaterializationResponse.json()
    assert.equal(recoveredMaterializationResponse.status, 200)
    assert.equal(recoveredMaterialization.data.replayed, true)
    assert.equal(
      await client.v2MaterializationAuthorization.count({
        where: {
          workspaceId,
          id: recoveredMaterialization.data.authorization.id,
        },
      }),
      1,
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
    const renderOperationConcurrentResponses = await Promise.all([
      enqueueRender('render-operation-approved-1'),
      enqueueRender('render-operation-approved-1'),
    ])
    assert.ok(renderOperationConcurrentResponses.every((response) => response.status === 202))
    const renderOperationConcurrentBodies = await Promise.all(
      renderOperationConcurrentResponses.map((response) => response.json()),
    )
    const renderOperation = renderOperationConcurrentBodies.find(
      (body) => body.data.replayed === false,
    )
    const renderOperationReplay = renderOperationConcurrentBodies.find(
      (body) => body.data.replayed === true,
    )
    assert.ok(renderOperation)
    assert.ok(renderOperationReplay)
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
    const canceledOperationResponses = await Promise.all([
      cancelOperationRequest(),
      cancelOperationRequest(),
    ])
    assert.deepEqual(canceledOperationResponses.map((response) => response.status), [200, 200])
    const [canceledOperation, canceledConcurrentReplay] = await Promise.all(
      canceledOperationResponses.map((response) => response.json()),
    )
    assert.equal(canceledOperation.data.operation.status, 'canceled')
    assert.equal(canceledOperation.data.operation.phase, 'canceled')
    assert.equal(canceledOperation.data.operation.cancelable, false)
    assert.equal(canceledOperation.data.operation.retryable, false)
    assert.equal(typeof canceledOperation.data.operation.completedAt, 'string')
    assert.deepEqual(canceledConcurrentReplay.data.operation, canceledOperation.data.operation)
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
    const retriedOperationResponses = await Promise.all([
      retryOperationRequest(),
      retryOperationRequest(),
    ])
    assert.deepEqual(retriedOperationResponses.map((response) => response.status), [200, 200])
    const [retriedOperation, retriedConcurrentReplay] = await Promise.all(
      retriedOperationResponses.map((response) => response.json()),
    )
    assert.equal(retriedOperation.data.operation.status, 'queued')
    assert.equal(retriedOperation.data.operation.phase, 'queued')
    assert.equal(retriedOperation.data.operation.attempt, 0)
    assert.equal(retriedOperation.data.operation.cancelable, true)
    assert.equal('completedAt' in retriedOperation.data.operation, false)
    assert.deepEqual(retriedConcurrentReplay.data.operation, retriedOperation.data.operation)
    const retriedReplayResponse = await retryOperationRequest()
    assert.deepEqual(
      (await retriedReplayResponse.json()).data.operation,
      retriedOperation.data.operation,
    )
    const discardedCancelOperationResponse = await cancelOperationRequest()
    assert.equal(discardedCancelOperationResponse.status, 200)
    const recoveredCancelOperationResponse = await cancelOperationRequest()
    const recoveredCancelOperation = await recoveredCancelOperationResponse.json()
    assert.equal(recoveredCancelOperationResponse.status, 200)
    assert.equal(recoveredCancelOperation.data.operation.status, 'canceled')
    const discardedRetryOperationResponse = await retryOperationRequest()
    assert.equal(discardedRetryOperationResponse.status, 200)
    const recoveredRetryOperationResponse = await retryOperationRequest()
    const recoveredRetryOperation = await recoveredRetryOperationResponse.json()
    assert.equal(recoveredRetryOperationResponse.status, 200)
    assert.equal(recoveredRetryOperation.data.operation.status, 'queued')
    assert.equal(recoveredRetryOperation.data.operation.attempt, 0)
    const canceledReadResponse = await fetch(
      `${baseUrl}/v1/operations/${renderOperation.data.operation.id}`,
      { headers: { authorization } },
    )
    assert.deepEqual(
      (await canceledReadResponse.json()).data.operation,
      recoveredRetryOperation.data.operation,
    )
    const discardedSecondRenderOperationResponse = await enqueueRender(
      'render-operation-approved-2',
    )
    assert.equal(discardedSecondRenderOperationResponse.status, 202)
    const secondRenderOperationResponse = await enqueueRender('render-operation-approved-2')
    const secondRenderOperation = await secondRenderOperationResponse.json()
    assert.equal(secondRenderOperationResponse.status, 202)
    assert.equal(secondRenderOperation.data.replayed, true)
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
    const retryDeadLetterRequest = () => fetch(
      `${baseUrl}/v1/operations/${firstDeadLetterPage.data.operations[0].id}/retry`,
      { method: 'POST', headers: { authorization } },
    )
    const retriedDeadLetterResponses = await Promise.all([
      retryDeadLetterRequest(),
      retryDeadLetterRequest(),
    ])
    assert.deepEqual(retriedDeadLetterResponses.map((response) => response.status), [200, 200])
    const [retriedDeadLetter, retriedDeadLetterConcurrentReplay] = await Promise.all(
      retriedDeadLetterResponses.map((response) => response.json()),
    )
    assert.equal(retriedDeadLetter.data.operation.status, 'retrying')
    assert.equal(retriedDeadLetter.data.operation.attempt, 1)
    assert.equal(retriedDeadLetter.data.operation.maxAttempts, 2)
    assert.deepEqual(
      retriedDeadLetterConcurrentReplay.data.operation,
      retriedDeadLetter.data.operation,
    )
    const recoveredDeadLetterRetryResponse = await retryDeadLetterRequest()
    assert.deepEqual(
      (await recoveredDeadLetterRetryResponse.json()).data.operation,
      retriedDeadLetter.data.operation,
    )
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
    const rotateConcurrentResponses = await Promise.all([
      rotateRequest(),
      rotateRequest(),
    ])
    assert.deepEqual(
      rotateConcurrentResponses.map((response) => response.status).sort(),
      [200, 201],
    )
    const rotateConcurrentBodies = await Promise.all(
      rotateConcurrentResponses.map((response) => response.json()),
    )
    const rotated = rotateConcurrentBodies.find((body) => body.data.replayed === false)
    const rotateReplay = rotateConcurrentBodies.find((body) => body.data.replayed === true)
    assert.ok(rotated)
    assert.ok(rotateReplay)
    assert.equal(rotated.data.secretAvailable, true)
    assert.equal(typeof rotated.data.token, 'string')
    assert.equal(rotateReplay.data.secretAvailable, false)
    assert.equal('token' in rotateReplay.data, false)
    assert.equal(rotateReplay.data.credential.id, rotated.data.credential.id)

    const expiredOldTokenResponse = await fetch(`${baseUrl}/v1/projects`, {
      headers: { authorization: childAuthorization },
    })
    assert.equal(expiredOldTokenResponse.status, 401)

    const rotatedAuthorization = `Bearer ${rotated.data.token}`
    const rotatedTokenResponse = await fetch(`${baseUrl}/v1/projects`, {
      headers: { authorization: rotatedAuthorization },
    })
    assert.equal(rotatedTokenResponse.status, 200)

    const rotateCredential = (targetClientId, idempotencyKey, overlapSeconds) =>
      fetch(
        `${baseUrl}/v1/workspaces/${workspaceId}/clients/${targetClientId}/credentials`,
        {
          method: 'POST',
          headers: {
            authorization,
            'content-type': 'application/json',
            'idempotency-key': idempotencyKey,
          },
          body: JSON.stringify({ overlapSeconds }),
        },
      )
    const discardedRotationResponse = await rotateCredential(
      recovered.data.client.id,
      'rotate-client-response-loss-1',
      30,
    )
    assert.equal(discardedRotationResponse.status, 201)
    const recoveredRotationResponse = await rotateCredential(
      recovered.data.client.id,
      'rotate-client-response-loss-1',
      30,
    )
    const recoveredRotation = await recoveredRotationResponse.json()
    assert.equal(recoveredRotationResponse.status, 200)
    assert.equal(recoveredRotation.data.replayed, true)
    assert.equal(recoveredRotation.data.secretAvailable, false)
    assert.equal('token' in recoveredRotation.data, false)

    const mismatchedRotationResponses = await Promise.all([
      rotateCredential(
        mismatchedWinner.data.client.id,
        'rotate-client-concurrent-mismatch-1',
        30,
      ),
      rotateCredential(
        mismatchedWinner.data.client.id,
        'rotate-client-concurrent-mismatch-1',
        60,
      ),
    ])
    assert.deepEqual(
      mismatchedRotationResponses.map((response) => response.status).sort(),
      [201, 409],
    )
    const mismatchedRotationBodies = await Promise.all(
      mismatchedRotationResponses.map((response) => response.json()),
    )
    const mismatchedRotationWinner = mismatchedRotationBodies.find((body) => body.data)
    const mismatchedRotationFailure = mismatchedRotationBodies.find((body) => body.error)
    assert.equal(mismatchedRotationWinner.data.replayed, false)
    assert.equal(mismatchedRotationWinner.data.secretAvailable, true)
    assert.equal(typeof mismatchedRotationWinner.data.token, 'string')
    assert.equal(
      mismatchedRotationFailure.error.code,
      'IDEMPOTENCY_PAYLOAD_MISMATCH',
    )

    const selfRevokeResponse = await fetch(
      `${baseUrl}/v1/workspaces/${workspaceId}/clients/${apiClientId}/credentials/${issued.credential.id}`,
      { method: 'DELETE', headers: { authorization } },
    )
    assert.equal(selfRevokeResponse.status, 409)

    const revokeCredentialRequest = () => fetch(
      `${baseUrl}/v1/workspaces/${workspaceId}/clients/${childCreated.data.client.id}/credentials/${rotated.data.credential.id}`,
      { method: 'DELETE', headers: { authorization } },
    )
    const revokeResponses = await Promise.all([
      revokeCredentialRequest(),
      revokeCredentialRequest(),
    ])
    assert.deepEqual(revokeResponses.map((response) => response.status), [200, 200])
    const [revoked, concurrentRevoked] = await Promise.all(
      revokeResponses.map((response) => response.json()),
    )
    assert.equal(revoked.data.credential.status, 'revoked')
    assert.deepEqual(concurrentRevoked.data.credential, revoked.data.credential)
    const discardedRevokeResponse = await revokeCredentialRequest()
    assert.equal(discardedRevokeResponse.status, 200)
    const recoveredRevokeResponse = await revokeCredentialRequest()
    const recoveredRevoked = await recoveredRevokeResponse.json()
    assert.equal(recoveredRevokeResponse.status, 200)
    assert.deepEqual(recoveredRevoked.data.credential, revoked.data.credential)
    const storedRevokedCredential = await client.v2ApiCredential.findUniqueOrThrow({
      where: {
        id_clientId: {
          id: rotated.data.credential.id,
          clientId: childCreated.data.client.id,
        },
      },
    })
    assert.equal(storedRevokedCredential.revokedAt.toISOString(), revoked.data.credential.revokedAt)

    const revokedTokenResponse = await fetch(`${baseUrl}/v1/projects`, {
      headers: { authorization: rotatedAuthorization },
    })
    assert.equal(revokedTokenResponse.status, 401)

    const storedAdminResponses = await client.v2IdempotencyRecord.findMany({
      where: {
        workspaceId,
        key: {
          in: [
            'public-create-child-client-1',
            'public-create-client-response-loss-1',
            'public-create-client-concurrent-mismatch-1',
            'rotate-child-client-1',
            'rotate-client-response-loss-1',
            'rotate-client-concurrent-mismatch-1',
          ],
        },
      },
      select: { responseJson: true },
    })
    assert.equal(storedAdminResponses.length, 6)
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
        body: JSON.stringify({
          name: 'Projeto criado externamente',
          objective: 'discovery',
          format: '9:16',
          locale: 'pt-BR',
          briefing: 'Público: gestores. Oferta: conteúdo. Tom: direto e natural.',
        }),
      })
    const createdResponse = await createRequest()
    const created = await createdResponse.json()
    assert.equal(createdResponse.status, 201)
    assert.equal(created.data.replayed, false)
    assert.equal(created.data.project.name, 'Projeto criado externamente')
    assert.equal(created.data.project.objective, 'discovery')
    assert.equal(created.data.project.format, '9:16')
    assert.equal(created.data.project.locale, 'pt-BR')
    assert.ok(created.data.version.snapshotRefs.brief)
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
