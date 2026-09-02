import {
  Prisma,
  type PrismaClient,
  type V2TransformationCriticIssue,
  type V2TransformationCriticMeasurement,
  type V2TransformationCriticReport,
  type V2TransformationFallbackAttempt,
  type V2TransformationFallbackLedger,
} from '../../../../generated/prisma-v2/index.js'

import type { TransformationQualityRepository } from '../../application/ports/transformation-quality-repository.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  assertTransformationCriticReport,
  TRANSFORMATION_CRITIC_DIMENSIONS,
  TRANSFORMATION_CRITIC_REPORT_VERSION,
  type TransformationCriticEvaluator,
  type TransformationCriticReport,
} from '../../domain/transformation-critic-report.ts'
import {
  assertTransformationFallbackLedger,
  TRANSFORMATION_FALLBACK_LEDGER_VERSION,
  type TransformationFallbackLedger,
} from '../../domain/transformation-fallback.ts'
import type { TransformationFallback, TransformationPreserve } from '../../domain/transformation-brief.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

type FallbackRow = V2TransformationFallbackLedger & { attempts: V2TransformationFallbackAttempt[] }
type CriticRow = V2TransformationCriticReport & {
  measurements: V2TransformationCriticMeasurement[]
  issues: V2TransformationCriticIssue[]
}

const FALLBACK_INCLUDE = { attempts: true } as const
const CRITIC_INCLUDE = { measurements: true, issues: true } as const

function conflict(message: string): never {
  throw new DomainError('PERSISTENCE_CONFLICT', message)
}

function parsed<T>(value: string, field: string): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return conflict(`Stored ${field} JSON is invalid`)
  }
}

function hydrateFallback(row: FallbackRow): Readonly<TransformationFallbackLedger> {
  const ladder = parsed<TransformationFallback[]>(row.ladderJson, 'fallback ladder')
  const attempts = [...row.attempts]
    .sort((left, right) => left.sequence - right.sequence)
    .map((attempt) => Object.freeze({
      sequence: attempt.sequence,
      rung: attempt.rung as TransformationFallback,
      ...(attempt.providerJobId ? { providerJobId: attempt.providerJobId } : {}),
      ...(attempt.providerId ? { providerId: attempt.providerId } : {}),
      ...(attempt.artifactId ? { artifactId: attempt.artifactId } : {}),
      ...(attempt.artifactSha256 ? { artifactSha256: attempt.artifactSha256 } : {}),
      outcome: attempt.outcome as TransformationFallbackLedger['attempts'][number]['outcome'],
      intentScoreBps: attempt.intentScoreBps,
      ...(attempt.criticReportHash ? { criticReportHash: attempt.criticReportHash } : {}),
      violatesProtectedContent: attempt.violatesProtectedContent,
      estimatedCostMinorUnits: attempt.estimatedCostMinorUnits,
      observedCostMinorUnits: attempt.observedCostMinorUnits,
      costCurrency: attempt.costCurrency,
      reason: attempt.reason,
      ...(attempt.descendedBecause
        ? { descendedBecause: attempt.descendedBecause as TransformationFallbackLedger['attempts'][number]['descendedBecause'] }
        : {}),
    }))
  const ledger = Object.freeze({
    schemaVersion: TRANSFORMATION_FALLBACK_LEDGER_VERSION,
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    projectVersionId: row.projectVersionId,
    briefId: row.briefId,
    briefHash: row.briefHash,
    ladder: Object.freeze(ladder),
    attempts: Object.freeze(attempts),
    currentRung: row.currentRung as TransformationFallback,
    bestArtifactId: row.bestArtifactId,
    bestArtifactSha256: row.bestArtifactSha256,
    bestIntentScoreBps: row.bestIntentScoreBps,
    incurredCostMinorUnits: row.incurredCostMinorUnits,
    costCurrency: row.costCurrency,
    reviewDecision: row.reviewDecision as TransformationFallbackLedger['reviewDecision'],
    sourceArtifactId: row.sourceArtifactId,
    sourceArtifactSha256: row.sourceArtifactSha256,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ledgerHash: row.ledgerHash,
  })
  if (stableSerialize(ladder) !== row.ladderJson) conflict('Stored fallback ladder is not canonical')
  return assertTransformationFallbackLedger(ledger)
}

