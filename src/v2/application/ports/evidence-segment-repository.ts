import type {
  CatalogedEvidenceSegment,
  EvidenceCategory,
  EvidenceReuseDecision,
  EvidenceRightsSnapshot,
} from '../../domain/evidence-segment.ts'
import type {
  CatalogedSpeechSegment,
} from '../../domain/speech-segment-catalog.ts'

export interface EvidenceSegmentCreationContext {
  sourceSpeechSegment: Readonly<CatalogedSpeechSegment>
  transcriptDurationMs: number
  rights: Readonly<EvidenceRightsSnapshot>
}

export interface PersistedEvidenceSegment
extends CatalogedEvidenceSegment {
  requestFingerprint: string
  idempotencyKey: string
}

export interface EvidenceSegmentSearchQuery {
  workspaceId: string
  projectId: string
  text?: string
  category?: EvidenceCategory
  subject?: string
  attribution?: string
  sourceSpeechSegmentId?: string
  offerId?: string
  objection?: string
  intendedClaim?: string
  includedContext: boolean
  limit: number
  now: string
}

export interface EvidenceSegmentSearchResult {
  evidence: Readonly<PersistedEvidenceSegment>
  matchedBy: readonly (
    | 'text'
    | 'category'
    | 'subject'
    | 'attribution'
    | 'source-speech-segment'
    | 'offer'
    | 'objection'
  )[]
  reuseDecision: Readonly<EvidenceReuseDecision>
}

export interface EvidenceSegmentRepository {
  readCreationContext(input: {
    workspaceId: string
    projectId: string
    sourceSpeechSegmentId: string
  }): Promise<Readonly<EvidenceSegmentCreationContext> | null>
  findIdempotent(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
  }): Promise<Readonly<PersistedEvidenceSegment> | null>
  persist(
    evidence: Readonly<PersistedEvidenceSegment>,
  ): Promise<Readonly<{
    evidence: Readonly<PersistedEvidenceSegment>
    replayed: boolean
  }>>
  search(
    query: Readonly<EvidenceSegmentSearchQuery>,
  ): Promise<readonly Readonly<EvidenceSegmentSearchResult>[]>
}
