import { DomainError, assertDomain } from '../domain/errors.ts'
import { PUBLIC_EVENT_CATALOG } from '../domain/public-event.ts'

export type JsonSchema = Readonly<Record<string, unknown>>

export interface PublicSchemaDefinition {
  ref: string
  id: string
  version: number
  title: string
  schema: JsonSchema
}

const idSchema = { type: 'string', minLength: 3, maxLength: 128 }
const dateTimeSchema = { type: 'string', format: 'date-time' }
const apiMetaSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['apiVersion'],
  properties: { apiVersion: { const: 'v1' } },
}

const publicEventResourceTypes = [...new Set(
  PUBLIC_EVENT_CATALOG.map((descriptor) => descriptor.resourceType),
)]
const publicEventTypes = PUBLIC_EVENT_CATALOG.map((descriptor) => descriptor.type)

const publicEventSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'type', 'version', 'workspaceId', 'occurredAt', 'resource', 'data'],
  properties: {
    id: {
      type: 'string',
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    },
    type: { type: 'string', enum: publicEventTypes },
    version: { const: '1.0.0' },
    workspaceId: idSchema,
    occurredAt: dateTimeSchema,
    sequence: { type: 'integer', minimum: 1 },
    actor: {
      type: 'object',
      additionalProperties: false,
      minProperties: 1,
      properties: {
        clientId: idSchema,
        userId: idSchema,
      },
    },
    resource: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'id'],
      properties: {
        type: { type: 'string', enum: publicEventResourceTypes },
        id: idSchema,
      },
    },
    data: {
      type: 'object',
      maxProperties: 1024,
      additionalProperties: true,
    },
  },
}

function successSchema(data: Record<string, unknown>) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['data', 'meta'],
    properties: { data, meta: apiMetaSchema },
  }
}

const projectSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'workspaceId', 'name', 'status', 'createdAt'],
  properties: {
    id: idSchema,
    workspaceId: idSchema,
    name: { type: 'string', minLength: 2, maxLength: 120 },
    status: { type: 'string' },
    currentVersionId: idSchema,
    createdAt: dateTimeSchema,
  },
}

const apiClientSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'workspaceId', 'name', 'status', 'environment', 'scopes', 'createdAt'],
  properties: {
    id: idSchema,
    workspaceId: idSchema,
    name: { type: 'string', minLength: 2, maxLength: 120 },
    status: { enum: ['active', 'suspended', 'revoked'] },
    environment: { enum: ['sandbox', 'production'] },
    scopes: {
      type: 'array',
      uniqueItems: true,
      items: { type: 'string', pattern: '^[a-z-]+:[a-z-]+$' },
    },
    createdAt: dateTimeSchema,
    lastUsedAt: dateTimeSchema,
  },
}

const apiCredentialSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'clientId', 'status', 'createdAt'],
  properties: {
    id: idSchema,
    clientId: idSchema,
    status: { enum: ['active', 'revoked'] },
    createdAt: dateTimeSchema,
    expiresAt: dateTimeSchema,
    lastUsedAt: dateTimeSchema,
    revokedAt: dateTimeSchema,
  },
}

const sha256Schema = { type: 'string', pattern: '^[a-f0-9]{64}$' }

const artifactSourceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['artifactId', 'artifactKey', 'sha256', 'role', 'ordinal'],
  properties: {
    artifactId: idSchema,
    artifactKey: { type: 'string', minLength: 1, maxLength: 512 },
    sha256: sha256Schema,
    role: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$' },
    ordinal: { type: 'integer', minimum: 0 },
  },
}

const artifactManifestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'schemaVersion', 'manifestHash', 'recipe', 'sources', 'createdAt'],
  properties: {
    id: idSchema,
    schemaVersion: { type: 'string', minLength: 1, maxLength: 64 },
    manifestHash: sha256Schema,
    recipe: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'version', 'parametersHash'],
      properties: {
        id: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$' },
        version: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$' },
        parametersHash: sha256Schema,
      },
    },
    probe: {
      type: 'object',
      additionalProperties: false,
      required: ['width', 'height', 'duration', 'fps'],
      properties: {
        width: { type: 'number', exclusiveMinimum: 0 },
        height: { type: 'number', exclusiveMinimum: 0 },
        duration: { type: 'number', exclusiveMinimum: 0 },
        fps: { type: 'number', exclusiveMinimum: 0 },
      },
    },
    sources: { type: 'array', items: artifactSourceSchema },
    createdAt: dateTimeSchema,
  },
}

const lineageDiagnosticManifestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'manifestHash', 'schemaVersion', 'recipe'],
  properties: {
    id: idSchema,
    manifestHash: sha256Schema,
    schemaVersion: { type: 'string', minLength: 1, maxLength: 64 },
    recipe: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'version', 'parametersHash'],
      properties: {
        id: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$' },
        version: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$' },
        parametersHash: sha256Schema,
      },
    },
  },
}

const executionProvenanceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['tool'],
  properties: {
    tool: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'version', 'digest'],
      properties: {
        id: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$' },
        version: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$' },
        digest: sha256Schema,
      },
    },
    model: {
      type: 'object',
      additionalProperties: false,
      required: ['provider', 'id', 'version', 'configHash'],
      properties: {
        provider: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$' },
        id: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$' },
        version: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$' },
        configHash: sha256Schema,
      },
    },
  },
}

const renderTokenSchema = {
  type: 'string',
  pattern: '^[a-z0-9][a-z0-9._-]{0,127}$',
}
const renderIdentitySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'version', 'digest'],
  properties: {
    id: renderTokenSchema,
    version: renderTokenSchema,
    digest: sha256Schema,
  },
}
const renderPlanSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'versionId', 'hash'],
  properties: {
    id: renderTokenSchema,
    versionId: renderTokenSchema,
    hash: sha256Schema,
  },
}
const renderOutputRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id', 'locale', 'aspectRatio', 'width', 'height', 'fps',
    'safeArea', 'durationInFrames',
  ],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 128 },
    locale: {
      type: 'string',
      pattern: '^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$',
    },
    aspectRatio: { enum: ['9:16', '16:9', '4:5', '1:1', '21:9'] },
    width: { type: 'integer', minimum: 2, multipleOf: 2 },
    height: { type: 'integer', minimum: 2, multipleOf: 2 },
    fps: { type: 'integer', minimum: 1, maximum: 120 },
    safeArea: {
      type: 'object',
      additionalProperties: false,
      required: ['top', 'right', 'bottom', 'left'],
      properties: {
        top: { type: 'number', minimum: 0, exclusiveMaximum: 0.5 },
        right: { type: 'number', minimum: 0, exclusiveMaximum: 0.5 },
        bottom: { type: 'number', minimum: 0, exclusiveMaximum: 0.5 },
        left: { type: 'number', minimum: 0, exclusiveMaximum: 0.5 },
      },
    },
    deliveryProfileId: { type: 'string', minLength: 1, maxLength: 128 },
    durationInFrames: {
      type: 'integer',
      minimum: 1,
      maximum: 5184000,
    },
  },
}

const publicOperationTargetSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'id', 'manifestId'],
  properties: {
    type: { const: 'media-artifact' },
    id: idSchema,
    manifestId: idSchema,
  },
}

const publicOperationSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion', 'id', 'type', 'status', 'phase', 'cancelable',
    'retryable', 'target', 'attempt', 'maxAttempts', 'createdAt', 'updatedAt',
  ],
  properties: {
    schemaVersion: { const: 'public-operation/v1' },
    id: idSchema,
    type: { const: 'artifact-render' },
    status: {
      enum: ['queued', 'running', 'waiting', 'retrying', 'succeeded', 'failed', 'canceled'],
    },
    phase: {
      enum: [
        'queued', 'materializing', 'rendering', 'verifying', 'persisting',
        'waiting', 'retrying', 'completed', 'failed', 'canceled',
      ],
    },
    progress: {
      type: 'object',
      additionalProperties: false,
      required: ['completed'],
      properties: {
        completed: { type: 'integer', minimum: 0 },
        total: { type: 'integer', minimum: 1 },
        unit: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}$' },
      },
    },
    cancelable: { type: 'boolean' },
    retryable: { type: 'boolean' },
    target: publicOperationTargetSchema,
    result: {
      type: 'object',
      additionalProperties: false,
      required: ['resource'],
      properties: { resource: publicOperationTargetSchema },
    },
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message', 'retryable'],
      properties: {
        code: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}$' },
        message: { type: 'string', minLength: 1, maxLength: 500 },
        retryable: { type: 'boolean' },
      },
    },
    attempt: { type: 'integer', minimum: 0 },
    maxAttempts: { type: 'integer', minimum: 1 },
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
    startedAt: dateTimeSchema,
    completedAt: dateTimeSchema,
  },
}

