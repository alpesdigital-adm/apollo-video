import { assertDomain } from '../domain/errors.ts'

export type CapabilityExposure = 'public' | 'workspace-admin' | 'internal-only'
export type CapabilityOperationKind = 'query' | 'command' | 'preflight' | 'job'
export type CapabilityCostClass = 'free' | 'low' | 'medium' | 'high' | 'variable'
export type CapabilityConfirmation = 'none' | 'preflight-token' | 'human-approval'
export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

export interface PublicCapability {
  id: string
  version: string
  title: string
  description: string
  exposure: CapabilityExposure
  operationKind: CapabilityOperationKind
  requiredScopes: readonly string[]
  inputSchemaRef?: string
  outputSchemaRef: string
  endpoint?: Readonly<{ method: HttpMethod; path: string }>
  toolName?: string
  supportsDryRun: boolean
  costClass: CapabilityCostClass
  confirmation: CapabilityConfirmation
}

export interface UiActionDescriptor {
  id: string
  capabilityId?: string
  internalOnlyReason?: string
}

function validateCapability(capability: PublicCapability): void {
  assertDomain(
    /^apollo\.[a-z0-9.-]+$/.test(capability.id),
    'INVALID_CAPABILITY',
    'Capability id must start with apollo. and use lowercase segments',
    { capabilityId: capability.id },
  )
  assertDomain(
    /^\d+\.\d+\.\d+$/.test(capability.version),
    'INVALID_CAPABILITY',
    'Capability version must use semantic x.y.z format',
    { capabilityId: capability.id, version: capability.version },
  )
  assertDomain(
    capability.title.trim().length > 0 && capability.description.trim().length > 0,
    'INVALID_CAPABILITY',
    'Capability title and description are required',
    { capabilityId: capability.id },
  )
  assertDomain(
    capability.outputSchemaRef.trim().length > 0,
    'INVALID_CAPABILITY',
    'Capability outputSchemaRef is required',
    { capabilityId: capability.id },
  )
  assertDomain(
    new Set(capability.requiredScopes).size === capability.requiredScopes.length,
    'INVALID_CAPABILITY',
    'Capability scopes cannot contain duplicates',
    { capabilityId: capability.id },
  )

  if (capability.exposure === 'internal-only') {
    assertDomain(
      !capability.endpoint && !capability.toolName,
      'INVALID_CAPABILITY',
      'Internal-only capabilities cannot publish endpoints or tools',
      { capabilityId: capability.id },
    )
  } else {
    assertDomain(
      Boolean(capability.endpoint),
      'INVALID_CAPABILITY',
      'Externally exposed capabilities require an endpoint',
      { capabilityId: capability.id },
    )
  }

  if (capability.endpoint) {
    assertDomain(
      capability.endpoint.path.startsWith('/v1/'),
      'INVALID_CAPABILITY',
      'Public endpoint paths must be versioned under /v1',
      { capabilityId: capability.id, path: capability.endpoint.path },
    )
  }

  if (capability.costClass === 'high' || capability.costClass === 'variable') {
    assertDomain(
      capability.confirmation !== 'none',
      'INVALID_CAPABILITY',
      'High or variable cost capabilities require confirmation',
      { capabilityId: capability.id, costClass: capability.costClass },
    )
  }
}

export function defineCapabilityRegistry(
  capabilities: readonly PublicCapability[],
): readonly Readonly<PublicCapability>[] {
  const ids = new Set<string>()
  const endpoints = new Set<string>()
  const tools = new Set<string>()

  const registry = capabilities.map((capability) => {
    validateCapability(capability)
    const identity = `${capability.id}@${capability.version}`
    assertDomain(
      !ids.has(identity),
      'DUPLICATE_CAPABILITY',
      'Capability id and version must be unique',
      { identity },
    )
    ids.add(identity)

    if (capability.endpoint) {
      const endpointIdentity = `${capability.endpoint.method} ${capability.endpoint.path}`
      assertDomain(
        !endpoints.has(endpointIdentity),
        'DUPLICATE_CAPABILITY',
        'Public endpoint must map to one capability',
        { endpoint: endpointIdentity },
      )
      endpoints.add(endpointIdentity)
    }

    if (capability.toolName) {
      assertDomain(
        !tools.has(capability.toolName),
        'DUPLICATE_CAPABILITY',
        'Tool name must be unique',
        { toolName: capability.toolName },
      )
      tools.add(capability.toolName)
    }

    return Object.freeze({
      ...capability,
      requiredScopes: Object.freeze([...capability.requiredScopes]),
      endpoint: capability.endpoint ? Object.freeze({ ...capability.endpoint }) : undefined,
    })
  })

  return Object.freeze(registry)
}

export function capabilitiesForScopes(
  registry: readonly PublicCapability[],
  grantedScopes: ReadonlySet<string>,
): readonly PublicCapability[] {
  return registry.filter(
    (capability) =>
      capability.exposure !== 'internal-only' &&
      capability.requiredScopes.every((scope) => grantedScopes.has(scope)),
  )
}

