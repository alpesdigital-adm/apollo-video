import { createHash } from 'node:crypto'

import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type {
  OperationTelemetryAlert,
  OperationAlertSink,
  OperationTelemetryEvent,
  OperationTelemetrySink,
} from '../../application/ports/operation-telemetry.ts'
import type {
  OperationTelemetryMetricAggregate,
  OperationTelemetryQueryRepository,
} from '../../application/ports/operation-telemetry-query-repository.ts'

function contentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function optionalBigInt(value: number | undefined): bigint | undefined {
  return value === undefined ? undefined : BigInt(value)
}

function count(value: bigint): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Telemetry aggregate exceeds safe response limits')
  return result
}

function metric(sampleCount: bigint, total: bigint, maximum: bigint): Readonly<OperationTelemetryMetricAggregate> {
  return Object.freeze({ sampleCount: count(sampleCount), total: total.toString(), maximum: maximum.toString() })
}

interface SummaryRow {
  eventTotal: bigint
  created: bigint
  succeeded: bigint
  failed: bigint
  canceled: bigint
  spansSucceeded: bigint
  spansFailed: bigint
  alertTotal: bigint
  warning: bigint
  critical: bigint
  operationFailed: bigint
  queueWaitHigh: bigint
  runDurationHigh: bigint
  spanDurationHigh: bigint
  costHigh: bigint
  queueWaitCount: bigint
  queueWaitTotal: bigint
  queueWaitMax: bigint
  runDurationCount: bigint
  runDurationTotal: bigint
  runDurationMax: bigint
  spanDurationCount: bigint
  spanDurationTotal: bigint
  spanDurationMax: bigint
  inputBytesCount: bigint
  inputBytesTotal: bigint
  inputBytesMax: bigint
  outputBytesCount: bigint
  outputBytesTotal: bigint
  outputBytesMax: bigint
  inputTokensCount: bigint
  inputTokensTotal: bigint
  inputTokensMax: bigint
  outputTokensCount: bigint
  outputTokensTotal: bigint
  outputTokensMax: bigint
  costCount: bigint
  costTotal: bigint
  costMax: bigint
}

