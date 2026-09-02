import type { TransformationCriticReport } from '../../domain/transformation-critic-report.ts'
import type { TransformationFallbackLedger } from '../../domain/transformation-fallback.ts'

export interface TransformationQualityRepository {
  recordFallbackLedger(input: {
    ledger: Readonly<TransformationFallbackLedger>
    previousLedgerHash: string | null
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
