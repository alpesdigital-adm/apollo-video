import type { PersistedTreatmentPlan } from '../application/ports/treatment-plan-repository.ts'
import { DomainError } from '../domain/errors.ts'
import { STRATEGIC_OBJECTIVES, type StrategicObjectiveId } from '../domain/strategic-objective.ts'

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('INVALID_ARGUMENT', `${field} must be an object`)
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, fields: readonly string[], field: string): void {
  const unknown = Object.keys(value).filter((key) => !fields.includes(key))
  if (unknown.length) throw new DomainError('INVALID_ARGUMENT', `${field} contains unknown fields`, { fields: unknown })
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  return value.trim()
}

function integer(value: unknown, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  return value as number
}

function ratio(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  return value
}

export function parseCreateTreatmentPlanBody(raw: unknown) {
  const body = object(raw, 'body')
  exact(body, ['projectVersionId', 'policySnapshotId', 'objective', 'mode', 'perceptionSummary'], 'body')
  const objective = string(body.objective, 'objective')
  if (!STRATEGIC_OBJECTIVES.some((item) => item.id === objective)) throw new DomainError('INVALID_ARGUMENT', 'objective is invalid')
  const mode = string(body.mode, 'mode')
  if (!['talking-head', 'visual-montage'].includes(mode)) throw new DomainError('INVALID_ARGUMENT', 'mode is invalid')
  const perception = object(body.perceptionSummary, 'perceptionSummary')
  exact(perception, ['id', 'schemaVersion', 'summaryHash', 'confidence', 'speakerCoverage', 'visualVariety', 'evidenceItemCount', 'durationMs'], 'perceptionSummary')
  return Object.freeze({
    projectVersionId: string(body.projectVersionId, 'projectVersionId'),
    policySnapshotId: string(body.policySnapshotId, 'policySnapshotId'),
    objective: objective as StrategicObjectiveId,
    mode: mode as 'talking-head' | 'visual-montage',
    perceptionSummary: Object.freeze({
      id: string(perception.id, 'perceptionSummary.id'),
      schemaVersion: integer(perception.schemaVersion, 1, 1_000_000, 'perceptionSummary.schemaVersion'),
      summaryHash: string(perception.summaryHash, 'perceptionSummary.summaryHash'),
      confidence: ratio(perception.confidence, 'perceptionSummary.confidence'),
      speakerCoverage: ratio(perception.speakerCoverage, 'perceptionSummary.speakerCoverage'),
      visualVariety: ratio(perception.visualVariety, 'perceptionSummary.visualVariety'),
      evidenceItemCount: integer(perception.evidenceItemCount, 0, 1_000_000, 'perceptionSummary.evidenceItemCount'),
      durationMs: integer(perception.durationMs, 1, 2_147_483_647, 'perceptionSummary.durationMs'),
    }),
  })
}

export function presentTreatmentPlan(value: Readonly<PersistedTreatmentPlan>) {
  return Object.freeze({
    id: value.id,
    workspaceId: value.workspaceId,
    projectId: value.projectId,
    projectVersionId: value.projectVersionId,
    plan: value.plan,
    treatmentHash: value.treatmentHash,
    createdByClientId: value.createdByClientId,
    createdAt: value.createdAt,
  })
}
