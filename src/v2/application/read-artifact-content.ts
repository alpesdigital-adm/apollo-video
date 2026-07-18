import { DomainError } from '../domain/errors.ts'
import type { ArtifactContentStorage, ArtifactByteRange } from './ports/artifact-content-storage.ts'
import type { MediaArtifactQueryRepository } from './ports/media-artifact-query-repository.ts'

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', flac: 'audio/flac',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
})

function parseRange(value: string | null, total: number): ArtifactByteRange | undefined {
  if (!value) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!match || (!match[1] && !match[2])) {
    throw new DomainError('MEDIA_RANGE_NOT_SATISFIABLE', 'Requested media byte range is invalid')
  }
  let start: number
  let end: number
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new DomainError('MEDIA_RANGE_NOT_SATISFIABLE', 'Requested media suffix range is invalid')
    start = Math.max(0, total - suffix)
    end = total - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Number(match[2]) : total - 1
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= total || end < start) {
    throw new DomainError('MEDIA_RANGE_NOT_SATISFIABLE', 'Requested media byte range cannot be satisfied')
  }
  return { start, end: Math.min(end, total - 1) }
}

export function readArtifactContentService(dependencies: {
  artifacts: MediaArtifactQueryRepository
  storage: ArtifactContentStorage
}) {
  return async function read(input: { workspaceId: string; artifactId: string; rangeHeader: string | null }) {
    const artifact = await dependencies.artifacts.findById(input.workspaceId, input.artifactId.trim())
    if (!artifact || artifact.status !== 'available') throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Media artifact content was not found')
    if (artifact.byteSize > BigInt(Number.MAX_SAFE_INTEGER)) throw new DomainError('PERSISTENCE_CONFLICT', 'Media artifact is too large to stream safely')
    const total = Number(artifact.byteSize)
    const range = parseRange(input.rangeHeader, total)
    const content = await dependencies.storage.open({ artifactKey: artifact.artifactKey, expectedByteSize: artifact.byteSize, ...(range ? { range } : {}) })
    return Object.freeze({
      ...content,
      totalByteSize: total,
      partial: Boolean(range),
      contentType: CONTENT_TYPES[artifact.container] ?? 'application/octet-stream',
      etag: `"sha256-${artifact.sha256}"`,
    })
  }
}
