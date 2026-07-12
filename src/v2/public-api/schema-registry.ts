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
      then: { required: ['token'] },
      else: { not: { required: ['token'] } },
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
