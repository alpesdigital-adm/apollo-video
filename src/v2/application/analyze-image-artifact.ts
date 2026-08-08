import { createHash } from 'node:crypto'

import { createImageAnalysis } from '../domain/image-analysis.ts'
import { createMediaArtifactManifestV2 } from '../domain/media-artifact.ts'
import { DomainError } from '../domain/errors.ts'
import type { ImageAnalysisProcessor } from './ports/image-analysis.ts'
import type { ImageAnalysisRepository } from './ports/image-analysis-repository.ts'
import type { MediaArtifactPersistenceRepository } from './ports/media-artifact-repository.ts'
import type { ArtifactFileIntegrity, VerifiedMediaStorage } from './ports/media-ingest.ts'

export function analyzeImageArtifactService(dependencies: { processor: ImageAnalysisProcessor; repository: ImageAnalysisRepository; artifacts: MediaArtifactPersistenceRepository; storage: VerifiedMediaStorage; integrity: ArtifactFileIntegrity; clock?: () => Date }) {
  return async (input: { operationId: string; workspaceId: string; artifactId: string; manifestId: string; artifactKey: string; sourcePath: string; sourceSha256: string; signal?: AbortSignal }) => {
    const existing = await dependencies.repository.find(input.workspaceId, input.artifactId); if (existing) return Object.freeze({ analysis: existing, replayed: true })
    const before = await dependencies.integrity.sha256(input.sourcePath); if (before !== input.sourceSha256) throw new DomainError('PERSISTENCE_CONFLICT', 'Image analysis source checksum is invalid')
    try {
      const result = await dependencies.processor.analyze({ operationId: input.operationId, sourcePath: input.sourcePath, signal: input.signal })
      if (await dependencies.integrity.sha256(input.sourcePath) !== input.sourceSha256) throw new DomainError('PERSISTENCE_CONFLICT', 'Image analysis mutated its immutable source')
      const thumbnail = await dependencies.storage.promoteDerived({ workspaceId: input.workspaceId, sourcePath: result.thumbnail.path, sha256: result.thumbnail.sha256, extension: 'webp', prefix: 'image-thumbnails' })
      const preview = await dependencies.storage.promoteDerived({ workspaceId: input.workspaceId, sourcePath: result.preview.path, sha256: result.preview.sha256, extension: 'webp', prefix: 'image-previews' })
      const namespace = createHash('sha256').update(input.workspaceId).digest('hex').slice(0, 12); const toolDigest = createHash('sha256').update('apollo-v2-sharp-image-analysis/1.0.0').digest('hex')
      const persistDerivative = async (kind: 'thumbnail' | 'preview', stored: typeof thumbnail, dimensions: { width: number; height: number }) => {
        const manifest = createMediaArtifactManifestV2({ artifactKey: stored.key, artifactSha256: stored.sha256, byteSize: stored.byteSize, mediaType: 'image', container: 'webp', recipe: { id: `image-${kind}`, version: '1.0.0', parameters: { fit: 'inside', maxDimension: kind === 'thumbnail' ? 320 : 1280, width: dimensions.width, height: dimensions.height, immutableOriginal: true } }, sources: [{ artifactKey: input.artifactKey, sha256: input.sourceSha256, role: 'source-master', execution: { tool: { id: 'sharp', version: '0.35.3', digest: toolDigest } } }] })
        const artifactId = `artifact-${kind}-${namespace}-${stored.sha256}`; const manifestId = `manifest-${kind}-${namespace}-${manifest.manifestHash}`
        await dependencies.artifacts.persistOrReplay({ workspaceId: input.workspaceId, artifactId, manifestId, lineageIds: [`lineage-${kind}-${namespace}-${manifest.manifestHash}`], manifest, createdAt: (dependencies.clock?.() ?? new Date()).toISOString() })
        return Object.freeze({ artifactId, manifestId })
      }
      const [thumbnailIdentity, previewIdentity] = await Promise.all([persistDerivative('thumbnail', thumbnail, { width: result.thumbnail.width, height: result.thumbnail.height }), persistDerivative('preview', preview, { width: result.preview.width, height: result.preview.height })])
      const identityHash = createHash('sha256').update(`${input.workspaceId}:${input.artifactId}:${input.manifestId}:${input.sourceSha256}`).digest('hex')
      const analysis = createImageAnalysis({ id: `image-analysis-${identityHash.slice(0, 48)}`, workspaceId: input.workspaceId, artifactId: input.artifactId, manifestId: input.manifestId, sourceSha256: input.sourceSha256, dimensions: { width: result.width, height: result.height }, dominantColors: result.dominantColors, ocr: result.ocr, faces: result.faces, objects: result.objects, observedDescription: result.observedDescription, inferredTags: result.inferredTags, derivatives: { thumbnailArtifactId: thumbnailIdentity.artifactId, previewArtifactId: previewIdentity.artifactId, immutableOriginal: true }, createdAt: (dependencies.clock?.() ?? new Date()).toISOString() })
      return dependencies.repository.persist(analysis)
    } finally { await dependencies.processor.cleanup(input.operationId) }
  }
}

export function readImageAnalysisService(dependencies: { repository: ImageAnalysisRepository }) {
  return async (workspaceId: string, artifactId: string) => {
    const analysis = await dependencies.repository.find(workspaceId.trim(), artifactId.trim())
    if (!analysis) throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Image analysis was not found')
    return analysis
  }
}
