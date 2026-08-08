import type { PrismaClient, V2MediaSegment } from '../../../../generated/prisma-v2/index.js'

import type { MediaSegmentRepository } from '../../application/ports/media-segment-repository.ts'
import { calculateCanonicalHash } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import type { MediaSegment } from '../../domain/media-segment.ts'

function durationFromManifest(manifestJson: string): number {
  let parsed: unknown
  try { parsed = JSON.parse(manifestJson) } catch { throw new DomainError('PERSISTENCE_CONFLICT', 'Stored source manifest JSON is invalid') }
  const probe = typeof parsed === 'object' && parsed !== null ? (parsed as { probe?: unknown }).probe : undefined
  const duration = typeof probe === 'object' && probe !== null ? (probe as { duration?: unknown }).duration : undefined
  const durationMs = typeof duration === 'number' ? Math.round(duration * 1000) : 0
  if (!Number.isSafeInteger(durationMs) || durationMs < 1) throw new DomainError('PERSISTENCE_CONFLICT', 'Segment source requires trusted duration metadata')
  return durationMs
}

function mapSegment(row: V2MediaSegment): Readonly<MediaSegment> {
  const semanticRange = Object.freeze({ startMs: row.startMs, endMs: row.endMs })
  const sourceTimeMapping = Object.freeze({ sourceStartMs: row.startMs, sourceEndMs: row.endMs, rate: 1 as const })
  const content = { schemaVersion: 'media-segment/v1', workspaceId: row.workspaceId, parentAssetId: row.artifactId, ...(row.parentSegmentId ? { parentSegmentId: row.parentSegmentId } : {}), label: row.label, description: row.description, semanticRange, sourceTimeMapping, sourceDurationMs: row.sourceDurationMs }
  if (row.physicalObjectKey !== null || calculateCanonicalHash(content) !== row.segmentHash || row.startMs < 0 || row.endMs <= row.startMs || row.endMs > row.sourceDurationMs) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored media segment failed integrity validation')
  return Object.freeze({ id: row.id, workspaceId: row.workspaceId, parentAssetId: row.artifactId, ...(row.parentSegmentId ? { parentSegmentId: row.parentSegmentId } : {}), label: row.label, description: row.description, semanticRange, sourceTimeMapping, physicalObjectKey: null, sourceDurationMs: row.sourceDurationMs, segmentHash: row.segmentHash, createdAt: row.createdAt.toISOString() })
}

export class PrismaMediaSegmentRepository implements MediaSegmentRepository {
  private readonly client: PrismaClient
  constructor(client: PrismaClient) { this.client = client }

  async readSource(workspaceId: string, artifactId: string) {
    const row = await this.client.v2MediaArtifact.findFirst({ where: { workspaceId, id: artifactId, status: 'available', mediaType: { in: ['video', 'audio'] } }, include: { manifests: { orderBy: { createdAt: 'desc' }, take: 1 } } })
    const manifest = row?.manifests[0]
    if (!row || !manifest) return null
    return Object.freeze({ artifactId: row.id, artifactKey: row.artifactKey, sha256: row.sha256, byteSize: Number(row.byteSize), mediaType: row.mediaType as 'video' | 'audio', container: row.container, durationMs: durationFromManifest(manifest.manifestJson) })
  }

  async find(workspaceId: string, segmentId: string) {
    const row = await this.client.v2MediaSegment.findFirst({ where: { workspaceId, id: segmentId } })
    if (!row) return null
    const mapped = mapSegment(row)
    if (!row.parentSegmentId) return mapped
    const parent = await this.client.v2MediaSegment.findFirst({ where: { workspaceId, id: row.parentSegmentId } })
    if (!parent || parent.artifactId !== row.artifactId || row.startMs < parent.startMs || row.endMs > parent.endMs) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored nested media segment is inconsistent')
    return mapped
  }

  async list(workspaceId: string, artifactId: string) {
    const rows = await this.client.v2MediaSegment.findMany({ where: { workspaceId, artifactId }, orderBy: [{ startMs: 'asc' }, { endMs: 'asc' }, { id: 'asc' }] })
    return Object.freeze(rows.map(mapSegment))
  }

