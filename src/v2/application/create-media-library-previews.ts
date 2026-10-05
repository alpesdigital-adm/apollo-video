import { createHash, randomUUID } from 'node:crypto'
import { DomainError } from '../domain/errors.ts'
import { createMediaArtifactManifestV2 } from '../domain/media-artifact.ts'
import type { MediaArtifactPersistenceRepository } from './ports/media-artifact-repository.ts'
import type { ArtifactFileIntegrity, VerifiedMediaStorage } from './ports/media-ingest.ts'

export interface MediaLibraryPreviewProcessor {
  generate(input: { operationId: string; sourcePath: string; mediaType: 'video' | 'audio'; signal?: AbortSignal }): Promise<readonly Readonly<{
    kind: 'thumbnail' | 'waveform'; path: string; sha256: string; byteSize: number; width: number; height: number
    tool: Readonly<{ id: 'ffmpeg'; version: string; digest: string }>
  }>[]>
  cleanup(operationId: string): Promise<void>
}
export interface MediaLibraryPreviewRepository {
  find(workspaceId: string, artifactId: string): Promise<Readonly<{ thumbnailArtifactId: string | null; waveformArtifactId: string | null }> | null>
  publish(input: { operationId: string; leaseOwner: string; attempt: number; workspaceId: string; artifactId: string; label: string; thumbnailArtifactId?: string; waveformArtifactId?: string; createdAt: string; signal?: AbortSignal }): Promise<void>
}
export function createMediaLibraryPreviewsService(dependencies: {
  processor: MediaLibraryPreviewProcessor; repository: MediaLibraryPreviewRepository; artifacts: MediaArtifactPersistenceRepository; storage: VerifiedMediaStorage; integrity: ArtifactFileIntegrity; clock?: () => Date
}) {
  return async (input: { operationId: string; leaseOwner: string; attempt: number; assertActive?: () => Promise<void>; workspaceId: string; artifactId: string; artifactKey: string; sourcePath: string; sourceSha256: string; mediaType: 'video' | 'audio'; label: string; signal?: AbortSignal }) => {
    const executionId = `preview-${randomUUID()}`
    const assertActive = async () => {
      if (input.signal?.aborted) throw new DomainError('RENDER_EXECUTION_FAILED', 'Preview generation was cancelled')
      await input.assertActive?.()
      if (input.signal?.aborted) throw new DomainError('RENDER_EXECUTION_FAILED', 'Preview generation was cancelled')
    }
    await assertActive()
    const existing = await dependencies.repository.find(input.workspaceId, input.artifactId)
    await assertActive()
    if (input.mediaType === 'audio' ? existing?.waveformArtifactId : existing?.thumbnailArtifactId) return { replayed: true }
    if (await dependencies.integrity.sha256(input.sourcePath) !== input.sourceSha256) throw new DomainError('PERSISTENCE_CONFLICT', 'Preview source checksum is invalid')
    try {
      await assertActive()
      const outputs = await dependencies.processor.generate({ ...input, operationId: executionId })
      await assertActive()
      if (await dependencies.integrity.sha256(input.sourcePath) !== input.sourceSha256) throw new DomainError('PERSISTENCE_CONFLICT', 'Preview generation mutated the original')
      await assertActive()
      const identities: { thumbnailArtifactId?: string; waveformArtifactId?: string } = {}
      const namespace = createHash('sha256').update(input.workspaceId).digest('hex').slice(0, 12)
      for (const output of outputs) {
        await assertActive()
        if (!output.tool || output.tool.id !== 'ffmpeg' || !output.tool.version || output.tool.version === 'static' || !/^[a-f0-9]{64}$/.test(output.tool.digest)) throw new DomainError('RENDER_OUTPUT_INVALID', 'Preview executable provenance is missing or invalid')
        const stored = await dependencies.storage.promoteDerived({ workspaceId: input.workspaceId, sourcePath: output.path, sha256: output.sha256, extension: 'png', prefix: `library-${output.kind}s` })
        await assertActive()
        const manifest = createMediaArtifactManifestV2({ artifactKey: stored.key, artifactSha256: stored.sha256, byteSize: stored.byteSize, mediaType: 'image', container: 'png', recipe: { id: `media-library-${output.kind}`, version: '1.0.0', parameters: { width: output.width, height: output.height, immutableOriginal: true } }, sources: [{ artifactKey: input.artifactKey, sha256: input.sourceSha256, role: 'source-master', execution: { tool: output.tool } }] })
        const artifactId = `preview-${output.kind}-${namespace}-${stored.sha256}`
        const persisted = await dependencies.artifacts.persistOrReplay({ workspaceId: input.workspaceId, artifactId, manifestId: `manifest-${namespace}-${manifest.manifestHash}`, lineageIds: [`lineage-${namespace}-${manifest.manifestHash}`], manifest, createdAt: (dependencies.clock?.() ?? new Date()).toISOString() })
        await assertActive()
        identities[output.kind === 'thumbnail' ? 'thumbnailArtifactId' : 'waveformArtifactId'] = persisted.artifactId
      }
      if (input.mediaType === 'audio' ? !identities.waveformArtifactId : !identities.thumbnailArtifactId) throw new DomainError('RENDER_OUTPUT_INVALID', 'Library preview output is incomplete')
      await assertActive()
      await dependencies.repository.publish({ operationId: input.operationId, leaseOwner: input.leaseOwner, attempt: input.attempt, workspaceId: input.workspaceId, artifactId: input.artifactId, label: input.label, ...identities, createdAt: (dependencies.clock?.() ?? new Date()).toISOString(), signal: input.signal })
      await assertActive()
      return { replayed: false }
    } finally { await dependencies.processor.cleanup(executionId) }
  }
}
