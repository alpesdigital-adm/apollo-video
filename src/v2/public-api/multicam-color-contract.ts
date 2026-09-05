import type {
  ColorCriticIssueListing,
} from '../application/color-critic.ts'
import type {
  AddMulticamMatchRangeOverrideResult,
  DeriveMulticamMatchPlanResult,
  MulticamMatchColorPlanWrite,
  MulticamMatchPlanRead,
} from '../application/multicam-color-match.ts'
import type { ColorTransform } from '../domain/color-and-export.ts'
import {
  COLOR_CRITIC_DIMENSIONS,
  COLOR_CRITIC_SEVERITIES,
  type ColorCriticIssue,
  type ColorCriticReport,
} from '../domain/color-critic-report.ts'
import type { CameraColorMeasurement } from '../domain/color-measurement.ts'
import { DomainError } from '../domain/errors.ts'
import type {
  CameraMatchTransform,
  MatchRangeOverride,
  MulticamMatchPlan,
} from '../domain/multicam-match-plan.ts'
import {
  boundedNumber,
  exactFields,
  identifier,
  member,
  presentInterval,
  presentOptionalInterval,
  record,
  sha256,
  text,
  tick,
} from './capture-derivation-contract.ts'

/**
 * The public boundary for the multicamera colour match and the colour critic
 * (F4.013, F4.014).
 *
 * Two things a reader of this file should not have to infer.
 *
 * **The critic has no command here.** `evaluateColorCriticService` is handed a
 * path on the server's disk, the sha of the bytes at it, and the clips the
 * timeline was cut from; the render worker measures all three. A caller-facing
 * "evaluate" would have to accept them from the request, which is the caller
 * supplying the evidence for a verdict about their own render. The critic runs
 * inside the proxy render, and what this boundary publishes is what it decided.
 *
 * **The reference camera is the only colour decision a caller makes.** It is a
 * position — which camera the others are corrected towards — and the service
 * checks that the session actually carries it. Every delta, confidence and
 * issue below is measured from decoded frames.
 *
 * The one exception is a range override, where the parameters *are* the
 * caller's: an operator saying "this shot, one third of a stop up" is an
 * editorial correction, not a measurement, and the domain bounds each number
 * before it becomes a transform.
 */

const TOKEN = /^[a-z0-9][a-z0-9._/-]{0,127}$/

function token(value: unknown, field: string): string {
  if (typeof value !== 'string' || !TOKEN.test(value)) {
    throw new DomainError('INVALID_ARGUMENT', `${field} is not a canonical lowercase key`)
  }
  return value
}

// ---------------------------------------------------------------------------
// Match plan
// ---------------------------------------------------------------------------

/**
 * A colour transform as the plan holds it, recipe included.
 *
 * `implementation.parameters` is the provider's own recipe and it is published
 * rather than summarised: `parametersHash` alone identifies a transform without
 * saying what it does, and a person asked to approve a correction of a camera
 * they filmed deserves to read the numbers rather than a digest of them.
 *
 * The shape is the one `colorTransformSchema` already publishes for a
 * ColorPlan (`schema-registry.ts`), including an **absent** `lut` rather than a
 * null one — a second shape for the same object would let a client parse the
 * project's plan and fail on the match plan that wrote half of it.
 */
export function presentColorTransform(transform: Readonly<ColorTransform>) {
  return Object.freeze({
    id: transform.id,
    kind: transform.kind,
    version: transform.version,
    enabled: transform.enabled,
    input: Object.freeze({ ...transform.input }),
    output: Object.freeze({ ...transform.output }),
    implementation: Object.freeze({
      provider: transform.implementation.provider,
      version: transform.implementation.version,
      parameters: Object.freeze({ ...transform.implementation.parameters }),
      parametersHash: transform.implementation.parametersHash,
    }),
    ...(transform.lut === undefined ? {} : { lut: Object.freeze({ ...transform.lut }) }),
  })
}

