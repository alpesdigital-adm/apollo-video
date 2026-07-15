import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

test('webhook registration is atomic, workspace-scoped and stores only a secret reference', async () => {
  const clientPackage =
    process.env.APOLLO_V2_PERSISTENCE === 'postgres'
      ? '../../generated/prisma-v2/index.js'
      : '@prisma/client'
  const { PrismaClient } = await import(clientPackage)
  const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
  const { registerWebhookService } = await import('../../src/v2/application/register-webhook.ts')
  const { materializeNextWebhookEventService } = await import(
    '../../src/v2/application/materialize-webhook-deliveries.ts'
  )
  const {
    claimNextWebhookDeliveryService,
    heartbeatWebhookDeliveryService,
    settleWebhookDeliveryService,
  } = await import('../../src/v2/application/manage-webhook-delivery.ts')
  const { dispatchWebhookDeliveryService } = await import(
    '../../src/v2/application/dispatch-webhook-delivery.ts'
  )
  const { runNextWebhookDeliveryService } = await import(
    '../../src/v2/application/run-webhook-delivery-worker.ts'
  )
  const { discoverRunnableWebhookWorkspacesService } = await import(
    '../../src/v2/application/discover-webhook-workspaces.ts'
  )
  const { replayWebhookDeliveryService } = await import(
    '../../src/v2/application/replay-webhook-delivery.ts'
  )
  const { replayWebhookEventService } = await import(
    '../../src/v2/application/replay-webhook-event.ts'
  )
  const { coordinateWebhookWorkerShardService } = await import(
    '../../src/v2/application/coordinate-webhook-worker-shard.ts'
  )
  const {
    issueWebhookChallengeService,
    verifyWebhookChallengeService,
    verifyWebhookRequestService,
  } = await import('../../src/v2/application/secure-webhook.ts')
  const { DomainError } = await import('../../src/v2/domain/errors.ts')
  const { webhookSubscriptionRevision } = await import('../../src/v2/domain/webhook.ts')
  const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
  const {
    issueWebhookChallengeToken,
    signWebhookPayload,
    verifyWebhookSignature,
  } = await import('../../src/v2/domain/webhook-security.ts')
  const { issueWebhookDeliveryLeaseToken } = await import(
    '../../src/v2/domain/webhook-delivery-lease.ts'
  )
  const { PrismaApiClientRepository } = await import(
    '../../src/v2/infrastructure/prisma/api-client-repository.ts'
  )
  const { PrismaWebhookRegistrationRepository } = await import(
    '../../src/v2/infrastructure/prisma/webhook-registration-repository.ts'
  )
  const { PrismaWebhookFanoutRepository } = await import(
    '../../src/v2/infrastructure/prisma/webhook-fanout-repository.ts'
  )
  const { PrismaWebhookDeliveryRepository } = await import(
    '../../src/v2/infrastructure/prisma/webhook-delivery-repository.ts'
  )
  const { PrismaWebhookEventReplayRepository } = await import(
    '../../src/v2/infrastructure/prisma/webhook-event-replay-repository.ts'
  )
  const { PrismaWebhookWorkerShardRepository } = await import(
    '../../src/v2/infrastructure/prisma/webhook-worker-shard-repository.ts'
  )
  const { PrismaWebhookAdministrationQueryRepository } = await import(
    '../../src/v2/infrastructure/prisma/webhook-administration-query-repository.ts'
  )
  const { PrismaWebhookSubscriptionCommandRepository } = await import(
    '../../src/v2/infrastructure/prisma/webhook-subscription-command-repository.ts'
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
  const { createEnvironmentWebhookSigningSecretProvider } = await import(
    '../../src/v2/infrastructure/security/environment-webhook-signing-secret-provider.ts'
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
    await client.v2WebhookWorkerShardLease.deleteMany({
      where: { poolId: 'webhook-integration-pool' },
    })
    await client.v2WebhookReplayReceipt.deleteMany({ where: { workspaceId } })
    await client.v2WebhookVerificationChallenge.deleteMany({ where: { workspaceId } })
    await client.v2WebhookDeliveryAttempt.deleteMany({ where: { workspaceId } })
    await client.v2WebhookDelivery.deleteMany({ where: { workspaceId } })
    await client.v2WebhookSubscription.deleteMany({ where: { workspaceId } })
    await client.v2WebhookSigningSecret.deleteMany({ where: { workspaceId } })
    await client.v2WebhookEndpoint.deleteMany({ where: { workspaceId } })
    await client.v2PublicEventOutbox.deleteMany({ where: { workspaceId } })
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

    let shardClock = new Date('2026-07-14T21:50:01.000Z')
    let shardLeaseId = 620
    const shardCoordinator = coordinateWebhookWorkerShardService({
      repository: new PrismaWebhookWorkerShardRepository(client),
      clock: () => shardClock,
      createId: () =>
        `00000000-0000-4000-8000-${String(shardLeaseId++).padStart(12, '0')}`,
      leaseDurationMs: 30_000,
    })
    const firstShard = await shardCoordinator.claim({
      poolId: 'webhook-integration-pool',
      shardCount: 2,
      leaseOwner: 'webhook-shard-worker-1',
    })
    const secondShard = await shardCoordinator.claim({
      poolId: 'webhook-integration-pool',
      shardCount: 2,
      leaseOwner: 'webhook-shard-worker-2',
    })
    assert.deepEqual([firstShard.shardIndex, secondShard.shardIndex], [0, 1])
    assert.equal(await shardCoordinator.claim({
      poolId: 'webhook-integration-pool',
      shardCount: 2,
      leaseOwner: 'webhook-shard-worker-3',
    }), null)
    await assert.rejects(
      () => shardCoordinator.claim({
        poolId: 'webhook-integration-pool',
        shardCount: 3,
        leaseOwner: 'webhook-shard-worker-incompatible',
      }),
      (error) =>
        error instanceof DomainError && error.code === 'WEBHOOK_SHARD_COORDINATION_REJECTED',
    )
    shardClock = new Date('2026-07-14T21:50:11.000Z')
    assert.equal(await shardCoordinator.heartbeat(firstShard), true)
    assert.equal(await shardCoordinator.heartbeat({
      ...firstShard,
      leaseToken: secondShard.leaseToken,
    }), false)
    shardClock = new Date('2026-07-14T21:50:32.000Z')
    const reclaimedShard = await shardCoordinator.claim({
      poolId: 'webhook-integration-pool',
      shardCount: 2,
      leaseOwner: 'webhook-shard-worker-3',
    })
    assert.equal(reclaimedShard.shardIndex, 1)
    assert.equal(await shardCoordinator.release(secondShard), false)
    assert.equal(await shardCoordinator.release(firstShard), true)
    assert.equal(await shardCoordinator.release(reclaimedShard), true)
    assert.equal(await client.v2WebhookWorkerShardLease.count({
      where: { poolId: 'webhook-integration-pool' },
    }), 0)

    let registrationIndex = 0
    const register = registerWebhookService({
      repository: new PrismaWebhookRegistrationRepository(client),
      clock: () => now,
      createId: (kind) => idSets[registrationIndex][kind],
    })
    const webhookSigningKey = Buffer.alloc(32, 18)
    const request = {
      workspaceId,
      url: 'https://hooks.example.com/apollo',
      eventTypes: ['project.created', 'project.version.created'],
      resourceIds: ['integration-project-1'],
      createdByClientId: clientId,
      secret: {
        keyRef: 'vault://apollo/webhook-integration/key-1',
        fingerprint: createHash('sha256').update(webhookSigningKey).digest('hex'),
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
    assert.deepEqual(
      await security.getPendingTarget(workspaceId, endpoint.id),
      {
        workspaceId,
        endpointId: endpoint.id,
        url: 'https://hooks.example.com/apollo',
      },
    )
    await assert.rejects(
      () => security.getPendingTarget('another-workspace', endpoint.id),
      (error) => error instanceof DomainError && error.code === 'WEBHOOK_CHALLENGE_NOT_FOUND',
    )
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
    await assert.rejects(
      () => security.getPendingTarget(workspaceId, endpoint.id),
      (error) => error instanceof DomainError && error.code === 'WEBHOOK_CHALLENGE_NOT_FOUND',
    )
    assert.equal(
      (await client.v2WebhookSubscription.findUniqueOrThrow({
        where: { id: subscription.id },
      })).status,
      'active',
    )
    const administration = new PrismaWebhookAdministrationQueryRepository(client)
    const endpointPage = await administration.listEndpoints({
      workspaceId, status: 'active', limit: 2,
    })
    assert.equal(endpointPage.length, 1)
    assert.equal(endpointPage[0].endpoint.id, endpoint.id)
    assert.equal(endpointPage[0].currentSecret.version, 1)
    assert.equal('keyRef' in endpointPage[0].currentSecret, false)
    const endpointDetail = await administration.findEndpointById(workspaceId, endpoint.id)
    assert.equal(endpointDetail.signingSecrets.length, 1)
    assert.equal(endpointDetail.signingSecrets[0].fingerprint, request.secret.fingerprint)
    assert.equal(await administration.findEndpointById('another-workspace', endpoint.id), null)
    const subscriptionPage = await administration.listSubscriptions({
      workspaceId, endpointId: endpoint.id, status: 'active', limit: 2,
    })
    assert.equal(subscriptionPage.length, 1)
    assert.deepEqual(subscriptionPage[0].filter.resourceIds, ['integration-project-1'])
    assert.equal(
      await administration.findSubscriptionById('another-workspace', subscription.id),
      null,
    )
    const subscriptionCommands = new PrismaWebhookSubscriptionCommandRepository(client)
    const activeSubscription = await administration.findSubscriptionById(workspaceId, subscription.id)
    const activeRevision = webhookSubscriptionRevision(activeSubscription)
    const subscriptionChangedAt = new Date(activeSubscription.updatedAt)
    const paused = await subscriptionCommands.setStatus({
      workspaceId, subscriptionId: subscription.id, targetStatus: 'paused',
      baseRevision: activeRevision, changedAt: new Date(subscriptionChangedAt.getTime() + 1_000).toISOString(),
    })
    assert.equal(paused.subscription.status, 'paused')
    assert.equal(paused.replayed, false)
    assert.notEqual(paused.revision, activeRevision)
    assert.equal(
      (await client.v2WebhookSubscription.findUniqueOrThrow({ where: { id: subscription.id } })).pausedAt.toISOString(),
      new Date(subscriptionChangedAt.getTime() + 1_000).toISOString(),
    )
    const pausedAgain = await subscriptionCommands.setStatus({
      workspaceId, subscriptionId: subscription.id, targetStatus: 'paused',
      baseRevision: activeRevision, changedAt: new Date(subscriptionChangedAt.getTime() + 1_500).toISOString(),
    })
    assert.equal(pausedAgain.replayed, true)
    assert.equal(pausedAgain.revision, paused.revision)
    await assert.rejects(
      () => subscriptionCommands.setStatus({
        workspaceId, subscriptionId: subscription.id, targetStatus: 'active',
        baseRevision: '0'.repeat(64), changedAt: new Date(subscriptionChangedAt.getTime() + 2_000).toISOString(),
      }),
      (error) => error instanceof DomainError && error.code === 'WEBHOOK_SUBSCRIPTION_REVISION_MISMATCH',
    )
    await client.v2WebhookEndpoint.update({
      where: { id: endpoint.id },
      data: {
        status: 'suspended',
        suspendedAt: new Date(subscriptionChangedAt.getTime() + 1_750),
      },
    })
    await assert.rejects(
      () => subscriptionCommands.setStatus({
        workspaceId, subscriptionId: subscription.id, targetStatus: 'active',
        baseRevision: paused.revision,
        changedAt: new Date(subscriptionChangedAt.getTime() + 2_000).toISOString(),
      }),
      (error) => error instanceof DomainError && error.code === 'WEBHOOK_SUBSCRIPTION_TRANSITION_REJECTED',
    )
    await client.v2WebhookEndpoint.update({
      where: { id: endpoint.id },
      data: { status: 'active', suspendedAt: null },
    })
    const resumed = await subscriptionCommands.setStatus({
      workspaceId, subscriptionId: subscription.id, targetStatus: 'active',
      baseRevision: paused.revision, changedAt: new Date(subscriptionChangedAt.getTime() + 2_000).toISOString(),
    })
    assert.equal(resumed.subscription.status, 'active')
    assert.equal(resumed.subscription.pausedAt, undefined)
    assert.equal(
      await subscriptionCommands.setStatus({
        workspaceId: 'another-workspace', subscriptionId: subscription.id,
        targetStatus: 'paused', baseRevision: resumed.revision,
        changedAt: new Date(subscriptionChangedAt.getTime() + 3_000).toISOString(),
      }),
      null,
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

    const fanoutAt = new Date(now.getTime() + 10_000)
    const eventRows = [
      {
        id: '00000000-0000-4000-8000-000000000301',
        type: 'project.created',
        resourceId: 'integration-project-1',
        occurredAt: now,
      },
      {
        id: '00000000-0000-4000-8000-000000000302',
        type: 'project.created',
        resourceId: 'integration-project-1',
        occurredAt: new Date(now.getTime() + 2_000),
      },
      {
        id: '00000000-0000-4000-8000-000000000303',
        type: 'project.created',
        resourceId: 'another-project',
        occurredAt: new Date(now.getTime() + 3_000),
      },
    ]
    await client.v2PublicEventOutbox.createMany({
      data: eventRows.map((event) => ({
        ...event,
        workspaceId,
        version: '1.0.0',
        actorClientId: clientId,
        resourceType: 'project',
        dataJson: '{}',
        createdAt: fanoutAt,
      })),
    })
    let deliveryId = 401
    let fanoutClock = fanoutAt
    const materialize = materializeNextWebhookEventService({
      repository: new PrismaWebhookFanoutRepository(
        client,
        () => `00000000-0000-4000-8000-${String(deliveryId++).padStart(12, '0')}`,
      ),
      clock: () => fanoutClock,
    })
    const runFanout = () => materialize({ workspaceId })
    const beforeVerification = await runFanout()
    assert.equal(beforeVerification.eventId, eventRows[0].id)
    assert.equal(beforeVerification.matchedSubscriptions, 0)
    const matching = await runFanout()
    assert.equal(matching.eventId, eventRows[1].id)
    assert.equal(matching.matchedSubscriptions, 1)
    assert.equal(matching.deliveries[0].subscriptionId, subscription.id)
    assert.equal(matching.deliveries[0].status, 'pending')
    assert.equal(matching.deliveries[0].maxAttempts, 8)
    const wrongResource = await runFanout()
    assert.equal(wrongResource.eventId, eventRows[2].id)
    assert.equal(wrongResource.matchedSubscriptions, 0)
    assert.deepEqual(await runFanout(), { status: 'idle' })
    assert.equal(await client.v2WebhookDelivery.count({ where: { workspaceId } }), 1)
    assert.equal(
      await client.v2PublicEventOutbox.count({
        where: { workspaceId, publishedAt: { not: null } },
      }),
      3,
    )

    await client.v2PublicEventOutbox.update({
      where: { id: eventRows[1].id },
      data: { publishedAt: null },
    })
    fanoutClock = new Date(fanoutAt.getTime() + 1_000)
    const replayedFanout = await runFanout()
    assert.equal(replayedFanout.eventId, eventRows[1].id)
    assert.equal(replayedFanout.deliveries[0].id, matching.deliveries[0].id)
    assert.equal(await client.v2WebhookDelivery.count({ where: { workspaceId } }), 1)

    const deliveryRepository = new PrismaWebhookDeliveryRepository(client)
    let deliveryClock = new Date(fanoutAt.getTime() + 2_000)
    let leaseByte = 10
    let attemptId = 501
    const claimDelivery = claimNextWebhookDeliveryService({
      repository: deliveryRepository,
      clock: () => deliveryClock,
      leaseDurationMs: 1_000,
      createAttemptId: () =>
        `00000000-0000-4000-8000-${String(attemptId++).padStart(12, '0')}`,
      issueLease: () => issueWebhookDeliveryLeaseToken(() => Buffer.alloc(32, leaseByte++)),
    })
    const heartbeatDelivery = heartbeatWebhookDeliveryService({
      repository: deliveryRepository,
      clock: () => deliveryClock,
      leaseDurationMs: 1_000,
    })
    const settleDelivery = settleWebhookDeliveryService({
      repository: deliveryRepository,
      clock: () => deliveryClock,
    })
    const discoverWorkspaces = discoverRunnableWebhookWorkspacesService({
      repository: deliveryRepository,
      clock: () => deliveryClock,
    })

    const firstClaim = await claimDelivery({ workspaceId, leaseOwner: 'webhook-worker-1' })
    assert.equal(firstClaim.delivery.id, matching.deliveries[0].id)
    assert.equal(firstClaim.delivery.status, 'in-flight')
    assert.equal(firstClaim.attempt.attemptNumber, 1)
    const storedClaim = await client.v2WebhookDelivery.findUniqueOrThrow({
      where: { id: firstClaim.delivery.id },
    })
    assert.match(storedClaim.leaseTokenHash, /^[0-9a-f]{64}$/)
    assert.equal(JSON.stringify(storedClaim).includes(firstClaim.leaseToken), false)

    deliveryClock = new Date(fanoutAt.getTime() + 2_500)
    const wrongLease = issueWebhookDeliveryLeaseToken(() => Buffer.alloc(32, 99)).token
    assert.equal(
      await heartbeatDelivery({
        workspaceId,
        deliveryId: firstClaim.delivery.id,
        leaseOwner: 'webhook-worker-1',
        leaseToken: wrongLease,
        attemptNumber: 1,
      }),
      false,
    )
    assert.equal(
      await heartbeatDelivery({
        workspaceId,
        deliveryId: firstClaim.delivery.id,
        leaseOwner: 'webhook-worker-1',
        leaseToken: firstClaim.leaseToken,
        attemptNumber: 1,
      }),
      true,
    )

    deliveryClock = new Date(fanoutAt.getTime() + 3_600)
    const secondClaim = await claimDelivery({ workspaceId, leaseOwner: 'webhook-worker-2' })
    assert.equal(secondClaim.delivery.id, firstClaim.delivery.id)
    assert.equal(secondClaim.attempt.attemptNumber, 2)
    assert.equal(
      (await client.v2WebhookDeliveryAttempt.findUniqueOrThrow({
        where: {
          deliveryId_attemptNumber: { deliveryId: firstClaim.delivery.id, attemptNumber: 1 },
        },
      })).errorCode,
      'lease_expired',
    )

    deliveryClock = new Date(fanoutAt.getTime() + 3_700)
    assert.equal(
      await settleDelivery({
        workspaceId,
        deliveryId: firstClaim.delivery.id,
        leaseOwner: 'webhook-worker-1',
        leaseToken: firstClaim.leaseToken,
        attemptNumber: 1,
        outcome: { status: 'succeeded', responseStatus: 204 },
      }),
      null,
    )
    const retryAt = new Date(fanoutAt.getTime() + 5_000).toISOString()
    const retried = await settleDelivery({
      workspaceId,
      deliveryId: secondClaim.delivery.id,
      leaseOwner: 'webhook-worker-2',
      leaseToken: secondClaim.leaseToken,
      attemptNumber: 2,
      outcome: { status: 'failed', errorCode: 'http_timeout', nextAttemptAt: retryAt },
    })
    assert.equal(retried.delivery.status, 'retry-scheduled')
    assert.equal(retried.attempt.status, 'failed')
    assert.equal((await claimDelivery({ workspaceId, leaseOwner: 'webhook-worker-3' })), null)
    assert.deepEqual((await discoverWorkspaces()).workspaceIds, [])

    deliveryClock = new Date(retryAt)
    await client.v2Workspace.update({
      where: { id: workspaceId },
      data: { createdAt: new Date(deliveryClock.getTime() + 1) },
    })
    assert.deepEqual((await discoverWorkspaces()).workspaceIds, [])
    await client.v2Workspace.update({
      where: { id: workspaceId },
      data: { createdAt: now },
    })
    assert.deepEqual((await discoverWorkspaces()).workspaceIds, [workspaceId])
    const dispatchDelivery = dispatchWebhookDeliveryService({
      repository: deliveryRepository,
      secrets: createEnvironmentWebhookSigningSecretProvider({
        APOLLO_V2_WEBHOOK_SIGNING_SECRETS_JSON: JSON.stringify([{
          workspaceId,
          endpointId: endpoint.id,
          keyRef: request.secret.keyRef,
          version: 1,
          secretBase64url: webhookSigningKey.toString('base64url'),
        }]),
      }),
      transport: {
        async send(transportRequest) {
          const eventBody = JSON.parse(Buffer.from(transportRequest.rawBody).toString('utf8'))
          assert.equal(eventBody.id, eventRows[1].id)
          assert.equal(eventBody.resource.id, 'integration-project-1')
          assert.equal(verifyWebhookSignature({
            secret: webhookSigningKey,
            rawBody: transportRequest.rawBody,
            headers: transportRequest.headers,
            now: deliveryClock,
          }).eventId, eventRows[1].id)
          return {
            statusCode: 204,
            responseBodyHash: createHash('sha256').update('').digest('hex'),
          }
        },
      },
      clock: () => deliveryClock,
    })
    const runDelivery = runNextWebhookDeliveryService({
      claim: claimDelivery,
      heartbeat: heartbeatDelivery,
      dispatch: dispatchDelivery,
      heartbeatIntervalMs: 100,
    })
    const succeeded = await runDelivery({ workspaceId, leaseOwner: 'webhook-worker-3' })
    assert.equal(succeeded.status, 'succeeded')
    assert.equal(succeeded.deliveryId, firstClaim.delivery.id)
    assert.equal(succeeded.attemptNumber, 3)
    assert.equal('leaseToken' in succeeded, false)
    assert.equal(
      (await client.v2WebhookDeliveryAttempt.findUniqueOrThrow({
        where: {
          deliveryId_attemptNumber: { deliveryId: firstClaim.delivery.id, attemptNumber: 3 },
        },
      })).status,
      'succeeded',
    )
    assert.equal(
      (await client.v2WebhookDelivery.findUniqueOrThrow({ where: { id: firstClaim.delivery.id } }))
        .leaseTokenHash,
      null,
    )
    assert.equal(await client.v2WebhookDeliveryAttempt.count({
      where: { deliveryId: firstClaim.delivery.id },
    }), 3)

    const exhaustedEventId = '00000000-0000-4000-8000-000000000305'
    await client.v2PublicEventOutbox.create({
      data: {
        id: exhaustedEventId,
        workspaceId,
        type: 'project.created',
        version: '1.0.0',
        occurredAt: new Date(fanoutAt.getTime() + 5_200),
        actorClientId: clientId,
        resourceType: 'project',
        resourceId: 'integration-project-1',
        dataJson: '{}',
        createdAt: new Date(fanoutAt.getTime() + 5_200),
      },
    })
    fanoutClock = new Date(fanoutAt.getTime() + 5_300)
    const exhaustedFanout = await materialize({ workspaceId, maxAttempts: 1 })
    deliveryClock = new Date(fanoutAt.getTime() + 5_400)
    const exhaustedClaim = await claimDelivery({ workspaceId, leaseOwner: 'webhook-worker-4' })
    assert.equal(exhaustedClaim.delivery.id, exhaustedFanout.deliveries[0].id)
    assert.equal(exhaustedClaim.delivery.maxAttempts, 1)
    deliveryClock = new Date(fanoutAt.getTime() + 6_500)
    assert.equal(await claimDelivery({ workspaceId, leaseOwner: 'webhook-worker-5' }), null)
    const deadLettered = await client.v2WebhookDelivery.findUniqueOrThrow({
      where: { id: exhaustedClaim.delivery.id },
    })
    assert.equal(deadLettered.status, 'dead-lettered')
    assert.equal(deadLettered.leaseTokenHash, null)
    assert.equal(
      (await client.v2WebhookDeliveryAttempt.findUniqueOrThrow({
        where: {
          deliveryId_attemptNumber: { deliveryId: exhaustedClaim.delivery.id, attemptNumber: 1 },
        },
      })).errorCode,
      'lease_expired',
    )
    const deadLetterPage = await deliveryRepository.list({
      workspaceId,
      status: 'dead-lettered',
      endpointId: endpoint.id,
      eventId: exhaustedEventId,
      limit: 2,
    })
    assert.equal(deadLetterPage.length, 1)
    assert.equal(deadLetterPage[0].delivery.id, exhaustedClaim.delivery.id)
    assert.equal(deadLetterPage[0].endpointId, endpoint.id)
    assert.deepEqual(
      await deliveryRepository.list({ workspaceId: 'another-workspace', limit: 2 }),
      [],
    )
    const deadLetterDiagnostic = await deliveryRepository.findDiagnosticById(
      workspaceId,
      exhaustedClaim.delivery.id,
    )
    assert.equal(deadLetterDiagnostic.delivery.status, 'dead-lettered')
    assert.deepEqual(
      deadLetterDiagnostic.attempts.map((attempt) => attempt.attemptNumber),
      [1],
    )
    assert.equal(deadLetterDiagnostic.attempts[0].errorCode, 'lease_expired')
    assert.equal(
      await deliveryRepository.findDiagnosticById(
        'another-workspace',
        exhaustedClaim.delivery.id,
      ),
      null,
    )
    const replayDelivery = replayWebhookDeliveryService({
      deliveries: deliveryRepository,
      clock: () => new Date(fanoutAt.getTime() + 7_000),
      createId: () => '00000000-0000-4000-8000-000000000612',
    })
    await client.v2WebhookEndpoint.update({
      where: { id: endpoint.id },
      data: {
        status: 'suspended',
        suspendedAt: new Date(fanoutAt.getTime() + 6_900),
      },
    })
    await assert.rejects(
      () => replayDelivery({
        workspaceId,
        clientId,
        deliveryId: exhaustedClaim.delivery.id,
        idempotencyKey: 'webhook-replay-inactive-target',
      }),
      (error) =>
        error instanceof DomainError && error.code === 'WEBHOOK_DELIVERY_REPLAY_REJECTED',
    )
    await client.v2WebhookEndpoint.update({
      where: { id: endpoint.id },
      data: { status: 'active', suspendedAt: null },
    })
    const firstReplay = await replayDelivery({
      workspaceId,
      clientId,
      deliveryId: exhaustedClaim.delivery.id,
      idempotencyKey: 'webhook-replay-integration-1',
    })
    assert.equal(firstReplay.replayed, false)
    assert.equal(firstReplay.diagnostic.delivery.status, 'retry-scheduled')
    assert.equal(firstReplay.diagnostic.delivery.maxAttempts, 2)
    assert.deepEqual(
      firstReplay.diagnostic.attempts.map((attempt) => attempt.attemptNumber),
      [1],
    )
    const idempotentReplay = await replayDelivery({
      workspaceId,
      clientId,
      deliveryId: exhaustedClaim.delivery.id,
      idempotencyKey: 'webhook-replay-integration-1',
    })
    assert.equal(idempotentReplay.replayed, true)
    assert.deepEqual(idempotentReplay.diagnostic, firstReplay.diagnostic)
    await assert.rejects(
      () => replayDelivery({
        workspaceId,
        clientId,
        deliveryId: firstClaim.delivery.id,
        idempotencyKey: 'webhook-replay-integration-1',
      }),
      (error) =>
        error instanceof DomainError && error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
    )
    await assert.rejects(
      () => replayDelivery({
        workspaceId,
        clientId,
        deliveryId: exhaustedClaim.delivery.id,
        idempotencyKey: 'webhook-replay-integration-2',
      }),
      (error) =>
        error instanceof DomainError && error.code === 'WEBHOOK_DELIVERY_REPLAY_REJECTED',
    )
    assert.equal(
      await client.v2IdempotencyRecord.count({
        where: { workspaceId, clientId, key: { startsWith: 'webhook-replay-integration-' } },
      }),
      1,
    )

    const pausedReplaySubscriptionId = '00000000-0000-4000-8000-000000000614'
    const activeReplaySubscriptionId = '00000000-0000-4000-8000-000000000615'
    await client.v2WebhookSubscription.createMany({
      data: [
        {
          id: pausedReplaySubscriptionId,
          workspaceId,
          endpointId: endpoint.id,
          status: 'paused',
          filterEventTypesJson: '["project.created"]',
          filterHash: '1'.repeat(64),
          createdByClientId: clientId,
          createdAt: fanoutAt,
          pausedAt: fanoutAt,
        },
        {
          id: activeReplaySubscriptionId,
          workspaceId,
          endpointId: endpoint.id,
          status: 'active',
          filterEventTypesJson: '["project.created"]',
          filterHash: '2'.repeat(64),
          createdByClientId: clientId,
          createdAt: fanoutAt,
        },
      ],
    })
    const skippedReplayDeliveryIds = [
      '00000000-0000-4000-8000-000000000616',
      '00000000-0000-4000-8000-000000000617',
    ]
    await client.v2WebhookDelivery.createMany({
      data: [
        {
          id: skippedReplayDeliveryIds[0],
          workspaceId,
          subscriptionId: pausedReplaySubscriptionId,
          eventId: firstClaim.delivery.eventId,
          status: 'succeeded',
          attemptCount: 1,
          maxAttempts: 8,
          nextAttemptAt: fanoutAt,
          createdAt: fanoutAt,
          completedAt: new Date(fanoutAt.getTime() + 1),
        },
        {
          id: skippedReplayDeliveryIds[1],
          workspaceId,
          subscriptionId: activeReplaySubscriptionId,
          eventId: firstClaim.delivery.eventId,
          status: 'pending',
          attemptCount: 0,
          maxAttempts: 8,
          nextAttemptAt: fanoutAt,
          createdAt: fanoutAt,
        },
      ],
    })
    const replayEvent = replayWebhookEventService({
      replays: new PrismaWebhookEventReplayRepository(client),
      clock: () => new Date(fanoutAt.getTime() + 7_100),
      createId: () => '00000000-0000-4000-8000-000000000613',
    })
    const firstEventReplay = await replayEvent({
      workspaceId,
      clientId,
      eventId: firstClaim.delivery.eventId,
      idempotencyKey: 'webhook-event-replay-integration-1',
    })
    assert.equal(firstEventReplay.replayed, false)
    assert.deepEqual(
      firstEventReplay.items.map((item) => item.status),
      ['scheduled', 'skipped-target-inactive', 'skipped-non-terminal'],
    )
    assert.equal(firstEventReplay.items[0].delivery.delivery.status, 'retry-scheduled')
    assert.equal(firstEventReplay.items[0].delivery.delivery.attemptCount, 3)
    const repeatedEventReplay = await replayEvent({
      workspaceId,
      clientId,
      eventId: firstClaim.delivery.eventId,
      idempotencyKey: 'webhook-event-replay-integration-1',
    })
    assert.equal(repeatedEventReplay.replayed, true)
    assert.deepEqual(repeatedEventReplay.items, firstEventReplay.items)
    await assert.rejects(
      () => replayEvent({
        workspaceId,
        clientId,
        eventId: exhaustedEventId,
        idempotencyKey: 'webhook-event-replay-integration-1',
      }),
      (error) =>
        error instanceof DomainError && error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
    )
    await assert.rejects(
      () => replayEvent({
        workspaceId,
        clientId,
        eventId: firstClaim.delivery.eventId,
        idempotencyKey: 'webhook-event-replay-integration-2',
      }),
      (error) => error instanceof DomainError && error.code === 'WEBHOOK_EVENT_REPLAY_REJECTED',
    )
    await assert.rejects(
      () => replayEvent({
        workspaceId,
        clientId,
        eventId: '00000000-0000-4000-8000-000000000699',
        idempotencyKey: 'webhook-event-replay-missing',
      }),
      (error) => error instanceof DomainError && error.code === 'WEBHOOK_EVENT_NOT_FOUND',
    )
    assert.equal(
      await client.v2IdempotencyRecord.count({
        where: { workspaceId, clientId, key: { startsWith: 'webhook-event-replay-' } },
      }),
      1,
    )
    await client.v2WebhookDelivery.deleteMany({
      where: { id: { in: skippedReplayDeliveryIds } },
    })
    await client.v2WebhookSubscription.deleteMany({
      where: { id: { in: [pausedReplaySubscriptionId, activeReplaySubscriptionId] } },
    })

    const corruptedEventId = '00000000-0000-4000-8000-000000000304'
    await client.$transaction([
      client.v2WebhookSubscription.update({
        where: { id: subscription.id },
        data: { filterHash: 'f'.repeat(64) },
      }),
      client.v2PublicEventOutbox.create({
        data: {
          id: corruptedEventId,
          workspaceId,
          type: 'project.created',
          version: '1.0.0',
          occurredAt: new Date(now.getTime() + 4_000),
          actorClientId: clientId,
          resourceType: 'project',
          resourceId: 'integration-project-1',
          dataJson: '{}',
          createdAt: fanoutAt,
        },
      }),
    ])
    await assert.rejects(
      () => runFanout(),
      (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
    )
    assert.equal(
      (await client.v2PublicEventOutbox.findUniqueOrThrow({
        where: { id: corruptedEventId },
      })).publishedAt,
      null,
    )
    assert.equal(await client.v2WebhookDelivery.count({ where: { workspaceId } }), 2)
    assert.deepEqual(
      await materialize({ workspaceId: 'another-workspace' }),
      { status: 'idle' },
    )

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
