import { assertDomain } from '../domain/errors.ts'
import {
  SYNTHETIC_CRITIC_DECISIONS,
  type SyntheticCriticDecision,
  type SyntheticCriticIssue,
  type SyntheticCriticMeasurement,
  type SyntheticCriticReport,
} from '../domain/synthetic-critic-report.ts'

/**
 * Public contract for the synthetic critic reports (F3.009).
 *
 * What crosses the boundary is the verdict and how it was reached: the
 * evaluators with their `kind` and `scope`, every dimension with its status,
 * value, unit, threshold and note, and the issues the critic localized. The
 * `kind` and `scope` are not decoration — they are the only thing that
 * separates a number an instrument measured from a deterministic stand-in for a
 * perceptual model nobody deployed, and a reader who cannot tell them apart
 * would read a controlled probe as production visual validation.
 *
 * What never crosses: the approved script text (only `scriptHash`), the consent
 * evidence behind the presenter snapshot (only `profileSnapshotId`), and any
 * provider payload, credential or adapter configuration. Presenters project an
 * explicit allowlist of fields — never a spread of the aggregate — so a field
 * added to the domain later cannot reach the public surface by accident.
 */

function string(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && value.trim().length > 0,
    'INVALID_ARGUMENT',
    `${field} must be a non-empty string`,
  )
  return (value as string).trim()
}

function decision(value: string | null, field: string): SyntheticCriticDecision {
  const raw = string(value, field)
  assertDomain(
    (SYNTHETIC_CRITIC_DECISIONS as readonly string[]).includes(raw),
    'INVALID_ARGUMENT',
    `${field} must be one of ${SYNTHETIC_CRITIC_DECISIONS.join(', ')}`,
  )
  return raw as SyntheticCriticDecision
}

function boundedLimit(value: string | null, field: string): number {
  const limit = Number(value)
  assertDomain(
    value !== null && value.trim().length > 0 && Number.isSafeInteger(limit),
    'INVALID_ARGUMENT',
    `${field} must be an integer`,
  )
  return limit
}

export const SYNTHETIC_CRITIC_REPORT_LIST_QUERY_PARAMETERS: ReadonlySet<string> =
  new Set(['decision', 'blockId', 'limit'])

export function parseSyntheticCriticReportListQuery(parameters: URLSearchParams) {
  return Object.freeze({
    ...(parameters.has('decision') ? { decision: decision(parameters.get('decision'), 'decision') } : {}),
    ...(parameters.has('blockId') ? { blockId: string(parameters.get('blockId'), 'blockId') } : {}),
    ...(parameters.has('limit') ? { limit: boundedLimit(parameters.get('limit'), 'limit') } : {}),
  }) as Readonly<{
    decision?: SyntheticCriticDecision
    blockId?: string
    limit?: number
  }>
}

/**
 * An instrument, and what it can and cannot answer. `kind` says whether it
 * measured the artifact or stood in for a model that is not deployed.
 */
function presentEvaluator(evaluator: Readonly<SyntheticCriticReport['evaluators'][number]>) {
  return Object.freeze({
    id: evaluator.id,
    version: evaluator.version,
    kind: evaluator.kind,
    scope: evaluator.scope,
  })
}

/**
 * One dimension's answer. A `not-applicable` or `unavailable` dimension carries
 * a null value and a note saying why, exactly as the aggregate stores it — the
 * presenter never fills a gap with a zero.
 */
function presentMeasurement(measurement: Readonly<SyntheticCriticMeasurement>) {
  return Object.freeze({
    dimension: measurement.dimension,
    status: measurement.status,
    evaluatorId: measurement.evaluatorId,
    value: measurement.value,
    unit: measurement.unit,
    threshold: measurement.threshold,
    confidence: measurement.confidence,
    evidenceRefs: Object.freeze([...measurement.evidenceRefs]),
    range: measurement.range ? Object.freeze({ startMs: measurement.range.startMs, endMs: measurement.range.endMs }) : null,
    note: measurement.note,
  })
}

function presentIssue(issue: Readonly<SyntheticCriticIssue>) {
  return Object.freeze({
    blockId: issue.blockId,
    dimension: issue.dimension,
    severity: issue.severity,
    range: issue.range ? Object.freeze({ startMs: issue.range.startMs, endMs: issue.range.endMs }) : null,
    evidence: issue.evidence,
    action: issue.action,
  })
}

export function presentSyntheticCriticReport(report: Readonly<SyntheticCriticReport>) {
  return Object.freeze({
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
    // The script itself stays behind its content address, which is the whole
    // reason the aggregate stores a hash.
    scriptHash: report.scriptHash,
    profileSnapshotId: report.profileSnapshotId,
    expectedIdentityRef: report.expectedIdentityRef,
    evaluators: report.evaluators.map(presentEvaluator),
    measurements: report.measurements.map(presentMeasurement),
    issues: report.issues.map(presentIssue),
    decision: report.decision,
    recommendedAction: report.recommendedAction,
    thresholdsVersion: report.thresholdsVersion,
    decidedAt: report.decidedAt,
    reportHash: report.reportHash,
  })
}
