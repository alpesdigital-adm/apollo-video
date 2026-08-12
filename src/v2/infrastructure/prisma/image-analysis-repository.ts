import { randomUUID } from 'node:crypto'

import type { Prisma, PrismaClient, V2ImageAnalysis, V2ImageReuseReference } from '../../../../generated/prisma-v2/index.js'

import type { ImageAnalysisRepository } from '../../application/ports/image-analysis-repository.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { evaluateAssetUse } from '../../domain/asset-rights.ts'
import { DomainError } from '../../domain/errors.ts'
import { createImageAnalysis, type ImageAnalysis } from '../../domain/image-analysis.ts'
import {
  imageReuseLineage,
  normalizeImageReuseSearchQuery,
  rankReusableImages,
  type ImageReuseReference,
  type ImageReuseSearchQuery,
} from '../../domain/image-library.ts'
import { mediaLibrarySearchField } from '../../domain/media-library.ts'
import { hydrateAssetRights } from './asset-rights-repository.ts'

function map(row: V2ImageAnalysis): Readonly<ImageAnalysis> {
  let value: Omit<ImageAnalysis, 'analysisHash'>
  try { value = JSON.parse(row.analysisJson) as Omit<ImageAnalysis, 'analysisHash'> } catch { throw new DomainError('PERSISTENCE_CONFLICT', 'Stored image analysis JSON is invalid') }
  const analysis = createImageAnalysis(value)
  if (analysis.analysisHash !== row.analysisHash || analysis.id !== row.id || analysis.workspaceId !== row.workspaceId || analysis.artifactId !== row.artifactId || analysis.manifestId !== row.manifestId || analysis.sourceSha256 !== row.sourceSha256 || analysis.derivatives.thumbnailArtifactId !== row.thumbnailArtifactId || analysis.derivatives.previewArtifactId !== row.previewArtifactId) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored image analysis failed integrity validation')
  return analysis
}

type SearchRow = Prisma.V2ImageAnalysisGetPayload<{
  include: { artifact: { include: { currentRightsSnapshot: true; libraryEntry: true } } }
}>

function authorizedCandidate(row: SearchRow, now: Date, locale: string) {
  if (row.workspaceId !== row.artifact.workspaceId || row.artifact.mediaType !== 'image' || row.artifact.status !== 'available' || !row.artifact.libraryEntry) return null
  const rights = row.artifact.currentRightsSnapshot ? hydrateAssetRights(row.artifact.currentRightsSnapshot) : null
  const decision = evaluateAssetUse(rights, { workspaceId: row.workspaceId, locale, use: 'editorial-reuse' }, now)
  if (decision.outcome !== 'allow' || !decision.rightsSnapshotId || !decision.rightsSnapshotHash || !decision.validUntil) return null
  return Object.freeze({
    analysis: map(row),
    label: row.artifact.libraryEntry.label,
    rightsSnapshotId: decision.rightsSnapshotId,
    rightsSnapshotHash: decision.rightsSnapshotHash,
    rightsValidUntil: decision.validUntil,
  })
}

function mapReuse(row: V2ImageReuseReference, replayed: boolean): Readonly<ImageReuseReference> {
  const usage = row.usage as ImageReuseReference['usage']
  if (!['b-roll', 'insert', 'card'].includes(usage) || !Number.isFinite(row.score) || row.score < 0 || row.score > 1) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored image reuse reference is invalid')
  const body = {
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    artifactId: row.artifactId,
    manifestId: row.manifestId,
    mediaAssetReferenceId: row.mediaAssetReferenceId,
    analysisId: row.analysisId,
    analysisHash: row.analysisHash,
    rightsSnapshotId: row.rightsSnapshotId,
    rightsSnapshotHash: row.rightsSnapshotHash,
    usage,
    query: row.query,
    score: row.score,
  }
  if (imageReuseLineage(body) !== row.lineageHash || row.id !== `image-reuse-${row.lineageHash.slice(0, 48)}`) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored image reuse lineage failed integrity validation')
  return Object.freeze({ schemaVersion: 'image-reuse-reference/v1', id: row.id, ...body, bytesDuplicated: false, lineageHash: row.lineageHash, replayed, createdAt: row.createdAt.toISOString() })
}

