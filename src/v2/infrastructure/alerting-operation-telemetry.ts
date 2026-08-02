import type {
  OperationTelemetryEvent,
  OperationTelemetrySink,
} from '../application/ports/operation-telemetry.ts'
import { DomainError } from '../domain/errors.ts'

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

export interface OperationAlertThresholds {
  queueWaitMs: number
  runDurationMs: number
  spanDurationMs: number
  costMinorUnits: number
}

const DEFAULT_THRESHOLDS: OperationAlertThresholds = Object.freeze({
  queueWaitMs: 60_000,
  runDurationMs: 900_000,
  spanDurationMs: 600_000,
  costMinorUnits: 10_000,
})

function threshold(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', `${name} alert threshold is invalid`)
  return parsed
}

export function operationAlertThresholdsFromEnvironment(environment: NodeJS.ProcessEnv = process.env): OperationAlertThresholds {
  return Object.freeze({
    queueWaitMs: threshold(environment.APOLLO_V2_ALERT_QUEUE_WAIT_MS, DEFAULT_THRESHOLDS.queueWaitMs, 'Queue wait'),
    runDurationMs: threshold(environment.APOLLO_V2_ALERT_RUN_DURATION_MS, DEFAULT_THRESHOLDS.runDurationMs, 'Run duration'),
    spanDurationMs: threshold(environment.APOLLO_V2_ALERT_SPAN_DURATION_MS, DEFAULT_THRESHOLDS.spanDurationMs, 'Span duration'),
    costMinorUnits: threshold(environment.APOLLO_V2_ALERT_COST_MINOR_UNITS, DEFAULT_THRESHOLDS.costMinorUnits, 'Cost'),
  })
}

export function evaluateOperationTelemetryAlerts(
  event: Readonly<OperationTelemetryEvent>,
  thresholds: Readonly<OperationAlertThresholds>,
): readonly Readonly<OperationTelemetryAlert>[] {
  const common = {
    schemaVersion: 'public-operation-alert/v1' as const,
    event: 'operation.alert-triggered' as const,
    occurredAt: event.occurredAt,
    traceId: event.traceId,
    jobId: event.jobId,
    workspaceId: event.workspaceId,
    ...('projectId' in event && event.projectId ? { projectId: event.projectId } : {}),
    operationType: event.operationType,
  }
  const alerts: OperationTelemetryAlert[] = []
  const add = (alertKind: OperationTelemetryAlert['alertKind'], severity: OperationTelemetryAlert['severity'], observed: number, limit: number) => {
    if (observed >= limit) alerts.push(Object.freeze({ ...common, alertKind, severity, observed, threshold: limit }))
  }
  if (event.schemaVersion === 'public-operation-telemetry/v1') {
    if (event.event === 'operation.failed') alerts.push(Object.freeze({ ...common, alertKind: 'operation-failed', severity: 'critical', observed: 1, threshold: 1 }))
    if (event.queueWaitMs !== undefined) add('queue-wait-high', 'warning', event.queueWaitMs, thresholds.queueWaitMs)
    if (event.runDurationMs !== undefined) add('run-duration-high', 'warning', event.runDurationMs, thresholds.runDurationMs)
  } else if (event.event !== 'operation.span-started') {
    if (event.durationMs !== undefined) add('span-duration-high', 'warning', event.durationMs, thresholds.spanDurationMs)
    if (event.costMinorUnits !== undefined) add('cost-high', 'critical', event.costMinorUnits, thresholds.costMinorUnits)
  }
  return Object.freeze(alerts)
}

interface AlertWriter { error(message: string): void }

export class AlertingOperationTelemetry implements OperationTelemetrySink {
  private readonly downstream: OperationTelemetrySink
  private readonly thresholds: Readonly<OperationAlertThresholds>
  private readonly writer: AlertWriter

  constructor(
    downstream: OperationTelemetrySink,
    thresholds: Readonly<OperationAlertThresholds>,
    writer: AlertWriter = console,
  ) {
    this.downstream = downstream
    this.thresholds = thresholds
    this.writer = writer
  }

  async emit(event: Readonly<OperationTelemetryEvent>): Promise<void> {
    try { await this.downstream.emit(event) } catch { /* telemetry remains best-effort */ }
    for (const alert of evaluateOperationTelemetryAlerts(event, this.thresholds)) {
      try { this.writer.error(JSON.stringify(alert)) } catch { /* alert delivery cannot change jobs */ }
    }
  }
}
