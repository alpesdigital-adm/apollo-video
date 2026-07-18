import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { registerWebhookService } from '../../src/v2/application/register-webhook.ts'
import { createWebhookEndpointService } from '../../src/v2/application/create-webhook-endpoint.ts'
import { createWebhookSubscriptionService } from '../../src/v2/application/create-webhook-subscription.ts'
import { provisionWebhookSigningSecretService } from '../../src/v2/application/provision-webhook-signing-secret.ts'
import { stageWebhookSigningSecretRotationService } from '../../src/v2/application/stage-webhook-signing-secret-rotation.ts'
import { activateWebhookSigningSecretRotationService } from '../../src/v2/application/activate-webhook-signing-secret-rotation.ts'
import { cancelWebhookSigningSecretRotationService } from '../../src/v2/application/cancel-webhook-signing-secret-rotation.ts'
import { runWebhookSigningSecretHygieneService } from '../../src/v2/application/run-webhook-signing-secret-hygiene.ts'
import {
  activateWebhookEndpointConvergentlyService,
  activateWebhookEndpointService,
} from '../../src/v2/application/secure-webhook.ts'
import { materializeNextWebhookEventService } from '../../src/v2/application/materialize-webhook-deliveries.ts'
import {
  claimNextWebhookDeliveryService,
  heartbeatWebhookDeliveryService,
  settleWebhookDeliveryService,
} from '../../src/v2/application/manage-webhook-delivery.ts'
import {
  calculateWebhookRetryAt,
  classifyWebhookResponse,
  dispatchWebhookDeliveryService,
} from '../../src/v2/application/dispatch-webhook-delivery.ts'
import {
  runCoordinatedWebhookDeliveryWorkerLoop,
  runNextWebhookDeliveryService,
  runDiscoveredWebhookDeliveryWorkerLoop,
  runWebhookDeliveryWorkerLoop,
} from '../../src/v2/application/run-webhook-delivery-worker.ts'
import { coordinateWebhookWorkerShardService } from '../../src/v2/application/coordinate-webhook-worker-shard.ts'
import {
  discoverRunnableWebhookWorkspacesService,
  webhookWorkspaceShard,
} from '../../src/v2/application/discover-webhook-workspaces.ts'
import { listWebhookDeliveriesService } from '../../src/v2/application/list-webhook-deliveries.ts'
import { readWebhookDeliveryService } from '../../src/v2/application/read-webhook-delivery.ts'
import {
  listWebhookEndpointsService,
  listWebhookSigningSecretRotationsService,
  listWebhookSubscriptionsService,
} from '../../src/v2/application/list-webhook-administration.ts'
import {
  readWebhookEndpointService,
  readWebhookSigningSecretRotationService,
  readWebhookSubscriptionService,
} from '../../src/v2/application/read-webhook-administration.ts'
import { replayWebhookDeliveryService } from '../../src/v2/application/replay-webhook-delivery.ts'
import { replayWebhookEventService } from '../../src/v2/application/replay-webhook-event.ts'
import { setWebhookSubscriptionStatusService } from '../../src/v2/application/set-webhook-subscription-status.ts'
import { setWebhookEndpointStatusService } from '../../src/v2/application/set-webhook-endpoint-status.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import {
  createWebhookDelivery,
  createWebhookDeliveryAttempt,
  createWebhookEndpoint,
  createWebhookEventFilter,
  createWebhookSigningSecret,
  createWebhookSubscription,
  normalizeWebhookUrl,
  replayWebhookDelivery,
  transitionWebhookEndpoint,
  transitionWebhookSubscription,
  webhookEndpointRevision,
  webhookSubscriptionRevision,
  webhookEventMatchesFilter,
} from '../../src/v2/domain/webhook.ts'
import {
  createWebhookVerificationChallenge,
  hashWebhookChallengeToken,
  issueWebhookChallengeToken,
  signWebhookPayload,
  verifyWebhookSignature,
} from '../../src/v2/domain/webhook-security.ts'
import {
  isPublicWebhookAddress,
  validateWebhookResolution,
} from '../../src/v2/domain/webhook-network.ts'
import {
  hashWebhookDeliveryLeaseToken,
  issueWebhookDeliveryLeaseToken,
} from '../../src/v2/domain/webhook-delivery-lease.ts'
import {
  createPinnedWebhookRequestOptions,
  SafeWebhookChallengeTransport,
} from '../../src/v2/infrastructure/webhook/safe-webhook-challenge-transport.ts'
import { SafeWebhookDeliveryTransport } from '../../src/v2/infrastructure/webhook/safe-webhook-delivery-transport.ts'
import { PrismaWebhookSigningSecretProvider } from '../../src/v2/infrastructure/prisma/webhook-signing-secret-provider.ts'
import { PrismaWebhookEndpointCreationRepository } from '../../src/v2/infrastructure/prisma/webhook-endpoint-creation-repository.ts'
import { PrismaWebhookSubscriptionCreationRepository } from '../../src/v2/infrastructure/prisma/webhook-subscription-creation-repository.ts'
import { PrismaWebhookSigningSecretProvisioningRepository } from '../../src/v2/infrastructure/prisma/webhook-signing-secret-provisioning-repository.ts'
import { PrismaWebhookDeliveryRepository } from '../../src/v2/infrastructure/prisma/webhook-delivery-repository.ts'
import { PrismaWebhookEventReplayRepository } from '../../src/v2/infrastructure/prisma/webhook-event-replay-repository.ts'
import { PrismaWebhookEndpointCommandRepository } from '../../src/v2/infrastructure/prisma/webhook-endpoint-command-repository.ts'
import { PrismaWebhookSubscriptionCommandRepository } from '../../src/v2/infrastructure/prisma/webhook-subscription-command-repository.ts'
import { PrismaWebhookSecurityRepository } from '../../src/v2/infrastructure/prisma/webhook-security-repository.ts'
import { createAesRecipeParameterCipher } from '../../src/v2/infrastructure/security/recipe-parameter-cipher.ts'
import {
  createWebhookSigningSecretProtector,
  webhookSigningSecretCipherContext,
} from '../../src/v2/infrastructure/security/webhook-signing-secret-protector.ts'

test('webhook endpoint creation generates only encrypted signing material and canonical intent', async () => {
  const rawSecret = Buffer.alloc(32, 17)
  const expectedFingerprint = createHash('sha256').update(rawSecret).digest('hex')
  const cipher = createAesRecipeParameterCipher({ keyId: 'webhook-test-key', key: Buffer.alloc(32, 8) })
  const protector = createWebhookSigningSecretProtector(cipher, () => rawSecret)
  const ids = {
    'webhook-endpoint': '00000000-0000-4000-8000-000000000123',
    'webhook-secret': '00000000-0000-4000-8000-000000000124',
    'idempotency-record': 'idempotency-webhook-endpoint-1',
  }
  let captured
  const create = createWebhookEndpointService({
    repository: {
      async createOrReplay(bundle) {
        captured = bundle
        return { endpoint: bundle.endpoint, secret: bundle.secret, replayed: false }
      },
    },
    secrets: protector,
    clock: () => new Date('2026-07-15T20:00:00.000Z'),
    createId: (kind) => ids[kind],
  })
  const result = await create({
    workspaceId: 'workspace-1',
    url: 'HTTPS://Hooks.Example.com:443/apollo',
    createdByClientId: 'client-1',
    idempotencyKey: 'endpoint-request-1',
  })

  assert.equal(result.endpoint.url, 'https://hooks.example.com/apollo')
  assert.equal(result.endpoint.status, 'pending-verification')
  assert.equal(result.secret.fingerprint, expectedFingerprint)
  assert.equal(rawSecret.every((value) => value === 0), true)
  assert.equal(JSON.stringify(captured).includes(Buffer.alloc(32, 17).toString('base64url')), false)
  const opened = await cipher.open(
    {
      algorithm: captured.secretPayload.algorithm,
      keyId: captured.secretPayload.keyId,
      nonce: captured.secretPayload.nonce,
      ciphertext: captured.secretPayload.ciphertext,
      authTag: captured.secretPayload.authTag,
    },
    webhookSigningSecretCipherContext({
      secretId: captured.secret.id,
      workspaceId: captured.endpoint.workspaceId,
      endpointId: captured.endpoint.id,
      version: captured.secret.version,
      keyRef: captured.secret.keyRef,
    }),
  )
  assert.equal(createHash('sha256').update(Buffer.from(opened, 'base64url')).digest('hex'), expectedFingerprint)
  assert.match(captured.idempotency.requestFingerprint, /^[a-f0-9]{64}$/)
})