function presentCameraTransform(entry: Readonly<CameraMatchTransform>) {
  return Object.freeze({
    cameraId: entry.cameraId,
    transform: presentColorTransform(entry.transform),
    derivedFrom: entry.derivedFrom,
    // Null in every slot nobody could measure. A white balance of 1/1/1 would
    // read as "measured, and the camera already matches".
    deltas: Object.freeze({
      exposureEv: entry.deltas.exposureEv,
      whiteBalance: entry.deltas.whiteBalance === null
        ? null
        : Object.freeze({ ...entry.deltas.whiteBalance }),
      contrast: entry.deltas.contrast,
      saturation: entry.deltas.saturation,
    }),
    confidence: entry.confidence,
    /** How many measured range pairs the transform was fitted over. */
    rangePairs: entry.rangePairs,
  })
}

function presentRangeOverride(override: Readonly<MatchRangeOverride>) {
  return Object.freeze({
    overrideId: override.overrideId,
    cameraId: override.cameraId,
    segmentId: override.segmentId ?? null,
    range: presentOptionalInterval(override.range ?? null),
    transform: presentColorTransform(override.transform),
    reason: override.reason,
    actor: Object.freeze({ kind: override.actor.kind, id: override.actor.id }),
  })
}

/**
 * A measurement as the plan cites it, not as the measurement records itself.
 *
 * The per-dimension readings live in the measurement aggregate, which several
 * plans and every critic report over the same frames cite by id. Copying them
 * into each plan would be two answers to one question; what travels here is
 * enough to tell one citation from another and to say whether the range was
 * comparable at all.
 */
function presentMeasurementRef(measurement: Readonly<CameraColorMeasurement>) {
  return Object.freeze({
    measurementId: measurement.measurementId,
    cameraId: measurement.cameraId,
    sourceAssetId: measurement.sourceAssetId,
    sourceSha256: measurement.sourceSha256,
    range: presentInterval(measurement.range),
    sourceRange: Object.freeze({ ...measurement.sourceRange }),
    sampledFrames: measurement.sampledFrames,
    confidence: measurement.confidence,
    comparability: Object.freeze({
      comparable: measurement.comparability.comparable,
      reasons: measurement.comparability.reasons,
    }),
    issues: measurement.issues.map((issue) => Object.freeze({ ...issue })),
    measurementHash: measurement.measurementHash,
  })
}

export function presentMulticamMatchPlan(plan: Readonly<MulticamMatchPlan>) {
  return Object.freeze({
    schemaVersion: plan.schemaVersion,
    planId: plan.planId,
    projectId: plan.projectId,
    sessionId: plan.sessionId,
    sessionVersion: plan.sessionVersion,
    referenceEpoch: plan.referenceEpoch,
    referenceCameraId: plan.referenceCameraId,
    referenceCameraSelection: Object.freeze({
      selectedBy: Object.freeze({
        kind: plan.referenceCameraSelection.selectedBy.kind,
        id: plan.referenceCameraSelection.selectedBy.id,
      }),
      selectedAt: plan.referenceCameraSelection.selectedAt,
      baseVersionId: plan.referenceCameraSelection.baseVersionId,
      baseHash: plan.referenceCameraSelection.baseHash,
    }),
    measurements: plan.measurements.map(presentMeasurementRef),
    cameraTransforms: plan.cameraTransforms.map(presentCameraTransform),
    rangeOverrides: plan.rangeOverrides.map(presentRangeOverride),
    confidence: plan.confidence,
    issues: plan.issues.map((issue) => Object.freeze({ ...issue })),
    // Ranges that measured different lighting conditions, named rather than
    // averaged into the fit.
    nonComparableRanges: plan.nonComparableRanges.map((range) => Object.freeze({
      cameraId: range.cameraId,
      measurementId: range.measurementId,
      range: presentInterval(range.range),
      reason: range.reason,
    })),
    humanReviewRequired: plan.humanReviewRequired,
    pipelineStage: plan.pipelineStage,
    lineage: Object.freeze({
      colorProbeIds: plan.lineage.colorProbeIds,
      compilationIds: plan.lineage.compilationIds ?? [],
      directionHash: plan.lineage.directionHash ?? null,
    }),
    dependsOn: Object.freeze({
      measurementIds: plan.dependsOn.measurementIds,
      referenceCameraId: plan.dependsOn.referenceCameraId,
    }),
    supersedes: plan.supersedes,
    createdAt: plan.createdAt,
    planHash: plan.planHash,
  })
}

