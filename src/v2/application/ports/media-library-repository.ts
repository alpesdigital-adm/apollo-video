import type { MediaLibraryItem, MediaLibraryPage, MediaLibraryQuery, MediaLibrarySelection, ProjectAssetReference } from '../../domain/media-library.ts'
import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'

export interface MediaLibraryRepository {
  list(query: MediaLibraryQuery, now: Date): Promise<Readonly<MediaLibraryPage>>
  findById(workspaceId: string, itemId: string, now: Date, locale?: string): Promise<Readonly<MediaLibraryItem> | null>
  attach(input: {
    workspaceId: string
    projectId: string
    selection: MediaLibrarySelection
    baseVersionId: string
    baseVersionHash: string
    idempotencyKey: string
    authenticationAudit: Readonly<ApiAccessAuditContext>
    createdAt: string
  }): Promise<Readonly<ProjectAssetReference>>
}
