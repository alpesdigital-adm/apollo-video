import { DomainError, assertDomain } from '../domain/errors.ts'

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
  defineSchema('project-list', 1, 'Project list response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['projects'],
      properties: { projects: { type: 'array', items: projectSchema } },
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
