import type {
  OperationTelemetrySink,
  PublicOperationTelemetryEvent,
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

  emit(event: Readonly<PublicOperationTelemetryEvent>): void {
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
