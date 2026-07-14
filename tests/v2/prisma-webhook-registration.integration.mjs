import assert from 'node:assert/strict'
import test from 'node:test'

test('webhook registration is atomic, workspace-scoped and stores only a secret reference', async () => {
  const clientPackage =
    process.env.APOLLO_V2_PERSISTENCE === 'postgres'
      ? '../../generated/prisma-v2/index.js'
      : '@prisma/client'
  const { PrismaClient } = await import(clientPackage)
  const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
  const { registerWebhookService } = await import('../../src/v2/application/register-webhook.ts')
  const {
    issueWebhookChallengeService,
    verifyWebhookChallengeService,
    verifyWebhookRequestService,
  } = await import('../../src/v2/application/secure-webhook.ts')
  const { DomainError } = await import('../../src/v2/domain/errors.ts')
  const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
  const {
    issueWebhookChallengeToken,
    signWebhookPayload,
  } = await import('../../src/v2/domain/webhook-security.ts')
  const { PrismaApiClientRepository } = await import(
    '../../src/v2/infrastructure/prisma/api-client-repository.ts'
  )
  const { PrismaWebhookRegistrationRepository } = await import(
    '../../src/v2/infrastructure/prisma/webhook-registration-repository.ts'
  )
  const { PrismaWebhookSecurityRepository } = await import(
    '../../src/v2/infrastructure/prisma/webhook-security-repository.ts'
  )
  const { PrismaWorkspaceRepository } = await import(
    '../../src/v2/infrastructure/prisma/workspace-repository.ts'
  )
  const { nodeApiCredentialCrypto } = await import(
    '../../src/v2/infrastructure/security/api-credential.ts'
  )

  const client = new PrismaClient()
  const workspaceId = 'webhook-integration-workspace'
  const clientId = 'webhook-integration-client'
  const now = new Date('2026-07-14T21:50:00.000Z')
  const idSets = [
    {
      'webhook-endpoint': '00000000-0000-4000-8000-000000000201',
      'webhook-secret': '00000000-0000-4000-8000-000000000202',
      'webhook-subscription': '00000000-0000-4000-8000-000000000203',
    },
    {
      'webhook-endpoint': '00000000-0000-4000-8000-000000000204',
      'webhook-secret': '00000000-0000-4000-8000-000000000205',
      'webhook-subscription': '00000000-0000-4000-8000-000000000206',
    },
    {
      'webhook-endpoint': '00000000-0000-4000-8000-000000000207',
      'webhook-secret': '00000000-0000-4000-8000-000000000208',
      'webhook-subscription': '00000000-0000-4000-8000-000000000209',
    },
  ]

  const cleanup = async () => {
    await client.v2WebhookReplayReceipt.deleteMany({ where: { workspaceId } })
    await client.v2WebhookVerificationChallenge.deleteMany({ where: { workspaceId } })
    await client.v2WebhookDeliveryAttempt.deleteMany({ where: { workspaceId } })
    await client.v2WebhookDelivery.deleteMany({ where: { workspaceId } })
    await client.v2WebhookSubscription.deleteMany({ where: { workspaceId } })
    await client.v2WebhookSigningSecret.deleteMany({ where: { workspaceId } })
    await client.v2WebhookEndpoint.deleteMany({ where: { workspaceId } })
    await client.v2ApiClient.deleteMany({ where: { workspaceId } })
    await client.v2Workspace.deleteMany({ where: { id: workspaceId } })
  }

  try {
    await cleanup()
    await new PrismaWorkspaceRepository(client).create(
      createWorkspace({
        id: workspaceId,
        slug: 'webhook-integration-workspace',
        name: 'Webhook Integration Workspace',
        status: 'active',
        createdAt: now.toISOString(),
      }),
    )
    await createApiClientService({
      repository: new PrismaApiClientRepository(client),
      credentialCrypto: nodeApiCredentialCrypto,
      clock: () => now,
    })({
      id: clientId,
      workspaceId,
      name: 'Webhook administrator',
      environment: 'sandbox',
      scopes: ['webhooks:admin'],
    })

    let registrationIndex = 0
    const register = registerWebhookService({
      repository: new PrismaWebhookRegistrationRepository(client),
      clock: () => now,
      createId: (kind) => idSets[registrationIndex][kind],
    })
    const request = {
      workspaceId,
      url: 'https://hooks.example.com/apollo',
      eventTypes: ['project.created', 'project.version.created'],
      resourceIds: ['integration-project-1'],
      createdByClientId: clientId,
      secret: {
        keyRef: 'vault://apollo/webhook-integration/key-1',
        fingerprint: 'b'.repeat(64),
      },
    }
    const registered = await register(request)
    assert.equal(registered.endpoint.status, 'pending-verification')

    const [endpoint, secret, subscription] = await Promise.all([
      client.v2WebhookEndpoint.findUniqueOrThrow({ where: { id: registered.endpoint.id } }),
      client.v2WebhookSigningSecret.findUniqueOrThrow({ where: { id: registered.secret.id } }),
      client.v2WebhookSubscription.findUniqueOrThrow({
        where: { id: registered.subscription.id },
      }),
    ])
    assert.equal(endpoint.workspaceId, workspaceId)
    assert.equal(secret.keyRef, request.secret.keyRef)
    assert.equal(secret.fingerprint, request.secret.fingerprint)
    assert.equal(JSON.stringify(secret).includes('secret-value'), false)
    assert.deepEqual(JSON.parse(subscription.filterEventTypesJson), [
      'project.created',
      'project.version.created',
    ])
    assert.deepEqual(JSON.parse(subscription.filterResourceIdsJson), [
      'integration-project-1',
    ])

    const security = new PrismaWebhookSecurityRepository(client)
    const wrongToken = issueWebhookChallengeToken(() => Buffer.alloc(32, 6)).token

    const exhausted = await issueWebhookChallengeService({
      repository: security,
      clock: () => now,
      createId: () => '00000000-0000-4000-8000-000000000208',
      issueToken: () => issueWebhookChallengeToken(() => Buffer.alloc(32, 3)),
    })({ workspaceId, endpointId: endpoint.id, maxAttempts: 1 })
    const verifyImmediately = verifyWebhookChallengeService({
      repository: security,
      clock: () => new Date(now.getTime() + 1_000),
    })
    await assert.rejects(
      () => verifyImmediately({
        workspaceId,
        endpointId: endpoint.id,
        challengeId: exhausted.challenge.id,
        echoedToken: wrongToken,
      }),
      (error) => error instanceof DomainError && error.code === 'WEBHOOK_CHALLENGE_REJECTED',
    )
    assert.equal(
      (await client.v2WebhookVerificationChallenge.findUniqueOrThrow({
        where: { id: exhausted.challenge.id },
      })).status,
      'failed',
    )
    await assert.rejects(
      () => verifyImmediately({
        workspaceId,
        endpointId: endpoint.id,
        challengeId: exhausted.challenge.id,
        echoedToken: exhausted.token,
      }),
      (error) => error instanceof DomainError && error.code === 'WEBHOOK_CHALLENGE_REJECTED',
    )

    const expiring = await issueWebhookChallengeService({
      repository: security,
      clock: () => now,
      createId: () => '00000000-0000-4000-8000-000000000209',
      issueToken: () => issueWebhookChallengeToken(() => Buffer.alloc(32, 4)),
    })({ workspaceId, endpointId: endpoint.id, ttlSeconds: 60 })
    const verifyExpired = verifyWebhookChallengeService({
      repository: security,
      clock: () => new Date(now.getTime() + 61_000),
    })
    await assert.rejects(
      () => verifyExpired({
        workspaceId,
        endpointId: endpoint.id,
        challengeId: expiring.challenge.id,
        echoedToken: expiring.token,
      }),
      (error) => error instanceof DomainError && error.code === 'WEBHOOK_CHALLENGE_REJECTED',
    )
    assert.equal(
      (await client.v2WebhookVerificationChallenge.findUniqueOrThrow({
        where: { id: expiring.challenge.id },
      })).status,
      'expired',
    )

    const issued = await issueWebhookChallengeService({
      repository: security,
      clock: () => now,
      createId: () => '00000000-0000-4000-8000-000000000210',
      issueToken: () => issueWebhookChallengeToken(() => Buffer.alloc(32, 5)),
    })({ workspaceId, endpointId: endpoint.id })
    const storedChallenge = await client.v2WebhookVerificationChallenge.findUniqueOrThrow({
      where: { id: issued.challenge.id },
    })
    assert.equal(storedChallenge.tokenHash, issued.challenge.tokenHash)
    assert.equal(JSON.stringify(storedChallenge).includes(issued.token), false)

    const verifyChallenge = verifyWebhookChallengeService({
      repository: security,
      clock: () => new Date(now.getTime() + 1_000),
    })
    await assert.rejects(
      () => verifyChallenge({
        workspaceId,
        endpointId: endpoint.id,
        challengeId: issued.challenge.id,
        echoedToken: wrongToken,
      }),
      (error) => error instanceof DomainError && error.code === 'WEBHOOK_CHALLENGE_REJECTED',
    )
    assert.equal(
      (await client.v2WebhookVerificationChallenge.findUniqueOrThrow({
        where: { id: issued.challenge.id },
      })).attemptCount,
      1,
    )
    const challengeResult = await verifyChallenge({
      workspaceId,
      endpointId: endpoint.id,
      challengeId: issued.challenge.id,
      echoedToken: issued.token,
    })
    assert.equal(challengeResult.challenge.status, 'verified')
    assert.equal(challengeResult.activatedSubscriptions, 1)
    assert.equal(
      (await client.v2WebhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } })).status,
      'active',
    )
    assert.equal(
      (await client.v2WebhookSubscription.findUniqueOrThrow({
        where: { id: subscription.id },
      })).status,
      'active',
    )
    await assert.rejects(
      () => verifyChallenge({
        workspaceId,
        endpointId: endpoint.id,
        challengeId: issued.challenge.id,
        echoedToken: issued.token,
      }),
      (error) => error instanceof DomainError && error.code === 'WEBHOOK_CHALLENGE_REJECTED',
    )

    const signedAt = new Date(now.getTime() + 2_000)
    const rawBody = Buffer.from('{"type":"project.created"}', 'utf8')
    const signedHeaders = signWebhookPayload({
      secret: Buffer.alloc(32, 8),
      eventId: '00000000-0000-4000-8000-000000000211',
      rawBody,
      timestamp: signedAt,
    })
    let receiptId = 212
    const verifyRequest = verifyWebhookRequestService({
      replayReceipts: security,
      clock: () => new Date(now.getTime() + 3_000),
      createId: () => `00000000-0000-4000-8000-${String(receiptId++).padStart(12, '0')}`,
    })
    const signedRequest = {
      workspaceId,
      endpointId: endpoint.id,
      secret: Buffer.alloc(32, 8),
      rawBody,
      headers: signedHeaders,
    }
    assert.equal((await verifyRequest(signedRequest)).eventId, signedHeaders['apollo-webhook-id'])
    await assert.rejects(
      () => verifyRequest(signedRequest),
      (error) => error instanceof DomainError && error.code === 'WEBHOOK_REPLAY_DETECTED',
    )
    assert.equal(await client.v2WebhookReplayReceipt.count({ where: { workspaceId } }), 1)

    registrationIndex = 1
    await assert.rejects(
      () => register({
        ...request,
        secret: {
          keyRef: 'vault://apollo/webhook-integration/key-2',
          fingerprint: 'c'.repeat(64),
        },
      }),
      (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
    )
    assert.equal(await client.v2WebhookEndpoint.count({ where: { workspaceId } }), 1)
    assert.equal(await client.v2WebhookSigningSecret.count({ where: { workspaceId } }), 1)
    assert.equal(await client.v2WebhookSubscription.count({ where: { workspaceId } }), 1)

    registrationIndex = 2
    await assert.rejects(
      () => register({
        ...request,
        url: 'https://other-hooks.example.com/apollo',
        createdByClientId: 'missing-webhook-client',
        secret: {
          keyRef: 'vault://apollo/webhook-integration/key-3',
          fingerprint: 'd'.repeat(64),
        },
      }),
      (error) => error instanceof DomainError && error.code === 'API_CLIENT_NOT_FOUND',
    )
    assert.equal(await client.v2WebhookEndpoint.count({ where: { workspaceId } }), 1)
  } finally {
    await cleanup()
    await client.$disconnect()
  }
})
