import type { WorkspaceLutRecord } from '../application/ports/workspace-lut-repository.ts'
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

export function presentWorkspaceLut(value: Readonly<WorkspaceLutRecord>) {
  const item = value.currentVersion
  return Object.freeze({
    id: value.lutId, workspaceId: value.workspaceId, status: value.status,
    currentVersion: Object.freeze({
      id: item.id, version: item.version, name: item.name, owner: item.owner,
      license: item.license, tags: item.tags, compatibility: item.compatibility, intensity: item.intensity,
      cube: Object.freeze({ title: item.cube.title, size: item.cube.size, domainMin: item.cube.domainMin, domainMax: item.cube.domainMax, rows: item.cube.rows, contentHash: item.cube.contentHash }),
      preview: Object.freeze({ ...item.preview, path: `/v1/workspaces/${encodeURIComponent(value.workspaceId)}/luts/${encodeURIComponent(value.lutId)}/versions/${item.version}/preview` }),
      createdByClientId: item.createdByClientId, createdAt: item.createdAt, recordHash: item.recordHash,
    }),
  })
}
