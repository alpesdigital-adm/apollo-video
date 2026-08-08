import type { AssetRightsSnapshot } from './asset-rights.ts'
import { evaluateAssetUse } from './asset-rights.ts'
import { DomainError, assertDomain } from './errors.ts'
import type { MediaArtifactLifecycleStatus, MediaArtifactType } from './media-artifact.ts'

export const MEDIA_LIBRARY_KINDS = ['video', 'audio', 'image', 'segment'] as const
export type LibraryKind = (typeof MEDIA_LIBRARY_KINDS)[number]
export const MEDIA_LIBRARY_RIGHTS_STATUSES = ['eligible', 'review', 'restricted', 'expired'] as const
export type LibraryRightsStatus = (typeof MEDIA_LIBRARY_RIGHTS_STATUSES)[number]
export type RightsStatus = LibraryRightsStatus

export interface MediaLibraryItem {
  id: string
  workspaceId: string
  kind: LibraryKind
  label: string
  people: readonly string[]
  topics: readonly string[]
  status: 'processing' | 'usable' | 'failed'
  rights: Readonly<{
    status: LibraryRightsStatus
    snapshotId?: string
    reasonCodes: readonly string[]
  }>
  origin: Readonly<{ type: 'upload' | 'generated' | 'derived'; parentArtifactId?: string }>
  preview: Readonly<{
    thumbnail: Readonly<{ status: 'available' | 'unavailable'; artifactId?: string }>
    waveform: Readonly<{ status: 'available' | 'unavailable'; artifactId?: string }>
  }>
  technical: Readonly<{ mediaType: MediaArtifactType; container: string; byteSize: string }>
  createdAt: string
}

export interface MediaLibraryQuery {
  workspaceId: string
  kind?: LibraryKind
  person?: string
  topic?: string
  rightsStatus?: LibraryRightsStatus
  after?: string
  limit?: number
}

