import type { PublicCapability } from './capability-registry.ts'
import { capabilitiesForScopes } from './capability-registry.ts'
import { getPublicSchema } from './schema-registry.ts'

function embeddedSchema(ref: string) {
  const { $schema: _schema, $id: _id, title: _title, examples: _examples, ...schema } =
    getPublicSchema(ref).schema
  return { ...schema }
}

function pathSchema(capability: PublicCapability) {
  const names = [...(capability.endpoint?.path.matchAll(/\{([^}]+)\}/g) ?? [])]
    .map((match) => match[1])
  if (names.length === 0) return undefined
  return {
    type: 'object',
    additionalProperties: false,
    required: names,
    properties: Object.fromEntries(
      names.map((name) => [name, { type: 'string', minLength: 3, maxLength: 128 }]),
    ),
  }
}

function querySchema(capability: PublicCapability) {
  if (!capability.queryParameters?.length) return undefined
  const required = capability.queryParameters
    .filter((parameter) => parameter.required)
    .map((parameter) => parameter.name)
  return {
    type: 'object',
    additionalProperties: false,
    ...(required.length > 0 ? { required } : {}),
    properties: Object.fromEntries(
      capability.queryParameters.map((parameter) => [
        parameter.name,
        { ...parameter.schema, description: parameter.description },
      ]),
    ),
  }
}

function headerSchema(capability: PublicCapability) {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  if (capability.idempotency === 'required') {
    properties.idempotencyKey = {
      type: 'string', minLength: 1, maxLength: 128,
      description: 'Stable Idempotency-Key value for this logical mutation.',
    }
    required.push('idempotencyKey')
  }
  if (capability.precondition === 'if-match') {
    properties.ifMatch = {
      type: 'string', pattern: '^"[a-f0-9]{64}"$',
      description: 'Strong If-Match ETag returned by the latest resource read.',
    }
    required.push('ifMatch')
  }
  if (required.length === 0) return undefined
  return { type: 'object', additionalProperties: false, required, properties }
}

export function agentToolDescriptor(capability: Readonly<PublicCapability>) {
  const path = pathSchema(capability)
  const query = querySchema(capability)
  const headers = headerSchema(capability)
  const body = capability.inputSchemaRef ? embeddedSchema(capability.inputSchemaRef) : undefined
  const properties = {
    ...(path ? { path } : {}),
    ...(query ? { query } : {}),
    ...(headers ? { headers } : {}),
    ...(body ? { body } : {}),
  }
  const required = [
    ...(path ? ['path'] : []),
    ...(headers ? ['headers'] : []),
    ...(body && (capability.requestBodyRequired ?? true) ? ['body'] : []),
  ]
  return Object.freeze({
    name: capability.toolName,
    title: capability.title,
    description: capability.description,
    inputSchema: Object.freeze({
      type: 'object', additionalProperties: false,
      ...(required.length > 0 ? { required: Object.freeze(required) } : {}),
      properties: Object.freeze(properties),
    }),
    outputSchema: Object.freeze(embeddedSchema(capability.outputSchemaRef)),
    errorSchema: Object.freeze(embeddedSchema('apollo://schemas/error-envelope/v2')),
    annotations: Object.freeze({
      readOnlyHint:
        capability.operationKind === 'query' || capability.operationKind === 'preflight',
      idempotentHint:
        capability.operationKind === 'query' ||
        capability.operationKind === 'preflight' ||
        capability.idempotency !== 'not-applicable',
    }),
    apollo: Object.freeze({
      capabilityId: capability.id,
      capabilityVersion: capability.version,
      operationKind: capability.operationKind,
      requiredScopes: Object.freeze([...capability.requiredScopes]),
      endpoint: capability.endpoint ? Object.freeze({ ...capability.endpoint }) : undefined,
      costClass: capability.costClass,
      confirmation: capability.confirmation,
      supportsDryRun: capability.supportsDryRun,
    }),
  })
}

export function agentToolsForScopes(
  capabilities: readonly PublicCapability[],
  grantedScopes: ReadonlySet<string>,
) {
  return Object.freeze(
    capabilitiesForScopes(capabilities, grantedScopes)
      .filter((capability) => capability.toolName)
      .map(agentToolDescriptor),
  )
}
