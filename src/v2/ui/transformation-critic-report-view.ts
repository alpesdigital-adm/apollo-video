/**
 * Reading rules of the transformation critic report that the synthetic phase
 * gate panel opens inline.
 *
 * The server already revalidated the record, so nothing here recomputes its
 * hash. What lives here is only what the viewer must never get wrong and a
 * test can hold still: whether the answer is the report the gate referenced,
 * that an absent number never reads as zero, that ranges are stated in frames,
 * and which evaluator a measurement came from — a controlled stand-in is never
 * presented as a real measurement.
 */

import type {
  TransformationCriticAction,
  TransformationCriticDecision,
  TransformationCriticDimension,
  TransformationCriticIssue,
  TransformationCriticStatus,
  TransformationEvaluatorKind,
} from '../domain/transformation-critic-report.ts'

export interface PublicCriticFrameRange {
  startFrame: number
  endFrame: number
}

export interface PublicCriticRegion {
  x: number
  y: number
  width: number
  height: number
}

export interface PublicCriticEvaluator {
  id: string
  kind: TransformationEvaluatorKind
  version: string
  scope: string
}

export interface PublicCriticMeasurement {
  dimension: TransformationCriticDimension
  status: TransformationCriticStatus
  evaluatorId?: string
  scoreBps: number | null
  thresholdBps: number | null
  frameRange: PublicCriticFrameRange | null
  region: PublicCriticRegion | null
  note?: string
}

export interface PublicCriticIssue {
  dimension: TransformationCriticDimension
  severity: TransformationCriticIssue['severity']
  frameRange: PublicCriticFrameRange
  region: PublicCriticRegion | null
  violatedPreserve?: string
  description: string
}

/** The report as `GET /v1/projects/{projectId}/transformation-critic-reports/{reportId}` presents it. */
export interface PublicCriticReport {
  schemaVersion: string
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
  evaluators: readonly PublicCriticEvaluator[]
  measurements: readonly PublicCriticMeasurement[]
  issues: readonly PublicCriticIssue[]
  hardGates: readonly TransformationCriticDimension[]
  decision: TransformationCriticDecision
  action: TransformationCriticAction
  confidenceBps: number | null
  intentScoreBps: number | null
  evaluatedAt: string
  reportHash: string
}

export type CriticReportViewerPhase = 'loading' | 'ready' | 'error'

export interface CriticReportViewerFailure {
  /** A classified read refusal (`ReadFailureKind`) or `identity`. */
  kind: string
  code?: string
  retryAfterMs?: number
  message: string
}

export interface CriticMeasurementOrigin {
  /** The measurement's own `evaluatorId`, or an empty string when it names none. */
  evaluatorId: string
  kind: TransformationEvaluatorKind | ''
  label: string
}

export const CRITIC_DECISION_LABELS: Readonly<Record<TransformationCriticDecision, string>> = Object.freeze({
  approved: 'Aprovado',
  rejected: 'Rejeitado',
  'needs-review': 'Precisa de revisão',
  'evidence-unavailable': 'Evidência indisponível',
})

export const CRITIC_ACTION_LABELS: Readonly<Record<TransformationCriticAction, string>> = Object.freeze({
  approve: 'aprovar',
  retry: 'repetir',
  fallback: 'usar alternativa',
  review: 'revisar',
})

export const CRITIC_STATUS_LABELS: Readonly<Record<TransformationCriticStatus, string>> = Object.freeze({
  measured: 'Medida',
  'not-applicable': 'Não se aplica',
  unavailable: 'Indisponível',
})

export const CRITIC_SEVERITY_LABELS: Readonly<Record<TransformationCriticIssue['severity'], string>> = Object.freeze({
  blocking: 'Bloqueante',
  major: 'Grave',
  minor: 'Menor',
})

export const CRITIC_EVALUATOR_KIND_LABELS: Readonly<Record<TransformationEvaluatorKind, string>> = Object.freeze({
  measured: 'medição real',
  controlled: 'prova controlada',
})

export const CRITIC_REPORT_IDENTITY_MISMATCH =
  'O relatório retornado não corresponde à referência selecionada (projeto, ID ou hash divergente).'

/**
 * The label of an enumerated value, or the value itself when the server sends
 * one this screen does not know yet. Own keys only: a value named after an
 * `Object.prototype` member must not render that member.
 */
export function criticLabel(labels: Readonly<Record<string, string>>, value: string): string {
  return Object.prototype.hasOwnProperty.call(labels, value) ? labels[value] : value
}

/** The answer is shown only when it is the very report the gate referenced. */
export function matchesTransformationCriticReportReference(input: Readonly<{
  report: Readonly<{ id: string; reportHash: string; projectId: string }>
  projectId: string
  reference: Readonly<{ id: string; hash: string }>
}>): boolean {
  return input.report.projectId === input.projectId &&
    input.report.id === input.reference.id &&
    input.report.reportHash === input.reference.hash
}

/** A score that was not produced reads as unavailable, never as zero. */
export function formatBasisPoints(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value} bps` : 'indisponível'
}

/** Ranges are stated in frames, as recorded; a null range covers the whole result. */
export function frameRangeLabel(range: Readonly<PublicCriticFrameRange> | null | undefined): string {
  return range ? `quadros ${range.startFrame}–${range.endFrame}` : 'resultado inteiro'
}

export function resolveMeasurementOrigin(
  measurement: Readonly<{ evaluatorId?: string }>,
  evaluators: readonly Readonly<{ id: string; kind: string; version: string }>[],
): CriticMeasurementOrigin {
  const evaluatorId = measurement.evaluatorId ?? ''
  const evaluator = evaluatorId === ''
    ? undefined
    : evaluators.find((candidate) => candidate.id === evaluatorId)
  if (evaluator === undefined || (evaluator.kind !== 'measured' && evaluator.kind !== 'controlled')) {
    return { evaluatorId, kind: '', label: 'origem não informada' }
  }
  return {
    evaluatorId,
    kind: evaluator.kind,
    label: `origem: ${evaluator.id} · ${CRITIC_EVALUATOR_KIND_LABELS[evaluator.kind]} · v${evaluator.version}`,
  }
}

/** `evaluatedAt` in pt-BR; a value that is not an instant is shown as received. */
export function formatCriticEvaluatedAt(value: string): string {
  const instant = Date.parse(value)
  if (Number.isNaN(instant)) return value
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(instant))
}

/** The violated preserve entry as stable text. */
export function violatedPreserveText(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value) ?? String(value)
}

export function viewerFailureText(failure: Readonly<CriticReportViewerFailure>): string {
  if (failure.kind === 'identity') return CRITIC_REPORT_IDENTITY_MISMATCH
  if (failure.kind === 'forbidden') return 'Esta sessão não pode consultar o relatório crítico.'
  if (failure.kind === 'rate-limited') {
    const waitMs = failure.retryAfterMs
    return typeof waitMs === 'number' && Number.isFinite(waitMs) && waitMs > 0
      ? `O servidor pediu uma pausa de ${Math.ceil(waitMs / 1_000)} s antes de consultar o relatório novamente.`
      : 'O servidor pediu uma pausa antes de consultar o relatório novamente.'
  }
  // The route answers a missing report, or one filed under another project,
  // with 422 ASSET_NOT_FOUND rather than 404: the code is what names it.
  if (failure.code === 'ASSET_NOT_FOUND') return 'Relatório não encontrado neste projeto (ASSET_NOT_FOUND).'
  return failure.message
}
