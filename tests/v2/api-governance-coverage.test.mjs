import assert from 'node:assert/strict'
import test from 'node:test'
import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'

const capabilities = new Map(FOUNDATION_CAPABILITIES.map((item) => [item.id, item]))

test('client governance covers listing, scoped creation, environments and secret lifecycle', () => {
  for (const id of ['apollo.clients.list', 'apollo.clients.create', 'apollo.clients.credentials.rotate', 'apollo.clients.credentials.revoke']) assert.equal(capabilities.has(id), true, id)
  const create = getPublicSchema(capabilities.get('apollo.clients.create').inputSchemaRef).schema
  assert.deepEqual(create.required, ['name', 'scopes'])
  assert.deepEqual(create.properties.environment.enum, ['sandbox', 'production'])
  assert.equal(create.properties.scopes.maxItems, 64)
  for (const id of ['apollo.clients.list', 'apollo.clients.create', 'apollo.clients.credentials.rotate', 'apollo.clients.credentials.revoke']) assert.deepEqual(capabilities.get(id).requiredScopes, ['clients:admin'])
})

test('webhook governance covers endpoint, subscription, lifecycle, delivery and diagnostics', () => {
  const required = [
    'apollo.webhooks.endpoints.create', 'apollo.webhooks.endpoints.list', 'apollo.webhooks.endpoints.read', 'apollo.webhooks.endpoints.status.set',
    'apollo.webhooks.endpoints.challenge', 'apollo.webhooks.subscriptions.create', 'apollo.webhooks.subscriptions.list', 'apollo.webhooks.subscriptions.read',
    'apollo.webhooks.subscriptions.status.set', 'apollo.webhooks.deliveries.list', 'apollo.webhooks.deliveries.read', 'apollo.webhooks.deliveries.replay',
  ]
  for (const id of required) {
    assert.equal(capabilities.has(id), true, id)
    assert.equal(capabilities.get(id).authMode, 'required')
  }
  assert.equal(capabilities.get('apollo.webhooks.deliveries.list').queryParameters.some((parameter) => parameter.name === 'cursor'), true)
})
