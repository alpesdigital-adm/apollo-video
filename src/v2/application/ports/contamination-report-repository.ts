import type {
  ContaminationReport,
} from '../../domain/contamination-report.ts'

export interface ContaminationReportCreateRecord {
  report: Readonly<ContaminationReport>
  requestFingerprint: string
  idempotencyKey: string
}

export interface ContaminationReportReplay {
  report: Readonly<ContaminationReport>
  requestFingerprint: string
}

export interface ContaminationReportPage {
  reports: readonly Readonly<ContaminationReport>[]
  nextCursor?: string
}

export interface ContaminationReportRepository {
  findCreateReplay(input: {
    workspaceId: string
    projectId: string
    actorClientId: string
    idempotencyKey: string
  }): Promise<Readonly<ContaminationReportReplay> | null>
  create(
    record: Readonly<ContaminationReportCreateRecord>,
  ): Promise<Readonly<{
    report: Readonly<ContaminationReport>
    replayed: boolean
  }>>
  read(input: {
    workspaceId: string
    projectId: string
    reportId: string
  }): Promise<Readonly<ContaminationReport> | null>
  list(input: {
    workspaceId: string
    projectId: string
    sourceDeconstructionReportId?: string
    limit: number
    cursor?: string
  }): Promise<Readonly<ContaminationReportPage>>
}
