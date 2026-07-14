import assert from 'node:assert/strict'
import test from 'node:test'

import { registerWebhookService } from '../../src/v2/application/register-webhook.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import {
  createWebhookDelivery,
  createWebhookDeliveryAttempt,
  createWebhookEndpoint,
  createWebhookEventFilter,
  createWebhookSigningSecret,
  normalizeWebhookUrl,
} from '../../src/v2/domain/webhook.ts'

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
})
