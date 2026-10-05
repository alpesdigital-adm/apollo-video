import { editCommandExternalActorAuditData } from './edit-command-actor-audit.ts'
import { randomUUID } from 'node:crypto'
import type { Prisma, PrismaClient, V2MediaLibraryAttachment, V2MediaLibraryEntry, V2MediaSegment } from '../../../../generated/prisma-v2/index.js'

import type { MediaLibraryRepository } from '../../application/ports/media-library-repository.ts'
import { calculateCanonicalHash, stableSerialize } from '../../domain/canonical-hash.ts'
import { parseMediaLibraryAttachmentImpact } from '../../domain/media-library-attachment-impact.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  assertLibraryAttachmentEligible,
  mediaLibraryRights,
  mediaLibraryTechnicalStatus,
  normalizeMediaLibraryQuery,
  type LibraryKind,
  type MediaLibraryItem,
  type MediaLibraryQuery,
  type MediaLibrarySelection,
} from '../../domain/media-library.ts'
import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type { MediaArtifactLifecycleStatus, MediaArtifactType } from '../../domain/media-artifact.ts'
import { hydrateAssetRights } from './asset-rights-repository.ts'

type LibraryMetadata = V2MediaLibraryEntry & {
  thumbnailArtifact: { id: string; status: string } | null
  waveformArtifact: { id: string; status: string } | null
}

type EntryWithArtifact = LibraryMetadata & {
  artifact: {
    mediaType: string
    container: string
    byteSize: bigint
    status: string
    currentRightsSnapshot: Parameters<typeof hydrateAssetRights>[0] | null
  }
}

type SegmentWithArtifact = V2MediaSegment & {
  parentSegment: { artifactId: string; startMs: number; endMs: number } | null
  artifact: {
    id: string
    mediaType: string
    container: string
    byteSize: bigint
    status: string
    currentRightsSnapshot: Parameters<typeof hydrateAssetRights>[0] | null
    libraryEntry: LibraryMetadata | null
  }
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

type CursorEntity = 'asset' | 'segment'

function cursorKey(entity: CursorEntity, id: string): string {
  return `${entity === 'segment' ? 's' : 'a'}:${id}`
}

function encodeCursor(entry: { entity: CursorEntity; id: string; createdAt: Date }, fingerprint: string): string {
  return Buffer.from(stableSerialize({ createdAt: entry.createdAt.toISOString(), fingerprint, key: cursorKey(entry.entity, entry.id) }), 'utf8').toString('base64url')
}

function decodeCursor(value: string, fingerprint: string): Readonly<{ createdAt: Date; entity: CursorEntity; id: string; key: string }> {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>
    if (Object.keys(parsed).sort().join(',') !== 'createdAt,fingerprint,key' || parsed.fingerprint !== fingerprint || typeof parsed.key !== 'string' || typeof parsed.createdAt !== 'string') throw new Error('invalid')
    const createdAt = new Date(parsed.createdAt)
    const match = /^(a|s):([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/.exec(parsed.key)
    if (Number.isNaN(createdAt.getTime()) || !match) throw new Error('invalid')
    return Object.freeze({ createdAt, entity: match[1] === 's' ? 'segment' : 'asset', id: match[2], key: parsed.key })
  } catch {
    throw new DomainError('INVALID_CURSOR', 'Media library cursor is invalid for this query')
  }
}

function previewFromLibrary(row: LibraryMetadata) {
  const preview = (artifact: { id: string; status: string } | null) => artifact?.status === 'available'
    ? Object.freeze({ status: 'available' as const, artifactId: artifact.id })
    : Object.freeze({ status: 'unavailable' as const })
  return Object.freeze({ thumbnail: preview(row.thumbnailArtifact), waveform: preview(row.waveformArtifact) })
}

function mapItem(row: EntryWithArtifact, now: Date, locale: string): Readonly<MediaLibraryItem> {
  const mediaType = row.artifact.mediaType as MediaArtifactType
  if (!['video', 'audio', 'image'].includes(mediaType)) throw new DomainError('PERSISTENCE_CONFLICT', 'Library entry points to an unsupported artifact type')
  const status = row.artifact.status as MediaArtifactLifecycleStatus
  if (!['available', 'quarantined', 'deleted'].includes(status)) throw new DomainError('PERSISTENCE_CONFLICT', 'Library artifact status is invalid')
  const originType = row.originType as MediaLibraryItem['origin']['type']
  if (!['upload', 'generated', 'derived'].includes(originType)) throw new DomainError('PERSISTENCE_CONFLICT', 'Library origin is invalid')
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
    preview: previewFromLibrary(row),
    technical: Object.freeze({ mediaType, container: row.artifact.container, byteSize: row.artifact.byteSize.toString() }),
    source: Object.freeze({ type: 'artifact' as const, artifactId: row.artifactId, virtual: false as const, bytesDuplicated: false as const }),
    createdAt: row.createdAt.toISOString(),
  })
}

