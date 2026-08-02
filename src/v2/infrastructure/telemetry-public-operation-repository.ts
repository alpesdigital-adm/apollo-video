import type {
  PublicOperation,
  PublicOperationRunningPhase,
} from '../domain/public-operation.ts'
import type {
  OperationTelemetrySink,
  PublicOperationTelemetryEventName,
} from '../application/ports/operation-telemetry.ts'
import type {
  ClaimedPublicOperationRecord,
  PublicOperationLeaseCommand,
  PublicOperationListQuery,
  PublicOperationPersistenceResult,
  PublicOperationRecord,
  PublicOperationRepository,
  ResumeWaitingPublicOperationCommand,
} from '../application/ports/public-operation-repository.ts'
import { createPublicOperationTelemetryEvent } from '../application/public-operation-telemetry.ts'

export class TelemetryPublicOperationRepository implements PublicOperationRepository {
  private readonly claims = new Map<string, ClaimedPublicOperationRecord>()
  private readonly repository: PublicOperationRepository
  private readonly telemetry: OperationTelemetrySink

  constructor(
    repository: PublicOperationRepository,
    telemetry: OperationTelemetrySink,
  ) {
    this.repository = repository
    this.telemetry = telemetry
  }

  private emit(
    event: PublicOperationTelemetryEventName,
    record: Readonly<PublicOperationRecord>,
    occurredAt?: string,
  ): void {
    try {
      const emission = this.telemetry.emit(createPublicOperationTelemetryEvent({
        event,
        record,
        ...(occurredAt ? { occurredAt } : {}),
      }))
      if (emission && typeof emission.then === 'function') {
        void emission.catch(() => undefined)
      }
    } catch {
      // Telemetry must never change durable operation behavior.
    }
  }

  findById(workspaceId: string, operationId: string) {
    return this.repository.findById(workspaceId, operationId)
  }

  list(input: PublicOperationListQuery) {
    return this.repository.list(input)
  }

  async cancel(input: Parameters<PublicOperationRepository['cancel']>[0]) {
    const record = await this.repository.cancel(input)
    if (record?.operation.status === 'canceled') {
      this.claims.delete(record.operation.id)
      this.emit('operation.canceled', record, input.canceledAt)
    }
    return record
  }

  async retry(input: Parameters<PublicOperationRepository['retry']>[0]) {
    const record = await this.repository.retry(input)
    if (record) this.emit('operation.retry-requested', record, input.requestedAt)
    return record
  }

  findReplay(input: Parameters<PublicOperationRepository['findReplay']>[0]) {
    return this.repository.findReplay(input)
  }

  async createOrReplay(
    input: Parameters<PublicOperationRepository['createOrReplay']>[0],
  ): Promise<PublicOperationPersistenceResult> {
    const record = await this.repository.createOrReplay(input)
    this.emit(record.replayed ? 'operation.replayed' : 'operation.created', record)
    return record
  }

  async claimNext(input: {
    leaseOwner: string
    now: string
    leaseUntil: string
    workspaceId?: string
    type?: PublicOperation['type']
  }): Promise<ClaimedPublicOperationRecord | null> {
    const record = await this.repository.claimNext(input)
    if (record) {
      this.claims.set(record.operation.id, record)
      this.emit('operation.claimed', record, input.now)
    }
    return record
  }

  async heartbeat(input: PublicOperationLeaseCommand & { leaseUntil: string }) {
    const renewed = await this.repository.heartbeat(input)
    const record = renewed ? this.claims.get(input.operationId) : undefined
    if (record) this.emit('operation.heartbeat', record, input.now)
    return renewed
  }

  async advancePhase(
    input: PublicOperationLeaseCommand & {
      phase: PublicOperationRunningPhase
    },
  ) {
    const advanced = await this.repository.advancePhase(input)
    const claimed = advanced ? this.claims.get(input.operationId) : undefined
    if (claimed) {
      const record = {
        ...claimed,
        operation: Object.freeze({ ...claimed.operation, phase: input.phase }),
      }
      this.claims.set(input.operationId, record)
      this.emit('operation.phase-advanced', record, input.now)
    }
    return advanced
  }

  async wait(input: PublicOperationLeaseCommand) {
    const record = await this.repository.wait(input)
    if (record) {
      this.claims.delete(input.operationId)
      this.emit('operation.waiting', record, input.now)
    }
    return record
  }

  async resumeWaiting(
    input: ResumeWaitingPublicOperationCommand,
  ): Promise<ClaimedPublicOperationRecord | null> {
    const record = await this.repository.resumeWaiting(input)
    if (record) {
      this.claims.set(input.operationId, record)
      this.emit('operation.resumed', record, input.now)
    }
    return record
  }

  async succeed(input: PublicOperationLeaseCommand) {
    const record = await this.repository.succeed(input)
    this.claims.delete(input.operationId)
    if (record) this.emit('operation.succeeded', record, input.now)
    return record
  }

  async failOrRetry(
    input: Parameters<PublicOperationRepository['failOrRetry']>[0],
  ) {
    const record = await this.repository.failOrRetry(input)
    this.claims.delete(input.operationId)
    if (record) {
      this.emit(
        record.operation.status === 'retrying'
          ? 'operation.retrying'
          : 'operation.failed',
        record,
        input.now,
      )
    }
    return record
  }
}