function hydrateCritic(row: CriticRow): Readonly<TransformationCriticReport> {
  const evaluators = parsed<TransformationCriticEvaluator[]>(row.evaluatorsJson, 'transformation critic evaluators')
  const measurementByDimension = new Map(row.measurements.map((measurement) => [measurement.dimension, measurement]))
  const measurements = TRANSFORMATION_CRITIC_DIMENSIONS.map((dimension) => {
    const measurement = measurementByDimension.get(dimension)
    if (!measurement) return conflict(`Stored transformation critic measurement ${dimension} is missing`)
    return Object.freeze({
      dimension: measurement.dimension as TransformationCriticReport['measurements'][number]['dimension'],
      status: measurement.status as TransformationCriticReport['measurements'][number]['status'],
      ...(measurement.evaluatorId ? { evaluatorId: measurement.evaluatorId } : {}),
      scoreBps: measurement.scoreBps,
      thresholdBps: measurement.thresholdBps,
      frameRange: measurement.startFrame !== null && measurement.endFrame !== null
        ? Object.freeze({ startFrame: measurement.startFrame, endFrame: measurement.endFrame })
        : null,
      region: measurement.regionJson
        ? Object.freeze(parsed<NonNullable<TransformationCriticReport['measurements'][number]['region']>>(measurement.regionJson, 'transformation critic measurement region'))
        : null,
      ...(measurement.note ? { note: measurement.note } : {}),
    })
  })
  const issues = [...row.issues]
    .sort((left, right) => left.sequence - right.sequence)
    .map((issue) => Object.freeze({
      dimension: issue.dimension as TransformationCriticReport['issues'][number]['dimension'],
      severity: issue.severity as TransformationCriticReport['issues'][number]['severity'],
      frameRange: Object.freeze({ startFrame: issue.startFrame, endFrame: issue.endFrame }),
      region: issue.regionJson
        ? Object.freeze(parsed<NonNullable<TransformationCriticReport['issues'][number]['region']>>(issue.regionJson, 'transformation critic issue region'))
        : null,
      ...(issue.violatedPreserve ? { violatedPreserve: issue.violatedPreserve as TransformationPreserve } : {}),
      description: issue.description,
    }))
  const hardGates = parsed<TransformationCriticReport['hardGates']>(row.hardGatesJson, 'transformation critic hard gates')
  const report = Object.freeze({
    schemaVersion: TRANSFORMATION_CRITIC_REPORT_VERSION,
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    briefId: row.briefId,
    briefHash: row.briefHash,
    providerJobId: row.providerJobId,
    policyId: row.policyId,
    policyHash: row.policyHash,
    sourceArtifactId: row.sourceArtifactId,
    sourceArtifactSha256: row.sourceArtifactSha256,
    resultArtifactId: row.resultArtifactId,
    resultArtifactSha256: row.resultArtifactSha256,
    evaluators: Object.freeze(evaluators),
    measurements: Object.freeze(measurements),
    issues: Object.freeze(issues),
    hardGates: Object.freeze([...hardGates]),
    decision: row.decision as TransformationCriticReport['decision'],
    action: row.action as TransformationCriticReport['action'],
    confidenceBps: row.confidenceBps,
    intentScoreBps: row.intentScoreBps,
    evaluatedAt: row.evaluatedAt.toISOString(),
    reportHash: row.reportHash,
  })
  if (stableSerialize(evaluators) !== row.evaluatorsJson || stableSerialize(hardGates) !== row.hardGatesJson) {
    conflict('Stored transformation critic JSON projections are not canonical')
  }
  return assertTransformationCriticReport(report)
}

