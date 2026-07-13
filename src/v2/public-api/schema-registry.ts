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
