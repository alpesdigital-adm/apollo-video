import type { MediaArtifactManifest } from '../../domain/media-artifact.ts'
import type { MediaTranscript } from '../../domain/media-transcript.ts'
import type { MediaUpload, MediaUploadPart } from '../../domain/media-transfer.ts'

export interface NormalizedIngestMedia {
  proxyPath: string
  audioPath: string
  proxySha256: string
  proxyByteSize: number
  probe: { width: number; height: number; duration: number; fps: number; codec: string; container: string }
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
  readProject(input: { workspaceId: string; projectId: string }): Promise<Readonly<{ id: string; locale: string }> | null>
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
    createdAt: string
  }): Promise<void>
  markIngestFailed(input: { workspaceId: string; projectId: string }): Promise<void>
}