function isUnique(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

export class PrismaTransformationQualityRepository implements TransformationQualityRepository {
  constructor(private readonly prisma: PrismaClient = getV2PostgresClient()) {}

  async recordFallbackLedger(input: Parameters<TransformationQualityRepository['recordFallbackLedger']>[0]) {
    const ledger = assertTransformationFallbackLedger(input.ledger)
    if (ledger.attempts.some((attempt) => attempt.reason.length > 300)) {
      conflict('Fallback attempt reason exceeds its durable storage contract')
    }
    try {
      const replayed = await this.prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`${ledger.workspaceId}:transformation-fallback:${ledger.projectId}:${ledger.briefId}`}, 0)
          )::text AS "lock"
        `)
        const existing = await transaction.v2TransformationFallbackLedger.findFirst({
          where: { id: ledger.id, workspaceId: ledger.workspaceId, projectId: ledger.projectId },
          include: FALLBACK_INCLUDE,
        })
        if (existing) {
          const hydrated = hydrateFallback(existing)
          if (hydrated.ledgerHash !== ledger.ledgerHash) conflict('Fallback ledger identity already exists with a different body')
          return true
        }
        const latest = await transaction.v2TransformationFallbackLedger.findFirst({
          where: { workspaceId: ledger.workspaceId, projectId: ledger.projectId, briefId: ledger.briefId },
          select: { ledgerHash: true },
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        })
        if ((latest?.ledgerHash ?? null) !== input.previousLedgerHash) {
          throw new DomainError('VERSION_CONFLICT', 'Transformation fallback ledger has a newer revision')
        }
        await transaction.v2TransformationFallbackLedger.create({ data: {
          id: ledger.id, workspaceId: ledger.workspaceId, projectId: ledger.projectId,
          projectVersionId: ledger.projectVersionId, schemaVersion: ledger.schemaVersion,
          briefId: ledger.briefId, briefHash: ledger.briefHash,
          ladderJson: stableSerialize([...ledger.ladder]), currentRung: ledger.currentRung,
          bestArtifactId: ledger.bestArtifactId, bestArtifactSha256: ledger.bestArtifactSha256,
          bestIntentScoreBps: ledger.bestIntentScoreBps,
          incurredCostMinorUnits: ledger.incurredCostMinorUnits, costCurrency: ledger.costCurrency,
          reviewDecision: ledger.reviewDecision, sourceArtifactId: ledger.sourceArtifactId,
          sourceArtifactSha256: ledger.sourceArtifactSha256, ledgerHash: ledger.ledgerHash,
          createdAt: new Date(ledger.createdAt), updatedAt: new Date(ledger.updatedAt),
        } })
        if (ledger.attempts.length > 0) await transaction.v2TransformationFallbackAttempt.createMany({
          data: ledger.attempts.map((attempt) => ({
            id: `fallback-attempt-${ledger.ledgerHash.slice(0, 24)}-${attempt.sequence}`,
            workspaceId: ledger.workspaceId, ledgerId: ledger.id, sequence: attempt.sequence,
            rung: attempt.rung, providerJobId: attempt.providerJobId ?? null,
            providerId: attempt.providerId ?? null, artifactId: attempt.artifactId ?? null,
            artifactSha256: attempt.artifactSha256 ?? null, outcome: attempt.outcome,
            intentScoreBps: attempt.intentScoreBps, criticReportHash: attempt.criticReportHash ?? null,
            violatesProtectedContent: attempt.violatesProtectedContent,
            estimatedCostMinorUnits: attempt.estimatedCostMinorUnits,
            observedCostMinorUnits: attempt.observedCostMinorUnits,
            costCurrency: attempt.costCurrency, reason: attempt.reason,
            descendedBecause: attempt.descendedBecause ?? null,
          })),
        })
        return false
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      if (replayed) {
        const stored = await this.readFallbackLedger({ workspaceId: ledger.workspaceId, projectId: ledger.projectId, ledgerId: ledger.id })
        if (!stored) conflict('Fallback ledger replay disappeared')
        return Object.freeze({ ledger: stored, replayed: true })
      }
      return Object.freeze({ ledger, replayed: false })
    } catch (error) {
      if (!isUnique(error)) throw error
      const stored = await this.readFallbackLedger({ workspaceId: ledger.workspaceId, projectId: ledger.projectId, ledgerId: ledger.id })
      if (!stored || stored.ledgerHash !== ledger.ledgerHash) conflict('Fallback ledger identity already exists with a different body')
      return Object.freeze({ ledger: stored, replayed: true })
    }
  }

  async readFallbackLedger(input: Parameters<TransformationQualityRepository['readFallbackLedger']>[0]) {
    const row = await this.prisma.v2TransformationFallbackLedger.findFirst({
      where: { id: input.ledgerId, workspaceId: input.workspaceId, projectId: input.projectId },
      include: FALLBACK_INCLUDE,
    })
    return row ? hydrateFallback(row) : null
  }

  async readLatestFallbackLedger(input: Parameters<TransformationQualityRepository['readLatestFallbackLedger']>[0]) {
    const row = await this.prisma.v2TransformationFallbackLedger.findFirst({
      where: input, include: FALLBACK_INCLUDE, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    })
    return row ? hydrateFallback(row) : null
  }

  async listFallbackLedgers(input: Parameters<TransformationQualityRepository['listFallbackLedgers']>[0]) {
    const rows = await this.prisma.v2TransformationFallbackLedger.findMany({
      where: { workspaceId: input.workspaceId, projectId: input.projectId }, include: FALLBACK_INCLUDE,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: Math.min(Math.max(input.limit ?? 20, 1), 100),
    })
    return Object.freeze(rows.map(hydrateFallback))
  }

  async recordCriticReport(input: Parameters<TransformationQualityRepository['recordCriticReport']>[0]) {
    const report = assertTransformationCriticReport(input.report)
    if (report.issues.some((issue) => issue.description.length > 500)) {
      conflict('Transformation critic issue description exceeds its durable storage contract')
    }
    try {
      await this.prisma.$transaction(async (transaction) => {
        await transaction.v2TransformationCriticReport.create({ data: {
          id: report.id, workspaceId: report.workspaceId, projectId: report.projectId,
          schemaVersion: report.schemaVersion, briefId: report.briefId, briefHash: report.briefHash,
          providerJobId: report.providerJobId, policyId: report.policyId, policyHash: report.policyHash,
          sourceArtifactId: report.sourceArtifactId, sourceArtifactSha256: report.sourceArtifactSha256,
          resultArtifactId: report.resultArtifactId, resultArtifactSha256: report.resultArtifactSha256,
          evaluatorsJson: stableSerialize([...report.evaluators]), hardGatesJson: stableSerialize([...report.hardGates]),
          hardGateCount: report.hardGates.length, decision: report.decision, action: report.action,
          confidenceBps: report.confidenceBps, intentScoreBps: report.intentScoreBps,
          reportHash: report.reportHash, evaluatedAt: new Date(report.evaluatedAt), createdAt: new Date(report.evaluatedAt),
        } })
        await transaction.v2TransformationCriticMeasurement.createMany({ data: report.measurements.map((measurement) => ({
          id: `transformation-measurement-${report.reportHash.slice(0, 20)}-${measurement.dimension}`,
          workspaceId: report.workspaceId, reportId: report.id, dimension: measurement.dimension,
          status: measurement.status, evaluatorId: measurement.evaluatorId ?? null,
          scoreBps: measurement.scoreBps, thresholdBps: measurement.thresholdBps,
          startFrame: measurement.frameRange?.startFrame ?? null, endFrame: measurement.frameRange?.endFrame ?? null,
          regionJson: measurement.region ? stableSerialize(measurement.region) : null, note: measurement.note ?? null,
        })) })
        if (report.issues.length > 0) await transaction.v2TransformationCriticIssue.createMany({ data: report.issues.map((issue, sequence) => ({
          id: `transformation-issue-${report.reportHash.slice(0, 24)}-${sequence}`,
          workspaceId: report.workspaceId, reportId: report.id, sequence,
          dimension: issue.dimension, severity: issue.severity,
          startFrame: issue.frameRange.startFrame, endFrame: issue.frameRange.endFrame,
          regionJson: issue.region ? stableSerialize(issue.region) : null,
          violatedPreserve: issue.violatedPreserve ?? null, description: issue.description,
        })) })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      return Object.freeze({ report, replayed: false })
    } catch (error) {
      if (!isUnique(error)) throw error
      const stored = await this.readCriticReport({ workspaceId: report.workspaceId, projectId: report.projectId, reportId: report.id })
      if (!stored || stored.reportHash !== report.reportHash) conflict('Transformation critic report identity already exists with a different body')
      return Object.freeze({ report: stored, replayed: true })
    }
  }

  async readCriticReport(input: Parameters<TransformationQualityRepository['readCriticReport']>[0]) {
    const row = await this.prisma.v2TransformationCriticReport.findFirst({
      where: { id: input.reportId, workspaceId: input.workspaceId, projectId: input.projectId },
      include: CRITIC_INCLUDE,
    })
    return row ? hydrateCritic(row) : null
  }

  async readCriticReportByJob(input: Parameters<TransformationQualityRepository['readCriticReportByJob']>[0]) {
    const row = await this.prisma.v2TransformationCriticReport.findFirst({
      where: input, include: CRITIC_INCLUDE, orderBy: [{ evaluatedAt: 'desc' }, { id: 'desc' }],
    })
    return row ? hydrateCritic(row) : null
  }

  async listCriticReports(input: Parameters<TransformationQualityRepository['listCriticReports']>[0]) {
    const rows = await this.prisma.v2TransformationCriticReport.findMany({
      where: { workspaceId: input.workspaceId, projectId: input.projectId }, include: CRITIC_INCLUDE,
      orderBy: [{ evaluatedAt: 'desc' }, { id: 'desc' }], take: Math.min(Math.max(input.limit ?? 20, 1), 100),
    })
    return Object.freeze(rows.map(hydrateCritic))
  }
}