export class PrismaImageAnalysisRepository implements ImageAnalysisRepository {
  private readonly client: PrismaClient
  constructor(client: PrismaClient) { this.client = client }
  async find(workspaceId: string, artifactId: string) { const row = await this.client.v2ImageAnalysis.findFirst({ where: { workspaceId, artifactId } }); return row ? map(row) : null }
  async persist(analysis: Readonly<ImageAnalysis>) {
    return this.client.$transaction(async (transaction) => {
      const existing = await transaction.v2ImageAnalysis.findUnique({ where: { workspaceId_artifactId_manifestId: { workspaceId: analysis.workspaceId, artifactId: analysis.artifactId, manifestId: analysis.manifestId } } })
      if (existing) { const current = map(existing); if (current.analysisHash !== analysis.analysisHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Image analysis replay collided'); return Object.freeze({ analysis: current, replayed: true }) }
      const [source, manifest, thumbnail, preview] = await Promise.all([
        transaction.v2MediaArtifact.findFirst({ where: { id: analysis.artifactId, workspaceId: analysis.workspaceId, mediaType: 'image', status: 'available', sha256: analysis.sourceSha256 } }),
        transaction.v2MediaArtifactManifest.findFirst({ where: { id: analysis.manifestId, artifactId: analysis.artifactId, workspaceId: analysis.workspaceId } }),
        transaction.v2MediaArtifact.findFirst({ where: { id: analysis.derivatives.thumbnailArtifactId, workspaceId: analysis.workspaceId, mediaType: 'image', status: 'available' } }),
        transaction.v2MediaArtifact.findFirst({ where: { id: analysis.derivatives.previewArtifactId, workspaceId: analysis.workspaceId, mediaType: 'image', status: 'available' } }),
      ])
      if (!source || !manifest || !thumbnail || !preview) throw new DomainError('PERSISTENCE_CONFLICT', 'Image analysis references are incomplete')
      const { analysisHash: _hash, ...content } = analysis
      const created = await transaction.v2ImageAnalysis.create({ data: { id: analysis.id, workspaceId: analysis.workspaceId, artifactId: analysis.artifactId, manifestId: analysis.manifestId, sourceSha256: analysis.sourceSha256, analysisJson: stableSerialize(content), analysisHash: analysis.analysisHash, thumbnailArtifactId: analysis.derivatives.thumbnailArtifactId, previewArtifactId: analysis.derivatives.previewArtifactId, createdAt: new Date(analysis.createdAt) } })
      const topics = mediaLibrarySearchField(analysis.inferredTags.map((tag) => tag.value).filter((value, index, all) => all.indexOf(value) === index).slice(0, 64), 'topics')
      const libraryUpdated = await transaction.v2MediaLibraryEntry.updateMany({ where: { workspaceId: analysis.workspaceId, artifactId: analysis.artifactId }, data: { thumbnailArtifactId: analysis.derivatives.thumbnailArtifactId, topicsJson: stableSerialize(topics.values), topicsSearch: topics.search } })
      if (libraryUpdated.count !== 1) throw new DomainError('PERSISTENCE_CONFLICT', 'Image analysis library entry is missing or ambiguous')
      return Object.freeze({ analysis: map(created), replayed: false })
    }, { isolationLevel: 'Serializable' })
  }

  async searchReusable(rawQuery: ImageReuseSearchQuery, now: Date) {
    const query = normalizeImageReuseSearchQuery(rawQuery)
    const rows = await this.client.$transaction((transaction) => transaction.v2ImageAnalysis.findMany({
      where: { workspaceId: query.workspaceId, artifact: { mediaType: 'image', status: 'available', libraryEntry: { isNot: null } } },
      include: { artifact: { include: { currentRightsSnapshot: true, libraryEntry: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 500,
    }), { isolationLevel: 'RepeatableRead' })
    const candidates = rows.map((row) => authorizedCandidate(row, now, 'pt-BR')).filter((candidate) => candidate !== null)
    return rankReusableImages(query, candidates)
  }

  async reuse(input: { workspaceId: string; projectId: string; artifactId: string; usage: ImageReuseSearchQuery['usage']; text: string; createdAt: string }) {
    const query = normalizeImageReuseSearchQuery({ workspaceId: input.workspaceId, text: input.text, usage: input.usage, limit: 1 })
    const createdAt = new Date(input.createdAt)
    if (Number.isNaN(createdAt.getTime())) throw new DomainError('INVALID_ARGUMENT', 'Image reuse createdAt is invalid')
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.client.$transaction(async (transaction) => {
          const [project, row] = await Promise.all([
            transaction.v2Project.findFirst({ where: { id: input.projectId, workspaceId: query.workspaceId }, select: { id: true, locale: true } }),
            transaction.v2ImageAnalysis.findFirst({
              where: { workspaceId: query.workspaceId, artifactId: input.artifactId },
              include: { artifact: { include: { currentRightsSnapshot: true, libraryEntry: true } } },
            }),
          ])
          if (!project) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found')
          if (!row) throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Reusable image analysis was not found')
          const authorized = authorizedCandidate(row, createdAt, project.locale ?? 'pt-BR')
          if (!authorized) throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Image is not currently eligible for editorial reuse')
          const ranked = rankReusableImages(query, [authorized])[0]
          if (!ranked) throw new DomainError('ASSET_NOT_USABLE', 'Image does not match the requested reuse query')
          const existingAsset = await transaction.v2ProjectMediaAsset.findUnique({ where: { projectId_artifactId_role: { projectId: input.projectId, artifactId: input.artifactId, role: 'selected-insert' } } })
          const mediaAsset = existingAsset ?? await transaction.v2ProjectMediaAsset.create({ data: {
            id: randomUUID(), workspaceId: query.workspaceId, projectId: input.projectId, artifactId: input.artifactId,
            role: 'selected-insert', originalFileName: authorized.label, createdAt,
          } })
          const lineageBody = {
            workspaceId: query.workspaceId,
            projectId: input.projectId,
            artifactId: ranked.artifactId,
            manifestId: ranked.manifestId,
            mediaAssetReferenceId: mediaAsset.id,
            analysisId: ranked.analysisId,
            analysisHash: ranked.analysisHash,
            rightsSnapshotId: ranked.rightsSnapshotId,
            rightsSnapshotHash: ranked.rightsSnapshotHash,
            usage: ranked.usage,
            query: query.text,
            score: ranked.score,
          }
          const lineageHash = imageReuseLineage(lineageBody)
          const existing = await transaction.v2ImageReuseReference.findUnique({ where: { workspaceId_projectId_lineageHash: { workspaceId: query.workspaceId, projectId: input.projectId, lineageHash } } })
          if (existing) return mapReuse(existing, true)
          const reference = await transaction.v2ImageReuseReference.create({ data: {
            id: `image-reuse-${lineageHash.slice(0, 48)}`, ...lineageBody, lineageHash, createdAt,
          } })
          return mapReuse(reference, false)
        }, { isolationLevel: 'Serializable' as Prisma.TransactionIsolationLevel })
      } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
        if (attempt < 3 && (code === 'P2034' || code === 'P2002')) continue
        throw error
      }
    }
    throw new DomainError('PERSISTENCE_CONFLICT', 'Image reuse could not be serialized')
  }
}
