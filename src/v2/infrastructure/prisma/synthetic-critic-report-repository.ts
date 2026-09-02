import {
  Prisma,
  type PrismaClient,
  type V2SyntheticCriticEvaluator,
  type V2SyntheticCriticIssue,
  type V2SyntheticCriticMeasurement,
  type V2SyntheticCriticReport,
} from '../../../../generated/prisma-v2/index.js'

import type { SyntheticCriticReportRepository } from '../../application/ports/synthetic-critic-report-repository.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  assertSyntheticCriticReportIntegrity,
  type SyntheticCriticReport,
} from '../../domain/synthetic-critic-report.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

type ReportRow = V2SyntheticCriticReport & {
  evaluators: V2SyntheticCriticEvaluator[]
  measurements: V2SyntheticCriticMeasurement[]
  issues: V2SyntheticCriticIssue[]
}

const INCLUDE = { evaluators: true, measurements: true, issues: true } as const
const DEFAULT_LIMIT = 20

function conflict(message: string): never {
  throw new DomainError('PERSISTENCE_CONFLICT', message)
}

/**
 * Fail-closed rehydration.
 *
 * The report hash is recalculated from the stored body, the body is compared
 * byte for byte with its canonical serialization, every projected column is
 * compared with the aggregate, and every normalized evaluator, measurement and
 * issue row is compared with its counterpart. A row edited behind the
 * application is a persistence conflict — never a verdict that gets served, and
 * least of all an approval.
 */
function hydrate(row: ReportRow): Readonly<SyntheticCriticReport> {
  let report: SyntheticCriticReport
  try {
    report = JSON.parse(row.reportJson) as SyntheticCriticReport
  } catch {
    conflict('Stored synthetic critic report JSON is invalid')
  }
  assertSyntheticCriticReportIntegrity(report)
  const mismatch =
    stableSerialize(report) !== row.reportJson ||
    report.id !== row.id ||
    report.workspaceId !== row.workspaceId ||
    report.projectId !== row.projectId ||
    report.blockId !== row.blockId ||
    report.schemaVersion !== row.schemaVersion ||
    report.capability !== row.capability ||
    report.adapterId !== row.adapterId ||
    report.adapterVersion !== row.adapterVersion ||
    report.artifactId !== row.artifactId ||
    report.artifactSha256 !== row.artifactSha256 ||
    report.audioArtifactId !== row.audioArtifactId ||
    report.alignmentArtifactId !== row.alignmentArtifactId ||
    report.scriptHash !== row.scriptHash ||
    report.profileSnapshotId !== row.profileSnapshotId ||
    report.expectedIdentityRef !== row.expectedIdentityRef ||
    report.decision !== row.decision ||
    report.recommendedAction !== row.recommendedAction ||
    report.thresholdsVersion !== row.thresholdsVersion ||
    report.reportHash !== row.reportHash ||
    report.decidedAt !== row.decidedAt.toISOString()
  if (mismatch) conflict('Stored synthetic critic report failed integrity validation')

  const evaluators = new Map(row.evaluators.map((entry) => [entry.evaluatorId, entry]))
  if (evaluators.size !== report.evaluators.length) {
    conflict('Stored synthetic critic evaluator rows do not match the report')
  }
  for (const evaluator of report.evaluators) {
    const persisted = evaluators.get(evaluator.id)
    if (
      !persisted ||
      persisted.workspaceId !== report.workspaceId ||
      persisted.version !== evaluator.version ||
      persisted.kind !== evaluator.kind ||
      persisted.scope !== evaluator.scope
    ) {
      conflict(`Stored synthetic critic evaluator ${evaluator.id} was altered`)
    }
  }

  const measurements = new Map(row.measurements.map((entry) => [entry.dimension, entry]))
  if (measurements.size !== report.measurements.length) {
    conflict('Stored synthetic critic measurement rows do not match the report')
  }
  for (const measurement of report.measurements) {
    const persisted = measurements.get(measurement.dimension)
    if (
      !persisted ||
      persisted.workspaceId !== report.workspaceId ||
      persisted.blockId !== report.blockId ||
      persisted.status !== measurement.status ||
      persisted.evaluatorId !== measurement.evaluatorId ||
      persisted.value !== measurement.value ||
      persisted.unit !== measurement.unit ||
      persisted.threshold !== measurement.threshold ||
      persisted.confidence !== measurement.confidence ||
      persisted.note !== measurement.note ||
      persisted.startMs !== (measurement.range?.startMs ?? null) ||
      persisted.endMs !== (measurement.range?.endMs ?? null) ||
      persisted.evidenceRefsJson !== stableSerialize([...measurement.evidenceRefs])
    ) {
      conflict(`Stored synthetic critic ${measurement.dimension} measurement was altered`)
    }
  }

  const issues = new Map(row.issues.map((entry) => [entry.ordinal, entry]))
  if (issues.size !== report.issues.length) {
    conflict('Stored synthetic critic issue rows do not match the report')
  }
  for (const [ordinal, issue] of report.issues.entries()) {
    const persisted = issues.get(ordinal)
    if (
      !persisted ||
      persisted.workspaceId !== report.workspaceId ||
      persisted.blockId !== issue.blockId ||
      persisted.dimension !== issue.dimension ||
      persisted.severity !== issue.severity ||
      persisted.evidence !== issue.evidence ||
      persisted.action !== issue.action ||
      persisted.startMs !== (issue.range?.startMs ?? null) ||
      persisted.endMs !== (issue.range?.endMs ?? null)
    ) {
      conflict(`Stored synthetic critic issue ${ordinal} was altered`)
    }
  }

  return Object.freeze(report)
}

