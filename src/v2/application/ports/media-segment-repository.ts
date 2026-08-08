import type { MediaSegment } from '../../domain/media-segment.ts'

export interface MediaSegmentSource {
  artifactId: string
  artifactKey: string
  sha256: string
  byteSize: number
  mediaType: 'video' | 'audio'
  container: string
  durationMs: number
}

export interface MediaSegmentMaterializationRecord {
  segmentId: string
  consumerKey: string
  outputArtifactId: string
  outputManifestId: string
  replayed: boolean
}

export interface MediaSegmentRepository {
  readSource(workspaceId: string, artifactId: string): Promise<Readonly<MediaSegmentSource> | null>
  find(workspaceId: string, segmentId: string): Promise<Readonly<MediaSegment> | null>
  list(workspaceId: string, artifactId: string): Promise<readonly Readonly<MediaSegment>[]>
  create(segment: Readonly<MediaSegment>): Promise<Readonly<{ segment: Readonly<MediaSegment>; replayed: boolean }>>
  findMaterialization(workspaceId: string, segmentId: string, consumerKey: string): Promise<Readonly<MediaSegmentMaterializationRecord> | null>
  recordMaterialization(input: Omit<MediaSegmentMaterializationRecord, 'replayed'> & {
    workspaceId: string; id: string; sourceArtifactSha256: string; createdAt: string
  }): Promise<Readonly<MediaSegmentMaterializationRecord>>
}
