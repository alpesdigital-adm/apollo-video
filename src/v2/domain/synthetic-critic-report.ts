import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'

export const SYNTHETIC_CRITIC_REPORT_SCHEMA_VERSION = 'synthetic-critic-report/v1' as const

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/

/**
 * The dimensions a synthetic result is judged on. Every report carries an entry
 * for each one — silence is not an answer — and each entry states whether it
 * was actually measured, does not apply, or could not be evaluated.
 */
export const SYNTHETIC_CRITIC_DIMENSIONS = Object.freeze([
  'lip-sync',
  'identity',
  'pronunciation',
  'visual-artifacts',
  'framing',
  'continuity',
  'eyes',
  'teeth',
  'hands',
  'temporal-integrity',
  'audiovisual-integrity',
] as const)
export type SyntheticCriticDimension = (typeof SYNTHETIC_CRITIC_DIMENSIONS)[number]

export const SYNTHETIC_CRITIC_MEASUREMENT_STATUSES = Object.freeze([
  'measured',
  'not-applicable',
  'unavailable',
] as const)
export type SyntheticCriticMeasurementStatus = (typeof SYNTHETIC_CRITIC_MEASUREMENT_STATUSES)[number]

/**
 * How much a verdict is worth. `measured` means an instrument produced the
 * number from the artifact itself; `controlled` means a named, deterministic
 * evaluator stood in for a perceptual model that is not deployed. A controlled
 * evaluator is never reported as production visual validation — the kind
 * travels with every report so a reader can tell them apart.
 */
export const SYNTHETIC_CRITIC_EVALUATOR_KINDS = Object.freeze(['measured', 'controlled'] as const)
export type SyntheticCriticEvaluatorKind = (typeof SYNTHETIC_CRITIC_EVALUATOR_KINDS)[number]

export const SYNTHETIC_CRITIC_DECISIONS = Object.freeze([
  'approved',
  'rejected',
  'needs-review',
  'evidence-unavailable',
] as const)
export type SyntheticCriticDecision = (typeof SYNTHETIC_CRITIC_DECISIONS)[number]

export const SYNTHETIC_CRITIC_ACTIONS = Object.freeze(['retry', 'fallback', 'manual-review', 'none'] as const)
export type SyntheticCriticAction = (typeof SYNTHETIC_CRITIC_ACTIONS)[number]

export const SYNTHETIC_CRITIC_SEVERITIES = Object.freeze(['blocking', 'major', 'minor'] as const)
export type SyntheticCriticSeverity = (typeof SYNTHETIC_CRITIC_SEVERITIES)[number]

export interface SyntheticCriticRange {
  startMs: number
  endMs: number
}

export interface SyntheticCriticEvaluator {
  id: string
  version: string
  kind: SyntheticCriticEvaluatorKind
  /** What the evaluator can and cannot answer, in the report itself. */
  scope: string
}

export interface SyntheticCriticMeasurement {
  dimension: SyntheticCriticDimension
  status: SyntheticCriticMeasurementStatus
  evaluatorId: string | null
  value: number | null
  unit: string | null
  threshold: number | null
  confidence: number | null
  evidenceRefs: readonly string[]
  range: Readonly<SyntheticCriticRange> | null
  /** Why a dimension is unavailable or not applicable, in plain words. */
  note: string | null
}

export interface SyntheticCriticIssue {
  blockId: string
  dimension: SyntheticCriticDimension
  severity: SyntheticCriticSeverity
  range: Readonly<SyntheticCriticRange> | null
  evidence: string
  action: Exclude<SyntheticCriticAction, 'none'>
}

export interface SyntheticCriticReport {
  schemaVersion: typeof SYNTHETIC_CRITIC_REPORT_SCHEMA_VERSION
  id: string
  workspaceId: string
  projectId: string
  blockId: string
  capability: string
  adapterId: string
  adapterVersion: string
  /** Exactly which bytes were judged. */
  artifactId: string
  artifactSha256: string
  audioArtifactId: string | null
  alignmentArtifactId: string | null
  scriptHash: string
  profileSnapshotId: string
  expectedIdentityRef: string
  evaluators: readonly Readonly<SyntheticCriticEvaluator>[]
  measurements: readonly Readonly<SyntheticCriticMeasurement>[]
  issues: readonly Readonly<SyntheticCriticIssue>[]
  decision: SyntheticCriticDecision
  recommendedAction: SyntheticCriticAction
  thresholdsVersion: string
  decidedAt: string
  reportHash: string
}

