import type { MediaArtifactManifest } from '../../domain/media-artifact.ts'
import type { MediaTranscript } from '../../domain/media-transcript.ts'
import type { MediaUpload, MediaUploadPart } from '../../domain/media-transfer.ts'
import type {
  DetectedMediaColor,
  MediaColorProbe,
} from '../../domain/color-and-export.ts'
import type { ProjectSnapshot } from '../../domain/project-snapshot.ts'
import type { ProjectVersion } from '../../domain/project-version.ts'
import type { PublicEvent } from '../../domain/public-event.ts'

export interface MediaIngestProbe {
  width: number
  height: number
  fps: number
  duration: number
  codec: string
  audioCodec: string
  container: string
  color: DetectedMediaColor
  producer: Readonly<{
    provider: 'ffprobe'
    version: 'json-v1'
    binaryDigest: string
  }>
}

export interface NormalizedIngestMedia {
  proxyPath: string
  audioPath: string
  proxySha256: string
  proxyByteSize: number
  probe: MediaIngestProbe
}

export interface MediaIngestProcessor {
  normalize(input: { sourcePath: string; operationId: string; signal?: AbortSignal }): Promise<Readonly<NormalizedIngestMedia>>
  cleanup(operationId: string): Promise<void>
}

export interface MediaTranscriber {
  transcribe(input: { audioPath: string; language: string; signal?: AbortSignal }): Promise<Readonly<MediaTranscript>>
}

export interface VerifiedMediaStorage {
  promoteMaster(upload: Readonly<MediaUpload>, parts?: readonly Readonly<MediaUploadPart>[]): Promise<Readonly<{ key: string; path: string; byteSize: number; sha256: string }>>
  promoteDerived(input: { workspaceId: string; sourcePath: string; sha256: string; extension: string; prefix: string }): Promise<Readonly<{ key: string; path: string; byteSize: number; sha256: string }>>
}

export interface ProjectMediaRepository {
  readProject(input: { workspaceId: string; projectId: string }): Promise<Readonly<{
    id: string
    locale: string
    currentVersion: Readonly<ProjectVersion>
  }> | null>
  persistCompletedIngest(input: {
    workspaceId: string
    projectId: string
    uploadId: string
    originalFileName: string
    sourceArtifactId: string
    sourceManifestId: string
    proxyArtifactId: string
    proxyManifestId: string
    transcriptId: string
    transcript: Readonly<MediaTranscript>
    sourceManifest: Readonly<MediaArtifactManifest>
    proxyManifest: Readonly<MediaArtifactManifest>
    sourceColorProbe: Readonly<MediaColorProbe>
    proxyColorProbe: Readonly<MediaColorProbe>
    initialPlan: Readonly<{
      snapshot: Readonly<ProjectSnapshot>
      version: Readonly<ProjectVersion>
      event: Readonly<PublicEvent>
    }>
    createdAt: string
  }): Promise<void>
  markIngestFailed(input: { workspaceId: string; projectId: string }): Promise<void>
}
