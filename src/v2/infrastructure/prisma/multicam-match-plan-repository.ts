import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type {
  CameraColorMeasurementRepository,
  MulticamMatchPlanBase,
  MulticamMatchPlanDependencyRef,
  MulticamMatchPlanRepository,
  StoredMulticamMatchPlan,
} from '../../application/ports/multicam-match-plan-repository.ts'
import { childRowId } from './child-row-id.ts'
import type { ColorMetadata, ColorTransform } from '../../domain/color-and-export.ts'
import {
  CAMERA_COLOR_MEASUREMENT_SCHEMA_VERSION,
  COLOR_MEASUREMENT_DIMENSIONS,
  assertCameraColorMeasurementIntegrity,
  type CameraColorMeasurement,
  type ColorEvaluatorKind,
  type ColorMeasurementDimension,
  type ColorMeasurementDimensionResult,
  type ColorMeasurementIssue,
  type ColorMeasurementStatus,
  type HdrMode,
} from '../../domain/color-measurement.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  MATCH_PIPELINE_STAGE,
  MULTICAM_MATCH_PLAN_SCHEMA_VERSION,
  assertMulticamMatchPlanIntegrity,
  type CameraMatchTransform,
  type MatchActorKind,
  type MatchDeltas,
  type MatchPlanIssue,
  type MatchPlanLineage,
  type MatchRangeOverride,
  type MulticamMatchPlan,
  type NonComparableRange,
} from '../../domain/multicam-match-plan.ts'
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

function numberParameter(
  parameters: Readonly<Record<string, string | number | boolean>>,
  key: string,
): number | null {
  const value = parameters[key]
  return typeof value === 'number' ? value : null
}

/**
 * Row keys carry the workspace because the primary key is global and the
 * business ids are not: two workspaces may each have a `session-1`, and
 * without the prefix the second one to write would be told its own aggregate
 * already exists with different content.
 */
function planRowId(workspaceId: string, projectId: string, sessionId: string, version: number): string {
  return childRowId([workspaceId, projectId, sessionId, `mp${version}`], 160)
}

/** The stored row of a measurement, which its children and joins point at. */
function measurementRowId(workspaceId: string, measurementId: string): string {
  return childRowId([workspaceId, measurementId], 128)
}

// ---------------------------------------------------------------------------
// Camera colour measurements
// ---------------------------------------------------------------------------

interface DimensionRow {
  dimension: string
  status: string
  value: number | null
  unit: string | null
  evaluatorId: string | null
  evaluatorKind: string | null
  evaluatorVersion: string | null
  evidenceRef: string | null
  reason: string | null
  components: readonly { name: string; value: number }[]
}

interface MeasurementRow {
  measurementId: string
  sessionId: string | null
  schemaVersion: string
  sourceAssetId: string
  sourceSha256: string
  cameraId: string
  rangeStartTicks: bigint
  rangeEndTicks: bigint
  sourceStartFrame: number
  sourceEndFrame: number
  sampledFrames: number
  pixelFormat: string
  hdrMode: string
  metadataJson: string
  comparable: boolean
  comparabilityJson: string
  confidence: number
  issuesJson: string
  measurementHash: string
  dimensions: readonly DimensionRow[]
}

