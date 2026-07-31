import type { ProjectLutSelectionResult } from '../application/ports/project-lut-selection-repository.ts'
import { DomainError } from '../domain/errors.ts'

function object(value: unknown, field: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('INVALID_ARGUMENT', `${field} must be an object`); return value as Record<string, unknown> }
function exact(value: Record<string, unknown>, fields: readonly string[], field: string) { const unknown = Object.keys(value).filter((key) => !fields.includes(key)); if (unknown.length) throw new DomainError('INVALID_ARGUMENT', `${field} contains unknown fields`, { fields: unknown }) }
function string(value: unknown, field: string) { if (typeof value !== 'string' || !value.trim()) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`); return value.trim() }

export function parseSetProjectLutSelectionBody(raw: unknown) {
  const body = object(raw, 'body'); exact(body, ['baseVersionId', 'baseHash', 'selection', 'intensity', 'reason'], 'body')
  const selection = object(body.selection, 'selection'); exact(selection, ['mode', 'lutId', 'version'], 'selection')
  let normalized
  if (selection.mode === 'lut-version') {
    if (!Number.isSafeInteger(selection.version) || (selection.version as number) < 1) throw new DomainError('INVALID_ARGUMENT', 'selection.version is invalid')
    normalized = Object.freeze({ mode: 'lut-version' as const, lutId: string(selection.lutId, 'selection.lutId'), version: selection.version as number })
  } else if (selection.mode === 'workspace-default' || selection.mode === 'none') {
    if (selection.lutId !== undefined || selection.version !== undefined) throw new DomainError('INVALID_ARGUMENT', `${selection.mode} cannot identify a LUT`)
    normalized = Object.freeze({ mode: selection.mode })
  } else throw new DomainError('INVALID_ARGUMENT', 'selection.mode is invalid')
  if (body.intensity !== undefined && (typeof body.intensity !== 'number' || !Number.isFinite(body.intensity))) throw new DomainError('INVALID_ARGUMENT', 'intensity is invalid')
  return Object.freeze({
    baseVersionId: string(body.baseVersionId, 'baseVersionId'), baseHash: string(body.baseHash, 'baseHash'), selection: normalized,
    ...(body.intensity !== undefined ? { intensity: body.intensity as number } : {}), ...(body.reason !== undefined ? { reason: string(body.reason, 'reason') } : {}),
  })
}

export function presentProjectLutSelectionResult(value: Readonly<ProjectLutSelectionResult>) {
  return Object.freeze({
    command: Object.freeze({ id: value.command.id, type: value.command.type, baseVersionId: value.command.baseVersionId, author: value.command.author, reason: value.command.reason, createdAt: value.command.createdAt }),
    version: Object.freeze({ id: value.version.id, sequence: value.version.sequence, parentVersionId: value.version.parentVersionId, baseHash: value.version.baseHash, createdAt: value.version.createdAt }),
    selection: Object.freeze({
      id: value.selection.id, requested: value.selection.requested, resolved: value.selection.resolved,
      ...(value.selection.workspaceDefaultRevision !== undefined ? { workspaceDefaultRevision: value.selection.workspaceDefaultRevision } : {}),
      intensity: value.selection.intensity, selectionHash: value.selection.selectionHash, createdAt: value.selection.createdAt,
    }),
    replayed: value.replayed,
  })
}
