import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { DomainError } from '../domain/errors.ts'
import { createWorkspaceLutVersion, parseCube3d, type LutColorSpace, type LutLicensePolicy } from '../domain/workspace-lut.ts'
import type { LutPreviewGenerator } from './ports/lut-preview-generator.ts'
import type { WorkspaceLutRepository } from './ports/workspace-lut-repository.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
function id(value: string, field: string) {
  const normalized = value?.trim()
  if (!ID.test(normalized)) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  return normalized
}

export function importWorkspaceLutService(dependencies: {
  repository: WorkspaceLutRepository
  preview: LutPreviewGenerator
  createVersionId: () => string
  clock?: () => Date
}) {
  const clock = dependencies.clock ?? (() => new Date())
  return async function importLut(request: {
    workspaceId: string; lutId: string; name: string; owner: string
    license: { policy: LutLicensePolicy; name: string; usageNotes?: string }
    tags?: readonly string[]
    compatibility: { inputColorSpace: LutColorSpace; outputColorSpace: LutColorSpace }
    intensity?: number; cubeContent: string
    actor: { type: 'api-client'; id: string }; idempotencyKey: string
  }) {
    const workspaceId = id(request.workspaceId, 'workspaceId')
    const lutId = id(request.lutId, 'lutId')
    if (request.actor?.type !== 'api-client') throw new DomainError('INVALID_ARGUMENT', 'actor is invalid')
    const createdByClientId = id(request.actor.id, 'actor.id')
    const idempotencyKey = (request.idempotencyKey ?? '').trim()
    if (idempotencyKey.length < 8 || idempotencyKey.length > 128) throw new DomainError('INVALID_ARGUMENT', 'Idempotency-Key is invalid')
    const cube = parseCube3d(request.cubeContent)
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'workspace-lut-import-request/v1', workspaceId, lutId,
      name: request.name, owner: request.owner, license: request.license,
      tags: request.tags ?? [], compatibility: request.compatibility,
      intensity: request.intensity ?? 1, cubeContentHash: cube.contentHash, createdByClientId,
    })
    const replay = await dependencies.repository.findIdempotent({ workspaceId, createdByClientId, idempotencyKey })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with another LUT import')
      return Object.freeze({ value: replay, replayed: true })
    }
    const preview = await dependencies.preview.generate({ canonicalCube: cube.canonicalContent })
    const createdAt = clock().toISOString()
    const version = createWorkspaceLutVersion({
      id: id(dependencies.createVersionId(), 'versionId'), workspaceId, lutId, version: 1,
      name: request.name, owner: request.owner, license: request.license, tags: request.tags,
      compatibility: request.compatibility, intensity: request.intensity,
      cubeContent: cube.canonicalContent,
      preview: { byteSize: preview.png.byteLength, sha256: preview.sha256 },
      createdByClientId, createdAt,
    })
    return dependencies.repository.import({
      value: { record: { lutId, workspaceId, status: 'active', revision: 1, currentVersion: version }, idempotencyKey, requestFingerprint },
      previewPng: preview.png,
    })
  }
}

export function createWorkspaceLutVersionService(dependencies: {
  repository: WorkspaceLutRepository
  preview: LutPreviewGenerator
  createVersionId: () => string
  clock?: () => Date
}) {
  const clock = dependencies.clock ?? (() => new Date())
  return async function createVersion(request: {
    workspaceId: string; lutId: string; baseVersion: number; name: string; owner: string
    license: { policy: LutLicensePolicy; name: string; usageNotes?: string }; tags?: readonly string[]
    compatibility: { inputColorSpace: LutColorSpace; outputColorSpace: LutColorSpace }
    intensity?: number; cubeContent: string; actor: { type: 'api-client'; id: string }; idempotencyKey: string
  }) {
    const workspaceId = id(request.workspaceId, 'workspaceId')
    const lutId = id(request.lutId, 'lutId')
    const createdByClientId = request.actor?.type === 'api-client' ? id(request.actor.id, 'actor.id') : ''
    if (!createdByClientId) throw new DomainError('INVALID_ARGUMENT', 'actor is invalid')
    if (!Number.isSafeInteger(request.baseVersion) || request.baseVersion < 1) throw new DomainError('INVALID_ARGUMENT', 'baseVersion is invalid')
    const idempotencyKey = (request.idempotencyKey ?? '').trim()
    if (idempotencyKey.length < 8 || idempotencyKey.length > 128) throw new DomainError('INVALID_ARGUMENT', 'Idempotency-Key is invalid')
    const cube = parseCube3d(request.cubeContent)
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'workspace-lut-version-create-request/v1', workspaceId, lutId, baseVersion: request.baseVersion,
      name: request.name, owner: request.owner, license: request.license, tags: request.tags ?? [],
      compatibility: request.compatibility, intensity: request.intensity ?? 1, cubeContentHash: cube.contentHash, createdByClientId,
    })
    const replay = await dependencies.repository.findIdempotent({ workspaceId, createdByClientId, idempotencyKey })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with another LUT mutation')
      return Object.freeze({ value: replay, replayed: true })
    }
    const current = await dependencies.repository.read({ workspaceId, lutId })
    if (!current) throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Workspace LUT was not found')
    if (current.currentVersion.version !== request.baseVersion) throw new DomainError('VERSION_CONFLICT', 'Workspace LUT baseVersion is stale')
    const preview = await dependencies.preview.generate({ canonicalCube: cube.canonicalContent })
    const version = createWorkspaceLutVersion({
      id: id(dependencies.createVersionId(), 'versionId'), workspaceId, lutId, version: request.baseVersion + 1,
      name: request.name, owner: request.owner, license: request.license, tags: request.tags,
      compatibility: request.compatibility, intensity: request.intensity, cubeContent: cube.canonicalContent,
      preview: { byteSize: preview.png.byteLength, sha256: preview.sha256 }, createdByClientId, createdAt: clock().toISOString(),
    })
    return dependencies.repository.createVersion({
      value: { record: { ...current, currentVersion: version }, idempotencyKey, requestFingerprint },
      previewPng: preview.png, expectedCurrentVersionId: current.currentVersion.id,
    })
  }
}

