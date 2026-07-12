import type { PublicCapability } from './capability-registry.ts'

export const PUBLIC_API_VERSION = 'v1' as const

export interface PublicSuccess<T> {
  data: T
  meta: {
    apiVersion: typeof PUBLIC_API_VERSION
  }
}
export function presentSuccess<T>(data: T): PublicSuccess<T> {
  return {
    data,
    meta: { apiVersion: PUBLIC_API_VERSION },
  }
}

export function presentCapability(capability: PublicCapability) {
  return {
    id: capability.id,
    version: capability.version,
    title: capability.title,
    description: capability.description,
    operationKind: capability.operationKind,
    requiredScopes: [...capability.requiredScopes],
    inputSchemaRef: capability.inputSchemaRef,
    outputSchemaRef: capability.outputSchemaRef,
    endpoint: capability.endpoint,
    toolName: capability.toolName,
    supportsDryRun: capability.supportsDryRun,
    costClass: capability.costClass,
    confirmation: capability.confirmation,
  }
}
