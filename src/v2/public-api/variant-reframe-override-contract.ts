import { presentVariantReframePlan } from '../application/plan-project-reframe.ts'
import type { VariantReframeOverrideResult } from '../application/ports/variant-reframe-override-repository.ts'
import { DomainError } from '../domain/errors.ts'
import { presentProjectVersionV2 } from './presenters.ts'

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('INVALID_ARGUMENT', `${field} must be an object`)
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, fields: readonly string[], field: string) {
  const extra = Object.keys(value).filter((key) => !fields.includes(key))
  if (extra.length) throw new DomainError('INVALID_ARGUMENT', `${field} contains unknown fields`, { fields: extra })
}
function text(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim()) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  return value.trim()
}
function frame(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  return value as number
}

/**
 * A manual reframe as a closed request body (W66r). `action: 'set'` carries the crop the editor chose; `action: 'reset'` carries none and
 * returns the exact range to the automatic level. The variant is the STABLE State variant id; the clip and the half-open frame range are
 * the editor's, and the domain refuses a range that leaves the clip it names.
 */
export function parseApplyVariantReframeOverrideBody(raw: unknown) {
  const body = record(raw, 'body')
  exact(body, ['baseVersionId', 'baseHash', 'variantId', 'clipId', 'startFrame', 'endFrame', 'action', 'crop', 'reason'], 'body')
  const action = body.action === undefined ? 'set' : body.action
  if (action !== 'set' && action !== 'reset') throw new DomainError('INVALID_ARGUMENT', 'Variant reframe override action is invalid')
  const identity = {
    baseVersionId: text(body.baseVersionId, 'baseVersionId'), baseHash: text(body.baseHash, 'baseHash'), variantId: text(body.variantId, 'variantId'),
    clipId: text(body.clipId, 'clipId'), startFrame: frame(body.startFrame, 'startFrame'), endFrame: frame(body.endFrame, 'endFrame'),
    ...(body.reason !== undefined ? { reason: text(body.reason, 'reason') } : {}),
  }
  if (action === 'reset') {
    if (body.crop !== undefined) throw new DomainError('INVALID_ARGUMENT', 'A reset cannot specify a crop')
    return Object.freeze({ ...identity, action: 'reset' as const })
  }
  const crop = record(body.crop, 'crop')
  exact(crop, ['x', 'y', 'width', 'height'], 'crop')
  for (const key of ['x', 'y', 'width', 'height']) {
    if (typeof crop[key] !== 'number' || !Number.isFinite(crop[key])) throw new DomainError('INVALID_ARGUMENT', `crop.${key} is invalid`)
  }
  return Object.freeze({
    ...identity, action: 'set' as const,
    crop: Object.freeze({ x: crop.x as number, y: crop.y as number, width: crop.width as number, height: crop.height as number }),
  })
}

export function presentVariantReframeOverrideResult(value: Readonly<VariantReframeOverrideResult>) {
  return Object.freeze({
    command: Object.freeze({
      id: value.command.id, type: value.command.type, baseVersionId: value.command.baseVersionId,
      author: value.command.author, reason: value.command.reason, createdAt: value.command.createdAt,
    }),
    version: presentProjectVersionV2(
      { id: value.version.id, sequence: value.version.sequence, parentVersionId: value.version.parentVersionId, baseHash: value.version.baseHash, createdAt: value.version.createdAt },
      { current: true, previewAvailable: false },
    ),
    reframeOverride: value.reframeOverride,
    plan: presentVariantReframePlan(value.plan),
    impact: value.impact,
    replayed: value.replayed,
  })
}