const webhookUuidSchema = {
  type: 'string',
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
}
const webhookDeliverySummaryRequired = [
  'schemaVersion', 'id', 'endpointId', 'subscriptionId', 'eventId', 'status',
  'attemptCount', 'maxAttempts', 'nextAttemptAt', 'createdAt',
]
const webhookSigningSecretMetadataSchema = {
  type: 'object', additionalProperties: false,
  required: ['version', 'fingerprint', 'status', 'createdAt'],
  properties: {
    version: { type: 'integer', minimum: 1 }, fingerprint: sha256Schema,
    status: { enum: ['active', 'retired', 'revoked'] }, createdAt: dateTimeSchema,
    retiredAt: dateTimeSchema, revokedAt: dateTimeSchema,
  },
}
const webhookEndpointSummaryProperties = {
  schemaVersion: { const: 'webhook-endpoint/v1' }, id: webhookUuidSchema,
  status: { enum: ['pending-verification', 'active', 'suspended', 'revoked'] },
  revision: sha256Schema,
  destinationOrigin: { type: 'string', format: 'uri', maxLength: 255 },
  urlFingerprint: sha256Schema, createdByClientId: idSchema, createdAt: dateTimeSchema,
  verifiedAt: dateTimeSchema, suspendedAt: dateTimeSchema, revokedAt: dateTimeSchema,
  currentSigningSecret: webhookSigningSecretMetadataSchema,
}
const webhookEndpointSummarySchema = {
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'id', 'status', 'destinationOrigin', 'urlFingerprint', 'createdByClientId', 'createdAt'],
  properties: webhookEndpointSummaryProperties,
}
const webhookEndpointDetailSchema = {
  type: 'object', additionalProperties: false,
  required: [...webhookEndpointSummarySchema.required, 'signingSecrets'],
  properties: { ...webhookEndpointSummaryProperties, signingSecrets: { type: 'array', maxItems: 100, items: webhookSigningSecretMetadataSchema } },
}

const semanticDiffItemSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['commandId', 'target', 'summary'],
  properties: {
    commandId: idSchema,
    target: { type: 'string', minLength: 1, maxLength: 256 },
    summary: { type: 'string', minLength: 1, maxLength: 500 },
  },
}

const versionDiffSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'commands', 'storyChanges', 'timelineChanges', 'visualChanges', 'audioChanges',
    'outputChanges', 'invalidatedArtifacts', 'estimatedCostDelta',
  ],
  properties: {
    commands: { type: 'array', maxItems: 1000, uniqueItems: true, items: idSchema },
    storyChanges: { type: 'array', maxItems: 1000, items: semanticDiffItemSchema },
    timelineChanges: { type: 'array', maxItems: 1000, items: semanticDiffItemSchema },
    visualChanges: { type: 'array', maxItems: 1000, items: semanticDiffItemSchema },
    audioChanges: { type: 'array', maxItems: 1000, items: semanticDiffItemSchema },
    outputChanges: { type: 'array', maxItems: 1000, items: semanticDiffItemSchema },
    invalidatedArtifacts: {
      type: 'array', maxItems: 1024, uniqueItems: true, items: idSchema,
    },
    estimatedCostDelta: { type: 'number', minimum: -1000000, maximum: 1000000 },
  },
}
const webhookSigningSecretRotationMetadataSchema = {
  type: 'object', additionalProperties: false,
  required: [
    'schemaVersion', 'id', 'endpointId', 'candidateVersion', 'fingerprint', 'status',
    'overlapSeconds', 'baseRevision', 'createdAt', 'expiresAt',
  ],
  properties: {
    schemaVersion: { const: 'webhook-signing-secret-rotation/v1' },
    id: webhookUuidSchema, endpointId: webhookUuidSchema,
    candidateVersion: { type: 'integer', minimum: 2 }, fingerprint: sha256Schema,
    status: { enum: ['staged', 'activated', 'cancelled', 'expired'] },
    overlapSeconds: { type: 'integer', minimum: 60, maximum: 86400 },
    baseRevision: sha256Schema, createdAt: dateTimeSchema, expiresAt: dateTimeSchema,
    activatedAt: dateTimeSchema, overlapUntil: dateTimeSchema, cancelledAt: dateTimeSchema,
  },
}
const webhookSubscriptionSchema = {
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'id', 'endpointId', 'status', 'eventTypes', 'createdByClientId', 'createdAt'],
  properties: {
    schemaVersion: { const: 'webhook-subscription/v1' }, id: webhookUuidSchema, endpointId: webhookUuidSchema,
    status: { enum: ['pending-verification', 'active', 'paused', 'revoked'] },
    revision: sha256Schema,
    eventTypes: { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: { type: 'string', minLength: 3, maxLength: 128 } },
    resourceIds: { type: 'array', minItems: 1, maxItems: 128, uniqueItems: true, items: idSchema },
    createdByClientId: idSchema, createdAt: dateTimeSchema, pausedAt: dateTimeSchema, revokedAt: dateTimeSchema,
  },
}
const webhookDeliverySummaryProperties = {
  schemaVersion: { const: 'webhook-delivery/v1' },
  id: webhookUuidSchema,
  endpointId: webhookUuidSchema,
  subscriptionId: webhookUuidSchema,
  eventId: webhookUuidSchema,
  status: {
    enum: ['pending', 'in-flight', 'retry-scheduled', 'succeeded', 'dead-lettered'],
  },
  attemptCount: { type: 'integer', minimum: 0, maximum: 20 },
  maxAttempts: { type: 'integer', minimum: 1, maximum: 20 },
  nextAttemptAt: dateTimeSchema,
  createdAt: dateTimeSchema,
  completedAt: dateTimeSchema,
  deadLetteredAt: dateTimeSchema,
}
const webhookDeliverySummarySchema = {
  type: 'object',
  additionalProperties: false,
  required: webhookDeliverySummaryRequired,
  properties: webhookDeliverySummaryProperties,
}
const webhookDeliveryAttemptSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'id', 'attemptNumber', 'status', 'scheduledAt', 'createdAt'],
  properties: {
    schemaVersion: { const: 'webhook-delivery-attempt/v1' },
    id: webhookUuidSchema,
    attemptNumber: { type: 'integer', minimum: 1, maximum: 20 },
    status: { enum: ['scheduled', 'in-flight', 'succeeded', 'failed'] },
    scheduledAt: dateTimeSchema,
    createdAt: dateTimeSchema,
    startedAt: dateTimeSchema,
    completedAt: dateTimeSchema,
    responseStatus: { type: 'integer', minimum: 100, maximum: 599 },
    responseBodyHash: sha256Schema,
    errorCode: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}$' },
  },
}
const webhookDeliveryDiagnosticSchema = {
  type: 'object',
  additionalProperties: false,
  required: [...webhookDeliverySummaryRequired, 'attempts'],
  properties: {
    ...webhookDeliverySummaryProperties,
    attempts: { type: 'array', maxItems: 20, items: webhookDeliveryAttemptSchema },
  },
}
const webhookEventReplayItemSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'delivery'],
  properties: {
    status: {
      enum: [
        'scheduled',
        'skipped-non-terminal',
        'skipped-target-inactive',
        'skipped-attempt-limit',
      ],
    },
    delivery: webhookDeliverySummarySchema,
  },
}
const renderInputAssetSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id', 'artifactId', 'artifactKey', 'kind', 'role',
    'ordinal', 'sha256', 'byteSize',
  ],
  properties: {
    id: renderTokenSchema,
    artifactId: renderTokenSchema,
    artifactKey: { type: 'string', minLength: 1, maxLength: 512 },
    kind: { enum: ['video', 'audio', 'image', 'font', 'lut', 'data'] },
    role: renderTokenSchema,
    ordinal: { type: 'integer', minimum: 0, maximum: 4095 },
    sha256: sha256Schema,
    byteSize: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  },
}

