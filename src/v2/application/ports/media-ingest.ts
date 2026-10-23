import type { MediaArtifactManifest } from '../../domain/media-artifact.ts'
import type { MediaTranscript } from '../../domain/media-transcript.ts'
import type { MediaUpload, MediaUploadPart } from '../../domain/media-transfer.ts'
import type {
  DetectedMediaColor,
  MediaColorProbe,
} from '../../domain/color-and-export.ts'

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
  observation:Readonly<MediaNormalizationObservationV3>
}

export interface MediaIngestProcessor {
  normalize(input: { sourcePath: string; operationId: string; owner:Readonly<MediaNormalizationOwnerV3>; signal?: AbortSignal }): Promise<Readonly<NormalizedIngestMedia>>
  observeOriginalAudio(input:{sourcePath:string;operationId:string;owner:Readonly<MediaNormalizationOwnerV3>;signal?:AbortSignal}):Promise<Readonly<MediaNormalizationObservationV3>>
  cleanup(operationId: string): Promise<void>
}

export interface MediaSourceProber {
  probe(sourcePath: string, options?: { signal?: AbortSignal }): Promise<Readonly<MediaIngestProbe>>
}

export interface ArtifactFileIntegrity {
  sha256(filePath: string): Promise<string>
}

export interface MediaTranscriber {
  /**
   * `language` is the project's declared language; without it the provider detects the language of the speech and the transcript records it as
   * detected (`languageBasis`). Nothing is assumed in its place.
   */
  transcribe(input: { audioPath: string; language?: string; signal?: AbortSignal }): Promise<Readonly<MediaTranscript>>
}

export interface VerifiedMediaStorage {
  quarantineSource(upload: Readonly<MediaUpload>, parts?: readonly Readonly<MediaUploadPart>[]): Promise<Readonly<{ path: string; byteSize: number; sha256: string }>>
  promoteMaster(upload: Readonly<MediaUpload>, parts?: readonly Readonly<MediaUploadPart>[]): Promise<Readonly<{ key: string; path: string; byteSize: number; sha256: string }>>
  promoteDerived(input: { workspaceId: string; sourcePath: string; sha256: string; extension: string; prefix: string }): Promise<Readonly<{ key: string; path: string; byteSize: number; sha256: string }>>
}

export interface ArtifactSourceMaterializer {
  materialize(input: {
    operationId: string
    artifactKey: string
    sha256: string
    byteSize: number
    signal?: AbortSignal
  }): Promise<Readonly<{ path: string; sha256: string; byteSize: number }>>
  cleanup(operationId: string): Promise<void>
}

export interface ProjectMediaRepository {
  readIngestRequestFingerprint(input:{workspaceId:string;projectId:string;operationId:string}):Promise<string>
  readProject(input: { workspaceId: string; projectId: string }): Promise<Readonly<{
    id: string
    /** The language the project declares, when it declares one. */
    locale?: string
    currentVersion: Readonly<import('../../domain/project-version.ts').ProjectVersionV3>
    outputBundle:Readonly<import('../../domain/output-version-bundle.ts').OperationalOutputVersionBundleV3>
  }> | null>
  /** Full operational bundle owner publishes plan, facts, head, event and op terminal together. */
  persistCompletedIngest(input:Readonly<import('./output-version-bundle-repository.ts').OperationalOutputBundleWriteV3>):Promise<void>
  persistCatalogedInput(input: {
    workspaceId: string
    projectId: string
    uploadId: string
    originalFileName: string
    artifactId: string
    manifestId: string
    mediaType: 'audio' | 'image'
    normalization:Readonly<import('../../domain/output-materialization.ts').SealedOutputNormalizationV3>|null
    createdAt: string
  }): Promise<void>
  markIngestFailed(input: { workspaceId: string; projectId: string }): Promise<void>
}

export interface MediaNormalizationObservationV3 {
  schemaVersion:'media-normalization-observation/v3'
  operationId:string
  attempt:number
  leaseOwner:string
  sourceProbe:Readonly<import('../../domain/output-materialization.ts').OutputObservedProbeV3>
  audioProbes:Readonly<import('../../domain/output-materialization.ts').OutputNormalizationReceiptV3['audioProbes']>
  derivativeProbe:Readonly<import('../../domain/output-materialization.ts').OutputObservedProbeV3>
  execution:Readonly<import('../../domain/output-materialization.ts').OutputNormalizationReceiptV3['execution']>
}
export interface MediaNormalizationOwnerV3 {
  attempt:number
  leaseOwner:string
  sourceSha256:string
  sourceByteSize:number
  /** Both absolute from operation admission. No stage renews either value. */
  workEndMonotonicMs:number
  hardEndMonotonicMs:number
}