export function presentMulticamMatchPlanRead(read: Readonly<MulticamMatchPlanRead>) {
  return Object.freeze({
    plan: presentMulticamMatchPlan(read.plan),
    version: read.version,
    previousVersionHash: read.previousVersionHash,
    versionRef: read.versionRef,
    isHead: read.isHead,
  })
}

function presentColorPlanWrite(write: Readonly<MulticamMatchColorPlanWrite>) {
  return Object.freeze({
    colorPlanId: write.colorPlanId,
    colorPlanHash: write.colorPlanHash,
    compiledManifestHash: write.compiledManifestHash,
    resultVersionId: write.resultVersionId,
    replayed: write.replayed,
    // Cameras the plan corrected that the current EditPlan does not cut to, and
    // layer keys the write dropped because the EditPlan no longer names them.
    // Reported rather than removed in silence: a dropped key can take a
    // transform of another kind with it.
    omittedCameraIds: write.omittedCameraIds,
    prunedCameraIds: write.prunedCameraIds,
    prunedSegmentIds: write.prunedSegmentIds,
  })
}

export function presentDerivedMatchPlan(result: Readonly<DeriveMulticamMatchPlanResult>) {
  return Object.freeze({
    plan: presentMulticamMatchPlan(result.plan),
    version: result.version,
    versionRef: `${result.plan.sessionId}:match:v${result.version}`,
    // A retry that measured the same bytes produced the same content-addressed
    // measurements and therefore the same plan: the first answer arriving
    // twice, not a second derivation.
    replayed: result.replayed,
    colorPlan: presentColorPlanWrite(result.colorPlan),
    // Advisory. Nothing here marks these stale; a superseded plan already names
    // its successor, and this says which readers should look again.
    invalidated: Object.freeze({
      matchPlanIds: result.invalidated.matchPlanIds,
      colorCriticReportIds: result.invalidated.colorCriticReportIds,
    }),
  })
}

export function presentMatchOverrideResult(result: Readonly<AddMulticamMatchRangeOverrideResult>) {
  return Object.freeze({
    plan: presentMulticamMatchPlan(result.plan),
    version: result.version,
    versionRef: `${result.plan.sessionId}:match:v${result.version}`,
    // True when the plan already carried this override id: the amendment is
    // already in force and nothing new is written.
    replayed: result.replayed,
    colorPlan: presentColorPlanWrite(result.colorPlan),
  })
}

// ---------------------------------------------------------------------------
// Colour critic
// ---------------------------------------------------------------------------

export function presentColorCriticIssue(issue: Readonly<ColorCriticIssue>) {
  return Object.freeze({
    code: issue.code,
    dimension: issue.dimension,
    severity: issue.severity,
    classification: issue.classification,
    cause: issue.cause,
    stage: issue.stage,
    cameraId: issue.cameraId,
    range: presentOptionalInterval(issue.range),
    // Null only where there is no number: an insufficient-evidence issue has
    // nothing measured, and a zero there would be a reading.
    measured: issue.measured,
    threshold: issue.threshold,
    thresholdVersion: issue.thresholdVersion,
    confidence: issue.confidence,
    evidenceRefs: issue.evidenceRefs,
  })
}

/**
 * One verdict, with the pairing that makes it checkable.
 *
 * `stagePairs` says which "before" reading was compared with which "after"
 * reading for which camera, so "the critic compared camera A with camera A" is
 * something a reader can verify instead of trust. The per-dimension readings of
 * each section stay in the measurement aggregate; the section publishes the
 * ids it read.
 */