const rightsTokenSchema = {
  type: 'string',
  pattern: '^[a-z0-9][a-z0-9._:-]{0,63}$',
}
const rightsTokenArraySchema = {
  type: 'array',
  maxItems: 64,
  uniqueItems: true,
  items: rightsTokenSchema,
}
const marketArraySchema = {
  type: 'array',
  maxItems: 64,
  uniqueItems: true,
  items: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9-]{1,15}$' },
}
const localeArraySchema = {
  type: 'array',
  maxItems: 64,
  uniqueItems: true,
  items: {
    type: 'string',
    pattern: '^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$',
  },
}
const consentScopeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'allowedUses'],
  properties: {
    status: {
      enum: ['not-required', 'approved', 'restricted', 'unknown', 'expired', 'revoked'],
    },
    allowedUses: rightsTokenArraySchema,
    allowedMarkets: marketArraySchema,
    allowedLocales: localeArraySchema,
    allowedSyntheticOperations: rightsTokenArraySchema,
    expiresAt: dateTimeSchema,
    documentArtifactId: idSchema,
  },
}
const assetRightsDraftSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'allowedUses', 'prohibitedUses', 'consent'],
  properties: {
    owner: { type: 'string', minLength: 1, maxLength: 240 },
    license: { type: 'string', minLength: 1, maxLength: 240 },
    status: { enum: ['approved', 'restricted', 'unknown', 'expired', 'revoked'] },
    allowedUses: rightsTokenArraySchema,
    prohibitedUses: rightsTokenArraySchema,
    allowedMarkets: marketArraySchema,
    allowedLocales: localeArraySchema,
    allowedSyntheticOperations: rightsTokenArraySchema,
    expiresAt: dateTimeSchema,
    consent: consentScopeSchema,
    sourceNote: { type: 'string', minLength: 1, maxLength: 2000 },
  },
}
const assetRightsSnapshotSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion', 'id', 'workspaceId', 'artifactId', 'sequence',
    'snapshotHash', 'status', 'allowedUses', 'prohibitedUses',
    'allowedWorkspaceIds', 'consent', 'createdBy', 'createdAt',
  ],
  properties: {
    ...assetRightsDraftSchema.properties,
    schemaVersion: { const: 'asset-rights/v1' },
    id: idSchema,
    workspaceId: idSchema,
    artifactId: idSchema,
    sequence: { type: 'integer', minimum: 1 },
    snapshotHash: sha256Schema,
    allowedWorkspaceIds: {
      type: 'array',
      minItems: 1,
      maxItems: 64,
      uniqueItems: true,
      items: idSchema,
    },
    createdBy: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'id'],
      properties: {
        type: { enum: ['api-client', 'user', 'system'] },
        id: idSchema,
      },
    },
    createdAt: dateTimeSchema,
  },
}
const assetUseDenialCodes = [
  'RIGHTS_MISSING', 'RIGHTS_STATUS_RESTRICTED', 'RIGHTS_STATUS_UNKNOWN',
  'RIGHTS_STATUS_EXPIRED', 'RIGHTS_STATUS_REVOKED', 'RIGHTS_EXPIRED',
  'RIGHTS_WORKSPACE_NOT_ALLOWED', 'RIGHTS_USE_PROHIBITED',
  'RIGHTS_USE_NOT_ALLOWED', 'RIGHTS_MARKET_NOT_ALLOWED',
  'RIGHTS_LOCALE_NOT_ALLOWED', 'RIGHTS_SYNTHETIC_OPERATION_NOT_ALLOWED',
  'CONSENT_STATUS_RESTRICTED', 'CONSENT_STATUS_UNKNOWN',
  'CONSENT_STATUS_EXPIRED', 'CONSENT_STATUS_REVOKED', 'CONSENT_EXPIRED',
  'CONSENT_USE_NOT_ALLOWED', 'CONSENT_MARKET_NOT_ALLOWED',
  'CONSENT_LOCALE_NOT_ALLOWED', 'CONSENT_SYNTHETIC_OPERATION_NOT_ALLOWED',
]

const credentialMutationDataSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['client', 'credential', 'secretAvailable', 'replayed'],
  properties: {
    client: apiClientSchema,
    credential: apiCredentialSchema,
    token: { type: 'string', pattern: '^apollo_v2\\.' },
    secretAvailable: { type: 'boolean' },
    replayed: { type: 'boolean' },
  },
  allOf: [
    {
      if: { properties: { secretAvailable: { const: true } }, required: ['secretAvailable'] },
      then: {
        required: ['token'],
        properties: { token: { type: 'string', pattern: '^apollo_v2\\.' } },
      },
      else: { properties: { token: false } },
    },
  ],
}

function defineSchema(
  id: string,
  version: number,
  title: string,
  body: Record<string, unknown>,
): PublicSchemaDefinition {
  const ref = `apollo://schemas/${id}/v${version}`
  assertDomain(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) && Number.isInteger(version) && version > 0,
    'INVALID_PUBLIC_SCHEMA',
    'Public schema id/version is invalid',
    { id, version },
  )
  return Object.freeze({
    ref,
    id,
    version,
    title,
    schema: Object.freeze({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: ref,
      title,
      ...body,
    }),
  })
}

function defineSchemaRegistry(definitions: readonly PublicSchemaDefinition[]) {
  const refs = new Set<string>()
  for (const definition of definitions) {
    assertDomain(
      !refs.has(definition.ref),
      'INVALID_PUBLIC_SCHEMA',
      'Public schema refs must be unique',
      { ref: definition.ref },
    )
    refs.add(definition.ref)
  }
  return Object.freeze([...definitions])
}