function hydrateDimension(
  measurementId: string,
  row: DimensionRow,
): Readonly<ColorMeasurementDimensionResult> {
  const status = row.status as ColorMeasurementStatus
  if (status !== 'measured') {
    // Not measured is the absence of a number, so the absent keys stay absent:
    // writing `value: undefined` would make a stored dimension a different
    // object from the one the domain built, for no reason a reader can see.
    if (row.reason === null) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `Stored dimension ${row.dimension} of ${measurementId} is ${status} and says nothing about why`,
      )
    }
    return Object.freeze({ status, reason: row.reason })
  }
  if (
    row.value === null || row.unit === null || row.evidenceRef === null ||
    row.evaluatorId === null || row.evaluatorKind === null || row.evaluatorVersion === null
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored dimension ${row.dimension} of ${measurementId} claims a measurement without one`,
    )
  }
  const components = row.components.length === 0
    ? undefined
    : Object.freeze(Object.fromEntries(
        [...row.components]
          .sort((left, right) => left.name.localeCompare(right.name))
          .map((component) => [component.name, component.value] as const),
      ))
  return Object.freeze({
    status: 'measured' as const,
    value: row.value,
    unit: row.unit,
    evaluator: Object.freeze({
      id: row.evaluatorId,
      kind: row.evaluatorKind as ColorEvaluatorKind,
      version: row.evaluatorVersion,
    }),
    evidenceRef: row.evidenceRef,
    ...(components ? { components } : {}),
  })
}

function hydrateMeasurement(row: MeasurementRow): Readonly<CameraColorMeasurement> {
  if (row.schemaVersion !== CAMERA_COLOR_MEASUREMENT_SCHEMA_VERSION) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored colour measurement ${row.measurementId} carries an unknown schema version`,
    )
  }
  const byDimension = new Map(row.dimensions.map((dimension) => [dimension.dimension, dimension]))
  const dimensions: Partial<Record<ColorMeasurementDimension, Readonly<ColorMeasurementDimensionResult>>> = {}
  for (const dimension of COLOR_MEASUREMENT_DIMENSIONS) {
    const stored = byDimension.get(dimension)
    if (!stored) {
      // Every dimension answers, even if the answer is "not read". A missing
      // row is a truncated write, not a dimension that came out at zero.
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `Stored colour measurement ${row.measurementId} has no answer for ${dimension}`,
      )
    }
    dimensions[dimension] = hydrateDimension(row.measurementId, stored)
  }
  const measurement: CameraColorMeasurement = {
    schemaVersion: CAMERA_COLOR_MEASUREMENT_SCHEMA_VERSION,
    measurementId: row.measurementId,
    sessionId: row.sessionId,
    sourceAssetId: row.sourceAssetId,
    sourceSha256: row.sourceSha256,
    cameraId: row.cameraId,
    range: createTickInterval(row.rangeStartTicks, row.rangeEndTicks),
    sourceRange: Object.freeze({ startFrame: row.sourceStartFrame, endFrame: row.sourceEndFrame }),
    sampledFrames: row.sampledFrames,
    technical: Object.freeze({
      metadata: Object.freeze(parse<ColorMetadata>(row.metadataJson, `measurement ${row.measurementId} metadata`)),
      pixelFormat: row.pixelFormat,
      hdrMode: row.hdrMode as HdrMode,
    }),
    dimensions: Object.freeze(dimensions) as Readonly<Record<ColorMeasurementDimension, Readonly<ColorMeasurementDimensionResult>>>,
    comparability: Object.freeze({
      comparable: row.comparable,
      reasons: Object.freeze(
        parse<string[]>(row.comparabilityJson, `measurement ${row.measurementId} comparability reasons`),
      ),
    }),
    confidence: row.confidence,
    issues: Object.freeze(
      parse<ColorMeasurementIssue[]>(row.issuesJson, `measurement ${row.measurementId} issues`)
        .map((issue) => Object.freeze(issue)),
    ),
    measurementHash: row.measurementHash,
  }
  // A value edited underneath the row is refused rather than believed: a match
  // built on a repaired exposure would correct footage nobody measured.
  return assertCameraColorMeasurementIntegrity(Object.freeze(measurement))
}

const MEASUREMENT_INCLUDE = {
  dimensions: { include: { components: true }, orderBy: { dimension: 'asc' } },
} as const

