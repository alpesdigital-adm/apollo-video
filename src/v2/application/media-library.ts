import { normalizeMediaLibraryQuery } from '../domain/media-library.ts'
import { DomainError } from '../domain/errors.ts'
import type { MediaLibraryRepository } from './ports/media-library-repository.ts'

export function listMediaLibraryService(dependencies: { repository: MediaLibraryRepository; clock?: () => Date }) {
  return async (query: Parameters<typeof normalizeMediaLibraryQuery>[0]) => dependencies.repository.list(normalizeMediaLibraryQuery(query), dependencies.clock?.() ?? new Date())
}

export function readMediaLibraryItemService(dependencies: { repository: MediaLibraryRepository; clock?: () => Date }) {
  return async (workspaceId: string, artifactId: string) => {
    const item = await dependencies.repository.findById(workspaceId, artifactId.trim(), dependencies.clock?.() ?? new Date())
    if (!item) throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Media library item was not found')
    return item
  }
}

export function attachMediaLibraryItemService(dependencies: { repository: MediaLibraryRepository; clock?: () => Date }) {
  return async (input: { workspaceId: string; projectId: string; artifactId: string }) => {
    const now = dependencies.clock?.() ?? new Date()
    const workspaceId = input.workspaceId.trim()
    const projectId = input.projectId.trim()
    const artifactId = input.artifactId.trim()
    if (![workspaceId, projectId, artifactId].every((id) => /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(id))) {
      throw new DomainError('INVALID_ARGUMENT', 'workspaceId, projectId and artifactId must be valid identifiers')
    }
    return dependencies.repository.attach({
      workspaceId, projectId, artifactId,
      createdAt: now.toISOString(),
    })
  }
}
