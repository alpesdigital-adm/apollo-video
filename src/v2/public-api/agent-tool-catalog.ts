import type { PublicCapability } from './capability-registry.ts'
import { getPublicSchema } from './schema-registry.ts'
import {
  FOUNDATION_AGENT_TOOL_SAFETY,
  agentToolSafetyFor,
} from './agent-tool-safety.ts'

function embeddedSchema(ref: string) {
  const { $schema: _schema, $id: _id, title: _title, examples: _examples, ...schema } =
    getPublicSchema(ref).schema
  return { ...schema }
}

const UNTRUSTED_MEDIA_FIELDS = new Set([
  'transcript', 'transcripts', 'ocr', 'detectedText', 'recognizedText',
  'mediaMetadata', 'captions', 'subtitles', 'speakerLabels',
])

function untrustedPaths(schema: unknown, prefix = ''): readonly string[] {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return Object.freeze([])
  const record = schema as Record<string, unknown>
  const paths: string[] = []
  if (typeof record.properties === 'object' && record.properties !== null && !Array.isArray(record.properties)) {
    for (const [name, child] of Object.entries(record.properties as Record<string, unknown>)) {
      const path = `${prefix}/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`
      if (UNTRUSTED_MEDIA_FIELDS.has(name)) paths.push(path)
      paths.push(...untrustedPaths(child, path))
    }
  }
  if (record.items) paths.push(...untrustedPaths(record.items, `${prefix}/*`))
  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    if (Array.isArray(record[keyword])) {
      for (const child of record[keyword] as unknown[]) paths.push(...untrustedPaths(child, prefix))
    }
  }
  return Object.freeze([...new Set(paths)].sort())
}

export function agentDataBoundaryForSchemas(inputSchema: unknown, outputSchema: unknown) {
  return Object.freeze({
    structureClassification: 'trusted-contract' as const,
    mediaContentClassification: 'untrusted-data' as const,
    instructionPolicy: 'never-execute' as const,
    inputPaths: untrustedPaths(inputSchema),
    outputPaths: untrustedPaths(outputSchema),
  })
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
  const toolName = capability.toolName
  if (!toolName) throw new Error('Agent tool descriptor requires a tool name')
  const safety = agentToolSafetyFor(capability, FOUNDATION_AGENT_TOOL_SAFETY)
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
  const inputSchema = Object.freeze({
    type: 'object', additionalProperties: false,
    ...(required.length > 0 ? { required: Object.freeze(required) } : {}),
    properties: Object.freeze(properties),
  })
  const outputSchema = Object.freeze(embeddedSchema(capability.outputSchemaRef))
  const dataBoundary = agentDataBoundaryForSchemas(inputSchema, outputSchema)
  return Object.freeze({
    name: toolName,
    title: capability.title,
    description:
      safety.confirmation === 'human-approval'
        ? `${capability.description} Requires trusted human approval from the host before execution.`
        : safety.confirmation === 'preflight-token'
          ? `${capability.description} Requires a valid bound preflight token before execution.`
          : capability.description,
    inputSchema,
    outputSchema,
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
      confirmation: safety.confirmation,
      supportsDryRun: capability.supportsDryRun,
      dataBoundary,
    }),
  })
}

export type AgentToolDescriptor = ReturnType<typeof agentToolDescriptor>

export function agentToolsForCapabilities(
  capabilities: readonly PublicCapability[],
) {
  return Object.freeze(
    capabilities.filter((capability) => capability.toolName).map(agentToolDescriptor),
  )
}
