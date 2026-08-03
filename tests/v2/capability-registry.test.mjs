import assert from 'node:assert/strict'
import test from 'node:test'

import { DomainError } from '../../src/v2/domain/errors.ts'
import {
  FOUNDATION_CAPABILITIES,
  assertCapabilityParity,
  capabilitiesForAccess,
  capabilitiesForScopes,
  defineCapabilityAccessPolicy,
  defineCapabilityRegistry,
} from '../../src/v2/public-api/capability-registry.ts'
import { agentToolsForCapabilities } from '../../src/v2/public-api/agent-tool-catalog.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'

function expectDomainError(callback, code) {
  assert.throws(callback, (error) => error instanceof DomainError && error.code === code)
}

test('foundation registry exposes health and discovery without scopes', () => {
  const visible = capabilitiesForScopes(FOUNDATION_CAPABILITIES, new Set())

  assert.deepEqual(
    visible.map((capability) => capability.id),
    [
      'apollo.health.read',
      'apollo.sessions.login',
      'apollo.sessions.read',
      'apollo.sessions.logout',
      'apollo.capabilities.list',
      'apollo.tools.list',
      'apollo.events.catalog.read',
      'apollo.sessions.switch-workspace',
      'apollo.sessions.oidc-start',
      'apollo.sessions.oidc-callback',
      'apollo.contracts.openapi.read',
      'apollo.contracts.schemas.read',
      'apollo.media.uploads.content.put',
      'apollo.media.download-grants.consume',
    ],
  )
  assert.ok(visible.every((capability) => Object.isFrozen(capability)))
})

test('human session capabilities are public contracts but never agent tools', () => {
  const sessions = FOUNDATION_CAPABILITIES.filter((capability) =>
    capability.id.startsWith('apollo.sessions.'),
  )

  assert.deepEqual(sessions.map((capability) => capability.id), [
    'apollo.sessions.login',
    'apollo.sessions.read',
    'apollo.sessions.logout',
    'apollo.sessions.switch-workspace',
    'apollo.sessions.oidc-start',
    'apollo.sessions.oidc-callback',
  ])
  assert.ok(sessions.every((capability) => capability.toolName === undefined))
  assert.equal(sessions.find((capability) => capability.id.endsWith('.read')).authScheme, 'ui-session')
  const agentToolCapabilityIds = agentToolsForCapabilities(FOUNDATION_CAPABILITIES)
    .map((tool) => tool.apollo.capabilityId)
  assert.equal(agentToolCapabilityIds.some((id) => id.startsWith('apollo.sessions.')), false)
  const loginSchema = getPublicSchema(sessions.find((capability) => capability.id.endsWith('.login')).inputSchemaRef).schema
  assert.equal(loginSchema.properties.password.writeOnly, true)
  for (const capability of sessions) {
    assert.equal(JSON.stringify(getPublicSchema(capability.outputSchemaRef).schema).includes('password'), false)
  }

  expectDomainError(() => defineCapabilityRegistry([{ ...sessions[0], toolName: 'apollo.sessions.login' }]), 'INVALID_CAPABILITY')
})
test('scope filtering is deny-by-default', () => {
  const registry = defineCapabilityRegistry([
    {
      id: 'apollo.projects.read',
      version: '1.0.0',
      title: 'Read projects',
      description: 'Reads workspace projects.',
      exposure: 'public',
      operationKind: 'query',
      authMode: 'required',
      requiredScopes: ['projects:read'],
      outputSchemaRef: 'apollo://schemas/project-list/v1',
      endpoint: { method: 'GET', path: '/v1/projects' },
      toolName: 'apollo.projects.read',
      supportsDryRun: false,
      costClass: 'free',
      confirmation: 'none',
      successStatuses: [200],
      idempotency: 'not-applicable',
    },
  ])

  assert.equal(capabilitiesForScopes(registry, new Set()).length, 0)
  assert.equal(capabilitiesForScopes(registry, new Set(['projects:read'])).length, 1)
})

