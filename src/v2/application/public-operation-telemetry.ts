import { createHash } from 'node:crypto'

import type {
  PublicOperationRecord,
} from './ports/public-operation-repository.ts'
import {
  PUBLIC_OPERATION_TELEMETRY_SCHEMA_VERSION,
  type PublicOperationTelemetryEvent,
  type PublicOperationTelemetryEventName,
} from './ports/operation-telemetry.ts'

function projectIdOf(record: Readonly<PublicOperationRecord>): string | undefined {
  return 'projectId' in record.context ? record.context.projectId : undefined
}

export function publicOperationTraceId(input: {
  workspaceId: string
  operationId: string
}): string {
  return createHash('sha256')
    .update(`public-operation/v1:${input.workspaceId}:${input.operationId}`)
    .digest('hex')
    .slice(0, 32)
}

export function createPublicOperationTelemetryEvent(input: {
  event: PublicOperationTelemetryEventName
  record: Readonly<PublicOperationRecord>
  occurredAt?: string
}): Readonly<PublicOperationTelemetryEvent> {
  const projectId = projectIdOf(input.record)
  return Object.freeze({
    schemaVersion: PUBLIC_OPERATION_TELEMETRY_SCHEMA_VERSION,
    event: input.event,
    occurredAt: input.occurredAt ?? input.record.operation.updatedAt,
    traceId: publicOperationTraceId({
      workspaceId: input.record.operation.workspaceId,
      operationId: input.record.operation.id,
    }),
    jobId: input.record.operation.id,
    workspaceId: input.record.operation.workspaceId,
    ...(projectId ? { projectId } : {}),
    operationType: input.record.operation.type,
    status: input.record.operation.status,
    phase: input.record.operation.phase,
    attempt: input.record.operation.attempt,
  })
}
