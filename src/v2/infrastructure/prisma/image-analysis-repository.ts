import type { PrismaClient, V2ImageAnalysis } from '../../../../generated/prisma-v2/index.js'

import type { ImageAnalysisRepository } from '../../application/ports/image-analysis-repository.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import { createImageAnalysis, type ImageAnalysis } from '../../domain/image-analysis.ts'
import { mediaLibrarySearchField } from '../../domain/media-library.ts'

function map(row: V2ImageAnalysis): Readonly<ImageAnalysis> {
  let value: Omit<ImageAnalysis, 'analysisHash'>
  try { value = JSON.parse(row.analysisJson) as Omit<ImageAnalysis, 'analysisHash'> } catch { throw new DomainError('PERSISTENCE_CONFLICT', 'Stored image analysis JSON is invalid') }
  const analysis = createImageAnalysis(value)
  if (analysis.analysisHash !== row.analysisHash || analysis.id !== row.id || analysis.workspaceId !== row.workspaceId || analysis.artifactId !== row.artifactId || analysis.manifestId !== row.manifestId || analysis.sourceSha256 !== row.sourceSha256 || analysis.derivatives.thumbnailArtifactId !== row.thumbnailArtifactId || analysis.derivatives.previewArtifactId !== row.previewArtifactId) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored image analysis failed integrity validation')
  return analysis
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
}
