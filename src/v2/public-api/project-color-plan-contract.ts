import type { ProjectColorPlanResult } from '../application/ports/project-color-plan-repository.ts'
import { createColorPlan, type ColorPlan } from '../domain/color-and-export.ts'
import { DomainError } from '../domain/errors.ts'
import { presentProjectVersionV2 } from './presenters.ts'

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('INVALID_ARGUMENT', `${field} must be an object`)
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, fields: readonly string[], field: string) {
  const unknown = Object.keys(value).filter((key) => !fields.includes(key))
  if (unknown.length) throw new DomainError('INVALID_ARGUMENT', `${field} contains unknown fields`, { fields: unknown })
}
function string(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim()) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  return value.trim()
}

export function parseSetProjectColorPlanBody(raw: unknown) {
  const body = object(raw, 'body')
  exact(body, ['baseVersionId', 'baseHash', 'plan', 'reason'], 'body')
  const plan = createColorPlan(object(body.plan, 'plan') as unknown as ColorPlan)
  return Object.freeze({
    baseVersionId: string(body.baseVersionId, 'baseVersionId'),
    baseHash: string(body.baseHash, 'baseHash'),
    plan,
    ...(body.reason !== undefined ? { reason: string(body.reason, 'reason') } : {}),
  })
}

export function presentProjectColorPlanResult(value: Readonly<ProjectColorPlanResult>) {
  return Object.freeze({
    command: Object.freeze({
      id: value.command.id, type: value.command.type, baseVersionId: value.command.baseVersionId,
      author: value.command.author, reason: value.command.reason, createdAt: value.command.createdAt,
    }),
    version: presentProjectVersionV2(
      { id: value.version.id, sequence: value.version.sequence, parentVersionId: value.version.parentVersionId, baseHash: value.version.baseHash, createdAt: value.version.createdAt },
      { current: true, previewAvailable: false },
    ),
    colorPlan: value.colorPlan,
    impact: value.impact,
    invalidations: value.invalidations,
    replayed: value.replayed,
  })
}
