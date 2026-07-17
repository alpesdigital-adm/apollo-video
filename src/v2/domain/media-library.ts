import { DomainError } from './errors.ts'

export type LibraryKind = 'video' | 'audio' | 'image' | 'segment'
export type RightsStatus = 'eligible' | 'review' | 'restricted' | 'expired'

export interface MediaLibraryItem {
  id: string
  workspaceId: string
  kind: LibraryKind
  label: string
  people: readonly string[]
  topics: readonly string[]
  status: 'processing' | 'usable' | 'failed'
  rightsStatus: RightsStatus
  origin: { type: 'upload' | 'generated' | 'derived'; parentId?: string }
  preview: { thumbnailUrl?: string; waveformUrl?: string }
  createdAt: string
}

export interface MediaLibraryQuery {
  workspaceId: string
  kind?: LibraryKind
  person?: string
  topic?: string
  rightsStatus?: RightsStatus
  after?: string
  limit?: number
}

export interface MediaLibraryPage {
  items: readonly MediaLibraryItem[]
  nextCursor: string | null
}

function cursorOf(item: MediaLibraryItem): string {
  return Buffer.from(`${item.createdAt}\u0000${item.id}`, 'utf8').toString('base64url')
}

export function listMediaLibrary(items: readonly MediaLibraryItem[], query: MediaLibraryQuery): Readonly<MediaLibraryPage> {
  const limit = Math.min(Math.max(query.limit ?? 24, 1), 100)
  const sorted = items
    .filter((item) => item.workspaceId === query.workspaceId)
    .filter((item) => !query.kind || item.kind === query.kind)
    .filter((item) => !query.person || item.people.some((person) => person.toLocaleLowerCase() === query.person!.toLocaleLowerCase()))
    .filter((item) => !query.topic || item.topics.some((topic) => topic.toLocaleLowerCase().includes(query.topic!.toLocaleLowerCase())))
    .filter((item) => !query.rightsStatus || item.rightsStatus === query.rightsStatus)
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  const start = query.after ? sorted.findIndex((item) => cursorOf(item) === query.after) + 1 : 0
  if (query.after && start === 0) throw new DomainError('INVALID_CURSOR', 'Cursor does not belong to this filtered result')
  const page = sorted.slice(start, start + limit)
  return Object.freeze({ items: Object.freeze(page), nextCursor: start + limit < sorted.length && page.length ? cursorOf(page.at(-1)!) : null })
}

export interface ProjectAssetReference {
  projectId: string
  workspaceId: string
  assetId: string
  source: 'media-library'
  bytesDuplicated: false
}

export function attachLibraryItem(input: { item: MediaLibraryItem; projectId: string; workspaceId: string }): Readonly<ProjectAssetReference> {
  if (input.item.workspaceId !== input.workspaceId) throw new DomainError('ASSET_NOT_FOUND', 'Asset is not visible in this workspace')
  if (input.item.status !== 'usable') throw new DomainError('ASSET_NOT_USABLE', 'Asset is not usable yet')
  if (input.item.rightsStatus !== 'eligible') throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Asset rights do not allow project use')
  return Object.freeze({ projectId: input.projectId, workspaceId: input.workspaceId, assetId: input.item.id, source: 'media-library', bytesDuplicated: false })
}