function instant(value: string, field: string): string {
  assertDomain(
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
    'INVALID_ARGUMENT',
    `${field} must be a canonical ISO instant`,
  )
  return value
}

function assertRange(range: Readonly<SyntheticCriticRange> | null, field: string): Readonly<SyntheticCriticRange> | null {
  if (range === null) return null
  assertDomain(
    Number.isSafeInteger(range.startMs) && range.startMs >= 0 &&
      Number.isSafeInteger(range.endMs) && range.endMs > range.startMs,
    'INVALID_ARGUMENT',
    `${field} must be a half-open millisecond range`,
  )
  return Object.freeze({ startMs: range.startMs, endMs: range.endMs })
}

function assertMeasurements(
  measurements: readonly Readonly<SyntheticCriticMeasurement>[],
  evaluators: readonly Readonly<SyntheticCriticEvaluator>[],
): readonly Readonly<SyntheticCriticMeasurement>[] {
  const byDimension = new Map<SyntheticCriticDimension, Readonly<SyntheticCriticMeasurement>>()
  const evaluatorIds = new Set(evaluators.map((evaluator) => evaluator.id))
  for (const measurement of measurements) {
    assertDomain(
      SYNTHETIC_CRITIC_DIMENSIONS.includes(measurement.dimension),
      'INVALID_ARGUMENT',
      `critic dimension ${measurement.dimension} is unknown`,
    )
    assertDomain(!byDimension.has(measurement.dimension), 'INVALID_ARGUMENT', `critic dimension ${measurement.dimension} is duplicated`)
    assertDomain(
      SYNTHETIC_CRITIC_MEASUREMENT_STATUSES.includes(measurement.status),
      'INVALID_ARGUMENT',
      `critic measurement status ${measurement.status} is invalid`,
    )
    if (measurement.status === 'measured') {
      // A measured dimension must name the instrument, the number, its unit
      // and the evidence. Anything less is a score without a measurement.
      assertDomain(
        measurement.evaluatorId !== null && evaluatorIds.has(measurement.evaluatorId),
        'INVALID_ARGUMENT',
        `measured dimension ${measurement.dimension} must name an evaluator listed in the report`,
      )
      assertDomain(
        typeof measurement.value === 'number' && Number.isFinite(measurement.value),
        'INVALID_ARGUMENT',
        `measured dimension ${measurement.dimension} must carry a finite value`,
      )
      assertDomain(
        typeof measurement.unit === 'string' && measurement.unit.trim().length > 0,
        'INVALID_ARGUMENT',
        `measured dimension ${measurement.dimension} must carry a unit`,
      )
      assertDomain(
        measurement.evidenceRefs.length > 0,
        'INVALID_ARGUMENT',
        `measured dimension ${measurement.dimension} must reference its evidence`,
      )
    } else {
      // Nothing was measured, so nothing may look like a measurement.
      assertDomain(
        measurement.value === null && measurement.confidence === null,
        'INVALID_ARGUMENT',
        `dimension ${measurement.dimension} is ${measurement.status} and must not carry a fabricated value`,
      )
      assertDomain(
        typeof measurement.note === 'string' && measurement.note.trim().length > 0,
        'INVALID_ARGUMENT',
        `dimension ${measurement.dimension} is ${measurement.status} and must say why`,
      )
    }
    assertDomain(
      measurement.confidence === null || (measurement.confidence >= 0 && measurement.confidence <= 1),
      'INVALID_ARGUMENT',
      `critic confidence for ${measurement.dimension} must be between 0 and 1`,
    )
    byDimension.set(
      measurement.dimension,
      Object.freeze({
        ...measurement,
        evidenceRefs: Object.freeze([...measurement.evidenceRefs]),
        range: assertRange(measurement.range, `measurement.${measurement.dimension}.range`),
      }),
    )
  }
  for (const dimension of SYNTHETIC_CRITIC_DIMENSIONS) {
    assertDomain(
      byDimension.has(dimension),
      'INVALID_ARGUMENT',
      `critic report is silent about ${dimension}; every dimension must state measured, not-applicable or unavailable`,
    )
  }
  return Object.freeze(SYNTHETIC_CRITIC_DIMENSIONS.map((dimension) => byDimension.get(dimension)!))
}

