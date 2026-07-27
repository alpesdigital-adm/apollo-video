import type { MediaTranscript } from '../../domain/media-transcript.ts'
import type {
  CatalogedSpeechSegment,
  SpeechCatalogProducer,
  SpeechSegmentAnnotationInput,
  SpeechSegmentClassification,
} from '../../domain/speech-segment-catalog.ts'

export interface SpeechCatalogExtractionContext {
  workspaceId: string
  projectId: string
  sourceTranscriptId: string
  sourceArtifactId: string
  transcript: Readonly<MediaTranscript>
}

export interface PersistedSpeechCatalogRun {
  schemaVersion: 'speech-segment-catalog-run/v1'
  id: string
  workspaceId: string
  projectId: string
  sourceTranscriptId: string
  sourceTranscriptHash: string
  sourceArtifactId: string
  extractionPolicyVersion: 'speech-segment-extraction/v1'
  producer: Readonly<SpeechCatalogProducer>
  annotations: readonly Readonly<SpeechSegmentAnnotationInput>[]
  annotationsHash: string
  segments: readonly Readonly<CatalogedSpeechSegment>[]
  segmentCount: number
  requestFingerprint: string
  idempotencyKey: string
  createdBy: Readonly<{ type: 'api-client'; id: string }>
  createdAt: string
  recordHash: string
  active: boolean
}

export interface SpeechSegmentSearchQuery {
  workspaceId: string
  projectId: string
  text?: string
  intention?: string
  speakerId?: string
  emotion?: string
  expression?: string
  wardrobe?: string
  setting?: string
  sourceArtifactId?: string
  classification?: SpeechSegmentClassification
  completeThoughtMin?: number
  limit: number
}

export interface SpeechSegmentSearchResult {
  segment: Readonly<CatalogedSpeechSegment>
  matchedBy: readonly (
    | 'speech'
    | 'intention'
    | 'person'
    | 'emotion'
    | 'expression'
    | 'wardrobe'
    | 'setting'
    | 'source-artifact'
    | 'classification'
    | 'complete-thought'
  )[]
  rightsStatus: string
  eligibleForReuse: boolean
  blockedReasons: readonly string[]
}

export interface SpeechSegmentCatalogRepository {
  readExtractionContext(input: {
    workspaceId: string
    projectId: string
    sourceTranscriptId: string
  }): Promise<Readonly<SpeechCatalogExtractionContext> | null>
  findIdempotent(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
  }): Promise<Readonly<PersistedSpeechCatalogRun> | null>
  persist(
    run: Readonly<PersistedSpeechCatalogRun>,
  ): Promise<Readonly<{
    run: Readonly<PersistedSpeechCatalogRun>
    replayed: boolean
  }>>
  search(
    query: Readonly<SpeechSegmentSearchQuery>,
  ): Promise<readonly Readonly<SpeechSegmentSearchResult>[]>
}
