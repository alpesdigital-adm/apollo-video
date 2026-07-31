import type { WorkspaceLutDefault, WorkspaceLutDefaultVersion, WorkspaceLutRecord, WorkspaceLutStatusCommand } from '../application/ports/workspace-lut-repository.ts'
import { DomainError } from '../domain/errors.ts'
import type { LutColorSpace, LutLicensePolicy } from '../domain/workspace-lut.ts'

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('INVALID_ARGUMENT', `${field} must be an object`)
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, fields: readonly string[], field: string) {
  const unknown = Object.keys(value).filter((key) => !fields.includes(key))
  if (unknown.length) throw new DomainError('INVALID_ARGUMENT', `${field} contains unknown fields`, { fields: unknown })
}
function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  return value
}

export function parseImportWorkspaceLutBody(raw: unknown) {
  const body = object(raw, 'body')
  exact(body, ['lutId', 'name', 'owner', 'license', 'tags', 'compatibility', 'intensity', 'cubeContent'], 'body')
  const license = object(body.license, 'license')
  exact(license, ['policy', 'name', 'usageNotes'], 'license')
  const compatibility = object(body.compatibility, 'compatibility')
  exact(compatibility, ['inputColorSpace', 'outputColorSpace'], 'compatibility')
  if (body.tags !== undefined && (!Array.isArray(body.tags) || !body.tags.every((tag) => typeof tag === 'string'))) throw new DomainError('INVALID_ARGUMENT', 'tags must be an array of strings')
  if (body.intensity !== undefined && (typeof body.intensity !== 'number' || !Number.isFinite(body.intensity))) throw new DomainError('INVALID_ARGUMENT', 'intensity must be a finite number')
  return Object.freeze({
    lutId: string(body.lutId, 'lutId').trim(), name: string(body.name, 'name'), owner: string(body.owner, 'owner'),
    license: Object.freeze({ policy: string(license.policy, 'license.policy') as LutLicensePolicy, name: string(license.name, 'license.name'), ...(license.usageNotes !== undefined ? { usageNotes: string(license.usageNotes, 'license.usageNotes') } : {}) }),
    ...(body.tags ? { tags: Object.freeze([...(body.tags as string[])]) } : {}),
    compatibility: Object.freeze({ inputColorSpace: string(compatibility.inputColorSpace, 'compatibility.inputColorSpace') as LutColorSpace, outputColorSpace: string(compatibility.outputColorSpace, 'compatibility.outputColorSpace') as LutColorSpace }),
    ...(body.intensity !== undefined ? { intensity: body.intensity } : {}),
    cubeContent: string(body.cubeContent, 'cubeContent'),
  })
}

export function parseCreateWorkspaceLutVersionBody(raw: unknown) {
  const body = object(raw, 'body')
  exact(body, ['baseVersion', 'name', 'owner', 'license', 'tags', 'compatibility', 'intensity', 'cubeContent'], 'body')
  if (!Number.isSafeInteger(body.baseVersion) || (body.baseVersion as number) < 1) throw new DomainError('INVALID_ARGUMENT', 'baseVersion is invalid')
  const { baseVersion: _baseVersion, ...versionFields } = body
  const parsed = parseImportWorkspaceLutBody({ ...versionFields, lutId: 'placeholder' })
  const { lutId: _lutId, ...withoutLutId } = parsed
  return Object.freeze({ baseVersion: body.baseVersion as number, ...withoutLutId })
}

export function parseSetWorkspaceLutStatusBody(raw: unknown) {
  const body = object(raw, 'body')
  exact(body, ['baseRevision', 'status'], 'body')
  if (!Number.isSafeInteger(body.baseRevision) || (body.baseRevision as number) < 1) throw new DomainError('INVALID_ARGUMENT', 'baseRevision is invalid')
  if (!['active', 'inactive'].includes(body.status as string)) throw new DomainError('INVALID_ARGUMENT', 'status is invalid')
  return Object.freeze({ baseRevision: body.baseRevision as number, status: body.status as 'active' | 'inactive' })
}

