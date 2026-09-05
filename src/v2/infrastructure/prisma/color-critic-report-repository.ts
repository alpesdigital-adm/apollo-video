import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type {
  ColorCriticReportRef,
  ColorCriticReportRepository,
} from '../../application/ports/color-critic-report-repository.ts'
import { parseWithTicks, stringifyWithTicks } from './bigint-json.ts'
import { childRowId } from './child-row-id.ts'
import {
  COLOR_CRITIC_MAX_CORRECTION_ITERATIONS,
  COLOR_CRITIC_REPORT_SCHEMA_VERSION,
  DEFAULT_COLOR_CRITIC_POLICY,
  assertColorCriticReportIntegrity,
  type ColorCriticAction,
  type ColorCriticBytes,
  type ColorCriticCause,
  type ColorCriticClassification,
  type ColorCriticConfidenceBand,
  type ColorCriticCreativeIntent,
  type ColorCriticDimension,
  type ColorCriticDimensionResult,
  type ColorCriticEvaluator,
  type ColorCriticPolicy,
  type ColorCriticProposedDelta,
  type ColorCriticReport,
  type ColorCriticSection,
  type ColorCriticSeverity,
  type ColorCriticStagePair,
  type ColorCriticStageScope,
  type ColorCriticStatus,
  type ColorCriticSubject,
  type ColorCriticSubjectKind,
  type ColorCriticThresholds,
} from '../../domain/color-critic-report.ts'
import { DomainError } from '../../domain/errors.ts'
import { createTickInterval } from '../../domain/session-time.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function parse<T>(json: string, what: string): T {
  try {
    return JSON.parse(json) as T
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${what} is not valid JSON`)
  }
}

/** The same, for the payload whose leaves include ticks. */
function parseTicks<T>(json: string, what: string): T {
  try {
    return parseWithTicks(json) as T
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${what} is not valid JSON`)
  }
}

/**
 * An optional list, written so that "absent" and "empty" stay different.
 *
 * A dimension nobody could read carries no evaluator list at all; a dimension
 * read by nobody in particular could carry an empty one. Both would be `[]` in
 * a column that only knows arrays, and the difference is exactly the one the
 * report is about — so absence is stored as JSON `null` and read back as a key
 * that is not there.
 */
function optionalList(value: readonly string[] | undefined): string {
  return value === undefined ? 'null' : JSON.stringify(value)
}

function readOptionalList(json: string, what: string): readonly string[] | undefined {
  const parsed = parse<string[] | null>(json, what)
  return parsed === null ? undefined : Object.freeze(parsed)
}

function hydrateSubject(row: {
  subjectKind: string
  subjectSourceAssetId: string | null
  subjectCameraId: string | null
  subjectArtifactId: string | null
  subjectRangeStartTicks: bigint | null
  subjectRangeEndTicks: bigint | null
}): Readonly<ColorCriticSubject> {
  return Object.freeze({
    kind: row.subjectKind as ColorCriticSubjectKind,
    ...(row.subjectSourceAssetId === null ? {} : { sourceAssetId: row.subjectSourceAssetId }),
    ...(row.subjectCameraId === null ? {} : { cameraId: row.subjectCameraId }),
    ...(row.subjectArtifactId === null ? {} : { artifactId: row.subjectArtifactId }),
    ...(row.subjectRangeStartTicks === null || row.subjectRangeEndTicks === null
      ? {}
      : { range: createTickInterval(row.subjectRangeStartTicks, row.subjectRangeEndTicks) }),
  })
}

