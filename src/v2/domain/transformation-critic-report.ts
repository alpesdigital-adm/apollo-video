import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import type { TransformationPreserve } from './transformation-brief.ts'

/**
 * The transformation critic (FR-116).
 *
 * This is not the synthetic presenter critic from Wave 14. That one asks
 * "did this avatar speak this script well"; this one asks "did this
 * transformation change only what it was allowed to change". They share the
 * shape of honest evidence — a dimension either was measured, or is not
 * applicable, or is unavailable, and silence is never a pass — and nothing
 * else.
 *
 * The rule that gives this critic its purpose: **a protected-content violation
 * is a hard gate and cannot be compensated.** A result that changed the
 * subject's face is rejected at any aesthetic score, because the thing it got
 * wrong is the thing the brief existed to protect.
 */

export const TRANSFORMATION_CRITIC_REPORT_VERSION = 'transformation-critic-report/v1' as const

export const TRANSFORMATION_CRITIC_DIMENSIONS = [
  'intent-adherence',
  'preserve-list',
  'identity',
  'lip-sync',
  'temporal-coherence',
  'flicker',
  'warping',
  'anatomy',
  'composite-edges',
  'composite-light',
  'transitions',
  'format-safe-areas',
  'risk',
  'media-integrity',
] as const
export type TransformationCriticDimension = (typeof TRANSFORMATION_CRITIC_DIMENSIONS)[number]

/**
 * Dimensions that must always answer with a measurement. Everything else may be
 * `not-applicable` when the material genuinely does not contain it — a cutaway
 * with no person has no identity to preserve — but these four are facts about
 * any transformation result whatsoever.
 */
export const MANDATORY_TRANSFORMATION_CRITIC_DIMENSIONS = [
  'intent-adherence',
  'preserve-list',
  'media-integrity',
  'risk',
] as const satisfies readonly TransformationCriticDimension[]

export const TRANSFORMATION_CRITIC_STATUSES = ['measured', 'not-applicable', 'unavailable'] as const
export type TransformationCriticStatus = (typeof TRANSFORMATION_CRITIC_STATUSES)[number]

/**
 * What an evaluator actually is. `measured` means a real probe read the bytes —
 * ffprobe, a frame differ, a pixel comparison. `controlled` means a
 * deterministic stand-in for a perceptual model that is not deployed. The
 * distinction is written into every report because calling a controlled
 * detector a production visual evaluation would be a lie with a number
 * attached.
 */
export const TRANSFORMATION_EVALUATOR_KINDS = ['measured', 'controlled'] as const
export type TransformationEvaluatorKind = (typeof TRANSFORMATION_EVALUATOR_KINDS)[number]

export const TRANSFORMATION_CRITIC_ACTIONS = ['approve', 'retry', 'fallback', 'review'] as const
export type TransformationCriticAction = (typeof TRANSFORMATION_CRITIC_ACTIONS)[number]

export const TRANSFORMATION_CRITIC_DECISIONS = ['approved', 'rejected', 'needs-review', 'evidence-unavailable'] as const
export type TransformationCriticDecision = (typeof TRANSFORMATION_CRITIC_DECISIONS)[number]

export interface TransformationCriticEvaluator {
  id: string
  kind: TransformationEvaluatorKind
  version: string
  /** What this evaluator can and cannot speak to, in plain words. */
  scope: string
}

export interface TransformationCriticRegion {
  x: number
  y: number
  width: number
  height: number
}

export interface TransformationCriticMeasurement {
  dimension: TransformationCriticDimension
  status: TransformationCriticStatus
  evaluatorId?: string
  /** Basis points. Null unless the dimension was actually measured. */
  scoreBps: number | null
  thresholdBps: number | null
  /** Frame range the measurement covers. Null when the whole result is covered. */
  frameRange: Readonly<{ startFrame: number; endFrame: number }> | null
  region: Readonly<TransformationCriticRegion> | null
  /** Why this dimension is unavailable or not applicable. Required when it is. */
  note?: string
}

export interface TransformationCriticIssue {
  dimension: TransformationCriticDimension
  severity: 'blocking' | 'major' | 'minor'
  frameRange: Readonly<{ startFrame: number; endFrame: number }>
  region: Readonly<TransformationCriticRegion> | null
  /** The preserve entry this issue violates, when it violates one. */
  violatedPreserve?: TransformationPreserve
  description: string
}

