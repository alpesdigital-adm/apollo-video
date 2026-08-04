import type {
  ValidationEnvelopeDecision,
  ValidationEnvelopeReusePlan,
} from '../../domain/validation-envelope.ts'
import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'

export interface ValidationEnvelopeReuseRecord {
  plan: Readonly<ValidationEnvelopeReusePlan>
  decisions: readonly Readonly<ValidationEnvelopeDecision>[]
  currentDecision: Readonly<ValidationEnvelopeDecision>
}

export interface ValidationEnvelopeCreateRecord {
  plan: Readonly<ValidationEnvelopeReusePlan>
  initialDecision: Readonly<ValidationEnvelopeDecision>
  requestFingerprint: string
  idempotencyKey: string
}

export interface ValidationEnvelopeDecisionRecord {
  decision: Readonly<ValidationEnvelopeDecision>
  requestFingerprint: string
  idempotencyKey: string
}

export interface ValidationEnvelopeReusePage {
  reuses: readonly Readonly<ValidationEnvelopeReuseRecord>[]
  nextCursor?: string
}

export interface ValidationEnvelopeRepository {
  findCreateReplay(input: {
    workspaceId: string
    projectId: string
    actorClientId: string
    idempotencyKey: string
    actorContextHash: string
  }): Promise<Readonly<{
    record: Readonly<ValidationEnvelopeReuseRecord>
    requestFingerprint: string
  }> | null>
  create(
    record: Readonly<ValidationEnvelopeCreateRecord>,
    authenticationAudit: Readonly<ApiAccessAuditContext>,
  ): Promise<Readonly<
    ValidationEnvelopeReuseRecord & { replayed: boolean }
  >>
  read(input: {
    workspaceId: string
    projectId: string
    reusePlanId: string
  }): Promise<Readonly<ValidationEnvelopeReuseRecord> | null>
  list(input: {
    workspaceId: string
    projectId: string
    validatedSegmentId?: string
    batchId?: string
    limit: number
    cursor?: string
  }): Promise<Readonly<ValidationEnvelopeReusePage>>
  findDecisionReplay(input: {
    workspaceId: string
    projectId: string
    actorClientId: string
    idempotencyKey: string
    actorContextHash: string
  }): Promise<Readonly<ValidationEnvelopeDecisionRecord> | null>
  appendDecision(
    record: Readonly<ValidationEnvelopeDecisionRecord>,
    authenticationAudit: Readonly<ApiAccessAuditContext>,
  ): Promise<Readonly<
    ValidationEnvelopeReuseRecord & { replayed: boolean }
  >>
}