export function presentColorCriticReport(report: Readonly<ColorCriticReport>) {
  return Object.freeze({
    schemaVersion: report.schemaVersion,
    reportId: report.reportId,
    projectId: report.projectId,
    projectVersionId: report.projectVersionId,
    subject: Object.freeze({
      kind: report.subject.kind,
      sourceAssetId: report.subject.sourceAssetId ?? null,
      cameraId: report.subject.cameraId ?? null,
      artifactId: report.subject.artifactId ?? null,
      range: presentOptionalInterval(report.subject.range ?? null),
    }),
    referenceCameraId: report.referenceCameraId,
    matchPlanId: report.matchPlanId,
    matchPlanHash: report.matchPlanHash,
    sections: report.sections.map((section) => Object.freeze({
      stage: section.stage,
      bytesEvaluated: section.bytesEvaluated.map((bytes) => Object.freeze({ ...bytes })),
      measurementIds: section.measurementIds,
    })),
    stagePairs: report.stagePairs.map((pair) => Object.freeze({ ...pair })),
    bytesEvaluated: report.bytesEvaluated.map((bytes) => Object.freeze({ ...bytes })),
    evaluators: report.evaluators.map((evaluator) => Object.freeze({ ...evaluator })),
    dimensions: report.dimensions.map((dimension) => Object.freeze({
      dimension: dimension.dimension,
      status: dimension.status,
      stage: dimension.stage,
      value: dimension.value ?? null,
      unit: dimension.unit ?? null,
      threshold: dimension.threshold ?? null,
      evaluatorIds: dimension.evaluatorIds ?? [],
      evidenceRefs: dimension.evidenceRefs ?? [],
      cameraIds: dimension.cameraIds ?? [],
      classification: dimension.classification ?? null,
      reason: dimension.reason ?? null,
    })),
    issues: report.issues.map(presentColorCriticIssue),
    creativeIntent: Object.freeze({
      declared: report.creativeIntent.declared,
      castAllowedDelta: report.creativeIntent.castAllowedDelta ?? null,
      lutId: report.creativeIntent.lutId ?? null,
      note: report.creativeIntent.note ?? null,
      brandColorsDeclared: report.creativeIntent.brandColorsDeclared ?? null,
    }),
    intentBounds: Object.freeze({
      castAllowedDelta: report.intentBounds.castAllowedDelta,
      maxDeclaredCastAllowance: report.intentBounds.maxDeclaredCastAllowance,
    }),
    cause: report.cause,
    action: report.action,
    boundedCorrection: report.boundedCorrection === null ? null : Object.freeze({
      iteration: report.boundedCorrection.iteration,
      maxIterations: report.boundedCorrection.maxIterations,
      proposedDeltas: report.boundedCorrection.proposedDeltas.map((delta) => Object.freeze({
        cameraId: delta.cameraId,
        exposureEv: delta.exposureEv,
        whiteBalance: delta.whiteBalance === null ? null : Object.freeze({ ...delta.whiteBalance }),
        saturation: delta.saturation,
      })),
      reason: report.boundedCorrection.reason,
    }),
    confidence: report.confidence,
    confidenceBand: report.confidenceBand,
    thresholds: Object.freeze({
      calibrationVersion: report.thresholds.calibrationVersion,
      values: Object.freeze(Object.fromEntries(COLOR_CRITIC_DIMENSIONS.map((dimension) => [
        dimension,
        Object.freeze({ ...report.thresholds.values[dimension] }),
      ]))),
    }),
    evaluatedAt: report.evaluatedAt,
    reportHash: report.reportHash,
  })
}

/** Enough of a verdict to pick which one to open. */
export function presentColorCriticReportSummary(report: Readonly<ColorCriticReport>) {
  return Object.freeze({
    reportId: report.reportId,
    projectVersionId: report.projectVersionId,
    action: report.action,
    cause: report.cause,
    confidence: report.confidence,
    confidenceBand: report.confidenceBand,
    referenceCameraId: report.referenceCameraId,
    matchPlanId: report.matchPlanId,
    hardIssues: report.issues.filter((issue) => issue.severity === 'hard').length,
    warningIssues: report.issues.filter((issue) => issue.severity === 'warning').length,
    evaluatedAt: report.evaluatedAt,
    reportHash: report.reportHash,
  })
}

