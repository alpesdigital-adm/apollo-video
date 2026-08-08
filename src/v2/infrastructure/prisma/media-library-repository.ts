import { randomUUID } from 'node:crypto'
import type { Prisma, PrismaClient, V2MediaLibraryEntry } from '../../../../generated/prisma-v2/index.js'

import type { MediaLibraryRepository } from '../../application/ports/media-library-repository.ts'
import { calculateCanonicalHash, stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  assertLibraryAttachmentEligible,
  mediaLibraryRights,
  mediaLibraryTechnicalStatus,
  normalizeMediaLibraryQuery,
  type LibraryKind,
  type MediaLibraryItem,
  type MediaLibraryQuery,
} from '../../domain/media-library.ts'
import type { MediaArtifactLifecycleStatus, MediaArtifactType } from '../../domain/media-artifact.ts'
import { hydrateAssetRights } from './asset-rights-repository.ts'

type EntryWithArtifact = V2MediaLibraryEntry & {
  artifact: {
    mediaType: string
    container: string
    byteSize: bigint
    status: string
    currentRightsSnapshot: Parameters<typeof hydrateAssetRights>[0] | null
  }
  thumbnailArtifact: { id: string; status: string } | null
  waveformArtifact: { id: string; status: string } | null
}

function parseDisplayArray(value: string, field: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string') || stableSerialize(parsed) !== value) throw new Error('invalid')
    return Object.freeze(parsed)
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} metadata is invalid`)
  }
}

function queryFingerprint(query: MediaLibraryQuery): string {
  return calculateCanonicalHash({
    schemaVersion: 'media-library-cursor-scope/v1',
    workspaceId: query.workspaceId,
    kind: query.kind ?? null,
    person: query.person ?? null,
    topic: query.topic ?? null,
    rightsStatus: query.rightsStatus ?? null,
  })
}

function encodeCursor(entry: Pick<V2MediaLibraryEntry, 'artifactId' | 'createdAt'>, fingerprint: string): string {
  return Buffer.from(stableSerialize({ createdAt: entry.createdAt.toISOString(), fingerprint, id: entry.artifactId }), 'utf8').toString('base64url')
}

function decodeCursor(value: string, fingerprint: string): Readonly<{ createdAt: Date; id: string }> {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>
    if (Object.keys(parsed).sort().join(',') !== 'createdAt,fingerprint,id' || parsed.fingerprint !== fingerprint || typeof parsed.id !== 'string' || typeof parsed.createdAt !== 'string') throw new Error('invalid')
    const createdAt = new Date(parsed.createdAt)
    if (Number.isNaN(createdAt.getTime()) || parsed.id.length < 3 || parsed.id.length > 128) throw new Error('invalid')
    return Object.freeze({ createdAt, id: parsed.id })
  } catch {
    throw new DomainError('INVALID_CURSOR', 'Media library cursor is invalid for this query')
  }
}

function mapItem(row: EntryWithArtifact, now: Date, locale: string): Readonly<MediaLibraryItem> {
  const mediaType = row.artifact.mediaType as MediaArtifactType
  if (!['video', 'audio', 'image'].includes(mediaType)) throw new DomainError('PERSISTENCE_CONFLICT', 'Library entry points to an unsupported artifact type')
  const status = row.artifact.status as MediaArtifactLifecycleStatus
  if (!['available', 'quarantined', 'deleted'].includes(status)) throw new DomainError('PERSISTENCE_CONFLICT', 'Library artifact status is invalid')
  const originType = row.originType as MediaLibraryItem['origin']['type']
  if (!['upload', 'generated', 'derived'].includes(originType)) throw new DomainError('PERSISTENCE_CONFLICT', 'Library origin is invalid')
  const preview = (artifact: { id: string; status: string } | null) => artifact?.status === 'available'
    ? Object.freeze({ status: 'available' as const, artifactId: artifact.id })
    : Object.freeze({ status: 'unavailable' as const })
  return Object.freeze({
    id: row.artifactId,
    workspaceId: row.workspaceId,
    kind: mediaType as LibraryKind,
    label: row.label,
    people: parseDisplayArray(row.peopleJson, 'people'),
    topics: parseDisplayArray(row.topicsJson, 'topics'),
    status: mediaLibraryTechnicalStatus(status),
    rights: mediaLibraryRights(row.artifact.currentRightsSnapshot ? hydrateAssetRights(row.artifact.currentRightsSnapshot) : null, { workspaceId: row.workspaceId, locale, now }),
    origin: Object.freeze({ type: originType, ...(row.parentArtifactId ? { parentArtifactId: row.parentArtifactId } : {}) }),
    preview: Object.freeze({ thumbnail: preview(row.thumbnailArtifact), waveform: preview(row.waveformArtifact) }),
    technical: Object.freeze({ mediaType, container: row.artifact.container, byteSize: row.artifact.byteSize.toString() }),
    createdAt: row.createdAt.toISOString(),
  })
}

const include = {
  artifact: { select: { mediaType: true, container: true, byteSize: true, status: true, currentRightsSnapshot: true } },
  thumbnailArtifact: { select: { id: true, status: true } },
  waveformArtifact: { select: { id: true, status: true } },
} as const

export class PrismaMediaLibraryRepository implements MediaLibraryRepository {
  constructor(private readonly client: PrismaClient) {}

  async list(rawQuery: MediaLibraryQuery, now: Date) {
    const query = normalizeMediaLibraryQuery(rawQuery)
    const fingerprint = queryFingerprint(query)
    let scan = query.after ? decodeCursor(query.after, fingerprint) : null
    const matched: Array<{ row: EntryWithArtifact; item: Readonly<MediaLibraryItem> }> = []
    while (matched.length <= query.limit) {
      const rows = await this.client.v2MediaLibraryEntry.findMany({
        where: {
          workspaceId: query.workspaceId,
          artifact: { mediaType: query.kind && query.kind !== 'segment' ? query.kind : query.kind === 'segment' ? '__segment__' : { in: ['video', 'audio', 'image'] } },
          ...(query.person ? { peopleSearch: { contains: `\n${query.person}\n` } } : {}),
          ...(query.topic ? { topicsSearch: { contains: query.topic } } : {}),
          ...(scan ? { OR: [{ createdAt: { lt: scan.createdAt } }, { createdAt: scan.createdAt, artifactId: { lt: scan.id } }] } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { artifactId: 'desc' }],
        take: 100,
        include,
      }) as EntryWithArtifact[]
      if (rows.length === 0) break
      for (const row of rows) {
        const item = mapItem(row, now, 'pt-BR')
        if (!query.rightsStatus || item.rights.status === query.rightsStatus) matched.push({ row, item })
        if (matched.length > query.limit) break
      }
      const last = rows.at(-1)!
      scan = { createdAt: last.createdAt, id: last.artifactId }
      if (rows.length < 100 || matched.length > query.limit) break
    }
    const page = matched.slice(0, query.limit)
    return Object.freeze({
      items: Object.freeze(page.map(({ item }) => item)),
      nextCursor: matched.length > query.limit && page.length ? encodeCursor(page.at(-1)!.row, fingerprint) : null,
    })
  }

  async findById(workspaceId: string, artifactId: string, now: Date, locale = 'pt-BR') {
    const row = await this.client.v2MediaLibraryEntry.findFirst({ where: { workspaceId, artifactId }, include }) as EntryWithArtifact | null
    return row ? mapItem(row, now, locale) : null
  }

  async attach(input: { workspaceId: string; projectId: string; artifactId: string; createdAt: string }) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.client.$transaction(async (transaction) => {
      const [project, row, existing] = await Promise.all([
        transaction.v2Project.findFirst({ where: { id: input.projectId, workspaceId: input.workspaceId }, select: { id: true, locale: true } }),
        transaction.v2MediaLibraryEntry.findFirst({ where: { workspaceId: input.workspaceId, artifactId: input.artifactId }, include }) as Promise<EntryWithArtifact | null>,
        transaction.v2ProjectMediaAsset.findUnique({ where: { projectId_artifactId_role: { projectId: input.projectId, artifactId: input.artifactId, role: 'selected-insert' } } }),
      ])
      if (!project) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found')
      if (!row) throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Media library item was not found')
      assertLibraryAttachmentEligible(mapItem(row, new Date(input.createdAt), project.locale ?? 'pt-BR'), input.workspaceId)
      const reference = existing ?? await transaction.v2ProjectMediaAsset.create({ data: {
        id: randomUUID(), workspaceId: input.workspaceId, projectId: input.projectId,
        artifactId: input.artifactId, role: 'selected-insert', originalFileName: row.label,
        createdAt: new Date(input.createdAt),
      } })
      return Object.freeze({
        id: reference.id, workspaceId: reference.workspaceId, projectId: reference.projectId,
        artifactId: reference.artifactId, role: 'selected-insert' as const, bytesDuplicated: false as const,
        replayed: existing !== null, createdAt: reference.createdAt.toISOString(),
      })
        }, { isolationLevel: 'Serializable' as Prisma.TransactionIsolationLevel })
      } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
        if (attempt < 3 && (code === 'P2034' || code === 'P2002')) continue
        throw error
      }
    }
    throw new DomainError('PERSISTENCE_CONFLICT', 'Media library attachment could not be serialized')
  }
}