export const PUBLIC_SCHEMAS = defineSchemaRegistry([
  defineSchema('health-response', 1, 'Health response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['service', 'status'],
      properties: {
        service: { const: 'apollo-video' },
        status: { const: 'ok' },
      },
    }),
  ),
  defineSchema('capability-list', 1, 'Capability list response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['capabilities'],
      properties: {
        capabilities: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'id', 'version', 'title', 'description', 'operationKind', 'authMode',
              'requiredScopes', 'outputSchemaRef', 'endpoint', 'toolName',
              'supportsDryRun', 'costClass', 'confirmation', 'successStatuses',
              'idempotency', 'responseMediaType',
            ],
            properties: {
              id: { type: 'string', pattern: '^apollo\\.' },
              version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
              title: { type: 'string' },
              description: { type: 'string' },
              operationKind: { enum: ['query', 'command', 'preflight', 'job'] },
              authMode: { enum: ['none', 'optional', 'required'] },
              requiredScopes: { type: 'array', items: { type: 'string' }, uniqueItems: true },
              inputSchemaRef: { type: 'string' },
              outputSchemaRef: { type: 'string' },
              endpoint: {
                type: 'object',
                additionalProperties: false,
                required: ['method', 'path'],
                properties: {
                  method: { enum: ['GET', 'POST', 'PATCH', 'DELETE'] },
                  path: { type: 'string', pattern: '^/v1/' },
                },
              },
              toolName: { type: 'string' },
              supportsDryRun: { type: 'boolean' },
              costClass: { enum: ['free', 'low', 'medium', 'high', 'variable'] },
              confirmation: { enum: ['none', 'preflight-token', 'human-approval'] },
              successStatuses: { type: 'array', items: { type: 'integer' }, uniqueItems: true },
              idempotency: { enum: ['not-applicable', 'required', 'natural'] },
              queryParameters: { type: 'array', items: { type: 'object' } },
              requestBodyRequired: { type: 'boolean' },
              responseMediaType: {
                enum: ['application/json', 'application/schema+json'],
              },
            },
          },
        },
      },
    }),
  ),
  defineSchema('public-event', 1, 'Public event envelope', publicEventSchema),
  defineSchema('event-catalog', 1, 'Public event catalog response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['envelopeSchemaRef', 'events'],
      properties: {
        envelopeSchemaRef: { const: 'apollo://schemas/public-event/v1' },
        events: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'version', 'resourceType', 'description'],
            properties: {
              type: { type: 'string', enum: publicEventTypes },
              version: { const: '1.0.0' },
              resourceType: { type: 'string', enum: publicEventResourceTypes },
              description: { type: 'string', minLength: 1, maxLength: 512 },
            },
          },
        },
      },
    }),
  ),
  defineSchema('project-list', 1, 'Project list response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['projects'],
      properties: { projects: { type: 'array', items: projectSchema } },
    }),
  ),
  defineSchema('project-list', 2, 'Paginated project list response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['projects'],
      properties: {
        projects: { type: 'array', items: projectSchema },
        nextCursor: { type: 'string', minLength: 8, maxLength: 1024 },
      },
    }),
  ),
  defineSchema('artifact-detail', 1, 'Media artifact detail response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['artifact', 'manifests'],
      properties: {
        artifact: {
          type: 'object',
          additionalProperties: false,
          required: [
            'id', 'workspaceId', 'artifactKey', 'sha256', 'byteSize',
            'mediaType', 'container', 'status', 'createdAt',
          ],
          properties: {
            id: idSchema,
            workspaceId: idSchema,
            artifactKey: { type: 'string', minLength: 1, maxLength: 512 },
            sha256: sha256Schema,
            byteSize: { type: 'string', pattern: '^[1-9][0-9]*$' },
            mediaType: { enum: ['video', 'audio', 'image'] },
            container: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$' },
            status: { enum: ['available', 'quarantined', 'deleted'] },
            createdAt: dateTimeSchema,
          },
        },
        manifests: { type: 'array', items: artifactManifestSchema },
      },
    }),
  ),
  defineSchema('artifact-lineage-diagnostic', 1, 'Media artifact lineage diagnostic response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['artifactId', 'manifestId', 'healthy', 'nodes', 'edges', 'issues', 'limits'],
      properties: {
        artifactId: idSchema,
        manifestId: idSchema,
        healthy: { type: 'boolean' },
        nodes: {
          type: 'array',
          uniqueItems: true,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['artifactId', 'artifactKey', 'sha256', 'status', 'manifestCount'],
            properties: {
              artifactId: idSchema,
              artifactKey: { type: 'string', minLength: 1, maxLength: 512 },
              sha256: sha256Schema,
              status: { enum: ['available', 'quarantined', 'deleted'] },
              manifestCount: { type: 'integer', minimum: 0 },
              selectedManifest: lineageDiagnosticManifestSchema,
            },
          },
        },
        edges: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['sourceArtifactId', 'targetArtifactId', 'sha256', 'role', 'ordinal'],
            properties: {
              sourceArtifactId: idSchema,
              targetArtifactId: idSchema,
              sha256: sha256Schema,
              role: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$' },
              ordinal: { type: 'integer', minimum: 0 },
            },
          },
        },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['code', 'artifactId', 'message'],
            properties: {
              code: {
                enum: [
                  'ARTIFACT_UNAVAILABLE', 'MANIFEST_MISSING', 'SOURCE_NOT_FOUND',
                  'SOURCE_CHECKSUM_MISMATCH', 'SOURCE_INTEGRITY_FAILURE',
                  'LINEAGE_CYCLE', 'GRAPH_LIMIT_EXCEEDED', 'DEPTH_LIMIT_EXCEEDED',
                ],
              },
              artifactId: idSchema,
              message: { type: 'string', minLength: 1 },
            },
          },
        },
        limits: {
          type: 'object',
          additionalProperties: false,
          required: ['maxNodes', 'maxDepth', 'truncated'],
          properties: {
            maxNodes: { type: 'integer', minimum: 1 },
            maxDepth: { type: 'integer', minimum: 0 },
            truncated: { type: 'boolean' },
          },
        },
      },
    }),
  ),
  defineSchema('artifact-execution-provenance', 1, 'Artifact execution provenance response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: [
        'artifactId', 'manifestId', 'schemaVersion', 'manifestHash',
        'complete', 'edges', 'issues',
      ],
      properties: {
        artifactId: idSchema,
        manifestId: idSchema,
        schemaVersion: { type: 'string', minLength: 1, maxLength: 64 },
        manifestHash: sha256Schema,
        complete: { type: 'boolean' },
        edges: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['sourceArtifactId', 'role', 'ordinal'],
            properties: {
              sourceArtifactId: idSchema,
              role: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$' },
              ordinal: { type: 'integer', minimum: 0 },
              execution: executionProvenanceSchema,
            },
          },
        },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['code', 'sourceArtifactId', 'ordinal', 'message'],
            properties: {
              code: { const: 'EXECUTION_PROVENANCE_MISSING' },
              sourceArtifactId: idSchema,
              ordinal: { type: 'integer', minimum: 0 },
              message: { type: 'string', minLength: 1 },
            },
          },
        },
      },
    }),
  ),
  defineSchema('artifact-replay-spec', 1, 'Artifact replay specification response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: [
        'artifactId', 'manifestId', 'schemaVersion', 'manifestHash',
        'recipe', 'available', 'issues',
      ],
      properties: {
        artifactId: idSchema,
        manifestId: idSchema,
        schemaVersion: { type: 'string', minLength: 1, maxLength: 64 },
        manifestHash: sha256Schema,
        recipe: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'version', 'parametersHash'],
          properties: {
            id: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$' },
            version: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$' },
            parametersHash: sha256Schema,
          },
        },
        available: { type: 'boolean' },
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['ref', 'canonicalByteSize', 'protection'],
          properties: {
            ref: {
              type: 'string',
              pattern: '^recipe-parameters/sha256/[a-f0-9]{64}$',
            },
            canonicalByteSize: {
              type: 'integer',
              minimum: 1,
              maximum: 1048576,
            },
            protection: {
              type: 'object',
              additionalProperties: false,
              required: ['algorithm'],
              properties: { algorithm: { const: 'aes-256-gcm' } },
            },
          },
        },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['code', 'message'],
            properties: {
              code: { const: 'REPLAY_PARAMETERS_MISSING' },
              message: { type: 'string', minLength: 1 },
            },
          },
        },
      },
      allOf: [
        {
          if: { properties: { available: { const: true } } },
          then: {
            required: ['parameters'],
            properties: {
              parameters: { type: 'object' },
              issues: { type: 'array', maxItems: 0 },
            },
          },
        },
        {
          if: { properties: { available: { const: false } } },
          then: {
            not: { required: ['parameters'] },
            properties: { issues: { type: 'array', minItems: 1 } },
          },
        },
      ],
    }),
  ),
  defineSchema('artifact-render-input', 1, 'Artifact RenderInput metadata response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: [
        'artifactId', 'manifestId', 'schemaVersion', 'manifestHash',
        'available', 'issues',
      ],
      properties: {
        artifactId: idSchema,
        manifestId: idSchema,
        schemaVersion: { type: 'string', minLength: 1, maxLength: 64 },
        manifestHash: sha256Schema,
        available: { type: 'boolean' },
        renderInput: {
          type: 'object',
          additionalProperties: false,
          required: ['ref', 'inputHash', 'canonicalByteSize', 'protection'],
          properties: {
            ref: {
              type: 'string',
              pattern: '^render-input/sha256/[a-f0-9]{64}$',
            },
            inputHash: sha256Schema,
            canonicalByteSize: {
              type: 'integer',
              minimum: 1,
              maximum: 4194304,
            },
            protection: {
              type: 'object',
              additionalProperties: false,
              required: ['algorithm'],
              properties: { algorithm: { const: 'aes-256-gcm' } },
            },
          },
        },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['code', 'message'],
            properties: {
              code: { const: 'RENDER_INPUT_MISSING' },
              message: { type: 'string', minLength: 1 },
            },
          },
        },
      },
      allOf: [
        {
          if: { properties: { available: { const: true } } },
          then: {
            required: ['renderInput'],
            properties: {
              renderInput: { type: 'object' },
              issues: { type: 'array', maxItems: 0 },
            },
          },
        },
        {
          if: { properties: { available: { const: false } } },
          then: {
            not: { required: ['renderInput'] },
            properties: { issues: { type: 'array', minItems: 1 } },
          },
        },
      ],
    }),
  ),
  defineSchema('artifact-reconstruction-preflight', 1, 'Artifact reconstruction preflight response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: [
        'artifactId', 'manifestId', 'schemaVersion', 'manifestHash',
        'validationScope', 'rightsValidationRequired', 'materializationRequired',
        'payloadAuthenticated', 'eligible', 'assets', 'issues',
      ],
      properties: {
        artifactId: idSchema,
        manifestId: idSchema,
        schemaVersion: { type: 'string', minLength: 1, maxLength: 64 },
        manifestHash: sha256Schema,
        validationScope: { const: 'protected-input-and-asset-identity' },
        rightsValidationRequired: { const: true },
        materializationRequired: { const: true },
        payloadAuthenticated: { type: 'boolean' },
        eligible: { type: 'boolean' },
        inputHash: sha256Schema,
        renderer: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'version', 'digest', 'supported'],
          properties: {
            id: renderTokenSchema,
            version: renderTokenSchema,
            digest: sha256Schema,
            supported: { type: 'boolean' },
          },
        },
        composition: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'version', 'propsSchemaRef', 'supported'],
          properties: {
            id: renderTokenSchema,
            version: renderTokenSchema,
            propsSchemaRef: {
              type: 'string',
              pattern: '^apollo://render-props/[a-z0-9][a-z0-9-]*/v[1-9][0-9]*$',
            },
            supported: { type: 'boolean' },
          },
        },
        assets: {
          type: 'object',
          additionalProperties: false,
          required: ['total', 'available'],
          properties: {
            total: { type: 'integer', minimum: 0, maximum: 4096 },
            available: { type: 'integer', minimum: 0, maximum: 4096 },
          },
        },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['code', 'message'],
            properties: {
              code: {
                enum: [
                  'RENDER_INPUT_MISSING', 'RENDERER_UNAVAILABLE',
                  'COMPOSITION_UNAVAILABLE', 'ASSET_NOT_FOUND',
                  'ASSET_UNAVAILABLE', 'ASSET_IDENTITY_MISMATCH',
                  'ASSET_KIND_UNSUPPORTED',
                ],
              },
              message: { type: 'string', minLength: 1 },
              assetOrdinal: { type: 'integer', minimum: 0, maximum: 4095 },
              assetKind: { enum: ['video', 'audio', 'image', 'font', 'lut', 'data'] },
            },
          },
        },
      },
      allOf: [
        {
          if: { properties: { payloadAuthenticated: { const: true } } },
          then: {
            required: ['inputHash', 'renderer', 'composition'],
            properties: {
              inputHash: {},
              renderer: {},
              composition: {},
            },
          },
        },
        {
          if: { properties: { eligible: { const: true } } },
          then: { properties: { issues: { type: 'array', maxItems: 0 } } },
        },
        {
          if: { properties: { eligible: { const: false } } },
          then: { properties: { issues: { type: 'array', minItems: 1 } } },
        },
      ],
    }),
  ),
  defineSchema('set-asset-rights-request', 1, 'Set asset rights request',
    assetRightsDraftSchema,
  ),
  defineSchema('asset-rights-current', 1, 'Current asset rights response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['artifactId', 'configured'],
      properties: {
        artifactId: idSchema,
        configured: { type: 'boolean' },
        rights: assetRightsSnapshotSchema,
      },
      allOf: [
        {
          if: { properties: { configured: { const: true } }, required: ['configured'] },
          then: { required: ['rights'], properties: { rights: {} } },
          else: { properties: { rights: false } },
        },
      ],
    }),
  ),
  defineSchema('asset-rights-set', 1, 'Asset rights set response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['artifactId', 'rights', 'replayed'],
      properties: {
        artifactId: idSchema,
        rights: assetRightsSnapshotSchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema(
    'authorize-materialization-request',
    1,
    'Authorize RenderInput materialization request',
    {
      type: 'object',
      additionalProperties: false,
      required: ['use'],
      properties: {
        use: rightsTokenSchema,
        market: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9-]{1,15}$' },
        syntheticOperations: rightsTokenArraySchema,
      },
    },
  ),
  defineSchema(
    'materialization-authorization',
    1,
    'RenderInput materialization authorization response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['authorization', 'replayed'],
      properties: {
        replayed: { type: 'boolean' },
        authorization: {
          type: 'object',
          additionalProperties: false,
          required: [
            'schemaVersion', 'id', 'artifactId', 'manifestId', 'inputHash',
            'use', 'locale', 'syntheticOperations', 'status', 'issues',
            'decisions', 'evaluatedAt', 'revalidationRequired',
          ],
          properties: {
            schemaVersion: { const: 'materialization-authorization/v1' },
            id: idSchema,
            artifactId: idSchema,
            manifestId: idSchema,
            inputHash: sha256Schema,
            use: rightsTokenSchema,
            market: { type: 'string', pattern: '^[A-Z0-9][A-Z0-9-]{1,15}$' },
            locale: {
              type: 'string',
              pattern: '^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$',
            },
            syntheticOperations: rightsTokenArraySchema,
            status: { enum: ['authorized', 'denied'] },
            issues: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['code'],
                properties: {
                  code: {
                    enum: [
                      'RENDERER_UNAVAILABLE', 'COMPOSITION_UNAVAILABLE',
                      'ASSET_NOT_FOUND', 'ASSET_UNAVAILABLE',
                      'ASSET_IDENTITY_MISMATCH', 'ASSET_KIND_UNSUPPORTED',
                      'ASSET_RIGHTS_DENIED',
                    ],
                  },
                  assetOrdinal: { type: 'integer', minimum: 0, maximum: 4095 },
                  assetKind: { enum: ['video', 'audio', 'image', 'font', 'lut', 'data'] },
                },
              },
            },
            decisions: {
              type: 'array',
              maxItems: 4096,
              items: {
                type: 'object',
                additionalProperties: false,
                required: [
                  'artifactId', 'assetOrdinal', 'assetKind', 'outcome', 'reasonCodes',
                ],
                properties: {
                  artifactId: idSchema,
                  assetOrdinal: { type: 'integer', minimum: 0, maximum: 4095 },
                  assetKind: { enum: ['video', 'audio', 'image', 'font', 'lut', 'data'] },
                  outcome: { enum: ['allow', 'deny'] },
                  reasonCodes: {
                    type: 'array',
                    uniqueItems: true,
                    items: { enum: assetUseDenialCodes },
                  },
                  rightsSnapshotId: idSchema,
                  rightsSnapshotHash: sha256Schema,
                  validUntil: dateTimeSchema,
                },
                allOf: [
                  {
                    if: { properties: { outcome: { const: 'allow' } }, required: ['outcome'] },
                    then: {
                      required: ['rightsSnapshotId', 'rightsSnapshotHash', 'validUntil'],
                      properties: {
                        reasonCodes: { type: 'array', maxItems: 0 },
                        rightsSnapshotId: {},
                        rightsSnapshotHash: {},
                        validUntil: {},
                      },
                    },
                    else: { properties: { reasonCodes: { type: 'array', minItems: 1 } } },
                  },
                ],
              },
            },
            evaluatedAt: dateTimeSchema,
            validUntil: dateTimeSchema,
            revalidationRequired: { const: true },
          },
          allOf: [
            {
              if: { properties: { status: { const: 'authorized' } }, required: ['status'] },
              then: {
                required: ['validUntil'],
                properties: {
                  issues: { type: 'array', maxItems: 0 },
                  validUntil: {},
                },
              },
              else: {
                properties: {
                  issues: { type: 'array', minItems: 1 },
                  validUntil: false,
                },
              },
            },
          ],
        },
      },
    }),
  ),
  defineSchema('render-input-preflight-request', 1, 'Portable RenderInput preflight request', {
    type: 'object',
    additionalProperties: false,
    required: [
      'schemaVersion', 'renderer', 'composition', 'plan',
      'output', 'assets', 'props',
    ],
    properties: {
      schemaVersion: { const: 'render-input/v1' },
      renderer: renderIdentitySchema,
      composition: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'version', 'propsSchemaRef'],
        properties: {
          id: renderTokenSchema,
          version: renderTokenSchema,
          propsSchemaRef: {
            type: 'string',
            pattern: '^apollo://render-props/[a-z0-9][a-z0-9-]*/v[1-9][0-9]*$',
          },
        },
      },
      plan: renderPlanSchema,
      output: renderOutputRequestSchema,
      assets: {
        type: 'array',
        maxItems: 4096,
        items: renderInputAssetSchema,
      },
      props: { type: 'object' },
    },
  }),
  defineSchema('render-input-preflight', 1, 'Portable RenderInput preflight response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: [
        'schemaVersion', 'validationScope', 'materializationRequired',
        'inputHash', 'renderer', 'composition',
        'plan', 'output', 'assetCount', 'totalAssetBytes',
      ],
      properties: {
        schemaVersion: { const: 'render-input/v1' },
        validationScope: { const: 'portable-envelope' },
        materializationRequired: { const: true },
        inputHash: sha256Schema,
        renderer: renderIdentitySchema,
        composition: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'version', 'propsSchemaRef', 'propsHash'],
          properties: {
            id: renderTokenSchema,
            version: renderTokenSchema,
            propsSchemaRef: {
              type: 'string',
              pattern: '^apollo://render-props/[a-z0-9][a-z0-9-]*/v[1-9][0-9]*$',
            },
            propsHash: sha256Schema,
          },
        },
        plan: renderPlanSchema,
        output: {
          type: 'object',
          additionalProperties: false,
          required: [
            'id', 'locale', 'aspectRatio', 'width', 'height',
            'fps', 'durationInFrames',
          ],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 128 },
            locale: {
              type: 'string',
              pattern: '^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$',
            },
            aspectRatio: { enum: ['9:16', '16:9', '4:5', '1:1', '21:9'] },
            width: { type: 'integer', minimum: 2, multipleOf: 2 },
            height: { type: 'integer', minimum: 2, multipleOf: 2 },
            fps: { type: 'integer', minimum: 1, maximum: 120 },
            durationInFrames: { type: 'integer', minimum: 1, maximum: 5184000 },
          },
        },
        assetCount: { type: 'integer', minimum: 0, maximum: 4096 },
        totalAssetBytes: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
      },
    }),
  ),
  defineSchema('enqueue-artifact-render-request', 1, 'Authorized artifact render request', {
    type: 'object',
    additionalProperties: false,
    required: ['authorizationId'],
    properties: { authorizationId: idSchema },
  }),
  defineSchema('artifact-render-operation-accepted', 1, 'Accepted artifact render operation',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['operation', 'replayed'],
      properties: {
        operation: publicOperationSchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('public-operation-detail', 1, 'Public operation detail response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['operation'],
      properties: { operation: publicOperationSchema },
    }),
  ),
  defineSchema('public-operation-list', 1, 'Public operation list response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['operations'],
      properties: {
        operations: {
          type: 'array',
          maxItems: 100,
          items: publicOperationSchema,
        },
        nextCursor: {
          type: 'string',
          minLength: 8,
          maxLength: 1024,
          pattern: '^[A-Za-z0-9_-]+$',
        },
      },
    }),
  ),
  defineSchema('webhook-delivery-list', 1, 'Webhook delivery list response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['deliveries'],
      properties: {
        deliveries: {
          type: 'array',
          maxItems: 100,
          items: webhookDeliverySummarySchema,
        },
        nextCursor: {
          type: 'string',
          minLength: 8,
          maxLength: 1024,
          pattern: '^[A-Za-z0-9_-]+$',
        },
      },
    }),
  ),
  defineSchema('webhook-endpoint-list', 1, 'Webhook endpoint list response',
    successSchema({ type: 'object', additionalProperties: false, required: ['endpoints'], properties: {
      endpoints: { type: 'array', maxItems: 100, items: webhookEndpointSummarySchema },
      nextCursor: { type: 'string', minLength: 8, maxLength: 1024, pattern: '^[A-Za-z0-9_-]+$' },
    } }),
  ),
  defineSchema('create-webhook-endpoint-request', 1, 'Create webhook endpoint request', {
    type: 'object',
    additionalProperties: false,
    required: ['url'],
    properties: {
      url: { type: 'string', format: 'uri', pattern: '^https://', minLength: 12, maxLength: 2048 },
    },
  }),
  defineSchema('webhook-endpoint-created', 1, 'Webhook endpoint creation response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['endpoint', 'replayed'],
      properties: {
        endpoint: webhookEndpointSummarySchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('webhook-endpoint-detail', 1, 'Webhook endpoint detail response',
    successSchema({ type: 'object', additionalProperties: false, required: ['endpoint'], properties: { endpoint: webhookEndpointDetailSchema } }),
  ),
  defineSchema('set-webhook-endpoint-status-request', 1, 'Set webhook endpoint status request', {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'baseRevision'],
    properties: {
      status: { enum: ['active', 'suspended', 'revoked'] },
      baseRevision: sha256Schema,
    },
  }),
  defineSchema('webhook-endpoint-status-result', 1, 'Webhook endpoint status result',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['endpoint', 'effects', 'replayed'],
      properties: {
        endpoint: webhookEndpointSummarySchema,
        effects: {
          type: 'object',
          additionalProperties: false,
          required: ['pausedSubscriptions', 'revokedSubscriptions', 'revokedSigningSecrets'],
          properties: {
            pausedSubscriptions: { type: 'integer', minimum: 0 },
            revokedSubscriptions: { type: 'integer', minimum: 0 },
            revokedSigningSecrets: { type: 'integer', minimum: 0 },
          },
        },
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('webhook-endpoint-challenge-result', 1, 'Webhook endpoint challenge result',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['endpoint', 'effects', 'replayed'],
      properties: {
        endpoint: webhookEndpointSummarySchema,
        effects: {
          type: 'object',
          additionalProperties: false,
          required: ['activatedSubscriptions'],
          properties: { activatedSubscriptions: { type: 'integer', minimum: 0 } },
        },
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('provision-webhook-signing-secret-request', 1, 'Provision webhook signing secret request', {
    type: 'object',
    additionalProperties: false,
    required: ['baseRevision'],
    properties: { baseRevision: sha256Schema },
  }),
  defineSchema('webhook-signing-secret-provisioned', 1, 'Webhook signing secret provisioning response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['endpoint', 'secretAvailable', 'replayed'],
      properties: {
        endpoint: webhookEndpointSummarySchema,
        secretBase64url: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
        secretAvailable: { type: 'boolean' },
        replayed: { type: 'boolean' },
      },
      allOf: [
        {
          if: { properties: { secretAvailable: { const: true } }, required: ['secretAvailable'] },
          then: {
            required: ['secretBase64url'],
            properties: { secretBase64url: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' } },
          },
          else: { properties: { secretBase64url: false } },
        },
      ],
    }),
  ),
  defineSchema('stage-webhook-signing-secret-rotation-request', 1, 'Stage webhook signing secret rotation request', {
    type: 'object',
    additionalProperties: false,
    required: ['baseRevision', 'overlapSeconds'],
    properties: {
      baseRevision: sha256Schema,
      overlapSeconds: { type: 'integer', minimum: 60, maximum: 86400 },
    },
  }),
  defineSchema('webhook-signing-secret-rotation-staged', 1, 'Staged webhook signing secret rotation response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['rotation', 'secretAvailable', 'replayed'],
      properties: {
        rotation: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'endpointId', 'candidateVersion', 'fingerprint', 'status', 'overlapSeconds', 'createdAt', 'expiresAt'],
          properties: {
            id: idSchema,
            endpointId: idSchema,
            candidateVersion: { type: 'integer', minimum: 1 },
            fingerprint: sha256Schema,
            status: { type: 'string', const: 'staged' },
            overlapSeconds: { type: 'integer', minimum: 60, maximum: 86400 },
            createdAt: dateTimeSchema,
            expiresAt: dateTimeSchema,
          },
        },
        secretBase64url: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
        secretAvailable: { type: 'boolean' },
        replayed: { type: 'boolean' },
      },
      allOf: [{
        if: { properties: { secretAvailable: { const: true } }, required: ['secretAvailable'] },
        then: {
          required: ['secretBase64url'],
          properties: { secretBase64url: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' } },
        },
        else: { properties: { secretBase64url: false } },
      }],
    }),
  ),
  defineSchema('activate-webhook-signing-secret-rotation-request', 1, 'Activate webhook signing secret rotation request', {
    type: 'object', additionalProperties: false, required: ['baseRevision'],
    properties: { baseRevision: sha256Schema },
  }),
  defineSchema('webhook-signing-secret-rotation-activated', 1, 'Activated webhook signing secret rotation response',
    successSchema({
      type: 'object', additionalProperties: false,
      required: ['endpoint', 'rotation', 'signing', 'replayed'],
      properties: {
        endpoint: {
          type: 'object', additionalProperties: false, required: ['id', 'status', 'revision'],
          properties: { id: idSchema, status: { type: 'string', const: 'active' }, revision: sha256Schema },
        },
        rotation: {
          type: 'object', additionalProperties: false,
          required: ['id', 'status', 'candidateVersion', 'fingerprint', 'overlapSeconds', 'activatedAt', 'overlapUntil'],
          properties: {
            id: idSchema, status: { type: 'string', const: 'activated' },
            candidateVersion: { type: 'integer', minimum: 2 }, fingerprint: sha256Schema,
            overlapSeconds: { type: 'integer', minimum: 60, maximum: 86400 },
            activatedAt: dateTimeSchema, overlapUntil: dateTimeSchema,
          },
        },
        signing: {
          type: 'object', additionalProperties: false,
          required: ['activeVersion', 'activeFingerprint', 'previousVersion', 'previousFingerprint', 'previousUsableUntil'],
          properties: {
            activeVersion: { type: 'integer', minimum: 2 }, activeFingerprint: sha256Schema,
            previousVersion: { type: 'integer', minimum: 1 }, previousFingerprint: sha256Schema,
            previousUsableUntil: dateTimeSchema,
          },
        },
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('cancel-webhook-signing-secret-rotation-request', 1, 'Cancel webhook signing secret rotation request', {
    type: 'object', additionalProperties: false, required: ['baseRevision'],
    properties: { baseRevision: sha256Schema },
  }),
  defineSchema('webhook-signing-secret-rotation-cancelled', 1, 'Cancelled webhook signing secret rotation response',
    successSchema({
      type: 'object', additionalProperties: false,
      required: ['rotation', 'envelopeDestroyed', 'replayed'],
      properties: {
        rotation: {
          type: 'object', additionalProperties: false,
          required: ['id', 'endpointId', 'status', 'candidateVersion', 'fingerprint', 'cancelledAt'],
          properties: {
            id: idSchema, endpointId: idSchema,
            status: { type: 'string', enum: ['cancelled', 'expired'] },
            candidateVersion: { type: 'integer', minimum: 2 },
            fingerprint: sha256Schema, cancelledAt: dateTimeSchema,
          },
        },
        envelopeDestroyed: { type: 'boolean', const: true },
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('agent-tool-list', 1, 'Scope-filtered agent tool list',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['tools'],
      properties: {
        tools: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'name', 'title', 'description', 'inputSchema', 'outputSchema',
              'errorSchema', 'annotations', 'apollo',
            ],
            properties: {
              name: { type: 'string', pattern: '^[a-z][a-z0-9_.-]{2,127}$' },
              title: { type: 'string', minLength: 1, maxLength: 160 },
              description: { type: 'string', minLength: 1, maxLength: 1000 },
              inputSchema: { type: 'object' },
              outputSchema: { type: 'object' },
              errorSchema: { type: 'object' },
              annotations: {
                type: 'object', additionalProperties: false,
                required: ['readOnlyHint', 'idempotentHint'],
                properties: {
                  readOnlyHint: { type: 'boolean' },
                  idempotentHint: { type: 'boolean' },
                },
              },
              apollo: {
                type: 'object', additionalProperties: false,
                required: [
                  'capabilityId', 'capabilityVersion', 'operationKind',
                  'requiredScopes', 'endpoint', 'costClass', 'confirmation', 'supportsDryRun',
                ],
                properties: {
                  capabilityId: { type: 'string', pattern: '^apollo\\.' },
                  capabilityVersion: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
                  operationKind: { enum: ['query', 'command', 'preflight', 'job'] },
                  requiredScopes: {
                    type: 'array', uniqueItems: true, items: { type: 'string' },
                  },
                  endpoint: {
                    type: 'object', additionalProperties: false, required: ['method', 'path'],
                    properties: {
                      method: { enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
                      path: { type: 'string', pattern: '^/v1/' },
                    },
                  },
                  costClass: { enum: ['free', 'low', 'medium', 'high', 'variable'] },
                  confirmation: { enum: ['none', 'preflight-token', 'human-approval'] },
                  supportsDryRun: { type: 'boolean' },
                },
              },
            },
          },
        },
      },
    }),
  ),
  defineSchema('agent-tool-list', 2, 'Scope-filtered agent tool list with data trust boundaries',
    successSchema({
      type: 'object', additionalProperties: false, required: ['tools'],
      properties: {
        tools: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            required: ['name', 'title', 'description', 'inputSchema', 'outputSchema', 'errorSchema', 'annotations', 'apollo'],
            properties: {
              name: { type: 'string', pattern: '^[a-z][a-z0-9_.-]{2,127}$' },
              title: { type: 'string', minLength: 1, maxLength: 160 },
              description: { type: 'string', minLength: 1, maxLength: 1000 },
              inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, errorSchema: { type: 'object' },
              annotations: {
                type: 'object', additionalProperties: false, required: ['readOnlyHint', 'idempotentHint'],
                properties: { readOnlyHint: { type: 'boolean' }, idempotentHint: { type: 'boolean' } },
              },
              apollo: {
                type: 'object', additionalProperties: false,
                required: ['capabilityId', 'capabilityVersion', 'operationKind', 'requiredScopes', 'endpoint', 'costClass', 'confirmation', 'supportsDryRun', 'dataBoundary'],
                properties: {
                  capabilityId: { type: 'string', pattern: '^apollo\\.' },
                  capabilityVersion: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
                  operationKind: { enum: ['query', 'command', 'preflight', 'job'] },
                  requiredScopes: { type: 'array', uniqueItems: true, items: { type: 'string' } },
                  endpoint: {
                    type: 'object', additionalProperties: false, required: ['method', 'path'],
                    properties: { method: { enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }, path: { type: 'string', pattern: '^/v1/' } },
                  },
                  costClass: { enum: ['free', 'low', 'medium', 'high', 'variable'] },
                  confirmation: { enum: ['none', 'preflight-token', 'human-approval'] },
                  supportsDryRun: { type: 'boolean' },
                  dataBoundary: {
                    type: 'object', additionalProperties: false,
                    required: ['structureClassification', 'mediaContentClassification', 'instructionPolicy', 'inputPaths', 'outputPaths'],
                    properties: {
                      structureClassification: { const: 'trusted-contract' },
                      mediaContentClassification: { const: 'untrusted-data' },
                      instructionPolicy: { const: 'never-execute' },
                      inputPaths: { type: 'array', uniqueItems: true, items: { type: 'string', pattern: '^/' } },
                      outputPaths: { type: 'array', uniqueItems: true, items: { type: 'string', pattern: '^/' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }),
  ),
  defineSchema('webhook-signing-secret-rotation-list', 1, 'Webhook signing secret rotation list response',
    successSchema({
      type: 'object', additionalProperties: false, required: ['rotations'],
      properties: {
        rotations: { type: 'array', maxItems: 100, items: webhookSigningSecretRotationMetadataSchema },
        nextCursor: { type: 'string', minLength: 8, maxLength: 1024, pattern: '^[A-Za-z0-9_-]+$' },
      },
    }),
  ),
  defineSchema('webhook-signing-secret-rotation-detail', 1, 'Webhook signing secret rotation detail response',
    successSchema({
      type: 'object', additionalProperties: false, required: ['rotation'],
      properties: { rotation: webhookSigningSecretRotationMetadataSchema },
    }),
  ),
  defineSchema('run-webhook-signing-secret-hygiene-request', 1, 'Run webhook signing secret hygiene request', {
    type: 'object', additionalProperties: false, required: ['limitPerKind'],
    properties: { limitPerKind: { type: 'integer', minimum: 1, maximum: 100 } },
  }),
  defineSchema('webhook-signing-secret-hygiene-result', 1, 'Webhook signing secret hygiene result',
    successSchema({
      type: 'object', additionalProperties: false,
      required: [
        'asOf', 'expiredRotations', 'destroyedRotationEnvelopes',
        'destroyedSigningSecretPayloads', 'hasMore',
      ],
      properties: {
        asOf: dateTimeSchema,
        expiredRotations: { type: 'integer', minimum: 0, maximum: 100 },
        destroyedRotationEnvelopes: { type: 'integer', minimum: 0, maximum: 100 },
        destroyedSigningSecretPayloads: { type: 'integer', minimum: 0, maximum: 100 },
        hasMore: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('webhook-subscription-list', 1, 'Webhook subscription list response',
    successSchema({ type: 'object', additionalProperties: false, required: ['subscriptions'], properties: {
      subscriptions: { type: 'array', maxItems: 100, items: webhookSubscriptionSchema },
      nextCursor: { type: 'string', minLength: 8, maxLength: 1024, pattern: '^[A-Za-z0-9_-]+$' },
    } }),
  ),
  defineSchema('create-webhook-subscription-request', 1, 'Create webhook subscription request', {
    type: 'object',
    additionalProperties: false,
    required: ['endpointId', 'eventTypes'],
    properties: {
      endpointId: idSchema,
      eventTypes: {
        type: 'array', minItems: 1, maxItems: 64, uniqueItems: true,
        items: { type: 'string', enum: publicEventTypes },
      },
      resourceIds: {
        type: 'array', minItems: 1, maxItems: 128, uniqueItems: true, items: idSchema,
      },
    },
  }),
  defineSchema('webhook-subscription-created', 1, 'Webhook subscription creation response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['subscription', 'replayed'],
      properties: {
        subscription: webhookSubscriptionSchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('webhook-subscription-detail', 1, 'Webhook subscription detail response',
    successSchema({ type: 'object', additionalProperties: false, required: ['subscription'], properties: { subscription: webhookSubscriptionSchema } }),
  ),
  defineSchema('set-webhook-subscription-status-request', 1, 'Set webhook subscription status request', {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'baseRevision'],
    properties: {
      status: { enum: ['active', 'paused', 'revoked'] },
      baseRevision: sha256Schema,
    },
  }),
  defineSchema('webhook-delivery-detail', 1, 'Webhook delivery diagnostic response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['delivery'],
      properties: { delivery: webhookDeliveryDiagnosticSchema },
    }),
  ),
  defineSchema('webhook-delivery-replay-result', 1, 'Webhook delivery replay response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['delivery', 'replayed'],
      properties: {
        delivery: webhookDeliveryDiagnosticSchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('webhook-event-replay-result', 1, 'Webhook event replay response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['eventId', 'items', 'replayed'],
      properties: {
        eventId: webhookUuidSchema,
        items: { type: 'array', maxItems: 100, items: webhookEventReplayItemSchema },
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('create-project-request', 1, 'Create project request', {
    type: 'object',
    additionalProperties: false,
    required: ['name'],
    properties: { name: { type: 'string', minLength: 2, maxLength: 120 } },
  }),
  defineSchema('project-created', 1, 'Project creation response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['project', 'version', 'replayed'],
      properties: {
        project: projectSchema,
        version: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'sequence', 'baseHash', 'snapshotRefs', 'createdAt'],
          properties: {
            id: idSchema,
            sequence: { type: 'integer', minimum: 1 },
            baseHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            snapshotRefs: {
              type: 'object',
              additionalProperties: false,
              required: ['editPlan', 'policies'],
              properties: { editPlan: idSchema, policies: idSchema },
            },
            createdAt: dateTimeSchema,
          },
        },
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('api-client-list', 1, 'API client list response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['clients'],
      properties: { clients: { type: 'array', items: apiClientSchema } },
    }),
  ),
  defineSchema('create-api-client-request', 1, 'Create API client request', {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'scopes'],
    properties: {
      name: { type: 'string', minLength: 2, maxLength: 120 },
      environment: { enum: ['sandbox', 'production'] },
      scopes: {
        type: 'array',
        uniqueItems: true,
        items: { type: 'string', pattern: '^[a-z-]+:[a-z-]+$' },
      },
    },
  }),
  defineSchema('api-client-created', 1, 'API client creation response',
    successSchema(credentialMutationDataSchema),
  ),
  defineSchema('rotate-api-credential-request', 1, 'Rotate API credential request', {
    type: 'object',
    additionalProperties: false,
    properties: {
      overlapSeconds: { type: 'integer', minimum: 0, maximum: 86400, default: 900 },
    },
  }),
  defineSchema('api-credential-created', 1, 'API credential creation response',
    successSchema(credentialMutationDataSchema),
  ),
  defineSchema('api-credential-revoked', 1, 'API credential revocation response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['credential'],
      properties: { credential: apiCredentialSchema },
    }),
  ),
  defineSchema('error-envelope', 1, 'Public API error envelope', {
    type: 'object',
    additionalProperties: false,
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'message', 'category', 'retryable', 'requestId'],
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          category: { enum: ['auth', 'conflict', 'validation', 'internal'] },
          retryable: { type: 'boolean' },
          requestId: { type: 'string' },
          details: { type: 'object' },
        },
      },
    },
  }),
  defineSchema('error-envelope', 2, 'Public API error envelope with semantic conflict', {
    type: 'object',
    additionalProperties: false,
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'message', 'category', 'retryable', 'requestId'],
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          category: { enum: ['auth', 'conflict', 'validation', 'internal'] },
          retryable: { type: 'boolean' },
          requestId: { type: 'string' },
          details: { type: 'object' },
          conflict: {
            type: 'object',
            additionalProperties: false,
            required: ['currentVersionId', 'conflictingTargets', 'diff'],
            properties: {
              currentVersionId: idSchema,
              conflictingTargets: {
                type: 'array', minItems: 1, maxItems: 1024, uniqueItems: true,
                items: { type: 'string', minLength: 1, maxLength: 256 },
              },
              diff: versionDiffSchema,
            },
          },
        },
      },
    },
  }),
  defineSchema('openapi-document', 1, 'OpenAPI 3.1 document', {
    type: 'object',
    required: ['openapi', 'info', 'paths', 'components'],
    properties: {
      openapi: { const: '3.1.0' },
      info: { type: 'object' },
      paths: { type: 'object' },
      components: { type: 'object' },
    },
  }),
  defineSchema('json-schema-document', 1, 'JSON Schema document', {
    type: 'object',
    required: ['$schema', '$id', 'title'],
    properties: {
      $schema: { const: 'https://json-schema.org/draft/2020-12/schema' },
      $id: { type: 'string', pattern: '^apollo://schemas/' },
      title: { type: 'string' },
    },
  }),
])

const schemasByRef = new Map(PUBLIC_SCHEMAS.map((definition) => [definition.ref, definition]))
const schemasByRoute = new Map(
  PUBLIC_SCHEMAS.map((definition) => [
    `${definition.id}:v${definition.version}`,
    definition,
  ]),
)

export function getPublicSchema(ref: string): PublicSchemaDefinition {
  const definition = schemasByRef.get(ref)
  if (!definition) {
    throw new DomainError('PUBLIC_SCHEMA_NOT_FOUND', 'Public schema was not found')
  }
  return definition
}

export function getPublicSchemaByRoute(id: string, version: string): PublicSchemaDefinition {
  if (!/^v[1-9]\d*$/.test(version)) {
    throw new DomainError('PUBLIC_SCHEMA_NOT_FOUND', 'Public schema was not found')
  }
  const definition = schemasByRoute.get(`${id}:${version}`)
  if (!definition) {
    throw new DomainError('PUBLIC_SCHEMA_NOT_FOUND', 'Public schema was not found')
  }
  return definition
}

export function publicSchemaPath(definition: PublicSchemaDefinition): string {
  return `/v1/schemas/${definition.id}/v${definition.version}`
}