function measurementWriteData(
  workspaceId: string,
  measurement: Readonly<CameraColorMeasurement>,
  createdAt: Date,
) {
  const measured = COLOR_MEASUREMENT_DIMENSIONS
    .filter((dimension) => measurement.dimensions[dimension].status === 'measured').length
  return {
    id: measurementRowId(workspaceId, measurement.measurementId),
    workspaceId,
    sessionId: measurement.sessionId,
    schemaVersion: measurement.schemaVersion,
    measurementId: measurement.measurementId,
    sourceAssetId: measurement.sourceAssetId,
    sourceSha256: measurement.sourceSha256,
    cameraId: measurement.cameraId,
    rangeStartTicks: measurement.range.start,
    rangeEndTicks: measurement.range.end,
    sourceStartFrame: measurement.sourceRange.startFrame,
    sourceEndFrame: measurement.sourceRange.endFrame,
    sampledFrames: measurement.sampledFrames,
    pixelFormat: measurement.technical.pixelFormat,
    hdrMode: measurement.technical.hdrMode,
    metadataJson: JSON.stringify(measurement.technical.metadata),
    comparable: measurement.comparability.comparable,
    comparabilityJson: JSON.stringify(measurement.comparability.reasons),
    confidence: measurement.confidence,
    issuesJson: JSON.stringify(measurement.issues),
    measuredDimensions: measured,
    measurementHash: measurement.measurementHash,
    createdAt,
  }
}

type TransactionClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]

async function writeMeasurement(
  transaction: TransactionClient,
  workspaceId: string,
  measurement: Readonly<CameraColorMeasurement>,
  createdAt: Date,
): Promise<void> {
  await transaction.v2CameraColorMeasurement.create({
    data: measurementWriteData(workspaceId, measurement, createdAt),
  })
  for (const dimension of COLOR_MEASUREMENT_DIMENSIONS) {
    const result = measurement.dimensions[dimension]
    const parentId = measurementRowId(workspaceId, measurement.measurementId)
    const dimensionId = childRowId([parentId, dimension], 160)
    const measured = result.status === 'measured'
    await transaction.v2ColorMeasurementDimension.create({
      data: {
        id: dimensionId,
        workspaceId,
        measurementId: parentId,
        dimension,
        status: result.status,
        value: measured ? result.value ?? null : null,
        unit: measured ? result.unit ?? null : null,
        evaluatorId: measured ? result.evaluator?.id ?? null : null,
        evaluatorKind: measured ? result.evaluator?.kind ?? null : null,
        evaluatorVersion: measured ? result.evaluator?.version ?? null : null,
        evidenceRef: measured ? result.evidenceRef ?? null : null,
        reason: measured ? null : result.reason ?? null,
      },
    })
    const components = Object.entries(result.components ?? {})
    if (components.length === 0) continue
    await transaction.v2ColorMeasurementComponent.createMany({
      data: components.map(([name, value]) => ({
        id: childRowId([dimensionId, name], 160),
        workspaceId,
        dimensionId,
        name,
        value,
      })),
    })
  }
}

