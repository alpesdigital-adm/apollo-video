import { createHash } from 'node:crypto'

import type {
  OperationTelemetrySink,
  PublicOperationSpanKind,
  PublicOperationSpanName,
  PublicOperationSpanMetrics,
  PublicOperationSpanTelemetryEvent,
} from './ports/operation-telemetry.ts'
import type {
  ClaimedPublicOperationRecord,
} from './ports/public-operation-repository.ts'
import { publicOperationTraceId } from './public-operation-telemetry.ts'

function emitSafely(
  telemetry: OperationTelemetrySink,
  event: Readonly<PublicOperationSpanTelemetryEvent>,
): void {
  try {
    const emission = telemetry.emit(event)
    if (emission && typeof emission.then === 'function') {
      void emission.catch(() => undefined)
    }
  } catch {
    // Telemetry must never change provider or renderer behavior.
  }
}

function projectIdOf(
  record: Readonly<ClaimedPublicOperationRecord>,
): string | undefined {
  return 'projectId' in record.context
    ? record.context.projectId
    : undefined
}

export async function runPublicOperationSpan<T>(input: {
  telemetry: OperationTelemetrySink
  record: Readonly<ClaimedPublicOperationRecord>
  spanKind: PublicOperationSpanKind
  spanName: PublicOperationSpanName
  clock?: () => Date
  action: () => Promise<T>
  metrics?: (result: T) => Readonly<PublicOperationSpanMetrics>
}): Promise<T> {
  const clock = input.clock ?? (() => new Date())
  const startedAt = clock()
  const traceId = input.record.traceId ?? publicOperationTraceId({
    workspaceId: input.record.operation.workspaceId,
    operationId: input.record.operation.id,
  })
  const spanId = createHash('sha256')
    .update([
      'public-operation-span/v1',
      traceId,
      input.record.operation.id,
      input.record.lease.attempt,
      input.spanKind,
      input.spanName,
    ].join(':'))
    .digest('hex')
    .slice(0, 24)
  const projectId = projectIdOf(input.record)
  const common = {
    schemaVersion: 'public-operation-span-telemetry/v1' as const,
    traceId,
    spanId,
    jobId: input.record.operation.id,
    workspaceId: input.record.operation.workspaceId,
    ...(projectId ? { projectId } : {}),
    operationType: input.record.operation.type,
    attempt: input.record.lease.attempt,
    spanKind: input.spanKind,
    spanName: input.spanName,
  }
  emitSafely(input.telemetry, Object.freeze({
    ...common,
    event: 'operation.span-started',
    occurredAt: startedAt.toISOString(),
  }))
  try {
    const result = await input.action()
    const completedAt = clock()
    let metrics: PublicOperationSpanMetrics = {}
    try {
      const measured = input.metrics?.(result) ?? {}
      metrics = Object.fromEntries(Object.entries(measured).filter(([, value]) =>
        Number.isSafeInteger(value) && (value as number) >= 0))
    } catch {
      // Invalid measurement must not alter provider or renderer behavior.
    }
    emitSafely(input.telemetry, Object.freeze({
      ...common,
      event: 'operation.span-succeeded',
      occurredAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      ...metrics,
    }))
    return result
  } catch (error) {
    const completedAt = clock()
    emitSafely(input.telemetry, Object.freeze({
      ...common,
      event: 'operation.span-failed',
      occurredAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
    }))
    throw error
  }
}