export function setWorkspaceLutStatusService(dependencies: {
  repository: WorkspaceLutRepository; createCommandId: () => string; clock?: () => Date
}) {
  const clock = dependencies.clock ?? (() => new Date())
  return async (request: { workspaceId: string; lutId: string; baseRevision: number; status: 'active' | 'inactive'; actor: { type: 'api-client'; id: string }; idempotencyKey: string }) => {
    const workspaceId = id(request.workspaceId, 'workspaceId'); const lutId = id(request.lutId, 'lutId')
    const createdByClientId = request.actor?.type === 'api-client' ? id(request.actor.id, 'actor.id') : ''
    if (!createdByClientId) throw new DomainError('INVALID_ARGUMENT', 'actor is invalid')
    if (!Number.isSafeInteger(request.baseRevision) || request.baseRevision < 1) throw new DomainError('INVALID_ARGUMENT', 'baseRevision is invalid')
    if (!['active', 'inactive'].includes(request.status)) throw new DomainError('INVALID_ARGUMENT', 'status is invalid')
    const idempotencyKey = (request.idempotencyKey ?? '').trim()
    if (idempotencyKey.length < 8 || idempotencyKey.length > 128) throw new DomainError('INVALID_ARGUMENT', 'Idempotency-Key is invalid')
    const requestFingerprint = calculateCanonicalHash({ schemaVersion: 'workspace-lut-status-command/v1', workspaceId, lutId, baseRevision: request.baseRevision, status: request.status, createdByClientId })
    const replay = await dependencies.repository.findStatusIdempotent({ workspaceId, createdByClientId, idempotencyKey })
    if (replay) {
      if (replay.command.requestFingerprint !== requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with another LUT status command')
      return Object.freeze({ ...replay, replayed: true })
    }
    const current = await dependencies.repository.read({ workspaceId, lutId })
    if (!current) throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Workspace LUT was not found')
    if (current.revision !== request.baseRevision) throw new DomainError('VERSION_CONFLICT', 'Workspace LUT revision changed')
    return dependencies.repository.setStatus({ command: Object.freeze({
      id: id(dependencies.createCommandId(), 'commandId'), workspaceId, lutId, baseRevision: request.baseRevision,
      resultRevision: request.baseRevision + 1, status: request.status, resultVersionId: current.currentVersion.id, requestFingerprint, idempotencyKey,
      createdByClientId, createdAt: clock().toISOString(),
    }) })
  }
}

export function readWorkspaceLutService(dependencies: { repository: WorkspaceLutRepository }) {
  return async (input: { workspaceId: string; lutId: string }) => {
    const value = await dependencies.repository.read({ workspaceId: id(input.workspaceId, 'workspaceId'), lutId: id(input.lutId, 'lutId') })
    if (!value) throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Workspace LUT was not found')
    return value
  }
}

export function listWorkspaceLutsService(dependencies: { repository: WorkspaceLutRepository }) {
  return async (input: { workspaceId: string; status?: 'active' | 'inactive'; limit?: number }) => {
    const limit = input.limit ?? 50
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new DomainError('INVALID_ARGUMENT', 'limit must be between 1 and 100')
    if (input.status !== undefined && !['active', 'inactive'].includes(input.status)) throw new DomainError('INVALID_ARGUMENT', 'status is invalid')
    return dependencies.repository.list({ workspaceId: id(input.workspaceId, 'workspaceId'), ...(input.status ? { status: input.status } : {}), limit })
  }
}

export function readWorkspaceLutPreviewService(dependencies: { repository: WorkspaceLutRepository }) {
  return async (input: { workspaceId: string; lutId: string; version: number }) => {
    if (!Number.isSafeInteger(input.version) || input.version < 1) throw new DomainError('INVALID_ARGUMENT', 'version is invalid')
    const value = await dependencies.repository.readPreview({ workspaceId: id(input.workspaceId, 'workspaceId'), lutId: id(input.lutId, 'lutId'), version: input.version })
    if (!value) throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Workspace LUT preview was not found')
    return value
  }
}

export function readWorkspaceLutVersionService(dependencies: { repository: WorkspaceLutRepository }) {
  return async (input: { workspaceId: string; lutId: string; version: number }) => {
    if (!Number.isSafeInteger(input.version) || input.version < 1) throw new DomainError('INVALID_ARGUMENT', 'version is invalid')
    const value = await dependencies.repository.readVersion({ workspaceId: id(input.workspaceId, 'workspaceId'), lutId: id(input.lutId, 'lutId'), version: input.version })
    if (!value) throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Workspace LUT version was not found')
    return value
  }
}