function hydrateDimension(row: {
  dimension: string
  status: string
  stage: string
  value: number | null
  unit: string | null
  threshold: number | null
  classification: string | null
  reason: string | null
  evaluatorIdsJson: string
  evidenceRefsJson: string
  cameraIdsJson: string
}): Readonly<ColorCriticDimensionResult> {
  const what = `critic dimension ${row.dimension}`
  return Object.freeze({
    dimension: row.dimension as ColorCriticDimension,
    status: row.status as ColorCriticStatus,
    stage: row.stage as ColorCriticStageScope,
    ...(row.value === null ? {} : { value: row.value }),
    ...(row.unit === null ? {} : { unit: row.unit }),
    ...(row.threshold === null ? {} : { threshold: row.threshold }),
    ...(() => {
      const evaluatorIds = readOptionalList(row.evaluatorIdsJson, `${what} evaluators`)
      return evaluatorIds === undefined ? {} : { evaluatorIds }
    })(),
    ...(() => {
      const evidenceRefs = readOptionalList(row.evidenceRefsJson, `${what} evidence refs`)
      return evidenceRefs === undefined ? {} : { evidenceRefs }
    })(),
    ...(() => {
      const cameraIds = readOptionalList(row.cameraIdsJson, `${what} cameras`)
      return cameraIds === undefined ? {} : { cameraIds }
    })(),
    ...(row.classification === null
      ? {}
      : { classification: row.classification as ColorCriticClassification }),
    ...(row.reason === null ? {} : { reason: row.reason }),
  })
}

interface ReportRow {
  workspaceId: string
  projectId: string
  projectVersionId: string
  schemaVersion: string
  reportId: string
  subjectKind: string
  subjectSourceAssetId: string | null
  subjectCameraId: string | null
  subjectArtifactId: string | null
  subjectRangeStartTicks: bigint | null
  subjectRangeEndTicks: bigint | null
  referenceCameraId: string | null
  matchPlanId: string | null
  matchPlanHash: string | null
  sectionsJson: string
  stagePairsJson: string
  bytesEvaluatedJson: string
  evaluatorsJson: string
  creativeIntentJson: string
  castAllowedDelta: number | null
  maxDeclaredCastAllowance: number
  cause: string
  action: string
  correctionIteration: number | null
  correctionMaxIterations: number | null
  correctionReason: string | null
  confidence: number
  confidenceBand: string
  thresholdsJson: string
  evaluatedAt: Date
  reportHash: string
  dimensions: readonly Parameters<typeof hydrateDimension>[0][]
  issues: readonly {
    ordinal: number
    code: string
    dimension: string
    severity: string
    classification: string
    cause: string
    stage: string
    cameraId: string | null
    rangeStartTicks: bigint | null
    rangeEndTicks: bigint | null
    measured: number | null
    threshold: number | null
    thresholdVersion: string
    confidence: number
    evidenceRefsJson: string
  }[]
  proposedDeltas: readonly {
    cameraId: string
    exposureEv: number | null
    redGain: number | null
    greenGain: number | null
    blueGain: number | null
    saturation: number | null
  }[]
}

