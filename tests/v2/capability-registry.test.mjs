import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { DomainError } from '../../src/v2/domain/errors.ts'
import {
  FOUNDATION_CAPABILITIES,
  INTERNAL_ONLY_SURFACES,
  assertCapabilityAccess,
  assertCapabilityParity,
  bindUiNetworkActionsToCapabilities,
  capabilitiesForAccess,
  capabilitiesForScopes,
  defineCapabilityAccessPolicy,
  defineCapabilityRegistry,
  defineInternalOnlySurfaceAllowlist,
} from '../../src/v2/public-api/capability-registry.ts'
import { agentToolsForCapabilities } from '../../src/v2/public-api/agent-tool-catalog.ts'
import { PUBLIC_SCHEMAS, getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'
import {
  applicationServicesForEndpoint,
  createUiCapabilityParityReport,
  discoverUiNetworkActions,
} from '../../scripts/generate-ui-capability-parity-report.mjs'

function expectDomainError(callback, code) {
  assert.throws(callback, (error) => error instanceof DomainError && error.code === code)
}

const root = resolve(import.meta.dirname, '../..')

test('the scope-free surface is a closed set, and every member authenticates itself', () => {
  // Renamed from "exposes health and discovery": that stopped being the whole
  // truth before this wave. `media.uploads.content.put` and
  // `media.download-grants.consume` are mutations reachable without a scope
  // because they carry their own proof — a signed upload token, a signed grant.
  // `provider-callbacks.receive` joins them on the same terms: no Bearer token,
  // an HMAC over the exact bytes instead. What the assertion actually protects
  // is that this set stays closed and deliberate.
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
      'apollo.subtitle-styles.list',
      'apollo.subtitle-styles.preview',
      'apollo.director-tools.list',
      'apollo.events.catalog.read',
      'apollo.sessions.switch-workspace',
      'apollo.sessions.oidc-start',
      'apollo.sessions.oidc-callback',
      'apollo.contracts.openapi.read',
      'apollo.contracts.schemas.read',
      'apollo.media.uploads.content.put',
      'apollo.media.download-grants.consume',
      'apollo.projects.localization-canonicals.create',
      'apollo.projects.localization-translations.review',
      'apollo.projects.localization-media.approve',
      'apollo.provider-callbacks.receive',
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
  assert.throws(
    () => assertCapabilityAccess(registry, 'apollo.projects.read', {
      environment: 'production',
      actor: {
        clientId: 'client-scope-1', workspaceId: 'workspace-scope-1',
        environment: 'production', scopes: new Set(),
      },
    }),
    (error) => error instanceof DomainError && error.code === 'AUTH_SCOPE_REQUIRED',
  )
  assert.equal(
    assertCapabilityAccess(registry, 'apollo.projects.read', {
      environment: 'production',
      actor: {
        clientId: 'client-scope-1', workspaceId: 'workspace-scope-1',
        environment: 'production', scopes: new Set(['projects:read']),
      },
    }).id,
    'apollo.projects.read',
  )
  assert.throws(
    () => assertCapabilityAccess(registry, 'apollo.projects.read', {
      environment: 'production',
      actor: {
        clientId: 'client-scope-1', workspaceId: 'workspace-scope-1',
        environment: 'production', scopes: new Set(['projects:read']),
      },
      policy: defineCapabilityAccessPolicy(
        { byClient: { 'client-scope-1': ['apollo.projects.read'] } },
        registry,
      ),
    }),
    (error) => error instanceof DomainError && error.code === 'AUTH_SCOPE_REQUIRED',
  )
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
    { requiredScopes: ['projects:delete'] },
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
  expectDomainError(
    () => defineCapabilityRegistry([{ ...base, requiredScopes: [] }]),
    'INVALID_CAPABILITY',
  )

  assert.ok(FOUNDATION_CAPABILITIES.length >= 189)
  for (const capability of FOUNDATION_CAPABILITIES) {
    assert.ok(['public', 'workspace-admin', 'internal-only'].includes(capability.exposure))
    assert.ok(['free', 'low', 'medium', 'high', 'variable'].includes(capability.costClass))
    assert.ok(['none', 'preflight-token', 'human-approval'].includes(capability.confirmation))
    assert.doesNotThrow(() => getPublicSchema(capability.outputSchemaRef))
    if (capability.inputSchemaRef) assert.doesNotThrow(() => getPublicSchema(capability.inputSchemaRef))
  }
})

test('UI parity requires a public capability or an allowlisted internal-only surface', () => {
  assert.doesNotThrow(() =>
    assertCapabilityParity(
      [
        { id: 'health-button', capabilityId: 'apollo.health.read' },
        { id: 'internal-debug-panel', internalOnlySurfaceId: 'database-row' },
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
  expectDomainError(
    () => assertCapabilityParity(
      [{ id: 'invented-exception', internalOnlySurfaceId: 'because-this-is-private' }],
      FOUNDATION_CAPABILITIES,
    ),
    'CAPABILITY_PARITY_MISSING',
  )
})

test('T-F0-034 internal-only allowlist is justified and absent from public schema keys', () => {
  assert.equal(INTERNAL_ONLY_SURFACES.length, 6)
  const publicPropertyNames = new Set()
  const visit = (value) => {
    if (!value || typeof value !== 'object') return
    if (!Array.isArray(value) && value.properties && typeof value.properties === 'object') {
      for (const key of Object.keys(value.properties)) publicPropertyNames.add(key)
    }
    for (const nested of Array.isArray(value) ? value : Object.values(value)) visit(nested)
  }
  for (const definition of PUBLIC_SCHEMAS) visit(definition.schema)
  for (const surface of INTERNAL_ONLY_SURFACES) {
    assert.ok(surface.reason.length >= 20)
    assert.ok(surface.forbiddenPublicKeys.every((key) => !publicPropertyNames.has(key)))
  }

  const valid = INTERNAL_ONLY_SURFACES[0]
  for (const entries of [
    [valid, valid],
    [{ ...valid, id: 'Invalid Id' }],
    [{ ...valid, category: 'miscellaneous' }],
    [{ ...valid, reason: 'too short' }],
    [{ ...valid, forbiddenPublicKeys: [] }],
  ]) {
    expectDomainError(
      () => defineInternalOnlySurfaceAllowlist(entries),
      'CAPABILITY_PARITY_MISSING',
    )
  }

  const publicCapability = FOUNDATION_CAPABILITIES[0]
  expectDomainError(
    () => defineCapabilityRegistry([{
      ...publicCapability,
      id: 'apollo.internal.test',
      exposure: 'internal-only',
      endpoint: undefined,
      toolName: undefined,
      internalOnlySurfaceId: undefined,
    }]),
    'INVALID_CAPABILITY',
  )
  expectDomainError(
    () => defineCapabilityRegistry([{
      ...publicCapability,
      internalOnlySurfaceId: 'database-row',
    }]),
    'INVALID_CAPABILITY',
  )
  assert.doesNotThrow(() => defineCapabilityRegistry([{
    ...publicCapability,
    id: 'apollo.internal.test',
    exposure: 'internal-only',
    endpoint: undefined,
    toolName: undefined,
    internalOnlySurfaceId: 'database-row',
  }]))
})

test('T-F0-034-ui-capability-binding every operable UI network action resolves to an exposed capabilityId', () => {
  const actions = discoverUiNetworkActions(root)
  const bindings = bindUiNetworkActionsToCapabilities(actions, FOUNDATION_CAPABILITIES)
  assert.ok(bindings.length >= 70)
  assert.equal(bindings.length, actions.length)
  assert.ok(bindings.every((binding) => binding.capabilityId.startsWith('apollo.')))
  assert.ok(bindings.some((binding) => binding.capabilityId === 'apollo.media.uploads.content.put'))
  assert.ok(bindings.some((binding) => binding.capabilityId === 'apollo.projects.version-comparisons.act'))
  assert.ok(bindings.some((binding) => binding.capabilityId === 'apollo.batches.edit-preflights.commit'))

  expectDomainError(
    () => bindUiNetworkActionsToCapabilities(
      [{ id: 'unregistered', method: 'POST', path: '/v1/unregistered' }],
      FOUNDATION_CAPABILITIES,
    ),
    'CAPABILITY_PARITY_MISSING',
  )
  expectDomainError(
    () => bindUiNetworkActionsToCapabilities([actions[0], actions[0]], FOUNDATION_CAPABILITIES),
    'CAPABILITY_PARITY_MISSING',
  )
})

test('T-F0-034 scanner fails closed when canonical reads.read hides its descriptor in a variable', async () => {
  const fixtureRoot = await mkdtemp(resolve(tmpdir(), 'apollo-parity-falsification-'))
  try {
    await mkdir(resolve(fixtureRoot, 'src/app/probe'), { recursive: true })
    await mkdir(resolve(fixtureRoot, 'src/components'), { recursive: true })
    await writeFile(resolve(fixtureRoot, 'src/app/probe/page.tsx'), `
'use client'
export default function Probe() {
  const descriptor = { name: 'annotations', url: '/v1/projects/example/annotations' }
  void reads.read(descriptor)
  return null
}
`)
    assert.throws(
      () => discoverUiNetworkActions(fixtureRoot),
      /canonical reads\.read descriptor must be an object literal with a static url/,
    )
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('T-F0-034 scanner rejects a descriptor spread that replaces the declared url', async () => {
  const fixtureRoot = await mkdtemp(resolve(tmpdir(), 'apollo-parity-spread-'))
  try {
    await mkdir(resolve(fixtureRoot, 'src/app/probe'), { recursive: true })
    await mkdir(resolve(fixtureRoot, 'src/components'), { recursive: true })
    await writeFile(resolve(fixtureRoot, 'src/app/probe/page.tsx'), `
'use client'
export default function Probe(props) {
  const descriptor = { url: '/legacy/hidden' }
  void props.reads.read({ name: 'capabilities', url: '/v1/capabilities', ...descriptor })
  return null
}
`)
    assert.throws(() => discoverUiNetworkActions(fixtureRoot),
      /read coordinator descriptor.*(spread|unambiguous)/)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('T-F0-034 scanner refuses ambiguous descriptor keys and non-GET method metadata', async () => {
  const cases = [
    ['spread before url', "...descriptor, name: 'capabilities', url: '/v1/capabilities'"],
    ['duplicate url', "name: 'capabilities', url: '/v1/capabilities', url: '/legacy/hidden'"],
    ['literal computed url', "name: 'capabilities', url: '/v1/capabilities', ['url']: '/legacy/hidden'"],
    ['dynamic computed url', "name: 'capabilities', url: '/v1/capabilities', [props.key]: '/legacy/hidden'"],
    ['computed method', "name: 'capabilities', url: '/v1/capabilities', ['method']: 'POST'"],
    ['url accessor', "name: 'capabilities', url: '/v1/capabilities', get url() { return '/legacy/hidden' }"],
    ['method accessor', "name: 'capabilities', url: '/v1/capabilities', get method() { return 'POST' }"],
    ['POST method', "name: 'capabilities', url: '/v1/capabilities', method: 'POST'"],
    ['opaque method', "name: 'capabilities', url: '/v1/capabilities', method: props.method"],
    ['duplicate method', "name: 'capabilities', url: '/v1/capabilities', method: 'GET', method: 'POST'"],
    ['shorthand url', "name: 'capabilities', url: '/v1/capabilities', url"],
    ['shorthand method', "name: 'capabilities', url: '/v1/capabilities', method"],
  ]
  for (const [label, properties] of cases) {
    // Successful scans are cached by root; each variant needs a distinct root.
    const fixtureRoot = await mkdtemp(resolve(tmpdir(), 'apollo-parity-ambiguous-'))
    try {
      await mkdir(resolve(fixtureRoot, 'src/app/probe'), { recursive: true })
      await mkdir(resolve(fixtureRoot, 'src/components'), { recursive: true })
      await writeFile(resolve(fixtureRoot, 'src/app/probe/page.tsx'), `
'use client'
export default function Probe(props) {
  const descriptor = { url: '/legacy/hidden' }
  void props.reads.read({ ${properties} })
  return null
}
`)
      assert.throws(() => discoverUiNetworkActions(fixtureRoot),
        /read coordinator descriptor/, label)
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true })
    }
  }
})

test('T-F0-034 scanner binds reads.read and props.reads.read without counting unrelated reads', async () => {
  const fixtureRoot = await mkdtemp(resolve(tmpdir(), 'apollo-parity-coordinator-'))
  try {
    await mkdir(resolve(fixtureRoot, 'src/app/probe'), { recursive: true })
    await mkdir(resolve(fixtureRoot, 'src/components'), { recursive: true })
    await writeFile(resolve(fixtureRoot, 'src/app/probe/page.tsx'), `
'use client'
export default function Probe(props) {
  const query = 'limit=20'
  void reads.read({ name: 'gates', url: \`/v1/projects/\${props.projectId}/synthetic-phase-gates\`, query })
  void props.reads.read({ name: 'capabilities', url: '/v1/capabilities', method: 'GET' })
  void library.read({ url: '/v1/not-a-coordinator' })
  return null
}
`)
    const actions = discoverUiNetworkActions(fixtureRoot)
    assert.deepEqual(actions.map(({ method, path }) => ({ method, path })), [
      { method: 'GET', path: '/v1/projects/{param}/synthetic-phase-gates' },
      { method: 'GET', path: '/v1/capabilities' },
    ])
    const bindings = bindUiNetworkActionsToCapabilities(actions, FOUNDATION_CAPABILITIES)
    assert.deepEqual(bindings.map(({ capabilityId }) => capabilityId), [
      'apollo.projects.synthetic-phase-gates.list', 'apollo.capabilities.list',
    ])
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('T-F0-034 props coordinator rejects opaque URL and non-v1 URL', async () => {
  const fixtureRoot = await mkdtemp(resolve(tmpdir(), 'apollo-parity-opaque-'))
  try {
    await mkdir(resolve(fixtureRoot, 'src/app/probe'), { recursive: true })
    await mkdir(resolve(fixtureRoot, 'src/components'), { recursive: true })
    const page = resolve(fixtureRoot, 'src/app/probe/page.tsx')
    for (const url of ['props.href', "'/legacy/projects'"]) {
      await writeFile(page, `'use client'\nexport default function Probe(props) { void props.reads.read({ name: 'probe', url: ${url} }); return null }\n`)
      assert.throws(() => discoverUiNetworkActions(fixtureRoot),
        /read coordinator descriptor.*(static url|\/v1)/)
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('T-F0-034 scanner classifies parenthesized optional and literal-bracket coordinator reads', async () => {
  const fixtureRoot = await mkdtemp(resolve(tmpdir(), 'apollo-parity-spelling-'))
  try {
    await mkdir(resolve(fixtureRoot, 'src/app/probe'), { recursive: true })
    await mkdir(resolve(fixtureRoot, 'src/components'), { recursive: true })
    await writeFile(resolve(fixtureRoot, 'src/app/probe/page.tsx'), `
'use client'
export default function Probe(props) {
  void (props['reads'])?.['read']?.({ name: 'capabilities', url: '/v1/capabilities' })
  void (reads)?.read?.({ name: 'capabilities', url: '/v1/capabilities' })
  return null
}
`)
    const actions = discoverUiNetworkActions(fixtureRoot)
    assert.deepEqual(actions.map((action) => action.path), ['/v1/capabilities', '/v1/capabilities'])
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('T-F0-034 scanner rejects indirect descriptor and computed coordinator method', async () => {
  const fixtureRoot = await mkdtemp(resolve(tmpdir(), 'apollo-parity-indirect-'))
  try {
    await mkdir(resolve(fixtureRoot, 'src/app/probe'), { recursive: true })
    await mkdir(resolve(fixtureRoot, 'src/components'), { recursive: true })
    const page = resolve(fixtureRoot, 'src/app/probe/page.tsx')
    for (const call of [
      'props.reads.read(descriptor)',
      "props.reads[method]({ name: 'capabilities', url: '/v1/capabilities' })",
    ]) {
      await writeFile(page, `'use client'\nexport default function Probe(props) { const descriptor = { url: '/v1/capabilities' }; void ${call}; return null }\n`)
      assert.throws(() => discoverUiNetworkActions(fixtureRoot),
        /(?:canonical reads\.read descriptor|read coordinator.*method)/)
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('T-F0-034 scanner does not treat unrelated library read methods as Apollo transport', async () => {
  const fixtureRoot = await mkdtemp(resolve(tmpdir(), 'apollo-parity-library-read-'))
  try {
    await mkdir(resolve(fixtureRoot, 'src/app/probe'), { recursive: true })
    await mkdir(resolve(fixtureRoot, 'src/components'), { recursive: true })
    await writeFile(resolve(fixtureRoot, 'src/app/probe/page.tsx'), `
'use client'
export default function Probe() {
  const descriptor = { offset: 0 }
  void library.read(descriptor)
  return null
}
`)
    assert.deepEqual(discoverUiNetworkActions(fixtureRoot), [])
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('T-F0-034-shared-service-boundary UI and external API converge on the same application service boundary', () => {
  const actions = discoverUiNetworkActions(root)
  const bindings = bindUiNetworkActionsToCapabilities(actions, FOUNDATION_CAPABILITIES)
  const capabilities = new Map(FOUNDATION_CAPABILITIES.map((capability) => [capability.id, capability]))
  const missing = bindings
    .map((binding) => {
      const endpoint = capabilities.get(binding.capabilityId)?.endpoint
      assert.ok(endpoint, `bound UI capability lacks public endpoint: ${binding.capabilityId}`)
      return { binding, calls: applicationServicesForEndpoint(root, endpoint) }
    })
    .filter(({ calls }) => calls.length === 0)
  assert.deepEqual(
    missing,
    [],
    'every UI-reachable public API handler must call an imported V2 application service',
  )
})

test('T-F0-034 the parity report counts what it claims instead of publishing two zeros', () => {
  // `unboundActions` and `routesWithoutApplicationService` were literal zeros in
  // the summary. They read as measurements, and no arrangement of the codebase
  // could have moved either one: an action that bound to nothing crashed the
  // binder, and a route reaching no service crashed the service walker. This
  // test is the falsification the numbers were missing — it makes each one
  // non-zero on purpose and reads the name of the offender back out.
  const bound = createUiCapabilityParityReport(root)
  assert.equal(bound.summary.unboundActions, 0)
  assert.equal(bound.summary.routesWithoutApplicationService, 0)

  // Take away one capability the UI calls; its action now resolves to nothing.
  const dropped = bound.rows[0].capabilityId
  const withoutOne = FOUNDATION_CAPABILITIES.filter((entry) => entry.id !== dropped)
  const orphaned = createUiCapabilityParityReport(root, withoutOne)
  assert.ok(orphaned.summary.unboundActions >= 1, 'dropping a bound capability must be counted')
  assert.ok(
    orphaned.unboundActionIds.includes(bound.rows[0].uiAction),
    'the report must name the action that resolved to nothing',
  )

  // A UI action aimed at a real route that imports no application service.
  // `/v1/health` is one, so this measures the walker rather than a missing file.
  const serviceless = createUiCapabilityParityReport(
    root,
    FOUNDATION_CAPABILITIES,
    [{ id: 'probe:health', method: 'GET', path: '/v1/health' }],
  )
  assert.equal(serviceless.summary.uiActions, 1)
  assert.equal(
    serviceless.summary.routesWithoutApplicationService,
    1,
    'a route reaching no application service must be counted',
  )
  assert.deepEqual(
    serviceless.routesWithoutApplicationServiceEndpoints,
    ['GET /v1/health'],
    'the report must name the endpoint that reaches nothing',
  )
})

test('T-FR-240 W28 repository binds each previously missed GET exactly once to its public capability', () => {
  const report = createUiCapabilityParityReport(root)
  const cases = [
    ['src/components/SyntheticPhaseGatePanel.tsx', '/v1/projects/{param}/synthetic-phase-gates', 'apollo.projects.synthetic-phase-gates.list'],
    ['src/components/SyntheticPhaseGatePanel.tsx', '/v1/capabilities', 'apollo.capabilities.list'],
    ['src/components/TransformationCriticReportViewer.tsx', '/v1/projects/{param}/transformation-critic-reports/{param}', 'apollo.projects.transformation-critic-reports.get'],
  ]
  for (const [file, path, capabilityId] of cases) {
    const rows = report.rows.filter((row) => row.uiAction.startsWith(`${file}:`) &&
      row.endpoint === `GET ${FOUNDATION_CAPABILITIES.find((entry) => entry.id === capabilityId)?.endpoint.path}`)
    assert.equal(rows.length, 1, `${file} must bind exactly one ${path} GET`)
    assert.equal(rows[0].capabilityId, capabilityId)
    assert.ok(rows[0].applicationServices.length > 0, 'the bound endpoint reaches an application service')
    const action = discoverUiNetworkActions(root).find((entry) => entry.id === rows[0].uiAction)
    assert.equal(action.path, path)
    assert.equal(action.method, 'GET')
  }
  assert.ok(report.rows.some((row) => row.endpoint.startsWith('POST ')), 'existing mutations remain in the inventory')
  expectDomainError(() => bindUiNetworkActionsToCapabilities(
    [{ id: 'new-unregistered-get', method: 'GET', path: '/v1/unregistered' }],
    FOUNDATION_CAPABILITIES,
  ), 'CAPABILITY_PARITY_MISSING')
})

test('T-F0-034 generated parity report covers actions, capabilities, endpoints and tests', () => {
  const report = createUiCapabilityParityReport(root)
  assert.equal(report.schemaVersion, 'ui-capability-parity-report/v1')
  assert.equal(report.summary.uiActions, report.rows.length)
  assert.ok(report.summary.uiActions >= 70)
  assert.ok(report.summary.capabilities > 0)
  assert.ok(report.summary.endpoints > 0)
  assert.equal(report.summary.unboundActions, 0)
  assert.equal(report.summary.routesWithoutApplicationService, 0)
  assert.equal(report.summary.registeredCapabilities, FOUNDATION_CAPABILITIES.length)
  assert.equal(report.summary.operableCapabilities, FOUNDATION_CAPABILITIES.length)
  assert.equal(report.summary.publicContractCapabilities, FOUNDATION_CAPABILITIES.length)
  assert.equal(report.summary.unjustifiedCapabilities, 0)
  assert.ok(report.rows.every((row) => row.tests.length === 3))
  assert.ok(report.capabilityContracts.every((capability) => capability.tests.length === 1))
})
