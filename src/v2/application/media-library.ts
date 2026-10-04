import { normalizeMediaLibraryQuery } from '../domain/media-library.ts'
import { DomainError } from '../domain/errors.ts'
import type { MediaLibraryRepository } from './ports/media-library-repository.ts'
import { materializeActorAuditContext, requireScope, type AuthenticatedExternalActor } from './authenticate-api-client.ts'
import type { MediaLibrarySelection } from '../domain/media-library.ts'

export function listMediaLibraryService(dependencies: { repository: MediaLibraryRepository; clock?: () => Date }) {
  return async (query: Parameters<typeof normalizeMediaLibraryQuery>[0]) => dependencies.repository.list(normalizeMediaLibraryQuery(query), dependencies.clock?.() ?? new Date())
}

export function readMediaLibraryItemService(dependencies: { repository: MediaLibraryRepository; clock?: () => Date }) {
  return async (rawWorkspaceId: string, rawItemId: string) => {
    const workspaceId = normalizeMediaLibraryQuery({ workspaceId: rawWorkspaceId }).workspaceId
    const itemId = rawItemId.trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(itemId)) throw new DomainError('INVALID_ARGUMENT', 'Media library item id is invalid')
    const item = await dependencies.repository.findById(workspaceId, itemId, dependencies.clock?.() ?? new Date())
    if (!item) throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Media library item was not found')
    return item
  }
}

export function attachMediaLibraryItemService(dependencies: { repository: MediaLibraryRepository; clock?: () => Date }) {
  return async (input: { workspaceId: string; projectId: string; selection: MediaLibrarySelection; baseVersionId: string; baseVersionHash: string; idempotencyKey: string; actor: Readonly<AuthenticatedExternalActor> }) => {
    const workspaceId = input.workspaceId.trim()
    const projectId = input.projectId.trim()
    const selection = input.selection
    if (!selection || typeof selection !== 'object' || !['asset', 'segment'].includes(selection.kind)) throw new DomainError('INVALID_ARGUMENT', 'selection kind is invalid')
    const expectedKey = selection.kind === 'asset' ? 'artifactId' : 'segmentId'
    if (Object.keys(selection).sort().join(',') !== [expectedKey, 'kind'].sort().join(',')) throw new DomainError('INVALID_ARGUMENT', 'selection shape is invalid')
    const selectionId = selection.kind === 'asset' ? selection.artifactId : selection.segmentId
    if (![workspaceId, projectId, input.baseVersionId, selectionId].every((id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(id)) || !/^[a-f0-9]{64}$/.test(input.baseVersionHash)) {
      throw new DomainError('INVALID_ARGUMENT', 'Library attachment identity or base version is invalid')
    }
    if (!/^[\x21-\x7e]{8,128}$/.test(input.idempotencyKey)) throw new DomainError('INVALID_ARGUMENT', 'Idempotency-Key is invalid')
    requireScope(input.actor, 'projects:write')
    const authenticationAudit = materializeActorAuditContext(input.actor)
    if (authenticationAudit.workspaceId !== workspaceId) throw new DomainError('AUTH_INVALID', 'Actor workspace does not match selection')
    return dependencies.repository.attach({
      workspaceId, projectId, selection, baseVersionId: input.baseVersionId,
      baseVersionHash: input.baseVersionHash, idempotencyKey: input.idempotencyKey,
      authenticationAudit, createdAt: (dependencies.clock?.() ?? new Date()).toISOString(),
    })
  }
}