export interface MediaLibraryPage {
  items: readonly MediaLibraryItem[]
  nextCursor: string | null
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

function normalizedSearchTerm(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim().toLocaleLowerCase('pt-BR')
  assertDomain(normalized.length >= 1 && normalized.length <= 120 && !normalized.includes('\n'), 'INVALID_ARGUMENT', `${field} must contain 1 to 120 characters`)
  return normalized
}

export function normalizeMediaLibraryQuery(query: MediaLibraryQuery): Readonly<Required<Pick<MediaLibraryQuery, 'workspaceId' | 'limit'>> & Omit<MediaLibraryQuery, 'workspaceId' | 'limit'>> {
  const workspaceId = query.workspaceId.trim()
  assertDomain(ID_PATTERN.test(workspaceId), 'INVALID_ARGUMENT', 'workspaceId is invalid')
  assertDomain(query.kind === undefined || MEDIA_LIBRARY_KINDS.includes(query.kind), 'INVALID_ARGUMENT', 'kind is invalid')
  assertDomain(query.rightsStatus === undefined || MEDIA_LIBRARY_RIGHTS_STATUSES.includes(query.rightsStatus), 'INVALID_ARGUMENT', 'rightsStatus is invalid')
  const limit = query.limit ?? 24
  assertDomain(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'INVALID_ARGUMENT', 'limit must be between 1 and 100')
  const after = query.after?.trim()
  assertDomain(after === undefined || (after.length >= 8 && after.length <= 512), 'INVALID_CURSOR', 'cursor is invalid')
  return Object.freeze({
    workspaceId,
    limit,
    ...(query.kind ? { kind: query.kind } : {}),
    ...(query.rightsStatus ? { rightsStatus: query.rightsStatus } : {}),
    ...(after ? { after } : {}),
    ...(normalizedSearchTerm(query.person, 'person') ? { person: normalizedSearchTerm(query.person, 'person') } : {}),
    ...(normalizedSearchTerm(query.topic, 'topic') ? { topic: normalizedSearchTerm(query.topic, 'topic') } : {}),
  })
}

export function mediaLibrarySearchField(values: readonly string[], field: string): Readonly<{ values: readonly string[]; search: string }> {
  assertDomain(Array.isArray(values) && values.length <= 64, 'INVALID_ARGUMENT', `${field} must contain at most 64 values`)
  const normalized = values.map((value) => {
    assertDomain(typeof value === 'string', 'INVALID_ARGUMENT', `${field} must contain strings`)
    const display = value.trim()
    assertDomain(display.length >= 1 && display.length <= 120 && !display.includes('\n'), 'INVALID_ARGUMENT', `${field} contains an invalid value`)
    return display
  })
  assertDomain(new Set(normalized.map((value) => value.toLocaleLowerCase('pt-BR'))).size === normalized.length, 'INVALID_ARGUMENT', `${field} contains duplicates`)
  const sorted = [...normalized].sort((a, b) => a.localeCompare(b, 'pt-BR'))
  return Object.freeze({ values: Object.freeze(sorted), search: `\n${sorted.map((value) => value.toLocaleLowerCase('pt-BR')).join('\n')}\n` })
}

export function mediaLibraryTechnicalStatus(status: MediaArtifactLifecycleStatus): MediaLibraryItem['status'] {
  if (status === 'available') return 'usable'
  if (status === 'quarantined') return 'processing'
  return 'failed'
}

export function mediaLibraryRights(
  snapshot: AssetRightsSnapshot | null,
  input: { workspaceId: string; locale: string; now: Date },
): MediaLibraryItem['rights'] {
  const decision = evaluateAssetUse(snapshot, { workspaceId: input.workspaceId, locale: input.locale, use: 'editorial-reuse' }, input.now)
  if (decision.outcome === 'allow') {
    return Object.freeze({ status: 'eligible', snapshotId: decision.rightsSnapshotId!, reasonCodes: Object.freeze([]) })
  }
  const expired = decision.reasonCodes.some((reason) => reason.includes('EXPIRED'))
  const review = decision.reasonCodes.includes('RIGHTS_MISSING') || decision.reasonCodes.some((reason) => reason.includes('UNKNOWN'))
  return Object.freeze({
    status: expired ? 'expired' : review ? 'review' : 'restricted',
    ...(decision.rightsSnapshotId ? { snapshotId: decision.rightsSnapshotId } : {}),
    reasonCodes: Object.freeze([...decision.reasonCodes]),
  })
}

export interface ProjectAssetReference {
  id: string
  projectId: string
  workspaceId: string
  artifactId: string
  role: 'selected-insert'
  bytesDuplicated: false
  replayed: boolean
  createdAt: string
}

export function assertLibraryAttachmentEligible(item: MediaLibraryItem, workspaceId: string): void {
  if (item.workspaceId !== workspaceId) throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Library item is not visible in this workspace')
  if (item.status !== 'usable') throw new DomainError('ASSET_NOT_USABLE', 'Library item is not usable')
  if (item.rights.status !== 'eligible') {
    throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Library item rights do not allow editorial reuse', { reasonCodes: item.rights.reasonCodes })
  }
}

// Pure collection oracle retained for unit/property tests; production pagination is server-side.
export function listMediaLibrary(items: readonly MediaLibraryItem[], rawQuery: MediaLibraryQuery): Readonly<MediaLibraryPage> {
  const query = normalizeMediaLibraryQuery(rawQuery)
  const cursorOf = (item: MediaLibraryItem) => Buffer.from(`${item.createdAt}\u0000${item.id}`, 'utf8').toString('base64url')
  const sorted = items
    .filter((item) => item.workspaceId === query.workspaceId)
    .filter((item) => !query.kind || item.kind === query.kind)
    .filter((item) => !query.person || item.people.some((person) => person.toLocaleLowerCase('pt-BR') === query.person))
    .filter((item) => !query.topic || item.topics.some((topic) => topic.toLocaleLowerCase('pt-BR').includes(query.topic!)))
    .filter((item) => !query.rightsStatus || item.rights.status === query.rightsStatus)
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  const start = query.after ? sorted.findIndex((item) => cursorOf(item) === query.after) + 1 : 0
  if (query.after && start === 0) throw new DomainError('INVALID_CURSOR', 'Cursor does not belong to this filtered result')
  const page = sorted.slice(start, start + query.limit)
  return Object.freeze({ items: Object.freeze(page), nextCursor: start + query.limit < sorted.length && page.length ? cursorOf(page.at(-1)!) : null })
}
