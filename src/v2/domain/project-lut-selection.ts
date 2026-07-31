import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import type { WorkspaceLutVersion } from './workspace-lut.ts'

export type ProjectLutSelectionRequest =
  | Readonly<{ mode: 'workspace-default' }>
  | Readonly<{ mode: 'none' }>
  | Readonly<{ mode: 'lut-version'; lutId: string; version: number }>

export interface ResolvedProjectLutRef {
  lutId: string
  versionId: string
  version: number
  name: string
  recordHash: string
  cubeContentHash: string
}

export interface ProjectLutSelection {
  schemaVersion: 'project-lut-selection/v1'
  id: string
  workspaceId: string
  projectId: string
  baseVersionId: string
  resultVersionId: string
  commandId: string
  requested: ProjectLutSelectionRequest
  resolved: Readonly<{ mode: 'none' }> | Readonly<{ mode: 'lut-version'; lut: Readonly<ResolvedProjectLutRef> }>
  workspaceDefaultRevision?: number
  intensity: number
  selectionHash: string
  createdAt: string
}

function identifier(value: string, field: string) {
  assertDomain(typeof value === 'string' && value.trim().length > 0 && value.length <= 128, 'INVALID_ARGUMENT', `${field} is invalid`)
  return value.trim()
}

export function projectLutRef(value: Readonly<WorkspaceLutVersion>): Readonly<ResolvedProjectLutRef> {
  return Object.freeze({ lutId: value.lutId, versionId: value.id, version: value.version, name: value.name, recordHash: value.recordHash, cubeContentHash: value.cube.contentHash })
}

export function createProjectLutSelection(input: Omit<ProjectLutSelection, 'schemaVersion' | 'selectionHash'>): Readonly<ProjectLutSelection> {
  const ids = {
    id: identifier(input.id, 'id'), workspaceId: identifier(input.workspaceId, 'workspaceId'), projectId: identifier(input.projectId, 'projectId'),
    baseVersionId: identifier(input.baseVersionId, 'baseVersionId'), resultVersionId: identifier(input.resultVersionId, 'resultVersionId'), commandId: identifier(input.commandId, 'commandId'),
  }
  assertDomain(['workspace-default', 'lut-version', 'none'].includes(input.requested.mode), 'INVALID_ARGUMENT', 'requested LUT mode is invalid')
  if (input.requested.mode === 'lut-version') {
    identifier(input.requested.lutId, 'requested.lutId')
    assertDomain(Number.isSafeInteger(input.requested.version) && input.requested.version > 0, 'INVALID_ARGUMENT', 'requested LUT version is invalid')
  }
  assertDomain(input.resolved.mode === 'none' || input.resolved.mode === 'lut-version', 'INVALID_ARGUMENT', 'resolved LUT mode is invalid')
  if (input.resolved.mode === 'lut-version') {
    const lut = input.resolved.lut
    identifier(lut.lutId, 'resolved.lutId'); identifier(lut.versionId, 'resolved.versionId'); identifier(lut.name, 'resolved.name')
    assertDomain(Number.isSafeInteger(lut.version) && lut.version > 0 && /^[a-f0-9]{64}$/.test(lut.recordHash) && /^[a-f0-9]{64}$/.test(lut.cubeContentHash), 'INVALID_ARGUMENT', 'resolved LUT identity is invalid')
  }
  assertDomain(input.requested.mode !== 'lut-version' || input.resolved.mode === 'lut-version', 'INVALID_ARGUMENT', 'explicit LUT request must resolve to a LUT')
  assertDomain(input.requested.mode !== 'none' || input.resolved.mode === 'none', 'INVALID_ARGUMENT', 'none request must resolve to none')
  assertDomain(input.requested.mode !== 'workspace-default' || Number.isSafeInteger(input.workspaceDefaultRevision) && input.workspaceDefaultRevision! >= 0, 'INVALID_ARGUMENT', 'workspace default revision is required')
  assertDomain(input.requested.mode === 'workspace-default' || input.workspaceDefaultRevision === undefined, 'INVALID_ARGUMENT', 'workspace default revision is only valid for workspace-default')
  assertDomain(Number.isFinite(input.intensity) && input.intensity >= 0 && input.intensity <= 1, 'INVALID_ARGUMENT', 'LUT intensity must be between 0 and 1')
  assertDomain(!Number.isNaN(Date.parse(input.createdAt)), 'INVALID_ARGUMENT', 'createdAt is invalid')
  const body = {
    schemaVersion: 'project-lut-selection/v1' as const, ...ids, requested: input.requested, resolved: input.resolved,
    ...(input.workspaceDefaultRevision !== undefined ? { workspaceDefaultRevision: input.workspaceDefaultRevision } : {}), intensity: input.intensity, createdAt: input.createdAt,
  }
  return Object.freeze({ ...body, selectionHash: calculateCanonicalHash(body) })
}
