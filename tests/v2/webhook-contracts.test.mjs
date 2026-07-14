import assert from 'node:assert/strict'
import test from 'node:test'

import { registerWebhookService } from '../../src/v2/application/register-webhook.ts'
import { activateWebhookEndpointService } from '../../src/v2/application/secure-webhook.ts'
import { materializeNextWebhookEventService } from '../../src/v2/application/materialize-webhook-deliveries.ts'
import {
  claimNextWebhookDeliveryService,
  heartbeatWebhookDeliveryService,
  settleWebhookDeliveryService,
} from '../../src/v2/application/manage-webhook-delivery.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import {
  createWebhookDelivery,
  createWebhookDeliveryAttempt,
  createWebhookEndpoint,
  createWebhookEventFilter,
  createWebhookSigningSecret,
  normalizeWebhookUrl,
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
