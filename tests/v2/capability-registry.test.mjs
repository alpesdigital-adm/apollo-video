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

function expectDomainError(callback, code) {
  assert.throws(callback, (error) => error instanceof DomainError && error.code === code)
}

test('foundation registry exposes health and discovery without scopes', () => {
  const visible = capabilitiesForScopes(FOUNDATION_CAPABILITIES, new Set())

  assert.deepEqual(
    visible.map((capability) => capability.id),
    [
      'apollo.health.read',
      'apollo.capabilities.list',
      'apollo.tools.list',
      'apollo.events.catalog.read',
      'apollo.contracts.openapi.read',
      'apollo.contracts.schemas.read',
    ],
  )
  assert.ok(visible.every((capability) => Object.isFrozen(capability)))
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
