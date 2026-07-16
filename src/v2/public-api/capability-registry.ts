import { assertDomain } from '../domain/errors.ts'

export type CapabilityExposure = 'public' | 'workspace-admin' | 'internal-only'
export type CapabilityOperationKind = 'query' | 'command' | 'preflight' | 'job'
export type CapabilityCostClass = 'free' | 'low' | 'medium' | 'high' | 'variable'
export type CapabilityConfirmation = 'none' | 'preflight-token' | 'human-approval'
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type CapabilityAuthMode = 'none' | 'optional' | 'required'
export type CapabilityIdempotency = 'not-applicable' | 'required' | 'natural'
export type CapabilityPrecondition = 'if-match'
export type CapabilitySuccessStatus = 200 | 201 | 202 | 204

export interface CapabilityQueryParameter {
  name: string
  description: string
  required: boolean
  schema: Readonly<{
    type: 'string' | 'integer' | 'boolean'
    minimum?: number
    maximum?: number
    minLength?: number
    maxLength?: number
    enum?: readonly (string | number | boolean)[]
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
  precondition?: CapabilityPrecondition
  responseEtag?: boolean
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
  assertDomain(
    capability.precondition === undefined || capability.operationKind !== 'query',
    'INVALID_CAPABILITY',
    'Query capabilities cannot require mutation preconditions',
    { capabilityId: capability.id },
  )
  assertDomain(
    capability.precondition === undefined || capability.responseEtag === true,
    'INVALID_CAPABILITY',
    'If-Match capabilities must return the resulting ETag',
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
  if (capability.toolName) {
    assertDomain(
      /^[a-z][a-z0-9_.-]{2,127}$/.test(capability.toolName),
      'INVALID_CAPABILITY',
      'Tool name must be stable, bounded and MCP-safe',
      { capabilityId: capability.id, toolName: capability.toolName },
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
    id: 'apollo.tools.list',
    version: '1.0.0',
    title: 'List available agent tools',
    description: 'Returns scope-filtered tool descriptors with composed input, output and structured error schemas.',
    exposure: 'public',
    operationKind: 'query',
    authMode: 'optional',
    requiredScopes: [],
    outputSchemaRef: 'apollo://schemas/agent-tool-list/v1',
    endpoint: { method: 'GET', path: '/v1/tools' },
    toolName: 'apollo.tools.list',
    supportsDryRun: false,
    costClass: 'free',
    confirmation: 'none',
    successStatuses: [200],
    idempotency: 'not-applicable',
  },
  {
    id: 'apollo.events.catalog.read',
    version: '1.0.0',
    title: 'Read public event catalog',
    description: 'Lists versioned public event types and their canonical resource kinds without exposing workspace data.',
    exposure: 'public',
    operationKind: 'query',
    authMode: 'none',
    requiredScopes: [],
    outputSchemaRef: 'apollo://schemas/event-catalog/v1',
    endpoint: { method: 'GET', path: '/v1/events/catalog' },
    toolName: 'apollo.events.catalog.read',
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
    id: 'apollo.artifacts.render-input.read',
    version: '1.0.0',
    title: 'Read artifact RenderInput metadata',
    description: 'Returns content-addressed RenderInput metadata without exposing protected props, asset payloads or encryption material.',
    exposure: 'public',
    operationKind: 'query',
    authMode: 'required',
    requiredScopes: ['artifacts:read'],
    outputSchemaRef: 'apollo://schemas/artifact-render-input/v1',
    endpoint: {
      method: 'GET',
      path: '/v1/artifacts/{artifactId}/render-input/{manifestId}',
    },
    toolName: 'apollo.artifacts.render-input.read',
    supportsDryRun: false,
    costClass: 'free',
    confirmation: 'none',
    successStatuses: [200],
    idempotency: 'not-applicable',
  },
  {
    id: 'apollo.artifacts.reconstruction.preflight',
    version: '1.0.0',
    title: 'Preflight artifact reconstruction',
    description: 'Authenticates a protected RenderInput and checks exact renderer, composition and workspace asset identity without exposing payloads, materializing assets or starting a render.',
    exposure: 'public',
    operationKind: 'preflight',
    authMode: 'required',
    requiredScopes: ['artifacts:read'],
    outputSchemaRef: 'apollo://schemas/artifact-reconstruction-preflight/v1',
    endpoint: {
      method: 'POST',
      path: '/v1/artifacts/{artifactId}/reconstruction-preflight/{manifestId}',
    },
    toolName: 'apollo.artifacts.reconstruction.preflight',
    supportsDryRun: false,
    costClass: 'free',
    confirmation: 'none',
    successStatuses: [200],
    idempotency: 'natural',
  },
  {
    id: 'apollo.artifacts.rights.read',
    version: '1.0.0',
    title: 'Read current asset rights',
    description: 'Returns the current immutable rights and consent snapshot for one workspace artifact.',
    exposure: 'public',
    operationKind: 'query',
    authMode: 'required',
    requiredScopes: ['artifacts:rights'],
    outputSchemaRef: 'apollo://schemas/asset-rights-current/v1',
    endpoint: { method: 'GET', path: '/v1/artifacts/{artifactId}/rights' },
    toolName: 'apollo.artifacts.rights.read',
    supportsDryRun: false,
    costClass: 'free',
    confirmation: 'none',
    successStatuses: [200],
    idempotency: 'not-applicable',
    responseEtag: true,
  },
  {
    id: 'apollo.artifacts.rights.set',
    version: '2.0.0',
    title: 'Set current asset rights',
    description: 'Creates or reuses an immutable rights and consent snapshot under the strong If-Match ETag returned by the latest rights read.',
    exposure: 'public',
    operationKind: 'command',
    authMode: 'required',
    requiredScopes: ['artifacts:rights'],
    inputSchemaRef: 'apollo://schemas/set-asset-rights-request/v1',
    outputSchemaRef: 'apollo://schemas/asset-rights-set/v1',
    endpoint: { method: 'PUT', path: '/v1/artifacts/{artifactId}/rights' },
    toolName: 'apollo.artifacts.rights.set',
    supportsDryRun: false,
    costClass: 'free',
    confirmation: 'none',
    successStatuses: [200],
    idempotency: 'natural',
    precondition: 'if-match',
    responseEtag: true,
    requestBodyRequired: true,
  },
  {
    id: 'apollo.artifacts.materialization.authorize',
    version: '1.0.0',
    title: 'Authorize RenderInput materialization',
    description: 'Authenticates a protected RenderInput, applies current rights and consent to every asset, and records an auditable short-lived authorization without exposing storage locations.',
    exposure: 'public',
    operationKind: 'command',
    authMode: 'required',
    requiredScopes: ['artifacts:render'],
    inputSchemaRef: 'apollo://schemas/authorize-materialization-request/v1',
    outputSchemaRef: 'apollo://schemas/materialization-authorization/v1',
    endpoint: {
      method: 'POST',
      path: '/v1/artifacts/{artifactId}/materialization-authorizations/{manifestId}',
    },
    toolName: 'apollo.artifacts.materialization.authorize',
    supportsDryRun: false,
    costClass: 'free',
    confirmation: 'none',
    successStatuses: [201, 200],
    idempotency: 'required',
    requestBodyRequired: true,
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
    id: 'apollo.artifacts.render.enqueue',
    version: '1.0.0',
    title: 'Enqueue authorized artifact render',
    description: 'Creates an idempotent durable operation for an exact artifact manifest and an authorization issued to the same API client.',
    exposure: 'public',
    operationKind: 'job',
    authMode: 'required',
    requiredScopes: ['artifacts:render'],
    inputSchemaRef: 'apollo://schemas/enqueue-artifact-render-request/v1',
    outputSchemaRef: 'apollo://schemas/artifact-render-operation-accepted/v1',
    endpoint: { method: 'POST', path: '/v1/artifacts/{artifactId}/renders/{manifestId}' },
    toolName: 'apollo.artifacts.render.enqueue',
    supportsDryRun: false,
    costClass: 'medium',
    confirmation: 'none',
    successStatuses: [202],
    idempotency: 'required',
    requestBodyRequired: true,
  },
  {
    id: 'apollo.operations.list',
    version: '1.0.0',
    title: 'List public operations',
    description: 'Returns one stable cursor page of safe workspace operation metadata with allowlisted filters.',
    exposure: 'public',
    operationKind: 'query',
    authMode: 'required',
    requiredScopes: ['operations:read'],
    outputSchemaRef: 'apollo://schemas/public-operation-list/v1',
    endpoint: { method: 'GET', path: '/v1/operations' },
    toolName: 'apollo.operations.list',
    supportsDryRun: false,
    costClass: 'free',
    confirmation: 'none',
    successStatuses: [200],
    idempotency: 'not-applicable',
    queryParameters: [
      {
        name: 'limit',
        description: 'Maximum number of operations to return.',
        required: false,
        schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      {
        name: 'after',
        description: 'Opaque cursor returned by the previous page with the same filters.',
        required: false,
        schema: { type: 'string', minLength: 8, maxLength: 1024 },
      },
      {
        name: 'status',
        description: 'Exact public operation status.',
        required: false,
        schema: {
          type: 'string',
          enum: ['queued', 'running', 'waiting', 'retrying', 'succeeded', 'failed', 'canceled'],
        },
      },
      {
        name: 'type',
        description: 'Exact public operation type.',
        required: false,
        schema: { type: 'string', enum: ['artifact-render'] },
      },
      {
        name: 'targetId',
        description: 'Exact target resource identifier.',
        required: false,
        schema: { type: 'string', minLength: 3, maxLength: 128 },
      },
    ],
  },
  {
    id: 'apollo.operations.dead-letter.list',
    version: '1.0.0',
    title: 'List dead-letter operations',
    description: 'Returns failed workspace operations whose automatic retry capacity was exhausted and that may be considered for manual retry.',
    exposure: 'public',
    operationKind: 'query',
    authMode: 'required',
    requiredScopes: ['operations:read'],
    outputSchemaRef: 'apollo://schemas/public-operation-list/v1',
    endpoint: { method: 'GET', path: '/v1/operations/dead-letter' },
    toolName: 'apollo.operations.dead-letter.list',
    supportsDryRun: false,
    costClass: 'free',
    confirmation: 'none',
    successStatuses: [200],
    idempotency: 'not-applicable',
    queryParameters: [
      {
        name: 'limit',
        description: 'Maximum number of dead-letter operations to return.',
        required: false,
        schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      {
        name: 'after',
        description: 'Opaque cursor returned by the previous dead-letter page with the same filters.',
        required: false,
        schema: { type: 'string', minLength: 8, maxLength: 1024 },
      },
      {
        name: 'type',
        description: 'Exact public operation type.',
        required: false,
        schema: { type: 'string', enum: ['artifact-render'] },
      },
      {
        name: 'targetId',
        description: 'Exact target resource identifier.',
        required: false,
        schema: { type: 'string', minLength: 3, maxLength: 128 },
      },
    ],
  },
  {
    id: 'apollo.operations.read',
    version: '1.0.0',
    title: 'Read public operation',
    description: 'Returns safe status, progress, target and terminal result metadata for one workspace operation.',
    exposure: 'public',
    operationKind: 'query',
    authMode: 'required',
    requiredScopes: ['operations:read'],
    outputSchemaRef: 'apollo://schemas/public-operation-detail/v1',
    endpoint: { method: 'GET', path: '/v1/operations/{operationId}' },
    toolName: 'apollo.operations.read',
    supportsDryRun: false,
    costClass: 'free',
    confirmation: 'none',
    successStatuses: [200],
    idempotency: 'not-applicable',
  },
  {
    id: 'apollo.operations.cancel',
    version: '1.0.0',
    title: 'Cancel public operation',
    description: 'Idempotently cancels a queued, waiting, retrying or running workspace operation and invalidates any active worker lease.',
    exposure: 'public',
    operationKind: 'command',
    authMode: 'required',
    requiredScopes: ['operations:cancel'],
    outputSchemaRef: 'apollo://schemas/public-operation-detail/v1',
    endpoint: { method: 'POST', path: '/v1/operations/{operationId}/cancel' },
    toolName: 'apollo.operations.cancel',
    supportsDryRun: false,
    costClass: 'free',
    confirmation: 'human-approval',
    successStatuses: [200],
    idempotency: 'natural',
  },
  {
    id: 'apollo.operations.retry',
    version: '1.0.0',
    title: 'Retry public operation',
    description: 'Requeues a failed or canceled workspace operation while preserving its protected context and attempt history.',
    exposure: 'public',
    operationKind: 'command',
    authMode: 'required',
    requiredScopes: ['operations:retry'],
    outputSchemaRef: 'apollo://schemas/public-operation-detail/v1',
    endpoint: { method: 'POST', path: '/v1/operations/{operationId}/retry' },
    toolName: 'apollo.operations.retry',
    supportsDryRun: false,
    costClass: 'medium',
    confirmation: 'human-approval',
    successStatuses: [200],
    idempotency: 'natural',
  },
  {
    id: 'apollo.webhooks.endpoints.create', version: '1.0.0', title: 'Create webhook endpoint',
    description: 'Creates a pending HTTPS endpoint with a generated encrypted signing secret and durable idempotency.',
    exposure: 'workspace-admin', operationKind: 'command', authMode: 'required', requiredScopes: ['webhooks:admin'],
    inputSchemaRef: 'apollo://schemas/create-webhook-endpoint-request/v1',
    outputSchemaRef: 'apollo://schemas/webhook-endpoint-created/v1', endpoint: { method: 'POST', path: '/v1/webhooks/endpoints' },
    toolName: 'apollo.webhooks.endpoints.create', supportsDryRun: false, costClass: 'free', confirmation: 'human-approval', successStatuses: [200, 201], idempotency: 'required', requestBodyRequired: true,
  },
  {
    id: 'apollo.webhooks.endpoints.list',
    version: '1.0.0',
    title: 'List webhook endpoints',
    description: 'Lists workspace webhook endpoints with redacted destinations and signing-secret metadata.',
    exposure: 'workspace-admin', operationKind: 'query', authMode: 'required',
    requiredScopes: ['webhooks:admin'], outputSchemaRef: 'apollo://schemas/webhook-endpoint-list/v1',
    endpoint: { method: 'GET', path: '/v1/webhooks/endpoints' }, toolName: 'apollo.webhooks.endpoints.list',
    supportsDryRun: false, costClass: 'free', confirmation: 'none', successStatuses: [200], idempotency: 'not-applicable',
    queryParameters: [
      { name: 'limit', description: 'Page size from 1 to 100.', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
      { name: 'after', description: 'Opaque cursor bound to the filters.', required: false, schema: { type: 'string', minLength: 8, maxLength: 1024 } },
      { name: 'status', description: 'Exact endpoint status.', required: false, schema: { type: 'string', enum: ['pending-verification', 'active', 'suspended', 'revoked'] } },
    ],
  },
  {
    id: 'apollo.webhooks.endpoints.read', version: '1.0.0', title: 'Read webhook endpoint',
    description: 'Returns one redacted endpoint and up to 100 signing-secret metadata versions without key references.',
    exposure: 'workspace-admin', operationKind: 'query', authMode: 'required', requiredScopes: ['webhooks:admin'],
    outputSchemaRef: 'apollo://schemas/webhook-endpoint-detail/v1', endpoint: { method: 'GET', path: '/v1/webhooks/endpoints/{endpointId}' },
    toolName: 'apollo.webhooks.endpoints.read', supportsDryRun: false, costClass: 'free', confirmation: 'none', successStatuses: [200], idempotency: 'not-applicable',
  },
  {
    id: 'apollo.webhooks.endpoints.status.set', version: '1.0.0',
    title: 'Set webhook endpoint status',
    description: 'Suspends, resumes or irrevocably revokes an endpoint and applies its subscription/secret cascade atomically.',
    exposure: 'workspace-admin', operationKind: 'command', authMode: 'required',
    requiredScopes: ['webhooks:admin'],
    inputSchemaRef: 'apollo://schemas/set-webhook-endpoint-status-request/v1',
    outputSchemaRef: 'apollo://schemas/webhook-endpoint-status-result/v1',
    endpoint: { method: 'PUT', path: '/v1/webhooks/endpoints/{endpointId}/status' },
    toolName: 'apollo.webhooks.endpoints.status.set', supportsDryRun: false,
    costClass: 'free', confirmation: 'human-approval', successStatuses: [200],
    idempotency: 'natural', requestBodyRequired: true,
  },
  {
    id: 'apollo.webhooks.endpoints.challenge', version: '1.0.0',
    title: 'Challenge webhook endpoint',
    description: 'Performs a DNS-pinned HTTPS proof challenge and convergently activates a pending endpoint and its pending subscriptions.',
    exposure: 'workspace-admin', operationKind: 'command', authMode: 'required',
    requiredScopes: ['webhooks:admin'],
    outputSchemaRef: 'apollo://schemas/webhook-endpoint-challenge-result/v1',
    endpoint: { method: 'POST', path: '/v1/webhooks/endpoints/{endpointId}/challenge' },
    toolName: 'apollo.webhooks.endpoints.challenge', supportsDryRun: false,
    costClass: 'low', confirmation: 'human-approval', successStatuses: [200],
    idempotency: 'natural',
  },
  {
    id: 'apollo.webhooks.endpoints.signing-secrets.provision', version: '1.0.0',
    title: 'Provision webhook signing secret',
    description: 'Replaces the secret of a pending endpoint and discloses the new HMAC material only in the first response.',
    exposure: 'workspace-admin', operationKind: 'command', authMode: 'required',
    requiredScopes: ['webhooks:admin'],
    inputSchemaRef: 'apollo://schemas/provision-webhook-signing-secret-request/v1',
    outputSchemaRef: 'apollo://schemas/webhook-signing-secret-provisioned/v1',
    endpoint: { method: 'POST', path: '/v1/webhooks/endpoints/{endpointId}/signing-secrets' },
    toolName: 'apollo.webhooks.endpoints.signing-secrets.provision', supportsDryRun: false,
    costClass: 'free', confirmation: 'human-approval', successStatuses: [200, 201],
    idempotency: 'required', requestBodyRequired: true,
  },
  {
    id: 'apollo.webhooks.endpoints.signing-secrets.rotations.stage', version: '1.0.0',
    title: 'Stage webhook signing secret rotation',
    description: 'Stages a new HMAC secret for an active endpoint without changing outbound signatures and discloses it only once.',
    exposure: 'workspace-admin', operationKind: 'command', authMode: 'required',
    requiredScopes: ['webhooks:admin'],
    inputSchemaRef: 'apollo://schemas/stage-webhook-signing-secret-rotation-request/v1',
    outputSchemaRef: 'apollo://schemas/webhook-signing-secret-rotation-staged/v1',
    endpoint: { method: 'POST', path: '/v1/webhooks/endpoints/{endpointId}/signing-secrets/rotations' },
    toolName: 'apollo.webhooks.endpoints.signing-secrets.rotations.stage', supportsDryRun: false,
    costClass: 'free', confirmation: 'human-approval', successStatuses: [200, 201],
    idempotency: 'required', requestBodyRequired: true,
  },
  {
    id: 'apollo.webhooks.endpoints.signing-secrets.rotations.activate', version: '1.0.0',
    title: 'Activate webhook signing secret rotation',
    description: 'Atomically activates a staged HMAC secret and keeps the previous version usable only through its recorded overlap window.',
    exposure: 'workspace-admin', operationKind: 'command', authMode: 'required',
    requiredScopes: ['webhooks:admin'],
    inputSchemaRef: 'apollo://schemas/activate-webhook-signing-secret-rotation-request/v1',
    outputSchemaRef: 'apollo://schemas/webhook-signing-secret-rotation-activated/v1',
    endpoint: { method: 'POST', path: '/v1/webhooks/endpoints/{endpointId}/signing-secrets/rotations/{rotationId}/activate' },
    toolName: 'apollo.webhooks.endpoints.signing-secrets.rotations.activate', supportsDryRun: false,
    costClass: 'free', confirmation: 'human-approval', successStatuses: [200],
    idempotency: 'natural', requestBodyRequired: true,
  },
  {
    id: 'apollo.webhooks.endpoints.signing-secrets.rotations.cancel', version: '1.0.0',
    title: 'Cancel webhook signing secret rotation',
    description: 'Convergently cancels or expires an unactivated HMAC rotation and destroys its staged encrypted envelope.',
    exposure: 'workspace-admin', operationKind: 'command', authMode: 'required',
    requiredScopes: ['webhooks:admin'],
    inputSchemaRef: 'apollo://schemas/cancel-webhook-signing-secret-rotation-request/v1',
    outputSchemaRef: 'apollo://schemas/webhook-signing-secret-rotation-cancelled/v1',
    endpoint: { method: 'POST', path: '/v1/webhooks/endpoints/{endpointId}/signing-secrets/rotations/{rotationId}/cancel' },
    toolName: 'apollo.webhooks.endpoints.signing-secrets.rotations.cancel', supportsDryRun: false,
    costClass: 'free', confirmation: 'human-approval', successStatuses: [200],
    idempotency: 'natural', requestBodyRequired: true,
  },
  {
    id: 'apollo.webhooks.endpoints.signing-secrets.rotations.list', version: '1.0.0',
    title: 'List webhook signing secret rotations',
    description: 'Lists redacted signing-secret rotation metadata for one workspace endpoint with a stable filter-bound cursor.',
    exposure: 'workspace-admin', operationKind: 'query', authMode: 'required',
    requiredScopes: ['webhooks:admin'],
    outputSchemaRef: 'apollo://schemas/webhook-signing-secret-rotation-list/v1',
    endpoint: { method: 'GET', path: '/v1/webhooks/endpoints/{endpointId}/signing-secrets/rotations' },
    toolName: 'apollo.webhooks.endpoints.signing-secrets.rotations.list', supportsDryRun: false,
    costClass: 'free', confirmation: 'none', successStatuses: [200], idempotency: 'not-applicable',
    queryParameters: [
      { name: 'limit', description: 'Page size from 1 to 100.', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
      { name: 'after', description: 'Opaque cursor bound to this endpoint and status filter.', required: false, schema: { type: 'string', minLength: 8, maxLength: 1024 } },
      { name: 'status', description: 'Exact rotation status.', required: false, schema: { type: 'string', enum: ['staged', 'activated', 'cancelled', 'expired'] } },
    ],
  },
  {
    id: 'apollo.webhooks.endpoints.signing-secrets.rotations.read', version: '1.0.0',
    title: 'Read webhook signing secret rotation',
    description: 'Returns one workspace- and endpoint-scoped rotation without secret identifiers, key references or encrypted envelope fields.',
    exposure: 'workspace-admin', operationKind: 'query', authMode: 'required', requiredScopes: ['webhooks:admin'],
    outputSchemaRef: 'apollo://schemas/webhook-signing-secret-rotation-detail/v1',
    endpoint: { method: 'GET', path: '/v1/webhooks/endpoints/{endpointId}/signing-secrets/rotations/{rotationId}' },
    toolName: 'apollo.webhooks.endpoints.signing-secrets.rotations.read', supportsDryRun: false,
    costClass: 'free', confirmation: 'none', successStatuses: [200], idempotency: 'not-applicable',
  },
  {
    id: 'apollo.webhooks.signing-secrets.hygiene.run', version: '1.0.0',
    title: 'Run webhook signing secret hygiene',
    description: 'Expires a bounded page of stale staged rotations and destroys payloads for revoked or overlap-expired signing secrets in the authenticated workspace.',
    exposure: 'workspace-admin', operationKind: 'command', authMode: 'required', requiredScopes: ['webhooks:admin'],
    inputSchemaRef: 'apollo://schemas/run-webhook-signing-secret-hygiene-request/v1',
    outputSchemaRef: 'apollo://schemas/webhook-signing-secret-hygiene-result/v1',
    endpoint: { method: 'POST', path: '/v1/webhooks/signing-secrets/hygiene' },
    toolName: 'apollo.webhooks.signing-secrets.hygiene.run', supportsDryRun: false,
    costClass: 'free', confirmation: 'human-approval', successStatuses: [200],
    idempotency: 'natural', requestBodyRequired: true,
  },
  {
    id: 'apollo.webhooks.subscriptions.create', version: '1.0.0',
    title: 'Create webhook subscription',
    description: 'Creates one exact event/resource subscription for an existing workspace endpoint with durable idempotency.',
    exposure: 'workspace-admin', operationKind: 'command', authMode: 'required',
    requiredScopes: ['webhooks:admin'],
    inputSchemaRef: 'apollo://schemas/create-webhook-subscription-request/v1',
    outputSchemaRef: 'apollo://schemas/webhook-subscription-created/v1',
    endpoint: { method: 'POST', path: '/v1/webhooks/subscriptions' },
    toolName: 'apollo.webhooks.subscriptions.create', supportsDryRun: false,
    costClass: 'free', confirmation: 'human-approval', successStatuses: [200, 201],
    idempotency: 'required', requestBodyRequired: true,
  },
  {
    id: 'apollo.webhooks.subscriptions.list', version: '1.0.0', title: 'List webhook subscriptions',
    description: 'Lists workspace webhook subscriptions and their exact event/resource filters.',
    exposure: 'workspace-admin', operationKind: 'query', authMode: 'required', requiredScopes: ['webhooks:admin'],
    outputSchemaRef: 'apollo://schemas/webhook-subscription-list/v1', endpoint: { method: 'GET', path: '/v1/webhooks/subscriptions' },
    toolName: 'apollo.webhooks.subscriptions.list', supportsDryRun: false, costClass: 'free', confirmation: 'none', successStatuses: [200], idempotency: 'not-applicable',
    queryParameters: [
      { name: 'limit', description: 'Page size from 1 to 100.', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
      { name: 'after', description: 'Opaque cursor bound to the filters.', required: false, schema: { type: 'string', minLength: 8, maxLength: 1024 } },
      { name: 'status', description: 'Exact subscription status.', required: false, schema: { type: 'string', enum: ['pending-verification', 'active', 'paused', 'revoked'] } },
      { name: 'endpointId', description: 'Exact endpoint UUID.', required: false, schema: { type: 'string', minLength: 36, maxLength: 36 } },
    ],
  },
  {
    id: 'apollo.webhooks.subscriptions.read', version: '1.0.0', title: 'Read webhook subscription',
    description: 'Returns one workspace-scoped subscription and its exact event/resource filter.',
    exposure: 'workspace-admin', operationKind: 'query', authMode: 'required', requiredScopes: ['webhooks:admin'],
    outputSchemaRef: 'apollo://schemas/webhook-subscription-detail/v1', endpoint: { method: 'GET', path: '/v1/webhooks/subscriptions/{subscriptionId}' },
    toolName: 'apollo.webhooks.subscriptions.read', supportsDryRun: false, costClass: 'free', confirmation: 'none', successStatuses: [200], idempotency: 'not-applicable',
  },
  {
    id: 'apollo.webhooks.subscriptions.status.set', version: '1.0.0',
    title: 'Set webhook subscription status',
    description: 'Pauses, resumes or irrevocably revokes a workspace webhook subscription using an optimistic base revision.',
    exposure: 'workspace-admin', operationKind: 'command', authMode: 'required',
    requiredScopes: ['webhooks:admin'],
    inputSchemaRef: 'apollo://schemas/set-webhook-subscription-status-request/v1',
    outputSchemaRef: 'apollo://schemas/webhook-subscription-detail/v1',
    endpoint: { method: 'PUT', path: '/v1/webhooks/subscriptions/{subscriptionId}/status' },
    toolName: 'apollo.webhooks.subscriptions.status.set', supportsDryRun: false,
    costClass: 'free', confirmation: 'human-approval', successStatuses: [200],
    idempotency: 'natural', requestBodyRequired: true,
  },
  {
    id: 'apollo.webhooks.deliveries.list',
    version: '1.0.0',
    title: 'List webhook deliveries',
    description: 'Returns a stable cursor page of redacted webhook delivery diagnostics for the authenticated workspace.',
    exposure: 'workspace-admin',
    operationKind: 'query',
    authMode: 'required',
    requiredScopes: ['webhooks:admin'],
    outputSchemaRef: 'apollo://schemas/webhook-delivery-list/v1',
    endpoint: { method: 'GET', path: '/v1/webhooks/deliveries' },
    toolName: 'apollo.webhooks.deliveries.list',
    supportsDryRun: false,
    costClass: 'free',
    confirmation: 'none',
    successStatuses: [200],
    idempotency: 'not-applicable',
    queryParameters: [
      {
        name: 'limit',
        description: 'Maximum number of deliveries to return.',
        required: false,
        schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      {
        name: 'after',
        description: 'Opaque cursor returned by the previous page with the same filters.',
        required: false,
        schema: { type: 'string', minLength: 8, maxLength: 1024 },
      },
      {
        name: 'status',
        description: 'Exact webhook delivery status.',
        required: false,
        schema: {
          type: 'string',
          enum: ['pending', 'in-flight', 'retry-scheduled', 'succeeded', 'dead-lettered'],
        },
      },
      {
        name: 'endpointId',
        description: 'Exact webhook endpoint UUID.',
        required: false,
        schema: { type: 'string', minLength: 36, maxLength: 36 },
      },
      {
        name: 'eventId',
        description: 'Exact public event UUID.',
        required: false,
        schema: { type: 'string', minLength: 36, maxLength: 36 },
      },
    ],
  },
  {
    id: 'apollo.webhooks.deliveries.read',
    version: '1.0.0',
    title: 'Read webhook delivery diagnostic',
    description: 'Returns one redacted webhook delivery and its ordered attempt history without endpoint URL, leases, payloads, signatures or secrets.',
    exposure: 'workspace-admin',
    operationKind: 'query',
    authMode: 'required',
    requiredScopes: ['webhooks:admin'],
    outputSchemaRef: 'apollo://schemas/webhook-delivery-detail/v1',
    endpoint: { method: 'GET', path: '/v1/webhooks/deliveries/{deliveryId}' },
    toolName: 'apollo.webhooks.deliveries.read',
    supportsDryRun: false,
    costClass: 'free',
    confirmation: 'none',
    successStatuses: [200],
    idempotency: 'not-applicable',
  },
  {
    id: 'apollo.webhooks.deliveries.replay',
    version: '1.0.0',
    title: 'Replay webhook delivery',
    description: 'Idempotently reopens one terminal webhook delivery for another signed attempt while preserving its attempt history.',
    exposure: 'workspace-admin',
    operationKind: 'command',
    authMode: 'required',
    requiredScopes: ['webhooks:admin'],
    outputSchemaRef: 'apollo://schemas/webhook-delivery-replay-result/v1',
    endpoint: { method: 'POST', path: '/v1/webhooks/deliveries/{deliveryId}/replay' },
    toolName: 'apollo.webhooks.deliveries.replay',
    supportsDryRun: false,
    costClass: 'medium',
    confirmation: 'human-approval',
    successStatuses: [202, 200],
    idempotency: 'required',
  },
  {
    id: 'apollo.webhooks.events.replay',
    version: '1.0.0',
    title: 'Replay webhook event deliveries',
    description: 'Idempotently reopens up to 100 eligible terminal deliveries for one exact public event and reports every skipped delivery.',
    exposure: 'workspace-admin',
    operationKind: 'command',
    authMode: 'required',
    requiredScopes: ['webhooks:admin'],
    outputSchemaRef: 'apollo://schemas/webhook-event-replay-result/v1',
    endpoint: { method: 'POST', path: '/v1/webhooks/events/{eventId}/replay' },
    toolName: 'apollo.webhooks.events.replay',
    supportsDryRun: false,
    costClass: 'high',
    confirmation: 'human-approval',
    successStatuses: [202, 200],
    idempotency: 'required',
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