export function calculateSyntheticCriticReportHash(report: Omit<SyntheticCriticReport, 'reportHash'>): string {
  return calculateCanonicalHash({
    schemaVersion: report.schemaVersion,
    id: report.id,
    workspaceId: report.workspaceId,
    projectId: report.projectId,
    blockId: report.blockId,
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
    evaluators: report.evaluators.map((evaluator) => ({ ...evaluator })),
    measurements: report.measurements.map((measurement) => ({
      ...measurement,
      evidenceRefs: [...measurement.evidenceRefs],
      range: measurement.range ? { ...measurement.range } : null,
    })),
    issues: report.issues.map((issue) => ({ ...issue, range: issue.range ? { ...issue.range } : null })),
    decision: report.decision,
    recommendedAction: report.recommendedAction,
    thresholdsVersion: report.thresholdsVersion,
    decidedAt: report.decidedAt,
  })
}

export function createSyntheticCriticReport(
  input: Omit<SyntheticCriticReport, 'schemaVersion' | 'reportHash'>,
): Readonly<SyntheticCriticReport> {
  for (const [field, value] of Object.entries({
    id: input.id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    blockId: input.blockId,
    artifactId: input.artifactId,
    profileSnapshotId: input.profileSnapshotId,
    adapterId: input.adapterId,
    adapterVersion: input.adapterVersion,
    capability: input.capability,
  })) {
    assertDomain(ID.test(value), 'INVALID_ARGUMENT', `report.${field} is invalid`)
  }
  assertDomain(HASH.test(input.artifactSha256), 'INVALID_ARGUMENT', 'report.artifactSha256 is invalid')
  assertDomain(HASH.test(input.scriptHash), 'INVALID_ARGUMENT', 'report.scriptHash is invalid')
  assertDomain(
    input.audioArtifactId === null || ID.test(input.audioArtifactId),
    'INVALID_ARGUMENT',
    'report.audioArtifactId is invalid',
  )
  assertDomain(
    input.alignmentArtifactId === null || ID.test(input.alignmentArtifactId),
    'INVALID_ARGUMENT',
    'report.alignmentArtifactId is invalid',
  )
  assertDomain(input.expectedIdentityRef.trim().length > 0, 'INVALID_ARGUMENT', 'report.expectedIdentityRef is required')
  assertDomain(input.thresholdsVersion.trim().length > 0, 'INVALID_ARGUMENT', 'report.thresholdsVersion is required')
  assertDomain(input.evaluators.length > 0, 'INVALID_ARGUMENT', 'report.evaluators is required')
  for (const evaluator of input.evaluators) {
    assertDomain(ID.test(evaluator.id), 'INVALID_ARGUMENT', 'report evaluator id is invalid')
    assertDomain(evaluator.version.trim().length > 0, 'INVALID_ARGUMENT', 'report evaluator version is required')
    assertDomain(
      SYNTHETIC_CRITIC_EVALUATOR_KINDS.includes(evaluator.kind),
      'INVALID_ARGUMENT',
      'report evaluator kind must say whether it measured or stood in',
    )
    assertDomain(evaluator.scope.trim().length > 0, 'INVALID_ARGUMENT', 'report evaluator scope is required')
  }

  const measurements = assertMeasurements(input.measurements, input.evaluators)

  const issues = Object.freeze(input.issues.map((issue) => {
    assertDomain(ID.test(issue.blockId), 'INVALID_ARGUMENT', 'issue.blockId is invalid')
    assertDomain(
      SYNTHETIC_CRITIC_DIMENSIONS.includes(issue.dimension),
      'INVALID_ARGUMENT',
      `issue dimension ${issue.dimension} is unknown`,
    )
    assertDomain(
      SYNTHETIC_CRITIC_SEVERITIES.includes(issue.severity),
      'INVALID_ARGUMENT',
      'issue.severity is invalid',
    )
    assertDomain(
      issue.action === 'retry' || issue.action === 'fallback' || issue.action === 'manual-review',
      'INVALID_ARGUMENT',
      'issue.action must be retry, fallback or manual-review',
    )
    assertDomain(issue.evidence.trim().length > 0, 'INVALID_ARGUMENT', 'issue.evidence is required')
    return Object.freeze({ ...issue, range: assertRange(issue.range, 'issue.range') })
  }))

  assertDomain(
    SYNTHETIC_CRITIC_DECISIONS.includes(input.decision),
    'INVALID_ARGUMENT',
    'report.decision is invalid',
  )
  assertDomain(
    SYNTHETIC_CRITIC_ACTIONS.includes(input.recommendedAction),
    'INVALID_ARGUMENT',
    'report.recommendedAction is invalid',
  )

  // An approval must be clean: no blocking issue, and nothing merely unknown.
  const blocking = issues.filter((issue) => issue.severity === 'blocking')
  if (input.decision === 'approved') {
    assertDomain(blocking.length === 0, 'INVALID_ARGUMENT', 'an approved report cannot carry a blocking issue')
    assertDomain(
      input.recommendedAction === 'none',
      'INVALID_ARGUMENT',
      'an approved report cannot recommend an action',
    )
  } else {
    assertDomain(
      input.recommendedAction !== 'none',
      'INVALID_ARGUMENT',
      'a report that is not approved must recommend what to do',
    )
  }
  if (input.decision === 'rejected') {
    assertDomain(issues.length > 0, 'INVALID_ARGUMENT', 'a rejected report must localize at least one issue')
  }
  if (input.decision === 'evidence-unavailable') {
    assertDomain(
      measurements.some((measurement) => measurement.status === 'unavailable'),
      'INVALID_ARGUMENT',
      'evidence-unavailable must point at the dimension that could not be evaluated',
    )
  }

  const body: Omit<SyntheticCriticReport, 'reportHash'> = {
    schemaVersion: SYNTHETIC_CRITIC_REPORT_SCHEMA_VERSION,
    id: input.id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    blockId: input.blockId,
    capability: input.capability,
    adapterId: input.adapterId,
    adapterVersion: input.adapterVersion,
    artifactId: input.artifactId,
    artifactSha256: input.artifactSha256,
    audioArtifactId: input.audioArtifactId,
    alignmentArtifactId: input.alignmentArtifactId,
    scriptHash: input.scriptHash,
    profileSnapshotId: input.profileSnapshotId,
    expectedIdentityRef: input.expectedIdentityRef,
    evaluators: Object.freeze(input.evaluators.map((evaluator) => Object.freeze({ ...evaluator }))),
    measurements,
    issues,
    decision: input.decision,
    recommendedAction: input.recommendedAction,
    thresholdsVersion: input.thresholdsVersion,
    decidedAt: instant(input.decidedAt, 'report.decidedAt'),
  }
  return Object.freeze({ ...body, reportHash: calculateSyntheticCriticReportHash(body) })
}

export function assertSyntheticCriticReportIntegrity(
  report: Readonly<SyntheticCriticReport>,
): Readonly<SyntheticCriticReport> {
  const { reportHash, ...body } = report
  assertDomain(
    calculateSyntheticCriticReportHash(body) === reportHash,
    'PERSISTENCE_CONFLICT',
    'synthetic critic report hash does not match its stored content',
  )
  return report
}

/**
 * Approval is the only decision that lets bytes become a master or a cache
 * candidate. `evidence-unavailable` is deliberately not approval: not knowing
 * is not the same as knowing it is fine.
 */
export function isSyntheticCriticApproval(decision: SyntheticCriticDecision): boolean {
  return decision === 'approved'
}