export function presentWorkspaceLutVersion(item: Readonly<WorkspaceLutRecord['currentVersion']>) {
  return Object.freeze({
    id: item.id, version: item.version, name: item.name, owner: item.owner,
    license: item.license, tags: item.tags, compatibility: item.compatibility, intensity: item.intensity,
    cube: Object.freeze({ title: item.cube.title, size: item.cube.size, domainMin: item.cube.domainMin, domainMax: item.cube.domainMax, rows: item.cube.rows, contentHash: item.cube.contentHash }),
    preview: Object.freeze({ ...item.preview, path: `/v1/workspaces/${encodeURIComponent(item.workspaceId)}/luts/${encodeURIComponent(item.lutId)}/versions/${item.version}/preview` }),
    createdByClientId: item.createdByClientId, createdAt: item.createdAt, recordHash: item.recordHash,
  })
}

export function presentWorkspaceLut(value: Readonly<WorkspaceLutRecord>) {
  const item = value.currentVersion
  return Object.freeze({
    id: value.lutId, workspaceId: value.workspaceId, status: value.status,
    currentVersion: presentWorkspaceLutVersion(item),
  })
}

export function presentWorkspaceLutLifecycle(value: Readonly<WorkspaceLutRecord>) {
  return Object.freeze({ id: value.lutId, workspaceId: value.workspaceId, status: value.status, revision: value.revision, currentVersion: value.currentVersion.version })
}

export function presentWorkspaceLutStatusCommand(command: Readonly<WorkspaceLutStatusCommand>) {
  return Object.freeze({
    id: command.id, lutId: command.lutId, baseRevision: command.baseRevision, resultRevision: command.resultRevision,
    status: command.status, createdByClientId: command.createdByClientId, createdAt: command.createdAt,
  })
}

export function parseSetWorkspaceLutDefaultBody(raw: unknown) {
  const body = object(raw, 'body'); exact(body, ['baseRevision', 'selection'], 'body')
  if (!Number.isSafeInteger(body.baseRevision) || (body.baseRevision as number) < 0) throw new DomainError('INVALID_ARGUMENT', 'baseRevision is invalid')
  const selection = object(body.selection, 'selection'); exact(selection, ['mode', 'lutId', 'version'], 'selection')
  if (selection.mode === 'none') {
    if (selection.lutId !== undefined || selection.version !== undefined) throw new DomainError('INVALID_ARGUMENT', 'none selection cannot identify a LUT')
    return Object.freeze({ baseRevision: body.baseRevision as number, selection: Object.freeze({ mode: 'none' as const }) })
  }
  if (selection.mode !== 'lut-version') throw new DomainError('INVALID_ARGUMENT', 'selection.mode is invalid')
  if (!Number.isSafeInteger(selection.version) || (selection.version as number) < 1) throw new DomainError('INVALID_ARGUMENT', 'selection.version is invalid')
  return Object.freeze({ baseRevision: body.baseRevision as number, selection: Object.freeze({ mode: 'lut-version' as const, lutId: string(selection.lutId, 'selection.lutId').trim(), version: selection.version as number }) })
}

export function presentWorkspaceLutDefaultVersion(value: Readonly<WorkspaceLutDefaultVersion>) {
  return Object.freeze({
    id: value.id, revision: value.revision, mode: value.mode, selectionHash: value.selectionHash,
    ...(value.lutVersion ? { lut: Object.freeze({ id: value.lutVersion.lutId, versionId: value.lutVersion.id, version: value.lutVersion.version, name: value.lutVersion.name, recordHash: value.lutVersion.recordHash }) } : {}),
    createdByClientId: value.createdByClientId, createdAt: value.createdAt,
  })
}

export function presentWorkspaceLutDefault(value: Readonly<WorkspaceLutDefault>) {
  return Object.freeze({ workspaceId: value.workspaceId, revision: value.revision, current: value.current ? presentWorkspaceLutDefaultVersion(value.current) : null })
}
