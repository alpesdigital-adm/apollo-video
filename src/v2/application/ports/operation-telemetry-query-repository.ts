import type { OperationTelemetryAlert, OperationTelemetryEvent } from './operation-telemetry.ts'

export interface OperationTelemetryMetricAggregate {
  sampleCount: number
  total: string
  maximum: string
}

export interface OperationTelemetrySummary {
  from: string
  to: string
  events: Readonly<{
    total: number
    created: number
    succeeded: number
    failed: number
    canceled: number
    spansSucceeded: number
    spansFailed: number
  }>
  alerts: Readonly<{
    total: number
    warning: number
    critical: number
    operationFailed: number
    queueWaitHigh: number
    runDurationHigh: number
    spanDurationHigh: number
    costHigh: number
  }>
  metrics: Readonly<{
    queueWaitMs: Readonly<OperationTelemetryMetricAggregate>
    runDurationMs: Readonly<OperationTelemetryMetricAggregate>
    spanDurationMs: Readonly<OperationTelemetryMetricAggregate>
    inputBytes: Readonly<OperationTelemetryMetricAggregate>
    outputBytes: Readonly<OperationTelemetryMetricAggregate>
    inputTokens: Readonly<OperationTelemetryMetricAggregate>
    outputTokens: Readonly<OperationTelemetryMetricAggregate>
    costMinorUnits: Readonly<OperationTelemetryMetricAggregate>
  }>
}

export interface OperationTelemetryQueryRepository {
  recordEvent(event: Readonly<OperationTelemetryEvent>): Promise<void>
  recordAlert(alert: Readonly<OperationTelemetryAlert>): Promise<void>
  summarize(input: Readonly<{ workspaceId: string; from: string; to: string }>): Promise<Readonly<OperationTelemetrySummary>>
}
