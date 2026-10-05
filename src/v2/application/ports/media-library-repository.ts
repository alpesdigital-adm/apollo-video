import type { MediaLibraryItem, MediaLibraryPage, MediaLibraryQuery, MediaLibrarySelection, ProjectAssetReference } from '../../domain/media-library.ts'
import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type { EditCommand } from '../../domain/edit-command.ts'

export interface MediaLibraryAttachmentCommandFacts {
  commandId: string; resultVersionId: string; editPlanSnapshotId: string | null
  parentArtifactId: string; sourceSha256: string; rightsSnapshotId: string
  segmentHash?: string; semanticRange?: { startMs: number; endMs: number }; sourceTimeMapping?: { sourceStartMs: number; sourceEndMs: number; rate: 1 }
}

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
    createCommand(facts: MediaLibraryAttachmentCommandFacts): Readonly<EditCommand>
  }): Promise<Readonly<ProjectAssetReference>>
}
