import type { SubtitleSegmentOverrideResult } from '../application/ports/subtitle-segment-override-repository.ts'
import { DomainError } from '../domain/errors.ts'
import {
  SUBTITLE_SEGMENT_OVERRIDE_ANCHORS,
  SUBTITLE_SEGMENT_OVERRIDE_KINDS,
  normalizeSubtitleSegmentOverrideDimensions,
} from '../domain/subtitle-segment-override.ts'
import { presentProjectVersionV2 } from './presenters.ts'

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be an object`)
  }
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

/**
 * State machine of one subtitle segment, expressed as a closed request body.
 *
 * `action: 'set'` writes the exception and may mark it `protected`; `action: 'reset'`
 * returns the segment to the level it carried before and refuses to carry either a
 * dimension or a protection flag of its own. The frame range is never part of the
 * request: it is read from the compiled segment, so a caller cannot claim frames
 * the EditPlan does not give that segment.
 */
export function parseApplySubtitleSegmentOverrideBody(raw: unknown) {
  const body = record(raw, 'body')
  exact(body, ['baseVersionId', 'baseHash', 'variantId', 'segmentId', 'action', 'dimensions', 'protected', 'reason'], 'body')
  const action = body.action === undefined ? 'set' : body.action
  if (action !== 'set' && action !== 'reset') throw new DomainError('INVALID_ARGUMENT', 'Subtitle segment override action is invalid')
  const identity = Object.freeze({
    baseVersionId: text(body.baseVersionId, 'baseVersionId'),
    baseHash: text(body.baseHash, 'baseHash'),
    variantId: text(body.variantId, 'variantId'),
    segmentId: text(body.segmentId, 'segmentId'),
    ...(body.reason !== undefined ? { reason: text(body.reason, 'reason') } : {}),
  })
  if (action === 'reset') {
    if (body.dimensions !== undefined || body.protected !== undefined) {
      throw new DomainError('INVALID_ARGUMENT', 'A reset cannot specify dimensions or protection')
    }
    return Object.freeze({ ...identity, action: 'reset' as const })
  }
  if (!Array.isArray(body.dimensions) || body.dimensions.length === 0) {
    throw new DomainError('INVALID_ARGUMENT', `A set requires at least one of ${SUBTITLE_SEGMENT_OVERRIDE_KINDS.join(', ')}`)
  }
  if (body.protected !== undefined && typeof body.protected !== 'boolean') {
    throw new DomainError('INVALID_ARGUMENT', 'protected is invalid')
  }
  // The domain owns the closed union; the contract only refuses shapes that could
  // never reach it and lets the typed parser produce the canonical list.
  const dimensions = normalizeSubtitleSegmentOverrideDimensions(body.dimensions)
  return Object.freeze({ ...identity, action: 'set' as const, dimensions, protected: body.protected === true })
}

/** What the editor panel shows for one segment: the resolved exception, not a mode to interpret. */
export function presentSubtitleSegmentOverrideResolution(value: Readonly<SubtitleSegmentOverrideResult>) {
  const { subtitleOverride } = value
  return Object.freeze({
    overrideId: subtitleOverride.id,
    overrideHash: subtitleOverride.overrideHash,
    variantId: subtitleOverride.variantId,
    segmentId: subtitleOverride.segmentId,
    range: subtitleOverride.range,
    action: subtitleOverride.action,
    previousOverrideId: subtitleOverride.previousOverrideId,
    dimensions: subtitleOverride.dimensions,
    /** Empty dimensions means the segment is back to the project-level resolution. */
    inherited: subtitleOverride.dimensions.length === 0,
    protected: subtitleOverride.protected,
    createdAt: subtitleOverride.createdAt,
  })
}

export function presentSubtitleSegmentOverrideResult(value: Readonly<SubtitleSegmentOverrideResult>) {
  return Object.freeze({
    command: Object.freeze({
      id: value.command.id, type: value.command.type, baseVersionId: value.command.baseVersionId,
      author: value.command.author, reason: value.command.reason, createdAt: value.command.createdAt,
    }),
    version: presentProjectVersionV2(
      {
        id: value.version.id, sequence: value.version.sequence, parentVersionId: value.version.parentVersionId,
        baseHash: value.version.baseHash, createdAt: value.version.createdAt,
      },
      { current: true, previewAvailable: false },
    ),
    subtitleOverride: value.subtitleOverride,
    resolution: presentSubtitleSegmentOverrideResolution(value),
    impact: value.impact,
    replayed: value.replayed,
  })
}

/** Anchors the public schema publishes, kept in one place with the domain union. */
export const PUBLIC_SUBTITLE_SEGMENT_OVERRIDE_ANCHORS = SUBTITLE_SEGMENT_OVERRIDE_ANCHORS