export class PrismaCameraColorMeasurementRepository implements CameraColorMeasurementRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient = getV2PostgresClient()) {
    this.client = client
  }

  async persist(input: {
    workspaceId: string
    measurement: Readonly<CameraColorMeasurement>
    createdAt: string
  }): Promise<Readonly<{ measurement: Readonly<CameraColorMeasurement>; replayed: boolean }>> {
    const { measurement, workspaceId } = input
    try {
      await this.client.$transaction(async (transaction) => {
        await writeMeasurement(transaction, workspaceId, measurement, new Date(input.createdAt))
      })
      return Object.freeze({ measurement, replayed: false })
    } catch (error) {
      if (!isPrismaCode(error, 'P2002')) throw error
      const stored = await this.read({ workspaceId, measurementId: measurement.measurementId })
      if (stored && stored.measurementHash === measurement.measurementHash) {
        return Object.freeze({ measurement: stored, replayed: true })
      }
      // Re-measuring the same range and getting a different answer is a second
      // measurement, not a correction of the first: two numbers under one id
      // would make "what did we measure" unanswerable.
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `Colour measurement ${measurement.measurementId} already exists with different content`,
      )
    }
  }

  async read(input: { workspaceId: string; measurementId: string }) {
    const row = await this.client.v2CameraColorMeasurement.findFirst({
      where: { workspaceId: input.workspaceId, measurementId: input.measurementId },
      include: MEASUREMENT_INCLUDE,
    })
    return row ? hydrateMeasurement(row) : null
  }

  async listForSession(input: { workspaceId: string; sessionId: string }) {
    const rows = await this.client.v2CameraColorMeasurement.findMany({
      where: { workspaceId: input.workspaceId, sessionId: input.sessionId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: MEASUREMENT_INCLUDE,
    })
    return Object.freeze(rows.map(hydrateMeasurement))
  }

  async listForCamera(input: { workspaceId: string; cameraId: string; sourceAssetId?: string }) {
    const rows = await this.client.v2CameraColorMeasurement.findMany({
      where: {
        workspaceId: input.workspaceId,
        cameraId: input.cameraId,
        ...(input.sourceAssetId ? { sourceAssetId: input.sourceAssetId } : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: MEASUREMENT_INCLUDE,
    })
    return Object.freeze(rows.map(hydrateMeasurement))
  }
}

// ---------------------------------------------------------------------------
// Match plans
// ---------------------------------------------------------------------------

function hydrateTransform(
  planId: string,
  row: { cameraId: string; transformJson: string; deltasJson: string; derivedFromJson: string; rangePairs: number; confidence: number },
): Readonly<CameraMatchTransform> {
  return Object.freeze({
    cameraId: row.cameraId,
    transform: Object.freeze(
      parse<ColorTransform>(row.transformJson, `plan ${planId} transform for ${row.cameraId}`),
    ),
    derivedFrom: Object.freeze(
      parse<string[]>(row.derivedFromJson, `plan ${planId} transform provenance for ${row.cameraId}`),
    ),
    deltas: Object.freeze(parse<MatchDeltas>(row.deltasJson, `plan ${planId} deltas for ${row.cameraId}`)),
    confidence: row.confidence,
    rangePairs: row.rangePairs,
  })
}

function hydrateOverride(
  planId: string,
  row: {
    ordinal: number
    overrideId: string
    cameraId: string
    segmentId: string | null
    rangeStartTicks: bigint | null
    rangeEndTicks: bigint | null
    transformJson: string
    reason: string
    actorKind: string
    actorId: string
  },
): Readonly<MatchRangeOverride> {
  // `segmentId` and `range` are alternatives, and the absent one is absent
  // rather than null: the plan hash covers the shape, not just the values.
  return Object.freeze({
    overrideId: row.overrideId,
    cameraId: row.cameraId,
    ...(row.segmentId === null ? {} : { segmentId: row.segmentId }),
    ...(row.rangeStartTicks === null || row.rangeEndTicks === null
      ? {}
      : { range: createTickInterval(row.rangeStartTicks, row.rangeEndTicks) }),
    transform: Object.freeze(
      parse<ColorTransform>(row.transformJson, `plan ${planId} override ${row.overrideId} transform`),
    ),
    reason: row.reason,
    actor: Object.freeze({ kind: row.actorKind as MatchActorKind, id: row.actorId }),
  })
}

interface PlanRow {
  workspaceId: string
  projectId: string
  sessionId: string
  schemaVersion: string
  planId: string
  version: number
  previousVersionHash: string | null
  supersedesPlanId: string | null
  sessionVersion: number
  referenceEpoch: number
  referenceCameraId: string
  selectedByKind: string
  selectedById: string
  selectedAt: Date
  selectionBaseVersionId: string
  selectionBaseHash: string
  confidence: number
  humanReviewRequired: boolean
  lineageJson: string
  dependsOnMeasurementIdsJson: string
  planHash: string
  createdAt: Date
  measurements: readonly { ordinal: number; isReference: boolean; measurement: MeasurementRow }[]
  cameraTransforms: readonly Parameters<typeof hydrateTransform>[1][]
  rangeOverrides: readonly Parameters<typeof hydrateOverride>[1][]
  nonComparableRanges: readonly {
    ordinal: number
    cameraId: string
    measurementId: string
    rangeStartTicks: bigint
    rangeEndTicks: bigint
    reason: string
  }[]
  issues: readonly {
    ordinal: number
    code: string
    cameraId: string | null
    message: string
    humanReviewRequired: boolean
  }[]
}

function hydratePlan(row: PlanRow): Readonly<StoredMulticamMatchPlan> {
  if (row.schemaVersion !== MULTICAM_MATCH_PLAN_SCHEMA_VERSION) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored match plan ${row.planId} carries an unknown schema version`,
    )
  }
  const plan: MulticamMatchPlan = {
    schemaVersion: MULTICAM_MATCH_PLAN_SCHEMA_VERSION,
    planId: row.planId,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    sessionId: row.sessionId,
    sessionVersion: row.sessionVersion,
    referenceEpoch: row.referenceEpoch,
    referenceCameraId: row.referenceCameraId,
    referenceCameraSelection: Object.freeze({
      selectedBy: Object.freeze({ kind: row.selectedByKind as MatchActorKind, id: row.selectedById }),
      selectedAt: row.selectedAt.toISOString(),
      baseVersionId: row.selectionBaseVersionId,
      baseHash: row.selectionBaseHash,
    }),
    // Measurements are joined back rather than copied in: the plan and a
    // critic report that cite one measurement cite one row.
    // The plan keeps the measurements in the order it was derived from, and
    // that order is inside the plan hash: sorting them here by id would work
    // for every fixture whose ids happen to be sorted and permute every other.
    measurements: Object.freeze(
      [...row.measurements]
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((entry) => hydrateMeasurement(entry.measurement)),
    ),
    cameraTransforms: Object.freeze(
      [...row.cameraTransforms]
        .map((transform) => hydrateTransform(row.planId, transform))
        .sort((left, right) => left.cameraId.localeCompare(right.cameraId)),
    ),
    rangeOverrides: Object.freeze(
      [...row.rangeOverrides]
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((override) => hydrateOverride(row.planId, override)),
    ),
    confidence: row.confidence,
    issues: Object.freeze(
      [...row.issues].sort((left, right) => left.ordinal - right.ordinal).map((issue) => Object.freeze({
        code: issue.code,
        cameraId: issue.cameraId,
        message: issue.message,
        humanReviewRequired: issue.humanReviewRequired,
      } satisfies MatchPlanIssue)),
    ),
    nonComparableRanges: Object.freeze(
      [...row.nonComparableRanges].sort((left, right) => left.ordinal - right.ordinal).map((range) => Object.freeze({
        cameraId: range.cameraId,
        measurementId: range.measurementId,
        range: createTickInterval(range.rangeStartTicks, range.rangeEndTicks),
        reason: range.reason,
      } satisfies NonComparableRange)),
    ),
    humanReviewRequired: row.humanReviewRequired,
    pipelineStage: MATCH_PIPELINE_STAGE,
    lineage: Object.freeze(parse<MatchPlanLineage>(row.lineageJson, `plan ${row.planId} lineage`)),
    dependsOn: Object.freeze({
      measurementIds: Object.freeze(
        parse<string[]>(row.dependsOnMeasurementIdsJson, `plan ${row.planId} dependencies`),
      ),
      referenceCameraId: row.referenceCameraId,
    }),
    supersedes: row.supersedesPlanId,
    createdAt: row.createdAt.toISOString(),
    planHash: row.planHash,
  }
  // Re-checks the plan hash, every measurement hash, and that no transform in
  // it is anything but a match-stage transform.
  assertMulticamMatchPlanIntegrity(Object.freeze(plan))
  return Object.freeze({ plan, version: row.version, previousVersionHash: row.previousVersionHash })
}

const PLAN_INCLUDE = {
  measurements: { include: { measurement: { include: MEASUREMENT_INCLUDE } }, orderBy: { ordinal: 'asc' } },
  cameraTransforms: true,
  rangeOverrides: { orderBy: { ordinal: 'asc' } },
  nonComparableRanges: true,
  issues: true,
} as const

export class PrismaMulticamMatchPlanRepository implements MulticamMatchPlanRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient = getV2PostgresClient()) {
    this.client = client
  }

  async appendVersion(input: {
    plan: Readonly<MulticamMatchPlan>
    base: Readonly<MulticamMatchPlanBase> | null
    occurredAt: string
  }): Promise<Readonly<{ stored: Readonly<StoredMulticamMatchPlan>; replayed: boolean }>> {
    const { plan, base } = input
    const version = base === null ? 1 : base.version + 1
    const id = planRowId(plan.workspaceId, plan.projectId, plan.sessionId, version)
    const at = new Date(input.occurredAt)
    const reviewIssues = plan.issues.filter((issue) => issue.humanReviewRequired).length

    try {
      await this.client.$transaction(async (transaction) => {
        // Measurements first: the join row is a Restrict foreign key, so a plan
        // cannot name a measurement that is not stored, and deleting a
        // measurement a plan cites is refused rather than cascaded away.
        const known = await transaction.v2CameraColorMeasurement.findMany({
          where: {
            workspaceId: plan.workspaceId,
            measurementId: { in: plan.measurements.map((measurement) => measurement.measurementId) },
          },
          select: { measurementId: true, measurementHash: true },
        })
        const stored = new Map(known.map((entry) => [entry.measurementId, entry.measurementHash]))
        for (const measurement of plan.measurements) {
          const existing = stored.get(measurement.measurementId)
          if (existing === undefined) {
            await writeMeasurement(transaction, plan.workspaceId, measurement, at)
            continue
          }
          if (existing !== measurement.measurementHash) {
            throw new DomainError(
              'PERSISTENCE_CONFLICT',
              `Colour measurement ${measurement.measurementId} is already stored with different content`,
            )
          }
        }

        await transaction.v2MulticamMatchPlan.create({
          data: {
            id,
            workspaceId: plan.workspaceId,
            projectId: plan.projectId,
            sessionId: plan.sessionId,
            schemaVersion: plan.schemaVersion,
            planId: plan.planId,
            version,
            previousVersionHash: base === null ? null : base.planHash,
            supersedesPlanId: plan.supersedes,
            sessionVersion: plan.sessionVersion,
            referenceEpoch: plan.referenceEpoch,
            referenceCameraId: plan.referenceCameraId,
            selectedByKind: plan.referenceCameraSelection.selectedBy.kind,
            selectedById: plan.referenceCameraSelection.selectedBy.id,
            selectedAt: new Date(plan.referenceCameraSelection.selectedAt),
            selectionBaseVersionId: plan.referenceCameraSelection.baseVersionId,
            selectionBaseHash: plan.referenceCameraSelection.baseHash,
            confidence: plan.confidence,
            pipelineStage: plan.pipelineStage,
            humanReviewRequired: plan.humanReviewRequired,
            transformCount: plan.cameraTransforms.length,
            overrideCount: plan.rangeOverrides.length,
            issueCount: plan.issues.length,
            nonComparableCount: plan.nonComparableRanges.length,
            reviewIssueCount: reviewIssues,
            lineageJson: JSON.stringify(plan.lineage),
            dependsOnMeasurementIdsJson: JSON.stringify(plan.dependsOn.measurementIds),
            planHash: plan.planHash,
            createdAt: at,
          },
        })

        if (plan.measurements.length > 0) {
          await transaction.v2MatchPlanMeasurement.createMany({
            data: plan.measurements.map((measurement, ordinal) => ({
              id: childRowId([id, measurement.measurementId], 160),
              workspaceId: plan.workspaceId,
              planId: id,
              ordinal,
              measurementId: measurementRowId(plan.workspaceId, measurement.measurementId),
              cameraId: measurement.cameraId,
              isReference: measurement.cameraId === plan.referenceCameraId,
            })),
          })
        }

        for (const entry of plan.cameraTransforms) {
          const parameters = entry.transform.implementation.parameters
          const mode = typeof parameters.mode === 'string' ? parameters.mode : 'adjust'
          await transaction.v2CameraMatchTransform.create({
            data: {
              id: childRowId([id, entry.cameraId], 160),
              workspaceId: plan.workspaceId,
              planId: id,
              cameraId: entry.cameraId,
              transformId: entry.transform.id,
              provider: entry.transform.implementation.provider,
              providerVersion: entry.transform.implementation.version,
              mode,
              enabled: entry.transform.enabled,
              transformJson: JSON.stringify(entry.transform),
              parametersJson: JSON.stringify(parameters),
              deltasJson: JSON.stringify(entry.deltas),
              brightness: numberParameter(parameters, 'brightness'),
              contrast: numberParameter(parameters, 'contrast'),
              saturation: numberParameter(parameters, 'saturation'),
              redGain: numberParameter(parameters, 'red-gain'),
              greenGain: numberParameter(parameters, 'green-gain'),
              blueGain: numberParameter(parameters, 'blue-gain'),
              exposureEv: entry.deltas.exposureEv,
              derivedFromJson: JSON.stringify(entry.derivedFrom),
              derivedFromCount: entry.derivedFrom.length,
              rangePairs: entry.rangePairs,
              confidence: entry.confidence,
            },
          })
        }

        for (const [ordinal, override] of plan.rangeOverrides.entries()) {
          const parameters = override.transform.implementation.parameters
          await transaction.v2MatchRangeOverride.create({
            data: {
              id: childRowId([id, override.overrideId], 160),
              workspaceId: plan.workspaceId,
              planId: id,
              ordinal,
              overrideId: override.overrideId,
              cameraId: override.cameraId,
              segmentId: override.segmentId ?? null,
              rangeStartTicks: override.range?.start ?? null,
              rangeEndTicks: override.range?.end ?? null,
              transformId: override.transform.id,
              provider: override.transform.implementation.provider,
              providerVersion: override.transform.implementation.version,
              transformJson: JSON.stringify(override.transform),
              parametersJson: JSON.stringify(parameters),
              reason: override.reason,
              actorKind: override.actor.kind,
              actorId: override.actor.id,
            },
          })
        }

        if (plan.nonComparableRanges.length > 0) {
          await transaction.v2MatchNonComparableRange.createMany({
            data: plan.nonComparableRanges.map((range, ordinal) => ({
              id: childRowId([id, `nc${ordinal}`], 160),
              workspaceId: plan.workspaceId,
              planId: id,
              ordinal,
              cameraId: range.cameraId,
              measurementId: range.measurementId,
              rangeStartTicks: range.range.start,
              rangeEndTicks: range.range.end,
              reason: range.reason,
            })),
          })
        }

        if (plan.issues.length > 0) {
          await transaction.v2MatchPlanIssue.createMany({
            data: plan.issues.map((issue, ordinal) => ({
              id: childRowId([id, `i${ordinal}`], 160),
              workspaceId: plan.workspaceId,
              planId: id,
              ordinal,
              code: issue.code,
              cameraId: issue.cameraId,
              message: issue.message,
              humanReviewRequired: issue.humanReviewRequired,
            })),
          })
        }

        if (base === null) {
          await transaction.v2MulticamMatchPlanHead.create({
            data: {
              id: childRowId([plan.workspaceId, plan.projectId, plan.sessionId], 160),
              workspaceId: plan.workspaceId,
              projectId: plan.projectId,
              sessionId: plan.sessionId,
              planId: plan.planId,
              version: 1,
              planHash: plan.planHash,
              referenceCameraId: plan.referenceCameraId,
              humanReviewRequired: plan.humanReviewRequired,
              createdAt: at,
              updatedAt: at,
            },
          })
          return
        }

        const advanced = await transaction.v2MulticamMatchPlanHead.updateMany({
          where: {
            workspaceId: plan.workspaceId,
            projectId: plan.projectId,
            sessionId: plan.sessionId,
            version: base.version,
            planHash: base.planHash,
          },
          data: {
            planId: plan.planId,
            version,
            planHash: plan.planHash,
            referenceCameraId: plan.referenceCameraId,
            humanReviewRequired: plan.humanReviewRequired,
            updatedAt: at,
          },
        })
        if (advanced.count !== 1) {
          const current = await transaction.v2MulticamMatchPlanHead.findFirst({
            where: { workspaceId: plan.workspaceId, projectId: plan.projectId, sessionId: plan.sessionId },
            select: { version: true, planHash: true },
          })
          throw new DomainError(
            'PERSISTENCE_CONFLICT',
            `The match plan for ${plan.projectId}/${plan.sessionId} moved on: version ${base.version} is no longer current`,
            { currentVersion: current?.version ?? null, currentHash: current?.planHash ?? null },
          )
        }
      })
      const stored = await this.readVersion({
        workspaceId: plan.workspaceId,
        projectId: plan.projectId,
        sessionId: plan.sessionId,
        version,
      })
      if (!stored) {
        throw new DomainError('PERSISTENCE_CONFLICT', `Match plan ${id} vanished between write and read`)
      }
      return Object.freeze({ stored, replayed: false })
    } catch (error) {
      if (!isPrismaCode(error, 'P2002')) throw error
      const stored = await this.readVersion({
        workspaceId: plan.workspaceId,
        projectId: plan.projectId,
        sessionId: plan.sessionId,
        version,
      })
      if (stored && stored.plan.planHash === plan.planHash) {
        return Object.freeze({ stored, replayed: true })
      }
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `The match plan for ${plan.projectId}/${plan.sessionId} already has a different version ${version}`,
      )
    }
  }

  async readHead(input: { workspaceId: string; projectId: string; sessionId: string }) {
    const head = await this.client.v2MulticamMatchPlanHead.findFirst({
      where: { workspaceId: input.workspaceId, projectId: input.projectId, sessionId: input.sessionId },
      select: { version: true },
    })
    return head ? this.readVersion({ ...input, version: head.version }) : null
  }

  async readVersion(input: {
    workspaceId: string
    projectId: string
    sessionId: string
    version: number
  }) {
    const row = await this.client.v2MulticamMatchPlan.findFirst({
      where: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        version: input.version,
      },
      include: PLAN_INCLUDE,
    })
    return row ? hydratePlan(row) : null
  }

  async listVersions(input: {
    workspaceId: string
    projectId: string
    sessionId: string
    limit?: number
  }) {
    const rows = await this.client.v2MulticamMatchPlan.findMany({
      where: { workspaceId: input.workspaceId, projectId: input.projectId, sessionId: input.sessionId },
      orderBy: { version: 'desc' },
      take: Math.min(Math.max(input.limit ?? 25, 1), 200),
      include: PLAN_INCLUDE,
    })
    return Object.freeze(rows.map(hydratePlan))
  }

  async findDependents(input: {
    workspaceId: string
    measurementId?: string
    referenceCameraId?: string
    sessionId?: string
  }): Promise<readonly Readonly<MulticamMatchPlanDependencyRef>[]> {
    const rows = await this.client.v2MulticamMatchPlan.findMany({
      where: {
        workspaceId: input.workspaceId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.referenceCameraId ? { referenceCameraId: input.referenceCameraId } : {}),
        ...(input.measurementId
          ? { measurements: { some: { measurementId: measurementRowId(input.workspaceId, input.measurementId) } } }
          : {}),
      },
      orderBy: [{ projectId: 'asc' }, { sessionId: 'asc' }, { version: 'desc' }],
      select: {
        projectId: true,
        sessionId: true,
        version: true,
        planHash: true,
        referenceCameraId: true,
        humanReviewRequired: true,
      },
    })
    if (rows.length === 0) return Object.freeze([])
    const heads = await this.client.v2MulticamMatchPlanHead.findMany({
      where: {
        workspaceId: input.workspaceId,
        projectId: { in: [...new Set(rows.map((row) => row.projectId))] },
        sessionId: { in: [...new Set(rows.map((row) => row.sessionId))] },
      },
      select: { projectId: true, sessionId: true, planHash: true },
    })
    const headHashes = new Map(heads.map((head) => [`${head.projectId}/${head.sessionId}`, head.planHash]))
    return Object.freeze(rows.map((row) => Object.freeze({
      ...row,
      isHead: headHashes.get(`${row.projectId}/${row.sessionId}`) === row.planHash,
    })))
  }
}