test('webhook endpoint creation rejects idempotency misuse before generating a secret', async () => {
  let generated = 0
  const create = createWebhookEndpointService({
    repository: { async createOrReplay() { throw new Error('must not persist') } },
    secrets: { async protect() { generated += 1; throw new Error('must not generate') } },
    clock: () => new Date('2026-07-15T20:00:00.000Z'),
    createId: () => '00000000-0000-4000-8000-000000000125',
  })
  await assert.rejects(
    () => create({
      workspaceId: 'workspace-1',
      url: 'https://hooks.example.com/apollo',
      createdByClientId: 'client-1',
      idempotencyKey: 'invalid key',
    }),
    (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT',
  )
  assert.equal(generated, 0)
})

test('webhook endpoint creation retries serialization conflicts before failing explicitly', async () => {
  const cipher = createAesRecipeParameterCipher({
    keyId: 'webhook-retry-test-key',
    key: Buffer.alloc(32, 6),
  })
  const protector = createWebhookSigningSecretProtector(cipher, () => Buffer.alloc(32, 19))
  const ids = {
    'webhook-endpoint': '00000000-0000-4000-8000-000000000126',
    'webhook-secret': '00000000-0000-4000-8000-000000000127',
    'idempotency-record': 'idempotency-webhook-endpoint-retry-1',
  }
  let bundle
  const create = createWebhookEndpointService({
    repository: {
      async createOrReplay(value) {
        bundle = value
        return { endpoint: value.endpoint, secret: value.secret, replayed: false }
      },
    },
    secrets: protector,
    clock: () => new Date('2026-07-15T20:01:00.000Z'),
    createId: (kind) => ids[kind],
  })
  await create({
    workspaceId: 'workspace-1',
    url: 'https://retry-hooks.example.com/apollo',
    createdByClientId: 'client-1',
    idempotencyKey: 'endpoint-retry-request-1',
  })
  let attempts = 0
  const repository = new PrismaWebhookEndpointCreationRepository({
    async $transaction() {
      attempts += 1
      const error = new Error('serialization conflict')
      error.code = 'P2034'
      throw error
    },
  })

  await assert.rejects(
    () => repository.createOrReplay(bundle),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
  assert.equal(attempts, 3)
})

test('pending endpoint provisions a signing secret once and redacts idempotent replay', async () => {
  const endpoint = createWebhookEndpoint({
    id: '00000000-0000-4000-8000-000000000130',
    workspaceId: 'workspace-1',
    url: 'https://hooks.example.com/apollo',
    status: 'pending-verification',
    createdByClientId: 'client-1',
    createdAt: '2026-07-15T22:00:00.000Z',
  })
  const rawSecrets = []
  const cipher = createAesRecipeParameterCipher({
    keyId: 'webhook-provision-key',
    key: Buffer.alloc(32, 23),
  })
  const protector = createWebhookSigningSecretProtector(cipher, () => {
    const secret = Buffer.alloc(32, 24 + rawSecrets.length)
    rawSecrets.push(secret)
    return secret
  })
  let persisted
  let writes = 0
  let id = 131
  const provision = provisionWebhookSigningSecretService({
    repository: {
      async getTarget() { return { endpoint, latestSecretVersion: 1 } },
      async provisionOrReplay(command) {
        writes += 1
        if (!persisted) {
          persisted = command
          return { endpoint: { ...endpoint, updatedAt: command.secret.createdAt }, secret: command.secret, replayed: false }
        }
        return {
          endpoint: { ...endpoint, updatedAt: persisted.secret.createdAt },
          secret: persisted.secret,
          replayed: true,
        }
      },
    },
    secrets: protector,
    clock: () => new Date('2026-07-15T22:01:00.000Z'),
    createId: () => `00000000-0000-4000-8000-${String(id++).padStart(12, '0')}`,
  })
  const request = {
    workspaceId: 'workspace-1',
    endpointId: endpoint.id,
    actorClientId: 'client-1',
    baseRevision: webhookEndpointRevision(endpoint),
    idempotencyKey: 'provision-secret-1',
  }
  const first = await provision(request)
  const replay = await provision(request)

  assert.equal(first.secret.version, 2)
  assert.equal(first.secretAvailable, true)
  assert.equal(first.secretBase64url, Buffer.alloc(32, 24).toString('base64url'))
  assert.equal(first.replayed, false)
  assert.equal(rawSecrets.every((secret) => secret.every((value) => value === 0)), true)
  assert.equal(JSON.stringify(persisted).includes(first.secretBase64url), false)
  assert.equal(replay.replayed, true)
  assert.equal(replay.secretAvailable, false)
  assert.equal('secretBase64url' in replay, false)
  assert.equal(replay.secret.id, first.secret.id)
  assert.equal(writes, 2)
})

test('signing secret provisioning rejects invalid revision before secret generation', async () => {
  let effects = 0
  const provision = provisionWebhookSigningSecretService({
    repository: {
      async getTarget() { effects += 1; return null },
      async provisionOrReplay() { effects += 1 },
    },
    secrets: {
      async protect() { effects += 1 },
      async protectForOneTimeDisclosure() { effects += 1 },
    },
    clock: () => new Date('2026-07-15T22:01:00.000Z'),
    createId: () => '00000000-0000-4000-8000-000000000135',
  })
  await assert.rejects(
    () => provision({
      workspaceId: 'workspace-1',
      endpointId: '00000000-0000-4000-8000-000000000130',
      actorClientId: 'client-1',
      baseRevision: 'invalid',
      idempotencyKey: 'provision-secret-1',
    }),
    (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT',
  )
  assert.equal(effects, 0)
})

test('active endpoint stages a signing secret rotation without changing the active secret', async () => {
  const endpoint = createWebhookEndpoint({
    id: '00000000-0000-4000-8000-000000000140', workspaceId: 'workspace-1',
    url: 'https://hooks.example.com/apollo', status: 'active', createdByClientId: 'client-1',
    createdAt: '2026-07-15T22:00:00.000Z', verifiedAt: '2026-07-15T22:01:00.000Z',
  })
  const activeSecret = createWebhookSigningSecret({
    id: '00000000-0000-4000-8000-000000000141', workspaceId: 'workspace-1', endpointId: endpoint.id,
    version: 1, keyRef: 'vault://apollo/webhooks/active', fingerprint: 'a'.repeat(64),
    status: 'active', createdAt: '2026-07-15T22:00:00.000Z',
  })
  const rawSecrets = []
  const protector = createWebhookSigningSecretProtector(
    createAesRecipeParameterCipher({ keyId: 'webhook-rotation-key', key: Buffer.alloc(32, 31) }),
    () => { const value = Buffer.alloc(32, 32 + rawSecrets.length); rawSecrets.push(value); return value },
  )
  let persisted
  let id = 142
  const stage = stageWebhookSigningSecretRotationService({
    repository: {
      async getTarget() { return { endpoint, activeSecret, latestSecretVersion: 1 } },
      async stageOrReplay(command) {
        if (!persisted) { persisted = command; return { endpoint, rotation: command.rotation, replayed: false } }
        return { endpoint, rotation: persisted.rotation, replayed: true }
      },
    },
    secrets: protector,
    clock: () => new Date('2026-07-15T22:02:00.000Z'),
    createId: () => `00000000-0000-4000-8000-${String(id++).padStart(12, '0')}`,
  })
  const request = {
    workspaceId: 'workspace-1', endpointId: endpoint.id, actorClientId: 'client-1',
    baseRevision: webhookEndpointRevision(endpoint), overlapSeconds: 300,
    idempotencyKey: 'rotate-secret-1',
  }
  const first = await stage(request)
  const replay = await stage(request)

  assert.equal(first.rotation.status, 'staged')
  assert.equal(first.rotation.previousSecretId, activeSecret.id)
  assert.equal(first.rotation.candidateVersion, 2)
  assert.equal(first.rotation.overlapSeconds, 300)
  assert.equal(first.secretAvailable, true)
  assert.equal(first.secretBase64url, Buffer.alloc(32, 32).toString('base64url'))
  assert.equal(JSON.stringify(persisted).includes(first.secretBase64url), false)
  assert.equal(rawSecrets.every((value) => value.every((byte) => byte === 0)), true)
  assert.equal(replay.secretAvailable, false)
  assert.equal('secretBase64url' in replay, false)
  assert.equal(replay.rotation.id, first.rotation.id)
  assert.equal(activeSecret.status, 'active')
})

test('signing secret rotation validates overlap before reading or generating material', async () => {
  let effects = 0
  const stage = stageWebhookSigningSecretRotationService({
    repository: { async getTarget() { effects += 1 }, async stageOrReplay() { effects += 1 } },
    secrets: { async protect() { effects += 1 }, async protectForOneTimeDisclosure() { effects += 1 } },
    clock: () => new Date('2026-07-15T22:02:00.000Z'),
    createId: () => '00000000-0000-4000-8000-000000000149',
  })
  await assert.rejects(() => stage({
    workspaceId: 'workspace-1', endpointId: '00000000-0000-4000-8000-000000000140',
    actorClientId: 'client-1', baseRevision: 'b'.repeat(64), overlapSeconds: 0,
    idempotencyKey: 'rotate-secret-1',
  }), (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT')
  assert.equal(effects, 0)
})

test('signing secret rotation rejects inactive endpoint before generating material', async () => {
  const endpoint = createWebhookEndpoint({
    id: '00000000-0000-4000-8000-000000000150', workspaceId: 'workspace-1',
    url: 'https://hooks.example.com/apollo', status: 'suspended', createdByClientId: 'client-1',
    createdAt: '2026-07-15T22:00:00.000Z', verifiedAt: '2026-07-15T22:01:00.000Z',
    suspendedAt: '2026-07-15T22:02:00.000Z',
  })
  const activeSecret = createWebhookSigningSecret({
    id: '00000000-0000-4000-8000-000000000151', workspaceId: 'workspace-1', endpointId: endpoint.id,
    version: 1, keyRef: 'vault://apollo/webhooks/active', fingerprint: 'a'.repeat(64),
    status: 'active', createdAt: '2026-07-15T22:00:00.000Z',
  })
  let generated = 0
  const stage = stageWebhookSigningSecretRotationService({
    repository: {
      async getTarget() { return { endpoint, activeSecret, latestSecretVersion: 1 } },
      async stageOrReplay() { throw new Error('must not persist') },
    },
    secrets: {
      async protect() { generated += 1 },
      async protectForOneTimeDisclosure() { generated += 1 },
    },
    clock: () => new Date('2026-07-15T22:03:00.000Z'),
    createId: () => '00000000-0000-4000-8000-000000000152',
  })
  await assert.rejects(() => stage({
    workspaceId: 'workspace-1', endpointId: endpoint.id, actorClientId: 'client-1',
    baseRevision: webhookEndpointRevision(endpoint), overlapSeconds: 300,
    idempotencyKey: 'rotate-secret-inactive',
  }), (error) => error instanceof DomainError && error.code === 'WEBHOOK_ENDPOINT_TRANSITION_REJECTED')
  assert.equal(generated, 0)
})

test('signing secret rotation rejects a candidate equal to the active key', async () => {
  const endpoint = createWebhookEndpoint({
    id: '00000000-0000-4000-8000-000000000170', workspaceId: 'workspace-1',
    url: 'https://hooks.example.com/apollo', status: 'active', createdByClientId: 'client-1',
    createdAt: '2026-07-15T22:00:00.000Z', verifiedAt: '2026-07-15T22:01:00.000Z',
  })
  const duplicate = Buffer.alloc(32, 45)
  const activeSecret = createWebhookSigningSecret({
    id: '00000000-0000-4000-8000-000000000171', workspaceId: 'workspace-1', endpointId: endpoint.id,
    version: 1, keyRef: 'vault://apollo/webhooks/active',
    fingerprint: createHash('sha256').update(duplicate).digest('hex'),
    status: 'active', createdAt: '2026-07-15T22:00:00.000Z',
  })
  let persisted = false
  const stage = stageWebhookSigningSecretRotationService({
    repository: {
      async getTarget() { return { endpoint, activeSecret, latestSecretVersion: 1 } },
      async stageOrReplay() { persisted = true },
    },
    secrets: createWebhookSigningSecretProtector(
      createAesRecipeParameterCipher({ keyId: 'webhook-duplicate-key', key: Buffer.alloc(32, 46) }),
      () => duplicate,
    ),
    clock: () => new Date('2026-07-15T22:02:00.000Z'),
    createId: () => '00000000-0000-4000-8000-000000000172',
  })
  await assert.rejects(() => stage({
    workspaceId: 'workspace-1', endpointId: endpoint.id, actorClientId: 'client-1',
    baseRevision: webhookEndpointRevision(endpoint), overlapSeconds: 300,
    idempotencyKey: 'rotate-duplicate-secret',
  }), (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT')
  assert.equal(persisted, false)
  assert.equal(duplicate.every((value) => value === 0), true)
})

test('signing secret rotation activation validates identity before persistence', async () => {
  let effects = 0
  const activate = activateWebhookSigningSecretRotationService({
    repository: {
      async getTarget() { effects += 1 },
      async stageOrReplay() { effects += 1 },
      async activateOrReplay() { effects += 1 },
    },
    clock: () => new Date('2026-07-15T22:10:00.000Z'),
  })
  await assert.rejects(() => activate({
    workspaceId: 'workspace-1',
    endpointId: '00000000-0000-4000-8000-000000000150',
    rotationId: 'invalid',
    actorClientId: 'client-1',
    baseRevision: 'a'.repeat(64),
  }), (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT')
  assert.equal(effects, 0)
})

test('signing secret rotation cancellation validates revision before persistence', async () => {
  let effects = 0
  const cancel = cancelWebhookSigningSecretRotationService({
    repository: {
      async getTarget() { effects += 1 },
      async stageOrReplay() { effects += 1 },
      async activateOrReplay() { effects += 1 },
      async cancelOrReplay() { effects += 1 },
    },
    clock: () => new Date('2026-07-15T22:11:00.000Z'),
  })
  await assert.rejects(() => cancel({
    workspaceId: 'workspace-1',
    endpointId: '00000000-0000-4000-8000-000000000150',
    rotationId: '00000000-0000-4000-8000-000000000152',
    actorClientId: 'client-1',
    baseRevision: 'invalid',
  }), (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT')
  assert.equal(effects, 0)
})

test('retired signing secret opens only during overlap and cannot fall back after expiry', async () => {
  const secretId = '00000000-0000-4000-8000-000000000160'
  const endpointId = '00000000-0000-4000-8000-000000000161'
  const keyRef = `vault://apollo/webhooks/${secretId}`
  const cipher = createAesRecipeParameterCipher({ keyId: 'webhook-overlap-key', key: Buffer.alloc(32, 43) })
  const material = await createWebhookSigningSecretProtector(
    cipher,
    () => Buffer.alloc(32, 44),
  ).protectForOneTimeDisclosure({
    secretId, workspaceId: 'workspace-1', endpointId, version: 1, keyRef,
    createdAt: '2026-07-15T22:00:00.000Z',
  })
  const row = {
    id: secretId, workspaceId: 'workspace-1', endpointId, version: 1,
    algorithm: 'hmac-sha256', keyRef, fingerprint: material.fingerprint,
    status: 'retired', createdAt: new Date('2026-07-15T22:00:00.000Z'),
    retiredAt: new Date('2026-07-15T22:05:00.000Z'),
    usableUntil: new Date('2026-07-15T22:10:00.000Z'), revokedAt: null,
    payload: {
      ...material.payload,
      createdAt: new Date(material.payload.createdAt),
    },
  }
  let now = new Date('2026-07-15T22:09:59.999Z')
  const database = new PrismaWebhookSigningSecretProvider(
    cipher,
    { v2WebhookSigningSecret: { async findFirst() { return row } } },
    () => now,
  )
  const opened = await database.open({ workspaceId: 'workspace-1', endpointId, keyRef, version: 1 })
  assert.equal(Buffer.from(opened).toString('base64url'), material.secretBase64url)
  opened.fill(0)
  now = new Date('2026-07-15T22:10:00.000Z')
  await assert.rejects(
    () => database.open({ workspaceId: 'workspace-1', endpointId, keyRef, version: 1 }),
    (error) => error instanceof DomainError && error.code === 'WEBHOOK_SECRET_UNAVAILABLE',
  )
})

test('generated webhook signing secret must contain exactly 256 bits', async () => {
  const invalidSecret = Buffer.alloc(31, 9)
  const protector = createWebhookSigningSecretProtector(
    createAesRecipeParameterCipher({
      keyId: 'webhook-size-key',
      key: Buffer.alloc(32, 10),
    }),
    () => invalidSecret,
  )
  await assert.rejects(
    () => protector.protectForOneTimeDisclosure({
      secretId: '00000000-0000-4000-8000-000000000136',
      workspaceId: 'workspace-1',
      endpointId: '00000000-0000-4000-8000-000000000137',
      version: 2,
      keyRef: 'vault://apollo/webhooks/00000000-0000-4000-8000-000000000136',
      createdAt: '2026-07-15T22:01:00.000Z',
    }),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
  assert.equal(invalidSecret.every((value) => value === 0), true)
})

test('webhook subscription creation canonicalizes filters and persists idempotency intent', async () => {
  const ids = {
    'webhook-subscription': '00000000-0000-4000-8000-000000000120',
    'idempotency-record': 'idempotency-webhook-120',
  }
  let captured
  const create = createWebhookSubscriptionService({
    repository: {
      async createOrReplay(bundle) {
        captured = bundle
        return { subscription: bundle.subscription, replayed: false }
      },
    },
    clock: () => new Date('2026-07-15T13:00:00.000Z'),
    createId: (kind) => ids[kind],
  })
  const result = await create({
    workspaceId: 'workspace-1',
    endpointId: '00000000-0000-4000-8000-000000000121',
    eventTypes: ['project.version.created', 'project.created'],
    resourceIds: ['project-2', 'project-1'],
    createdByClientId: 'client-1',
    idempotencyKey: 'subscription-request-1',
  })

  assert.deepEqual(result.subscription.filter.eventTypes, ['project.created', 'project.version.created'])
  assert.deepEqual(result.subscription.filter.resourceIds, ['project-1', 'project-2'])
  assert.equal(captured.idempotency.requestedAt, '2026-07-15T13:00:00.000Z')
  assert.equal(captured.idempotency.expiresAt, '2026-07-16T13:00:00.000Z')
  assert.match(captured.idempotency.requestFingerprint, /^[a-f0-9]{64}$/)
})

test('webhook subscription creation rejects unusable idempotency keys before persistence', async () => {
  let writes = 0
  const create = createWebhookSubscriptionService({
    repository: { async createOrReplay() { writes += 1 } },
    clock: () => new Date('2026-07-15T13:00:00.000Z'),
    createId: () => '00000000-0000-4000-8000-000000000122',
  })
  await assert.rejects(
    () => create({
      workspaceId: 'workspace-1',
      endpointId: '00000000-0000-4000-8000-000000000121',
      eventTypes: ['project.created'],
      createdByClientId: 'client-1',
      idempotencyKey: 'contains whitespace',
    }),
    (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT',
  )
  assert.equal(writes, 0)
})

test('webhook subscription creation retries serialization conflicts before failing explicitly', async () => {
  const retryIds = {
    'webhook-subscription': '00000000-0000-4000-8000-000000000128',
    'idempotency-record': 'idempotency-webhook-subscription-retry-1',
  }
  let bundle
  const create = createWebhookSubscriptionService({
    repository: {
      async createOrReplay(value) {
        bundle = value
        return { subscription: value.subscription, replayed: false }
      },
    },
    clock: () => new Date('2026-07-15T13:01:00.000Z'),
    createId: (kind) => retryIds[kind],
  })
  await create({
    workspaceId: 'workspace-1',
    endpointId: '00000000-0000-4000-8000-000000000129',
    eventTypes: ['project.created'],
    createdByClientId: 'client-1',
    idempotencyKey: 'subscription-retry-request-1',
  })
  let attempts = 0
  const repository = new PrismaWebhookSubscriptionCreationRepository({
    async $transaction() {
      attempts += 1
      const error = new Error('serialization conflict')
      error.code = 'P2034'
      throw error
    },
  })

  await assert.rejects(
    () => repository.createOrReplay(bundle),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
  assert.equal(attempts, 3)
})

test('webhook signing secret provisioning retries serialization conflicts', async () => {
  let attempts = 0
  const repository = new PrismaWebhookSigningSecretProvisioningRepository({
    v2IdempotencyRecord: { async findUnique() { return null } },
    async $transaction() {
      attempts += 1
      const error = new Error('serialization conflict')
      error.code = 'P2034'
      throw error
    },
  })
  await assert.rejects(
    () => repository.provisionOrReplay({
      workspaceId: 'workspace-1',
      endpointId: '00000000-0000-4000-8000-000000000130',
      actorClientId: 'client-1',
      idempotency: {
        id: 'idempotency-provision-retry-1', key: 'provision-retry-1',
        requestFingerprint: 'a'.repeat(64), requestedAt: '2026-07-16T21:00:00.000Z',
        expiresAt: '2026-07-17T21:00:00.000Z',
      },
    }),
    (error) =>
      error instanceof DomainError && error.code === 'WEBHOOK_ENDPOINT_REVISION_MISMATCH',
  )
  assert.equal(attempts, 3)
})

test('webhook signing secret provisioning recovers a concurrent committed winner', async () => {
  const endpointId = '00000000-0000-4000-8000-000000000131'
  const secretId = '00000000-0000-4000-8000-000000000132'
  const requestFingerprint = 'b'.repeat(64)
  let attempts = 0
  const repository = new PrismaWebhookSigningSecretProvisioningRepository({
    v2IdempotencyRecord: {
      async findUnique() {
        return {
          status: 'completed', requestFingerprint,
          responseJson: JSON.stringify({ endpointId, secretId }),
          expiresAt: new Date('2026-07-17T21:00:00.000Z'),
        }
      },
    },
    v2WebhookEndpoint: {
      async findFirst() {
        return {
          id: endpointId, workspaceId: 'workspace-1', url: 'https://hooks.example.com/apollo',
          status: 'pending-verification', createdByClientId: 'client-1',
          createdAt: new Date('2026-07-16T20:00:00.000Z'),
          updatedAt: new Date('2026-07-16T21:00:00.000Z'),
          verifiedAt: null, suspendedAt: null, revokedAt: null,
        }
      },
    },
    v2WebhookSigningSecret: {
      async findFirst() {
        return {
          id: secretId, workspaceId: 'workspace-1', endpointId, version: 2,
          algorithm: 'hmac-sha256', keyRef: 'vault://winner', fingerprint: 'c'.repeat(64),
          status: 'active', createdAt: new Date('2026-07-16T21:00:00.000Z'),
          retiredAt: null, revokedAt: null,
        }
      },
    },
    async $transaction() {
      attempts += 1
      const error = new Error('serialization conflict')
      error.code = 'P2034'
      throw error
    },
  })
  const result = await repository.provisionOrReplay({
    workspaceId: 'workspace-1', endpointId, actorClientId: 'client-1',
    idempotency: {
      id: 'idempotency-provision-winner-1', key: 'provision-winner-1',
      requestFingerprint, requestedAt: '2026-07-16T21:00:00.000Z',
      expiresAt: '2026-07-17T21:00:00.000Z',
    },
  })
  assert.equal(result.replayed, true)
  assert.equal(result.endpoint.id, endpointId)
  assert.equal(result.secret.id, secretId)
  assert.equal(attempts, 1)
})

const ids = {
  'webhook-endpoint': '00000000-0000-4000-8000-000000000101',
  'webhook-secret': '00000000-0000-4000-8000-000000000102',
  'webhook-subscription': '00000000-0000-4000-8000-000000000103',
}

test('webhook registration normalizes a pending endpoint, opaque secret and exact filter', async () => {
  let persisted
  const register = registerWebhookService({
    repository: {
      async register(bundle) {
        persisted = bundle
        return bundle
      },
    },
    clock: () => new Date('2026-07-14T21:45:00.000Z'),
    createId: (kind) => ids[kind],
  })

  const result = await register({
    workspaceId: 'workspace-1',
    url: ' HTTPS://Hooks.Example.COM:443/apollo ',
    eventTypes: ['project.version.created', 'project.created'],
    resourceIds: ['project-2', 'project-1'],
    createdByClientId: 'client-1',
    secret: {
      keyRef: 'vault://apollo/workspaces/workspace-1/webhooks/key-1',
      fingerprint: 'a'.repeat(64),
    },
  })

  assert.equal(result.endpoint.url, 'https://hooks.example.com/apollo')
  assert.equal(result.endpoint.status, 'pending-verification')
  assert.equal(result.secret.algorithm, 'hmac-sha256')
  assert.equal(result.secret.keyRef.includes('secret-value'), false)
  assert.equal(result.subscription.status, 'pending-verification')
  assert.deepEqual(result.subscription.filter.eventTypes, [
    'project.created',
    'project.version.created',
  ])
  assert.deepEqual(result.subscription.filter.resourceIds, ['project-1', 'project-2'])
  assert.match(result.subscription.filter.hash, /^[0-9a-f]{64}$/)
  assert.equal(persisted, result)
  assert.ok(Object.isFrozen(result.endpoint))
  assert.ok(Object.isFrozen(result.subscription.filter.eventTypes))
})

test('webhook models reject unsafe targets, ambiguous filters and secret material', () => {
  for (const url of [
    'http://hooks.example.com/apollo',
    'https://localhost/apollo',
    'https://127.0.0.1/apollo',
    'https://[::1]/apollo',
    'https://intranet/apollo',
    'https://hooks.example.com:8443/apollo',
    'https://user:pass@hooks.example.com/apollo',
    'https://hooks.example.com/apollo?token=private',
  ]) {
    assert.throws(
      () => normalizeWebhookUrl(url),
      (error) => error instanceof DomainError && error.code === 'INVALID_WEBHOOK',
    )
  }
  for (const filter of [
    { eventTypes: [] },
    { eventTypes: ['project.created', 'project.created'] },
    { eventTypes: ['project.unknown'] },
    { eventTypes: ['project.created'], resourceIds: [] },
  ]) {
    assert.throws(
      () => createWebhookEventFilter(filter),
      (error) => error instanceof DomainError && error.code === 'INVALID_WEBHOOK',
    )
  }
  assert.throws(
    () => createWebhookSigningSecret({
      id: ids['webhook-secret'],
      workspaceId: 'workspace-1',
      endpointId: ids['webhook-endpoint'],
      version: 1,
      keyRef: 'raw-secret-value',
      fingerprint: 'a'.repeat(64),
      status: 'active',
      createdAt: '2026-07-14T21:45:00.000Z',
    }),
    (error) => error instanceof DomainError && error.code === 'INVALID_WEBHOOK',
  )
  assert.throws(
    () => createWebhookEndpoint({
      id: ids['webhook-endpoint'],
      workspaceId: 'workspace-1',
      url: 'https://hooks.example.com/apollo',
      status: 'active',
      createdByClientId: 'client-1',
      createdAt: '2026-07-14T21:45:00.000Z',
    }),
    (error) => error instanceof DomainError && error.code === 'INVALID_WEBHOOK',
  )
})

test('delivery and attempt identities are bounded before any network execution', () => {
  const delivery = createWebhookDelivery({
    id: '00000000-0000-4000-8000-000000000104',
    workspaceId: 'workspace-1',
    subscriptionId: ids['webhook-subscription'],
    eventId: '00000000-0000-4000-8000-000000000105',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 8,
    nextAttemptAt: '2026-07-14T21:45:01.000Z',
    createdAt: '2026-07-14T21:45:00.000Z',
  })
  const attempt = createWebhookDeliveryAttempt({
    id: '00000000-0000-4000-8000-000000000106',
    workspaceId: delivery.workspaceId,
    deliveryId: delivery.id,
    attemptNumber: 1,
    status: 'scheduled',
    scheduledAt: delivery.nextAttemptAt,
    createdAt: delivery.createdAt,
  })

  assert.equal(delivery.status, 'pending')
  assert.equal(attempt.status, 'scheduled')
  assert.ok(Object.isFrozen(delivery))
  assert.throws(
    () => createWebhookDelivery({ ...delivery, attemptCount: 9 }),
    (error) => error instanceof DomainError && error.code === 'INVALID_WEBHOOK',
  )
  assert.throws(
    () => createWebhookDelivery({ ...delivery, status: 'succeeded' }),
    (error) => error instanceof DomainError && error.code === 'INVALID_WEBHOOK',
  )
  assert.throws(
    () => createWebhookDeliveryAttempt({ ...attempt, status: 'failed' }),
    (error) => error instanceof DomainError && error.code === 'INVALID_WEBHOOK',
  )
  assert.throws(
    () => createWebhookDelivery({ ...delivery, attemptCount: 1 }),
    (error) => error instanceof DomainError && error.code === 'INVALID_WEBHOOK',
  )
  assert.throws(
    () => createWebhookDeliveryAttempt({
      ...attempt,
      status: 'in-flight',
      startedAt: '2026-07-14T21:44:59.000Z',
    }),
    (error) => error instanceof DomainError && error.code === 'INVALID_WEBHOOK',
  )
})

test('delivery claim exposes one-shot token while heartbeat and settlement pass only its hash', async () => {
  const issued = issueWebhookDeliveryLeaseToken(() => Buffer.alloc(32, 7))
  assert.match(issued.token, /^whl_[A-Za-z0-9_-]{43}$/)
  assert.equal(hashWebhookDeliveryLeaseToken(issued.token), issued.tokenHash)
  assert.throws(
    () => hashWebhookDeliveryLeaseToken('predictable'),
    (error) => error instanceof DomainError && error.code === 'WEBHOOK_LEASE_REJECTED',
  )

  const commands = []
  const claimed = {
    delivery: { id: 'delivery' },
    attempt: { attemptNumber: 1 },
    lease: { owner: 'worker-1', attemptNumber: 1 },
  }
  const repository = {
    async claimNext(command) {
      commands.push(command)
      return claimed
    },
    async heartbeat(command) {
      commands.push(command)
      return true
    },
    async succeed(command) {
      commands.push(command)
      return claimed
    },
    async failOrRetry() {
      throw new Error('not expected')
    },
  }
  const clock = () => new Date('2026-07-14T23:30:00.000Z')
  const claim = claimNextWebhookDeliveryService({
    repository,
    clock,
    leaseDurationMs: 1_000,
    createAttemptId: () => '00000000-0000-4000-8000-000000000901',
    issueLease: () => issued,
  })
  const result = await claim({ workspaceId: 'workspace-1', leaseOwner: 'worker-1' })
  assert.equal(result.leaseToken, issued.token)
  assert.equal(commands[0].leaseTokenHash, issued.tokenHash)
  assert.equal(JSON.stringify(commands[0]).includes(issued.token), false)

  const heartbeat = heartbeatWebhookDeliveryService({
    repository,
    clock,
    leaseDurationMs: 1_000,
  })
  assert.equal(await heartbeat({
    workspaceId: 'workspace-1',
    deliveryId: '00000000-0000-4000-8000-000000000902',
    leaseOwner: 'worker-1',
    leaseToken: issued.token,
    attemptNumber: 1,
  }), true)
  assert.equal(commands[1].leaseTokenHash, issued.tokenHash)

  const settle = settleWebhookDeliveryService({ repository, clock })
  await settle({
    workspaceId: 'workspace-1',
    deliveryId: '00000000-0000-4000-8000-000000000902',
    leaseOwner: 'worker-1',
    leaseToken: issued.token,
    attemptNumber: 1,
    outcome: { status: 'succeeded', responseStatus: 204 },
  })
  assert.equal(commands[2].leaseTokenHash, issued.tokenHash)
  assert.equal(JSON.stringify(commands.slice(1)).includes(issued.token), false)
})

test('delivery transport pins DNS and preserves exact signed bytes and headers', async () => {
  const secret = Buffer.alloc(32, 12)
  const eventId = '00000000-0000-4000-8000-000000000903'
  const rawBody = Buffer.from('{"exact":"bytes"}', 'utf8')
  const headers = signWebhookPayload({
    secret,
    eventId,
    rawBody,
    timestamp: new Date('2026-07-14T23:40:00.000Z'),
  })
  let pinnedRequest
  const transport = new SafeWebhookDeliveryTransport({
    resolver: {
      async resolve(hostname) {
        assert.equal(hostname, 'hooks.example.com')
        return [{ address: '8.8.8.8', family: 4 }]
      },
    },
    client: {
      async post(request) {
        pinnedRequest = request
        assert.deepEqual(request.body, rawBody)
        return { statusCode: 429, body: Buffer.from('retry later', 'utf8') }
      },
    },
  })
  const result = await transport.send({
    url: 'https://hooks.example.com/apollo',
    eventId,
    rawBody,
    headers,
  })
  assert.equal(result.statusCode, 429)
  assert.equal(
    result.responseBodyHash,
    createHash('sha256').update('retry later', 'utf8').digest('hex'),
  )
  const options = createPinnedWebhookRequestOptions(pinnedRequest)
  assert.equal(options.headers['apollo-webhook-id'], eventId)
  assert.equal(options.headers['apollo-webhook-signature'], headers['apollo-webhook-signature'])
  assert.equal(options.headers['user-agent'], 'Apollo-Video-Webhook/1.0')
  assert.equal(options.hostname, 'hooks.example.com')
  assert.equal(options.lookup('ignored', {}, () => {}), undefined)
  await assert.rejects(
    () => transport.send({
      url: 'https://hooks.example.com/apollo',
      eventId: '00000000-0000-4000-8000-000000000999',
      rawBody,
      headers,
    }),
    (error) =>
      error instanceof DomainError && error.code === 'WEBHOOK_DELIVERY_TRANSPORT_FAILED',
  )

  let connections = 0
  const privateTransport = new SafeWebhookDeliveryTransport({
    resolver: { async resolve() { return [{ address: '127.0.0.1', family: 4 }] } },
    client: { async post() { connections += 1; throw new Error('must not connect') } },
  })
  await assert.rejects(
    () => privateTransport.send({
      url: 'https://hooks.example.com/apollo',
      eventId,
      rawBody,
      headers,
    }),
    (error) => error instanceof DomainError && error.code === 'WEBHOOK_NETWORK_REJECTED',
  )
  assert.equal(connections, 0)
})

test('dispatcher opens matching secret only in memory and settles signed success through fence', async () => {
  const secret = Buffer.alloc(32, 13)
  const lease = issueWebhookDeliveryLeaseToken(() => Buffer.alloc(32, 14))
  const eventId = '00000000-0000-4000-8000-000000000904'
  const deliveryId = '00000000-0000-4000-8000-000000000905'
  const rawBody = Buffer.from('{"id":"event"}', 'utf8')
  const commands = []
  let openedSecret
  let transported = 0
  const repository = {
    async getDispatchTarget(fence) {
      commands.push(fence)
      return { status: 'ready', target: {
          workspaceId: 'workspace-1',
          deliveryId,
          eventId,
          endpointId: ids['webhook-endpoint'],
          url: 'https://hooks.example.com/apollo',
          secretKeyRef: 'vault://apollo/workspaces/workspace-1/webhooks/key-1',
          secretVersion: 1,
          secretFingerprint: createHash('sha256').update(secret).digest('hex'),
          rawBody,
        } }
    },
    async succeed(command) {
      commands.push(command)
      return {
        delivery: { status: 'succeeded' },
        attempt: { status: 'succeeded' },
      }
    },
    async failOrRetry() { throw new Error('not expected') },
  }
  const dispatch = dispatchWebhookDeliveryService({
    repository,
    secrets: {
      async open(request) {
        assert.equal(request.keyRef, 'vault://apollo/workspaces/workspace-1/webhooks/key-1')
        openedSecret = Uint8Array.from(secret)
        return openedSecret
      },
    },
    transport: {
      async send(request) {
        transported += 1
        assert.deepEqual(request.rawBody, rawBody)
        assert.equal(verifyWebhookSignature({
          secret,
          rawBody,
          headers: request.headers,
          now: new Date('2026-07-14T23:40:00.000Z'),
        }).eventId, eventId)
        return {
          statusCode: 204,
          responseBodyHash: createHash('sha256').update('').digest('hex'),
        }
      },
    },
    clock: () => new Date('2026-07-14T23:40:00.000Z'),
  })
  const result = await dispatch({
    workspaceId: 'workspace-1',
    deliveryId,
    leaseOwner: 'worker-1',
    leaseToken: lease.token,
    attemptNumber: 1,
  })
  assert.equal(result.status, 'succeeded')
  assert.equal(transported, 1)
  assert.equal(commands[0].leaseTokenHash, lease.tokenHash)
  assert.equal(commands[1].leaseTokenHash, lease.tokenHash)
  assert.equal(JSON.stringify(commands).includes(lease.token), false)
  assert.equal(secret.equals(Buffer.alloc(32, 13)), true)
  assert.deepEqual(openedSecret, new Uint8Array(32))
})

test('dispatcher retries transient failures deterministically and dead-letters key mismatch', async () => {
  const secret = Buffer.alloc(32, 15)
  const lease = issueWebhookDeliveryLeaseToken(() => Buffer.alloc(32, 16))
  const deliveryId = '00000000-0000-4000-8000-000000000906'
  const now = new Date('2026-07-14T23:40:00.000Z')
  assert.deepEqual(classifyWebhookResponse(429), {
    succeeded: false,
    retryable: true,
    errorCode: 'http_429',
  })
  assert.deepEqual(classifyWebhookResponse(404), {
    succeeded: false,
    retryable: false,
    errorCode: 'http_404',
  })
  assert.equal(
    calculateWebhookRetryAt({ deliveryId, attemptNumber: 2, now }),
    calculateWebhookRetryAt({ deliveryId, attemptNumber: 2, now }),
  )

  let failureCommand
  let transports = 0
  let targetFingerprint = 'a'.repeat(64)
  const repository = {
    async getDispatchTarget() {
      return { status: 'ready', target: {
          workspaceId: 'workspace-1',
          deliveryId,
          eventId: '00000000-0000-4000-8000-000000000907',
          endpointId: ids['webhook-endpoint'],
          url: 'https://hooks.example.com/apollo',
          secretKeyRef: 'vault://apollo/workspaces/workspace-1/webhooks/key-1',
          secretVersion: 1,
          secretFingerprint: targetFingerprint,
          rawBody: Buffer.from('{}'),
        } }
    },
    async succeed() { throw new Error('not expected') },
    async failOrRetry(command) {
      failureCommand = command
      return {
        delivery: { status: command.nextAttemptAt ? 'retry-scheduled' : 'dead-lettered' },
        attempt: { status: 'failed' },
      }
    },
  }
  const dispatch = dispatchWebhookDeliveryService({
    repository,
    secrets: { async open() { return Uint8Array.from(secret) } },
    transport: { async send() { transports += 1; throw new Error('offline') } },
    clock: () => now,
  })
  const result = await dispatch({
    workspaceId: 'workspace-1',
    deliveryId,
    leaseOwner: 'worker-1',
    leaseToken: lease.token,
    attemptNumber: 1,
  })
  assert.equal(result.status, 'dead-lettered')
  assert.equal(failureCommand.errorCode, 'signing_key_mismatch')
  assert.equal(failureCommand.nextAttemptAt, undefined)
  assert.equal(transports, 0)

  targetFingerprint = createHash('sha256').update(secret).digest('hex')
  const retried = await dispatch({
    workspaceId: 'workspace-1',
    deliveryId,
    leaseOwner: 'worker-1',
    leaseToken: lease.token,
    attemptNumber: 1,
  })
  assert.equal(retried.status, 'retry-scheduled')
  assert.equal(failureCommand.errorCode, 'network_error')
  assert.ok(new Date(failureCommand.nextAttemptAt) > now)
  assert.equal(transports, 1)
})

test('dispatcher closes an inactive target without opening secret or network', async () => {
  const lease = issueWebhookDeliveryLeaseToken(() => Buffer.alloc(32, 17))
  let secretReads = 0
  let transports = 0
  let settled
  const dispatch = dispatchWebhookDeliveryService({
    repository: {
      async getDispatchTarget() {
        return { status: 'blocked', errorCode: 'target_inactive' }
      },
      async succeed() { throw new Error('not expected') },
      async failOrRetry(command) {
        settled = command
        return {
          delivery: { status: 'dead-lettered' },
          attempt: { status: 'failed' },
        }
      },
    },
    secrets: { async open() { secretReads += 1; return Buffer.alloc(32) } },
    transport: { async send() { transports += 1; throw new Error('not expected') } },
    clock: () => new Date('2026-07-14T23:40:00.000Z'),
  })
  const result = await dispatch({
    workspaceId: 'workspace-1',
    deliveryId: '00000000-0000-4000-8000-000000000908',
    leaseOwner: 'worker-1',
    leaseToken: lease.token,
    attemptNumber: 1,
  })
  assert.equal(result.status, 'dead-lettered')
  assert.equal(settled.errorCode, 'target_inactive')
  assert.equal(settled.nextAttemptAt, undefined)
  assert.equal(secretReads, 0)
  assert.equal(transports, 0)
})

test('delivery runner keeps heartbeat during dispatch and reports terminal outcome', async () => {
  const commands = []
  const runNext = runNextWebhookDeliveryService({
    claim: async () => ({
      delivery: { id: '00000000-0000-4000-8000-000000000909' },
      attempt: { attemptNumber: 2 },
      leaseToken: issueWebhookDeliveryLeaseToken(() => Buffer.alloc(32, 19)).token,
    }),
    heartbeat: async (command) => {
      commands.push({ kind: 'heartbeat', command })
      return true
    },
    dispatch: async (command) => {
      commands.push({ kind: 'dispatch', command })
      await new Promise((resolve) => setTimeout(resolve, 140))
      return { status: 'succeeded' }
    },
    heartbeatIntervalMs: 100,
  })
  const outcome = await runNext({ workspaceId: 'workspace-1', leaseOwner: 'worker-1' })
  assert.deepEqual(outcome, {
    workspaceId: 'workspace-1',
    deliveryId: '00000000-0000-4000-8000-000000000909',
    attemptNumber: 2,
    status: 'succeeded',
  })
  assert.equal(commands.filter((entry) => entry.kind === 'heartbeat').length, 1)
  assert.equal(commands.filter((entry) => entry.kind === 'dispatch').length, 1)
})

test('delivery runner converts stale settlement and failed heartbeat into lease-lost', async () => {
  let heartbeats = 0
  const runNext = runNextWebhookDeliveryService({
    claim: async () => ({
      delivery: { id: '00000000-0000-4000-8000-000000000910' },
      attempt: { attemptNumber: 1 },
      leaseToken: issueWebhookDeliveryLeaseToken(() => Buffer.alloc(32, 20)).token,
    }),
    heartbeat: async () => {
      heartbeats += 1
      return false
    },
    dispatch: async () => {
      await new Promise((resolve) => setTimeout(resolve, 140))
      return { status: 'stale' }
    },
    heartbeatIntervalMs: 100,
  })
  assert.equal(
    (await runNext({ workspaceId: 'workspace-1', leaseOwner: 'worker-1' })).status,
    'lease-lost',
  )
  assert.equal(heartbeats, 1)
})

test('delivery worker loop isolates workspace errors and stops gracefully without secrets', async () => {
  const controller = new AbortController()
  const iterations = []
  const errors = []
  const outcomes = []
  await runWebhookDeliveryWorkerLoop({
    workspaceIds: ['workspace-1', 'workspace-2'],
    leaseOwner: 'worker-1',
    signal: controller.signal,
    runNext: async ({ workspaceId }) => {
      iterations.push(workspaceId)
      if (workspaceId === 'workspace-1') throw new Error('tenant-local failure')
      return {
        workspaceId,
        deliveryId: '00000000-0000-4000-8000-000000000911',
        attemptNumber: 1,
        status: 'retry-scheduled',
      }
    },
    onIterationError: (event) => errors.push(event),
    onOutcome: (outcome) => {
      outcomes.push(outcome)
      controller.abort()
    },
  })
  assert.deepEqual(iterations, ['workspace-1', 'workspace-2'])
  assert.deepEqual(errors, [{ workspaceId: 'workspace-1' }])
  assert.equal(outcomes[0].status, 'retry-scheduled')
  assert.equal(JSON.stringify({ errors, outcomes }).includes('leaseToken'), false)

  await assert.rejects(
    () => runWebhookDeliveryWorkerLoop({
      workspaceIds: ['workspace-1', 'workspace-1'],
      leaseOwner: 'worker-1',
      signal: new AbortController().signal,
      runNext: async () => null,
    }),
    (error) => error instanceof DomainError && error.code === 'INVALID_WEBHOOK',
  )
})

test('workspace discovery keeps a stable snapshot and deterministic shard across pages', async () => {
  const workspaceIds = [
    'workspace-1',
    'workspace-2',
    'workspace-3',
    'workspace-4',
    'workspace-5',
  ]
  const queries = []
  let clockReads = 0
  const discover = discoverRunnableWebhookWorkspacesService({
    repository: {
      async listRunnableWorkspaceIds(query) {
        queries.push(query)
        const start = query.afterWorkspaceId
          ? workspaceIds.findIndex((id) => id > query.afterWorkspaceId)
          : 0
        return start < 0 ? [] : workspaceIds.slice(start, start + query.limit)
      },
    },
    clock: () => {
      clockReads += 1
      return new Date('2026-07-15T00:30:00.000Z')
    },
  })
  const discovered = []
  let cursor
  do {
    const page = await discover({
      shardIndex: 1,
      shardCount: 2,
      scanLimit: 2,
      ...(cursor ? { cursor } : {}),
    })
    discovered.push(...page.workspaceIds)
    cursor = page.nextCursor
  } while (cursor)
  assert.deepEqual(
    discovered,
    workspaceIds.filter((workspaceId) => webhookWorkspaceShard(workspaceId, 2) === 1),
  )
  assert.equal(clockReads, 1)
  assert.equal(new Set(queries.map((query) => query.asOf)).size, 1)
  assert.deepEqual(queries.map((query) => query.afterWorkspaceId), [undefined, 'workspace-2', 'workspace-4'])

  const first = await discover({ shardIndex: 0, shardCount: 2, scanLimit: 2 })
  await assert.rejects(
    () => discover({ shardIndex: 1, shardCount: 2, scanLimit: 2, cursor: first.nextCursor }),
    (error) => error instanceof DomainError && error.code === 'INVALID_WEBHOOK',
  )
})

test('discovered worker traverses every page and stops after current workspace', async () => {
  const controller = new AbortController()
  const discoveryRequests = []
  const runs = []
  await runDiscoveredWebhookDeliveryWorkerLoop({
    shardIndex: 0,
    shardCount: 1,
    leaseOwner: 'worker-1',
    signal: controller.signal,
    discover: async (request) => {
      discoveryRequests.push(request)
      return request.cursor
        ? { workspaceIds: ['workspace-1', 'workspace-2'] }
        : { workspaceIds: ['workspace-1'], nextCursor: 'cursor-page-2' }
    },
    runNext: async ({ workspaceId }) => {
      runs.push(workspaceId)
      if (runs.length === 2) controller.abort()
      return {
        workspaceId,
        deliveryId: `00000000-0000-4000-8000-000000000${runs.length === 1 ? '912' : '913'}`,
        attemptNumber: 1,
        status: 'succeeded',
      }
    },
  })
  assert.deepEqual(runs, ['workspace-1', 'workspace-2'])
  assert.deepEqual(discoveryRequests.map((request) => request.cursor), [undefined, 'cursor-page-2'])

  const repeatedCursorController = new AbortController()
  let repeatedCursorRequests = 0
  let discoveryErrors = 0
  await runDiscoveredWebhookDeliveryWorkerLoop({
    shardIndex: 0,
    shardCount: 1,
    leaseOwner: 'worker-1',
    signal: repeatedCursorController.signal,
    discover: async () => {
      repeatedCursorRequests += 1
      return { workspaceIds: [], nextCursor: 'repeated-cursor' }
    },
    runNext: async () => null,
    onDiscoveryError: () => {
      discoveryErrors += 1
    },
    wait: async () => {
      repeatedCursorController.abort()
    },
  })
  assert.equal(repeatedCursorRequests, 2)
  assert.equal(discoveryErrors, 1)
})

test('worker shard coordinator keeps the raw lease token outside persistence fences', async () => {
  let now = new Date('2026-07-15T10:40:00.000Z')
  let claimCommand
  let heartbeatCommand
  let releaseCommand
  const issued = issueWebhookDeliveryLeaseToken(() => Buffer.alloc(32, 31))
  const coordinator = coordinateWebhookWorkerShardService({
    repository: {
      async claim(command) {
        claimCommand = command
        return {
          id: command.id,
          poolId: command.poolId,
          shardIndex: 1,
          shardCount: command.shardCount,
          leaseOwner: command.leaseOwner,
          leaseTokenHash: command.leaseTokenHash,
          heartbeatAt: command.now,
          leaseExpiresAt: command.leaseUntil,
          createdAt: command.now,
        }
      },
      async heartbeat(command) {
        heartbeatCommand = command
        return true
      },
      async release(command) {
        releaseCommand = command
        return true
      },
    },
    clock: () => now,
    createId: () => '00000000-0000-4000-8000-000000000918',
    issueLease: () => issued,
    leaseDurationMs: 30_000,
  })
  const lease = await coordinator.claim({
    poolId: 'webhook-delivery',
    shardCount: 2,
    leaseOwner: 'webhook-worker-1',
  })
  assert.equal(lease.shardIndex, 1)
  assert.equal(lease.leaseToken, issued.token)
  assert.equal('leaseToken' in claimCommand, false)
  assert.equal(claimCommand.leaseTokenHash, issued.tokenHash)
  now = new Date('2026-07-15T10:40:10.000Z')
  assert.equal(await coordinator.heartbeat(lease), true)
  assert.equal(heartbeatCommand.leaseTokenHash, issued.tokenHash)
  assert.equal(await coordinator.release(lease), true)
  assert.equal(releaseCommand.leaseTokenHash, issued.tokenHash)
  assert.equal(JSON.stringify({ claimCommand, heartbeatCommand, releaseCommand }).includes(issued.token), false)
})

test('coordinated worker runs only its leased shard and releases it on shutdown', async () => {
  const controller = new AbortController()
  const events = []
  const lease = { shardIndex: 1, shardCount: 3 }
  await runCoordinatedWebhookDeliveryWorkerLoop({
    signal: controller.signal,
    claimShard: async () => {
      events.push('claim')
      return lease
    },
    heartbeatShard: async () => {
      events.push('heartbeat')
      return true
    },
    releaseShard: async (released) => {
      events.push(`release:${released.shardIndex}/${released.shardCount}`)
      return true
    },
    runAssignedShard: async (assignment) => {
      events.push(`run:${assignment.shardIndex}/${assignment.shardCount}`)
      controller.abort()
      assert.equal(assignment.signal.aborted, true)
    },
  })
  assert.deepEqual(events, ['claim', 'run:1/3', 'release:1/3'])
})

test('webhook endpoint administration paginates with filter-bound cursors and scoped reads', async () => {
  const makeEndpoint = (id, createdAt) => ({
    endpoint: createWebhookEndpoint({
      id, workspaceId: 'workspace-1', url: 'https://hooks.example.com/private-path',
      status: 'active', createdByClientId: 'client-1', createdAt, verifiedAt: createdAt,
    }),
    currentSecret: { version: 1, fingerprint: 'a'.repeat(64), status: 'active', createdAt },
  })
  const records = [
    makeEndpoint('00000000-0000-4000-8000-000000000921', '2026-07-15T11:20:01.000Z'),
    makeEndpoint('00000000-0000-4000-8000-000000000920', '2026-07-15T11:20:00.000Z'),
  ]
  const repository = {
    async listEndpoints() { return records },
    async findEndpointById(workspaceId, endpointId) {
      return workspaceId === 'workspace-1' && endpointId === records[0].endpoint.id
        ? { ...records[0], signingSecrets: [records[0].currentSecret] }
        : null
    },
  }
  const list = listWebhookEndpointsService({ repository })
  const first = await list({ workspaceId: 'workspace-1', limit: 1, status: 'active' })
  assert.equal(first.endpoints.length, 1)
  assert.equal(typeof first.nextCursor, 'string')
  await assert.rejects(
    () => list({ workspaceId: 'workspace-1', limit: 1, status: 'revoked', after: first.nextCursor }),
    (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT',
  )
  const read = readWebhookEndpointService({ repository })
  assert.equal((await read({ workspaceId: 'workspace-1', endpointId: records[0].endpoint.id })).endpoint.id, records[0].endpoint.id)
  await assert.rejects(
    () => read({ workspaceId: 'workspace-2', endpointId: records[0].endpoint.id }),
    (error) => error instanceof DomainError && error.code === 'WEBHOOK_ENDPOINT_NOT_FOUND',
  )
})

test('signing secret hygiene is workspace-scoped, bounded and clock-stable', async () => {
  let command
  const run = runWebhookSigningSecretHygieneService({
    repository: {
      async run(value) {
        command = value
        return {
          asOf: value.asOf, expiredRotations: 1, destroyedRotationEnvelopes: 1,
          destroyedSigningSecretPayloads: 2, hasMore: false,
        }
      },
    },
    clock: () => new Date('2026-07-15T12:00:00.000Z'),
  })
  const result = await run({ workspaceId: ' workspace-1 ', limitPerKind: 25 })
  assert.equal(command.workspaceId, 'workspace-1')
  assert.equal(command.asOf, '2026-07-15T12:00:00.000Z')
  assert.equal(command.limitPerKind, 25)
  assert.equal(result.destroyedSigningSecretPayloads, 2)
  await assert.rejects(
    () => run({ workspaceId: 'workspace-1', limitPerKind: 101 }),
    (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT',
  )
})

test('webhook signing secret rotation administration is endpoint-scoped and cursor-bound', async () => {
  const endpointId = '00000000-0000-4000-8000-000000000931'
  const rotations = [
    {
      id: '00000000-0000-4000-8000-000000000933', endpointId,
      candidateVersion: 3, fingerprint: 'c'.repeat(64), status: 'cancelled',
      overlapSeconds: 300, baseRevision: 'b'.repeat(64),
      createdAt: '2026-07-15T11:30:01.000Z', expiresAt: '2026-07-16T11:30:01.000Z',
      cancelledAt: '2026-07-15T11:31:01.000Z',
    },
    {
      id: '00000000-0000-4000-8000-000000000932', endpointId,
      candidateVersion: 2, fingerprint: 'a'.repeat(64), status: 'activated',
      overlapSeconds: 300, baseRevision: 'd'.repeat(64),
      createdAt: '2026-07-15T11:30:00.000Z', expiresAt: '2026-07-16T11:30:00.000Z',
      activatedAt: '2026-07-15T11:30:30.000Z', overlapUntil: '2026-07-15T11:35:30.000Z',
    },
  ]
  let query
  const repository = {
    async listSigningSecretRotations(value) { query = value; return rotations },
    async findSigningSecretRotationById(workspaceId, requestedEndpointId, rotationId) {
      return workspaceId === 'workspace-1' && requestedEndpointId === endpointId
        ? rotations.find((rotation) => rotation.id === rotationId) ?? null
        : null
    },
  }
  const list = listWebhookSigningSecretRotationsService({ repository })
  const first = await list({ workspaceId: 'workspace-1', endpointId, limit: 1, status: 'cancelled' })
  assert.equal(first.rotations.length, 1)
  assert.equal(query.endpointId, endpointId)
  assert.equal(typeof first.nextCursor, 'string')
  await assert.rejects(
    () => list({ workspaceId: 'workspace-1', endpointId, limit: 1, status: 'activated', after: first.nextCursor }),
    (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT',
  )
  const read = readWebhookSigningSecretRotationService({ repository })
  assert.equal((await read({ workspaceId: 'workspace-1', endpointId, rotationId: rotations[0].id })).status, 'cancelled')
  await assert.rejects(
    () => read({ workspaceId: 'workspace-2', endpointId, rotationId: rotations[0].id }),
    (error) => error instanceof DomainError && error.code === 'WEBHOOK_SIGNING_SECRET_ROTATION_NOT_FOUND',
  )
})

test('webhook endpoint lifecycle is revisioned, reversible only from suspension and terminal after revoke', () => {
  const active = createWebhookEndpoint({
    id: '00000000-0000-4000-8000-000000000925', workspaceId: 'workspace-1',
    url: 'https://hooks.example.com/lifecycle', status: 'active',
    createdByClientId: 'client-1', createdAt: '2026-07-15T11:24:00.000Z',
    verifiedAt: '2026-07-15T11:24:00.000Z',
  })
  const suspended = transitionWebhookEndpoint(active, 'suspended', '2026-07-15T11:24:01.000Z')
  assert.equal(suspended.status, 'suspended')
  assert.notEqual(webhookEndpointRevision(suspended), webhookEndpointRevision(active))
  assert.equal(transitionWebhookEndpoint(suspended, 'suspended', suspended.updatedAt), suspended)
  const resumed = transitionWebhookEndpoint(suspended, 'active', '2026-07-15T11:24:02.000Z')
  assert.equal(resumed.status, 'active')
  assert.equal('suspendedAt' in resumed, false)
  const revoked = transitionWebhookEndpoint(resumed, 'revoked', '2026-07-15T11:24:03.000Z')
  assert.equal(revoked.status, 'revoked')
  assert.throws(
    () => transitionWebhookEndpoint(revoked, 'active', '2026-07-15T11:24:04.000Z'),
    (error) => error instanceof DomainError && error.code === 'WEBHOOK_ENDPOINT_TRANSITION_REJECTED',
  )
})

test('webhook endpoint status command validates revision and scopes repository input', async () => {
  const endpoint = createWebhookEndpoint({
    id: '00000000-0000-4000-8000-000000000926', workspaceId: 'workspace-1',
    url: 'https://hooks.example.com/command', status: 'active',
    createdByClientId: 'client-1', createdAt: '2026-07-15T11:25:00.000Z',
    verifiedAt: '2026-07-15T11:25:00.000Z',
  })
  const baseRevision = webhookEndpointRevision(endpoint)
  let command
  const setStatus = setWebhookEndpointStatusService({
    repository: {
      async setStatus(value) {
        command = value
        const next = transitionWebhookEndpoint(endpoint, value.targetStatus, value.changedAt)
        return {
          endpoint: { endpoint: next }, replayed: false,
          effects: { pausedSubscriptions: 1, revokedSubscriptions: 0, revokedSigningSecrets: 0 },
        }
      },
    },
    clock: () => new Date('2026-07-15T11:25:01.000Z'),
  })
  const result = await setStatus({
    workspaceId: 'workspace-1', endpointId: endpoint.id,
    status: 'suspended', baseRevision,
  })
  assert.equal(result.endpoint.endpoint.status, 'suspended')
  assert.equal(result.effects.pausedSubscriptions, 1)
  assert.equal(command.workspaceId, 'workspace-1')
  assert.equal(command.baseRevision, baseRevision)
  await assert.rejects(
    () => setStatus({ workspaceId: 'workspace-1', endpointId: endpoint.id, status: 'pending-verification', baseRevision }),
    (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT',
  )
})

test('webhook subscription administration binds endpoint filters and scopes exact reads', async () => {
  const subscription = createWebhookSubscription({
    id: '00000000-0000-4000-8000-000000000922', workspaceId: 'workspace-1',
    endpointId: ids['webhook-endpoint'], status: 'active',
    filter: { eventTypes: ['project.created'], resourceIds: ['project-1'] },
    createdByClientId: 'client-1', createdAt: '2026-07-15T11:21:00.000Z',
  })
  let query
  const repository = {
    async listSubscriptions(value) { query = value; return [subscription] },
    async findSubscriptionById(workspaceId, subscriptionId) {
      return workspaceId === 'workspace-1' && subscriptionId === subscription.id ? subscription : null
    },
  }
  const list = listWebhookSubscriptionsService({ repository })
  assert.equal((await list({ workspaceId: 'workspace-1', endpointId: ids['webhook-endpoint'] })).subscriptions[0].id, subscription.id)
  assert.equal(query.endpointId, ids['webhook-endpoint'])
  const read = readWebhookSubscriptionService({ repository })
  assert.deepEqual((await read({ workspaceId: 'workspace-1', subscriptionId: subscription.id })).filter.resourceIds, ['project-1'])
  await assert.rejects(
    () => read({ workspaceId: 'workspace-2', subscriptionId: subscription.id }),
    (error) => error instanceof DomainError && error.code === 'WEBHOOK_SUBSCRIPTION_NOT_FOUND',
  )
})

test('webhook subscription lifecycle is revisioned, convergent and terminal after revocation', () => {
  const active = createWebhookSubscription({
    id: '00000000-0000-4000-8000-000000000923', workspaceId: 'workspace-1',
    endpointId: ids['webhook-endpoint'], status: 'active',
    filter: { eventTypes: ['project.created'] }, createdByClientId: 'client-1',
    createdAt: '2026-07-15T11:22:00.000Z', updatedAt: '2026-07-15T11:22:00.000Z',
  })
  const paused = transitionWebhookSubscription(active, 'paused', '2026-07-15T11:22:01.000Z')
  assert.equal(paused.status, 'paused')
  assert.equal(paused.pausedAt, '2026-07-15T11:22:01.000Z')
  assert.notEqual(webhookSubscriptionRevision(paused), webhookSubscriptionRevision(active))
  assert.equal(transitionWebhookSubscription(paused, 'paused', paused.updatedAt), paused)
  const resumed = transitionWebhookSubscription(paused, 'active', '2026-07-15T11:22:02.000Z')
  assert.equal(resumed.status, 'active')
  assert.equal('pausedAt' in resumed, false)
  const revoked = transitionWebhookSubscription(resumed, 'revoked', '2026-07-15T11:22:03.000Z')
  assert.equal(revoked.status, 'revoked')
  assert.throws(
    () => transitionWebhookSubscription(revoked, 'active', '2026-07-15T11:22:04.000Z'),
    (error) => error instanceof DomainError && error.code === 'WEBHOOK_SUBSCRIPTION_TRANSITION_REJECTED',
  )
})

test('webhook subscription status command validates revision and scopes repository input', async () => {
  const subscription = createWebhookSubscription({
    id: '00000000-0000-4000-8000-000000000924', workspaceId: 'workspace-1',
    endpointId: ids['webhook-endpoint'], status: 'active',
    filter: { eventTypes: ['project.created'] }, createdByClientId: 'client-1',
    createdAt: '2026-07-15T11:23:00.000Z',
  })
  const baseRevision = webhookSubscriptionRevision(subscription)
  let command
  const setStatus = setWebhookSubscriptionStatusService({
    repository: {
      async setStatus(value) {
        command = value
        const next = transitionWebhookSubscription(subscription, value.targetStatus, value.changedAt)
        return { subscription: next, revision: webhookSubscriptionRevision(next), replayed: false }
      },
    },
    clock: () => new Date('2026-07-15T11:23:01.000Z'),
  })
  const result = await setStatus({
    workspaceId: 'workspace-1', subscriptionId: subscription.id,
    status: 'paused', baseRevision,
  })
  assert.equal(result.subscription.status, 'paused')
  assert.equal(command.workspaceId, 'workspace-1')
  assert.equal(command.baseRevision, baseRevision)
  await assert.rejects(
    () => setStatus({ workspaceId: 'workspace-1', subscriptionId: subscription.id, status: 'pending-verification', baseRevision }),
    (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT',
  )
})

test('webhook status repositories retry serialization conflicts before returning revision mismatch', async () => {
  const conflictingClient = () => {
    let attempts = 0
    return {
      client: {
        async $transaction() {
          attempts += 1
          const error = new Error('serialization conflict')
          error.code = 'P2034'
          throw error
        },
      },
      attempts: () => attempts,
    }
  }

  const endpointConflict = conflictingClient()
  const endpointRepository = new PrismaWebhookEndpointCommandRepository(endpointConflict.client)
  await assert.rejects(
    () => endpointRepository.setStatus({
      workspaceId: 'workspace-1',
      endpointId: '00000000-0000-4000-8000-000000000925',
      targetStatus: 'suspended',
      baseRevision: 'a'.repeat(64),
      changedAt: '2026-07-16T13:10:00.000Z',
    }),
    (error) => error instanceof DomainError && error.code === 'WEBHOOK_ENDPOINT_REVISION_MISMATCH',
  )
  assert.equal(endpointConflict.attempts(), 3)

  const subscriptionConflict = conflictingClient()
  const subscriptionRepository = new PrismaWebhookSubscriptionCommandRepository(
    subscriptionConflict.client,
  )
  await assert.rejects(
    () => subscriptionRepository.setStatus({
      workspaceId: 'workspace-1',
      subscriptionId: '00000000-0000-4000-8000-000000000926',
      targetStatus: 'paused',
      baseRevision: 'b'.repeat(64),
      changedAt: '2026-07-16T13:10:00.000Z',
    }),
    (error) => error instanceof DomainError && error.code === 'WEBHOOK_SUBSCRIPTION_REVISION_MISMATCH',
  )
  assert.equal(subscriptionConflict.attempts(), 3)
})

test('webhook delivery diagnostics paginate with filters bound into the cursor', async () => {
  const endpointId = '00000000-0000-4000-8000-000000000801'
  const subscriptionId = '00000000-0000-4000-8000-000000000802'
  const eventId = '00000000-0000-4000-8000-000000000803'
  const makeRecord = (suffix, createdAt) => ({
    endpointId,
    delivery: createWebhookDelivery({
      id: `00000000-0000-4000-8000-${suffix}`,
      workspaceId: 'workspace-1',
      subscriptionId,
      eventId,
      status: 'succeeded',
      attemptCount: 1,
      maxAttempts: 8,
      nextAttemptAt: createdAt,
      createdAt,
      completedAt: createdAt,
    }),
  })
  const records = [
    makeRecord('000000000812', '2026-07-15T01:00:02.000Z'),
    makeRecord('000000000811', '2026-07-15T01:00:01.000Z'),
    makeRecord('000000000810', '2026-07-15T01:00:00.000Z'),
  ]
  const queries = []
  const list = listWebhookDeliveriesService({
    deliveries: {
      async list(query) {
        queries.push(query)
        return query.after ? [] : records
      },
      async findDiagnosticById() {
        return null
      },
    },
  })
  const first = await list({
    workspaceId: 'workspace-1',
    limit: 2,
    status: 'succeeded',
    endpointId,
    eventId,
  })
  assert.deepEqual(first.deliveries, records.slice(0, 2))
  assert.equal(typeof first.nextCursor, 'string')
  await list({
    workspaceId: 'workspace-1',
    limit: 2,
    status: 'succeeded',
    endpointId,
    eventId,
    after: first.nextCursor,
  })
  assert.deepEqual(queries[1].after, {
    createdAt: records[1].delivery.createdAt,
    id: records[1].delivery.id,
  })
  await assert.rejects(
    () => list({
      workspaceId: 'workspace-1',
      limit: 2,
      status: 'dead-lettered',
      endpointId,
      eventId,
      after: first.nextCursor,
    }),
    (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT',
  )
})

test('webhook delivery diagnostic is workspace-scoped and preserves ordered attempts', async () => {
  const deliveryId = '00000000-0000-4000-8000-000000000821'
  const delivery = createWebhookDelivery({
    id: deliveryId,
    workspaceId: 'workspace-1',
    subscriptionId: '00000000-0000-4000-8000-000000000822',
    eventId: '00000000-0000-4000-8000-000000000823',
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 8,
    nextAttemptAt: '2026-07-15T01:10:00.000Z',
    createdAt: '2026-07-15T01:10:00.000Z',
    completedAt: '2026-07-15T01:10:01.000Z',
  })
  const attempt = createWebhookDeliveryAttempt({
    id: '00000000-0000-4000-8000-000000000824',
    workspaceId: 'workspace-1',
    deliveryId,
    attemptNumber: 1,
    status: 'succeeded',
    scheduledAt: delivery.createdAt,
    createdAt: delivery.createdAt,
    startedAt: delivery.createdAt,
    completedAt: delivery.completedAt,
    responseStatus: 204,
    responseBodyHash: 'a'.repeat(64),
  })
  const read = readWebhookDeliveryService({
    deliveries: {
      async list() {
        return []
      },
      async findDiagnosticById(workspaceId, requestedId) {
        return workspaceId === 'workspace-1' && requestedId === deliveryId
          ? {
              delivery,
              endpointId: '00000000-0000-4000-8000-000000000825',
              attempts: [attempt],
            }
          : null
      },
    },
  })
  assert.deepEqual((await read({ workspaceId: 'workspace-1', deliveryId })).attempts, [attempt])
  await assert.rejects(
    () => read({ workspaceId: 'workspace-2', deliveryId }),
    (error) => error instanceof DomainError && error.code === 'WEBHOOK_DELIVERY_NOT_FOUND',
  )
})

test('webhook delivery replay reopens only terminal state within the absolute attempt limit', () => {
  const terminal = createWebhookDelivery({
    id: '00000000-0000-4000-8000-000000000831',
    workspaceId: 'workspace-1',
    subscriptionId: '00000000-0000-4000-8000-000000000832',
    eventId: '00000000-0000-4000-8000-000000000833',
    status: 'dead-lettered',
    attemptCount: 8,
    maxAttempts: 8,
    nextAttemptAt: '2026-07-15T01:20:00.000Z',
    createdAt: '2026-07-15T01:00:00.000Z',
    completedAt: '2026-07-15T01:20:00.000Z',
    deadLetteredAt: '2026-07-15T01:20:00.000Z',
  })
  const replayed = replayWebhookDelivery(
    terminal,
    '2026-07-15T01:21:00.000Z',
    '2026-07-15T01:21:00.001Z',
  )
  assert.equal(replayed.status, 'retry-scheduled')
  assert.equal(replayed.maxAttempts, 9)
  assert.equal(replayed.completedAt, undefined)
  assert.equal(replayed.deadLetteredAt, undefined)
  assert.throws(
    () => replayWebhookDelivery(
      { ...terminal, status: 'retry-scheduled', completedAt: undefined, deadLetteredAt: undefined },
      '2026-07-15T01:21:00.000Z',
      '2026-07-15T01:21:00.001Z',
    ),
    (error) => error instanceof DomainError && error.code === 'WEBHOOK_DELIVERY_REPLAY_REJECTED',
  )
  assert.throws(
    () => replayWebhookDelivery(
      { ...terminal, attemptCount: 20, maxAttempts: 20 },
      '2026-07-15T01:21:00.000Z',
      '2026-07-15T01:21:00.001Z',
    ),
    (error) => error instanceof DomainError && error.code === 'WEBHOOK_DELIVERY_REPLAY_REJECTED',
  )
})

test('webhook replay service binds client and delivery into required idempotency', async () => {
  let command
  const diagnostic = {
    delivery: createWebhookDelivery({
      id: '00000000-0000-4000-8000-000000000841',
      workspaceId: 'workspace-1',
      subscriptionId: '00000000-0000-4000-8000-000000000842',
      eventId: '00000000-0000-4000-8000-000000000843',
      status: 'retry-scheduled',
      attemptCount: 1,
      maxAttempts: 8,
      nextAttemptAt: '2026-07-15T01:30:00.001Z',
      createdAt: '2026-07-15T01:00:00.000Z',
    }),
    endpointId: '00000000-0000-4000-8000-000000000844',
    attempts: [],
  }
  const replay = replayWebhookDeliveryService({
    deliveries: {
      async replay(value) {
        command = value
        return { diagnostic, replayed: false }
      },
    },
    clock: () => new Date('2026-07-15T01:30:00.000Z'),
    createId: () => '00000000-0000-4000-8000-000000000845',
  })
  const result = await replay({
    workspaceId: 'workspace-1',
    clientId: 'client-1',
    deliveryId: diagnostic.delivery.id,
    idempotencyKey: 'replay-request-1',
  })
  assert.equal(result.diagnostic.delivery.id, diagnostic.delivery.id)
  assert.equal(command.nextAttemptAt, '2026-07-15T01:30:00.001Z')
  assert.equal(command.expiresAt, '2026-07-16T01:30:00.000Z')
  assert.match(command.requestFingerprint, /^[a-f0-9]{64}$/)
  await assert.rejects(
    () => replay({
      workspaceId: 'workspace-1',
      clientId: 'client-1',
      deliveryId: diagnostic.delivery.id,
      idempotencyKey: '',
    }),
    (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT',
  )
})

test('webhook delivery replay retries serialization conflicts before failing explicitly', async () => {
  let attempts = 0
  const repository = new PrismaWebhookDeliveryRepository({
    v2IdempotencyRecord: { async findUnique() { return null } },
    async $transaction() {
      attempts += 1
      const error = new Error('serialization conflict')
      error.code = 'P2034'
      throw error
    },
  })

  await assert.rejects(
    () => repository.replay({
      idempotencyId: '00000000-0000-4000-8000-000000000846',
      workspaceId: 'workspace-1',
      clientId: 'client-1',
      idempotencyKey: 'replay-serialization-retry-1',
      requestFingerprint: 'e'.repeat(64),
      deliveryId: '00000000-0000-4000-8000-000000000847',
      requestedAt: '2026-07-16T08:02:00.000Z',
      nextAttemptAt: '2026-07-16T08:02:00.001Z',
      expiresAt: '2026-07-17T08:02:00.000Z',
    }),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
  assert.equal(attempts, 3)
})

test('webhook delivery replay recovers a concurrent committed winner after serialization conflict', async () => {
  const deliveryId = '00000000-0000-4000-8000-000000000848'
  const requestFingerprint = 'd'.repeat(64)
  let transactions = 0
  const responseJson = JSON.stringify({
    delivery: {
      id: deliveryId,
      workspaceId: 'workspace-1',
      subscriptionId: '00000000-0000-4000-8000-000000000849',
      eventId: '00000000-0000-4000-8000-00000000084a',
      status: 'retry-scheduled',
      attemptCount: 1,
      maxAttempts: 8,
      nextAttemptAt: '2026-07-16T08:02:00.001Z',
      createdAt: '2026-07-16T08:00:00.000Z',
    },
    endpointId: '00000000-0000-4000-8000-00000000084b',
    attempts: [{
      id: '00000000-0000-4000-8000-00000000084c',
      workspaceId: 'workspace-1',
      deliveryId,
      attemptNumber: 1,
      status: 'scheduled',
      scheduledAt: '2026-07-16T08:00:00.000Z',
      createdAt: '2026-07-16T08:00:00.000Z',
    }],
  })
  const repository = new PrismaWebhookDeliveryRepository({
    v2IdempotencyRecord: {
      async findUnique() {
        return {
          requestFingerprint,
          status: 'completed',
          responseJson,
          expiresAt: new Date('2026-07-17T08:02:00.000Z'),
        }
      },
    },
    async $transaction() {
      transactions += 1
      const error = new Error('serialization conflict')
      error.code = 'P2034'
      throw error
    },
  })
  const result = await repository.replay({
    idempotencyId: '00000000-0000-4000-8000-00000000084d',
    workspaceId: 'workspace-1',
    clientId: 'client-1',
    idempotencyKey: 'replay-concurrent-winner-1',
    requestFingerprint,
    deliveryId,
    requestedAt: '2026-07-16T08:02:00.000Z',
    nextAttemptAt: '2026-07-16T08:02:00.001Z',
    expiresAt: '2026-07-17T08:02:00.000Z',
  })
  assert.equal(result.replayed, true)
  assert.equal(result.diagnostic.delivery.id, deliveryId)
  assert.equal(result.diagnostic.attempts.length, 1)
  assert.equal(transactions, 1)
})

test('webhook event replay service binds the exact event and bounded batch into idempotency', async () => {
  let command
  const eventId = '00000000-0000-4000-8000-000000000851'
  const replay = replayWebhookEventService({
    replays: {
      async replayEvent(value) {
        command = value
        return { eventId, items: [], replayed: false }
      },
    },
    clock: () => new Date('2026-07-15T01:40:00.000Z'),
    createId: () => '00000000-0000-4000-8000-000000000852',
    maxDeliveries: 100,
  })
  assert.equal((await replay({
    workspaceId: 'workspace-1',
    clientId: 'client-1',
    eventId,
    idempotencyKey: 'event-replay-request-1',
  })).eventId, eventId)
  assert.equal(command.maxDeliveries, 100)
  assert.equal(command.nextAttemptAt, '2026-07-15T01:40:00.001Z')
  assert.equal(command.expiresAt, '2026-07-16T01:40:00.000Z')
  assert.match(command.requestFingerprint, /^[a-f0-9]{64}$/)
  await assert.rejects(
    () => replay({
      workspaceId: 'workspace-1',
      clientId: 'client-1',
      eventId,
      idempotencyKey: '',
    }),
    (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT',
  )
  assert.throws(
    () => replayWebhookEventService({ replays: {}, maxDeliveries: 101 }),
    (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT',
  )
})

test('webhook event replay retries serialization conflicts before failing explicitly', async () => {
  let attempts = 0
  const repository = new PrismaWebhookEventReplayRepository({
    v2IdempotencyRecord: { async findUnique() { return null } },
    async $transaction() {
      attempts += 1
      const error = new Error('serialization conflict')
      error.code = 'P2034'
      throw error
    },
  })

  await assert.rejects(
    () => repository.replayEvent({
      idempotencyId: '00000000-0000-4000-8000-000000000853',
      workspaceId: 'workspace-1',
      clientId: 'client-1',
      idempotencyKey: 'event-replay-serialization-retry-1',
      requestFingerprint: 'f'.repeat(64),
      eventId: '00000000-0000-4000-8000-000000000854',
      requestedAt: '2026-07-16T08:03:00.000Z',
      nextAttemptAt: '2026-07-16T08:03:00.001Z',
      expiresAt: '2026-07-17T08:03:00.000Z',
      maxDeliveries: 100,
    }),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
  assert.equal(attempts, 3)
})

test('webhook filters match event type and optional resource exactly', () => {
  const typeOnly = createWebhookEventFilter({ eventTypes: ['project.created'] })
  const scoped = createWebhookEventFilter({
    eventTypes: ['project.created', 'project.version.created'],
    resourceIds: ['project-1'],
  })
  assert.equal(
    webhookEventMatchesFilter(typeOnly, { type: 'project.created', resourceId: 'any-project' }),
    true,
  )
  assert.equal(
    webhookEventMatchesFilter(scoped, { type: 'project.created', resourceId: 'project-1' }),
    true,
  )
  assert.equal(
    webhookEventMatchesFilter(scoped, { type: 'project.created', resourceId: 'project-10' }),
    false,
  )
  assert.equal(
    webhookEventMatchesFilter(scoped, { type: 'project.status.changed', resourceId: 'project-1' }),
    false,
  )
})

test('webhook fan-out service validates bounded retry policy and canonical clock', async () => {
  let command
  const materialize = materializeNextWebhookEventService({
    repository: {
      async materializeNext(received) {
        command = received
        return { status: 'idle' }
      },
    },
    clock: () => new Date('2026-07-14T23:20:00.000Z'),
  })
  assert.deepEqual(await materialize({ workspaceId: 'workspace-1' }), { status: 'idle' })
  assert.deepEqual(command, {
    workspaceId: 'workspace-1',
    maxAttempts: 8,
    publishedAt: '2026-07-14T23:20:00.000Z',
  })
  await assert.rejects(
    () => materialize({ workspaceId: 'workspace-1', maxAttempts: 21 }),
    (error) => error instanceof DomainError && error.code === 'INVALID_WEBHOOK',
  )
  await assert.rejects(
    () => materialize({ workspaceId: 'x' }),
    (error) => error instanceof DomainError && error.code === 'INVALID_WEBHOOK',
  )
})

test('webhook challenge token is one-shot material represented durably only by hash', () => {
  const issued = issueWebhookChallengeToken(() => Buffer.alloc(32, 7))
  assert.match(issued.token, /^whc_[A-Za-z0-9_-]{43}$/)
  assert.match(issued.tokenHash, /^[0-9a-f]{64}$/)
  assert.equal(hashWebhookChallengeToken(issued.token), issued.tokenHash)
  assert.equal(issued.tokenHash.includes(issued.token), false)

  const challenge = createWebhookVerificationChallenge({
    id: '00000000-0000-4000-8000-000000000107',
    workspaceId: 'workspace-1',
    endpointId: ids['webhook-endpoint'],
    tokenHash: issued.tokenHash,
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 5,
    createdAt: '2026-07-14T22:10:00.000Z',
    expiresAt: '2026-07-14T22:20:00.000Z',
  })
  assert.equal(challenge.status, 'pending')
  assert.equal('token' in challenge, false)
  assert.throws(
    () => hashWebhookChallengeToken('predictable-token'),
    (error) => error instanceof DomainError && error.code === 'WEBHOOK_CHALLENGE_REJECTED',
  )
})

test('webhook signature binds timestamp, event ID and exact body bytes', () => {
  const secret = Buffer.alloc(32, 9)
  const rawBody = Buffer.from('{"event":"project.created","name":"Ação"}', 'utf8')
  const eventId = '00000000-0000-4000-8000-000000000108'
  const timestamp = new Date('2026-07-14T22:10:00.789Z')
  const headers = signWebhookPayload({ secret, eventId, rawBody, timestamp })
  const verified = verifyWebhookSignature({
    secret,
    rawBody,
    headers,
    now: new Date('2026-07-14T22:14:59.000Z'),
  })
  assert.equal(verified.eventId, eventId)
  assert.equal(verified.timestamp, '2026-07-14T22:10:00.000Z')

  for (const invalid of [
    { secret: Buffer.alloc(32, 8), rawBody, headers, now: timestamp },
    { secret, rawBody: Buffer.from('{"event":"project.created","name":"Acao"}'), headers, now: timestamp },
    { secret, rawBody, headers, now: new Date('2026-07-14T22:15:01.000Z') },
    {
      secret,
      rawBody,
      headers: { ...headers, 'apollo-webhook-signature': `v2=${'a'.repeat(64)}` },
      now: timestamp,
    },
    {
      secret,
      rawBody,
      headers: { ...headers, 'apollo-webhook-id': 'not-an-event-id' },
      now: timestamp,
    },
  ]) {
    assert.throws(
      () => verifyWebhookSignature(invalid),
      (error) => error instanceof DomainError && error.code === 'WEBHOOK_SIGNATURE_INVALID',
    )
  }
})

test('webhook network policy accepts only globally routable DNS answers', () => {
  for (const [address, family] of [
    ['8.8.8.8', 4],
    ['1.1.1.1', 4],
    ['2606:4700:4700::1111', 6],
    ['2a00:1450:4001:81b::200e', 6],
  ]) {
    assert.equal(isPublicWebhookAddress(address, family), true)
  }
  for (const [address, family] of [
    ['0.0.0.0', 4],
    ['10.0.0.1', 4],
    ['100.64.0.1', 4],
    ['127.0.0.1', 4],
    ['169.254.169.254', 4],
    ['172.31.0.1', 4],
    ['192.168.1.1', 4],
    ['198.18.0.1', 4],
    ['203.0.113.10', 4],
    ['224.0.0.1', 4],
    ['::', 6],
    ['::1', 6],
    ['::ffff:127.0.0.1', 6],
    ['2001:db8::1', 6],
    ['3fff::1', 6],
    ['fc00::1', 6],
    ['fe80::1', 6],
    ['ff02::1', 6],
  ]) {
    assert.equal(isPublicWebhookAddress(address, family), false, address)
  }
  assert.throws(
    () => validateWebhookResolution([
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]),
    (error) => error instanceof DomainError && error.code === 'WEBHOOK_NETWORK_REJECTED',
  )
  assert.throws(
    () => validateWebhookResolution([]),
    (error) => error instanceof DomainError && error.code === 'WEBHOOK_NETWORK_REJECTED',
  )
})

test('safe webhook challenge pins a fresh public DNS answer and accepts exact proof', async () => {
  const issued = issueWebhookChallengeToken(() => Buffer.alloc(32, 10))
  const challengeId = '00000000-0000-4000-8000-000000000109'
  let pinnedRequest
  const transport = new SafeWebhookChallengeTransport({
    resolver: {
      async resolve(hostname) {
        assert.equal(hostname, 'hooks.example.com')
        return [
          { address: '8.8.8.8', family: 4 },
          { address: '2606:4700:4700::1111', family: 6 },
        ]
      },
    },
    client: {
      async post(request) {
        pinnedRequest = request
        const payload = JSON.parse(request.body.toString('utf8'))
        assert.deepEqual(payload, {
          type: 'apollo.webhook.challenge',
          challengeId,
          token: issued.token,
          expiresAt: '2026-07-14T23:10:00.000Z',
        })
        return {
          statusCode: 200,
          contentType: 'application/json; charset=utf-8',
          body: Buffer.from(JSON.stringify({ challengeId, token: issued.token })),
        }
      },
    },
  })

  const result = await transport.send({
    url: 'https://hooks.example.com/apollo',
    challengeId,
    token: issued.token,
    expiresAt: '2026-07-14T23:10:00.000Z',
  })
  assert.equal(result.echoedToken, issued.token)
  assert.deepEqual(pinnedRequest.address, { address: '8.8.8.8', family: 4 })
  assert.ok(pinnedRequest.timeoutMs > 0 && pinnedRequest.timeoutMs <= 5_000)

  const options = createPinnedWebhookRequestOptions(pinnedRequest)
  assert.equal(options.hostname, 'hooks.example.com')
  assert.equal(options.family, 4)
  assert.equal(options.servername, 'hooks.example.com')
  assert.equal(options.agent, false)
  assert.equal(options.rejectUnauthorized, true)
  assert.equal(options.minVersion, 'TLSv1.2')
  assert.equal(options.path, '/apollo')
  const pinnedLookup = await new Promise((resolve, reject) => {
    options.lookup('hooks.example.com', {}, (error, address, family) => {
      if (error) reject(error)
      else resolve({ address, family })
    })
  })
  assert.deepEqual(pinnedLookup, { address: '8.8.8.8', family: 4 })
})

test('safe webhook challenge fails closed before connection and rejects ambiguous responses', async () => {
  const issued = issueWebhookChallengeToken(() => Buffer.alloc(32, 11))
  const challengeId = '00000000-0000-4000-8000-000000000110'
  let connections = 0
  const privateTransport = new SafeWebhookChallengeTransport({
    resolver: { async resolve() { return [{ address: '169.254.169.254', family: 4 }] } },
    client: { async post() { connections += 1; throw new Error('must not connect') } },
  })
  await assert.rejects(
    () => privateTransport.send({
      url: 'https://hooks.example.com/apollo',
      challengeId,
      token: issued.token,
      expiresAt: '2026-07-14T23:10:00.000Z',
    }),
    (error) => error instanceof DomainError && error.code === 'WEBHOOK_NETWORK_REJECTED',
  )
  assert.equal(connections, 0)

  for (const response of [
    { statusCode: 302, contentType: 'application/json', body: Buffer.from('{}') },
    { statusCode: 200, contentType: 'text/plain', body: Buffer.from(issued.token) },
    { statusCode: 200, contentType: 'application/json', body: Buffer.from('{') },
    {
      statusCode: 200,
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify({ challengeId, token: issued.token, extra: true })),
    },
    {
      statusCode: 200,
      contentType: 'application/json',
      body: Buffer.from(` ${JSON.stringify({ challengeId, token: issued.token })}`),
    },
    {
      statusCode: 200,
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify({
        challengeId: '00000000-0000-4000-8000-000000000111',
        token: issued.token,
      })),
    },
    {
      statusCode: 200,
      contentType: 'application/json',
      body: Buffer.alloc(1_025, 32),
    },
  ]) {
    const transport = new SafeWebhookChallengeTransport({
      resolver: { async resolve() { return [{ address: '8.8.8.8', family: 4 }] } },
      client: { async post() { return response } },
    })
    await assert.rejects(
      () => transport.send({
        url: 'https://hooks.example.com/apollo',
        challengeId,
        token: issued.token,
        expiresAt: '2026-07-14T23:10:00.000Z',
      }),
      (error) =>
        error instanceof DomainError &&
        error.code === 'WEBHOOK_CHALLENGE_TRANSPORT_FAILED' &&
        !error.message.includes(issued.token),
    )
  }
  assert.throws(
    () => new SafeWebhookChallengeTransport({ timeoutMs: 999 }),
    (error) =>
      error instanceof DomainError && error.code === 'WEBHOOK_CHALLENGE_TRANSPORT_FAILED',
  )
})

test('webhook challenge resolves every connection again and blocks rebinding', async () => {
  const issued = issueWebhookChallengeToken(() => Buffer.alloc(32, 13))
  const challengeId = '00000000-0000-4000-8000-000000000113'
  let resolutions = 0
  let connections = 0
  const transport = new SafeWebhookChallengeTransport({
    resolver: {
      async resolve() {
        resolutions += 1
        return resolutions === 1
          ? [{ address: '8.8.8.8', family: 4 }]
          : [{ address: '127.0.0.1', family: 4 }]
      },
    },
    client: {
      async post() {
        connections += 1
        return {
          statusCode: 200,
          contentType: 'application/json',
          body: Buffer.from(JSON.stringify({ challengeId, token: issued.token })),
        }
      },
    },
  })
  const request = {
    url: 'https://hooks.example.com/apollo',
    challengeId,
    token: issued.token,
    expiresAt: '2026-07-14T23:10:00.000Z',
  }
  await transport.send(request)
  await assert.rejects(
    () => transport.send(request),
    (error) => error instanceof DomainError && error.code === 'WEBHOOK_NETWORK_REJECTED',
  )
  assert.equal(resolutions, 2)
  assert.equal(connections, 1)
})

test('webhook challenge enforces one absolute deadline across transport boundaries', async () => {
  const issued = issueWebhookChallengeToken(() => Buffer.alloc(32, 14))
  const startedAt = Date.now()
  const transport = new SafeWebhookChallengeTransport({
    timeoutMs: 1_000,
    resolver: { async resolve() { return [{ address: '8.8.8.8', family: 4 }] } },
    client: { async post() { return new Promise(() => {}) } },
  })
  await assert.rejects(
    () => transport.send({
      url: 'https://hooks.example.com/apollo',
      challengeId: '00000000-0000-4000-8000-000000000114',
      token: issued.token,
      expiresAt: '2026-07-14T23:10:00.000Z',
    }),
    (error) =>
      error instanceof DomainError && error.code === 'WEBHOOK_CHALLENGE_TRANSPORT_FAILED',
  )
  const elapsedMs = Date.now() - startedAt
  assert.ok(elapsedMs >= 900 && elapsedMs < 2_000, `elapsed ${elapsedMs}ms`)
})

test('endpoint activation keeps the one-shot token inside the challenge workflow', async () => {
  const now = new Date('2026-07-14T23:00:00.000Z')
  const issued = issueWebhookChallengeToken(() => Buffer.alloc(32, 12))
  let storedChallenge
  let transportedToken
  const repository = {
    async getPendingTarget(workspaceId, endpointId) {
      return { workspaceId, endpointId, url: 'https://hooks.example.com/apollo' }
    },
    async issue(challenge) {
      storedChallenge = challenge
      return challenge
    },
    async verify(command) {
      assert.equal(command.responseHash, storedChallenge.tokenHash)
      return { challenge: storedChallenge, activatedSubscriptions: 2 }
    },
  }
  const activate = activateWebhookEndpointService({
    repository,
    transport: {
      async send(request) {
        transportedToken = request.token
        return { echoedToken: request.token }
      },
    },
    clock: () => now,
    createId: () => '00000000-0000-4000-8000-000000000112',
    issueToken: () => issued,
  })

  const result = await activate({
    workspaceId: 'workspace-1',
    endpointId: ids['webhook-endpoint'],
  })
  assert.equal(transportedToken, issued.token)
  assert.equal(JSON.stringify(storedChallenge).includes(issued.token), false)
  assert.equal(JSON.stringify(result).includes(issued.token), false)
  assert.equal(result.activatedSubscriptions, 2)
})

test('public endpoint challenge activates once and converges after a lost response', async () => {
  let state = 'pending'
  let issues = 0
  let transports = 0
  let activationLeaseTokenHash
  let activationLeaseByte = 22
  const issued = issueWebhookChallengeToken(() => Buffer.alloc(32, 21))
  const repository = {
    async getActivationState(workspaceId, endpointId) {
      return state === 'active'
        ? { status: 'active', workspaceId, endpointId }
        : { status: 'pending', workspaceId, endpointId, url: 'https://hooks.example.com/apollo' }
    },
    async claimActivationLease(command) {
      if (state === 'active') {
        return { status: 'active', workspaceId: command.workspaceId, endpointId: command.endpointId }
      }
      if (activationLeaseTokenHash) {
        return { status: 'follower', workspaceId: command.workspaceId, endpointId: command.endpointId }
      }
      activationLeaseTokenHash = command.leaseTokenHash
      return {
        status: 'leader', workspaceId: command.workspaceId, endpointId: command.endpointId,
        url: 'https://hooks.example.com/apollo',
      }
    },
    async releaseActivationLease(command) {
      if (activationLeaseTokenHash !== command.leaseTokenHash) return false
      activationLeaseTokenHash = undefined
      return true
    },
    async issue(challenge) { issues += 1; return challenge },
    async verify(command) {
      assert.equal(command.responseHash, issued.tokenHash)
      assert.equal(command.activationLeaseTokenHash, activationLeaseTokenHash)
      state = 'active'
      activationLeaseTokenHash = undefined
      return { challenge: {}, activatedSubscriptions: 3 }
    },
  }
  const activate = activateWebhookEndpointConvergentlyService({
    repository,
    transport: {
      async send(request) {
        transports += 1
        await new Promise((resolve) => setTimeout(resolve, 10))
        return { echoedToken: request.token }
      },
    },
    clock: () => new Date('2026-07-15T21:00:00.000Z'),
    createId: () => '00000000-0000-4000-8000-000000000126',
    issueToken: () => issued,
    issueActivationLeaseToken: () =>
      issueWebhookChallengeToken(() => Buffer.alloc(32, activationLeaseByte++)),
    activationLeaseMs: 100,
    followerPollMs: 1,
    followerMaxWaitMs: 1_000,
  })
  const request = {
    workspaceId: 'workspace-1',
    endpointId: '00000000-0000-4000-8000-000000000127',
  }
  const concurrent = await Promise.all([activate(request), activate(request)])
  assert.deepEqual(concurrent.map((result) => result.replayed).sort(), [false, true])
  assert.deepEqual(
    concurrent.map((result) => result.activatedSubscriptions).sort((left, right) => left - right),
    [0, 3],
  )
  assert.deepEqual(await activate(request), { activatedSubscriptions: 0, replayed: true })
  assert.equal(issues, 1)
  assert.equal(transports, 1)
})

test('webhook activation lease retries concurrent write conflicts before failing explicitly', async () => {
  let attempts = 0
  const repository = new PrismaWebhookSecurityRepository({
    v2WebhookEndpoint: {
      async findFirst() {
        return {
          id: '00000000-0000-4000-8000-000000000130',
          workspaceId: 'workspace-1',
          url: 'https://hooks.example.com/apollo',
          status: 'pending-verification',
        }
      },
    },
    v2WebhookEndpointActivationLease: {
      async updateMany() {
        attempts += 1
        const error = new Error('serialization conflict')
        error.code = 'P2034'
        throw error
      },
    },
  })

  await assert.rejects(
    () => repository.claimActivationLease({
      workspaceId: 'workspace-1',
      endpointId: '00000000-0000-4000-8000-000000000130',
      leaseTokenHash: 'a'.repeat(64),
      claimedAt: '2026-07-16T16:00:00.000Z',
      leaseExpiresAt: '2026-07-16T16:00:10.000Z',
    }),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
  assert.equal(attempts, 3)
})

test('public endpoint challenge cannot bypass suspended or revoked lifecycle', async () => {
  let effects = 0
  const activate = activateWebhookEndpointConvergentlyService({
    repository: {
      async getActivationState(workspaceId, endpointId) {
        return { status: 'blocked', workspaceId, endpointId }
      },
      async claimActivationLease(command) {
        return { status: 'blocked', workspaceId: command.workspaceId, endpointId: command.endpointId }
      },
      async releaseActivationLease() { effects += 1; return false },
      async issue() { effects += 1 },
      async verify() { effects += 1 },
    },
    transport: { async send() { effects += 1 } },
    clock: () => new Date('2026-07-15T21:00:00.000Z'),
    createId: () => '00000000-0000-4000-8000-000000000128',
  })
  await assert.rejects(
    () => activate({
      workspaceId: 'workspace-1',
      endpointId: '00000000-0000-4000-8000-000000000129',
    }),
    (error) => error instanceof DomainError && error.code === 'WEBHOOK_CHALLENGE_REJECTED',
  )
  assert.equal(effects, 0)
})