export function presentColorCriticIssueListing(listing: Readonly<ColorCriticIssueListing>) {
  return Object.freeze({
    reportId: listing.reportId,
    projectId: listing.projectId,
    projectVersionId: listing.projectVersionId,
    action: listing.action,
    cause: listing.cause,
    referenceCameraId: listing.referenceCameraId,
    matchPlanId: listing.matchPlanId,
    evaluatedAt: listing.evaluatedAt,
    reportHash: listing.reportHash,
    issues: listing.issues.map(presentColorCriticIssue),
    // How many the filters removed. A narrowed list that reads like a clean
    // report is how "no hard issues" becomes "no issues".
    filteredOut: listing.filteredOut,
  })
}

/** The whole body of a `color-critic-reports.read` response. */
export function presentColorCriticReportResponse(report: Readonly<ColorCriticReport>) {
  return Object.freeze({ report: presentColorCriticReport(report) })
}

/**
 * The whole body of a `color-critic-reports.list` response.
 *
 * The two counters travel with the page because they are what a reader decides
 * with, and they are NOT derived from the page: the service counts them over
 * the window the evaluator counts over, so the answer does not move when the
 * caller changes `limit`. Presented here rather than assembled in the route so
 * the published example and the emitted body cannot drift apart.
 */
export function presentColorCriticReportListing(listing: Readonly<{
  reports: readonly Readonly<ColorCriticReport>[]
  correctionsApplied: number
  correctionBudgetExhausted: boolean
}>) {
  return Object.freeze({
    reports: listing.reports.map(presentColorCriticReportSummary),
    correctionsApplied: listing.correctionsApplied,
    correctionBudgetExhausted: listing.correctionBudgetExhausted,
  })
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface ParsedDeriveMatchPlanBody {
  readonly referenceCameraId: string
  readonly baseVersionId: string
  readonly baseHash: string
  readonly projectBaseVersionId: string
  readonly projectBaseHash: string
  readonly note?: string
}

/**
 * Two fences, both named by the caller.
 *
 * The reference camera was chosen while looking at one exact capture-session
 * version, and the ColorPlan layers this derivation writes have to land on one
 * exact project version. Neither can stand in for the other: a session that
 * moved means the cameras changed, a project that moved means the cut did.
 */
export function parseDeriveMatchPlanBody(raw: unknown): ParsedDeriveMatchPlanBody {
  const body = record(raw, 'body')
  exactFields(
    body,
    ['referenceCameraId', 'baseVersionId', 'baseHash', 'projectBaseVersionId', 'projectBaseHash', 'note'],
    'body',
  )
  return Object.freeze({
    referenceCameraId: token(body.referenceCameraId, 'referenceCameraId'),
    baseVersionId: identifier(body.baseVersionId, 'baseVersionId'),
    baseHash: sha256(body.baseHash, 'baseHash'),
    projectBaseVersionId: identifier(body.projectBaseVersionId, 'projectBaseVersionId'),
    projectBaseHash: sha256(body.projectBaseHash, 'projectBaseHash'),
    ...(body.note === undefined ? {} : { note: text(body.note, 'note', 400) }),
  })
}

export interface ParsedMatchRangeOverrideBody {
  readonly baseVersionId: string
  readonly baseHash: string
  readonly projectBaseVersionId: string
  readonly projectBaseHash: string
  readonly override: Readonly<{
    overrideId: string
    cameraId: string
    segmentId?: string
    range?: Readonly<{ start: bigint; end: bigint }>
    parameters: Readonly<{
      brightness: number
      contrast: number
      saturation: number
      gains?: Readonly<{ redGain: number; greenGain: number; blueGain: number }>
    }>
    reason: string
  }>
}

const OVERRIDE_KEYS = Object.freeze([
  'overrideId',
  'cameraId',
  'segmentId',
  'range',
  'parameters',
  'reason',
] as const)
const PARAMETER_KEYS = Object.freeze(['brightness', 'contrast', 'saturation', 'gains'] as const)
const GAIN_KEYS = Object.freeze(['redGain', 'greenGain', 'blueGain'] as const)

export function parseMatchRangeOverrideBody(raw: unknown): ParsedMatchRangeOverrideBody {
  const body = record(raw, 'body')
  exactFields(
    body,
    ['baseVersionId', 'baseHash', 'projectBaseVersionId', 'projectBaseHash', 'override'],
    'body',
  )
  const override = record(body.override, 'override')
  exactFields(override, OVERRIDE_KEYS, 'override')
  const parameters = record(override.parameters, 'override.parameters')
  exactFields(parameters, PARAMETER_KEYS, 'override.parameters')
  let range: Readonly<{ start: bigint; end: bigint }> | undefined
  if (override.range !== undefined) {
    const raw = record(override.range, 'override.range')
    exactFields(raw, ['start', 'end'], 'override.range')
    const start = tick(raw.start, 'override.range.start')
    const end = tick(raw.end, 'override.range.end')
    if (start >= end) {
      throw new DomainError('INVALID_ARGUMENT', 'override.range.start must be before override.range.end')
    }
    range = Object.freeze({ start, end })
  }
  let gains: Readonly<{ redGain: number; greenGain: number; blueGain: number }> | undefined
  if (parameters.gains !== undefined) {
    const rawGains = record(parameters.gains, 'override.parameters.gains')
    exactFields(rawGains, GAIN_KEYS, 'override.parameters.gains')
    gains = Object.freeze({
      redGain: boundedNumber(rawGains.redGain, 'override.parameters.gains.redGain', 0.25, 4),
      greenGain: boundedNumber(rawGains.greenGain, 'override.parameters.gains.greenGain', 0.25, 4),
      blueGain: boundedNumber(rawGains.blueGain, 'override.parameters.gains.blueGain', 0.25, 4),
    })
  }
  return Object.freeze({
    baseVersionId: identifier(body.baseVersionId, 'baseVersionId'),
    baseHash: sha256(body.baseHash, 'baseHash'),
    projectBaseVersionId: identifier(body.projectBaseVersionId, 'projectBaseVersionId'),
    projectBaseHash: sha256(body.projectBaseHash, 'projectBaseHash'),
    override: Object.freeze({
      overrideId: identifier(override.overrideId, 'override.overrideId'),
      cameraId: token(override.cameraId, 'override.cameraId'),
      ...(override.segmentId === undefined
        ? {}
        : { segmentId: token(override.segmentId, 'override.segmentId') }),
      ...(range === undefined ? {} : { range }),
      // The one place a colour number is the caller's: an operator's local
      // correction. The domain bounds each before it becomes a transform, and
      // the bounds here are the wider outer guard rails so a typo is a 422
      // rather than a stack trace out of the hasher.
      parameters: Object.freeze({
        brightness: boundedNumber(parameters.brightness, 'override.parameters.brightness', -1, 1),
        contrast: boundedNumber(parameters.contrast, 'override.parameters.contrast', 0, 4),
        saturation: boundedNumber(parameters.saturation, 'override.parameters.saturation', 0, 4),
        ...(gains === undefined ? {} : { gains }),
      }),
      reason: text(override.reason, 'override.reason', 400),
    }),
  })
}

/** The two filters the issue listing accepts, parsed off the query string. */
export function parseIssueSeverity(value: string | null) {
  return value === null ? undefined : member(value, COLOR_CRITIC_SEVERITIES, 'severity')
}

export function parseIssueDimension(value: string | null) {
  return value === null ? undefined : member(value, COLOR_CRITIC_DIMENSIONS, 'dimension')
}
