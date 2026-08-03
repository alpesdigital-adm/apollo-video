import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'

const capabilities = new Map(FOUNDATION_CAPABILITIES.map((item) => [item.id, item]))
const root = resolve(import.meta.dirname, '../..')

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
  assert.equal(capabilities.get('apollo.webhooks.deliveries.list').queryParameters.some((parameter) => parameter.name === 'after'), true)
})

test('T-FR-242 every route uses the authenticated audit actor instead of rebuilding it', () => {
  const routesRoot = join(root, 'src/app/v1')
  const routeFiles = readdirSync(routesRoot, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith('route.ts'))
  const manualActor = /actor\s*:\s*\{(?:(?!\}).){0,200}type\s*:\s*['"]api-client['"](?:(?!\}).){0,200}id\s*:\s*actor\.clientId/gs
  const offenders = []
  let canonicalBindings = 0
  for (const relative of routeFiles) {
    const source = readFileSync(join(routesRoot, relative), 'utf8')
    if (manualActor.test(source)) offenders.push(relative)
    manualActor.lastIndex = 0
    canonicalBindings += source.match(/actor\s*:\s*actor\.auditContext\.actor/g)?.length ?? 0
  }
  assert.deepEqual(offenders, [])
  assert.ok(canonicalBindings >= 60, `expected broad audit propagation, found ${canonicalBindings}`)
})
