import { createHash } from 'node:crypto'

import { createMediaArtifactManifestV2 } from '../domain/media-artifact.ts'
import { DomainError } from '../domain/errors.ts'
import { materializeSegment } from '../domain/media-segment.ts'
import { segmentDerivativeIdentity } from './media-segments.ts'
import type { MediaArtifactPersistenceRepository } from './ports/media-artifact-repository.ts'
import type { ArtifactFileIntegrity, ArtifactSourceMaterializer, VerifiedMediaStorage } from './ports/media-ingest.ts'
import type { MediaSegmentExtractor } from './ports/media-segment-extractor.ts'
import type { MediaSegmentRepository } from './ports/media-segment-repository.ts'

export function materializeMediaSegmentDerivativeService(dependencies: {
  repository: MediaSegmentRepository; artifacts: MediaArtifactPersistenceRepository; sources: ArtifactSourceMaterializer
  storage: VerifiedMediaStorage; extractor: MediaSegmentExtractor; integrity: ArtifactFileIntegrity; clock?: () => Date
}) {
  return async (input: { workspaceId: string; segmentId: string; consumerKey: string; requiresPhysicalDerivative: boolean; signal?: AbortSignal }) => {
    const workspaceId = input.workspaceId.trim(); const segmentId = input.segmentId.trim(); const consumerKey = input.consumerKey.trim().toLowerCase()
    const segment = await dependencies.repository.find(workspaceId, segmentId)
    if (!segment) throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Media segment was not found')
    const recipe = materializeSegment(segment, { key: consumerKey, requiresPhysicalDerivative: input.requiresPhysicalDerivative })
    if (!recipe) return Object.freeze({ segmentId, physicalDerivative: null, sourceImmutable: true as const })
    const replay = await dependencies.repository.findMaterialization(workspaceId, segmentId, consumerKey)
    if (replay) return Object.freeze({ ...replay, sourceImmutable: true as const })
    const source = await dependencies.repository.readSource(workspaceId, segment.parentAssetId)
    if (!source) throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Segment source artifact was not found')
    if (source.mediaType !== 'video') throw new DomainError('INVALID_ARGUMENT', 'Physical segment extraction currently requires a video source')
    const identity = segmentDerivativeIdentity({ workspaceId, segmentId, consumerKey, sourceSha256: source.sha256 })
    const operationId = `extract-${createHash('sha256').update(`${workspaceId}:${segmentId}:${consumerKey}`).digest('hex').slice(0, 32)}`
    try {
      const materialized = await dependencies.sources.materialize({ operationId, artifactKey: source.artifactKey, sha256: source.sha256, byteSize: source.byteSize })
      const before = await dependencies.integrity.sha256(materialized.path)
      const extracted = await dependencies.extractor.extract({ operationId, sourcePath: materialized.path, startMs: segment.semanticRange.startMs, endMs: segment.semanticRange.endMs, signal: input.signal })
      const after = await dependencies.integrity.sha256(materialized.path)
      if (before !== source.sha256 || after !== source.sha256) throw new DomainError('PERSISTENCE_CONFLICT', 'Segment extraction mutated its immutable source')
      const stored = await dependencies.storage.promoteDerived({ workspaceId, sourcePath: extracted.outputPath, sha256: extracted.sha256, extension: 'mp4', prefix: 'segments' })
      const toolDigest = createHash('sha256').update('apollo-v2-ffmpeg-extract-range/1.0.0').digest('hex')
      const manifest = createMediaArtifactManifestV2({ artifactKey: stored.key, artifactSha256: stored.sha256, byteSize: stored.byteSize, mediaType: 'video', container: 'mp4', recipe: { id: 'extract-range', version: '1.0.0', parameters: { segmentId, segmentHash: segment.segmentHash, consumerKey, sourceRangeMs: recipe.sourceRangeMs, sourceImmutable: true } }, sources: [{ artifactKey: source.artifactKey, sha256: source.sha256, role: 'source-master', execution: { tool: { id: 'ffmpeg', version: 'static', digest: toolDigest } } }], probe: extracted.probe })
      await dependencies.artifacts.persistOrReplay({ workspaceId, artifactId: identity.artifactId, manifestId: identity.manifestId, lineageIds: [`lineage-${createHash('sha256').update(`${workspaceId}:${identity.manifestId}:${source.artifactId}`).digest('hex')}`], manifest, createdAt: (dependencies.clock?.() ?? new Date()).toISOString() })
      const record = await dependencies.repository.recordMaterialization({ workspaceId, id: identity.materializationId, segmentId, consumerKey, outputArtifactId: identity.artifactId, outputManifestId: identity.manifestId, sourceArtifactSha256: source.sha256, createdAt: (dependencies.clock?.() ?? new Date()).toISOString() })
      return Object.freeze({ ...record, sourceImmutable: true as const })
    } finally { await Promise.allSettled([dependencies.extractor.cleanup(operationId), dependencies.sources.cleanup(operationId)]) }
  }
}