function mapSegmentItem(row: SegmentWithArtifact, now: Date, locale: string): Readonly<MediaLibraryItem> {
  const library = row.artifact.libraryEntry
  if (!library) throw new DomainError('PERSISTENCE_CONFLICT', 'Media segment parent is not cataloged in the library')
  const mediaType = row.artifact.mediaType as MediaArtifactType
  if (!['video', 'audio'].includes(mediaType)) throw new DomainError('PERSISTENCE_CONFLICT', 'Media segment parent type is invalid')
  const status = row.artifact.status as MediaArtifactLifecycleStatus
  if (!['available', 'quarantined', 'deleted'].includes(status)) throw new DomainError('PERSISTENCE_CONFLICT', 'Media segment parent status is invalid')
  const semanticRange = Object.freeze({ startMs: row.startMs, endMs: row.endMs })
  const sourceTimeMapping = Object.freeze({ sourceStartMs: row.startMs, sourceEndMs: row.endMs, rate: 1 as const })
  const segmentContent = {
    schemaVersion: 'media-segment/v1', workspaceId: row.workspaceId, parentAssetId: row.artifactId,
    ...(row.parentSegmentId ? { parentSegmentId: row.parentSegmentId } : {}), label: row.label, description: row.description,
    semanticRange, sourceTimeMapping, sourceDurationMs: row.sourceDurationMs,
  }
  const parentIsValid = !row.parentSegmentId || (row.parentSegment?.artifactId === row.artifactId && row.startMs >= row.parentSegment.startMs && row.endMs <= row.parentSegment.endMs)
  if (row.physicalObjectKey !== null || row.startMs < 0 || row.endMs <= row.startMs || row.endMs > row.sourceDurationMs || !parentIsValid || calculateCanonicalHash(segmentContent) !== row.segmentHash) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored media segment failed read-model validation')
  }
  return Object.freeze({
    id: row.id,
    workspaceId: row.workspaceId,
    kind: 'segment' as const,
    label: row.label,
    people: parseDisplayArray(library.peopleJson, 'people'),
    topics: parseDisplayArray(library.topicsJson, 'topics'),
    status: mediaLibraryTechnicalStatus(status),
    rights: mediaLibraryRights(row.artifact.currentRightsSnapshot ? hydrateAssetRights(row.artifact.currentRightsSnapshot) : null, { workspaceId: row.workspaceId, locale, now }),
    origin: Object.freeze({ type: 'derived' as const, parentArtifactId: row.artifact.id }),
    preview: previewFromLibrary(library),
    technical: Object.freeze({ mediaType, container: row.artifact.container, byteSize: row.artifact.byteSize.toString() }),
    source: Object.freeze({
      type: 'segment' as const,
      artifactId: row.artifact.id,
      ...(row.parentSegmentId ? { parentSegmentId: row.parentSegmentId } : {}),
      description: row.description,
      semanticRange,
      sourceTimeMapping,
      physicalObjectKey: null,
      sourceDurationMs: row.sourceDurationMs,
      segmentHash: row.segmentHash,
      virtual: true as const,
      bytesDuplicated: false as const,
    }),
    createdAt: row.createdAt.toISOString(),
  })
}

const include = {
  artifact: { select: { mediaType: true, container: true, byteSize: true, status: true, currentRightsSnapshot: true } },
  thumbnailArtifact: { select: { id: true, status: true } },
  waveformArtifact: { select: { id: true, status: true } },
} as const

const segmentInclude = {
  parentSegment: { select: { artifactId: true, startMs: true, endMs: true } },
  artifact: {
    select: {
      id: true, mediaType: true, container: true, byteSize: true, status: true, currentRightsSnapshot: true,
      libraryEntry: { include: { thumbnailArtifact: { select: { id: true, status: true } }, waveformArtifact: { select: { id: true, status: true } } } },
    },
  },
} as const

