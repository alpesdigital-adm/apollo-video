import { stableSerialize } from '../application/version-hash.ts'
import type { PublicCapability } from './capability-registry.ts'
import { FOUNDATION_CAPABILITIES } from './capability-registry.ts'
import { PUBLIC_SCHEMAS, type PublicSchemaDefinition } from './schema-registry.ts'

export interface PublicContractSnapshot {
  schemaVersion: 1
  apiMajor: 'v1'
  capabilities: Record<string, unknown>
  schemas: Record<string, unknown>
}

function snapshotCapability(capability: PublicCapability) {
  return {
    version: capability.version,
    exposure: capability.exposure,
    operationKind: capability.operationKind,
    authMode: capability.authMode,
    requiredScopes: [...capability.requiredScopes],
    inputSchemaRef: capability.inputSchemaRef,
    outputSchemaRef: capability.outputSchemaRef,
    endpoint: capability.endpoint ? { ...capability.endpoint } : undefined,
    toolName: capability.toolName,
    supportsDryRun: capability.supportsDryRun,
    costClass: capability.costClass,
    confirmation: capability.confirmation,
    successStatuses: [...capability.successStatuses],
    idempotency: capability.idempotency,
    ...(capability.precondition ? { precondition: capability.precondition } : {}),
    ...(capability.responseEtag ? { responseEtag: true } : {}),
    queryParameters: capability.queryParameters?.map((parameter) => ({
      ...parameter,
      schema: { ...parameter.schema },
    })),
    requestBodyRequired: capability.inputSchemaRef
      ? capability.requestBodyRequired ?? true
      : undefined,
    responseMediaType: capability.responseMediaType ?? 'application/json',
  }
}

function snapshotSchema(definition: PublicSchemaDefinition) {
  const { $schema: _dialect, $id: _id, title: _title, examples: _examples, ...contract } =
    definition.schema
  return contract
}

export function createPublicContractSnapshot(
  capabilities: readonly PublicCapability[] = FOUNDATION_CAPABILITIES,
  schemas: readonly PublicSchemaDefinition[] = PUBLIC_SCHEMAS,
): PublicContractSnapshot {
  return {
    schemaVersion: 1,
    apiMajor: 'v1',
    capabilities: Object.fromEntries(
      [...capabilities]
        .filter((capability) => capability.exposure !== 'internal-only')
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((capability) => [capability.id, snapshotCapability(capability)]),
    ),
    schemas: Object.fromEntries(
      [...schemas]
        .sort((left, right) => left.ref.localeCompare(right.ref))
        .map((definition) => [definition.ref, snapshotSchema(definition)]),
    ),
  }
}

export function findBreakingContractChanges(
  baseline: PublicContractSnapshot,
  current: PublicContractSnapshot,
): readonly string[] {
  const changes: string[] = []
  if (baseline.schemaVersion !== current.schemaVersion || baseline.apiMajor !== current.apiMajor) {
    changes.push('contract snapshot format or API major changed')
    return changes
  }

  for (const [capabilityId, expected] of Object.entries(baseline.capabilities)) {
    const actual = current.capabilities[capabilityId]
    if (!actual) {
      changes.push(`capability removed: ${capabilityId}`)
    } else if (stableSerialize(actual) !== stableSerialize(expected)) {
      changes.push(`capability contract changed: ${capabilityId}`)
    }
  }
  for (const [schemaRef, expected] of Object.entries(baseline.schemas)) {
    const actual = current.schemas[schemaRef]
    if (!actual) {
      changes.push(`schema removed: ${schemaRef}`)
    } else if (stableSerialize(actual) !== stableSerialize(expected)) {
      changes.push(`schema changed without a new ref: ${schemaRef}`)
    }
  }

  return Object.freeze(changes)
}