export class PrismaSyntheticCriticReportRepository implements SyntheticCriticReportRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient = getV2PostgresClient()) {
    this.client = client
  }

  async record(input: Parameters<SyntheticCriticReportRepository['record']>[0]) {
    const report = input.report
    try {
      const row = await this.client.$transaction(async (transaction) => {
        const created = await transaction.v2SyntheticCriticReport.create({
          data: {
            id: report.id,
            workspaceId: report.workspaceId,
            projectId: report.projectId,
            blockId: report.blockId,
            schemaVersion: report.schemaVersion,
            capability: report.capability,
            adapterId: report.adapterId,
            adapterVersion: report.adapterVersion,
            artifactId: report.artifactId,
            artifactSha256: report.artifactSha256,
            audioArtifactId: report.audioArtifactId,
            alignmentArtifactId: report.alignmentArtifactId,
            scriptHash: report.scriptHash,
            profileSnapshotId: report.profileSnapshotId,
            expectedIdentityRef: report.expectedIdentityRef,
            decision: report.decision,
            recommendedAction: report.recommendedAction,
            thresholdsVersion: report.thresholdsVersion,
            reportJson: stableSerialize(report),
            reportHash: report.reportHash,
            decidedAt: new Date(report.decidedAt),
          },
        })
        // The queryable projection is written inside the same transaction: a
        // report without its measurements never exists, not even briefly.
        await transaction.v2SyntheticCriticEvaluator.createMany({
          data: report.evaluators.map((evaluator) => ({
            reportId: created.id,
            workspaceId: report.workspaceId,
            evaluatorId: evaluator.id,
            version: evaluator.version,
            kind: evaluator.kind,
            scope: evaluator.scope,
          })),
        })
        await transaction.v2SyntheticCriticMeasurement.createMany({
          data: report.measurements.map((measurement) => ({
            reportId: created.id,
            workspaceId: report.workspaceId,
            blockId: report.blockId,
            dimension: measurement.dimension,
            status: measurement.status,
            evaluatorId: measurement.evaluatorId,
            value: measurement.value,
            unit: measurement.unit,
            threshold: measurement.threshold,
            confidence: measurement.confidence,
            evidenceRefsJson: stableSerialize([...measurement.evidenceRefs]),
            startMs: measurement.range?.startMs ?? null,
            endMs: measurement.range?.endMs ?? null,
            note: measurement.note,
          })),
        })
        if (report.issues.length > 0) {
          await transaction.v2SyntheticCriticIssue.createMany({
            data: report.issues.map((issue, ordinal) => ({
              reportId: created.id,
              workspaceId: report.workspaceId,
              ordinal,
              blockId: issue.blockId,
              dimension: issue.dimension,
              severity: issue.severity,
              startMs: issue.range?.startMs ?? null,
              endMs: issue.range?.endMs ?? null,
              evidence: issue.evidence,
              action: issue.action,
            })),
          })
        }
        return transaction.v2SyntheticCriticReport.findUniqueOrThrow({
          where: { id: created.id },
          include: INCLUDE,
        })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      return Object.freeze({ value: hydrate(row), replayed: false })
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
      const sealed = await this.readByHash({
        workspaceId: report.workspaceId,
        reportHash: report.reportHash,
      })
      if (sealed) return Object.freeze({ value: sealed, replayed: true })
      // The same take was already judged under the same published policy. The
      // stored verdict is the answer — unless it disagrees with this one, which
      // would mean the critic is not deterministic and must not be papered over.
      const [existing] = await this.readByBlock({
        workspaceId: report.workspaceId,
        blockId: report.blockId,
        artifactId: report.artifactId,
        thresholdsVersion: report.thresholdsVersion,
        limit: 1,
      })
      if (!existing) {
        throw new DomainError('VERSION_CONFLICT', 'Synthetic critic report identity already exists')
      }
      if (
        existing.decision !== report.decision ||
        existing.recommendedAction !== report.recommendedAction
      ) {
        conflict('The same take already carries a different critic verdict under the same thresholds version')
      }
      return Object.freeze({ value: existing, replayed: true })
    }
  }

  async read(input: Parameters<SyntheticCriticReportRepository['read']>[0]) {
    const row = await this.client.v2SyntheticCriticReport.findFirst({
      where: { id: input.reportId, workspaceId: input.workspaceId },
      include: INCLUDE,
    })
    return row ? hydrate(row) : null
  }

  async readByHash(input: Parameters<SyntheticCriticReportRepository['readByHash']>[0]) {
    const row = await this.client.v2SyntheticCriticReport.findFirst({
      where: { workspaceId: input.workspaceId, reportHash: input.reportHash },
      include: INCLUDE,
    })
    return row ? hydrate(row) : null
  }

  async readByBlock(input: Parameters<SyntheticCriticReportRepository['readByBlock']>[0]) {
    const rows = await this.client.v2SyntheticCriticReport.findMany({
      where: {
        workspaceId: input.workspaceId,
        blockId: input.blockId,
        ...(input.artifactId ? { artifactId: input.artifactId } : {}),
        ...(input.thresholdsVersion ? { thresholdsVersion: input.thresholdsVersion } : {}),
      },
      include: INCLUDE,
      orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
      take: input.limit ?? DEFAULT_LIMIT,
    })
    return Object.freeze(rows.map(hydrate))
  }

  async readByArtifact(input: Parameters<SyntheticCriticReportRepository['readByArtifact']>[0]) {
    const rows = await this.client.v2SyntheticCriticReport.findMany({
      where: { workspaceId: input.workspaceId, artifactId: input.artifactId },
      include: INCLUDE,
      orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
      take: input.limit ?? DEFAULT_LIMIT,
    })
    return Object.freeze(rows.map(hydrate))
  }

  async listByProject(input: Parameters<SyntheticCriticReportRepository['listByProject']>[0]) {
    const rows = await this.client.v2SyntheticCriticReport.findMany({
      where: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        ...(input.decision ? { decision: input.decision } : {}),
      },
      include: INCLUDE,
      orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
      take: input.limit,
    })
    return Object.freeze(rows.map(hydrate))
  }
}