function afterFor(entity: CursorEntity, scan: ReturnType<typeof decodeCursor> | null) {
  if (!scan) return {}
  const sameTimestampIsAfter = entity === 'asset'
    ? scan.entity === 'segment' ? {} : { artifactId: { lt: scan.id } }
    : scan.entity === 'asset' ? null : { id: { lt: scan.id } }
  return {
    OR: [
      { createdAt: { lt: scan.createdAt } },
      ...(sameTimestampIsAfter === null ? [] : [{ createdAt: scan.createdAt, ...sameTimestampIsAfter }]),
    ],
  }
}

export class PrismaMediaLibraryRepository implements MediaLibraryRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient) {
    this.client = client
  }

  async list(rawQuery: MediaLibraryQuery, now: Date) {
    const query = normalizeMediaLibraryQuery(rawQuery)
    const fingerprint = queryFingerprint(query)
    let scan = query.after ? decodeCursor(query.after, fingerprint) : null
    const matched: Array<{ cursor: { entity: CursorEntity; id: string; createdAt: Date }; item: Readonly<MediaLibraryItem> }> = []
    while (matched.length <= query.limit) {
      const libraryFilter = {
        ...(query.person ? { peopleSearch: { contains: `\n${query.person}\n` } } : {}),
        ...(query.topic ? { topicsSearch: { contains: query.topic } } : {}),
      }
      const [assetRows, segmentRows] = await Promise.all([
        query.kind === 'segment' ? Promise.resolve([] as EntryWithArtifact[]) : this.client.v2MediaLibraryEntry.findMany({
          where: {
            workspaceId: query.workspaceId,
            artifact: { mediaType: query.kind ?? { in: ['video', 'audio', 'image'] } },
            ...libraryFilter,
            ...afterFor('asset', scan),
          },
          orderBy: [{ createdAt: 'desc' }, { artifactId: 'desc' }], take: 100, include,
        }) as Promise<EntryWithArtifact[]>,
        query.kind && query.kind !== 'segment' ? Promise.resolve([] as SegmentWithArtifact[]) : this.client.v2MediaSegment.findMany({
          where: {
            workspaceId: query.workspaceId,
            artifact: { libraryEntry: { is: libraryFilter } },
            ...afterFor('segment', scan),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100, include: segmentInclude,
        }) as Promise<SegmentWithArtifact[]>,
      ])
      const candidates = [
        ...assetRows.map((row) => ({ entity: 'asset' as const, id: row.artifactId, createdAt: row.createdAt, item: mapItem(row, now, 'pt-BR') })),
        ...segmentRows.map((row) => ({ entity: 'segment' as const, id: row.id, createdAt: row.createdAt, item: mapSegmentItem(row, now, 'pt-BR') })),
      ].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || cursorKey(right.entity, right.id).localeCompare(cursorKey(left.entity, left.id))).slice(0, 100)
      if (candidates.length === 0) break
      for (const candidate of candidates) {
        if (!query.rightsStatus || candidate.item.rights.status === query.rightsStatus) matched.push({ cursor: candidate, item: candidate.item })
        if (matched.length > query.limit) break
      }
      const last = candidates.at(-1)!
      scan = Object.freeze({ createdAt: last.createdAt, entity: last.entity, id: last.id, key: cursorKey(last.entity, last.id) })
      if (candidates.length < 100 || matched.length > query.limit) break
    }
    const page = matched.slice(0, query.limit)
    return Object.freeze({
      items: Object.freeze(page.map(({ item }) => item)),
      nextCursor: matched.length > query.limit && page.length ? encodeCursor(page.at(-1)!.cursor, fingerprint) : null,
    })
  }

  async findById(workspaceId: string, itemId: string, now: Date, locale = 'pt-BR') {
    const [row, segment] = await Promise.all([
      this.client.v2MediaLibraryEntry.findFirst({ where: { workspaceId, artifactId: itemId }, include }) as Promise<EntryWithArtifact | null>,
      this.client.v2MediaSegment.findFirst({ where: { workspaceId, id: itemId, artifact: { libraryEntry: { isNot: null } } }, include: segmentInclude }) as Promise<SegmentWithArtifact | null>,
    ])
    if (row && segment) throw new DomainError('PERSISTENCE_CONFLICT', 'Media library identity is ambiguous')
    return row ? mapItem(row, now, locale) : segment ? mapSegmentItem(segment, now, locale) : null
  }

  async attach(input: Parameters<MediaLibraryRepository['attach']>[0]) {
    const selectionId = input.selection.kind === 'asset' ? input.selection.artifactId : input.selection.segmentId
    const requestFingerprint = calculateCanonicalHash({ schemaVersion: 'media-library-attachment-request/v2', workspaceId: input.workspaceId, projectId: input.projectId, selection: input.selection, baseVersionId: input.baseVersionId, baseVersionHash: input.baseVersionHash, actorContextHash: input.authenticationAudit.contextHash })
    const resultOf = (row: V2MediaLibraryAttachment, replayed: boolean) => Object.freeze({
      id: row.id, workspaceId: row.workspaceId, projectId: row.projectId,
      selection: row.selectionKind === 'asset' ? Object.freeze({ kind: 'asset' as const, artifactId: row.selectionId }) : Object.freeze({ kind: 'segment' as const, segmentId: row.selectionId }),
      parentArtifactId: row.parentArtifactId, sourceSha256: row.sourceSha256, rightsSnapshotId: row.rightsSnapshotId,
      ...(row.segmentHash ? { segmentHash: row.segmentHash } : {}),
      ...(row.semanticRangeJson ? { semanticRange: JSON.parse(row.semanticRangeJson) as { startMs: number; endMs: number } } : {}),
      ...(row.sourceTimeMappingJson ? { sourceTimeMapping: JSON.parse(row.sourceTimeMappingJson) as { sourceStartMs: number; sourceEndMs: number; rate: 1 } } : {}),
      commandId: row.commandId, baseVersionId: row.baseVersionId, resultVersionId: row.resultVersionId, resultVersionHash: row.resultVersionHash,
      role: 'selected-insert' as const, bytesDuplicated: false as const, replayed, createdAt: row.createdAt.toISOString(),
    })
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.client.$transaction(async (transaction) => {
          const existing = await transaction.v2MediaLibraryAttachment.findUnique({ where: { workspaceId_projectId_idempotencyKey: { workspaceId: input.workspaceId, projectId: input.projectId, idempotencyKey: input.idempotencyKey } } })
          if (existing) {
            if (existing.requestFingerprint !== requestFingerprint || existing.actorContextHash !== input.authenticationAudit.contextHash) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with a different library attachment')
            return resultOf(existing, true)
          }
          const project = await transaction.v2Project.findFirst({ where: { id: input.projectId, workspaceId: input.workspaceId }, select: { locale: true, currentVersion: true } })
          if (!project?.currentVersion) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found')
          const base = project.currentVersion
          if (base.id !== input.baseVersionId || base.baseHash !== input.baseVersionHash) throw new DomainError('VERSION_CONFLICT', 'Project version changed before library attachment')
          const row = input.selection.kind === 'asset'
            ? await transaction.v2MediaLibraryEntry.findFirst({ where: { workspaceId: input.workspaceId, artifactId: selectionId }, include }) as EntryWithArtifact | null
            : await transaction.v2MediaSegment.findFirst({ where: { workspaceId: input.workspaceId, id: selectionId, artifact: { libraryEntry: { isNot: null } } }, include: segmentInclude }) as SegmentWithArtifact | null
          if (!row) throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Media library selection was not found')
          const item = input.selection.kind === 'asset' ? mapItem(row as EntryWithArtifact, new Date(input.createdAt), project.locale ?? 'pt-BR') : mapSegmentItem(row as SegmentWithArtifact, new Date(input.createdAt), project.locale ?? 'pt-BR')
          assertLibraryAttachmentEligible(item, input.workspaceId)
          const parentArtifactId = item.source.artifactId
          const source = await transaction.v2MediaArtifact.findFirst({ where: { workspaceId: input.workspaceId, id: parentArtifactId, status: 'available' }, select: { sha256: true, currentRightsSnapshotId: true } })
          if (!source || source.currentRightsSnapshotId !== item.rights.snapshotId) throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Library source or rights changed before attachment')
          const commandId = `command-library-${randomUUID()}`
          const resultVersionId = `version-library-${randomUUID()}`
          const resultVersionHash = calculateCanonicalHash({ schemaVersion: 'media-library-attachment-version/v1', projectId: input.projectId, sequence: base.sequence + 1, parentVersionId: base.id, previousBaseHash: base.baseHash, commandId, selection: input.selection, sourceSha256: source.sha256, rightsSnapshotId: item.rights.snapshotId, segmentHash: item.source.type === 'segment' ? item.source.segmentHash : null })
          const command = input.createCommand({ commandId, resultVersionId, editPlanSnapshotId: base.editPlanSnapshotId, parentArtifactId, sourceSha256: source.sha256, rightsSnapshotId: item.rights.snapshotId!, ...(item.source.type === 'segment' ? { segmentHash: item.source.segmentHash, semanticRange: item.source.semanticRange, sourceTimeMapping: item.source.sourceTimeMapping } : {}) })
          const actorAuditData = editCommandExternalActorAuditData(input.authenticationAudit, input.workspaceId, command.author)
          const impact = parseMediaLibraryAttachmentImpact((command.payload as { impact: unknown }).impact)
          if (command.id !== commandId || command.workspaceId !== input.workspaceId || command.projectId !== input.projectId || command.baseVersionId !== base.id || command.baseHash !== base.baseHash || command.type !== 'attach-media-library-reference' || command.author.id !== input.authenticationAudit.clientId || impact.commandId !== commandId || impact.resultVersionId !== resultVersionId || impact.baseVersionId !== base.id || impact.preservedEditPlanSnapshotId !== base.editPlanSnapshotId || impact.selectionId !== selectionId || impact.selectionKind !== input.selection.kind || impact.parentArtifactId !== parentArtifactId || impact.sourceSha256 !== source.sha256 || impact.rightsSnapshotId !== item.rights.snapshotId) throw new DomainError('PERSISTENCE_CONFLICT', 'Application Command does not match locked library attachment facts')
          await transaction.v2EditCommand.create({ data: { id: commandId, workspaceId: input.workspaceId, projectId: input.projectId, baseVersionId: base.id, baseHash: base.baseHash, type: 'attach-media-library-reference', scopeJson: stableSerialize(command.scope), payloadJson: stableSerialize(command.payload), actorType: command.author.type, actorId: command.author.id, delegatedUserId: command.author.delegatedUserId, ...actorAuditData, idempotencyKey: input.idempotencyKey, requestFingerprint, createdAt: new Date(input.createdAt) } })
          await transaction.v2ProjectVersion.create({ data: { id: resultVersionId, workspaceId: input.workspaceId, projectId: input.projectId, sequence: base.sequence + 1, parentVersionId: base.id, briefSnapshotId: base.briefSnapshotId, treatmentSnapshotId: base.treatmentSnapshotId, storySnapshotId: base.storySnapshotId, editPlanSnapshotId: base.editPlanSnapshotId, policiesSnapshotId: base.policiesSnapshotId, baseHash: resultVersionHash, createdBy: input.authenticationAudit.clientId, commandId, createdAt: new Date(input.createdAt) } })
          const reference = await transaction.v2MediaLibraryAttachment.create({ data: { id: randomUUID(), workspaceId: input.workspaceId, projectId: input.projectId, selectionKind: input.selection.kind, selectionId, parentArtifactId, sourceSha256: source.sha256, rightsSnapshotId: item.rights.snapshotId!, segmentHash: item.source.type === 'segment' ? item.source.segmentHash : null, semanticRangeJson: item.source.type === 'segment' ? stableSerialize(item.source.semanticRange) : null, sourceTimeMappingJson: item.source.type === 'segment' ? stableSerialize(item.source.sourceTimeMapping) : null, commandId, baseVersionId: base.id, resultVersionId, resultVersionHash, actorContextHash: input.authenticationAudit.contextHash, idempotencyKey: input.idempotencyKey, requestFingerprint, createdAt: new Date(input.createdAt) } })
          const updated = await transaction.v2Project.updateMany({ where: { id: input.projectId, workspaceId: input.workspaceId, currentVersionId: base.id }, data: { currentVersionId: resultVersionId } })
          if (updated.count !== 1) throw new DomainError('VERSION_CONFLICT', 'Project changed during library attachment')
          return resultOf(reference, false)
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
