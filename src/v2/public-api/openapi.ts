import type { PublicCapability } from './capability-registry.ts'
import { FOUNDATION_CAPABILITIES } from './capability-registry.ts'
import {
  PUBLIC_SCHEMAS,
  getPublicSchema,
  publicSchemaPath,
  type PublicSchemaDefinition,
} from './schema-registry.ts'
import { publicSchemaDocument } from './schema-examples.ts'

function componentName(definition: PublicSchemaDefinition): string {
  const name = definition.id
    .split('-')
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join('')
  return `${name}V${definition.version}`
}

function schemaReference(ref: string) {
  return { $ref: `#/components/schemas/${componentName(getPublicSchema(ref))}` }
}

function securityFor(capability: PublicCapability) {
  if (capability.authMode === 'none') return []
  if (capability.authMode === 'optional') return [{}, { bearerAuth: [] }]
  return [{ bearerAuth: [] }]
}

function parametersFor(capability: PublicCapability) {
  const parameters: Array<Record<string, unknown>> = []
  for (const match of capability.endpoint?.path.matchAll(/\{([^}]+)\}/g) ?? []) {
    parameters.push({
      name: match[1],
      in: 'path',
      required: true,
      description: `Public ${match[1]} identifier.`,
      schema: { type: 'string', minLength: 3, maxLength: 128 },
    })
  }
  for (const parameter of capability.queryParameters ?? []) {
    parameters.push({
      name: parameter.name,
      in: 'query',
      required: parameter.required,
      description: parameter.description,
      schema: { ...parameter.schema },
    })
  }
  if (capability.idempotency === 'required') {
    parameters.push({
      name: 'Idempotency-Key',
      in: 'header',
      required: true,
      description: 'Stable key for replaying the same mutation without duplicating effects.',
      schema: { type: 'string', minLength: 1, maxLength: 128 },
    })
  }
  if (capability.precondition === 'if-match') {
    parameters.push({
      name: 'If-Match',
      in: 'header',
      required: true,
      description: 'Strong ETag returned by the latest read or successful mutation.',
      schema: { type: 'string', pattern: '^"[a-f0-9]{64}"$' },
    })
  }
  return parameters
}

function responsesFor(capability: PublicCapability) {
  const responses: Record<string, unknown> = {}
  for (const status of capability.successStatuses) {
    responses[String(status)] = {
      description: status === 201 ? 'Resource created.' : 'Request completed successfully.',
      headers: {
        'Apollo-API-Version': { schema: { type: 'string', const: 'v1' } },
        'Apollo-Request-Id': { schema: { type: 'string' } },
        ...(capability.responseEtag
          ? {
              ETag: {
                description: 'Strong revision validator for the returned resource state.',
                schema: { type: 'string', pattern: '^"[a-f0-9]{64}"$' },
              },
            }
          : {}),
      },
      content: {
        [capability.responseMediaType ?? 'application/json']: {
          schema: schemaReference(capability.outputSchemaRef),
        },
      },
    }
  }
  const errorResponse = {
    description: 'Public error envelope without internal diagnostics.',
    content: {
      'application/json': {
        schema: schemaReference('apollo://schemas/error-envelope/v1'),
      },
    },
  }
  for (const status of [401, 403, 404, 409, 422, 500, 502]) {
    responses[String(status)] = errorResponse
  }
  if (capability.precondition === 'if-match') {
    responses['412'] = errorResponse
    responses['428'] = errorResponse
  }
  return responses
}

export function createOpenApiDocument(
  capabilities: readonly PublicCapability[] = FOUNDATION_CAPABILITIES,
) {
  for (const capability of capabilities) {
    getPublicSchema(capability.outputSchemaRef)
    if (capability.inputSchemaRef) getPublicSchema(capability.inputSchemaRef)
  }

  const schemas = Object.fromEntries(
    PUBLIC_SCHEMAS.map((definition) => [componentName(definition), publicSchemaDocument(definition)]),
  )
  const paths: Record<string, Record<string, unknown>> = {}
  for (const capability of capabilities) {
    if (!capability.endpoint || capability.exposure === 'internal-only') continue
    const path = (paths[capability.endpoint.path] ??= {})
    path[capability.endpoint.method.toLowerCase()] = {
      operationId: capability.id.replaceAll('.', '_').replaceAll('-', '_'),
      summary: capability.title,
      description: capability.description,
      tags: [capability.id.split('.')[1] ?? 'apollo'],
      security: securityFor(capability),
      parameters: parametersFor(capability),
      requestBody: capability.inputSchemaRef
        ? {
            required: capability.requestBodyRequired ?? true,
            content: {
              'application/json': { schema: schemaReference(capability.inputSchemaRef) },
            },
          }
        : undefined,
      responses: responsesFor(capability),
      'x-apollo-capability-id': capability.id,
      'x-apollo-capability-version': capability.version,
      'x-apollo-required-scopes': [...capability.requiredScopes],
      'x-apollo-idempotency': capability.idempotency,
    }
  }

  return {
    openapi: '3.1.0',
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: {
      title: 'Apollo Video Public API',
      version: '1.0.0',
      description: 'API-first contract shared by the Apollo UI, external agents and MCP adapter.',
    },
    servers: [{ url: '/' }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'Apollo service credential' },
      },
      schemas,
    },
    'x-apollo-schema-routes': Object.fromEntries(
      PUBLIC_SCHEMAS.map((definition) => [definition.ref, publicSchemaPath(definition)]),
    ),
  } as const
}
