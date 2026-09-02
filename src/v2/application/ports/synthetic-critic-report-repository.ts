import type {
  SyntheticCriticDecision,
  SyntheticCriticReport,
} from '../../domain/synthetic-critic-report.ts'

/**
 * Durable home of the critic's verdicts.
 *
 * Reports are immutable and content-addressed: `record` is idempotent by
 * `reportHash`, and a second attempt at the same block, artifact and thresholds
 * version returns the stored verdict instead of writing a second opinion.
 * Every read rehydrates fail-closed — the stored hash is recalculated before a
 * report is handed back, so a row edited behind the application is a
 * persistence conflict rather than an approval.
 */
export interface SyntheticCriticReportRepository {
  record(input: {
    report: Readonly<SyntheticCriticReport>
  }): Promise<Readonly<{ value: Readonly<SyntheticCriticReport>; replayed: boolean }>>

  read(input: {
    workspaceId: string
    reportId: string
  }): Promise<Readonly<SyntheticCriticReport> | null>

  readByHash(input: {
    workspaceId: string
    reportHash: string
  }): Promise<Readonly<SyntheticCriticReport> | null>

  /** Newest first. Optionally narrowed to one take and one thresholds version. */
  readByBlock(input: {
    workspaceId: string
    blockId: string
    artifactId?: string
    thresholdsVersion?: string
    limit?: number
  }): Promise<readonly Readonly<SyntheticCriticReport>[]>

  /** Every verdict ever passed on one set of bytes. */
  readByArtifact(input: {
    workspaceId: string
    artifactId: string
    limit?: number
  }): Promise<readonly Readonly<SyntheticCriticReport>[]>

  listByProject(input: {
    workspaceId: string
    projectId: string
    decision?: SyntheticCriticDecision
    limit: number
  }): Promise<readonly Readonly<SyntheticCriticReport>[]>
}