export class PrismaOperationTelemetryRepository implements OperationTelemetrySink, OperationAlertSink, OperationTelemetryQueryRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient) { this.client = client }

  async emit(event: Readonly<OperationTelemetryEvent>): Promise<void> {
    await this.recordEvent(event)
  }

  async emitAlert(alert: Readonly<OperationTelemetryAlert>): Promise<void> {
    await this.recordAlert(alert)
  }

  async recordEvent(event: Readonly<OperationTelemetryEvent>): Promise<void> {
    const span = event.schemaVersion === 'public-operation-span-telemetry/v1'
    await this.client.v2OperationTelemetryEvent.upsert({
      where: { eventHash: contentHash(event) },
      update: {},
      create: {
        eventHash: contentHash(event), workspaceId: event.workspaceId, schemaVersion: event.schemaVersion,
        event: event.event, occurredAt: new Date(event.occurredAt), traceId: event.traceId, jobId: event.jobId,
        projectId: event.projectId, operationType: event.operationType, attempt: event.attempt,
        ...(!span ? { status: event.status, phase: event.phase, queueWaitMs: optionalBigInt(event.queueWaitMs), runDurationMs: optionalBigInt(event.runDurationMs) } : {}),
        ...(span ? {
          spanId: event.spanId, spanKind: event.spanKind, spanName: event.spanName,
          durationMs: optionalBigInt(event.durationMs), inputBytes: optionalBigInt(event.inputBytes),
          outputBytes: optionalBigInt(event.outputBytes), inputTokens: optionalBigInt(event.inputTokens),
          outputTokens: optionalBigInt(event.outputTokens), costMinorUnits: optionalBigInt(event.costMinorUnits),
        } : {}),
      },
    })
  }

  async recordAlert(alert: Readonly<OperationTelemetryAlert>): Promise<void> {
    const alertHash = contentHash(alert)
    await this.client.v2OperationTelemetryAlert.upsert({
      where: { alertHash }, update: {},
      create: {
        alertHash, workspaceId: alert.workspaceId, schemaVersion: alert.schemaVersion,
        occurredAt: new Date(alert.occurredAt), alertKind: alert.alertKind, severity: alert.severity,
        traceId: alert.traceId, jobId: alert.jobId, projectId: alert.projectId,
        operationType: alert.operationType, observed: BigInt(alert.observed), threshold: BigInt(alert.threshold),
      },
    })
  }

  async summarize(input: Readonly<{ workspaceId: string; from: string; to: string }>) {
    const from = new Date(input.from)
    const to = new Date(input.to)
    const rows = await this.client.$queryRaw<SummaryRow[]>(Prisma.sql`
      WITH e AS (
        SELECT * FROM "operation_telemetry_events"
        WHERE "workspaceId" = ${input.workspaceId} AND "occurredAt" >= ${from} AND "occurredAt" < ${to}
      ), a AS (
        SELECT * FROM "operation_telemetry_alerts"
        WHERE "workspaceId" = ${input.workspaceId} AND "occurredAt" >= ${from} AND "occurredAt" < ${to}
      )
      SELECT
        (SELECT COUNT(*) FROM e) AS "eventTotal",
        (SELECT COUNT(*) FROM e WHERE "event" = 'operation.created') AS "created",
        (SELECT COUNT(*) FROM e WHERE "event" = 'operation.succeeded') AS "succeeded",
        (SELECT COUNT(*) FROM e WHERE "event" = 'operation.failed') AS "failed",
        (SELECT COUNT(*) FROM e WHERE "event" = 'operation.canceled') AS "canceled",
        (SELECT COUNT(*) FROM e WHERE "event" = 'operation.span-succeeded') AS "spansSucceeded",
        (SELECT COUNT(*) FROM e WHERE "event" = 'operation.span-failed') AS "spansFailed",
        (SELECT COUNT(*) FROM a) AS "alertTotal",
        (SELECT COUNT(*) FROM a WHERE "severity" = 'warning') AS "warning",
        (SELECT COUNT(*) FROM a WHERE "severity" = 'critical') AS "critical",
        (SELECT COUNT(*) FROM a WHERE "alertKind" = 'operation-failed') AS "operationFailed",
        (SELECT COUNT(*) FROM a WHERE "alertKind" = 'queue-wait-high') AS "queueWaitHigh",
        (SELECT COUNT(*) FROM a WHERE "alertKind" = 'run-duration-high') AS "runDurationHigh",
        (SELECT COUNT(*) FROM a WHERE "alertKind" = 'span-duration-high') AS "spanDurationHigh",
        (SELECT COUNT(*) FROM a WHERE "alertKind" = 'cost-high') AS "costHigh",
        (SELECT COUNT("queueWaitMs") FROM e) AS "queueWaitCount", (SELECT COALESCE(SUM("queueWaitMs"), 0) FROM e) AS "queueWaitTotal", (SELECT COALESCE(MAX("queueWaitMs"), 0) FROM e) AS "queueWaitMax",
        (SELECT COUNT("runDurationMs") FROM e) AS "runDurationCount", (SELECT COALESCE(SUM("runDurationMs"), 0) FROM e) AS "runDurationTotal", (SELECT COALESCE(MAX("runDurationMs"), 0) FROM e) AS "runDurationMax",
        (SELECT COUNT("durationMs") FROM e) AS "spanDurationCount", (SELECT COALESCE(SUM("durationMs"), 0) FROM e) AS "spanDurationTotal", (SELECT COALESCE(MAX("durationMs"), 0) FROM e) AS "spanDurationMax",
        (SELECT COUNT("inputBytes") FROM e) AS "inputBytesCount", (SELECT COALESCE(SUM("inputBytes"), 0) FROM e) AS "inputBytesTotal", (SELECT COALESCE(MAX("inputBytes"), 0) FROM e) AS "inputBytesMax",
        (SELECT COUNT("outputBytes") FROM e) AS "outputBytesCount", (SELECT COALESCE(SUM("outputBytes"), 0) FROM e) AS "outputBytesTotal", (SELECT COALESCE(MAX("outputBytes"), 0) FROM e) AS "outputBytesMax",
        (SELECT COUNT("inputTokens") FROM e) AS "inputTokensCount", (SELECT COALESCE(SUM("inputTokens"), 0) FROM e) AS "inputTokensTotal", (SELECT COALESCE(MAX("inputTokens"), 0) FROM e) AS "inputTokensMax",
        (SELECT COUNT("outputTokens") FROM e) AS "outputTokensCount", (SELECT COALESCE(SUM("outputTokens"), 0) FROM e) AS "outputTokensTotal", (SELECT COALESCE(MAX("outputTokens"), 0) FROM e) AS "outputTokensMax",
        (SELECT COUNT("costMinorUnits") FROM e) AS "costCount", (SELECT COALESCE(SUM("costMinorUnits"), 0) FROM e) AS "costTotal", (SELECT COALESCE(MAX("costMinorUnits"), 0) FROM e) AS "costMax"
    `)
    const row = rows[0]
    if (!row) throw new Error('Telemetry summary query returned no row')
    return Object.freeze({
      from: input.from, to: input.to,
      events: Object.freeze({ total: count(row.eventTotal), created: count(row.created), succeeded: count(row.succeeded), failed: count(row.failed), canceled: count(row.canceled), spansSucceeded: count(row.spansSucceeded), spansFailed: count(row.spansFailed) }),
      alerts: Object.freeze({ total: count(row.alertTotal), warning: count(row.warning), critical: count(row.critical), operationFailed: count(row.operationFailed), queueWaitHigh: count(row.queueWaitHigh), runDurationHigh: count(row.runDurationHigh), spanDurationHigh: count(row.spanDurationHigh), costHigh: count(row.costHigh) }),
      metrics: Object.freeze({
        queueWaitMs: metric(row.queueWaitCount, row.queueWaitTotal, row.queueWaitMax), runDurationMs: metric(row.runDurationCount, row.runDurationTotal, row.runDurationMax), spanDurationMs: metric(row.spanDurationCount, row.spanDurationTotal, row.spanDurationMax),
        inputBytes: metric(row.inputBytesCount, row.inputBytesTotal, row.inputBytesMax), outputBytes: metric(row.outputBytesCount, row.outputBytesTotal, row.outputBytesMax), inputTokens: metric(row.inputTokensCount, row.inputTokensTotal, row.inputTokensMax), outputTokens: metric(row.outputTokensCount, row.outputTokensTotal, row.outputTokensMax), costMinorUnits: metric(row.costCount, row.costTotal, row.costMax),
      }),
    })
  }
}