  async create(segment: Readonly<MediaSegment>) {
    return this.client.$transaction(async (transaction) => {
      const artifact = await transaction.v2MediaArtifact.findFirst({ where: { workspaceId: segment.workspaceId, id: segment.parentAssetId, status: 'available', mediaType: { in: ['video', 'audio'] } }, include: { manifests: { orderBy: { createdAt: 'desc' }, take: 1 } } })
      if (!artifact?.manifests[0] || durationFromManifest(artifact.manifests[0].manifestJson) !== segment.sourceDurationMs) throw new DomainError('PERSISTENCE_CONFLICT', 'Segment source changed or is unavailable')
      if (segment.parentSegmentId) {
        const parent = await transaction.v2MediaSegment.findFirst({ where: { workspaceId: segment.workspaceId, id: segment.parentSegmentId } })
        if (!parent || parent.artifactId !== segment.parentAssetId || segment.semanticRange.startMs < parent.startMs || segment.semanticRange.endMs > parent.endMs) throw new DomainError('PERSISTENCE_CONFLICT', 'Nested segment no longer fits its parent')
      }
      const existing = await transaction.v2MediaSegment.findFirst({ where: { workspaceId: segment.workspaceId, artifactId: segment.parentAssetId, segmentHash: segment.segmentHash } })
      if (existing) return Object.freeze({ segment: mapSegment(existing), replayed: true })
      const created = await transaction.v2MediaSegment.create({ data: { id: segment.id, workspaceId: segment.workspaceId, artifactId: segment.parentAssetId, parentSegmentId: segment.parentSegmentId ?? null, label: segment.label, description: segment.description, startMs: segment.semanticRange.startMs, endMs: segment.semanticRange.endMs, sourceDurationMs: segment.sourceDurationMs, physicalObjectKey: null, segmentHash: segment.segmentHash, createdAt: new Date(segment.createdAt) } })
      return Object.freeze({ segment: mapSegment(created), replayed: false })
    }, { isolationLevel: 'Serializable' })
  }

  async findMaterialization(workspaceId: string, segmentId: string, consumerKey: string) {
    const row = await this.client.v2MediaSegmentMaterialization.findFirst({ where: { workspaceId, segmentId, consumerKey } })
    return row ? Object.freeze({ segmentId: row.segmentId, consumerKey: row.consumerKey, outputArtifactId: row.outputArtifactId, outputManifestId: row.outputManifestId, replayed: true }) : null
  }

  async recordMaterialization(input: { workspaceId: string; id: string; segmentId: string; consumerKey: string; outputArtifactId: string; outputManifestId: string; sourceArtifactSha256: string; createdAt: string }) {
    return this.client.$transaction(async (transaction) => {
      let replayed = true
      let row = await transaction.v2MediaSegmentMaterialization.findUnique({ where: { workspaceId_segmentId_consumerKey: { workspaceId: input.workspaceId, segmentId: input.segmentId, consumerKey: input.consumerKey } } })
      if (!row) { row = await transaction.v2MediaSegmentMaterialization.create({ data: { ...input, recipe: 'extract-range/v1', createdAt: new Date(input.createdAt) } }); replayed = false }
      const expectedHash = calculateCanonicalHash({ segmentId: input.segmentId, consumerKey: input.consumerKey, outputArtifactId: input.outputArtifactId, outputManifestId: input.outputManifestId, sourceArtifactSha256: input.sourceArtifactSha256 })
      const actualHash = calculateCanonicalHash({ segmentId: row.segmentId, consumerKey: row.consumerKey, outputArtifactId: row.outputArtifactId, outputManifestId: row.outputManifestId, sourceArtifactSha256: row.sourceArtifactSha256 })
      if (expectedHash !== actualHash || row.recipe !== 'extract-range/v1') throw new DomainError('PERSISTENCE_CONFLICT', 'Segment materialization replay collided')
      return Object.freeze({ segmentId: row.segmentId, consumerKey: row.consumerKey, outputArtifactId: row.outputArtifactId, outputManifestId: row.outputManifestId, replayed })
    }, { isolationLevel: 'Serializable' })
  }
}