test('capability discovery intersects scopes, environment and deny-only policy', () => {
  const scopes = new Set(
    FOUNDATION_CAPABILITIES.flatMap((capability) => capability.requiredScopes),
  )
  const policy = defineCapabilityAccessPolicy(
    {
      disabled: ['apollo.contracts.schemas.read'],
      byEnvironment: { production: ['apollo.contracts.openapi.read'] },
      byWorkspace: { 'workspace-policy-1': ['apollo.clients.list'] },
      byClient: { 'client-policy-1': ['apollo.events.catalog.read'] },
    },
    FOUNDATION_CAPABILITIES,
  )
  const visible = capabilitiesForAccess(FOUNDATION_CAPABILITIES, {
    environment: 'production',
    actor: {
      clientId: 'client-policy-1',
      workspaceId: 'workspace-policy-1',
      environment: 'production',
      scopes,
    },
    policy,
  })
  const ids = new Set(visible.map((capability) => capability.id))

  assert.equal(ids.has('apollo.projects.create'), true)
  assert.equal(ids.has('apollo.contracts.schemas.read'), false)
  assert.equal(ids.has('apollo.contracts.openapi.read'), false)
  assert.equal(ids.has('apollo.clients.list'), false)
  assert.equal(ids.has('apollo.events.catalog.read'), false)
})

test('capability availability is environment-bound and policy configuration fails closed', () => {
  const registry = defineCapabilityRegistry([
    {
      ...FOUNDATION_CAPABILITIES[0],
      id: 'apollo.sandbox.health.read',
      endpoint: { method: 'GET', path: '/v1/sandbox-health' },
      toolName: 'apollo.sandbox.health.read',
      availableIn: ['sandbox'],
    },
  ])

  assert.equal(
    capabilitiesForAccess(registry, { environment: 'sandbox' }).length,
    1,
  )
  assert.equal(
    capabilitiesForAccess(registry, { environment: 'production' }).length,
    0,
  )
  expectDomainError(
    () => defineCapabilityAccessPolicy({ byClient: { client: ['apollo.missing'] } }, registry),
    'INVALID_CAPABILITY_POLICY',
  )
  expectDomainError(
    () => defineCapabilityAccessPolicy({ allow: ['apollo.sandbox.health.read'] }, registry),
    'INVALID_CAPABILITY_POLICY',
  )
})

test('registry rejects duplicate capabilities and unsafe high-cost actions', () => {
  const base = FOUNDATION_CAPABILITIES[0]

  expectDomainError(
    () => defineCapabilityRegistry([base, { ...base }]),
    'DUPLICATE_CAPABILITY',
  )
  expectDomainError(
    () =>
      defineCapabilityRegistry([
        {
          ...base,
          id: 'apollo.synthetic.generate',
          endpoint: { method: 'POST', path: '/v1/synthetic:generate' },
          toolName: 'apollo.synthetic.generate',
          operationKind: 'job',
          costClass: 'variable',
          confirmation: 'none',
        },
      ]),
    'INVALID_CAPABILITY',
  )
})

test('T-F0-034 registry fails closed for exposure, scopes, schema, cost and confirmation drift', () => {
  const base = FOUNDATION_CAPABILITIES.find((capability) => capability.id === 'apollo.projects.create')
  assert.ok(base)
  const mutations = [
    { exposure: 'partner' },
    { operationKind: 'mutation' },
    { requiredScopes: ['projects read'] },
    { inputSchemaRef: 'https://schemas.example/create-project.json' },
    { outputSchemaRef: 'apollo://schemas/project-created/v0' },
    { costClass: 'unbounded' },
    { confirmation: 'click-through' },
  ]

  for (const mutation of mutations) {
    expectDomainError(
      () => defineCapabilityRegistry([{ ...base, ...mutation }]),
      'INVALID_CAPABILITY',
    )
  }

  assert.ok(FOUNDATION_CAPABILITIES.length >= 189)
  for (const capability of FOUNDATION_CAPABILITIES) {
    assert.ok(['public', 'workspace-admin', 'internal-only'].includes(capability.exposure))
    assert.ok(['free', 'low', 'medium', 'high', 'variable'].includes(capability.costClass))
    assert.ok(['none', 'preflight-token', 'human-approval'].includes(capability.confirmation))
    assert.doesNotThrow(() => getPublicSchema(capability.outputSchemaRef))
    if (capability.inputSchemaRef) assert.doesNotThrow(() => getPublicSchema(capability.inputSchemaRef))
  }
})

test('UI parity requires a public capability or an internal-only reason', () => {
  assert.doesNotThrow(() =>
    assertCapabilityParity(
      [
        { id: 'health-button', capabilityId: 'apollo.health.read' },
        { id: 'internal-debug-panel', internalOnlyReason: 'Infrastructure diagnostics only' },
      ],
      FOUNDATION_CAPABILITIES,
    ),
  )

  expectDomainError(
    () =>
      assertCapabilityParity(
        [{ id: 'orphan-ui-action', capabilityId: 'apollo.projects.missing' }],
        FOUNDATION_CAPABILITIES,
      ),
    'CAPABILITY_PARITY_MISSING',
  )
})
