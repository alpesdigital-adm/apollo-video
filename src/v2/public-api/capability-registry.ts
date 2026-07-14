import { assertDomain } from '../domain/errors.ts'

export type CapabilityExposure = 'public' | 'workspace-admin' | 'internal-only'
export type CapabilityOperationKind = 'query' | 'command' | 'preflight' | 'job'
export type CapabilityCostClass = 'free' | 'low' | 'medium' | 'high' | 'variable'
export type CapabilityConfirmation = 'none' | 'preflight-token' | 'human-approval'
export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'
export type CapabilityAuthMode = 'none' | 'optional' | 'required'
export type CapabilityIdempotency = 'not-applicable' | 'required' | 'natural'
export type CapabilitySuccessStatus = 200 | 201 | 202 | 204

export interface CapabilityQueryParameter {
  name: string
  description: string
  required: boolean
  schema: Readonly<{
    type: 'string' | 'integer' | 'boolean'
    minimum?: number
    maximum?: number
    default?: string | number | boolean
  }>
}

export interface PublicCapability {
  id: string
  version: string
  title: string
  description: string
  exposure: CapabilityExposure
  operationKind: CapabilityOperationKind
  authMode: CapabilityAuthMode
  requiredScopes: readonly string[]
  inputSchemaRef?: string
  outputSchemaRef: string
  endpoint?: Readonly<{ method: HttpMethod; path: string }>
  toolName?: string
  supportsDryRun: boolean
  costClass: CapabilityCostClass
  confirmation: CapabilityConfirmation
  successStatuses: readonly CapabilitySuccessStatus[]
  idempotency: CapabilityIdempotency
  queryParameters?: readonly CapabilityQueryParameter[]
  requestBodyRequired?: boolean
  responseMediaType?: 'application/json' | 'application/schema+json'
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
  assertDomain(
    capability.authMode === 'required' || capability.requiredScopes.length === 0,
    'INVALID_CAPABILITY',
    'Capabilities with scopes must require authentication',
    { capabilityId: capability.id },
  )
  assertDomain(
    capability.operationKind === 'query'
      ? capability.idempotency === 'not-applicable'
      : capability.idempotency !== 'not-applicable',
    'INVALID_CAPABILITY',
    'Capability idempotency must match its operation kind',
    { capabilityId: capability.id, idempotency: capability.idempotency },
  )
  assertDomain(
    capability.successStatuses.length > 0 &&
      new Set(capability.successStatuses).size === capability.successStatuses.length,
    'INVALID_CAPABILITY',
    'Capability success statuses must be non-empty and unique',
    { capabilityId: capability.id },
  )
  const queryParameterNames = new Set(
    capability.queryParameters?.map((parameter) => parameter.name) ?? [],
  )
  assertDomain(
    queryParameterNames.size === (capability.queryParameters?.length ?? 0),
    'INVALID_CAPABILITY',
    'Capability query parameter names must be unique',
    { capabilityId: capability.id },
  )
  assertDomain(
    capability.inputSchemaRef || capability.requestBodyRequired === undefined,
    'INVALID_CAPABILITY',
    'requestBodyRequired is only valid when an input schema exists',
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
      successStatuses: Object.freeze([...capability.successStatuses]),
      endpoint: capability.endpoint ? Object.freeze({ ...capability.endpoint }) : undefined,
      queryParameters: capability.queryParameters
        ? Object.freeze(
            capability.queryParameters.map((parameter) =>
              Object.freeze({
                ...parameter,
                schema: Object.freeze({ ...parameter.schema }),
              }),
            ),
          )
        : undefined,
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
    authMode: 'none',
    requiredScopes: [],
    outputSchemaRef: 'apollo://schemas/health-response/v1',
    endpoint: { method: 'GET', path: '/v1/health' },
    toolName: 'apollo.health.read',
    supportsDryRun: false,
    costClass: 'free',
    confirmation: 'none',
    successStatuses: [200],
    idempotency: 'not-applicable',
  },
  {
    id: 'apollo.capabilities.list',
    version: '1.0.0',
    title: 'List available capabilities',
    description: 'Lists public capabilities available to the current external actor.',
    exposure: 'public',
    operationKind: 'query',
    authMode: 'optional',
    requiredScopes: [],
    outputSchemaRef: 'apollo://schemas/capability-list/v1',
    endpoint: { method: 'GET', path: '/v1/capabilities' },
    toolName: 'apollo.capabilities.list',
    supportsDryRun: false,
    costClass: 'free',
    confirmation: 'none',
    successStatuses: [200],
    idempotency: 'not-applicable',
  },
  {
    id: 'apollo.projects.list',
    version: '1.0.0',
    title: 'List projects',
    description: 'Lists projects that belong to the authenticated workspace.',
    exposure: 'public',
    operationKind: 'query',
    authMode: 'required',
    requiredScopes: ['projects:read'],
    outputSchemaRef: 'apollo://schemas/project-list/v1',
    endpoint: { method: 'GET', path: '/v1/projects' },
    toolName: 'apollo.projects.list',
    supportsDryRun: false,
    costClass: 'free',
    confirmation: 'none',
    successStatuses: [200],
    idempotency: 'not-applicable',
    queryParameters: [
      {
        name: 'limit',
        description: 'Maximum number of projects to return.',
        required: false,
        schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
    ],
  },
  {
    id: 'apollo.artifacts.read',
    version: '1.0.0',
    title: 'Read media artifact lineage',
    description: 'Returns safe metadata, manifests and ordered source lineage for one workspace artifact.',
    exposure: 'public',
    operationKind: 'query',
    authMode: 'required',
    requiredScopes: ['artifacts:read'],
    outputSchemaRef: 'apollo://schemas/artifact-detail/v1',
    endpoint: { method: 'GET', path: '/v1/artifacts/{artifactId}' },
    toolName: 'apollo.artifacts.read',
    supportsDryRun: false,
    costClass: 'free',
    confirmation: 'none',
    successStatuses: [200],
    idempotency: 'not-applicable',
  },
  {
    id: 'apollo.artifacts.lineage.diagnose',
    version: '1.0.0',
    title: 'Diagnose media artifact lineage',
    description: 'Validates one exact manifest and recursively reports safe lineage health diagnostics.',
    exposure: 'public',
    operationKind: 'query',
    authMode: 'required',
    requiredScopes: ['artifacts:read'],
    outputSchemaRef: 'apollo://schemas/artifact-lineage-diagnostic/v1',
    endpoint: {
      method: 'GET',
      path: '/v1/artifacts/{artifactId}/lineage-diagnostics/{manifestId}',
    },
    toolName: 'apollo.artifacts.lineage.diagnose',
    supportsDryRun: false,
    costClass: 'free',
    confirmation: 'none',
    successStatuses: [200],
    idempotency: 'not-applicable',
  },
  {
    id: 'apollo.artifacts.provenance.read',
    version: '1.0.0',
    title: 'Read artifact execution provenance',
    description: 'Returns versioned tool and model identity hashes for each edge of one exact manifest.',
    exposure: 'public',
    operationKind: 'query',
    authMode: 'required',
    requiredScopes: ['artifacts:read'],
    outputSchemaRef: 'apollo://schemas/artifact-execution-provenance/v1',
    endpoint: {
      method: 'GET',
      path: '/v1/artifacts/{artifactId}/provenance/{manifestId}',
    },
    toolName: 'apollo.artifacts.provenance.read',
    supportsDryRun: false,
    costClass: 'free',
    confirmation: 'none',
    successStatuses: [200],
    idempotency: 'not-applicable',
  },
  {
    id: 'apollo.artifacts.replay-spec.read',
    version: '1.0.0',
    title: 'Read artifact replay specification',
    description: 'Returns content-addressed replay metadata without exposing protected recipe parameters or encryption material.',
    exposure: 'public',
    operationKind: 'query',
    authMode: 'required',
    requiredScopes: ['artifacts:read'],
    outputSchemaRef: 'apollo://schemas/artifact-replay-spec/v1',
    endpoint: {
      method: 'GET',
      path: '/v1/artifacts/{artifactId}/replay-spec/{manifestId}',
    },
    toolName: 'apollo.artifacts.replay-spec.read',
    supportsDryRun: false,
    costClass: 'free',
    confirmation: 'none',
    successStatuses: [200],
    idempotency: 'not-applicable',
  },
  {
    id: 'apollo.render-inputs.preflight',
    version: '1.0.0',
    title: 'Preflight portable render input',
    description: 'Validates portable envelope invariants and hashes a RenderInput without resolving storage locations, validating composition-specific props or starting a render.',
    exposure: 'public',
    operationKind: 'preflight',
    authMode: 'required',
    requiredScopes: ['artifacts:read'],
    inputSchemaRef: 'apollo://schemas/render-input-preflight-request/v1',
    outputSchemaRef: 'apollo://schemas/render-input-preflight/v1',
    endpoint: { method: 'POST', path: '/v1/render-inputs/preflight' },
    toolName: 'apollo.render-inputs.preflight',
    supportsDryRun: false,
    costClass: 'free',
    confirmation: 'none',
    successStatuses: [200],
    idempotency: 'natural',
    requestBodyRequired: true,
  },
  {
    id: 'apollo.contracts.openapi.read',
    version: '1.0.0',
    title: 'Read OpenAPI document',
    description: 'Returns the generated OpenAPI 3.1 contract for public capabilities.',
    exposure: 'public',
    operationKind: 'query',
    authMode: 'none',
    requiredScopes: [],
    outputSchemaRef: 'apollo://schemas/openapi-document/v1',
    endpoint: { method: 'GET', path: '/v1/openapi.json' },
    toolName: 'apollo.contracts.openapi.read',
    supportsDryRun: false,
    costClass: 'free',
    confirmation: 'none',
    successStatuses: [200],
    idempotency: 'not-applicable',
  },
  {
    id: 'apollo.contracts.schemas.read',
    version: '1.0.0',
    title: 'Read JSON Schema',
    description: 'Returns a versioned JSON Schema referenced by a public capability.',
    exposure: 'public',
    operationKind: 'query',
    authMode: 'none',
    requiredScopes: [],
    outputSchemaRef: 'apollo://schemas/json-schema-document/v1',
    endpoint: { method: 'GET', path: '/v1/schemas/{schemaId}/{version}' },
    toolName: 'apollo.contracts.schemas.read',
    supportsDryRun: false,
    costClass: 'free',
    confirmation: 'none',
    successStatuses: [200],
    idempotency: 'not-applicable',
    responseMediaType: 'application/schema+json',
  },
  {
    id: 'apollo.projects.create',
    version: '1.0.0',
    title: 'Create project',
    description: 'Creates a draft project and its immutable initial version.',
    exposure: 'public',
    operationKind: 'command',
    authMode: 'required',
    requiredScopes: ['projects:write'],
    inputSchemaRef: 'apollo://schemas/create-project-request/v1',
    outputSchemaRef: 'apollo://schemas/project-created/v1',
    endpoint: { method: 'POST', path: '/v1/projects' },
    toolName: 'apollo.projects.create',
    supportsDryRun: false,
    costClass: 'free',
    confirmation: 'none',
    successStatuses: [201, 200],
    idempotency: 'required',
  },
  {
    id: 'apollo.clients.list',
    version: '1.0.0',
    title: 'List API clients',
    description: 'Lists API clients belonging to the authenticated workspace.',
    exposure: 'workspace-admin',
    operationKind: 'query',
    authMode: 'required',
    requiredScopes: ['clients:admin'],
    outputSchemaRef: 'apollo://schemas/api-client-list/v1',
    endpoint: { method: 'GET', path: '/v1/workspaces/{workspaceId}/clients' },
    toolName: 'apollo.clients.list',
    supportsDryRun: false,
    costClass: 'free',
    confirmation: 'none',
    successStatuses: [200],
    idempotency: 'not-applicable',
    queryParameters: [
      {
        name: 'limit',
        description: 'Maximum number of API clients to return.',
        required: false,
        schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
    ],
  },
  {
    id: 'apollo.clients.create',
    version: '1.0.0',
    title: 'Create API client',
    description: 'Creates a workspace API client and returns its first credential once.',
    exposure: 'workspace-admin',
    operationKind: 'command',
    authMode: 'required',
    requiredScopes: ['clients:admin'],
    inputSchemaRef: 'apollo://schemas/create-api-client-request/v1',
    outputSchemaRef: 'apollo://schemas/api-client-created/v1',
    endpoint: { method: 'POST', path: '/v1/workspaces/{workspaceId}/clients' },
    toolName: 'apollo.clients.create',
    supportsDryRun: false,
    costClass: 'free',
    confirmation: 'none',
    successStatuses: [201, 200],
    idempotency: 'required',
  },
  {
    id: 'apollo.clients.credentials.rotate',
    version: '1.0.0',
    title: 'Rotate API credential',
    description: 'Creates a new credential and limits the overlap of older credentials.',
    exposure: 'workspace-admin',
    operationKind: 'command',
    authMode: 'required',
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
    successStatuses: [201, 200],
    idempotency: 'required',
    requestBodyRequired: false,
  },
  {
    id: 'apollo.clients.credentials.revoke',
    version: '1.0.0',
    title: 'Revoke API credential',
    description: 'Immediately revokes one API credential without exposing its secret.',
    exposure: 'workspace-admin',
    operationKind: 'command',
    authMode: 'required',
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
    successStatuses: [200],
    idempotency: 'natural',
  },
])
