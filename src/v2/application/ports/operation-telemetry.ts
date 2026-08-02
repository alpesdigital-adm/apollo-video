import type {
  PublicOperation,
  PublicOperationStatus,
} from '../../domain/public-operation.ts'

export const PUBLIC_OPERATION_TELEMETRY_SCHEMA_VERSION =
  'public-operation-telemetry/v1' as const

export type PublicOperationTelemetryEventName =
  | 'operation.created'
  | 'operation.replayed'
  | 'operation.claimed'
  | 'operation.heartbeat'
  | 'operation.phase-advanced'
  | 'operation.waiting'
  | 'operation.resumed'
  | 'operation.succeeded'
  | 'operation.retrying'
  | 'operation.failed'
  | 'operation.canceled'
  | 'operation.retry-requested'

export interface PublicOperationTelemetryEvent {
  schemaVersion: typeof PUBLIC_OPERATION_TELEMETRY_SCHEMA_VERSION
  event: PublicOperationTelemetryEventName
  occurredAt: string
  traceId: string
  jobId: string
  workspaceId: string
  projectId?: string
  operationType: PublicOperation['type']
  status: PublicOperationStatus
  phase: PublicOperation['phase']
  attempt: number
}

export interface OperationTelemetrySink {
  emit(event: Readonly<PublicOperationTelemetryEvent>): void | Promise<void>
}