export interface TransformationCriticReport {
  schemaVersion: typeof TRANSFORMATION_CRITIC_REPORT_VERSION
  id: string
  workspaceId: string
  projectId: string
  briefId: string
  briefHash: string
  providerJobId: string
  policyId: string
  policyHash: string
  sourceArtifactId: string
  sourceArtifactSha256: string
  resultArtifactId: string
  resultArtifactSha256: string
  evaluators: readonly Readonly<TransformationCriticEvaluator>[]
  measurements: readonly Readonly<TransformationCriticMeasurement>[]
  issues: readonly Readonly<TransformationCriticIssue>[]
  /** Hard gates that fired. A non-empty list can only mean rejection. */
  hardGates: readonly TransformationCriticDimension[]
  decision: TransformationCriticDecision
  action: TransformationCriticAction
  /** Overall confidence in basis points, or null when nothing produced one. */
  confidenceBps: number | null
  intentScoreBps: number | null
  evaluatedAt: string
  reportHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/

function id(value: string, field: string): string {
  assertDomain(typeof value === 'string' && ID.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  return value
}

function hash(value: string, field: string): string {
  assertDomain(typeof value === 'string' && HASH.test(value), 'INVALID_ARGUMENT', `${field} must be a lowercase SHA-256`)
  return value
}

function instant(value: string, field: string): string {
  assertDomain(
    typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value,
    'INVALID_ARGUMENT',
    `${field} must be a canonical ISO instant`,
  )
  return value
}

function assertRegion(region: Readonly<TransformationCriticRegion>, field: string): void {
  assertDomain(
    [region.x, region.y, region.width, region.height].every((value) => Number.isFinite(value) && value >= 0 && value <= 1) &&
      region.width > 0 && region.height > 0 && region.x + region.width <= 1 && region.y + region.height <= 1,
    'INVALID_ARGUMENT',
    `${field} must be inside normalized bounds`,
  )
}

function assertMeasurement(
  measurement: Readonly<TransformationCriticMeasurement>,
  evaluators: ReadonlySet<string>,
): void {
  assertDomain(TRANSFORMATION_CRITIC_DIMENSIONS.includes(measurement.dimension), 'INVALID_ARGUMENT', 'Unknown critic dimension')
  assertDomain(TRANSFORMATION_CRITIC_STATUSES.includes(measurement.status), 'INVALID_ARGUMENT', 'Unknown measurement status')
  if (measurement.status === 'measured') {
    // A measurement without an evaluator is an opinion. Naming who measured it
    // is what lets a reader weigh it later.
    assertDomain(
      Boolean(measurement.evaluatorId && evaluators.has(measurement.evaluatorId)),
      'INVALID_ARGUMENT',
      'A measured dimension must name a declared evaluator',
    )
    assertDomain(
      Number.isSafeInteger(measurement.scoreBps) && measurement.scoreBps! >= 0 && measurement.scoreBps! <= 10_000,
      'INVALID_ARGUMENT',
      'A measured dimension must carry a score in basis points',
    )
    assertDomain(
      Number.isSafeInteger(measurement.thresholdBps) && measurement.thresholdBps! >= 0 && measurement.thresholdBps! <= 10_000,
      'INVALID_ARGUMENT',
      'A measured dimension must carry the threshold it was judged against',
    )
  } else {
    // Silence is not a pass. A dimension that could not be measured has to say
    // why, in words, or the report is claiming knowledge it does not have.
    assertDomain(
      measurement.scoreBps === null && measurement.thresholdBps === null,
      'INVALID_ARGUMENT',
      'A dimension that was not measured cannot carry a score',
    )
    assertDomain(
      typeof measurement.note === 'string' && measurement.note.trim().length >= 10,
      'INVALID_ARGUMENT',
      'A not-applicable or unavailable dimension must explain itself',
    )
  }
  if (measurement.frameRange) {
    assertDomain(
      Number.isSafeInteger(measurement.frameRange.startFrame) && measurement.frameRange.startFrame >= 0 &&
        Number.isSafeInteger(measurement.frameRange.endFrame) && measurement.frameRange.endFrame > measurement.frameRange.startFrame,
      'INVALID_ARGUMENT',
      'measurement frameRange must be a non-empty forward range',
    )
  }
  if (measurement.region) assertRegion(measurement.region, `${measurement.dimension}.region`)
}

export function createTransformationCriticReport(input: Omit<TransformationCriticReport, 'schemaVersion' | 'id' | 'reportHash'>): Readonly<TransformationCriticReport> {
  assertDomain(input.evaluators.length > 0, 'INVALID_ARGUMENT', 'A report must declare who evaluated it')
  const evaluatorIds = new Set<string>()
  for (const evaluator of input.evaluators) {
    id(evaluator.id, 'evaluator.id')
    assertDomain(TRANSFORMATION_EVALUATOR_KINDS.includes(evaluator.kind), 'INVALID_ARGUMENT', 'Unknown evaluator kind')
    assertDomain(
      evaluator.scope.trim().length >= 10,
      'INVALID_ARGUMENT',
      'An evaluator must state what it can and cannot speak to',
    )
    assertDomain(!evaluatorIds.has(evaluator.id), 'INVALID_ARGUMENT', 'Duplicate evaluator id')
    evaluatorIds.add(evaluator.id)
  }

  const seen = new Set<TransformationCriticDimension>()
  for (const measurement of input.measurements) {
    assertMeasurement(measurement, evaluatorIds)
    assertDomain(!seen.has(measurement.dimension), 'INVALID_ARGUMENT', 'A dimension may only be answered once')
    seen.add(measurement.dimension)
  }
  // Every dimension answers. An absent dimension is not "fine", it is unknown,
  // and a report that omits it is claiming a completeness it does not have.
  for (const dimension of TRANSFORMATION_CRITIC_DIMENSIONS) {
    assertDomain(seen.has(dimension), 'INVALID_ARGUMENT', `Dimension ${dimension} was not answered`)
  }

  const byDimension = new Map(input.measurements.map((measurement) => [measurement.dimension, measurement]))
  // Fail closed: a mandatory dimension with no evidence cannot produce an
  // approval, whatever the other numbers say.
  const missingMandatory = MANDATORY_TRANSFORMATION_CRITIC_DIMENSIONS
    .filter((dimension) => byDimension.get(dimension)!.status !== 'measured')

  for (const issue of input.issues) {
    assertDomain(TRANSFORMATION_CRITIC_DIMENSIONS.includes(issue.dimension), 'INVALID_ARGUMENT', 'Unknown issue dimension')
    assertDomain(
      Number.isSafeInteger(issue.frameRange.startFrame) && issue.frameRange.startFrame >= 0 &&
        Number.isSafeInteger(issue.frameRange.endFrame) && issue.frameRange.endFrame > issue.frameRange.startFrame,
      'INVALID_ARGUMENT',
      'An issue must be localized to a non-empty frame range',
    )
    if (issue.region) assertRegion(issue.region, 'issue.region')
    assertDomain(issue.description.trim().length >= 10, 'INVALID_ARGUMENT', 'An issue must describe itself')
  }

  const hardGates = Object.freeze([...new Set(input.hardGates)].toSorted())
  for (const gate of hardGates) {
    assertDomain(TRANSFORMATION_CRITIC_DIMENSIONS.includes(gate), 'INVALID_ARGUMENT', 'Unknown hard gate dimension')
    assertDomain(
      input.issues.some((issue) => issue.dimension === gate && issue.severity === 'blocking'),
      'INVALID_ARGUMENT',
      'A hard gate must be backed by a blocking issue that localizes it',
    )
  }

  // The rule this critic exists for. A protected-content violation cannot be
  // outvoted by aesthetics.
  assertDomain(
    hardGates.length === 0 || input.decision === 'rejected',
    'INVALID_ARGUMENT',
    'A report with a hard gate can only be a rejection; visual quality does not buy back protected content',
  )
  assertDomain(
    missingMandatory.length === 0 || input.decision === 'evidence-unavailable',
    'INVALID_ARGUMENT',
    `Mandatory dimensions without evidence (${missingMandatory.join(', ')}) can only produce evidence-unavailable`,
  )
  assertDomain(
    input.decision !== 'approved' || input.action === 'approve',
    'INVALID_ARGUMENT',
    'An approval cannot recommend doing something else',
  )
  assertDomain(
    input.decision !== 'evidence-unavailable' || input.action === 'review',
    'INVALID_ARGUMENT',
    'Missing evidence is a question for a human, never an automatic retry',
  )
  assertDomain(
    input.decision !== 'approved' || input.issues.every((issue) => issue.severity !== 'blocking'),
    'INVALID_ARGUMENT',
    'An approval cannot carry a blocking issue',
  )
  if (input.confidenceBps !== null) {
    assertDomain(
      Number.isSafeInteger(input.confidenceBps) && input.confidenceBps >= 0 && input.confidenceBps <= 10_000,
      'INVALID_ARGUMENT',
      'confidenceBps must be basis points',
    )
  }
  if (input.intentScoreBps !== null) {
    assertDomain(
      Number.isSafeInteger(input.intentScoreBps) && input.intentScoreBps >= 0 && input.intentScoreBps <= 10_000,
      'INVALID_ARGUMENT',
      'intentScoreBps must be basis points',
    )
  }

  const body = Object.freeze({
    schemaVersion: TRANSFORMATION_CRITIC_REPORT_VERSION,
    workspaceId: id(input.workspaceId, 'workspaceId'),
    projectId: id(input.projectId, 'projectId'),
    briefId: id(input.briefId, 'briefId'),
    briefHash: hash(input.briefHash, 'briefHash'),
    providerJobId: id(input.providerJobId, 'providerJobId'),
    policyId: id(input.policyId, 'policyId'),
    policyHash: hash(input.policyHash, 'policyHash'),
    sourceArtifactId: id(input.sourceArtifactId, 'sourceArtifactId'),
    sourceArtifactSha256: hash(input.sourceArtifactSha256, 'sourceArtifactSha256'),
    resultArtifactId: id(input.resultArtifactId, 'resultArtifactId'),
    resultArtifactSha256: hash(input.resultArtifactSha256, 'resultArtifactSha256'),
    evaluators: Object.freeze(input.evaluators.map((evaluator) => Object.freeze({ ...evaluator }))),
    measurements: Object.freeze(
      TRANSFORMATION_CRITIC_DIMENSIONS.map((dimension) => Object.freeze({ ...byDimension.get(dimension)! })),
    ),
    issues: Object.freeze(input.issues.map((issue) => Object.freeze({ ...issue }))),
    hardGates,
    decision: input.decision,
    action: input.action,
    confidenceBps: input.confidenceBps,
    intentScoreBps: input.intentScoreBps,
    evaluatedAt: instant(input.evaluatedAt, 'evaluatedAt'),
  })
  const reportHash = calculateCanonicalHash(body)
  return Object.freeze({ ...body, id: `transformation-critic-${reportHash.slice(0, 32)}`, reportHash })
}

export function assertTransformationCriticReport(report: Readonly<TransformationCriticReport>): Readonly<TransformationCriticReport> {
  assertDomain(report.schemaVersion === TRANSFORMATION_CRITIC_REPORT_VERSION, 'PERSISTENCE_CONFLICT', 'Stored transformation critic schema is invalid')
  const { id: reportId, reportHash, ...body } = report
  assertDomain(calculateCanonicalHash(body) === reportHash, 'PERSISTENCE_CONFLICT', 'Stored transformation critic hash does not match its body')
  assertDomain(reportId === `transformation-critic-${reportHash.slice(0, 32)}`, 'PERSISTENCE_CONFLICT', 'Stored transformation critic id does not match its hash')
  return report
}

/**
 * Whether this report permits the result to be used.
 *
 * `evidence-unavailable` is not approval. That has to be said explicitly,
 * because a truthy check on "no rejection" would quietly treat "we could not
 * tell" as "it is fine".
 */
export function isTransformationApproval(report: Readonly<TransformationCriticReport>): boolean {
  return report.decision === 'approved'
}

/** Did this report reject specifically because protected content changed? */
export function rejectedProtectedContent(report: Readonly<TransformationCriticReport>): boolean {
  return report.hardGates.includes('preserve-list') || report.hardGates.includes('identity')
}