export function assertCapabilityParity(
  actions: readonly UiActionDescriptor[],
  registry: readonly PublicCapability[],
): void {
  const exposedCapabilities = new Set(
    registry
      .filter((capability) => capability.exposure !== 'internal-only')
      .map((capability) => capability.id),
  )

  for (const action of actions) {
    const hasCapability =
      Boolean(action.capabilityId) && exposedCapabilities.has(action.capabilityId as string)
    const hasInternalReason = Boolean(action.internalOnlyReason?.trim())

    assertDomain(
      hasCapability || hasInternalReason,
      'CAPABILITY_PARITY_MISSING',
      'UI action must map to a public capability or an explicit internal-only reason',
      { actionId: action.id, capabilityId: action.capabilityId },
    )
    assertDomain(
      !(hasCapability && hasInternalReason),
      'CAPABILITY_PARITY_MISSING',
      'UI action cannot be both public and internal-only',
      { actionId: action.id, capabilityId: action.capabilityId },
    )
  }
}

export const FOUNDATION_CAPABILITIES = defineCapabilityRegistry([
  {
    id: 'apollo.health.read',
    version: '1.0.0',
    title: 'Read API health',
    description: 'Returns a non-sensitive liveness response for the Apollo public API.',
    exposure: 'public',
    operationKind: 'query',
    requiredScopes: [],
    outputSchemaRef: 'apollo://schemas/health-response/v1',
    endpoint: { method: 'GET', path: '/v1/health' },
    toolName: 'apollo.health.read',
    supportsDryRun: false,
    costClass: 'free',
    confirmation: 'none',
  },
  {
    id: 'apollo.capabilities.list',
    version: '1.0.0',
    title: 'List available capabilities',
    description: 'Lists public capabilities available to the current external actor.',
    exposure: 'public',
    operationKind: 'query',
    requiredScopes: [],
    outputSchemaRef: 'apollo://schemas/capability-list/v1',
    endpoint: { method: 'GET', path: '/v1/capabilities' },
    toolName: 'apollo.capabilities.list',
    supportsDryRun: false,
    costClass: 'free',
    confirmation: 'none',
  },
  {
    id: 'apollo.projects.list',
    version: '1.0.0',
    title: 'List projects',
    description: 'Lists projects that belong to the authenticated workspace.',
    exposure: 'public',
    operationKind: 'query',
    requiredScopes: ['projects:read'],
    outputSchemaRef: 'apollo://schemas/project-list/v1',
    endpoint: { method: 'GET', path: '/v1/projects' },
    toolName: 'apollo.projects.list',
    supportsDryRun: false,
    costClass: 'free',
    confirmation: 'none',
  },
  {
    id: 'apollo.projects.create',
    version: '1.0.0',
    title: 'Create project',
    description: 'Creates a draft project and its immutable initial version.',
    exposure: 'public',
    operationKind: 'command',
    requiredScopes: ['projects:write'],
    inputSchemaRef: 'apollo://schemas/create-project-request/v1',
    outputSchemaRef: 'apollo://schemas/project-created/v1',
    endpoint: { method: 'POST', path: '/v1/projects' },
    toolName: 'apollo.projects.create',
    supportsDryRun: false,
    costClass: 'free',
    confirmation: 'none',
  },
  {
    id: 'apollo.clients.list',
    version: '1.0.0',
    title: 'List API clients',
    description: 'Lists API clients belonging to the authenticated workspace.',
    exposure: 'workspace-admin',
    operationKind: 'query',
    requiredScopes: ['clients:admin'],
    outputSchemaRef: 'apollo://schemas/api-client-list/v1',
    endpoint: { method: 'GET', path: '/v1/workspaces/{workspaceId}/clients' },
    toolName: 'apollo.clients.list',
    supportsDryRun: false,
    costClass: 'free',
    confirmation: 'none',
  },
  {
    id: 'apollo.clients.create',
    version: '1.0.0',
    title: 'Create API client',
    description: 'Creates a workspace API client and returns its first credential once.',
    exposure: 'workspace-admin',
    operationKind: 'command',
    requiredScopes: ['clients:admin'],
    inputSchemaRef: 'apollo://schemas/create-api-client-request/v1',
    outputSchemaRef: 'apollo://schemas/api-client-created/v1',
    endpoint: { method: 'POST', path: '/v1/workspaces/{workspaceId}/clients' },
    toolName: 'apollo.clients.create',
    supportsDryRun: false,
    costClass: 'free',
    confirmation: 'none',
  },
  {
    id: 'apollo.clients.credentials.rotate',
    version: '1.0.0',
    title: 'Rotate API credential',
    description: 'Creates a new credential and limits the overlap of older credentials.',
    exposure: 'workspace-admin',
    operationKind: 'command',
    requiredScopes: ['clients:admin'],
    inputSchemaRef: 'apollo://schemas/rotate-api-credential-request/v1',
    outputSchemaRef: 'apollo://schemas/api-credential-created/v1',
    endpoint: {
      method: 'POST',
      path: '/v1/workspaces/{workspaceId}/clients/{clientId}/credentials',
    },
    toolName: 'apollo.clients.credentials.rotate',
    supportsDryRun: false,
    costClass: 'free',
    confirmation: 'none',
  },
  {
    id: 'apollo.clients.credentials.revoke',
    version: '1.0.0',
    title: 'Revoke API credential',
    description: 'Immediately revokes one API credential without exposing its secret.',
    exposure: 'workspace-admin',
    operationKind: 'command',
    requiredScopes: ['clients:admin'],
    outputSchemaRef: 'apollo://schemas/api-credential-revoked/v1',
    endpoint: {
      method: 'DELETE',
      path: '/v1/workspaces/{workspaceId}/clients/{clientId}/credentials/{credentialId}',
    },
    toolName: 'apollo.clients.credentials.revoke',
    supportsDryRun: false,
    costClass: 'free',
    confirmation: 'none',
  },
])