function hydrateReport(row: ReportRow): Readonly<ColorCriticReport> {
  if (row.schemaVersion !== COLOR_CRITIC_REPORT_SCHEMA_VERSION) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored colour critic report ${row.reportId} carries an unknown schema version`,
    )
  }
  const hasCorrection = row.correctionIteration !== null
  if (
    hasCorrection &&
    (row.correctionReason === null || row.correctionMaxIterations !== COLOR_CRITIC_MAX_CORRECTION_ITERATIONS)
  ) {
    // A correction with no budget, or a budget that is not the one the domain
    // enforces, is not a bounded correction — and filling either in from a
    // constant here would be this layer deciding what the critic proposed.
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored colour critic report ${row.reportId} carries half a bounded correction`,
    )
  }
  if (!hasCorrection && (row.correctionMaxIterations !== null || row.correctionReason !== null)) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored colour critic report ${row.reportId} has no correction but carries its remains`,
    )
  }
  const proposedDeltas: readonly Readonly<ColorCriticProposedDelta>[] = Object.freeze(
    [...row.proposedDeltas]
      .sort((left, right) => left.cameraId.localeCompare(right.cameraId))
      .map((delta) => Object.freeze({
        cameraId: delta.cameraId,
        exposureEv: delta.exposureEv,
        // Three channels or none: half a white balance is not a correction.
        whiteBalance: delta.redGain === null || delta.greenGain === null || delta.blueGain === null
          ? null
          : Object.freeze({ redGain: delta.redGain, greenGain: delta.greenGain, blueGain: delta.blueGain }),
        saturation: delta.saturation,
      })),
  )
  const report: ColorCriticReport = {
    schemaVersion: COLOR_CRITIC_REPORT_SCHEMA_VERSION,
    reportId: row.reportId,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    projectVersionId: row.projectVersionId,
    subject: hydrateSubject(row),
    referenceCameraId: row.referenceCameraId,
    matchPlanId: row.matchPlanId,
    matchPlanHash: row.matchPlanHash,
    // A section carries the measurement aggregates it read, and a measured
    // range is bigint ticks: the tagged codec is the only writer here that
    // does not turn a 64-bit tick into a double on the way out.
    sections: Object.freeze(
      parseTicks<ColorCriticSection[]>(row.sectionsJson, `critic report ${row.reportId} sections`),
    ),
    stagePairs: Object.freeze(
      parse<ColorCriticStagePair[]>(row.stagePairsJson, `critic report ${row.reportId} stage pairs`),
    ),
    bytesEvaluated: Object.freeze(
      parse<ColorCriticBytes[]>(row.bytesEvaluatedJson, `critic report ${row.reportId} evaluated bytes`),
    ),
    evaluators: Object.freeze(
      parse<ColorCriticEvaluator[]>(row.evaluatorsJson, `critic report ${row.reportId} evaluators`),
    ),
    dimensions: Object.freeze(row.dimensions.map(hydrateDimension)),
    issues: Object.freeze(
      [...row.issues].sort((left, right) => left.ordinal - right.ordinal).map((issue) => Object.freeze({
        code: issue.code,
        dimension: issue.dimension as ColorCriticDimension,
        severity: issue.severity as ColorCriticSeverity,
        classification: issue.classification as ColorCriticClassification,
        cause: issue.cause as ColorCriticCause,
        stage: issue.stage as ColorCriticStageScope,
        cameraId: issue.cameraId,
        range: issue.rangeStartTicks === null || issue.rangeEndTicks === null
          ? null
          : createTickInterval(issue.rangeStartTicks, issue.rangeEndTicks),
        measured: issue.measured,
        threshold: issue.threshold,
        thresholdVersion: issue.thresholdVersion,
        confidence: issue.confidence,
        evidenceRefs: Object.freeze(
          parse<string[]>(issue.evidenceRefsJson, `critic issue ${issue.code} evidence refs`),
        ),
      })),
    ),
    creativeIntent: Object.freeze(
      parse<ColorCriticCreativeIntent>(row.creativeIntentJson, `critic report ${row.reportId} creative intent`),
    ),
    intentBounds: Object.freeze({
      castAllowedDelta: row.castAllowedDelta,
      maxDeclaredCastAllowance: row.maxDeclaredCastAllowance,
    }),
    cause: row.cause as ColorCriticCause,
    action: row.action as ColorCriticAction,
    boundedCorrection: row.correctionIteration === null || row.correctionReason === null
      ? null
      : Object.freeze({
        iteration: row.correctionIteration,
        maxIterations: COLOR_CRITIC_MAX_CORRECTION_ITERATIONS,
        proposedDeltas,
        reason: row.correctionReason,
      }),
    confidence: row.confidence,
    confidenceBand: row.confidenceBand as ColorCriticConfidenceBand,
    thresholds: Object.freeze(
      parse<ColorCriticThresholds>(row.thresholdsJson, `critic report ${row.reportId} thresholds`),
    ),
    evaluatedAt: row.evaluatedAt.toISOString(),
    reportHash: row.reportHash,
  }
  // Re-checks the report hash, the cause-to-action table, and every embedded
  // measurement. A verdict softened from reject to approve in the database
  // fails here rather than releasing an export nobody approved.
  return assertColorCriticReportIntegrity(Object.freeze(report))
}

const REPORT_INCLUDE = {
  dimensions: { orderBy: { dimension: 'asc' } },
  issues: true,
  proposedDeltas: true,
} as const

export class PrismaColorCriticReportRepository implements ColorCriticReportRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient = getV2PostgresClient()) {
    this.client = client
  }

  async persist(input: {
    report: Readonly<ColorCriticReport>
    policy?: Readonly<ColorCriticPolicy>
    createdAt: string
  }): Promise<Readonly<{ report: Readonly<ColorCriticReport>; replayed: boolean }>> {
    const { report } = input
    const policy = input.policy ?? DEFAULT_COLOR_CRITIC_POLICY
    const at = new Date(input.createdAt)
    const correction = report.boundedCorrection
    const bytes = report.bytesEvaluated
    const hardIssues = report.issues.filter((issue) => issue.severity === 'hard').length
    const insufficient = report.issues
      .filter((issue) => issue.classification === 'insufficient-evidence').length
    const unavailable = report.dimensions.filter((dimension) => dimension.status === 'unavailable').length

    try {
      await this.client.$transaction(async (transaction) => {
        await transaction.v2ColorCriticReport.create({
          data: {
            id: report.reportId,
            workspaceId: report.workspaceId,
            projectId: report.projectId,
            projectVersionId: report.projectVersionId,
            schemaVersion: report.schemaVersion,
            reportId: report.reportId,
            subjectKind: report.subject.kind,
            subjectSourceAssetId: report.subject.sourceAssetId ?? null,
            subjectCameraId: report.subject.cameraId ?? null,
            subjectArtifactId: report.subject.artifactId ?? null,
            subjectRangeStartTicks: report.subject.range?.start ?? null,
            subjectRangeEndTicks: report.subject.range?.end ?? null,
            referenceCameraId: report.referenceCameraId,
            matchPlanId: report.matchPlanId,
            matchPlanHash: report.matchPlanHash,
            sectionCount: report.sections.length,
            sectionsJson: stringifyWithTicks(report.sections),
            stagePairsJson: JSON.stringify(report.stagePairs),
            bytesEvaluatedJson: JSON.stringify(bytes),
            bytesEvaluatedCount: bytes.length,
            evaluatorsJson: JSON.stringify(report.evaluators),
            dimensionCount: report.dimensions.length,
            unavailableDimensionCount: unavailable,
            issueCount: report.issues.length,
            hardIssueCount: hardIssues,
            insufficientEvidenceCount: insufficient,
            creativeIntentDeclared: report.creativeIntent.declared,
            creativeIntentJson: JSON.stringify(report.creativeIntent),
            castAllowedDelta: report.intentBounds.castAllowedDelta,
            maxDeclaredCastAllowance: report.intentBounds.maxDeclaredCastAllowance,
            cause: report.cause,
            action: report.action,
            correctionIteration: correction?.iteration ?? null,
            correctionMaxIterations: correction?.maxIterations ?? null,
            correctionReason: correction?.reason ?? null,
            proposedDeltaCount: correction?.proposedDeltas.length ?? 0,
            confidence: report.confidence,
            confidenceBand: report.confidenceBand,
            thresholdVersion: report.thresholds.calibrationVersion,
            thresholdsJson: JSON.stringify(report.thresholds),
            evaluatedAt: new Date(report.evaluatedAt),
            reportHash: report.reportHash,
            createdAt: at,
          },
        })

        await transaction.v2ColorCriticDimensionResult.createMany({
          data: report.dimensions.map((dimension) => ({
            id: childRowId([report.reportId, dimension.dimension], 160),
            workspaceId: report.workspaceId,
            reportId: report.reportId,
            dimension: dimension.dimension,
            status: dimension.status,
            stage: dimension.stage,
            value: dimension.value ?? null,
            unit: dimension.unit ?? null,
            threshold: dimension.threshold ?? null,
            classification: dimension.classification ?? null,
            reason: dimension.reason ?? null,
            evaluatorIdsJson: optionalList(dimension.evaluatorIds),
            evidenceRefsJson: optionalList(dimension.evidenceRefs),
            cameraIdsJson: optionalList(dimension.cameraIds),
          })),
        })

        if (report.issues.length > 0) {
          await transaction.v2ColorCriticIssue.createMany({
            data: report.issues.map((issue, ordinal) => ({
              id: childRowId([report.reportId, `i${ordinal}`], 160),
              workspaceId: report.workspaceId,
              reportId: report.reportId,
              ordinal,
              code: issue.code,
              dimension: issue.dimension,
              severity: issue.severity,
              classification: issue.classification,
              cause: issue.cause,
              stage: issue.stage,
              cameraId: issue.cameraId,
              rangeStartTicks: issue.range?.start ?? null,
              rangeEndTicks: issue.range?.end ?? null,
              measured: issue.measured,
              threshold: issue.threshold,
              thresholdVersion: issue.thresholdVersion,
              confidence: issue.confidence,
              evidenceRefsJson: JSON.stringify(issue.evidenceRefs),
              evidenceArtifactId: null,
            })),
          })
        }

        if (correction && correction.proposedDeltas.length > 0) {
          await transaction.v2ColorCriticProposedDelta.createMany({
            // The bounds travel with the delta rather than living in a policy
            // the row cannot see: a stored correction stays checkable against
            // the limits that actually produced it.
            data: correction.proposedDeltas.map((delta) => ({
              id: childRowId([report.reportId, delta.cameraId], 160),
              workspaceId: report.workspaceId,
              reportId: report.reportId,
              cameraId: delta.cameraId,
              exposureEv: delta.exposureEv,
              redGain: delta.whiteBalance?.redGain ?? null,
              greenGain: delta.whiteBalance?.greenGain ?? null,
              blueGain: delta.whiteBalance?.blueGain ?? null,
              saturation: delta.saturation,
              maxExposureEv: policy.maxProposedExposureEv,
              maxGain: policy.maxProposedGain,
              minSaturation: policy.proposedSaturationRange[0],
              maxSaturation: policy.proposedSaturationRange[1],
            })),
          })
        }
      })
      return Object.freeze({ report, replayed: false })
    } catch (error) {
      if (!isPrismaCode(error, 'P2002')) throw error
      const stored = await this.read({ workspaceId: report.workspaceId, reportId: report.reportId })
      if (stored && stored.reportHash === report.reportHash) {
        // The same bytes judged against the same thresholds are the same
        // report: re-running the critic is not a second verdict.
        return Object.freeze({ report: stored, replayed: true })
      }
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `Colour critic report ${report.reportId} already exists with a different verdict`,
      )
    }
  }

  async read(input: { workspaceId: string; reportId: string }) {
    const row = await this.client.v2ColorCriticReport.findFirst({
      where: { workspaceId: input.workspaceId, reportId: input.reportId },
      include: REPORT_INCLUDE,
    })
    return row ? hydrateReport(row) : null
  }

  async readByHash(input: { workspaceId: string; reportHash: string }) {
    const row = await this.client.v2ColorCriticReport.findFirst({
      where: { workspaceId: input.workspaceId, reportHash: input.reportHash },
      include: REPORT_INCLUDE,
    })
    return row ? hydrateReport(row) : null
  }

  async listForProjectVersion(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    limit?: number
  }) {
    const rows = await this.client.v2ColorCriticReport.findMany({
      where: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        projectVersionId: input.projectVersionId,
      },
      orderBy: [{ evaluatedAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(input.limit ?? 25, 1), 200),
      include: REPORT_INCLUDE,
    })
    return Object.freeze(rows.map(hydrateReport))
  }

  async findDependentsOfMatchPlan(input: {
    workspaceId: string
    matchPlanId: string
  }): Promise<readonly Readonly<ColorCriticReportRef>[]> {
    const rows = await this.client.v2ColorCriticReport.findMany({
      where: { workspaceId: input.workspaceId, matchPlanId: input.matchPlanId },
      orderBy: { evaluatedAt: 'desc' },
      select: {
        reportId: true,
        projectVersionId: true,
        action: true,
        cause: true,
        matchPlanId: true,
        matchPlanHash: true,
        evaluatedAt: true,
      },
    })
    return Object.freeze(rows.map((row) => Object.freeze({
      ...row,
      evaluatedAt: row.evaluatedAt.toISOString(),
    })))
  }
}
