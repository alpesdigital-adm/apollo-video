import { assertDomain } from '../domain/errors.ts'
import {
  FALLBACK_DESCENT_REASONS,
  type TransformationFallbackLedger,
} from '../domain/transformation-fallback.ts'
import type { PersistedProviderJob } from '../application/ports/provider-job-repository.ts'
import type { TransformationCriticReport } from '../domain/transformation-critic-report.ts'
import { presentTransformationJob } from './transformation-job-contract.ts'

function record(value: unknown, field: string): Record<string, unknown> {
  assertDomain(typeof value === 'object' && value !== null && !Array.isArray(value), 'INVALID_ARGUMENT', `${field} must be an object`)
  return value as Record<string, unknown>
}

export function parseTransformationFallbackAction(raw: unknown) {
  const body = record(raw, 'body')
  assertDomain(Object.keys(body).every((key) => key === 'action' || key === 'because') && 'action' in body, 'INVALID_ARGUMENT', 'body contains missing or unsupported properties')
  assertDomain(body.action === 'accept' || body.action === 'keep-source' || body.action === 'descend', 'INVALID_ARGUMENT', 'body.action is unsupported')
  if (body.because !== undefined) {
    assertDomain(typeof body.because === 'string' && FALLBACK_DESCENT_REASONS.includes(body.because as never), 'INVALID_ARGUMENT', 'body.because is unsupported')
  }
  assertDomain(body.action === 'descend' || body.because === undefined, 'INVALID_ARGUMENT', 'body.because only applies to descend')
  return Object.freeze({
    action: body.action,
    ...(body.because ? { because: body.because as (typeof FALLBACK_DESCENT_REASONS)[number] } : {}),
  })
}

function nonEmptyString(value: unknown, field: string, maximum: number): string {
  assertDomain(
    typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maximum,
    'INVALID_ARGUMENT',
    `${field} must be a bounded non-empty string`,
  )
  return value.trim()
}

export function parseTransformationFallbackDispatch(raw: unknown) {
  const body = record(raw, 'body')
  const keys = ['expectedLedgerHash', 'use', 'market', 'locale']
  assertDomain(
    Object.keys(body).length === keys.length &&
      Object.keys(body).every((key) => keys.includes(key)) &&
      keys.every((key) => key in body),
    'INVALID_ARGUMENT',
    'body contains missing or unsupported properties',
  )
  const expectedLedgerHash = nonEmptyString(body.expectedLedgerHash, 'body.expectedLedgerHash', 64)
  assertDomain(/^[a-f0-9]{64}$/.test(expectedLedgerHash), 'INVALID_ARGUMENT', 'body.expectedLedgerHash must be SHA-256')
  return Object.freeze({
    expectedLedgerHash,
    use: nonEmptyString(body.use, 'body.use', 128),
    market: nonEmptyString(body.market, 'body.market', 64),
    locale: nonEmptyString(body.locale, 'body.locale', 35),
  })
}

export function presentTransformationFallbackLedger(
  ledger: Readonly<TransformationFallbackLedger>,
) {
  return Object.freeze({
    schemaVersion: ledger.schemaVersion,
    id: ledger.id,
    projectId: ledger.projectId,
    projectVersionId: ledger.projectVersionId,
    briefId: ledger.briefId,
    briefHash: ledger.briefHash,
    ladder: Object.freeze([...ledger.ladder]),
    attempts: Object.freeze(ledger.attempts.map((attempt) => Object.freeze({ ...attempt }))),
    currentRung: ledger.currentRung,
    bestArtifactId: ledger.bestArtifactId,
    bestArtifactSha256: ledger.bestArtifactSha256,
    bestIntentScoreBps: ledger.bestIntentScoreBps,
    incurredCostMinorUnits: ledger.incurredCostMinorUnits,
    costCurrency: ledger.costCurrency,
    reviewDecision: ledger.reviewDecision,
    sourceArtifactId: ledger.sourceArtifactId,
    sourceArtifactSha256: ledger.sourceArtifactSha256,
    createdAt: ledger.createdAt,
    updatedAt: ledger.updatedAt,
    ledgerHash: ledger.ledgerHash,
  })
}

export function presentTransformationFallbackDispatch(result: Readonly<{
  outcome: 'enqueued' | 'replayed' | 'skipped'
  ledger: Readonly<TransformationFallbackLedger>
  job?: Readonly<PersistedProviderJob>
  reason?: 'capability-unavailable'
}>) {
  return Object.freeze({
    outcome: result.outcome,
    ledger: presentTransformationFallbackLedger(result.ledger),
    ...(result.job ? { job: presentTransformationJob(result.job) } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
  })
}

export function presentTransformationQuality(value: Readonly<{
  ledgers: readonly Readonly<{ ledger: unknown; actions: readonly string[] }>[]
  reports: readonly unknown[]
  novelty: readonly unknown[]
}>) {
  return Object.freeze({ ledgers: value.ledgers, reports: value.reports, novelty: value.novelty })
}

export function presentTransformationCriticReport(report: Readonly<TransformationCriticReport>) {
  return Object.freeze({ report: Object.freeze({
    schemaVersion: report.schemaVersion,
    id: report.id,
    workspaceId: report.workspaceId,
    projectId: report.projectId,
    briefId: report.briefId,
    briefHash: report.briefHash,
    providerJobId: report.providerJobId,
    policyId: report.policyId,
    policyHash: report.policyHash,
    sourceArtifactId: report.sourceArtifactId,
    sourceArtifactSha256: report.sourceArtifactSha256,
    resultArtifactId: report.resultArtifactId,
    resultArtifactSha256: report.resultArtifactSha256,
    evaluators: report.evaluators.map(({ id, kind, version, scope }) => Object.freeze({ id, kind, version, scope })),
    measurements: report.measurements.map(({ dimension, status, evaluatorId, scoreBps, thresholdBps, frameRange, region, note }) => Object.freeze({
      dimension, status, ...(evaluatorId === undefined ? {} : { evaluatorId }), scoreBps, thresholdBps,
      frameRange: frameRange ? Object.freeze({ startFrame: frameRange.startFrame, endFrame: frameRange.endFrame }) : null,
      region: region ? Object.freeze({ x: region.x, y: region.y, width: region.width, height: region.height }) : null,
      ...(note === undefined ? {} : { note }),
    })),
    issues: report.issues.map(({ dimension, severity, frameRange, region, violatedPreserve, description }) => Object.freeze({
      dimension, severity,
      frameRange: Object.freeze({ startFrame: frameRange.startFrame, endFrame: frameRange.endFrame }),
      region: region ? Object.freeze({ x: region.x, y: region.y, width: region.width, height: region.height }) : null,
      ...(violatedPreserve === undefined ? {} : { violatedPreserve }), description,
    })),
    hardGates: [...report.hardGates],
    decision: report.decision,
    action: report.action,
    confidenceBps: report.confidenceBps,
    intentScoreBps: report.intentScoreBps,
    evaluatedAt: report.evaluatedAt,
    reportHash: report.reportHash,
  }) })
}
