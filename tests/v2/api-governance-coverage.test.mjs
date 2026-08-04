import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { API_SCOPES, isApiScope } from '../../src/v2/domain/api-client.ts'
import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'
import { applicationServicesForEndpoint } from '../../scripts/generate-ui-capability-parity-report.mjs'

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

test('T-FR-242 capability grants and route enforcement share one closed resource:action matrix', () => {
  const routesRoot = join(root, 'src/app/v1')
  const applicationRoot = join(root, 'src/v2/application')
  const applicationFiles = new Map()
  const exportedApplicationFiles = new Map()
  for (const relative of readdirSync(applicationRoot, { recursive: true }).map(String)) {
    if (!relative.endsWith('.ts')) continue
    const file = join(applicationRoot, relative)
    const source = readFileSync(file, 'utf8')
    applicationFiles.set(resolve(file), source)
    for (const match of source.matchAll(/export function\s+([A-Za-z0-9_]+)/g)) {
      exportedApplicationFiles.set(match[1], resolve(file))
    }
  }
  const applicationSourceClosure = (file, visited = new Set()) => {
    if (!file || visited.has(file)) return ''
    visited.add(file)
    const source = applicationFiles.get(file) ?? ''
    const dependencies = [...source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)]
      .map((match) => resolve(dirname(file), match[1]))
      .filter((dependency) => applicationFiles.has(dependency))
    return [source, ...dependencies.map((dependency) => applicationSourceClosure(dependency, visited))]
      .join('\n')
  }
  const capabilityScopes = [...new Set(
    FOUNDATION_CAPABILITIES.flatMap((capability) => capability.requiredScopes),
  )].sort()
  assert.deepEqual(capabilityScopes, [...API_SCOPES].sort())

  for (const capability of FOUNDATION_CAPABILITIES) {
    if (!capability.endpoint || capability.requiredScopes.length === 0) continue
    const routePath = capability.endpoint.path
      .replace(/^\/v1\/?/, '')
      .replace(/\{([^}]+)\}/g, '[$1]')
    const routeSource = readFileSync(join(routesRoot, routePath, 'route.ts'), 'utf8')
    const serviceSource = applicationServicesForEndpoint(root, capability.endpoint)
      .map((name) => applicationSourceClosure(exportedApplicationFiles.get(name)))
      .join('\n')
    const enforcementSource = `${routeSource}\n${serviceSource}`
    for (const scope of capability.requiredScopes) {
      assert.match(
        enforcementSource,
        new RegExp(`requireScope\\([^,]+,\\s*['\"]${scope}['\"]\\)`),
        `${capability.endpoint.method} ${capability.endpoint.path} must enforce ${scope} in its route or shared Application service`,
      )
    }
  }

  for (const sourceRoot of [routesRoot, applicationRoot]) {
    for (const relative of readdirSync(sourceRoot, { recursive: true }).map(String)) {
      if (!relative.endsWith('.ts')) continue
      const source = readFileSync(join(sourceRoot, relative), 'utf8')
      for (const match of source.matchAll(/requireScope\([^,]+,\s*['"]([^'"]+)['"]\)/g)) {
        assert.equal(isApiScope(match[1]), true, `${relative} uses unknown scope ${match[1]}`)
      }
    }
  }
})
