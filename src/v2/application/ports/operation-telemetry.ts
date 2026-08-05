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
  queueWaitMs?: number
  runDurationMs?: number
}

export const PUBLIC_OPERATION_SPAN_TELEMETRY_SCHEMA_VERSION =
  'public-operation-span-telemetry/v1' as const

export type PublicOperationSpanKind = 'provider' | 'renderer'
export type PublicOperationSpanName =
  | 'ffmpeg-media-normalize'
  | 'groq-transcription'
  | 'media-transcription'
  | 'ffmpeg-editorial-proxy'
  | 'remotion-authorized-render'
  | 'ffmpeg-final-export'
  | 'ffmpeg-source-cleanup'
  | 'long-form-transcript'
  | 'openai-diarization'
  | 'speaker-diarization'
  | 'long-form-derived-analysis'

export interface PublicOperationSpanTelemetryEvent {
  schemaVersion: typeof PUBLIC_OPERATION_SPAN_TELEMETRY_SCHEMA_VERSION
  event:
    | 'operation.span-started'
    | 'operation.span-succeeded'
    | 'operation.span-failed'
  occurredAt: string
  traceId: string
  spanId: string
  jobId: string
  workspaceId: string
  projectId?: string
  operationType: PublicOperation['type']
  attempt: number
  spanKind: PublicOperationSpanKind
  spanName: PublicOperationSpanName
  durationMs?: number
  inputBytes?: number
  outputBytes?: number
  inputTokens?: number
  outputTokens?: number
  costMinorUnits?: number
}

export interface PublicOperationSpanMetrics {
  inputBytes?: number
  outputBytes?: number
  inputTokens?: number
  outputTokens?: number
  costMinorUnits?: number
}

export type OperationTelemetryEvent =
  | PublicOperationTelemetryEvent
  | PublicOperationSpanTelemetryEvent

export interface OperationTelemetryAlert {
  schemaVersion: 'public-operation-alert/v1'
  event: 'operation.alert-triggered'
  occurredAt: string
  alertKind: 'operation-failed' | 'queue-wait-high' | 'run-duration-high' | 'span-duration-high' | 'cost-high'
  severity: 'warning' | 'critical'
  traceId: string
  jobId: string
  workspaceId: string
  projectId?: string
  operationType: OperationTelemetryEvent['operationType']
  observed: number
  threshold: number
}

export interface OperationTelemetrySink {
  emit(event: Readonly<OperationTelemetryEvent>): void | Promise<void>
}

export interface OperationAlertSink {
  emitAlert(alert: Readonly<OperationTelemetryAlert>): void | Promise<void>
}
