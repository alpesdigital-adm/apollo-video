import type { ProjectSubtitleConfigurationResult } from '../application/ports/project-subtitle-configuration-repository.ts'
import { DomainError } from '../domain/errors.ts'
import { SUBTITLE_MODES, SUBTITLE_PRESETS, type SubtitleModeRequest, type SubtitlePresetId } from '../domain/subtitle-system.ts'
import { presentProjectVersionV2 } from './presenters.ts'

function record(value: unknown, field: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('INVALID_ARGUMENT', `${field} must be an object`); return value as Record<string, unknown> }
function exact(value: Record<string, unknown>, fields: readonly string[], field: string) { const extra = Object.keys(value).filter(key => !fields.includes(key)); if (extra.length) throw new DomainError('INVALID_ARGUMENT', `${field} contains unknown fields`, { fields: extra }) }
function text(value: unknown, field: string) { if (typeof value !== 'string' || !value.trim()) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`); return value.trim() }

/**
 * State machine of one output variant, expressed as a closed request body.
 *
 * `action: 'set'` moves the variant to one of the four modes; `action: 'revert'`
 * returns it to the mode it carried before the current configuration and refuses
 * to carry a mode of its own.
 */
export function parseSetProjectSubtitleConfigurationBody(raw: unknown) {
  const body = record(raw, 'body'); exact(body, ['baseVersionId', 'baseHash', 'variantId', 'action', 'mode', 'presetId', 'presetVersion', 'reason'], 'body')
  const action = body.action === undefined ? 'set' : body.action
  if (action !== 'set' && action !== 'revert') throw new DomainError('INVALID_ARGUMENT', 'Subtitle action is invalid')
  const identity = Object.freeze({ baseVersionId: text(body.baseVersionId, 'baseVersionId'), baseHash: text(body.baseHash, 'baseHash'), variantId: text(body.variantId, 'variantId'), ...(body.reason !== undefined ? { reason: text(body.reason, 'reason') } : {}) })
  if (action === 'revert') {
    if (body.mode !== undefined || body.presetId !== undefined || body.presetVersion !== undefined) throw new DomainError('INVALID_ARGUMENT', 'A revert cannot specify a subtitle mode or preset')
    return Object.freeze({ ...identity, action: 'revert' as const })
  }
  let requested: SubtitleModeRequest
  if (body.mode === 'manual') {
    if (!Object.prototype.hasOwnProperty.call(SUBTITLE_PRESETS, String(body.presetId)) || body.presetVersion !== 1) throw new DomainError('INVALID_ARGUMENT', 'Manual subtitle preset reference is invalid')
    requested = Object.freeze({ mode: 'manual', presetId: body.presetId as SubtitlePresetId, presetVersion: 1 })
  } else if (body.mode === 'auto' || body.mode === 'workspace-default' || body.mode === 'none') {
    if (body.presetId !== undefined || body.presetVersion !== undefined) throw new DomainError('INVALID_ARGUMENT', `${body.mode} cannot specify a manual preset`)
    requested = Object.freeze({ mode: body.mode })
  } else throw new DomainError('INVALID_ARGUMENT', `Subtitle mode must be one of ${SUBTITLE_MODES.join(', ')}`)
  return Object.freeze({ ...identity, action: 'set' as const, requested })
}

/** The resolved origin the editor panel displays, plus the versioned preset reference. */
export function presentProjectSubtitleResolution(value: Readonly<ProjectSubtitleConfigurationResult>) {
  const { configuration } = value
  return Object.freeze({
    configurationId: configuration.id,
    configurationHash: configuration.configurationHash,
    variantId: configuration.variantId,
    action: configuration.action,
    previousConfigurationId: configuration.previousConfigurationId,
    mode: configuration.requested.mode,
    origin: configuration.origin,
    enabled: configuration.resolved.enabled,
    presetId: configuration.resolved.enabled ? configuration.resolved.presetId : null,
    presetVersion: configuration.resolved.enabled ? configuration.resolved.presetVersion : null,
    presetHash: configuration.resolved.enabled ? configuration.resolved.presetHash : null,
    workspaceDefaultRevision: configuration.workspaceDefaultRevision ?? null,
    transcriptHash: configuration.transcriptHash,
    createdAt: configuration.createdAt,
  })
}

export function presentProjectSubtitleConfigurationResult(value: Readonly<ProjectSubtitleConfigurationResult>) {
  return Object.freeze({
    command: Object.freeze({ id: value.command.id, type: value.command.type, baseVersionId: value.command.baseVersionId, author: value.command.author, reason: value.command.reason, createdAt: value.command.createdAt }),
    version: presentProjectVersionV2({ id: value.version.id, sequence: value.version.sequence, parentVersionId: value.version.parentVersionId, baseHash: value.version.baseHash, createdAt: value.version.createdAt }, { current: true, previewAvailable: false }),
    configuration: value.configuration,
    resolution: presentProjectSubtitleResolution(value),
    impact: value.impact,
    replayed: value.replayed,
  })
}
