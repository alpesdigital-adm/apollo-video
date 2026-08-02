import type {
  OperationTelemetrySink,
  OperationTelemetryEvent,
} from '../application/ports/operation-telemetry.ts'

interface StructuredLogWriter {
  info(message: string): void
  error(message: string): void
}

export class StructuredConsoleOperationTelemetry implements OperationTelemetrySink {
  private readonly writer: StructuredLogWriter

  constructor(writer: StructuredLogWriter = console) {
    this.writer = writer
  }

  emit(event: Readonly<OperationTelemetryEvent>): void {
    try {
      this.writer.info(JSON.stringify(event))
    } catch {
      try {
        this.writer.error(JSON.stringify({
          schemaVersion: event.schemaVersion,
          event: 'operation.telemetry-failed',
          occurredAt: event.occurredAt,
          traceId: event.traceId,
          jobId: event.jobId,
          workspaceId: event.workspaceId,
        }))
      } catch {
        // Telemetry must never change durable operation behavior.
      }
    }
  }
}

export class CompositeOperationTelemetry implements OperationTelemetrySink {
  private readonly sinks: readonly OperationTelemetrySink[]

  constructor(sinks: readonly OperationTelemetrySink[]) { this.sinks = sinks }

  async emit(event: Readonly<OperationTelemetryEvent>): Promise<void> {
    await Promise.all(this.sinks.map(async (sink) => {
      try { await sink.emit(event) } catch { /* one sink cannot disable the others */ }
    }))
  }
}
