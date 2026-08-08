import type { MediaLibraryItem, MediaLibraryPage, MediaLibraryQuery, ProjectAssetReference } from '../../domain/media-library.ts'

export interface MediaLibraryRepository {
  list(query: MediaLibraryQuery, now: Date): Promise<Readonly<MediaLibraryPage>>
  findById(workspaceId: string, artifactId: string, now: Date, locale?: string): Promise<Readonly<MediaLibraryItem> | null>
  attach(input: {
    workspaceId: string
    projectId: string
    artifactId: string
    createdAt: string
  }): Promise<Readonly<ProjectAssetReference>>
}
