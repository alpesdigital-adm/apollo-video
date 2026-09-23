import type { TransformationCriticReport } from '../../domain/transformation-critic-report.ts'
import type { TransformationFallbackLedger } from '../../domain/transformation-fallback.ts'
import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'

export interface TransformationFallbackDispatchClaim {
  id: string
  workspaceId: string
  projectId: string
  requestedLedgerId: string
  requestedLedgerHash: string
  briefId: string
  dispatchRequestHash: string
  authenticationAudit: Readonly<ApiAccessAuditContext>
  rung: 'generated-cutaway'
  outcome: 'pending' | 'enqueued' | 'skipped'
  providerJobId: string | null
  resultLedgerId: string | null
  resultLedgerHash: string | null
  reason: string | null
}

export interface TransformationQualityRepository {
  readFallbackDispatchRequest(input: {
    workspaceId: string
    actorClientId: string
    idempotencyKey: string
  }): Promise<Readonly<{ requestFingerprint: string; authenticationAudit: Readonly<ApiAccessAuditContext>; claim: Readonly<TransformationFallbackDispatchClaim> }> | null>

  claimFallbackDispatch(input: {
    claimId: string
    requestId: string
    workspaceId: string
    projectId: string
    ledgerId: string
    ledgerHash: string
    briefId: string
    rung: 'generated-cutaway'
    idempotencyKey: string
    requestFingerprint: string
    authenticationAudit: Readonly<ApiAccessAuditContext>
    createdAt: string
  }): Promise<Readonly<{ claim: Readonly<TransformationFallbackDispatchClaim>; requestReplayed: boolean }>>

  settleFallbackDispatch(input: {
    workspaceId: string
    projectId: string
    claimId: string
    expectedLedgerId: string
    outcome: 'enqueued' | 'skipped'
    providerJobId?: string | null
    resultLedgerId?: string | null
    resultLedgerHash?: string | null
    reason?: string | null
    settledAt: string
  }): Promise<Readonly<TransformationFallbackDispatchClaim>>

  recordFallbackLedger(input: {
    ledger: Readonly<TransformationFallbackLedger>
    previousLedgerHash: string | null
    dispatch?: Readonly<{ attemptSequence: number; requestHash: string; authenticationAudit: Readonly<ApiAccessAuditContext> }>
  }): Promise<Readonly<{ ledger: Readonly<TransformationFallbackLedger>; replayed: boolean }>>

  readFallbackLedger(input: {
    workspaceId: string
    projectId: string
    ledgerId: string
  }): Promise<Readonly<TransformationFallbackLedger> | null>

  readLatestFallbackLedger(input: {
    workspaceId: string
    projectId: string
    briefId: string
  }): Promise<Readonly<TransformationFallbackLedger> | null>

  findFallbackDispatchAttempt?(input: {
    workspaceId: string
    projectId: string
    briefId: string
    rung: 'generated-cutaway'
  }): Promise<Readonly<{ ledger: Readonly<TransformationFallbackLedger>; requestHash: string; authenticationAudit: Readonly<ApiAccessAuditContext> }> | null>

  listFallbackLedgers(input: {
    workspaceId: string
    projectId: string
    limit?: number
  }): Promise<readonly Readonly<TransformationFallbackLedger>[]>

  recordCriticReport(input: {
    report: Readonly<TransformationCriticReport>
  }): Promise<Readonly<{ report: Readonly<TransformationCriticReport>; replayed: boolean }>>

  readCriticReport(input: {
    workspaceId: string
    projectId: string
    reportId: string
  }): Promise<Readonly<TransformationCriticReport> | null>

  readCriticReportByJob(input: {
    workspaceId: string
    projectId: string
    providerJobId: string
  }): Promise<Readonly<TransformationCriticReport> | null>

  listCriticReports(input: {
    workspaceId: string
    projectId: string
    limit?: number
  }): Promise<readonly Readonly<TransformationCriticReport>[]>
}
